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
import { EstadoEjecucion, Fallo, Parte, ProcesoJudicial } from './types';
import { log } from './utils/logger';

/**
 * U+FEFF. Se construye por código en vez de incrustar el carácter en el fuente:
 * un BOM literal es invisible en el editor y cualquiera lo borraría sin saberlo.
 */
const CODIGO_BOM = 0xfeff;
const BOM_UTF8 = String.fromCharCode(CODIGO_BOM);

/**
 * Forma en disco de records.json: objeto indexado por numeroProcesso, no array.
 * Da búsqueda O(1) al deduplicar y hace los duplicados imposibles por
 * construcción, en vez de confiar en que nadie haga push dos veces.
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
  { cabecera: 'numeroProcesso', valor: (p) => p.numeroProcesso },
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

/**
 * Guarda de tipo para lo que sale de JSON.parse: el fichero lo pudo escribir
 * una versión anterior del scraper, así que su forma se comprueba, no se asume.
 */
function esProceso(valor: unknown): valor is ProcesoJudicial {
  if (typeof valor !== 'object' || valor === null) return false;
  const candidato = valor as {
    numeroProcesso?: unknown;
    partes?: unknown;
    documentos?: unknown;
    archivos?: unknown;
  };
  if (typeof candidato.numeroProcesso !== 'string' || candidato.numeroProcesso.trim().length === 0) return false;
  // Los campos de colección se declaran array en el contrato y el resto del
  // scraper los recorre sin volver a mirar. Si el fichero trae otra cosa, el
  // registro entero es sospechoso y se descarta aquí, que es la frontera donde
  // el módulo promete que un fichero corrupto degrada en vez de reventar.
  const coleccionValida = (v: unknown): boolean => v === undefined || Array.isArray(v);
  return coleccionValida(candidato.partes) && coleccionValida(candidato.documentos) && coleccionValida(candidato.archivos);
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

function esFallo(valor: unknown): valor is Fallo {
  if (typeof valor !== 'object' || valor === null) return false;
  const candidato = valor as { numeroProcesso?: unknown; fase?: unknown };
  return typeof candidato.numeroProcesso === 'string' && typeof candidato.fase === 'string';
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
      log.warn(`${this.rutaProcesos} no es un objeto indexado por número de proceso: se empieza de cero`);
      return mapa;
    }

    let descartados = 0;
    for (const valor of Object.values(crudo as Record<string, unknown>)) {
      if (!esProceso(valor)) {
        descartados++;
        continue;
      }
      // Ante discrepancia entre la clave del fichero y el campo, manda el campo:
      // numeroProcesso es el dato del portal, la clave es solo un índice.
      mapa.set(valor.numeroProcesso, valor);
    }
    if (descartados > 0) log.warn(`${descartados} entrada(s) de records.json sin número de proceso: descartadas`);
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
      const clave = typeof proceso.numeroProcesso === 'string' ? proceso.numeroProcesso.trim() : '';
      if (clave.length === 0) {
        log.warn('Proceso sin numeroProcesso: se ignora');
        continue;
      }
      // Deduplicación por la clave que asigna el poder judicial: es estable
      // entre páginas y entre ejecuciones, a diferencia de cualquier id propio.
      if (procesos.has(clave)) continue;

      procesos.set(clave, {
        ...proceso,
        numeroProcesso: clave,
        // vistoEn marca el primer avistamiento: solo se sella al insertar, nunca
        // se refresca, o dejaría de significar "primera vez".
        vistoEn: proceso.vistoEn ?? ahora,
        estado: proceso.estado ?? 'pendiente',
      });
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
    return crudo.filter(esFallo).map((fallo) => ({
      ...fallo,
      intentos: typeof fallo.intentos === 'number' && fallo.intentos > 0 ? fallo.intentos : 1,
      ultimoIntentoEn: typeof fallo.ultimoIntentoEn === 'string' ? fallo.ultimoIntentoEn : new Date(0).toISOString(),
    }));
  }

  /**
   * Anota un fallo para reintentarlo en otra pasada.
   *
   * La clave es (numeroProcesso, fase): el mismo proceso puede fallar al listar
   * su ficha y también al descargar un documento, y son dos problemas distintos.
   */
  registrarFallo(fallo: Omit<Fallo, 'intentos' | 'ultimoIntentoEn'>): void {
    const fallos = this.cargarFallos();
    const ahora = new Date().toISOString();
    const existente = fallos.find((f) => f.numeroProcesso === fallo.numeroProcesso && f.fase === fallo.fase);

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
    log.debug(`Fallo registrado: ${fallo.numeroProcesso} [${fallo.fase}]`);
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
