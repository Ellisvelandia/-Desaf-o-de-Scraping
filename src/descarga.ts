/**
 * Descarga de los PDF de un proceso.
 *
 * Tres invariantes gobiernan este módulo, y las tres nacen de fallos reales de
 * scrapers contra este tipo de portal:
 *
 *  1. La ruta final solo aparece en disco cuando el fichero está completo y
 *     validado. Se escribe a `<destino>.part` y se renombra al final, de modo
 *     que «si existe, sáltalo» sea una decisión segura y no una que dé por buena
 *     una descarga cortada a la mitad.
 *  2. Un 200 no es un PDF. El portal responde 200 con la página de sesión
 *     caducada, y sin validar se acaba con un directorio lleno de ficheros del
 *     mismo tamaño que nadie mira hasta el día de la entrega.
 *  3. Un documento que falla es un documento perdido, no una ejecución perdida.
 *     Los errores se propagan al llamante para que los anote en `failed.json` y
 *     siga con el siguiente.
 *
 * Ritmo: este servicio no duerme. Es el llamante quien espera
 * `CONFIG.delayBetweenDownloadsMs` entre dos llamadas a `descargar`, porque solo
 * él sabe cuántas descargas quedan y si hubo pausas por medio. `ClienteHttp` ya
 * impone la pausa mínima entre peticiones, que es un suelo, no un sustituto.
 */
import { AxiosResponse } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from './config';
import { construirCuerpoA4J } from './jsf/a4j';
import { SesionPje } from './session';
import { DescargaDirecta, DescargaPostback, DocumentoProceso, ProcesoJudicial } from './types';
import { log } from './utils/logger';
import { withRetry } from './utils/retry';

/** Cabecera de un PDF válido. Un fichero que no empieza así no lo es, diga lo que diga el content-type. */
const FIRMA_PDF = '%PDF-';

/** Por debajo de esto no hay PDF real, solo una página de error o una respuesta truncada. */
const TAMANO_MINIMO_BYTES = 1024;

/** Tope del nombre base, dejando margen para el directorio y la extensión dentro del límite de ruta de Windows. */
const LONGITUD_MAXIMA_NOMBRE = 120;

/** Caracteres que Windows no admite en un nombre de fichero, más los de control. */
const CARACTERES_PROHIBIDOS = /[<>:"/\\|?*\x00-\x1f]/g;

/** Nombres de dispositivo heredados de DOS: Windows los rechaza incluso con extensión (`CON.pdf`). */
const NOMBRES_RESERVADOS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Se declara la intención de recibir un binario; la validación es lo que decide, no esta cabecera. */
const ACEPTA_PDF = 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8';

/**
 * La respuesta llegó, pero no es un PDF utilizable.
 *
 * Es deliberadamente distinto de un error de transporte: `esReintentable` lo
 * trata como fatal, y con razón. Repetir la petición no va a convertir una
 * página de sesión caducada en un documento; hay que renovar la sesión.
 */
export class DescargaInvalidaError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'DescargaInvalidaError';
  }
}

export class ServicioDescarga {
  constructor(private readonly sesion: SesionPje) {}

  /**
   * Descarga un documento y devuelve la ruta final del fichero.
   *
   * Si el fichero ya existe, no vuelve a pedirlo. Ante un fallo persistente
   * (429 agotado, HTML en lugar de PDF, fichero corrupto) lanza; el llamante
   * debe registrarlo y continuar con el siguiente documento.
   *
   * El llamante espera `CONFIG.delayBetweenDownloadsMs` antes de la siguiente
   * llamada: un PDF pesa mucho más que una página y es lo que dispara el 429.
   */
  async descargar(proceso: ProcesoJudicial, documento: DocumentoProceso): Promise<string> {
    const destino = this.rutaDestino(proceso, documento);

    // Solo se renombra al destino un fichero ya validado, así que su presencia
    // es prueba suficiente para saltarlo sin volver a mirar dentro.
    if (fs.existsSync(destino)) {
      log.info(`PDF ya presente, se omite: ${path.basename(destino)} · ${fs.statSync(destino).size} B`);
      return destino;
    }

    const descarga = documento.descarga;
    if (!descarga) {
      throw new DescargaInvalidaError(`El documento "${documento.titulo}" no publica ninguna forma de descarga`);
    }

    fs.mkdirSync(CONFIG.pdfDir, { recursive: true });
    const temporal = `${destino}.part`;

    // Solo la petición entra en el bucle de reintentos: el 429 y los cortes de red
    // se resuelven repitiendo, pero un PDF que no lo es seguirá sin serlo.
    const respuesta = await withRetry(() => this.pedir(descarga), {
      // El número si el tribunal lo publica, y la clave del scraper si el
      // proceso está en sigilo: un `undefined` en la etiqueta de un reintento
      // deja el log sin decir de qué expediente se está hablando.
      etiqueta: `descarga ${proceso.numeroProcesso ?? proceso.claveUnica} · ${documento.titulo}`,
    });

    // La escritura entra en el try junto con la validación: un fallo a mitad de
    // `writeFileSync` (disco lleno, permisos) deja un `.part` truncado, y fuera
    // del try nadie lo borraría. Quedaría en el directorio para siempre, porque
    // el único camino que limpia temporales es este.
    try {
      fs.writeFileSync(temporal, respuesta.data);
      const bytes = this.validar(temporal, respuesta);
      fs.renameSync(temporal, destino);
      // El tamaño en el log no es adorno: una corrida donde todos los ficheros
      // pesan igual es una corrida que bajó N veces la misma página de error.
      log.info(`PDF ${path.basename(destino)} · ${bytes} B`);
      return destino;
    } catch (e) {
      this.borrar(temporal);
      throw e;
    }
  }

  /**
   * Convierte texto arbitrario del portal en un nombre de fichero válido en Windows.
   *
   * Une las partes con `_` y aplica, en este orden: sustitución de caracteres
   * ilegales, colapso de espacios, recorte de puntos y espacios finales (Windows
   * los descarta al crear el fichero, y entonces la ruta que se cree escrita deja
   * de coincidir con la que existe), escape de nombres de dispositivo reservados
   * y truncado.
   */
  static nombreSeguro(...partes: string[]): string {
    const unido = partes
      .map((parte) => String(parte ?? '').trim())
      .filter(Boolean)
      .join('_');

    let nombre = ServicioDescarga.recortarFinal(unido.replace(CARACTERES_PROHIBIDOS, '_').replace(/\s+/g, ' '));
    if (!nombre) return 'sin_nombre';

    // `_CON.pdf` sí es un nombre válido; `CON.pdf` abre el dispositivo de consola.
    if (NOMBRES_RESERVADOS.test(nombre)) nombre = `_${nombre}`;

    // El truncado va al final para que no reintroduzca un punto o un espacio
    // final que el recorte anterior ya había quitado.
    nombre = ServicioDescarga.recortarFinal(nombre.slice(0, LONGITUD_MAXIMA_NOMBRE));
    return nombre || 'sin_nombre';
  }

  /**
   * Ruta en la que acabaría este documento, sin pedir nada al portal.
   *
   * La expone el orquestador para distinguir «descargado ahora» de «ya estaba en
   * disco»: un fichero omitido no es una descarga y no debe consumir el tope de
   * `MAX_DESCARGAS`, o una segunda pasada agotaría el cupo saltando ficheros que
   * ya tenía.
   */
  rutaDe(proceso: ProcesoJudicial, documento: DocumentoProceso): string {
    return this.rutaDestino(proceso, documento);
  }

  // ---------------------------------------------------------------- internos

  /** Quita espacios de los extremos y los puntos finales que Windows descartaría. */
  private static recortarFinal(texto: string): string {
    return texto.trim().replace(/[. ]+$/, '');
  }

  private rutaDestino(proceso: ProcesoJudicial, documento: DocumentoProceso): string {
    // Prefijar con el número de proceso hace cada fichero trazable a su expediente
    // sin abrir el JSON, y agrupa los documentos de un mismo proceso al ordenar.
    //
    // El id va en el nombre porque el título NO es único dentro de un proceso: la
    // ficha repite «Petição», «Certidão» o «Despacho» tantas veces como
    // movimientos haya, y el parser llega a titular un icono con el texto de su
    // fila. Sin el id, el segundo documento homónimo encuentra el destino ya
    // creado, se da por descargado y se pierde en silencio. Se pone antes del
    // título para que sobreviva al truncado por longitud.
    //
    // El prefijo es el número CNJ cuando el tribunal lo publica y la `claveUnica`
    // cuando no (segredo de justiça): un fichero llamado `undefined_1234_….pdf`
    // sería ilegible y, peor, todos los procesos en sigilo compartirían prefijo.
    // `nombreSeguro` convierte los dos puntos de `sigilo:` en `_`, que Windows sí
    // admite en un nombre de fichero.
    const prefijo = proceso.numeroProcesso ?? proceso.claveUnica;
    const base = ServicioDescarga.nombreSeguro(prefijo, documento.id ?? '', documento.titulo);
    return path.join(CONFIG.pdfDir, `${base}.pdf`);
  }

  private async pedir(descarga: DescargaDirecta | DescargaPostback): Promise<AxiosResponse<Buffer>> {
    if (descarga.tipo === 'url') {
      return this.sesion.http.getBinario(this.urlAbsoluta(descarga.url), { headers: { Accept: ACEPTA_PDF } });
    }
    return this.postback(descarga);
  }

  /**
   * Reproduce el POST que el portal exige para servir ciertos artefactos.
   *
   * El cuerpo se reconstruye sobre el formulario **vigente** de la sesión: JSF
   * valida el `ViewState` de la última respuesta, así que uno guardado junto al
   * documento cuando se leyó la ficha ya estaría caducado.
   */
  private async postback(descarga: DescargaPostback): Promise<AxiosResponse<Buffer>> {
    const form = this.sesion.formularioActual(descarga.formId);
    const cuerpo = construirCuerpoA4J(form.campos, form.viewState, {
      formId: descarga.formId,
      control: descarga.control,
      parametros: descarga.parametros,
    });
    // Un `action` vacío significa "la misma vista"; el portal la escribe con
    // `;jsessionid=`, así que se cae a la landing solo cuando no hay nada que leer.
    return this.sesion.http.postBinario(form.action || CONFIG.landingPath, cuerpo, {
      headers: { Accept: ACEPTA_PDF },
    });
  }

  /** Resuelve una URL relativa contra el origen; las absolutas pasan intactas. */
  private urlAbsoluta(url: string): string {
    try {
      // `new URL` conserva el `;jsessionid=…` que el portal incrusta en el path,
      // cosa que un `baseUrl + url` a mano rompería en cuanto la URL fuera absoluta.
      return new URL(url, CONFIG.baseUrl).toString();
    } catch {
      throw new DescargaInvalidaError(`URL de descarga inutilizable: ${url}`);
    }
  }

  /** Comprueba que lo descargado es un PDF y devuelve su tamaño en bytes. */
  private validar(temporal: string, r: AxiosResponse<Buffer>): number {
    const tipo = String(r.headers['content-type'] ?? '');
    // El portal responde 200 con la página de sesión caducada en lugar del
    // artefacto. Es el fallo silencioso más caro de este scraper.
    if (/text\/html|application\/xhtml/i.test(tipo)) {
      throw new DescargaInvalidaError(`El servidor devolvió HTML (${tipo}) en lugar de un PDF`);
    }

    // El tamaño se mide en disco y no sobre el buffer: así el mismo control
    // cubre también una escritura corta (disco lleno), no solo una respuesta corta.
    const bytes = fs.statSync(temporal).size;
    if (bytes < TAMANO_MINIMO_BYTES) {
      throw new DescargaInvalidaError(`Fichero demasiado pequeño: ${bytes} B (mínimo ${TAMANO_MINIMO_BYTES} B)`);
    }

    // Último filtro y el único que no se puede falsear con cabeceras.
    const firma = r.data.subarray(0, FIRMA_PDF.length).toString('latin1');
    if (firma !== FIRMA_PDF) {
      throw new DescargaInvalidaError(`Los bytes iniciales no son los de un PDF: ${JSON.stringify(firma)}`);
    }

    return bytes;
  }

  /** Borra un temporal sin dejar que el fallo al borrarlo tape el error que lo provocó. */
  private borrar(ruta: string): void {
    try {
      fs.rmSync(ruta, { force: true });
    } catch (e) {
      log.warn(`No se pudo borrar el temporal ${ruta}`, e);
    }
  }
}
