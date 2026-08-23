/**
 * Configuración global del scraper.
 *
 * Todo valor que afecte al ritmo de peticiones o a las rutas de salida vive
 * aquí, para que el comportamiento sea auditable en un solo sitio.
 */
import * as path from 'path';

/**
 * Portales que sabe recorrer este scraper.
 *
 * Son DOS porque el enunciado nombra dos sitios y no dice cuál manda: bajo
 * «Sitio web a scrapear» aparece el PJe del TRF5 (Brasil), pero tanto el Paso 1
 * como el Entregable dicen literalmente «asegúrate de que funcione correctamente
 * con el sitio» y ahí el sitio es la Jurisprudencia Nacional Sistematizada del
 * Poder Judicial del Perú. Implementar los dos es la única lectura que cumple el
 * enunciado entero, en vez de apostar por una de las dos y acertar o no.
 */
export type Objetivo = 'trf5' | 'peru';

interface PerfilObjetivo {
  baseUrl: string;
  /** Página de entrada donde vive el formulario de búsqueda. */
  landingPath: string;
  /** Página que recibe los POST de paginación. */
  resultadoPath: string;
  /** Idiomas que se declaran, en el idioma del portal. */
  acceptLanguage: string;
  /** Subcarpeta de `output/`. Vacía para el TRF5, que es el objetivo histórico. */
  subdirectorio: string;
}

const PERFILES: Record<Objetivo, PerfilObjetivo> = {
  trf5: {
    baseUrl: 'https://pje.trf5.jus.br',
    landingPath: '/pjeconsulta/ConsultaPublica/listView.seam',
    resultadoPath: '/pjeconsulta/ConsultaPublica/listView.seam',
    acceptLanguage: 'pt-BR,pt;q=0.9,es;q=0.8,en;q=0.7',
    subdirectorio: '',
  },
  peru: {
    baseUrl: 'https://jurisprudencia.pj.gob.pe',
    landingPath: '/jurisprudenciaweb/faces/page/inicio.xhtml',
    resultadoPath: '/jurisprudenciaweb/faces/page/resultado.xhtml',
    acceptLanguage: 'es-PE,es;q=0.9,en;q=0.8',
    subdirectorio: 'peru',
  },
};

/**
 * Objetivo activo.
 *
 * Se resuelve por `TARGET` o por el argumento de la línea de órdenes, y cae en
 * `trf5` ante cualquier otra cosa. El valor por defecto NO es una preferencia:
 * es lo que mantiene idéntico el comportamiento de quien ya usaba este scraper
 * antes de que existiera el segundo objetivo.
 */
function resolverObjetivo(): Objetivo {
  const crudo = (process.env.TARGET ?? process.argv.slice(2).find((a) => a === 'peru' || a === 'trf5') ?? '')
    .trim()
    .toLowerCase();
  return crudo === 'peru' ? 'peru' : 'trf5';
}

export const OBJETIVO: Objetivo = resolverObjetivo();

const PERFIL = PERFILES[OBJETIVO];

export const CONFIG = {
  /** Objetivo activo, para que los logs y la salida digan contra qué se corrió. */
  objetivo: OBJETIVO,

  /**
   * Origen del portal.
   *
   * Configurable porque el PJe es el mismo software desplegado en decenas de
   * tribunales: apuntar a otra instancia debe ser cambiar una variable, no tocar
   * el código. Las rutas de cada llamada se siguen leyendo del HTML.
   */
  baseUrl: process.env.PJE_BASE_URL ?? PERFIL.baseUrl,

  /** Página de entrada de la Consulta Pública (JSF/Seam). */
  landingPath: process.env.PJE_LANDING_PATH ?? PERFIL.landingPath,

  /** Página que atiende los POST de paginación. */
  resultadoPath: process.env.PJE_RESULTADO_PATH ?? PERFIL.resultadoPath,

  /** Idiomas declarados, en el idioma del portal de destino. */
  acceptLanguage: PERFIL.acceptLanguage,

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

  /**
   * Directorios de salida, separados por objetivo.
   *
   * Cada portal tiene su carpeta porque `records.json` y `state.json` se indexan
   * por clave de proceso y guardan la página por la que iba la extracción. Con
   * una sola carpeta, correr el objetivo peruano sobre la salida del TRF5
   * reanudaría en la página que dejó el otro portal y mezclaría en un mismo
   * fichero registros de dos jurisdicciones distintas.
   *
   * El TRF5 se queda en `output/` a secas —sin subcarpeta— para no invalidar las
   * rutas que ya documentan el README y `docs/evidencia/`.
   */
  outputDir: path.resolve(__dirname, '..', 'output', PERFIL.subdirectorio),
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
