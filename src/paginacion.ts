/**
 * Paginación de la lista de resultados (RichFaces 3.3).
 *
 * RichFaces no navega por URL: el paginador es un `rich:datascroller` cuyas
 * celdas llevan un `onclick` con `A4J.AJAX.Submit(...)`, y el número de página
 * viaja como un único parámetro `<idDelScroller>=<n>` dentro de `parameters`.
 * Este módulo lee ese contrato del HTML vigente —id del scroller, id del
 * formulario y parámetros acompañantes— en vez de codificarlo a mano, porque
 * los ids que genera JSF (`j_idNNN`) cambian con cada versión de la vista y,
 * peor aún, de una instancia del PJe a otra: TRF5, TRF1 y TRF6 numeran distinto
 * exactamente la misma pantalla.
 *
 * DOS PLANTILLAS, UN SOLO CONTRATO
 * --------------------------------
 * La Consulta Pública se publica con dos plantillas. En la antigua («seam») el
 * scroller se dibuja con las clases `rich-datascr-*` de serie. En la moderna
 * («fPP») la tabla `…:processosTable` mete su paginador en el `<tfoot>`, dentro
 * de un `<div class="pull-left" title="Paginação">` que la maquetación propia
 * del portal reestiliza, así que las clases de RichFaces pueden no aparecer.
 * Por eso hay dos caminos de detección: por clase y por contenedor. Los dos
 * acaban leyendo el MISMO `onclick`, que es el único sitio donde el contrato
 * está escrito de verdad.
 *
 * VENTANA DESLIZANTE
 * ------------------
 * RichFaces no dibuja todas las páginas: muestra una ventana de como mucho
 * `maxPages` números alrededor de la actual. De ahí que `ultimaPagina` sea un
 * MÍNIMO y nunca el total, y que el control haya que volver a detectarlo en
 * cada página. Ver la nota de `ultimaPagina` y la de `hayPaginaSiguiente`.
 *
 * El módulo no hace peticiones: describe el control y construye las opciones
 * A4J. Quien pagina es `SesionPje.accionA4J`.
 */
import * as cheerio from 'cheerio';
import { OpcionesA4J } from './jsf/a4j';

/**
 * Alias de los tipos de cheerio derivados de su propia API: el paquete no
 * reexporta `Element`/`AnyNode` (viven en `domhandler`, que no es dependencia
 * directa del proyecto), así que se obtienen de las firmas en vez de añadir una
 * dependencia solo para anotar dos parámetros.
 */
type Seleccion = ReturnType<cheerio.CheerioAPI>;
type Nodo = Seleccion extends cheerio.Cheerio<infer T> ? T : never;

export interface ControlPaginacion {
  /** `datascroller`: celdas numeradas. `enlace`: un único control «Próxima». */
  tipo: 'datascroller' | 'enlace';
  /**
   * Id del componente que decodifica el clic. Para el datascroller es además el
   * nombre del parámetro que transporta el número de página; para el enlace, su
   * id JSF.
   */
  id: string;
  /** Formulario que hay que reenviar entero (el argumento de formulario de A4J.AJAX.Submit). */
  formId: string;
  /** Nombre que viaja como control «pulsado» en el cuerpo A4J. */
  control: string;
  /** Parámetros fijos que RichFaces envía junto al control (p. ej. `ajaxSingle`). */
  parametros?: Record<string, string>;
  /** Página resaltada en el scroller (celda `rich-datascr-act`). */
  paginaActual?: number;
  /**
   * Mayor número visible en el scroller. Es un MÍNIMO, no el total: RichFaces
   * dibuja una ventana deslizante (`maxPages`), así que estando en la página 3
   * de 40 el scroller puede mostrar solo «1 2 3 4 5» y este campo valdría 5.
   * Por eso el final del recorrido NO puede decidirse solo con este número: hay
   * que volver a detectar el control en cada página (la ventana avanza con ella)
   * y confirmar el final con páginas vacías consecutivas.
   */
  ultimaPagina?: number;
}

/** Valores simbólicos que un `rich:datascroller` acepta además del número de página. */
const PAGINAS_SIMBOLICAS = new Set(['first', 'last', 'next', 'previous', 'fastforward', 'fastrewind']);

/** Etiquetas de un control «página siguiente» cuando no hay datascroller numerado. */
const PALABRA_SIGUIENTE = /(?:pr[oóõ]xim[ao]s?|seguinte|siguiente|next|avan[çc]ar)/i;
const FLECHAS_SIGUIENTE = new Set(['>', '>>', '»', '›', '››', '→', '≫']);

/**
 * Un control de paginación se etiqueta con una palabra o una flecha, nunca con
 * una frase: el tope de longitud evita confundir «Próxima» con un párrafo que
 * contenga «próximo passo».
 */
const MAX_LONGITUD_ETIQUETA = 24;

/**
 * Contenedores donde la plantilla moderna aloja el paginador.
 *
 * El `title` es el rótulo accesible que pone la propia plantilla del PJe, y se
 * acepta con y sin tilde porque no todas las instancias lo escriben igual. El
 * `<tfoot>` de `…:processosTable` va detrás como red de seguridad para las
 * instancias que no rotulen el hueco: ahí dentro solo viven el paginador y el
 * contador de resultados, así que no hay nada que confundir con una página.
 */
const CONTENEDORES_MODERNOS = [
  '[title="Paginação"]',
  '[title="Paginacao"]',
  '[title="Paginación"]',
  '[id$=":processosTable"] tfoot',
].join(', ');

/**
 * Elementos de un scroller clásico: los que llevan las clases de RichFaces 3.3.
 * `rich-datascr*` cubre las celdas (act/inact/button) y `rich-dtascroller*` la
 * tabla contenedora; RichFaces usa ambas raíces, con la errata incluida.
 */
const FUENTES_CLASICAS = [
  '[class*="rich-datascr"][onclick]',
  '[class*="rich-dtascroller"][onclick]',
  '[class*="rich-datascr"] [onclick]',
  '[class*="rich-dtascroller"] [onclick]',
].join(', ');

/** Datos que se pueden reconstruir de una llamada `A4J.AJAX.Submit` incrustada en un `onclick`. */
interface LlamadaA4J {
  /** Último argumento entrecomillado antes de las opciones: el id del formulario. */
  formId?: string;
  /** Pares de `parameters`, en orden de aparición. */
  pares: Array<[string, string]>;
}

/**
 * Localiza el control de paginación en el documento vigente.
 *
 * Devuelve `undefined` cuando la página no tiene paginador —búsqueda sin
 * resultados, página única, hueco de paginación vacío o formulario de entrada—
 * para que el llamante lo trate como «no hay más páginas» en lugar de tener que
 * capturar un error. El hueco vacío es un caso REAL, no teórico: en la tabla
 * moderna sin filtros el portal renderiza el `<div title="Paginação">` sin nada
 * dentro, y esta función devuelve `undefined` sobre él sin lanzar.
 */
export function detectarPaginacion($: cheerio.CheerioAPI): ControlPaginacion | undefined {
  return detectarDatascroller($) ?? detectarPaginadorModerno($) ?? detectarEnlaceSiguiente($);
}

/**
 * Traduce el control a un POST A4J listo para `SesionPje.accionA4J`.
 *
 * Reproduce la llamada que hace el navegador, verificada sobre el HTML del
 * portal:
 *
 *     A4J.AJAX.Submit('<formDelScroller>', event, {
 *       'parameters': { '<clientIdDelScroller>': <página>, 'ajaxSingle': '<clientIdDelScroller>' }
 *     })
 *
 * Es decir: el NOMBRE del parámetro que transporta la página es el propio
 * client-id del scroller, y el formulario es el que ENVUELVE al scroller, que
 * no tiene por qué ser el de búsqueda (`ControlPaginacion.formId` lo trae ya
 * resuelto por la detección).
 *
 * Con `tipo: 'enlace'` el número se ignora: ese control solo sabe avanzar una
 * página, y quien lo use debe recorrerlas en orden.
 */
export function construirOpcionesPagina(control: ControlPaginacion, pagina: number): OpcionesA4J {
  if (!Number.isInteger(pagina) || pagina < 1) {
    throw new Error(`Número de página inválido: ${pagina}`);
  }

  const parametros: Record<string, string> = { ...(control.parametros ?? {}) };
  let marcador = control.control;

  if (control.tipo === 'datascroller') {
    parametros[control.id] = String(pagina);
    // `ajaxSingle` hace que JSF decodifique SOLO el scroller en este postback, que
    // es justo lo que necesita un cambio de página: los criterios ya están en el
    // modelo del servidor desde la búsqueda. Si el `onclick` del portal ya trajo el
    // suyo se respeta ese valor; si no vino ninguno se pone el del propio scroller,
    // que es lo que emite RichFaces 3.3 y lo verificado contra el portal.
    if (parametros['ajaxSingle'] === undefined) parametros['ajaxSingle'] = control.id;
    // `construirCuerpoA4J` añade `<control>=<control>` ANTES de los parámetros. Si el
    // control fuese el propio id del scroller, el cuerpo llevaría dos veces ese nombre
    // (`…=<id>` y `…=<n>`) y el contenedor de servlets entrega a JSF el PRIMER valor:
    // el datascroller recibiría un texto donde espera un número y la lista se quedaría
    // clavada en la misma página. Con el id del formulario el par duplicado es idéntico
    // al que el propio formulario ya envía, así que no puede alterar ninguna decodificación.
    if (marcador === control.id) marcador = control.formId;
  }

  return { formId: control.formId, control: marcador, parametros };
}

/**
 * ¿Merece la pena pedir la página siguiente?
 *
 * Solo devuelve `false` con evidencia: no hay control, o el scroller sitúa la
 * página actual en su último número. Como esa última página es la de la ventana
 * deslizante y no el total, el control debe re-detectarse en CADA página (la
 * ventana avanza con ella) y el llamante debe corroborar el final con páginas
 * vacías consecutivas. Ante la duda se responde `true`: pedir una página de más
 * cuesta una petición; pararse de más pierde datos en silencio.
 */
export function hayPaginaSiguiente(control: ControlPaginacion | undefined, paginaActual: number): boolean {
  if (!control) return false;
  if (control.ultimaPagina !== undefined && paginaActual >= control.ultimaPagina) return false;
  return true;
}

// --------------------------------------------------------------- detección

/** Camino clásico: el scroller se reconoce por las clases `rich-datascr*`. */
function detectarDatascroller($: cheerio.CheerioAPI): ControlPaginacion | undefined {
  const candidatos = $('[class*="rich-datascr"], [class*="rich-dtascroller"]').toArray();

  const vistos = new Set<string>();
  for (const el of candidatos) {
    const $raiz = elegirRaiz($, el);
    if ($raiz.length === 0) continue;

    // Cabecera y pie de una misma tabla son dos scrollers distintos; basta el primero
    // utilizable, pero se evita reprocesar el mismo nodo por cada celda suya.
    const clave = $raiz.attr('id') ?? $.html($raiz).slice(0, 120);
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    const control = leerScroller($, $raiz, FUENTES_CLASICAS);
    if (control) return control;
  }
  return undefined;
}

/**
 * Camino moderno: el scroller se reconoce por DÓNDE está, no por cómo se pinta.
 *
 * En la plantilla fPP el hueco de paginación es un contenedor rotulado dentro
 * del pie de `…:processosTable`. Como la maquetación del portal puede haber
 * sustituido las clases de RichFaces, aquí se aceptan TODOS los `onclick` del
 * contenedor; es seguro porque el contenedor no alberga nada más que el
 * paginador, mientras que en la tabla de resultados cada fila lleva su propio
 * `onclick` (con un `openPopUp`, no un `A4J.AJAX.Submit`) y confundir el índice
 * de una fila con un número de página dejaría la extracción girando en la misma
 * página sin que nada fallara a la vista.
 */
function detectarPaginadorModerno($: cheerio.CheerioAPI): ControlPaginacion | undefined {
  for (const el of $(CONTENEDORES_MODERNOS).toArray()) {
    const control = leerScroller($, $(el), '[onclick]');
    if (control) return control;
  }
  return undefined;
}

/** Sube desde una celda del scroller hasta el elemento que lo dibuja entero. */
function elegirRaiz($: cheerio.CheerioAPI, el: Nodo): Seleccion {
  const $el = $(el);
  // La tabla del scroller lleva su propia clase (`rich-dtascroller-table`); se prefiere
  // a un `closest('table')` a secas porque el scroller vive dentro del pie de la tabla
  // de resultados y subir de más metería las filas de resultados en la raíz.
  const $contenedor = $el.closest('[class*="rich-dtascroller"], table[class*="rich-datascr"]');
  if ($contenedor.length > 0) return $contenedor;
  const $tabla = $el.closest('table');
  return $tabla.length > 0 ? $tabla : $el;
}

/**
 * Lee el contrato de paginación de una raíz concreta.
 *
 * `selectorFuentes` acota qué descendientes pueden aportar el `onclick`: por
 * clase en la plantilla clásica, cualquiera en el contenedor de la moderna.
 * Devuelve `undefined` si la raíz no describe una paginación utilizable, que es
 * lo que ocurre con el hueco vacío de la tabla moderna sin filtrar.
 */
function leerScroller($: cheerio.CheerioAPI, $raiz: Seleccion, selectorFuentes: string): ControlPaginacion | undefined {
  const formDelDom = $raiz.closest('form').attr('id');

  let id: string | undefined;
  let pares: Array<[string, string]> = [];
  let formIdLlamada: string | undefined;

  const fuentes = $raiz.find(selectorFuentes).toArray();

  // Las celdas numeradas dan el par más informativo (`<scroller>=<n>`); los botones
  // «primera/anterior/siguiente» usan valores simbólicos y sirven de reserva.
  for (const el of fuentes) {
    const onclick = $(el).attr('onclick') ?? '';
    const llamada = analizarLlamadaA4J(onclick);
    if (!llamada) continue;
    const par = llamada.pares.find(([, v]) => esNumeroPagina(v));
    const alternativo = llamada.pares.find(([, v]) => PAGINAS_SIMBOLICAS.has(v.toLowerCase()));
    const elegido = par ?? alternativo;
    if (!elegido) continue;
    id = elegido[0];
    pares = llamada.pares;
    formIdLlamada = llamada.formId;
    if (par) break; // par numérico: no hace falta seguir mirando
  }

  // Sin ningún `onclick` utilizable hay dos situaciones muy distintas. Si la raíz
  // se reconoció POR SUS CLASES de RichFaces, es un paginador real de una sola
  // página (o con los botones deshabilitados) y su id se puede asumir por la
  // convención de rotular el contenedor con el clientId del componente. Si la raíz
  // se reconoció por su POSICIÓN —el hueco de la plantilla moderna— asumir eso
  // sería inventarse un componente: ese `<div>` no es el scroller, es donde iría.
  // Ahí se devuelve `undefined`, que es el caso del fixture sin filtros.
  if (!id && selectorFuentes === FUENTES_CLASICAS) id = $raiz.attr('id');

  const form = formIdLlamada ?? formDelDom;
  if (!id || !form) return undefined;

  const { control, parametros } = repartirParametros(pares, id, form);
  const paginas = leerNumerosDePagina($, $raiz, fuentes);

  return {
    tipo: 'datascroller',
    id,
    formId: form,
    control,
    ...(Object.keys(parametros).length > 0 ? { parametros } : {}),
    ...(paginas.actual !== undefined ? { paginaActual: paginas.actual } : {}),
    ...(paginas.ultima !== undefined ? { ultimaPagina: paginas.ultima } : {}),
  };
}

/**
 * Números visibles del scroller: la celda activa y el mayor de la ventana dibujada.
 *
 * En la plantilla clásica salen de las celdas `rich-datascr-act`/`-inact`. Si no
 * hay ninguna —plantilla moderna, que reestiliza el paginador— se recurre a los
 * números que cada `onclick` lleva en sus `parameters`, que es el mismo dato
 * visto desde el otro lado. Ese respaldo puede incluir el salto del botón
 * «avanzar rápido», mayor que el último número dibujado; se acepta a propósito,
 * porque `ultimaPagina` ya es un mínimo y errar por exceso solo cuesta una
 * petición mientras que errar por defecto pierde procesos en silencio.
 */
function leerNumerosDePagina(
  $: cheerio.CheerioAPI,
  $raiz: Seleccion,
  fuentes: Nodo[],
): { actual?: number; ultima?: number } {
  const actual =
    aNumero($raiz.find('.rich-datascr-act').first().text()) ?? aNumero($raiz.find('.active').first().text());

  let ultima: number | undefined;
  const celdas = $raiz.find('.rich-datascr-act, .rich-datascr-inact').toArray();
  for (const el of celdas) {
    const n = aNumero($(el).text());
    if (n !== undefined && (ultima === undefined || n > ultima)) ultima = n;
  }

  if (celdas.length === 0) {
    for (const el of fuentes) {
      const llamada = analizarLlamadaA4J($(el).attr('onclick') ?? '');
      if (!llamada) continue;
      for (const [, v] of llamada.pares) {
        const n = esNumeroPagina(v) ? Number(v.trim()) : undefined;
        if (n !== undefined && (ultima === undefined || n > ultima)) ultima = n;
      }
    }
  }

  if (actual !== undefined && (ultima === undefined || actual > ultima)) ultima = actual;

  return {
    ...(actual !== undefined ? { actual } : {}),
    ...(ultima !== undefined ? { ultima } : {}),
  };
}

function detectarEnlaceSiguiente($: cheerio.CheerioAPI): ControlPaginacion | undefined {
  for (const el of $('[onclick]').toArray()) {
    const $el = $(el);
    const onclick = $el.attr('onclick') ?? '';
    const llamada = analizarLlamadaA4J(onclick);
    if (!llamada) continue;
    if (!esEtiquetaSiguiente(etiquetaDe($el))) continue;

    const formId = llamada.formId ?? $el.closest('form').attr('id');
    if (!formId) continue;

    // El id del enlace es su propio marcador: RichFaces envía `<id>=<id>` para
    // que JSF sepa qué `commandLink` se pulsó.
    const marcador = llamada.pares.find(([k, v]) => k === v)?.[0];
    const id = marcador ?? $el.attr('id');
    if (!id) continue;

    const { control, parametros } = repartirParametros(llamada.pares, id, formId);
    return {
      tipo: 'enlace',
      id,
      formId,
      control: marcador ?? control,
      ...(Object.keys(parametros).length > 0 ? { parametros } : {}),
    };
  }
  return undefined;
}

/** Texto y atributos que pueden rotular un control sin contenido visible. */
function etiquetaDe($el: Seleccion): string {
  return [$el.text(), $el.attr('title'), $el.attr('alt'), $el.attr('value')]
    .filter((s): s is string => typeof s === 'string')
    .join(' ');
}

function esEtiquetaSiguiente(etiqueta: string): boolean {
  const limpia = etiqueta.replace(/[\s ]+/g, ' ').trim();
  if (limpia.length === 0 || limpia.length > MAX_LONGITUD_ETIQUETA) return false;
  if (PALABRA_SIGUIENTE.test(limpia)) return true;
  return limpia.split(' ').some((token) => FLECHAS_SIGUIENTE.has(token));
}

// ------------------------------------------------------- lectura del onclick

/**
 * Extrae de un `onclick` el formulario y los `parameters` de `A4J.AJAX.Submit`.
 *
 * Se recorre a mano en vez de con una sola expresión regular porque las opciones
 * llevan funciones (`oncomplete:function(...){}`) y cualquier patrón que intente
 * casar hasta el paréntesis de cierre se pasa de largo.
 */
function analizarLlamadaA4J(onclick: string): LlamadaA4J | undefined {
  const marca = 'A4J.AJAX.Submit(';
  const inicio = onclick.indexOf(marca);
  if (inicio < 0) return undefined;

  // Argumentos iniciales entrecomillados: `(form, …)` o `(region, form, …)`. El
  // formulario es siempre el último de esa tanda; en este portal solo se observa
  // la forma de tres argumentos, con el formulario primero.
  let resto = onclick.slice(inicio + marca.length);
  const argumentos: string[] = [];
  for (;;) {
    const m = /^\s*(['"])(.*?)\1\s*,/.exec(resto);
    if (!m) break;
    argumentos.push(m[2]);
    resto = resto.slice(m[0].length);
  }

  // El bloque `parameters` se busca DESPUÉS del `A4J.AJAX.Submit(` que se está
  // leyendo, no desde el principio del atributo: un `onclick` real de este portal
  // encadena llamadas (`return executarReCaptcha();;A4J.AJAX.Submit(…)`) y
  // arrancar en el índice 0 podría leer los parámetros de otra distinta.
  const cuerpo = cuerpoDeParametros(onclick, inicio);
  const pares: Array<[string, string]> = [];
  if (cuerpo !== undefined) {
    const re = /(['"])(.*?)\1\s*:\s*(['"])(.*?)\3/g;
    for (let m = re.exec(cuerpo); m !== null; m = re.exec(cuerpo)) {
      pares.push([m[2], m[4]]);
    }
  }

  const formId = argumentos.length > 0 ? argumentos[argumentos.length - 1] : undefined;
  return {
    ...(formId !== undefined ? { formId } : {}),
    pares,
  };
}

/**
 * Cuerpo del objeto `'parameters': { … }` de una llamada A4J, contando llaves.
 *
 * Lo que había aquí era `/'parameters'\s*:\s*\{([^{}]*)\}/`, y ese `[^{}]*` es
 * una apuesta a que dentro del objeto no haya ni una llave. Los `onclick` de
 * este portal las traen: el botón de búsqueda de la plantilla moderna emite
 * `'oncomplete':function(request,event,data){hideLoading(); grecaptcha.reset();}`
 * dentro de las MISMAS opciones (verificado en `pje-nuevo-resultados.html`). Hoy
 * ese bloque va delante de `parameters` y el patrón se salva por los pelos; el
 * día que RichFaces reordene las opciones —o que un valor lleve una llave— la
 * expresión deja de casar, `pares` se queda vacío y la paginación pierde el
 * número de página sin que nada lance. Contar profundidad respetando las
 * comillas no tiene ese punto ciego. Es el mismo criterio, y por el mismo
 * motivo, que `recortarBloque` en `parser.ts`.
 *
 * Devuelve `undefined` si a partir de `desde` no hay un bloque `parameters`
 * cerrado: medio objeto es peor dato que ninguno.
 */
function cuerpoDeParametros(script: string, desde: number): string | undefined {
  const marca = /['"]parameters['"]\s*:\s*\{/g;
  marca.lastIndex = desde;
  const encontrado = marca.exec(script);
  if (!encontrado) return undefined;

  // La coincidencia termina en la llave de apertura: ahí empieza el conteo.
  const inicio = encontrado.index + encontrado[0].length - 1;
  let profundidad = 0;
  let comilla = '';
  for (let i = inicio; i < script.length; i++) {
    const c = script[i];
    if (comilla) {
      if (c === '\\') i++; // carácter escapado: no puede cerrar la comilla
      else if (c === comilla) comilla = '';
      continue;
    }
    if (c === "'" || c === '"') comilla = c;
    else if (c === '{') profundidad++;
    else if (c === '}' && --profundidad === 0) return script.slice(inicio + 1, i);
  }
  return undefined;
}

/**
 * Separa el marcador del control de los parámetros que lo acompañan.
 *
 * El par cuyo nombre y valor coinciden es el «botón pulsado» que espera JSF; el
 * resto (`ajaxSingle`, banderas del componente) se reenvía tal cual. Si no hay
 * marcador, se usa el id del formulario: el cuerpo ya lo incluye con ese mismo
 * valor, así que repetirlo es inocuo y evita inventar un nombre de componente.
 */
function repartirParametros(
  pares: Array<[string, string]>,
  idPagina: string,
  formId: string,
): { control: string; parametros: Record<string, string> } {
  const marcador = pares.find(([k, v]) => k === v)?.[0];
  const parametros: Record<string, string> = {};
  for (const [k, v] of pares) {
    if (k === idPagina) continue; // lo pone `construirOpcionesPagina` con la página pedida
    if (k === marcador) continue; // viaja como control
    parametros[k] = v;
  }
  return { control: marcador ?? formId, parametros };
}

// ------------------------------------------------------------------ números

function esNumeroPagina(valor: string): boolean {
  return /^\d+$/.test(valor.trim());
}

function aNumero(texto: string): number | undefined {
  const limpio = texto.replace(/[\s ]+/g, '');
  return /^\d+$/.test(limpio) ? Number(limpio) : undefined;
}
