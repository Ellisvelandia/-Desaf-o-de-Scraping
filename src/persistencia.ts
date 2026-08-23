/**
 * Persistencia en disco: procesos, estado de reanudación, fallos y export CSV.
 *
 * Dos garantías gobiernan todo el módulo, porque una ejecución de scraping dura
 * horas y se interrumpe (Ctrl+C, 429 que agota reintentos, corte de red):
 *  - Escritura atómica: temporal + rename. Un proceso muerto a mitad de un
 *    writeFileSync deja un JSON truncado que reventaría la ejecución siguiente,
 *    justo cuando más importa poder reanudar.
 *  - Lectura defensiva: todo JSON.parse va acorralado. Un fichero corrupto
 *    degrada a "empezar de cero con un aviso por log", nunca a excepción no
 *    capturada que tumbe el arranque.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from './config';
import { ServicioDescarga } from './descarga';
import { DocumentoProceso, EstadoEjecucion, Fallo, Parte, ProcesoJudicial } from './types';
import { log } from './utils/logger';

/**
 * U+FEFF. Se construye por código en vez de incrustar el carácter en el fuente:
 * un BOM literal es invisible en el editor y cualquiera lo borraría sin saberlo.
 */
const CODIGO_BOM = 0xfeff;
const BOM_UTF8 = String.fromCharCode(CODIGO_BOM);

/**
 * Forma en disco de records.json: objeto indexado por `claveUnica`, no array.
 * Da búsqueda O(1) al deduplicar y hace los duplicados imposibles por
 * construcción, en vez de confiar en que nadie haga push dos veces.
 *
 * La clave es `claveUnica` y no `numeroProcesso` porque hay procesos que el
 * portal publica SIN número (segredo de justiça). Con el número como índice,
 * esas filas solo tenían dos destinos: perderse, o forzar a inventarles uno.
 */
type RegistroProcesos = Record<string, ProcesoJudicial>;

/** Columna del CSV: cabecera estable y cómo se aplana el proceso a texto. */
interface ColumnaCsv {
  cabecera: string;
  valor: (proceso: ProcesoJudicial) => string;
}

/**
 * Solo columnas estables del contrato. `camposExtra` queda fuera a propósito:
 * su forma depende de las cabeceras que publique el portal ese día y una
 * cabecera variable rompe cualquier consumidor del CSV.
 */
const COLUMNAS: ReadonlyArray<ColumnaCsv> = [
  // `claveUnica` va primera porque es el índice del fichero: es la columna con la
  // que una fila del CSV se vuelve a encontrar en `records.json`.
  { cabecera: 'claveUnica', valor: (p) => p.claveUnica ?? '' },
  // Y `numeroProcesso` justo después, VACÍO cuando el portal no lo publica. La
  // celda en blanco es el dato correcto: significa "el tribunal no lo dice", y la
  // columna de al lado explica por qué.
  { cabecera: 'numeroProcesso', valor: (p) => p.numeroProcesso ?? '' },
  { cabecera: 'enSigilo', valor: (p) => (p.enSigilo === true ? 'true' : 'false') },
  { cabecera: 'orgaoJulgador', valor: (p) => p.orgaoJulgador ?? '' },
  { cabecera: 'classeJudicial', valor: (p) => p.classeJudicial ?? '' },
  { cabecera: 'dataAutuacao', valor: (p) => p.dataAutuacao ?? '' },
  { cabecera: 'partes', valor: (p) => serializarPartes(p.partes) },
  // Los documentos van como recuento: sus títulos son largos y volcarlos
  // enteros convierte la celda en un párrafo ilegible. El detalle está en el JSON.
  // Las colecciones se comprueban con `Array.isArray` en vez de con `?? []`: el
  // registro puede venir de un records.json escrito por otra versión o editado a
  // mano, y `.join` sobre algo que no es un array aborta la exportación entera
  // justo después de una extracción de horas.
  { cabecera: 'documentos', valor: (p) => String(Array.isArray(p.documentos) ? p.documentos.length : 0) },
  { cabecera: 'archivos', valor: (p) => (Array.isArray(p.archivos) ? p.archivos.join('; ') : '') },
  { cabecera: 'estado', valor: (p) => p.estado ?? '' },
  { cabecera: 'paginaOrigen', valor: (p) => (p.paginaOrigen === undefined ? '' : String(p.paginaOrigen)) },
  { cabecera: 'vistoEn', valor: (p) => p.vistoEn ?? '' },
];

/**
 * "PAPEL: Nombre; PAPEL: Nombre". Sin papel se emite solo el nombre.
 *
 * Se filtra elemento a elemento por el mismo motivo que las columnas de arriba:
 * un `null` o una cadena suelta dentro del array (fichero de otra versión) haría
 * estallar el acceso a `.papel` y con él toda la exportación.
 */
function serializarPartes(partes: Parte[] | undefined): string {
  if (!Array.isArray(partes) || partes.length === 0) return '';
  return partes
    .filter((parte): parte is Parte => typeof parte === 'object' && parte !== null && typeof parte.nombre === 'string')
    .map((parte) => (parte.papel ? `${parte.papel}: ${parte.nombre}` : parte.nombre))
    .join('; ');
}

/**
 * Se entrecomilla siempre, no solo cuando hace falta: así una coma, un punto y
 * coma o un salto de línea dentro del nombre de una parte no puede partir la
 * fila. Las comillas internas se duplican, que es el escape de RFC 4180 y el
 * único que entiende Excel.
 */
function escaparCsv(valor: string): string {
  return `"${valor.replace(/"/g, '""')}"`;
}

/** Devuelve la cadena recortada, o '' si no era una cadena con contenido. */
function texto(valor: unknown): string {
  return typeof valor === 'string' ? valor.trim() : '';
}

/**
 * Valida y normaliza lo que sale de JSON.parse, o devuelve undefined.
 *
 * El fichero lo pudo escribir una versión anterior del scraper, así que su forma
 * se comprueba, no se asume. Y hace además una MIGRACIÓN: un `records.json` de
 * un formato anterior está indexado por número de proceso y no trae
 * `claveUnica`, así que aquí se deriva del número. Sin esto, una actualización
 * del scraper descartaría en silencio todos los procesos ya extraídos —incluido
 * su estado `completado`— y la pasada siguiente volvería a bajarlo todo.
 */
function aProceso(valor: unknown): ProcesoJudicial | undefined {
  if (typeof valor !== 'object' || valor === null) return undefined;
  const candidato = valor as {
    claveUnica?: unknown;
    numeroProcesso?: unknown;
    partes?: unknown;
    documentos?: unknown;
    archivos?: unknown;
  };

  const numero = texto(candidato.numeroProcesso);
  // La clave del contrato manda; el número solo es el respaldo del formato viejo.
  const clave = texto(candidato.claveUnica) || numero;
  if (clave.length === 0) return undefined;

  // Los campos de colección se declaran array en el contrato y el resto del
  // scraper los recorre sin volver a mirar. Si el fichero trae otra cosa, el
  // registro entero es sospechoso y se descarta aquí, que es la frontera donde
  // el módulo promete que un fichero corrupto degrada en vez de reventar.
  const coleccionValida = (v: unknown): boolean => v === undefined || Array.isArray(v);
  if (!coleccionValida(candidato.partes)) return undefined;
  if (!coleccionValida(candidato.documentos)) return undefined;
  if (!coleccionValida(candidato.archivos)) return undefined;

  const proceso: ProcesoJudicial = { ...(valor as ProcesoJudicial), claveUnica: clave };
  // Un `numeroProcesso` vacío o no-cadena se omite en vez de propagarse: el
  // contrato dice que ese campo, si está, es el número que publicó el tribunal.
  if (numero.length > 0) proceso.numeroProcesso = numero;
  else delete proceso.numeroProcesso;
  return proceso;
}

function esEstado(valor: unknown): valor is EstadoEjecucion {
  if (typeof valor !== 'object' || valor === null) return false;
  const candidato = valor as { ultimaPaginaCompletada?: unknown; criterio?: unknown };
  // La página es el único campo del que depende la reanudación: si no es un
  // número, reanudar por él sería peor que empezar de cero.
  return (
    typeof candidato.ultimaPaginaCompletada === 'number' &&
    typeof candidato.criterio === 'object' &&
    candidato.criterio !== null
  );
}

/**
 * Valida y normaliza una entrada de failed.json, o devuelve undefined.
 *
 * Acepta también el `numeroProcesso` del formato anterior como clave: un
 * failed.json escrito por una versión previa no debe perder los reintentos ya
 * contados solo porque el campo cambió de nombre.
 */
/**
 * Identidad del documento dentro de un fallo, para deduplicar.
 *
 * El `id` manda cuando el portal lo publica —es estable entre ejecuciones—. Si
 * no, la misma huella que `ServicioDescarga.discriminante` (fecha + hash del
 * descriptor de descarga): el PJe repite títulos como «Despacho» sin `id`, y
 * clavear solo por título fundía dos fallos distintos en una entrada con un
 * `intentos` compartido. El título solo queda como último recurso para entradas
 * viejas de `failed.json` que no guardaron `descarga`.
 *
 * Cadena vacía para los fallos que no son de un documento (`pagina`, `ficha`),
 * de modo que esos sigan deduplicándose por (clave, fase) como antes.
 */
function identidadDocumento(fallo: Pick<Fallo, 'documento'>): string {
  const doc = fallo.documento;
  // Comprobación de tipo, no solo de `undefined`: `failed.json` está pensado para
  // que el operador lo lea y lo retoque, y también lo pudo escribir otra versión.
  // Con un `"documento": null` o una cadena suelta, acceder a `.id` lanzaba desde
  // DENTRO del catch que registra el fallo, y ese error tumbaba la Fase 2 entera
  // justo en el camino cuyo trabajo es que un fallo no detenga la ejecución.
  if (typeof doc !== 'object' || doc === null) return '';
  const tipado = doc as Partial<DocumentoProceso>;
  const id = texto(tipado.id);
  if (id) return id;
  if (tipado.descarga != null || texto(tipado.fecha)) {
    return ServicioDescarga.discriminante({
      ...(texto(tipado.fecha) ? { fecha: tipado.fecha } : {}),
      ...(tipado.descarga != null ? { descarga: tipado.descarga } : {}),
    });
  }
  return texto(tipado.titulo);
}

/**
 * Recorte de un documento para anotarlo en `failed.json`: lo mínimo para
 * identificarlo (y reintentarlo) sin volcar el resto del proceso.
 */
export function documentoParaFallo(documento: DocumentoProceso): NonNullable<Fallo['documento']> {
  return {
    ...(documento.id ? { id: documento.id } : {}),
    titulo: documento.titulo,
    ...(documento.fecha ? { fecha: documento.fecha } : {}),
    ...(documento.descarga ? { descarga: documento.descarga } : {}),
  };
}

function aFallo(valor: unknown): Fallo | undefined {
  if (typeof valor !== 'object' || valor === null) return undefined;
  const candidato = valor as { claveUnica?: unknown; numeroProcesso?: unknown; fase?: unknown };
  const clave = texto(candidato.claveUnica) || texto(candidato.numeroProcesso);
  if (clave.length === 0 || typeof candidato.fase !== 'string') return undefined;
  return { ...(valor as Fallo), claveUnica: clave };
}

export class Persistencia {
  private readonly rutaProcesos = CONFIG.recordsPath;
  private readonly rutaEstado = CONFIG.statePath;
  private readonly rutaFallos = CONFIG.failedPath;
  private readonly rutaCsv = path.join(CONFIG.outputDir, 'records.csv');

  constructor() {
    // El árbol de salida se crea una vez aquí para que el primer guardado no
    // falle por ENOENT del directorio en mitad de una extracción ya pagada.
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }

  // --- procesos -----------------------------------------------------------

  /** Lee records.json. Un fichero ausente o corrupto devuelve un mapa vacío. */
  cargarProcesos(): Map<string, ProcesoJudicial> {
    const mapa = new Map<string, ProcesoJudicial>();
    const crudo = this.leerJson(this.rutaProcesos);
    if (crudo === undefined) return mapa;

    if (typeof crudo !== 'object' || crudo === null || Array.isArray(crudo)) {
      log.warn(`${this.rutaProcesos} no es un objeto indexado por clave de proceso: se empieza de cero`);
      return mapa;
    }

    let descartados = 0;
    for (const valor of Object.values(crudo as Record<string, unknown>)) {
      const proceso = aProceso(valor);
      if (proceso === undefined) {
        descartados++;
        continue;
      }
      // Ante discrepancia entre la clave del fichero y el campo, manda el campo:
      // la clave del objeto JSON es solo un índice, y `aProceso` ya ha decidido
      // cuál es la buena (incluida la derivada de un fichero de formato anterior).
      mapa.set(proceso.claveUnica, proceso);
    }
    if (descartados > 0) {
      log.warn(`${descartados} entrada(s) de records.json sin clave utilizable (ni claveUnica ni número): descartadas`);
    }
    log.debug(`Procesos cargados: ${mapa.size}`);
    return mapa;
  }

  /** Vuelca el mapa como objeto indexado, de forma atómica. */
  guardarProcesos(procesos: Map<string, ProcesoJudicial>): void {
    const registro: RegistroProcesos = {};
    // Se respeta el orden de inserción del mapa, que es el orden de aparición en
    // el paginador: el JSON queda legible como el recorrido real del portal.
    for (const [clave, proceso] of procesos) registro[clave] = proceso;
    this.escribirAtomico(this.rutaProcesos, JSON.stringify(registro, null, 2));
    log.debug(`records.json escrito: ${procesos.size} proceso(s)`);
  }

  /**
   * Inserta en el mapa solo los que no existan y devuelve cuántos eran nuevos.
   *
   * No toca el disco: el llamador decide cuándo hacer flush (típicamente una vez
   * por página), en vez de reescribir el fichero entero por cada fila.
   */
  anadirProcesos(procesos: Map<string, ProcesoJudicial>, nuevos: ProcesoJudicial[]): number {
    const ahora = new Date().toISOString();
    let insertados = 0;

    for (const proceso of nuevos) {
      // El parser puede devolver una fila degenerada (cabecera, fila "sin
      // resultados"); sin clave no hay deduplicación posible, así que se ignora.
      // Se acepta el número como respaldo por si el registro viene de un
      // llamador que no rellenó `claveUnica`.
      const numero = texto(proceso.numeroProcesso);
      const clave = texto(proceso.claveUnica) || numero;
      if (clave.length === 0) {
        log.warn('Proceso sin claveUnica ni numeroProcesso: se ignora');
        continue;
      }
      // Deduplicación por `claveUnica`: el número CNJ cuando el tribunal lo
      // publica —estable entre páginas y entre ejecuciones—, y el identificador
      // derivado del enlace a la ficha cuando el proceso está en sigilo. Dos
      // procesos en sigilo distintos traen `ca=` distintos y no se funden.
      if (procesos.has(clave)) continue;

      const registro: ProcesoJudicial = {
        ...proceso,
        claveUnica: clave,
        // vistoEn marca el primer avistamiento: solo se sella al insertar, nunca
        // se refresca, o dejaría de significar "primera vez".
        vistoEn: proceso.vistoEn ?? ahora,
        estado: proceso.estado ?? 'pendiente',
      };
      // El número del portal, si lo hay, se guarda normalizado; si no lo hay, el
      // campo se omite en lugar de quedarse con la clave del scraper dentro.
      if (numero.length > 0) registro.numeroProcesso = numero;
      else delete registro.numeroProcesso;

      procesos.set(clave, registro);
      insertados++;
    }
    return insertados;
  }

  // --- estado de reanudación ----------------------------------------------

  cargarEstado(): EstadoEjecucion | undefined {
    const crudo = this.leerJson(this.rutaEstado);
    if (crudo === undefined) return undefined;
    if (!esEstado(crudo)) {
      log.warn(`${this.rutaEstado} no tiene forma de estado de ejecución: se ignora y se extrae desde el principio`);
      return undefined;
    }
    return crudo;
  }

  guardarEstado(estado: EstadoEjecucion): void {
    // actualizadoEn lo sella el escritor, no el llamador: su significado es
    // "cuándo se persistió esto", y solo aquí se conoce ese instante.
    const aEscribir: EstadoEjecucion = { ...estado, actualizadoEn: new Date().toISOString() };
    this.escribirAtomico(this.rutaEstado, JSON.stringify(aEscribir, null, 2));
  }

  // --- fallos --------------------------------------------------------------

  cargarFallos(): Fallo[] {
    const crudo = this.leerJson(this.rutaFallos);
    if (crudo === undefined) return [];
    if (!Array.isArray(crudo)) {
      log.warn(`${this.rutaFallos} no es un array de fallos: se empieza de cero`);
      return [];
    }
    // Se normalizan los contadores: una entrada escrita por una versión anterior
    // podría no traer `intentos`, y entonces el incremento daría NaN y el
    // criterio de "cuántas veces reintentar antes de rendirse" dejaría de existir.
    return crudo
      .map(aFallo)
      .filter((fallo): fallo is Fallo => fallo !== undefined)
      .map((fallo) => ({
        ...fallo,
        intentos: typeof fallo.intentos === 'number' && fallo.intentos > 0 ? fallo.intentos : 1,
        ultimoIntentoEn: typeof fallo.ultimoIntentoEn === 'string' ? fallo.ultimoIntentoEn : new Date(0).toISOString(),
      }));
  }

  /**
   * Anota un fallo para reintentarlo en otra pasada.
   *
   * La clave es (claveUnica, fase, documento): el mismo proceso puede fallar al
   * listar su ficha y también al descargar un documento, y son dos problemas
   * distintos; y DENTRO de la fase `documento` puede fallar más de uno.
   *
   * El tercer componente se añadió porque sin él el contador `intentos` mentía:
   * dos documentos distintos que fallaban una vez cada uno producían una sola
   * entrada con `intentos: 2`, idéntica a la de un documento que falló dos veces.
   * El enunciado pide saber QUÉ documentos fallaron, y con la clave anterior eso
   * era irrecuperable del fichero.
   *
   * Se indexa por `claveUnica` y no por el número CNJ para que un proceso en
   * sigilo —que no tiene número— también pueda anotarse y reintentarse.
   */
  registrarFallo(fallo: Omit<Fallo, 'intentos' | 'ultimoIntentoEn'>): void {
    const fallos = this.cargarFallos();
    const ahora = new Date().toISOString();
    const existente = fallos.find(
      (f) => f.claveUnica === fallo.claveUnica && f.fase === fallo.fase && identidadDocumento(f) === identidadDocumento(fallo),
    );

    if (existente) {
      // Se acumula en la entrada existente en vez de duplicar: así el contador
      // de intentos sirve para decidir cuándo rendirse con ese proceso.
      existente.intentos += 1;
      existente.ultimoIntentoEn = ahora;
      existente.motivo = fallo.motivo;
    } else {
      fallos.push({ ...fallo, intentos: 1, ultimoIntentoEn: ahora });
    }

    this.escribirAtomico(this.rutaFallos, JSON.stringify(fallos, null, 2));
    log.debug(`Fallo registrado: ${fallo.claveUnica} [${fallo.fase}]`);
  }

  // --- export --------------------------------------------------------------

  /** Escribe el CSV y devuelve la ruta usada. */
  exportarCsv(procesos: Map<string, ProcesoJudicial>, ruta?: string): string {
    const destino = ruta ?? this.rutaCsv;
    const lineas: string[] = [COLUMNAS.map((columna) => escaparCsv(columna.cabecera)).join(',')];
    for (const proceso of procesos.values()) {
      lineas.push(COLUMNAS.map((columna) => escaparCsv(columna.valor(proceso))).join(','));
    }

    // BOM UTF-8: sin él, Excel en Windows abre el fichero en la ANSI local y
    // destroza los acentos del portugués (Órgão, Réu). CRLF por el mismo motivo.
    const contenido = `${BOM_UTF8}${lineas.join('\r\n')}\r\n`;
    this.escribirAtomico(destino, contenido);
    log.info(`CSV exportado: ${destino} (${procesos.size} fila(s))`);
    return destino;
  }

  // --- primitivas de E/S ---------------------------------------------------

  /**
   * Escribe por temporal + rename. rename es atómico dentro del mismo volumen
   * (y en Windows reemplaza el destino), así que el fichero final nunca existe a
   * medias: o es el contenido anterior completo, o el nuevo completo.
   */
  private escribirAtomico(ruta: string, contenido: string): void {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    const temporal = `${ruta}.tmp`;
    try {
      fs.writeFileSync(temporal, contenido, 'utf8');
      fs.renameSync(temporal, ruta);
    } catch (error) {
      // Un `.tmp` truncado que sobrevive al fallo confunde en el siguiente
      // arranque y, si el fallo fue por disco lleno, retiene el espacio que hace
      // falta para reintentar. Se limpia antes de propagar el error real.
      try {
        fs.rmSync(temporal, { force: true });
      } catch {
        // Limpiar es un extra: nunca debe sustituir al error que se propaga.
      }
      throw error;
    }
  }

  /**
   * Lee y parsea un JSON sin poder lanzar: devuelve undefined si no existe, si
   * no se puede leer o si no es JSON válido.
   */
  private leerJson(ruta: string): unknown {
    let crudo: string;
    try {
      crudo = fs.readFileSync(ruta, 'utf8');
    } catch (error) {
      // ENOENT es el caso normal de la primera ejecución, no una anomalía: avisar
      // de él entrenaría al operador a ignorar los avisos que sí importan.
      const codigo = (error as NodeJS.ErrnoException).code;
      if (codigo !== 'ENOENT') log.warn(`No se pudo leer ${ruta}: ${(error as Error).message}`);
      return undefined;
    }

    try {
      // Un BOM al principio hace fallar a JSON.parse; puede venir de un editor
      // que reguardó el fichero a mano, y es demasiado barato de tolerar.
      const sinBom = crudo.charCodeAt(0) === CODIGO_BOM ? crudo.slice(1) : crudo;
      return JSON.parse(sinBom) as unknown;
    } catch (error) {
      log.warn(`${ruta} está corrupto (${(error as Error).message}): se empieza de cero`);
      this.apartarCorrupto(ruta);
      return undefined;
    }
  }

  /**
   * Renombra el fichero ilegible en lugar de dejar que el siguiente guardado lo
   * pise: puede contener horas de extracción rescatables a mano.
   */
  private apartarCorrupto(ruta: string): void {
    const destino = `${ruta}.corrupto-${Date.now()}`;
    try {
      fs.renameSync(ruta, destino);
      log.warn(`Copia del fichero corrupto guardada en ${destino}`);
    } catch (error) {
      // Salvar la evidencia es un extra: si falla, no debe impedir la ejecución.
      log.debug(`No se pudo apartar ${ruta}: ${(error as Error).message}`);
    }
  }
}
