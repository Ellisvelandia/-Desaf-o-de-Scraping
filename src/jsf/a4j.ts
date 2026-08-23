/**
 * Protocolo AJAX de RichFaces 3.3 (Ajax4jsf, "A4J").
 *
 * El navegador no navega: envía el formulario por XMLHttpRequest con cuatro
 * marcadores extra y recibe un documento XML con los fragmentos que debe
 * sustituir en el DOM. Este módulo reproduce ambas mitades:
 *
 *  - construirCuerpoA4J: formulario completo + marcadores + botón pulsado.
 *  - aplicarRespuestaA4J: localiza `Ajax-Update-Ids`, sustituye esos elementos
 *    en el documento vigente y recoge el nuevo ViewState.
 *
 * Mantener un documento "vigente" y parchearlo como hace el navegador es lo que
 * permite seguir leyendo el formulario y la tabla tras cada interacción.
 */
import * as cheerio from 'cheerio';
import { CamposFormulario, fijarCampo } from './form';

export interface OpcionesA4J {
  /** Id del formulario JSF (p. ej. `consultaPublicaForm`). */
  formId: string;
  /** Nombre completo del control que "se pulsa" (botón o enlace A4J). */
  control: string;
  /** Región AJAX: `_viewRoot` para el formulario entero, o el id de un a4j:region. */
  region?: string;
  /** Si el control es ajaxSingle, RichFaces añade `ajaxSingle=<control>`. */
  ajaxSingle?: boolean;
  /** Parámetros adicionales que RichFaces pasa en `parameters` (p. ej. el índice del datascroller). */
  parametros?: Record<string, string>;
}

/** Construye el cuerpo urlencoded exactamente como lo envía A4J.AJAX.Submit. */
export function construirCuerpoA4J(campos: CamposFormulario, viewState: string, o: OpcionesA4J): URLSearchParams {
  const body = new URLSearchParams();
  body.append('AJAXREQUEST', o.region ?? '_viewRoot');

  // Campos del formulario en orden de documento, con el ViewState vigente.
  for (const [n, v] of fijarCampo(campos, 'javax.faces.ViewState', viewState)) {
    if (n === 'javax.faces.ViewState') continue; // se coloca después, como hace el navegador
    body.append(n, v);
  }

  // El formulario se nombra a sí mismo (convención JSF 1.2) y lleva `autoScroll`;
  // ambos suelen venir ya como inputs ocultos. Solo se añaden si faltan.
  if (!campos.some(([n]) => n === o.formId)) body.append(o.formId, o.formId);
  if (!campos.some(([n]) => n === 'autoScroll')) body.append('autoScroll', '');
  body.append('javax.faces.ViewState', viewState);

  // Control pulsado y parámetros extra.
  body.append(o.control, o.control);
  if (o.ajaxSingle) body.append('ajaxSingle', o.control);
  for (const [k, v] of Object.entries(o.parametros ?? {})) body.append(k, v);

  body.append('AJAX:EVENTS_COUNT', '1');
  return body;
}

export interface ResultadoA4J {
  /** Ids que el servidor pidió actualizar. Vacío si la respuesta no es A4J. */
  idsActualizados: string[];
  /** ViewState nuevo, si vino. */
  viewState?: string;
  /** True si el servidor indicó una redirección completa (sesión caducada, etc.). */
  redireccion?: string;
}

/**
 * Aplica una respuesta A4J sobre el documento vigente y devuelve qué cambió.
 *
 * La respuesta es XML `<html>` con los elementos actualizados en el body, un
 * `<meta name="Ajax-Update-Ids">` con sus ids y un `#ajax-view-state` con el
 * ViewState nuevo. Si trae `<meta name="Location">`, es una redirección.
 */
export function aplicarRespuestaA4J($doc: cheerio.CheerioAPI, xml: string): ResultadoA4J {
  // La respuesta es XHTML; se parsea en modo HTML porque la re-serialización XML
  // de los fragmentos con <script>/CDATA no sobrevive al segundo parseo.
  const $r = cheerio.load(xml);

  const redireccion = $r('meta[name="Location"]').attr('content');
  if (redireccion) return { idsActualizados: [], redireccion };

  const contenido = $r('meta[name="Ajax-Update-Ids"]').attr('content') ?? '';
  const ids = contenido
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  for (const id of ids) {
    const $nuevo = $r(`[id="${id}"]`).first();
    if ($nuevo.length === 0) continue;
    const $viejo = $doc(`[id="${id}"]`).first();
    const html = $r.html($nuevo);
    if ($viejo.length > 0) $viejo.replaceWith(html);
    else $doc('body').append(html);
  }

  const viewState = $r('#ajax-view-state input[name="javax.faces.ViewState"]').attr('value')
    ?? $r('input[name="javax.faces.ViewState"]').first().attr('value');

  if (viewState) {
    // Sincroniza todos los ViewState del documento vigente con el nuevo valor.
    $doc('input[name="javax.faces.ViewState"]').attr('value', viewState);
  }

  return { idsActualizados: ids, viewState };
}
