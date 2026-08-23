/**
 * Configuración global del scraper.
 *
 * Todo valor que afecte al ritmo de peticiones o a las rutas de salida vive
 * aquí, para que el comportamiento sea auditable en un solo sitio.
 */
import * as path from 'path';

export const CONFIG = {
  /**
   * Origen del portal.
   *
   * Configurable porque el PJe es el mismo software desplegado en decenas de
   * tribunales: apuntar a otra instancia debe ser cambiar una variable, no tocar
   * el código. Las rutas de cada llamada se siguen leyendo del HTML.
   */
  baseUrl: process.env.PJE_BASE_URL ?? 'https://pje.trf5.jus.br',

  /** Página de entrada de la Consulta Pública (JSF/Seam). */
  landingPath: process.env.PJE_LANDING_PATH ?? '/pjeconsulta/ConsultaPublica/listView.seam',

  /** Identidad declarada. No se simula ningún navegador en particular más allá del UA. */
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',

  /** Pausa mínima entre peticiones consecutivas al portal (ms). */
  delayBetweenRequestsMs: 2000,

  /** Pausa entre descargas de PDF (ms). Los PDF pesan más que una página. */
  delayBetweenDownloadsMs: 3000,

  /** Tiempo máximo de espera por respuesta (ms). El servidor tarda hasta 30 s cuando su pool de BD está saturado. */
  requestTimeoutMs: 60000,

  /**
   * Tamaño máximo de una respuesta (bytes).
   *
   * El cliente bufferiza la respuesta entera antes de validarla —hay que ver los
   * bytes mágicos para saber si es un PDF—, así que sin tope una respuesta
   * inesperadamente enorme se lleva por delante la memoria del proceso y con ella
   * una extracción de horas. 64 MB deja holgura de sobra para un expediente
   * escaneado y corta cualquier cosa que ya no sea un documento.
   */
  maxResponseBytes: 64 * 1024 * 1024,

  /** Política de reintentos. */
  retry: {
    /** Intentos totales por petición (incluido el primero). */
    attempts: 4,
    /** Base del retroceso exponencial (ms): 2 s, 4 s, 8 s… */
    baseDelayMs: 2000,
    /**
     * Tope del retroceso exponencial y de un `Retry-After` (ms). Evita dormir
     * horas por un 429 persistente.
     *
     * NO acota `serverOverloadDelayMs`: la saturación del pool del TRF5 tiene su
     * propia escala (decenas de segundos hasta recuperarse) y su espera es un
     * valor fijo, no un retroceso creciente. Sigue estando acotada, por su propia
     * constante.
     */
    maxDelayMs: 60000,
    /** Jitter aleatorio añadido a cada espera (ms) para no sincronizar reintentos. */
    jitterMs: 500,
    /** Espera específica cuando el servidor devuelve errorUnexpected por pool agotado (ms). */
    serverOverloadDelayMs: 90000,
  },

  /** Veces que se pide al humano un CAPTCHA nuevo antes de abortar la sesión. */
  maxCaptchaAttempts: 3,

  /**
   * Imágenes de CAPTCHA servidas como cortesía sin que cuenten como intento.
   *
   * Pedir otra imagen (Enter vacío) no es un CAPTCHA fallado y no debe consumir
   * `maxCaptchaAttempts`. Pero sin este tope el bucle de búsqueda estaría acotado
   * solo por la paciencia del operador, y con un resolutor no interactivo que
   * devolviera cadena vacía no estaría acotado en absoluto.
   */
  maxImagenesCaptcha: 10,

  /** Renovaciones de sesión permitidas en una ejecución antes de rendirse. */
  maxSessionRenewals: 5,

  /** Directorios de salida. */
  outputDir: path.resolve(__dirname, '..', 'output'),
  get pdfDir() {
    return path.join(this.outputDir, 'pdfs');
  },
  get recordsPath() {
    return path.join(this.outputDir, 'records.json');
  },
  get statePath() {
    return path.join(this.outputDir, 'state.json');
  },
  get failedPath() {
    return path.join(this.outputDir, 'failed.json');
  },
  get captchaPath() {
    return path.join(this.outputDir, 'captcha.png');
  },
  get rawDir() {
    return path.join(this.outputDir, 'raw');
  },
};
