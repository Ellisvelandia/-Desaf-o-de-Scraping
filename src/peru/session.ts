/**
 * Sesión contra la Jurisprudencia Nacional Sistematizada (Poder Judicial del Perú).
 *
 * Es un JSF 2 con RichFaces 4 y, a diferencia del PJe del TRF5, **no exige
 * CAPTCHA**: la búsqueda, la paginación y la descarga del PDF se hacen con
 * peticiones HTTP normales. Eso es lo que permite que este objetivo sí se pueda
 * recorrer de principio a fin sin una persona delante.
 *
 * Tres peticiones componen todo el protocolo, verificadas en vivo sobre el sitio:
 *
 *  1. GET  /jurisprudenciaweb/faces/page/inicio.xhtml     → cookies + ViewState
 *  2. POST /jurisprudenciaweb/faces/page/inicio.xhtml     → página de resultados
 *  3. POST /jurisprudenciaweb/faces/page/resultado.xhtml  → salto de página
 *     (petición parcial de JSF 2 con `formBuscador:data1:page=N`)
 *
 * EL DETALLE QUE DECIDE SI ESTO SOBREVIVE A UN REDESPLIEGUE: el control que
 * dispara la búsqueda se llama `formBuscador:j_idt31`, y ese sufijo `j_idtNN` lo
 * genera JSF contando componentes en el árbol de la vista. Cambia en cuanto el
 * Poder Judicial toque la plantilla, y cambia entre despliegues del mismo código.
 * Por eso NO está codificado a mano en ningún sitio: se descubre leyendo el
 * `onclick` del botón de búsqueda, que es donde Mojarra deja los parámetros
 * exactos que hay que enviar. Es la misma lección que el README ya recoge para el
 * TRF5, donde los sufijos de la misma vista difieren entre tribunales.
 */
import * as cheerio from 'cheerio';
import { CONFIG } from '../config';
import { ClienteHttp } from '../http/client';
import { CamposFormulario, extraerFormulario, fijarCampo } from '../jsf/form';
import { aplicarRespuestaParcial, construirCuerpoParcial, esRespuestaParcial } from '../jsf/partial';
import { log } from '../utils/logger';
import { SesionCaducadaError, withRetry } from '../utils/retry';

/** Id del formulario de búsqueda, estable en toda la aplicación. */
export const FORM_ID = 'formBuscador';

/** Id del `rich:dataScroller` que pagina los resultados. */
export const SCROLLER_ID = 'formBuscador:data1';

/** Evento que RichFaces 4 declara al saltar de página. */
const EVENTO_SCROLLER = 'rich:datascroller:onscroll';

/** Campo de texto libre del buscador general. */
const CAMPO_TEXTO = 'formBuscador:txtBusqueda';

/** Campo del nº de expediente del buscador especializado. */
const CAMPO_EXPEDIENTE = 'formBuscador:buNroExpediente';

/** Campo del año de la resolución. */
const CAMPO_ANIO = 'formBuscador:buAnio';

/** Criterios de búsqueda que acepta el portal. Todos opcionales: sin ninguno, lista todo. */
export interface CriteriosPeru {
  /** Texto libre ("amparo", "casación laboral"…). */
  texto?: string;
  /** Nº de expediente exacto (`037233-2025`). */
  expediente?: string;
  /** Año de la resolución. */
  anio?: string;
}

export class SesionPeru {
  readonly http = new ClienteHttp();

  private $!: cheerio.CheerioAPI;
  private abierta = false;

  /** Documento vigente. Se parchea con cada respuesta, como haría el navegador. */
  get documento(): cheerio.CheerioAPI {
    if (!this.abierta) throw new Error('La sesión no está abierta: llama antes a abrir()');
    return this.$;
  }

  /** Pide la página de entrada y adopta su documento. */
  async abrir(): Promise<void> {
    const r = await withRetry(() => this.http.getTexto(CONFIG.landingPath), { etiqueta: 'apertura' });
    this.$ = cheerio.load(r.texto);
    this.abierta = true;
    const form = extraerFormulario(this.$, FORM_ID);
    log.info(`Sesión abierta: formulario=${FORM_ID} captcha=no campos=${form.campos.length}`);
  }

  /**
   * Lanza la búsqueda y deja la página de resultados como documento vigente.
   *
   * Devuelve false cuando el portal responde sin ningún panel de resultado, que
   * es como dice "no hay nada" para estos criterios.
   */
  async buscar(criterios: CriteriosPeru = {}): Promise<boolean> {
    const form = extraerFormulario(this.documento, FORM_ID);
    const control = this.controlBusqueda();

    let campos = form.campos;
    if (criterios.texto !== undefined) campos = fijarCampo(campos, CAMPO_TEXTO, criterios.texto);
    if (criterios.expediente !== undefined) campos = fijarCampo(campos, CAMPO_EXPEDIENTE, criterios.expediente);
    if (criterios.anio !== undefined) campos = fijarCampo(campos, CAMPO_ANIO, criterios.anio);

    const cuerpo = new URLSearchParams();
    for (const [n, v] of campos) {
      if (n === 'javax.faces.ViewState') continue;
      cuerpo.append(n, v);
    }
    if (!campos.some(([n]) => n === FORM_ID)) cuerpo.append(FORM_ID, FORM_ID);
    // Los parámetros del `onclick`, que incluyen el control con su sufijo real y
    // el `forward=buscar` que enruta la navegación de JSF hacia los resultados.
    for (const [k, v] of Object.entries(control)) cuerpo.append(k, v);
    cuerpo.append('javax.faces.ViewState', form.viewState);

    const r = await withRetry(() => this.http.postFormulario(form.action || CONFIG.landingPath, cuerpo), {
      etiqueta: 'busqueda',
    });
    this.adoptar(r.texto);

    const hay = this.hayResultados();
    log.info(hay ? 'Búsqueda aceptada: la página trae resultados' : 'La búsqueda no devolvió ningún resultado');
    return hay;
  }

  /**
   * Salta a la página `destino` del paginador.
   *
   * Devuelve false cuando el portal no aplica el cambio: eso es el final del
   * recorrido o una vista caducada, y en ninguno de los dos casos debe el
   * orquestador seguir parseando el mismo documento creyendo que avanzó.
   */
  async irAPagina(destino: number): Promise<boolean> {
    const form = extraerFormulario(this.documento, FORM_ID);

    const cuerpo = construirCuerpoParcial(form.campos, form.viewState, {
      formId: FORM_ID,
      source: SCROLLER_ID,
      evento: EVENTO_SCROLLER,
      // Valores capturados del propio portal: no son los de por defecto de JSF.
      execute: `${SCROLLER_ID} @component`,
      render: '@component',
      parametros: {
        [`${SCROLLER_ID}:page`]: String(destino),
        'org.richfaces.ajax.component': SCROLLER_ID,
        [SCROLLER_ID]: SCROLLER_ID,
        'AJAX:EVENTS_COUNT': '1',
      },
    });

    const r = await withRetry(() => this.http.postFormulario(form.action || CONFIG.resultadoPath, cuerpo), {
      etiqueta: `pagina ${destino}`,
    });

    // Un 200 con HTML completo en lugar de `<partial-response>` es la forma en que
    // este portal expulsa una sesión: si se aplicara igualmente, no actualizaría
    // nada y el scraper repaginaría sobre la misma página hasta agotar el tope,
    // informando de miles de páginas «recorridas» que son la primera N veces.
    if (!esRespuestaParcial(r.texto)) {
      log.warn(`La respuesta al salto a la página ${destino} no es una respuesta parcial de JSF`);
      return false;
    }

    const resultado = aplicarRespuestaParcial(this.$, r.texto);
    if (resultado.redireccion) throw new SesionCaducadaError(`El portal redirigió a ${resultado.redireccion}`);
    if (resultado.error) throw new Error(`El servidor JSF devolvió un error: ${resultado.error}`);

    if (resultado.idsActualizados.length === 0) {
      log.warn(`El salto a la página ${destino} no actualizó ningún elemento del documento`);
      return false;
    }
    return true;
  }

  /** Navega a una URL cualquiera del portal y la adopta como documento vigente. */
  async navegar(url: string): Promise<void> {
    const r = await withRetry(() => this.http.getTexto(url), { etiqueta: `navegacion ${url}` });
    this.adoptar(r.texto);
  }

  /**
   * Formulario vigente, para `ServicioDescarga`.
   *
   * Este portal sirve los PDF por GET, así que en la práctica no se usa; existe
   * para satisfacer el contrato del servicio de descarga sin duplicarlo.
   */
  formularioActual(formId: string = FORM_ID) {
    return extraerFormulario(this.documento, formId);
  }

  /** ¿La página vigente trae paneles de resultado? */
  hayResultados(): boolean {
    return this.documento('div.rf-p').filter((_, el) => this.$(el).find('div.rf-p-b').length > 0).length > 0;
  }

  // ---------------------------------------------------------------- internos

  private adoptar(html: string): void {
    this.$ = cheerio.load(html);
    this.abierta = true;
  }

  /**
   * Parámetros exactos que envía el botón de búsqueda, leídos de su `onclick`.
   *
   * Mojarra escribe `mojarra.jsfcljs(form, {'k':'v', …}, '')`, y ese objeto trae
   * el nombre real del control (`formBuscador:j_idtNN`) junto con los parámetros
   * de enrutado. Se lee en vez de codificarse porque el sufijo `j_idtNN` depende
   * del árbol de componentes y cambia con cualquier retoque de la plantilla.
   */
  private controlBusqueda(): Record<string, string> {
    const $ = this.documento;
    let parametros: Record<string, string> | undefined;

    $(`form[id="${FORM_ID}"] [onclick]`).each((_, el) => {
      if (parametros) return;
      const onclick = $(el).attr('onclick') ?? '';
      if (!/jsfcljs/i.test(onclick)) return;
      const candidato = extraerParametrosJsfcljs(onclick);
      // El botón de búsqueda es el que enruta a los resultados. Sin este filtro se
      // cogería el primer control con `jsfcljs` de la página —«Limpiar», por
      // ejemplo—, que responde 200 con el formulario vacío: una ejecución que
      // parece funcionar y extrae cero.
      if (candidato && Object.values(candidato).some((v) => /buscar/i.test(v))) parametros = candidato;
    });

    if (!parametros) {
      throw new Error(
        `No se encontró el control de búsqueda en el formulario "${FORM_ID}". El portal cambió su plantilla: ` +
          'hay que volver a leer el `onclick` del botón de búsqueda antes de seguir.',
      );
    }
    return parametros;
  }
}

/**
 * Extrae el objeto de parámetros de una llamada `mojarra.jsfcljs(form, {…}, '')`.
 *
 * Se recorre el literal con una expresión de pares en vez de con `JSON.parse`:
 * Mojarra emite comillas simples, que no son JSON válido, y sustituirlas a ciegas
 * rompería cualquier valor que contuviera un apóstrofo.
 */
export function extraerParametrosJsfcljs(onclick: string): Record<string, string> | undefined {
  const bloque = /jsfcljs\s*\([^,]*,\s*\{([^}]*)\}/i.exec(onclick);
  if (!bloque) return undefined;

  const parametros: Record<string, string> = {};
  const par = /'([^']*)'\s*:\s*'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = par.exec(bloque[1])) !== null) parametros[m[1]] = m[2];

  return Object.keys(parametros).length > 0 ? parametros : undefined;
}

/** Reexportado para que el orquestador no tenga que importar de dos sitios. */
export type { CamposFormulario };
