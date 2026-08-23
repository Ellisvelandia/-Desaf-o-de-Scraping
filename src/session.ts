/**
 * Sesión contra la Consulta Pública del PJe.
 *
 * Encapsula la conversación JSF/Seam:
 *  1. abrir():     GET de la página → cookies, ViewState, formulario, variante.
 *  2. buscar():    envía la búsqueda (con CAPTCHA o sin él, según la variante).
 *  3. accionA4J(): cualquier otra interacción (paginar, abrir un proceso) sobre
 *                  el documento vigente.
 *
 * Mantiene un documento cheerio "vigente" que se parchea con cada respuesta
 * A4J, igual que haría el navegador, de modo que el formulario y la tabla
 * siempre se leen del estado real.
 *
 * DOS VARIANTES, UNA SOLA SESIÓN
 * ------------------------------
 * El PJe publica la Consulta Pública con dos plantillas incompatibles y esta
 * clase habla las dos. Lo que cambia entre ellas —id del formulario, nombre del
 * botón, si el CAPTCHA se valida en servidor— no se decide aquí: lo dicta el
 * `PerfilVariante` que devuelve `detectarVariante` al abrir. De ese perfil esta
 * sesión consume tres datos, y ninguno más:
 *
 *   - `formId`:          id del formulario de búsqueda (`consultaPublicaForm` o `fPP`).
 *   - `botonBuscar`:     id completo del control que dispara la búsqueda.
 *   - `requiereCaptcha`: true en la variante «seam» (CAPTCHA de imagen validado
 *                        en servidor), false en la «fPP», donde se ha verificado
 *                        que el POST de búsqueda devuelve la tabla renderizada
 *                        sin enviar ningún token.
 *
 * Lo que queda —los nombres de los campos— se busca por SUFIJO sobre el HTML
 * vigente, nunca por id completo: los prefijos `j_idNNN` que genera JSF cambian
 * de una instancia del PJe a otra, y TRF5 y TRF1 numeran distinto la MISMA vista.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from './config';
import { ClienteHttp } from './http/client';
import { aplicarRespuestaA4J, construirCuerpoA4J, OpcionesA4J } from './jsf/a4j';
import { CamposFormulario, extraerFormulario, fijarCampo, buscarCampo } from './jsf/form';
import { ResolutorCaptcha } from './captcha/humano';
import { detectarVariante, localizarControlBusqueda, PerfilVariante } from './variante';
import { log } from './utils/logger';
import { esReintentable, ServidorSaturadoError, SesionCaducadaError, sleep, withRetry } from './utils/retry';

/**
 * Id del formulario de la variante antigua.
 *
 * Ya no lo usa esta clase —el id efectivo lo dicta `perfil.formId`, que puede ser
 * `fPP`— pero sigue exportado porque es parte de la API pública del módulo y
 * porque nombrar la constante es más claro que repetir el literal en las pruebas.
 */
export const FORM_ID = 'consultaPublicaForm';
/** Valor que el portal envía en el campo Processo cuando está vacío (máscara del plugin). */
export const MASCARA_PROCESO = '_______-__.____._.__.____';

export interface CriteriosBusqueda {
  /** Valor del selector Seção/Subseção. Vacío = [Todos]. Solo existe en la variante seam. */
  secao?: string;
  numeroProcesso?: string;
  nomeParte?: string;
  nomeAdvogado?: string;
  classeJudicial?: string;
  /** CPF/CNPJ de la parte. */
  documentoParte?: string;
  /** Número de inscripción OAB del abogado. */
  numeroOAB?: string;
  /** Estado (UF) del combo que acompaña al número de OAB. */
  estadoOAB?: string;
  /** Fecha de autuación desde / hasta, en el formato dd/MM/yyyy que espera el portal. */
  dataAutuacaoInicio?: string;
  dataAutuacaoFim?: string;
}

/**
 * Sufijos de cada criterio, cubriendo las dos familias de plantillas.
 *
 * `buscarCampo` casa por sufijo tras `:`, así que un mismo criterio declara el
 * nombre corto de cada plantilla y la sesión se queda con el primero que exista
 * en el formulario vigente. Está comprobado sobre los fixtures reales (seam de
 * TRF5, fPP de TRF5 y fPP de TRF1) que ningún sufijo de una familia casa por
 * accidente con un campo de la otra, de modo que el orden de la lista no cambia
 * qué campo se rellena.
 */
const SUFIJOS: Record<Exclude<keyof CriteriosBusqueda, 'numeroProcesso'>, readonly string[]> = {
  secao: ['jurisdicaoSecao'],
  nomeParte: ['nomeParte'],
  nomeAdvogado: ['nomeParteAdvogado', 'nomeAdv'],
  classeJudicial: ['classeJudicial'],
  documentoParte: ['documentoParte', 'numeroCPFCNPJCNPJ'],
  numeroOAB: ['numeroOAB', 'numeroOABParte'],
  estadoOAB: ['estadoComboOAB', 'numeroOABParteEstadoCombo'],
  dataAutuacaoInicio: ['dataAutuacaoInicioInputDate'],
  dataAutuacaoFim: ['dataAutuacaoFimInputDate'],
};

/** Sufijo del campo «número de proceso» en cada plantilla: [seam, fPP]. */
const SUFIJO_PROCESO_SEAM = 'Processo';
const SUFIJO_PROCESO_FPP = 'numProcesso-inputNumeroProcesso';

export class SesionPje {
  readonly http = new ClienteHttp();
  /** Documento vigente (página completa parcheada con cada respuesta A4J). */
  private $!: cheerio.CheerioAPI;
  private abierta = false;
  private perfilDetectado?: PerfilVariante;

  constructor(private readonly captcha: ResolutorCaptcha) {}

  /** Documento vigente para que el parser lea la tabla. */
  get documento(): cheerio.CheerioAPI {
    if (!this.abierta) throw new Error('La sesión no está abierta');
    return this.$;
  }

  /**
   * Variante detectada al abrir. De solo lectura desde fuera: la plantilla la
   * elige el portal, no el scraper, y cambiarla a mitad de sesión dejaría el
   * documento vigente y el formulario hablando de plantillas distintas.
   */
  get perfil(): PerfilVariante {
    if (!this.perfilDetectado) throw new Error('La sesión no está abierta');
    return this.perfilDetectado;
  }

  /** Paso 1: abre la página y captura sesión + estado + variante. */
  async abrir(): Promise<void> {
    this.http.reiniciarSesion();
    const r = await withRetry(() => this.http.getTexto(CONFIG.landingPath), { etiqueta: 'GET inicio' });
    this.adoptarDocumento(r.texto);
    const form = extraerFormulario(this.$, this.perfil.formId);
    log.info(
      `Sesión abierta: formulario=${this.perfil.formId} captcha=${this.perfil.requiereCaptcha ? 'sí' : 'no'} ` +
        `JSESSIONID=${(this.http.jsessionid ?? '').slice(0, 8)}… ViewState=${form.viewState} campos=${form.campos.length}`,
    );
    this.guardarRaw('01-inicio.html', r.texto);
  }

  /**
   * Paso 2: envía la búsqueda. Devuelve true si aparecieron resultados.
   *
   * El CAPTCHA solo se pide donde el servidor lo valida. En la variante fPP se
   * comprobó que el POST devuelve la tabla renderizada sin token alguno, así que
   * pedirle una imagen al operador sería trabajo humano tirado a la basura.
   */
  async buscar(criterios: CriteriosBusqueda = {}): Promise<boolean> {
    return this.perfil.requiereCaptcha ? this.buscarConCaptcha(criterios) : this.buscarSinCaptcha(criterios);
  }

  /** Variante seam: GET del CAPTCHA → humano → POST A4J, reintentando si el CAPTCHA falla. */
  private async buscarConCaptcha(criterios: CriteriosBusqueda): Promise<boolean> {
    let fallosServidor = 0;
    // Los dos `continue` de este bucle —imagen nueva a petición del operador y
    // espera por saturación— NO consumen `intento` a propósito: ninguno de los dos
    // es un CAPTCHA fallado. Pero un bucle cuya única cota sea la paciencia de
    // quien teclea no es una cota: con un resolutor no interactivo que devuelva
    // cadena vacía, gira para siempre. Las vueltas totales van acotadas aparte.
    const maxVueltas = CONFIG.maxCaptchaAttempts + CONFIG.maxSessionRenewals + CONFIG.maxImagenesCaptcha;
    let vueltas = 0;

    for (let intento = 1; intento <= CONFIG.maxCaptchaAttempts; ) {
      if (++vueltas > maxVueltas) {
        throw new Error(
          `La búsqueda no llegó a completarse tras ${maxVueltas} vueltas (imágenes de CAPTCHA pedidas más esperas ` +
            'por saturación). Se aborta en lugar de seguir pidiendo imágenes indefinidamente.',
        );
      }

      // Sonda barata antes de pedir el CAPTCHA: si el servidor está caído, esperar
      // aquí en lugar de gastar el trabajo del operador en una petición condenada.
      await this.esperarServidorSano();

      const texto = await this.obtenerCaptcha();
      if (!texto) {
        log.warn('CAPTCHA vacío: se pide una imagen nueva');
        continue;
      }

      const form = extraerFormulario(this.$, this.perfil.formId);
      let campos = this.aplicarCriterios(form.campos, criterios);
      const campoCaptcha = buscarCampo(campos, 'verifyCaptcha');
      if (!campoCaptcha) throw new Error('No se encontró el campo del CAPTCHA en el formulario');
      campos = fijarCampo(campos, campoCaptcha, texto);

      let resultado;
      try {
        resultado = await this.enviarA4J(
          form.action,
          campos,
          form.viewState,
          { formId: form.id, control: this.controlBusqueda() },
          `02-busqueda-${intento}.xml`,
        );
      } catch (e) {
        if (e instanceof ServidorSaturadoError && fallosServidor < CONFIG.maxSessionRenewals) {
          fallosServidor++;
          log.warn(
            `Servidor saturado (${fallosServidor}/${CONFIG.maxSessionRenewals}). ` +
              `Esperando ${CONFIG.retry.serverOverloadDelayMs / 1000} s y reabriendo sesión…`,
          );
          await sleep(CONFIG.retry.serverOverloadDelayMs);
          await this.abrir();
          continue; // no consume intento de CAPTCHA: el fallo no fue del operador
        }
        throw e;
      }

      if (this.hayResultados()) {
        log.info(`Búsqueda aceptada. Ids actualizados: ${resultado.idsActualizados.length}`);
        return true;
      }
      const mensaje = this.mensajesDelServidor();
      log.warn(
        `La búsqueda no devolvió resultados (intento ${intento}/${CONFIG.maxCaptchaAttempts}). ` +
          `Mensajes: ${mensaje || 'ninguno'}`,
      );
      intento++;
      // El formulario se re-renderiza con un CAPTCHA nuevo: el bucle lo vuelve a pedir.
    }
    return false;
  }

  /**
   * Variante fPP: POST A4J directo, sin CAPTCHA.
   *
   * Aquí no hay nada que reintentar salvo la saturación del servidor: repetir el
   * mismo POST con los mismos campos daría exactamente la misma respuesta, así
   * que una búsqueda sin resultados se informa como tal en la primera vuelta en
   * lugar de castigar al portal con peticiones idénticas.
   *
   * Tampoco se sondea la salud antes del primer envío: la sonda existe para no
   * malgastar el trabajo del operador con el CAPTCHA, y sin CAPTCHA solo sería un
   * GET de más. Se recurre a ella únicamente al recuperarse de una saturación,
   * donde además sirve para no reabrir sesión contra un servidor que sigue caído.
   */
  private async buscarSinCaptcha(criterios: CriteriosBusqueda): Promise<boolean> {
    for (let intento = 1; intento <= CONFIG.maxSessionRenewals; intento++) {
      const form = extraerFormulario(this.$, this.perfil.formId);
      const campos = this.aplicarCriterios(form.campos, criterios);

      try {
        const resultado = await this.enviarA4J(
          form.action,
          campos,
          form.viewState,
          { formId: form.id, control: this.controlBusqueda() },
          `02-busqueda-${intento}.xml`,
        );

        if (this.hayResultados()) {
          log.info(`Búsqueda aceptada. Ids actualizados: ${resultado.idsActualizados.length}`);
          return true;
        }
        log.warn(`La búsqueda no devolvió resultados. Mensajes: ${this.mensajesDelServidor() || 'ninguno'}`);
        return false;
      } catch (e) {
        if (e instanceof ServidorSaturadoError && intento < CONFIG.maxSessionRenewals) {
          log.warn(
            `Servidor saturado (${intento}/${CONFIG.maxSessionRenewals}). ` +
              `Esperando ${CONFIG.retry.serverOverloadDelayMs / 1000} s y reabriendo sesión…`,
          );
          await sleep(CONFIG.retry.serverOverloadDelayMs);
          await this.esperarServidorSano();
          await this.abrir();
          continue;
        }
        throw e;
      }
    }
    return false;
  }

  /**
   * Espera a que el portal responda con normalidad antes de pedir un CAPTCHA.
   *
   * El TRF5 agota su pool de conexiones a base de datos con frecuencia y responde
   * `errorUnexpected.seam` (IJ000655). Sondear con un GET barato evita quemar el
   * trabajo del operador en una búsqueda que el servidor no va a poder atender.
   *
   * Solo se sondea contra lo que puede mejorar esperando. Un fallo fatal —y el
   * caso que importa es `BloqueadoPorWafError`— se propaga en el acto: insistir
   * diez veces contra un F5 que ya rechazó la IP es exactamente lo que convierte
   * un bloqueo blando en uno duro, que es lo que `esReintentable` existe para
   * evitar en el resto del scraper.
   */
  private async esperarServidorSano(intentos = 10): Promise<void> {
    for (let i = 1; i <= intentos; i++) {
      try {
        const r = await this.http.getTexto(CONFIG.landingPath);
        if (this.esPaginaDeConsulta(r.texto)) {
          if (i > 1) log.info(`Servidor operativo tras ${i} sondas`);
          // La sonda trae una página nueva: se adopta como documento vigente.
          this.adoptarDocumento(r.texto);
          return;
        }
        log.warn(`Sonda ${i}/${intentos}: la página no trae el formulario esperado`);
      } catch (e) {
        if (!esReintentable(e)) throw e;
        const nombre = e instanceof Error ? e.name : 'error';
        log.warn(`Sonda ${i}/${intentos}: servidor no operativo (${nombre})`);
      }
      await sleep(CONFIG.retry.serverOverloadDelayMs);
    }
    throw new ServidorSaturadoError(`El portal no se estabilizó tras ${intentos} sondas`);
  }

  /**
   * Ejecuta una acción A4J (paginar, abrir proceso) sobre el documento vigente.
   * Reenvía el formulario completo actual y parchea el documento con la respuesta.
   */
  async accionA4J(opciones: OpcionesA4J, nombreRaw?: string): Promise<string[]> {
    const form = extraerFormulario(this.$, opciones.formId);
    const r = await this.enviarA4J(form.action, form.campos, form.viewState, opciones, nombreRaw);
    return r.idsActualizados;
  }

  /**
   * Sigue un enlace normal (no A4J) y adopta la respuesta como documento vigente.
   *
   * Se usa para las fichas que el portal publica como una vista propia en lugar
   * de como un postback. La URL se toma tal cual la publica el HTML, con su
   * `;jsessionid=` incrustado si lo lleva.
   *
   * La variante NO se re-detecta: una ficha no es una página de consulta y no
   * trae formulario de búsqueda, así que el perfil vigente debe seguir siendo el
   * de la lista a la que se volverá con `restaurar`.
   */
  async navegar(url: string): Promise<void> {
    const r = await withRetry(() => this.http.getTexto(url), { etiqueta: `GET ${url}` });
    this.$ = cheerio.load(r.texto);
    this.abierta = true;
  }

  /**
   * Copia del documento vigente, para poder volver a él más tarde.
   *
   * Sirve para el patrón «abrir una ficha y regresar a la lista» sin repetir la
   * búsqueda (que en la variante seam costaría otro CAPTCHA). Ver `restaurar`.
   */
  instantanea(): string {
    return this.$.html();
  }

  /**
   * Vuelve a un documento capturado antes con `instantanea`.
   *
   * ATENCIÓN, y no está verificado contra este portal: el documento restaurado
   * trae el `ViewState` que tenía cuando se capturó, no el último que emitió el
   * servidor. En JSF 1.2 con estado en servidor cada vista se guarda con su
   * propia clave y el contenedor conserva unas cuantas por sesión, así que
   * reenviar una anterior suele aceptarse; si este portal no lo acepta, el POST
   * siguiente responde con una redirección y `enviarA4J` lanza
   * `SesionCaducadaError`. Quien llama debe tratar ese caso, no asumir el éxito.
   */
  restaurar(html: string): void {
    this.$ = cheerio.load(html);
    this.abierta = true;
  }

  /**
   * Campos actuales del formulario de consulta (para construir peticiones no A4J).
   *
   * Sin argumento devuelve el formulario de búsqueda de la variante detectada,
   * que no siempre es `consultaPublicaForm`.
   */
  formularioActual(formId?: string) {
    return extraerFormulario(this.$, formId ?? this.perfil.formId);
  }

  /**
   * True si el documento vigente contiene una tabla de resultados con filas.
   *
   * Se cubren las dos plantillas: la antigua dibuja un `rich:dataTable` genérico
   * y la moderna un `<table id="…:processosTable">` cuyas filas llevan la clase
   * `rich-table-row`. El selector de la moderna se ancla por sufijo porque el
   * prefijo del id es el del formulario y las instancias no lo comparten.
   */
  hayResultados(): boolean {
    const selector = [
      'table.rich-table tbody tr',
      '[id*="dataTable"] tbody tr',
      '[id$=":processosTable"] tbody tr.rich-table-row',
      'tr.rich-table-row',
    ].join(', ');
    return this.$(selector).length > 0;
  }

  /** Texto de los mensajes JSF/RichFaces visibles (errores de validación, avisos). */
  mensajesDelServidor(): string {
    return this.$('#Message, .rich-messages, .rich-message, [id$="messages"], .mensagem, .erro')
      .map((_, el) => this.$(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)
      .join(' | ');
  }


  /**
   * Control que se envía para lanzar la búsqueda.
   *
   * En la variante moderna el botón visible no ejecuta la consulta (su `onclick`
   * hace `return` antes del submit), así que se prefiere el control real que
   * define `executarPesquisa()`. Si no se encuentra, se cae al botón: es mejor
   * intentarlo que abortar.
   */
  private controlBusqueda(): string {
    const real = localizarControlBusqueda(this.$, this.perfil.formId);
    if (real && real !== this.perfil.botonBuscar) {
      log.debug(`Control de búsqueda real: ${real} (el botón ${this.perfil.botonBuscar} no ejecuta la consulta)`);
      return real;
    }
    return this.perfil.botonBuscar;
  }

  // ---------------------------------------------------------------- internos

  /** Carga un HTML como documento vigente y re-detecta la variante que describe. */
  private adoptarDocumento(html: string): void {
    this.$ = cheerio.load(html);
    this.abierta = true;
    this.perfilDetectado = detectarVariante(this.$);
  }

  /**
   * ¿La respuesta es una página de consulta utilizable?
   *
   * No basta con «respondió 200»: cuando el pool de conexiones se agota, el portal
   * devuelve una página de error igual de válida para HTTP. La señal es que haya
   * con qué buscar, y quien sabe reconocer eso ya es `detectarVariante`: si no
   * clasifica el documento, no es ninguna de las dos consultas públicas.
   *
   * En la variante seam se exige además la imagen del CAPTCHA. El formulario sin
   * imagen no sirve de nada —la búsqueda no se puede firmar— y es justo el estado
   * en el que el portal deja la página cuando su capa Seam ha fallado.
   */
  private esPaginaDeConsulta(html: string): boolean {
    const $ = cheerio.load(html);
    let perfil: PerfilVariante;
    try {
      perfil = detectarVariante($);
    } catch {
      return false;
    }
    return perfil.requiereCaptcha ? $('img[id$="captchaImg"]').length > 0 : true;
  }

  /**
   * Rellena los criterios sobre los campos del formulario vigente.
   *
   * Cada criterio se intenta con los sufijos de las dos familias de plantillas y
   * se queda con el primero presente. Un criterio cuyo campo no existe en esta
   * plantilla (`secao`, por ejemplo, que solo tiene la variante seam) se ignora
   * en silencio: no es un fallo de programación, es una plantilla sin ese filtro.
   */
  private aplicarCriterios(campos: CamposFormulario, c: CriteriosBusqueda): CamposFormulario {
    const set = (sufijos: readonly string[], valor: string | undefined) => {
      if (valor === undefined) return;
      for (const sufijo of sufijos) {
        const nombre = buscarCampo(campos, sufijo);
        if (nombre) {
          campos = fijarCampo(campos, nombre, valor);
          return;
        }
      }
    };

    // El número de proceso va aparte porque su valor por defecto depende de la
    // plantilla: la variante seam lleva una máscara que rellena el JavaScript del
    // portal y que el navegador envía tal cual aunque no se filtre por número; la
    // fPP manda el campo vacío. Colar la máscara donde no se espera sería filtrar
    // por un número imposible, y la búsqueda no devolvería nada.
    const campoSeam = buscarCampo(campos, SUFIJO_PROCESO_SEAM);
    if (campoSeam) {
      campos = fijarCampo(campos, campoSeam, c.numeroProcesso ?? MASCARA_PROCESO);
    } else {
      const campoFpp = buscarCampo(campos, SUFIJO_PROCESO_FPP);
      if (campoFpp) campos = fijarCampo(campos, campoFpp, c.numeroProcesso ?? '');
    }

    set(SUFIJOS.secao, c.secao);
    set(SUFIJOS.nomeParte, c.nomeParte);
    set(SUFIJOS.nomeAdvogado, c.nomeAdvogado);
    set(SUFIJOS.classeJudicial, c.classeJudicial);
    set(SUFIJOS.documentoParte, c.documentoParte);
    set(SUFIJOS.numeroOAB, c.numeroOAB);
    set(SUFIJOS.estadoOAB, c.estadoOAB);
    set(SUFIJOS.dataAutuacaoInicio, c.dataAutuacaoInicio);
    set(SUFIJOS.dataAutuacaoFim, c.dataAutuacaoFim);
    return campos;
  }

  private async obtenerCaptcha(): Promise<string> {
    const src = this.$('img[id$="captchaImg"]').attr('src');
    if (!src) throw new Error('No se encontró la imagen del CAPTCHA en la página');
    // El navegador añade un cache-buster `f=<epoch>`; el servidor genera un desafío nuevo por GET.
    const url = src.includes('?') ? src : `${src}?f=${Date.now()}`;
    const r = await withRetry(() => this.http.getBinario(url), { etiqueta: 'GET captcha' });
    const tipo = String(r.headers['content-type'] ?? 'image/png');
    return this.captcha.resolver(Buffer.from(r.data), tipo);
  }

  private async enviarA4J(
    action: string,
    campos: CamposFormulario,
    viewState: string,
    o: OpcionesA4J,
    nombreRaw?: string,
  ) {
    const cuerpo = construirCuerpoA4J(campos, viewState, o);
    const r = await withRetry(() => this.http.postFormulario(action, cuerpo), { etiqueta: `POST ${o.control}` });
    if (nombreRaw) this.guardarRaw(nombreRaw, r.texto);

    const resultado = aplicarRespuestaA4J(this.$, r.texto);
    if (resultado.redireccion) {
      // El portal responde 200 con <meta name="Location"> cuando su capa Seam lanza
      // una excepción. Si apunta a errorUnexpected, es el pool de conexiones agotado
      // (IJ000655): es transitorio y merece esperar, no abortar.
      if (/errorUnexpected/i.test(resultado.redireccion)) {
        log.warn(`El servidor está saturado (${resultado.redireccion})`);
        throw new ServidorSaturadoError(`Redirección A4J a ${resultado.redireccion}`);
      }
      log.warn(`El servidor pidió redirigir a ${resultado.redireccion}`);
      throw new SesionCaducadaError(`Redirección A4J a ${resultado.redireccion}`);
    }
    if (resultado.idsActualizados.length === 0 && !/Ajax-Update-Ids/.test(r.texto)) {
      this.guardarRaw('error-a4j.txt', r.texto);
      throw new SesionCaducadaError('La respuesta no es un documento A4J válido');
    }
    log.debug(`A4J ${o.control}: ${resultado.idsActualizados.join(', ')} · ViewState=${resultado.viewState}`);
    return resultado;
  }

  private guardarRaw(nombre: string, contenido: string): void {
    if (!process.env.GUARDAR_RAW) return;
    fs.mkdirSync(CONFIG.rawDir, { recursive: true });
    fs.writeFileSync(path.join(CONFIG.rawDir, nombre), contenido, 'utf8');
  }
}
