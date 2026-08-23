/**
 * Protocolo AJAX parcial de JSF 2 (`javax.faces.partial.ajax`).
 *
 * POR QUÉ ESTE MÓDULO EXISTE APARTE DE `a4j.ts`: son dos protocolos distintos de
 * dos generaciones distintas del mismo ecosistema, y mezclarlos daría un parser
 * que no lee bien ninguno de los dos.
 *
 *  - `a4j.ts` habla el dialecto de RichFaces 3.3 sobre JSF 1.2 (el del PJe del
 *    TRF5): la respuesta es un documento XHTML con `<meta name="Ajax-Update-Ids">`
 *    y los fragmentos sueltos en el `<body>`.
 *  - Este módulo habla el estándar de JSF 2 (el de la Jurisprudencia Nacional
 *    Sistematizada del Poder Judicial del Perú): la respuesta es
 *    `<partial-response>` con un `<changes>` de `<update id="…"><![CDATA[…]]>`.
 *
 * El parseo es en dos etapas a propósito. La envoltura se lee en modo XML —sin
 * él, htmlparser2 trata `<![CDATA[…]]>` como un comentario mal formado y el HTML
 * de dentro se pierde entero—, y el fragmento recuperado se vuelve a cargar en
 * modo HTML, que es lo que es. Una sola pasada en cualquiera de los dos modos
 * devuelve basura.
 */
import * as cheerio from 'cheerio';

/** Id con el que JSF publica el ViewState nuevo dentro de `<changes>`. */
const ID_VIEW_STATE = 'javax.faces.ViewState';

/**
 * Ids especiales de JSF 2 que NO son elementos del documento.
 *
 * `@all` pide reemplazar el documento entero y los `javax.faces.*` transportan
 * estado, no marcado. Tratarlos como un id de elemento haría que el bucle de
 * sustitución buscase `[id="@all"]`, no encontrase nada y añadiese el documento
 * entero al final del `<body>` vigente: a partir de ahí habría dos formularios
 * con el mismo id y el scraper leería el equivocado.
 */
const IDS_NO_ELEMENTO = new Set([ID_VIEW_STATE, '@all']);

export interface OpcionesParcial {
  /** Id del formulario JSF que se reenvía completo (p. ej. `formBuscador`). */
  formId: string;
  /** Componente que origina el evento: va en `javax.faces.source`. */
  source: string;
  /** Valor de `javax.faces.partial.event`, si el componente lo declara. */
  evento?: string;
  /** Qué ejecuta el servidor. Por defecto `@all`, que es el valor por omisión de JSF. */
  execute?: string;
  /** Qué re-renderiza el servidor. Por defecto `@all`. */
  render?: string;
  /** Parámetros propios del componente (p. ej. el número de página del datascroller). */
  parametros?: Record<string, string>;
}

/**
 * Construye el cuerpo urlencoded de una petición parcial de JSF 2.
 *
 * Reenvía el formulario entero —JSF valida el estado contra lo que envió— y
 * añade encima los marcadores del protocolo parcial.
 */
export function construirCuerpoParcial(
  campos: Array<[string, string]>,
  viewState: string,
  o: OpcionesParcial,
): URLSearchParams {
  const body = new URLSearchParams();

  for (const [n, v] of campos) {
    // El ViewState se coloca al final con el valor vigente, como hace el navegador.
    if (n === ID_VIEW_STATE) continue;
    body.append(n, v);
  }

  // Convención JSF: el formulario se nombra a sí mismo. Solo se añade si el HTML
  // no lo traía ya como oculto, para no enviarlo dos veces.
  if (!campos.some(([n]) => n === o.formId)) body.append(o.formId, o.formId);

  for (const [k, v] of Object.entries(o.parametros ?? {})) body.append(k, v);

  body.append('javax.faces.source', o.source);
  if (o.evento) body.append('javax.faces.partial.event', o.evento);
  body.append('javax.faces.partial.execute', o.execute ?? '@all');
  body.append('javax.faces.partial.render', o.render ?? '@all');
  body.append('javax.faces.partial.ajax', 'true');
  body.append(ID_VIEW_STATE, viewState);

  return body;
}

export interface ResultadoParcial {
  /** Ids de elemento que el servidor pidió actualizar (sin los pseudo-ids de JSF). */
  idsActualizados: string[];
  /** ViewState nuevo, si vino en la respuesta. */
  viewState?: string;
  /** Destino cuando el servidor responde `<redirect>` (sesión caducada, por ejemplo). */
  redireccion?: string;
  /** Mensaje de `<error>`, cuando el servidor devuelve una excepción del servidor JSF. */
  error?: string;
}

/**
 * ¿Es esto una respuesta parcial de JSF 2?
 *
 * Se comprueba antes de aplicarla porque un portal cansado responde a veces con
 * una página HTML de error y un 200. Aplicar eso como si fuera XML no falla:
 * simplemente no actualiza nada, y el scraper seguiría paginando sobre la misma
 * página creyendo que avanza.
 */
export function esRespuestaParcial(xml: string): boolean {
  return /<partial-response\b/i.test(xml);
}

/**
 * Aplica una respuesta parcial sobre el documento vigente y devuelve qué cambió.
 *
 * Mantener un documento vigente y parchearlo como haría el navegador es lo que
 * permite seguir leyendo el formulario y la lista tras cada salto de página.
 */
export function aplicarRespuestaParcial($doc: cheerio.CheerioAPI, xml: string): ResultadoParcial {
  // Etapa 1: la envoltura, en modo XML, para que el CDATA sobreviva.
  const $r = cheerio.load(xml, { xml: true });

  const redireccion = $r('partial-response > redirect').attr('url');
  if (redireccion) return { idsActualizados: [], redireccion };

  const error = $r('partial-response > error > error-message').first().text().trim();
  if (error) return { idsActualizados: [], error };

  const ids: string[] = [];
  let viewState: string | undefined;

  $r('partial-response > changes > update').each((_, el) => {
    const $update = $r(el);
    const id = $update.attr('id') ?? '';
    // `.text()` devuelve el contenido del CDATA ya sin la envoltura.
    const contenido = $update.text();

    // El ViewState puede llegar con el id exacto o con el id de cliente que JSF
    // le pone en algunas implementaciones (`j_id1:javax.faces.ViewState:0`).
    if (id === ID_VIEW_STATE || id.endsWith(':' + ID_VIEW_STATE) || id.includes(ID_VIEW_STATE)) {
      viewState = contenido.trim();
      return;
    }
    if (IDS_NO_ELEMENTO.has(id) || !id) return;

    const $viejo = $doc(`[id="${id}"]`).first();
    // Etapa 2: el fragmento se sustituye como HTML, que es lo que es.
    if ($viejo.length > 0) {
      $viejo.replaceWith(contenido);
      ids.push(id);
    }
    // Un id que no existe en el documento vigente NO se añade al final: en JSF 2
    // toda actualización se refiere a un componente ya renderizado, así que un id
    // desconocido significa que el documento vigente no es el que el servidor
    // cree. Añadirlo al `<body>` produciría ids duplicados y lecturas silenciosas
    // del elemento equivocado; omitirlo deja el hecho visible en `idsActualizados`.
  });

  if (viewState) {
    // Todos los ViewState del documento vigente se sincronizan con el nuevo: el
    // siguiente POST se construye leyendo el formulario del documento, y uno
    // desactualizado lo rechazaría el servidor con la vista caducada.
    $doc(`input[name="${ID_VIEW_STATE}"]`).attr('value', viewState);
  }

  return viewState === undefined ? { idsActualizados: ids } : { idsActualizados: ids, viewState };
}
