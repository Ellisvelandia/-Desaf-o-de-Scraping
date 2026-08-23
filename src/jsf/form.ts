/**
 * Extracción de formularios JSF.
 *
 * Regla del portal: un POST solo es válido si reenvía todos los campos del
 * formulario tal como los dejó la última respuesta, incluido el ViewState.
 * Este módulo lee esos campos del HTML vigente para que el scraper nunca
 * tenga que inventar uno.
 */
import * as cheerio from 'cheerio';

export type CamposFormulario = Array<[string, string]>;

export interface FormularioJsf {
  id: string;
  /** Atributo action tal cual (incluye `;jsessionid=…` cuando el servidor lo incrusta). */
  action: string;
  /** Pares nombre/valor en orden de documento, como los enviaría un navegador. */
  campos: CamposFormulario;
  viewState: string;
}

/**
 * Lee un formulario por id y devuelve sus campos en el orden del documento.
 *
 * Replica el criterio de un navegador: omite checkbox/radio no marcados y
 * omite botones (JSF resuelve la acción por el nombre del botón que aparece en
 * el cuerpo, así que enviar dos equivale a pulsar dos).
 */
export function extraerFormulario($: cheerio.CheerioAPI, formId: string): FormularioJsf {
  const $form = $(`form[id="${formId}"]`).first();
  if ($form.length === 0) throw new Error(`No existe el formulario "${formId}" en la página`);

  const campos: CamposFormulario = [];

  $form.find('input[name], select[name], textarea[name]').each((_, el) => {
    const $el = $(el);
    const name = $el.attr('name');
    if (!name) return;
    const tag = ((el as { tagName?: string }).tagName ?? '').toLowerCase();
    const type = ($el.attr('type') ?? 'text').toLowerCase();

    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset' || type === 'file') return;
      if ((type === 'checkbox' || type === 'radio') && $el.attr('checked') === undefined) return;
      campos.push([name, $el.attr('value') ?? '']);
      return;
    }
    if (tag === 'select') {
      let $sel = $el.find('option[selected]').first();
      if ($sel.length === 0) $sel = $el.find('option').first();
      campos.push([name, $sel.attr('value') ?? $sel.text() ?? '']);
      return;
    }
    campos.push([name, $el.text() ?? '']);
  });

  const viewState = campos.find(([n]) => n === 'javax.faces.ViewState')?.[1] ?? '';
  if (!viewState) throw new Error(`El formulario "${formId}" no contiene javax.faces.ViewState`);

  return {
    id: formId,
    action: $form.attr('action') ?? '',
    campos,
    viewState,
  };
}

/** Sustituye (o añade) el valor de un campo manteniendo el orden. */
export function fijarCampo(campos: CamposFormulario, nombre: string, valor: string): CamposFormulario {
  let visto = false;
  const salida: CamposFormulario = campos.map(([n, v]) => {
    if (n === nombre) {
      visto = true;
      return [n, valor];
    }
    return [n, v];
  });
  if (!visto) salida.push([nombre, valor]);
  return salida;
}

/** Nombre completo del primer campo cuyo nombre termina en el sufijo dado. */
export function buscarCampo(campos: CamposFormulario, sufijo: string): string | undefined {
  return campos.find(([n]) => n === sufijo || n.endsWith(':' + sufijo))?.[0];
}
