/**
 * Sesión contra la Consulta Pública del PJe.
 *
 * Encapsula la conversación JSF/Seam:
 *  1. abrir():     GET de la página → cookies, ViewState, formulario, URL del CAPTCHA.
 *  2. buscar():    GET del CAPTCHA → humano → POST A4J de búsqueda → documento parcheado.
 *  3. accionA4J(): cualquier otra interacción (paginar, abrir un proceso) sobre
 *                  el documento vigente.
 *
 * Mantiene un documento cheerio "vigente" que se parchea con cada respuesta
 * A4J, igual que haría el navegador, de modo que el formulario y la tabla
 * siempre se leen del estado real.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from './config';
import { ClienteHttp } from './http/client';
import { aplicarRespuestaA4J, construirCuerpoA4J, OpcionesA4J } from './jsf/a4j';
import { CamposFormulario, extraerFormulario, fijarCampo, buscarCampo } from './jsf/form';
import { ResolutorCaptcha } from './captcha/humano';
import { log } from './utils/logger';
import { esReintentable, ServidorSaturadoError, SesionCaducadaError, sleep, withRetry } from './utils/retry';

export const FORM_ID = 'consultaPublicaForm';
/** Valor que el portal envía en el campo Processo cuando está vacío (máscara del plugin). */
export const MASCARA_PROCESO = '_______-__.____._.__.____';

export interface CriteriosBusqueda {
  /** Valor del selector Seção/Subseção. Vacío = [Todos]. */
  secao?: string;
  numeroProcesso?: string;
  nomeParte?: string;
  nomeAdvogado?: string;
  classeJudicial?: string;
}

export class SesionPje {
  readonly http = new ClienteHttp();
  /** Documento vigente (página completa parcheada con cada respuesta A4J). */
  private $!: cheerio.CheerioAPI;
  private abierta = false;

  constructor(private readonly captcha: ResolutorCaptcha) {}

  /** Documento vigente para que el parser lea la tabla. */
  get documento(): cheerio.CheerioAPI {
    if (!this.abierta) throw new Error('La sesión no está abierta');
    return this.$;
  }

  /** Paso 1: abre la página y captura sesión + estado. */
  async abrir(): Promise<void> {
    this.http.reiniciarSesion();
    const r = await withRetry(() => this.http.getTexto(CONFIG.landingPath), { etiqueta: 'GET inicio' });
    this.$ = cheerio.load(r.texto);
    this.abierta = true;
    const form = extraerFormulario(this.$, FORM_ID);
    log.info(`Sesión abierta: JSESSIONID=${(this.http.jsessionid ?? '').slice(0, 8)}… ViewState=${form.viewState} campos=${form.campos.length}`);
    this.guardarRaw('01-inicio.html', r.texto);
  }

  /** Paso 2: resuelve el CAPTCHA con el humano y envía la búsqueda. Devuelve true si aparecieron resultados. */
  async buscar(criterios: CriteriosBusqueda = {}): Promise<boolean> {
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

      const form = extraerFormulario(this.$, FORM_ID);
      let campos = form.campos;
      campos = this.aplicarCriterios(campos, criterios);
      const campoCaptcha = buscarCampo(campos, 'verifyCaptcha');
      if (!campoCaptcha) throw new Error('No se encontró el campo del CAPTCHA en el formulario');
      campos = fijarCampo(campos, campoCaptcha, texto);

      const boton = buscarCampo(form.campos, 'pesq') ?? `${FORM_ID}:pesq`;
      let resultado;
      try {
        resultado = await this.enviarA4J(form.action, campos, form.viewState, {
          formId: FORM_ID,
          control: boton,
        }, `02-busqueda-${intento}.xml`);
      } catch (e) {
        if (e instanceof ServidorSaturadoError && fallosServidor < CONFIG.maxSessionRenewals) {
          fallosServidor++;
          log.warn(`Servidor saturado (${fallosServidor}/${CONFIG.maxSessionRenewals}). Esperando ${CONFIG.retry.serverOverloadDelayMs / 1000} s y reabriendo sesión…`);
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
      log.warn(`La búsqueda no devolvió resultados (intento ${intento}/${CONFIG.maxCaptchaAttempts}). Mensajes: ${mensaje || 'ninguno'}`);
      intento++;
      // El formulario se re-renderiza con un CAPTCHA nuevo: el bucle lo vuelve a pedir.
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
        if (/captchaImg/.test(r.texto)) {
          if (i > 1) log.info(`Servidor operativo tras ${i} sondas`);
          // La sonda trae una página nueva: se adopta como documento vigente.
          this.$ = cheerio.load(r.texto);
          this.abierta = true;
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
   * búsqueda (que costaría otro CAPTCHA). Ver `restaurar`.
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

  /** Campos actuales del formulario de consulta (para construir peticiones no A4J). */
  formularioActual(formId = FORM_ID) {
    return extraerFormulario(this.$, formId);
  }

  /** True si el documento vigente contiene una tabla de resultados con filas. */
  hayResultados(): boolean {
    return this.$('table.rich-table tbody tr, [id*="dataTable"] tbody tr, tr.rich-table-row').length > 0;
  }

  /** Texto de los mensajes JSF/RichFaces visibles (errores de validación, avisos). */
  mensajesDelServidor(): string {
    return this.$('#Message, .rich-messages, .rich-message, [id$="messages"], .mensagem, .erro')
      .map((_, el) => this.$(el).text().replace(/\s+/g, ' ').trim())
      .get()
      .filter(Boolean)
      .join(' | ');
  }

  // ---------------------------------------------------------------- internos

  private aplicarCriterios(campos: CamposFormulario, c: CriteriosBusqueda): CamposFormulario {
    const set = (sufijo: string, valor: string | undefined) => {
      if (valor === undefined) return;
      const nombre = buscarCampo(campos, sufijo);
      if (nombre) campos = fijarCampo(campos, nombre, valor);
    };
    set('jurisdicaoSecao', c.secao);
    // El campo Processo lleva una máscara que rellena el JavaScript del portal; sin número
    // de proceso el navegador envía la máscara vacía, y se replica tal cual.
    set('Processo', c.numeroProcesso ?? MASCARA_PROCESO);
    set('nomeParte', c.nomeParte);
    set('nomeParteAdvogado', c.nomeAdvogado);
    set('classeJudicial', c.classeJudicial);
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

  private async enviarA4J(action: string, campos: CamposFormulario, viewState: string, o: OpcionesA4J, nombreRaw?: string) {
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
