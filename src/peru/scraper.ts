/**
 * Orquestador del objetivo peruano (Jurisprudencia Nacional Sistematizada).
 *
 * Mismas dos fases que el objetivo brasileño, y por el mismo motivo: la Fase 1
 * se puede repetir sin duplicar nada y la Fase 2 se puede lanzar más tarde sobre
 * lo que la Fase 1 dejó en disco.
 *
 * LA DIFERENCIA QUE IMPORTA FRENTE AL TRF5: aquí **no hay CAPTCHA y el PDF cuelga
 * de la propia lista**. Cada panel de resultados publica su `ServletDescarga?uuid=`
 * directamente, así que la Fase 2 no necesita abrir la ficha de cada expediente
 * —no hay una navegación intermedia que pueda fallar— y la ejecución completa,
 * de la primera página a la última, se puede dejar corriendo sin nadie delante.
 * Eso es lo que convierte a este objetivo en la demostración del requisito
 * «navegar por todas las páginas» que el TRF5, bloqueado por su CAPTCHA de
 * imagen, no puede dar.
 *
 * Reutiliza sin cambios `Persistencia` (JSON + CSV + `failed.json` + reanudación)
 * y `ServicioDescarga` (escritura atómica, validación de bytes, nombres seguros),
 * que son los módulos donde vive el cumplimiento del enunciado.
 */
import * as fs from 'fs';
import { CONFIG } from '../config';
import { ServicioDescarga } from '../descarga';
import { EstructuraInesperadaError } from '../errores';
import { Persistencia } from '../persistencia';
import { EstadoEjecucion, ProcesoJudicial } from '../types';
import { mismoCriterio } from '../scraper';
import { log } from '../utils/logger';
import { esReintentable, SesionCaducadaError, ServidorSaturadoError, sleep } from '../utils/retry';
import { detectarPaginaActual, detectarTotalPaginas, hayPaginaSiguiente, parsearResoluciones } from './parser';
import { CriteriosPeru, SesionPeru } from './session';

/** Páginas vacías consecutivas que se exigen antes de dar la extracción por terminada. */
const PAGINAS_VACIAS_PARA_TERMINAR = 2;

export interface OpcionesPeru {
  criterios: CriteriosPeru;
  /** Tope de páginas de la Fase 1. */
  maxPaginas: number;
  /** Tope de documentos de la Fase 2. Sirve para demostrar sin bajarlo todo. */
  maxDescargas?: number;
}

export class ScraperPeru {
  private readonly persistencia = new Persistencia();

  /**
   * Fase 1: recorrer el paginador y extraer los metadatos de cada resolución.
   *
   * Reanuda desde `state.json`: si una ejecución anterior llegó a la página N,
   * esta salta hasta N antes de acumular. El coste de una interrupción es, como
   * máximo, una página.
   */
  async fase1(opciones: OpcionesPeru): Promise<number> {
    log.info('=== FASE 1 · Extracción de metadatos (Perú) ===');

    const procesos = this.persistencia.cargarProcesos();
    const estadoPrevio = this.persistencia.cargarEstado();
    // Reanudar solo tiene sentido sobre la MISMA búsqueda: la página 50 de
    // «amparo» no es la página 50 de «casación laboral».
    const mismaBusqueda = estadoPrevio === undefined || mismoCriterio(estadoPrevio.criterio, opciones.criterios);
    if (!mismaBusqueda) {
      log.warn('El criterio de búsqueda cambió respecto de la ejecución anterior: se empieza desde la primera página.');
    }
    const desde = estadoPrevio?.extraccionCompletada || !mismaBusqueda ? 0 : (estadoPrevio?.ultimaPaginaCompletada ?? 0);
    if (desde > 0) log.info(`Reanudando: la ejecución anterior completó hasta la página ${desde}`);

    const sesion = new SesionPeru();
    await sesion.abrir();

    if (!(await sesion.buscar(opciones.criterios))) {
      log.error('La búsqueda no devolvió resultados con estos criterios.');
      return 0;
    }

    const totalPaginas = detectarTotalPaginas(sesion.documento);
    if (totalPaginas !== undefined) log.info(`El portal anuncia ${totalPaginas} páginas de resultados`);

    let pagina = 1;
    let vaciasSeguidas = 0;
    let completada = false;
    /**
     * Última página parseada ENTERA. No es `pagina`: el bucle puede cortarse
     * antes de procesar la página en curso, y guardar `pagina` haría que la
     * ejecución siguiente reanudara después de una página que nunca se leyó.
     */
    let ultimaCompletada = desde;
    /** Resoluciones vistas EN ESTA EJECUCIÓN, para no contar las de pasadas anteriores. */
    const vistasAhora = new Set<string>();

    // Avance rápido hasta la página guardada. Una sesión nueva siempre empieza en la 1.
    while (pagina <= desde && pagina < opciones.maxPaginas) {
      if (!(await this.avanzar(sesion, pagina + 1))) break;
      pagina++;
    }

    while (pagina <= opciones.maxPaginas) {
      try {
        const lote = parsearResoluciones(sesion.documento, pagina);
        const nuevas = this.persistencia.anadirProcesos(procesos, lote);
        for (const r of lote) vistasAhora.add(r.claveUnica);
        ultimaCompletada = pagina;
        log.info(
          `Página ${pagina}: ${lote.length} resoluciones, ${nuevas} nuevas ` +
            `(acumulado ${procesos.size}, esta ejecución ${vistasAhora.size})`,
        );

        if (lote.length === 0) {
          vaciasSeguidas++;
          // Una página vacía puede ser un hipo del servidor. Se exige corroboración
          // antes de declarar terminada la extracción y bloquear futuras pasadas.
          if (vaciasSeguidas >= PAGINAS_VACIAS_PARA_TERMINAR) {
            log.info(`${vaciasSeguidas} páginas vacías consecutivas: extracción completa`);
            completada = true;
            break;
          }
        } else {
          vaciasSeguidas = 0;
        }
      } catch (e) {
        if (e instanceof EstructuraInesperadaError) {
          log.error(`La estructura de los resultados cambió: ${e.message}`);
          this.persistencia.registrarFallo({ claveUnica: `pagina-${pagina}`, fase: 'pagina', motivo: e.message });
          break;
        }
        throw e;
      }

      // Persistir en cada página, no al final: es lo que hace barata una interrupción.
      this.persistencia.guardarProcesos(procesos);
      this.persistencia.guardarEstado(this.estado(opciones.criterios, ultimaCompletada, false, totalPaginas));

      // El total del portal se cuenta en PÁGINAS, no en registros: compararlo con
      // el número de resoluciones acumuladas daría por terminada la extracción
      // nada más pasar la décima página.
      const actual = detectarPaginaActual(sesion.documento) ?? pagina;
      if (totalPaginas !== undefined && actual >= totalPaginas) {
        log.info(`Alcanzada la última página anunciada (${totalPaginas}): extracción completa`);
        completada = true;
        break;
      }

      if (!hayPaginaSiguiente(sesion.documento, actual)) {
        log.info('El paginador no ofrece más páginas: extracción completa');
        completada = true;
        break;
      }

      await sleep(CONFIG.delayBetweenRequestsMs);
      if (!(await this.avanzar(sesion, pagina + 1))) break;
      pagina++;
    }

    this.persistencia.guardarProcesos(procesos);
    this.persistencia.guardarEstado(this.estado(opciones.criterios, ultimaCompletada, completada, totalPaginas));
    const csv = this.persistencia.exportarCsv(procesos);
    log.info(`Fase 1 terminada: ${procesos.size} resoluciones. JSON en ${CONFIG.recordsPath}, CSV en ${csv}`);
    return procesos.size;
  }

  /**
   * Fase 2: descargar los PDF de las resoluciones ya indexadas.
   *
   * El enlace de descarga se leyó de la propia lista en la Fase 1, así que aquí
   * no hay ninguna navegación intermedia: se abre una sesión —el servlet exige
   * las cookies— y se piden los documentos uno a uno.
   *
   * Un documento que falla se anota en `failed.json` y NO detiene la ejecución,
   * que es exactamente lo que pide el enunciado para el 429.
   */
  async fase2(opciones: OpcionesPeru): Promise<number> {
    log.info('=== FASE 2 · Descarga de PDF (Perú) ===');

    const procesos = this.persistencia.cargarProcesos();
    if (procesos.size === 0) {
      log.warn('No hay resoluciones indexadas. Ejecuta antes la Fase 1.');
      return 0;
    }

    const pendientes = [...procesos.values()].filter((p) => p.estado !== 'completado' && p.estado !== 'sin_documentos');
    log.info(`${pendientes.length} resoluciones pendientes de ${procesos.size}`);

    // El servlet de descarga valida la sesión: sin cookies responde con la página
    // de entrada en lugar del PDF, y `ServicioDescarga` la rechazaría por firma.
    const sesion = new SesionPeru();
    await sesion.abrir();

    const descargas = new ServicioDescarga(sesion);
    let bajados = 0;
    const tope = opciones.maxDescargas ?? Infinity;

    for (const proceso of pendientes) {
      if (bajados >= tope) {
        log.info(`Alcanzado el límite de ${tope} descargas de esta ejecución`);
        break;
      }

      const etiqueta = proceso.numeroProcesso ?? proceso.claveUnica;
      const documentos = (proceso.documentos ?? []).filter((d) => d.descarga !== undefined);

      if (documentos.length === 0) {
        // Terminal y con constancia: la Fase 1 leyó este panel y no publicaba
        // enlace de descarga. Marcarlo lo saca de futuras pasadas sin ocultar nada,
        // porque el registro conserva todo lo demás que el portal sí publicó.
        proceso.estado = 'sin_documentos';
        this.persistencia.guardarProcesos(procesos);
        continue;
      }

      const rutas: string[] = [];
      let fallidos = 0;
      for (const documento of documentos) {
        try {
          // `descargar` devuelve la ruta sin pedir nada cuando el fichero ya está
          // validado en disco. Eso no es una descarga y no debe consumir el tope,
          // o una segunda pasada agotaría el cupo saltando ficheros que ya tenía.
          const yaEstaba = fs.existsSync(descargas.rutaDe(proceso, documento));
          rutas.push(await descargas.descargar(proceso, documento));
          if (!yaEstaba) bajados++;
        } catch (e) {
          const motivo = e instanceof Error ? e.message : String(e);
          log.error(`Fallo al descargar "${documento.titulo}" de ${etiqueta}: ${motivo}`);
          fallidos++;
          this.persistencia.registrarFallo({
            claveUnica: proceso.claveUnica,
            fase: 'documento',
            documento: { ...(documento.id ? { id: documento.id } : {}), titulo: documento.titulo },
            motivo,
          });
          // Un documento fallido no detiene la ejecución: se registra y se sigue.
        }
        await sleep(CONFIG.delayBetweenDownloadsMs);
      }

      proceso.archivos = [...new Set([...(proceso.archivos ?? []), ...rutas])];
      // `completado` solo sin fallos: `parcial` mantiene la resolución dentro del
      // filtro de pendientes para que la pasada siguiente reintente lo que falta.
      proceso.estado = fallidos === 0 ? 'completado' : rutas.length > 0 ? 'parcial' : 'fallido';
      // Persistir tras cada resolución: una interrupción cuesta una, no la pasada.
      this.persistencia.guardarProcesos(procesos);
    }

    log.info(`Fase 2 terminada: ${bajados} archivos descargados en ${CONFIG.pdfDir}`);
    return bajados;
  }

  // ---------------------------------------------------------------- internos

  /** Pide la página `destino`. Devuelve false si no se pudo avanzar. */
  private async avanzar(sesion: SesionPeru, destino: number): Promise<boolean> {
    try {
      return await sesion.irAPagina(destino);
    } catch (e) {
      // Un transitorio agotado (429 persistente, corte de red) es fin ordenado del
      // recorrido, no error mortal: `state.json` ya guardó la última página
      // completada, así que relanzar reanuda sin perder nada. Propagarlo mataría
      // el proceso antes de exportar el CSV de lo ya extraído.
      if (e instanceof SesionCaducadaError || e instanceof ServidorSaturadoError || esReintentable(e)) {
        const motivo = e instanceof Error ? e.message : String(e);
        log.warn(`No se pudo avanzar a la página ${destino}: ${motivo}`);
        this.persistencia.registrarFallo({ claveUnica: `pagina-${destino}`, fase: 'pagina', motivo });
        return false;
      }
      throw e;
    }
  }

  private estado(
    criterios: CriteriosPeru,
    pagina: number,
    completada: boolean,
    totalPaginas: number | undefined,
  ): EstadoEjecucion {
    return {
      criterio: { ...criterios },
      ultimaPaginaCompletada: pagina,
      extraccionCompletada: completada,
      totalAnunciado: totalPaginas,
      actualizadoEn: new Date().toISOString(),
    };
  }
}

/** Reexportado por comodidad para el punto de entrada. */
export type { ProcesoJudicial };
