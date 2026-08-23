/**
 * Detección de la plantilla de Consulta Pública que sirve el portal.
 *
 * El PJe no es un único front: conviven dos plantillas de consulta pública que
 * no comparten ni el id del formulario, ni el botón de búsqueda, ni la política
 * de CAPTCHA. Antes de rellenar un formulario hay que saber cuál de las dos
 * tenemos delante, porque enviar el POST de una a la otra devuelve la página de
 * inicio sin error visible y el fallo aparece mucho después, al no haber tabla.
 *
 *   - 'seam' — la plantilla antigua (p. ej. https://pje.trf5.jus.br/pjeconsulta/):
 *     formulario `consultaPublicaForm`, botón `:pesq` y un CAPTCHA de imagen de
 *     Seam que el servidor SÍ valida.
 *   - 'fpp'  — la plantilla moderna del resto de instancias: formulario `fPP`,
 *     botón `fPP:searchProcessos` y tabla `…:processosTable`. En las instancias
 *     observadas el POST devuelve la tabla renderizada sin token de CAPTCHA.
 *
 * REGLA QUE ATRAVIESA TODO EL FICHERO: nada se busca por un id literal completo.
 * Los sufijos `j_idNNN` que JSF genera cambian entre instancias (TRF5 usa
 * 255/257/263 donde TRF1 usa 257/259/265), y hasta el prefijo puede cambiar si
 * alguien renombra el formulario. Se busca por sufijo de id (`[id$=":pesq"]`) y
 * se deriva el prefijo del elemento encontrado.
 */

import * as cheerio from 'cheerio';
import { desescaparJs } from './ficha';

/** Cuál de las dos plantillas de consulta pública sirve el portal. */
export type VariantePje = 'seam' | 'fpp';

/** Todo lo que el resto del scraper necesita saber para operar sobre la página. */
export interface PerfilVariante {
  variante: VariantePje;
  /** Id del formulario de búsqueda; es también el prefijo de los ids de sus campos. */
  formId: string;
  /** Id completo del control que dispara la búsqueda. */
  botonBuscar: string;
  /** Si hay que resolver un CAPTCHA antes de que el servidor acepte la búsqueda. */
  requiereCaptcha: boolean;
  /**
   * Id real de la tabla de resultados en esta instancia, cuando la página ya la
   * trae. Se omite en la página de inicio: no se puede prometer un id que
   * todavía no existe en el documento.
   */
  idTablaResultados?: string;
}

/** Sufijo del id de la tabla de resultados de la plantilla moderna. */
const SUFIJO_TABLA = '[id$=":processosTable"]';

/**
 * Marcas de un CAPTCHA realmente presente en el documento.
 *
 * Deliberadamente NO se mira el `<script src="…/recaptcha/api.js">`: las páginas
 * de resultados de la plantilla moderna cargan ese script y a continuación
 * definen `function executarReCaptcha() { if (false) { grecaptcha.execute(); … } }`,
 * es decir, el widget está desactivado en servidor. Confiar en la etiqueta
 * `<script>` haría creer que hace falta un CAPTCHA que nadie va a pedir, y el
 * scraper se bloquearía solo. Solo cuenta un widget instanciado en el DOM.
 */
const SELECTORES_CAPTCHA = [
  '.g-recaptcha',
  '.h-captcha',
  '[data-sitekey]',
  'img[src*="captcha" i]',
  'input[name*="captcha" i]',
  '[id$=":captcha"]',
].join(', ');

/** Prefijo JSF de un id compuesto (`fPP:searchProcessos` → `fPP`). */
function prefijoDe(id: string): string | undefined {
  const corte = id.lastIndexOf(':');
  return corte > 0 ? id.slice(0, corte) : undefined;
}

/**
 * Id completo del control cuyo id termina en `sufijo`.
 *
 * Cuando hay varios candidatos gana el que cuelga del formulario detectado: en
 * una página con varios formularios (el portal antiguo trae diez) el sufijo por
 * sí solo no basta para saber cuál es "el" botón de buscar.
 */
function idPorSufijo($: cheerio.CheerioAPI, sufijo: string, formId: string): string | undefined {
  const ids = $(`[id$="${sufijo}"]`)
    .toArray()
    .map((el) => $(el).attr('id'))
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  return ids.find((id) => prefijoDe(id) === formId) ?? ids[0];
}

/** Id del primer elemento que casa con el selector, si lo hay. */
function idDe($: cheerio.CheerioAPI, selector: string): string | undefined {
  const id = $(selector).first().attr('id');
  return id !== undefined && id.length > 0 ? id : undefined;
}

/** Hay un widget de CAPTCHA instanciado en el documento (no solo su `<script>`). */
function hayWidgetCaptcha($: cheerio.CheerioAPI): boolean {
  return $(SELECTORES_CAPTCHA).length > 0;
}

/**
 * Perfil de la plantilla que sirve el documento vigente.
 *
 * @throws Error si el documento no es ninguna de las dos consultas públicas
 *         conocidas. Se lanza en vez de devolver un perfil por defecto porque
 *         un perfil inventado produciría un POST a un formulario inexistente y
 *         el diagnóstico aparecería páginas después, ya sin contexto.
 */
export function detectarVariante($: cheerio.CheerioAPI): PerfilVariante {
  const idTabla = idDe($, SUFIJO_TABLA);

  // 1) Plantilla moderna. La reconoce el formulario `fPP` o cualquier campo con
  //    su prefijo: en las respuestas parciales de a4j llega el fragmento con los
  //    campos pero sin el `<form>` que los envuelve.
  const formFpp = idDe($, 'form#fPP');
  const hayCamposFpp = $('[id^="fPP:"]').length > 0;
  if (formFpp !== undefined || hayCamposFpp) {
    return perfilModerno($, formFpp ?? 'fPP', idTabla);
  }

  // 2) Plantilla antigua. Se comprueba ANTES que la tabla suelta del punto 3
  //    para que una página del portal antiguo nunca se clasifique como moderna.
  const formSeam = idDe($, 'form#consultaPublicaForm');
  if (formSeam !== undefined) {
    const formId = formSeam;
    return {
      variante: 'seam',
      formId,
      // El botón puede no existir en un fragmento; su id se deriva del formulario.
      botonBuscar: idPorSufijo($, ':pesq', formId) ?? `${formId}:pesq`,
      // Constante y no deducida del DOM: en esta plantilla el CAPTCHA de Seam lo
      // valida el servidor, así que hace falta aunque el fragmento no lo pinte.
      requiereCaptcha: true,
      ...(idTabla !== undefined ? { idTablaResultados: idTabla } : {}),
    };
  }

  // 3) Solo la tabla: una respuesta parcial de la plantilla moderna que trae los
  //    resultados sin el formulario. El prefijo real sale del id de la tabla.
  if (idTabla !== undefined) {
    return perfilModerno($, prefijoDe(idTabla) ?? 'fPP', idTabla);
  }

  throw new Error(
    'El documento no es ninguna de las dos consultas públicas conocidas del PJe: no hay ' +
      'form#fPP ni campos con prefijo "fPP:" (plantilla moderna), no hay form#consultaPublicaForm ' +
      '(plantilla antigua) y no hay ninguna tabla [id$=":processosTable"]. Comprueba que la URL ' +
      'apunta a la Consulta Pública y no a una página de login, a un error del portal o a una ' +
      `redirección; formularios presentes: ${describirFormularios($)}.`,
  );
}

/** Perfil de la plantilla moderna, con el prefijo ya resuelto. */
function perfilModerno($: cheerio.CheerioAPI, formId: string, idTabla: string | undefined): PerfilVariante {
  return {
    variante: 'fpp',
    formId,
    botonBuscar: idPorSufijo($, ':searchProcessos', formId) ?? `${formId}:searchProcessos`,
    // Por defecto false: está verificado que estas instancias devuelven la tabla
    // sin token de CAPTCHA. Se eleva a true solo si el DOM trae un widget real,
    // porque entonces sí hay algo que resolver.
    requiereCaptcha: hayWidgetCaptcha($),
    ...(idTabla !== undefined ? { idTablaResultados: idTabla } : {}),
  };
}

/** Lista de ids de formulario, para que el error diga qué se encontró en su lugar. */
function describirFormularios($: cheerio.CheerioAPI): string {
  const ids = $('form')
    .toArray()
    .map((el) => $(el).attr('id') ?? '(sin id)');
  return ids.length === 0 ? '(ninguno)' : ids.join(', ');
}

/**
 * Localiza el control que realmente lanza la búsqueda en la variante moderna.
 *
 * El botón «Pesquisar» NO es el control efectivo. Su `onclick` es:
 *
 *   return executarReCaptcha();;A4J.AJAX.Submit('fPP', ... 'fPP:searchProcessos' ...)
 *
 * El `return` corta la ejecución, así que ese `A4J.AJAX.Submit` nunca corre. El
 * envío real lo hace `executarPesquisa()`, un `a4j:jsFunction` oculto que el
 * portal define aparte y cuyo control es un identificador generado:
 *
 *   executarPesquisa=function(){ A4J.AJAX.Submit('fPP', null,
 *     { ... 'parameters':{'fPP:j_id244':'fPP:j_id244'} } ) };
 *
 * Ese identificador cambia entre instancias (`j_id244` en una, `j_id248` en
 * otra), así que se lee del propio JavaScript en cada ejecución. Enviar el
 * botón en su lugar produce una respuesta A4J vacía: el servidor repinta un
 * panel y no ejecuta la consulta.
 */
export function localizarControlBusqueda($: cheerio.CheerioAPI, formId: string): string | undefined {
  // El desescapado lo hace `desescaparJs`, el mismo que ya usa `ficha.ts`, y no un
  // `replace` a mano. Aquí había uno que no desescapaba nada: dentro de una
  // expresión regular, `/\x2D/g` ES el propio carácter `-`, así que sustituía
  // guiones por guiones. Lo que RichFaces escribe en el JavaScript es el texto
  // LITERAL de cuatro caracteres `\x2D`, y con el no-op un id como
  // `fPP:j\x2Did244` viajaba crudo en el POST. JSF no reconoce ese control y
  // responde con una actualización A4J vacía: ningún error, ninguna tabla.
  for (const el of $('script').toArray()) {
    const js = $(el).text();
    if (!js.includes('executarPesquisa')) continue;

    const m = /executarPesquisa\s*=\s*function[\s\S]*?'parameters'\s*:\s*\{\s*'([^']+)'/.exec(js);
    if (m) {
      const id = desescaparJs(m[1]);
      if (id.startsWith(`${formId}:`)) return id;
    }

    const sim = /executarPesquisa\s*=\s*function[\s\S]*?'similarityGroupingId'\s*:\s*'([^']+)'/.exec(js);
    if (sim) {
      const id = desescaparJs(sim[1]);
      if (id.startsWith(`${formId}:`)) return id;
    }
  }
  return undefined;
}
