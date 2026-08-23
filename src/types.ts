/**
 * Contrato de datos del scraper.
 *
 * Regla: ningún campo declarado aquí se emite vacío por defecto. Si el portal no
 * publica un dato, el campo es opcional y se omite, en lugar de prometer una
 * columna que siempre estaría en blanco.
 */

/** Una parte del proceso (autor, reo, etc.) tal como la publica la consulta pública. */
export interface Parte {
  /** Papel procesal: AUTOR, RÉU, EXEQUENTE… tal como lo etiqueta el portal. */
  papel?: string;
  nombre: string;
}

/** Un documento/movimiento del proceso con su enlace de descarga, si lo tiene. */
export interface DocumentoProceso {
  /** Identificador del documento en el portal, si se puede extraer. */
  id?: string;
  /** Texto visible del enlace o del tipo de documento. */
  titulo: string;
  /** Fecha del documento, en ISO-8601 si se pudo interpretar. */
  fecha?: string;
  /**
   * Cómo obtener el archivo. `url` para un GET directo; `postback` cuando el
   * portal exige reproducir un POST JSF con el control y los parámetros dados.
   */
  descarga?: DescargaDirecta | DescargaPostback;
}

export interface DescargaDirecta {
  tipo: 'url';
  url: string;
}

export interface DescargaPostback {
  tipo: 'postback';
  /** Id del formulario JSF que hay que reenviar. */
  formId: string;
  /** Nombre del control que "se pulsa". */
  control: string;
  /** Parámetros adicionales que RichFaces envía junto al control. */
  parametros?: Record<string, string>;
}

/** Estado de un proceso dentro del flujo del scraper. */
export type EstadoProceso = 'pendiente' | 'completado' | 'sin_documentos' | 'fallido';

/** Un proceso judicial extraído de la lista de resultados. */
export interface ProcesoJudicial {
  /**
   * Clave de deduplicación DEL SCRAPER. Siempre presente.
   *
   * POR QUÉ existen dos campos y no uno: `numeroProcesso` es un DATO DEL PORTAL
   * —lo asigna el poder judicial y aparece tal cual en el expediente— mientras
   * que `claveUnica` es un ÍNDICE INTERNO, un artefacto de este scraper que solo
   * sirve para no guardar dos veces la misma fila. Confundirlos es exactamente
   * lo que lleva a inventar números de proceso: al necesitar una clave para las
   * filas que no publican número, la tentación es rellenar `numeroProcesso` con
   * algo derivado, y desde ese momento el JSON y el CSV publican un número CNJ
   * que no existe en ningún tribunal.
   *
   * Vale `numeroProcesso` cuando el portal lo publica. Cuando no, se deriva del
   * enlace a la ficha —el parámetro `ca=` de `apertura.url`, que es el
   * identificador con el que el propio portal abre ese expediente— y lleva el
   * prefijo `sigilo:` para que de un vistazo no se pueda confundir con un
   * número real.
   */
  claveUnica: string;
  /**
   * Número único del proceso (formato CNJ NNNNNNN-DD.AAAA.J.TR.OOOO), tal como
   * lo publica el portal.
   *
   * OPCIONAL a propósito: los procesos en segredo de justiça NO lo publican (en
   * el fixture real del TRF1 son 8 de sus 30 filas). Esas filas se emiten igual
   * —con `enSigilo`, con su `claveUnica` y con todo lo demás que sí publican:
   * clase judicial, sigla, asunto y partes—, porque descartarlas tiraba el 27 %
   * de los resultados. Lo que no se hace nunca es rellenar este campo con un
   * sustituto: si el portal no lo dice, aquí no aparece.
   */
  numeroProcesso?: string;
  /**
   * True cuando la fila no publicó número CNJ, que es como el PJe presenta los
   * expedientes en segredo de justiça. Es una inferencia sobre la evidencia
   * disponible (la ausencia del número), no un campo que el portal rotule.
   */
  enSigilo?: boolean;
  /** Órgano juzgador / vara, si el portal lo publica. */
  orgaoJulgador?: string;
  /** Clase judicial (procedimiento). */
  classeJudicial?: string;
  /** Fecha de autuación en ISO-8601, si se pudo interpretar. */
  dataAutuacao?: string;
  /** Partes del proceso. */
  partes?: Parte[];
  /**
   * Cómo abrir la ficha de este proceso desde la lista de resultados.
   *
   * Se lee de la propia fila durante la Fase 1, porque el control solo existe
   * mientras esa página está en el documento vigente. Se omite cuando la fila no
   * lo publica de forma inequívoca; la Fase 2 lo registra entonces como fallo de
   * fase `ficha` en lugar de adivinar una navegación.
   */
  apertura?: DescargaDirecta | DescargaPostback;
  /** Documentos asociados, poblados al abrir la ficha del proceso en la Fase 2. */
  documentos?: DocumentoProceso[];
  /** Cualquier otra columna de la tabla, indexada por su cabecera normalizada. */
  camposExtra?: Record<string, string>;

  // --- metadatos del scraper, no del portal ---
  /** Página de resultados donde apareció (1-based). */
  paginaOrigen?: number;
  /** Estado de la fase de descarga. */
  estado?: EstadoProceso;
  /** Rutas locales de los PDF descargados. */
  archivos?: string[];
  /** Marca de la primera vez que se vio, en ISO-8601. */
  vistoEn?: string;
}

/** Estado persistido para reanudar una ejecución interrumpida. */
export interface EstadoEjecucion {
  /** Criterio de búsqueda con el que se abrió la sesión. */
  criterio: Record<string, string | undefined>;
  /** Última página de resultados procesada por completo (1-based). */
  ultimaPaginaCompletada: number;
  /** True cuando se agotó el paginador con evidencia, no por una página vacía suelta. */
  extraccionCompletada: boolean;
  /** Total de resultados que anunció el portal, si lo anunció. */
  totalAnunciado?: number;
  /** Marca de la última escritura, en ISO-8601. */
  actualizadoEn: string;
}

/** Registro de un fallo para poder reintentarlo en otra pasada. */
export interface Fallo {
  /**
   * A qué se refiere el fallo: la `claveUnica` del proceso afectado, o un
   * `pagina-N` cuando lo que falló fue una página entera de resultados.
   *
   * Es la clave del scraper y no el número CNJ por el mismo motivo que en
   * `ProcesoJudicial`: un proceso en sigilo también puede fallar al descargarse,
   * y tiene que poder anotarse sin inventarle un número.
   */
  claveUnica: string;
  /** Qué se intentaba: 'documento' | 'pagina' | 'ficha'. */
  fase: string;
  motivo: string;
  intentos: number;
  ultimoIntentoEn: string;
}
