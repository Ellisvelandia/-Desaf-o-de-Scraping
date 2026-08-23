/**
 * Orquestador del scraper.
 *
 * Coordina las dos fases que pide el desafío:
 *   Fase 1 — recorrer el paginador y extraer los metadatos de cada proceso.
 *   Fase 2 — descargar los PDF de los procesos ya indexados.
 *
 * Ambas son reanudables e independientes: la Fase 1 se puede repetir sin duplicar
 * nada, y la Fase 2 se puede lanzar en otro momento sobre lo que la Fase 1 dejó.
 */
import * as fs from 'fs';
import { CONFIG } from './config';
import { CriteriosBusqueda, SesionPje } from './session';
import { ResolutorCaptcha } from './captcha/humano';
import { detectarTotalResultados, parsearDocumentos, parsearProcesos, EstructuraInesperadaError } from './parser';
import { parsearFicha } from './ficha';
import { construirOpcionesPagina, detectarPaginacion, hayPaginaSiguiente } from './paginacion';
import { documentoParaFallo, Persistencia } from './persistencia';
import { ServicioDescarga } from './descarga';
import { DocumentoProceso, EstadoEjecucion, ProcesoJudicial } from './types';
import { log } from './utils/logger';
import { esReintentable, ServidorSaturadoError, SesionCaducadaError, sleep } from './utils/retry';

/** Páginas vacías consecutivas que se exigen antes de dar la extracción por terminada. */
const PAGINAS_VACIAS_PARA_TERMINAR = 2;

/**
 * Tope de páginas por ejecución, como red de seguridad ante un paginador que no
 * termine.
 *
 * Se valida en vez de confiar en `Number()`: un `MAX_PAGINAS=quinientas` daría
 * `NaN`, `pagina <= NaN` sería siempre falso y la Fase 1 terminaría sin extraer
 * nada informando de cero procesos, que parece un portal vacío y no un error de
 * configuración.
 */
export function enteroPositivo(valor: string | undefined, porDefecto: number, etiqueta: string): number {
  if (valor === undefined || valor.trim() === '') return porDefecto;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < 1) {
    log.warn(`${etiqueta}="${valor}" no es un entero positivo: se usa ${porDefecto}`);
    return porDefecto;
  }
  return n;
}

const MAX_PAGINAS = enteroPositivo(process.env.MAX_PAGINAS, 10000, 'MAX_PAGINAS');

/**
 * ¿Son el mismo criterio de búsqueda?
 *
 * Se comparan las claves con valor, no los objetos: `{a:'1'}` y
 * `{a:'1', b:undefined}` describen la misma búsqueda, y un `JSON.stringify` los
 * daría por distintos —descartando una reanudación legítima— solo porque una
 * versión del código añadió un campo opcional que nadie rellenó.
 */
export function mismoCriterio(
  a: Readonly<Record<string, string | undefined>>,
  // Los criterios concretos (`CriteriosBusqueda`, `CriteriosPeru`) son interfaces
  // sin índice de cadena, así que no encajan en `Record` sin este ensanchado.
  b: Readonly<Record<string, string | undefined>> | object,
): boolean {
  const util = (o: object): Array<[string, string]> =>
    Object.entries(o)
      .filter((par): par is [string, string] => par[1] !== undefined && par[1] !== '')
      .sort(([x], [y]) => x.localeCompare(y));
  const ma = util(a);
  const mb = util(b);
  return ma.length === mb.length && ma.every(([k, v], i) => mb[i][0] === k && mb[i][1] === v);
}

export interface OpcionesScraper {
  criterios: CriteriosBusqueda;
  /** Límite de documentos a descargar en la Fase 2. Sirve para demostrar sin bajarlo todo. */
  maxDescargas?: number;
}

export class Scraper {
  private readonly persistencia = new Persistencia();

  constructor(private readonly captcha: ResolutorCaptcha) {}

  /**
   * Fase 1: extracción de metadatos.
   *
   * Reanuda desde `state.json`: si una ejecución anterior llegó a la página N,
   * esta avanza hasta N antes de empezar a acumular. El coste de una interrupción
   * es, como máximo, una página.
   */
  async fase1(opciones: OpcionesScraper): Promise<number> {
    log.info('=== FASE 1 · Extracción de metadatos ===');

    const procesos = this.persistencia.cargarProcesos();
    const estadoPrevio = this.persistencia.cargarEstado();
    // Reanudar solo tiene sentido sobre LA MISMA búsqueda: la página 50 de
    // «SILVA» no es la página 50 de «SOUZA». Sin esta comprobación, cambiar el
    // criterio tras una interrupción hacía que el avance rápido saltara las 50
    // primeras páginas de la búsqueda nueva y las diera por extraídas.
    const mismaBusqueda = estadoPrevio === undefined || mismoCriterio(estadoPrevio.criterio, opciones.criterios);
    if (!mismaBusqueda) {
      log.warn(
        'El criterio de búsqueda cambió respecto de la ejecución anterior: se ignora la página guardada y se ' +
          'empieza desde la primera.',
      );
    }
    const desde = estadoPrevio?.extraccionCompletada || !mismaBusqueda ? 0 : (estadoPrevio?.ultimaPaginaCompletada ?? 0);
    if (desde > 0) log.info(`Reanudando: la ejecución anterior completó hasta la página ${desde}`);
    if (estadoPrevio?.extraccionCompletada) log.info('La extracción ya estaba marcada como completa; se repite desde el principio');

    const sesion = new SesionPje(this.captcha);
    await sesion.abrir();

    if (!(await sesion.buscar(opciones.criterios))) {
      log.error(`La búsqueda no devolvió resultados. Mensajes del portal: ${sesion.mensajesDelServidor() || 'ninguno'}`);
      return 0;
    }

    const total = detectarTotalResultados(sesion.documento);
    if (total !== undefined) log.info(`El portal anuncia ${total} resultados`);

    let pagina = 1;
    let vaciasSeguidas = 0;
    let completada = false;
    /**
     * Última página que se llegó a parsear ENTERA. No es `pagina`: el bucle puede
     * cortarse antes de procesar la página en curso (estructura cambiada), y
     * guardar `pagina` en ese caso haría que la ejecución siguiente reanudara
     * después de una página que nunca se leyó, perdiéndola en silencio.
     */
    let ultimaCompletada = desde;
    /**
     * Procesos vistos EN ESTA EJECUCIÓN. El corte por total anunciado no puede
     * mirar `procesos.size`: ese mapa arrastra lo que dejaron ejecuciones
     * anteriores, quizá con otro criterio de búsqueda, y con él una búsqueda
     * nueva y más estrecha se daría por terminada en la primera página.
     */
    const vistosAhora = new Set<string>();

    // Avance rápido hasta la página guardada. Una sesión nueva siempre empieza en la 1.
    while (pagina <= desde && pagina < MAX_PAGINAS) {
      if (!(await this.avanzarPagina(sesion, pagina + 1))) break;
      pagina++;
    }

    while (pagina <= MAX_PAGINAS) {
      let nuevosEnPagina = 0;
      try {
        const lote = parsearProcesos(sesion.documento, pagina);
        nuevosEnPagina = this.persistencia.anadirProcesos(procesos, lote);
        // Por `claveUnica` y no por el número: los procesos en sigilo no tienen
        // número, y contarlos como uno solo (undefined) frenaría la extracción
        // antes de tiempo al comparar contra el total anunciado.
        for (const p of lote) vistosAhora.add(p.claveUnica);
        ultimaCompletada = pagina;
        log.info(
          `Página ${pagina}: ${lote.length} filas, ${nuevosEnPagina} nuevas ` +
            `(acumulado ${procesos.size}, esta ejecución ${vistosAhora.size})`,
        );

        if (lote.length === 0) {
          vaciasSeguidas++;
          // Una página vacía puede ser un hipo del servidor. Se exige corroboración
          // antes de declarar terminada la extracción y bloquear futuras ejecuciones.
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
          log.error(`La estructura de la tabla cambió: ${e.message}`);
          this.persistencia.registrarFallo({ claveUnica: `pagina-${pagina}`, fase: 'pagina', motivo: e.message });
          break;
        }
        throw e;
      }

      // Persistir en cada página, no al final: es lo que hace barata una interrupción.
      this.persistencia.guardarProcesos(procesos);
      this.persistencia.guardarEstado(this.estado(opciones.criterios, ultimaCompletada, false, total));

      if (total !== undefined && vistosAhora.size >= total) {
        log.info(`Alcanzado el total anunciado (${total}): extracción completa`);
        completada = true;
        break;
      }

      const control = detectarPaginacion(sesion.documento);
      if (!hayPaginaSiguiente(control, pagina)) {
        // «No hay paginador» y «se acabaron los resultados» no son lo mismo, y
        // confundirlos es caro. Caso real y observado en los fixtures modernos:
        // el portal anuncia 106.073 resultados y renderiza el hueco de paginación
        // VACÍO (`<div title="Paginação"></div>`), así que `detectarPaginacion`
        // devuelve `undefined` con toda la razón en la primera página. Declarar
        // ahí «extracción completa» con 30 procesos de 106.073 escribiría un
        // `extraccionCompletada: true` que es sencillamente falso, y el número
        // solo aparecería en un log que nadie relee.
        const faltan = total !== undefined && vistosAhora.size < total;
        if (faltan) {
          log.warn(
            `El paginador no ofrece más páginas, pero solo se han recorrido ${vistosAhora.size} de los ${total} ` +
              'resultados que anuncia el portal. NO se marca la extracción como completa: puede que la lista se ' +
              'sirva sin paginador (búsqueda sin filtros) o que el control haya cambiado de forma.',
          );
        } else {
          log.info('El paginador no ofrece más páginas: extracción completa');
          completada = true;
        }
        break;
      }

      await sleep(CONFIG.delayBetweenRequestsMs);
      if (!(await this.avanzarPagina(sesion, pagina + 1))) break;
      pagina++;
    }

    this.persistencia.guardarProcesos(procesos);
    this.persistencia.guardarEstado(this.estado(opciones.criterios, ultimaCompletada, completada, total));
    const csv = this.persistencia.exportarCsv(procesos);
    log.info(`Fase 1 terminada: ${procesos.size} procesos. JSON en ${CONFIG.recordsPath}, CSV en ${csv}`);
    return procesos.size;
  }

  /**
   * Fase 2: descarga de PDF.
   *
   * Abre una sesión nueva (el portal ata los identificadores de descarga al árbol
   * de componentes de la sesión que los emitió) y recorre los procesos pendientes.
   * Un documento que falla se registra y no interrumpe el resto.
   *
   * De dónde salen los documentos: de la FICHA de cada proceso, abierta con el
   * `apertura` que la Fase 1 leyó de su fila, nunca del documento vigente de la
   * lista. Leerlos de la lista atribuía a todos los procesos los mismos enlaces,
   * que es peor que no tener ninguno: produce descargas equivocadas con aspecto
   * de correctas. Cuando el `apertura` es una URL —lo que emite la plantilla
   * moderna— la fase ni siquiera necesita la lista, y con ella se ahorra el
   * CAPTCHA y el punto en el que un fallo tumbaba toda la fase.
   */
  async fase2(opciones: OpcionesScraper): Promise<number> {
    log.info('=== FASE 2 · Descarga de PDF ===');

    const procesos = this.persistencia.cargarProcesos();
    if (procesos.size === 0) {
      log.warn('No hay procesos indexados. Ejecuta antes la Fase 1.');
      return 0;
    }

    const pendientes = [...procesos.values()].filter((p) => p.estado !== 'completado' && p.estado !== 'sin_documentos');
    log.info(`${pendientes.length} procesos pendientes de ${procesos.size}`);

    const sesion = new SesionPje(this.captcha);
    await sesion.abrir();

    /**
     * ¿Hace falta rehacer la búsqueda para poder abrir las fichas?
     *
     * Un `apertura` de tipo `url` es un permalink —`…/DetalheProcesso
     * ConsultaPublica/listView.seam?ca=<hash>`— que el portal sirve con un GET y
     * las cookies de la sesión, sin CAPTCHA y sin depender de la lista: está
     * verificado en vivo (ver `docs/protocol.md`). Un `postback`, en cambio, solo
     * se decodifica sobre el árbol de componentes de la lista que lo emitió, así
     * que ahí la búsqueda es obligatoria —y en la variante seam cuesta un CAPTCHA.
     *
     * Distinguirlos es justo lo que hace la Fase 2 robusta: en la plantilla
     * moderna ya no hay ninguna razón para reabrir la lista, y con ella
     * desaparece el punto en el que un CAPTCHA fallido tumbaba toda la fase.
     */
    const necesitaLista = pendientes.some((p) => p.apertura?.tipo === 'postback');
    /**
     * Copia de la lista para volver a ella entre proceso y proceso. `undefined`
     * cuando no se rehizo la búsqueda: restaurar la página de entrada entre
     * fichas no aportaría nada y ocultaría que no hay lista que restaurar.
     */
    let listado: string | undefined;
    if (necesitaLista) {
      if (!(await sesion.buscar(opciones.criterios))) {
        log.error('No se pudo reabrir la búsqueda para la Fase 2');
        return 0;
      }
      listado = sesion.instantanea();
    } else {
      log.info('Todas las fichas pendientes se abren por URL: no se rehace la búsqueda ni su CAPTCHA');
    }

    const descargas = new ServicioDescarga(sesion);
    let bajados = 0;
    const tope = opciones.maxDescargas ?? Infinity;

    /** Vuelve a la lista si es que había una que guardar. */
    const volverALaLista = (): void => {
      if (listado !== undefined) sesion.restaurar(listado);
    };

    for (const proceso of pendientes) {
      if (bajados >= tope) {
        log.info(`Alcanzado el límite de ${tope} descargas de esta ejecución`);
        break;
      }

      /**
       * Cómo se nombra este proceso en los logs: su número CNJ si el tribunal lo
       * publica y, si es un expediente en segredo de justiça, su `claveUnica`.
       * Nunca `undefined`, que es lo que saldría al interpolar el número a secas.
       */
      const etiqueta = proceso.numeroProcesso ?? proceso.claveUnica;

      // Los documentos de un proceso están en SU ficha, no en la lista. Leerlos
      // del documento vigente sin haber navegado atribuiría a todos los procesos
      // los mismos enlaces de la página de resultados, que es peor que no tener
      // ninguno: produce descargas equivocadas con aspecto de correctas.
      if (!proceso.apertura) {
        const motivo = 'La fila de la lista no publica de forma inequívoca cómo abrir la ficha del proceso';
        log.warn(`${etiqueta}: ${motivo}`);
        this.persistencia.registrarFallo({ claveUnica: proceso.claveUnica, fase: 'ficha', motivo });
        proceso.estado = 'fallido';
        this.persistencia.guardarProcesos(procesos);
        continue;
      }

      // La ficha se abre SIEMPRE, aunque `records.json` ya traiga sus documentos
      // de una pasada anterior. Un `DescargaPostback` se reconstruye sobre el
      // formulario vigente, y el control que descarga un documento solo existe
      // —con un ViewState que JSF acepte— mientras su ficha es el documento
      // vigente. Reutilizar la lista de documentos para ahorrarse la navegación
      // enviaría el postback contra el formulario de la lista, que no lo conoce.
      try {
        await this.abrirFicha(sesion, proceso);
      } catch (e) {
        const motivo = e instanceof Error ? e.message : String(e);
        log.error(`No se pudo abrir la ficha de ${etiqueta}: ${motivo}`);
        this.persistencia.registrarFallo({ claveUnica: proceso.claveUnica, fase: 'ficha', motivo });
        proceso.estado = 'fallido';
        this.persistencia.guardarProcesos(procesos);

        if (e instanceof SesionCaducadaError) {
          // El portal rechazó el estado de vista restaurado. Todo intento
          // posterior tendría el mismo destino, así que se corta aquí en vez de
          // recorrer los procesos que quedan marcándolos fallidos uno a uno.
          log.error('La sesión ya no es válida para el portal; se detiene la Fase 2. Relánzala para continuar.');
          break;
        }
        volverALaLista();
        continue;
      }

      // La ficha es la fuente de los documentos, y de paso de las partes y de los
      // rótulos de cabecera: la lista solo publica los polos en una línea suelta.
      // `parsearFicha` conoce la plantilla moderna (VERIFICADA contra
      // `pje-nuevo-ficha.html`); `parsearDocumentos` es el camino genérico que
      // queda para la plantilla antigua, cuya ficha sigue sin capturar.
      const ficha = parsearFicha(sesion.documento);
      let documentos: DocumentoProceso[];
      if (ficha.esFicha) {
        documentos = ficha.documentos;
        // Las de la ficha son mejores que las de la lista: traen el papel real,
        // el documento de identificación y la representación letrada.
        if (ficha.partes.length > 0) proceso.partes = ficha.partes;
        // Se funden en vez de sustituir: `camposExtra` ya trae lo que aportó la
        // fila (sigla, asunto, última movimentación) y son claves distintas de
        // los rótulos del bloque «Dados do Processo».
        if (ficha.camposExtra) proceso.camposExtra = { ...(proceso.camposExtra ?? {}), ...ficha.camposExtra };
      } else {
        log.warn(
          `${etiqueta}: la página abierta no trae ninguna de las tablas de una ficha; ` +
            'se lee con el parser genérico',
        );
        documentos = parsearDocumentos(sesion.documento);
      }

      // Se persisten al leerlos, aunque la descarga falle después: son parte de
      // «toda la información de cada documento» que pide el enunciado, y valen por
      // sí mismos en `records.json`.
      proceso.documentos = documentos;
      this.persistencia.guardarProcesos(procesos);

      const conArchivo = documentos.filter((d) => d.descarga !== undefined);
      if (conArchivo.length === 0) {
        if (ficha.esFicha) {
          // Ficha legítima que no publica nada descargable. Es terminal: marcarlo
          // `sin_documentos` lo saca de futuras pasadas, y eso solo es correcto
          // porque consta que la navegación llegó a su destino.
          proceso.estado = 'sin_documentos';
        } else {
          // Aquí NO consta. Un `sin_documentos` retiraría para siempre un proceso
          // cuya ficha quizá nunca llegó a abrirse (sesión caducada, redirección
          // a la lista), y el fallo se volvería invisible. Se registra y se deja
          // pendiente para la siguiente pasada.
          const motivo = 'La página abierta no es una ficha reconocible y no publica ningún documento';
          log.warn(`${etiqueta}: ${motivo}`);
          this.persistencia.registrarFallo({ claveUnica: proceso.claveUnica, fase: 'ficha', motivo });
          proceso.estado = 'fallido';
        }
        this.persistencia.guardarProcesos(procesos);
        volverALaLista();
        continue;
      }

      const rutas: string[] = [];
      let fallidos = 0;
      let cortadoPorTope = false;
      for (const documento of conArchivo) {
        // El tope se comprueba TAMBIÉN aquí, no solo entre procesos. Un expediente
        // del PJe pasa a menudo de cien documentos, así que con la comprobación
        // únicamente en el bucle exterior un `MAX_DESCARGAS=1` bajaba el proceso
        // entero: el tope existe para «demostrar sin bajarlo todo», y rebasarlo
        // por un factor arbitrario lo deja sin función.
        if (bajados >= tope) {
          cortadoPorTope = true;
          break;
        }
        try {
          // `descargar` devuelve la ruta sin pedir nada cuando el fichero ya está
          // validado en disco. Eso no es una descarga y no debe consumir el tope
          // de `MAX_DESCARGAS`, o una segunda pasada agotaría el cupo saltando
          // ficheros que ya tenía.
          const yaEstaba = fs.existsSync(descargas.rutaDe(proceso, documento));
          rutas.push(await descargas.descargar(proceso, documento));
          if (!yaEstaba) bajados++;
        } catch (e) {
          const motivo = e instanceof Error ? e.message : String(e);
          log.error(`Fallo al descargar "${documento.titulo}" de ${etiqueta}: ${motivo}`);
          fallidos++;
          // El documento va en el registro: sin él, «qué documentos fallaron» no
          // se puede responder desde `failed.json`, que es lo que el enunciado pide.
          this.persistencia.registrarFallo({
            claveUnica: proceso.claveUnica,
            fase: 'documento',
            documento: documentoParaFallo(documento),
            motivo,
          });
          // Un documento fallido no detiene el run: se registra y se sigue, como pide el desafío.
        }
        await sleep(CONFIG.delayBetweenDownloadsMs);
      }

      // Las rutas se deduplican: un mismo fichero puede reaparecer si la ficha
      // repite el enlace o si el proceso ya se había descargado en otra pasada.
      proceso.archivos = [...new Set([...(proceso.archivos ?? []), ...rutas])];
      // `completado` SOLO si no quedó ningún documento por bajar. Con el criterio
      // anterior —«bajó al menos uno»— un proceso con trece PDF y dos 429 salía
      // del filtro de pendientes para siempre, y sus dos fallos, aunque estuvieran
      // anotados, no los reintentaba ninguna pasada posterior. `parcial` los deja
      // dentro: `descargar` salta los ficheros ya validados, así que reintentarlo
      // cuesta solo los que faltan.
      // Un proceso cortado por el tope NO está completado aunque no fallara nada:
      // le quedan documentos sin pedir. `parcial` lo mantiene en pendientes para
      // que la pasada siguiente termine lo que falta.
      proceso.estado =
        fallidos === 0 && !cortadoPorTope ? 'completado' : rutas.length > 0 || cortadoPorTope ? 'parcial' : 'fallido';
      // Persistir tras cada proceso: una interrupción cuesta un proceso, no el run.
      this.persistencia.guardarProcesos(procesos);

      // De vuelta a la lista para poder abrir la ficha del proceso siguiente.
      volverALaLista();
    }

    log.info(`Fase 2 terminada: ${bajados} archivos descargados en ${CONFIG.pdfDir}`);
    return bajados;
  }

  // ---------------------------------------------------------------- internos

  /**
   * Abre la ficha de un proceso y la deja como documento vigente de la sesión.
   *
   * Los dos caminos que publica el portal son una URL de verdad o un postback JSF
   * (el enlace es JavaScript y hay que reproducir el POST). Se decide por lo que
   * la fila publicó, no por una suposición:
   *
   *  - `url`: es lo que emite la plantilla MODERNA, y está VERIFICADO (ver
   *    `docs/protocol.md`): `openPopUp('…','/<ctx>/ConsultaPublica/
   *    DetalheProcessoConsultaPublica/listView.seam?ca=<hash>')`, un GET normal
   *    con las cookies de la sesión y sin CAPTCHA.
   *  - `postback`: el camino de la plantilla ANTIGUA, todavía sin capturar,
   *    porque su CAPTCHA de imagen bloquea la lista de resultados.
   */
  private async abrirFicha(sesion: SesionPje, proceso: ProcesoJudicial): Promise<void> {
    const apertura = proceso.apertura;
    if (!apertura) throw new Error('El proceso no trae ningún control de apertura');

    if (apertura.tipo === 'url') {
      await sesion.navegar(apertura.url);
      return;
    }
    await sesion.accionA4J({
      formId: apertura.formId,
      control: apertura.control,
      ...(apertura.parametros ? { parametros: apertura.parametros } : {}),
    });
  }

  /** Pide la página `destino` al paginador. Devuelve false si no se pudo avanzar. */
  private async avanzarPagina(sesion: SesionPje, destino: number): Promise<boolean> {
    const control = detectarPaginacion(sesion.documento);
    if (!control) {
      log.warn('No se encontró control de paginación en el documento vigente');
      return false;
    }
    try {
      await sesion.accionA4J(construirOpcionesPagina(control, destino), `pagina-${destino}.xml`);
      return true;
    } catch (e) {
      // Un transitorio agotado —429 que sigue llegando tras los cuatro intentos de
      // `withRetry`, o un corte de red— se trata como FIN ORDENADO del recorrido,
      // no como error mortal. Propagarlo mataba el proceso con «Error no
      // recuperable» y sin escribir el CSV, dejando una extracción de horas a
      // medias y un mensaje falso: `state.json` ya guardaba la última página
      // completada, así que relanzar reanudaba sin perder nada.
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
    criterios: CriteriosBusqueda,
    pagina: number,
    completada: boolean,
    total: number | undefined,
  ): EstadoEjecucion {
    return {
      criterio: { ...criterios },
      ultimaPaginaCompletada: pagina,
      extraccionCompletada: completada,
      totalAnunciado: total,
      actualizadoEn: new Date().toISOString(),
    };
  }
}

/** Reexportado por comodidad para el punto de entrada. */
export type { ProcesoJudicial };
