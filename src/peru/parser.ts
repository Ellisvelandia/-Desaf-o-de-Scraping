/**
 * Parser de la lista de resultados de la Jurisprudencia Nacional Sistematizada
 * (Poder Judicial del Perú).
 *
 * ESTRUCTURA REAL DEL PORTAL, verificada en vivo sobre el DOM del sitio:
 *
 *   div.rf-p                          ← un panel = una resolución
 *     div.rf-p-hdr                    ← cabecera roja
 *       table>tbody>tr>td>span        ← tipo de recurso ("Apelación", "Casación")
 *                      td>span        ← nº de expediente ("037233-2025")
 *     div.rf-p-b                      ← cuerpo
 *       div.row > div.col-sm-*
 *         div.col-md-12.txtbold       ← RÓTULO ("Sumilla:", "Sala Suprema:"…)
 *         div.col-md-12               ← VALOR
 *       table>tbody>tr>td>a>img       ← "Ver Ficha" y "Ver Resolución"
 *
 * DOS DECISIONES DE DISEÑO, y el motivo de cada una:
 *
 * 1. Se indexa POR RÓTULO, nunca por posición. El portal ya pinta bloques de
 *    ancho variable (`col-sm-4` y `col-sm-8` en la misma fila) y añade rótulos
 *    según el tipo de resolución. Con índices fijos, el día que el Poder Judicial
 *    inserte un campo, la «Sala Suprema» pasaría a leerse de la «Fecha» sin que
 *    nada fallara: datos equivocados con aspecto de correctos. Todo rótulo que no
 *    se reconoce va a `camposExtra`, que es como el enunciado pide «toda la
 *    información disponible» sin tener que enumerarla de antemano.
 *
 * 2. El identificador de descarga (`uuid` de `ServletDescarga`) es la clave de
 *    deduplicación. El nº de expediente NO sirve: un mismo expediente puede
 *    publicar varias resoluciones, y usarlo como clave fundiría todas en una y
 *    descartaría en silencio las demás. El uuid identifica al documento, que es
 *    la unidad que este portal publica.
 */
import * as cheerio from 'cheerio';
import { EstructuraInesperadaError } from '../errores';
import { DocumentoProceso, ProcesoJudicial } from '../types';
import { log } from '../utils/logger';

/**
 * Tipos de cheerio derivados de su propia API, igual que en `parser.ts`:
 * `domhandler` es una dependencia transitiva y no declarada, así que importar
 * `Element` de ahí ataría este fichero a un paquete que nadie ha elegido.
 */
type Seleccion = ReturnType<ReturnType<cheerio.CheerioAPI['root']>['children']>;
type Elemento = Seleccion extends ArrayLike<infer E> ? E : never;

/** Nº de expediente del portal: cuatro a ocho dígitos, guion, año. */
const RE_EXPEDIENTE = /^\d{4,8}-\d{4}$/;

/** Fecha dd/mm/aaaa, que es como publica el portal. */
const RE_FECHA = /(\d{1,2})\/(\d{1,2})\/(\d{4})/;

/** Ruta del servlet que sirve el PDF de una resolución. */
const RE_SERVLET = /ServletDescarga\?uuid=([0-9a-fA-F-]{16,})/;

/** «Página: 1 de 15247» — el portal anuncia el total en páginas, no en registros. */
const RE_TOTAL_PAGINAS = /\bde\s+([\d.,]{1,12})\s*$/;

/** Rótulos que tienen sitio propio en el contrato y no se duplican en `camposExtra`. */
const ROTULO_SALA = 'sala suprema';
const ROTULO_FECHA = 'fecha resolucion';

/**
 * Los rangos van como secuencias de escape y no como el carácter literal por la
 * misma razón que el BOM de `persistencia.ts`: un separador de ancho cero escrito
 * tal cual es invisible en el editor, y cualquiera lo borraría sin saber qué
 * quitaba.
 */
function normalizar(texto: string): string {
  return texto
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Clave estable a partir de un rótulo: sin acentos, minúsculas, solo alfanumérico. */
function normalizarClave(texto: string): string {
  return normalizar(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * dd/mm/aaaa → aaaa-mm-dd, o undefined si la fecha no existe.
 *
 * Se valida el día real del mes en vez de fiarse del rollover de `Date`: sin la
 * comprobación, un 31/02/2026 se convertiría calladamente en 2026-03-03.
 */
function aIsoFecha(valor: string): string | undefined {
  const m = RE_FECHA.exec(valor);
  if (!m) return undefined;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const anio = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return undefined;
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) return undefined;
  return `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function texto($: cheerio.CheerioAPI, el: Elemento): string {
  return normalizar($(el).text());
}

/**
 * Total de PÁGINAS que anuncia el portal, no de registros.
 *
 * Es una distinción con consecuencias: el paginador dice «de 15247» refiriéndose
 * a páginas, y tomarlo por un número de resultados haría creer al orquestador que
 * ha terminado tras la página 1524 —el 10 % del corpus— porque ya habría
 * acumulado más registros que ese número.
 */
export function detectarTotalPaginas($: cheerio.CheerioAPI): number | undefined {
  let total: number | undefined;
  $('*').each((_, el) => {
    if (total !== undefined) return;
    const $el = $(el);
    // Solo nodos hoja: en un ancestro, el texto agregado casaría con cualquier
    // «de N» que apareciera en otra parte de la página.
    if ($el.children().length > 0) return;
    const m = RE_TOTAL_PAGINAS.exec(normalizar($el.text()));
    if (!m) return;
    const n = Number(m[1].replace(/[.,]/g, ''));
    if (Number.isInteger(n) && n > 0) total = n;
  });
  return total;
}

/** Página activa según el paginador (`span.rf-ds-act`). */
export function detectarPaginaActual($: cheerio.CheerioAPI): number | undefined {
  const n = Number(normalizar($('.rf-ds-nmb-btn.rf-ds-act').first().text()));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** ¿El paginador ofrece alguna página posterior a la actual? */
export function hayPaginaSiguiente($: cheerio.CheerioAPI, paginaActual: number): boolean {
  // El botón «siguiente» desaparece, o se marca deshabilitado, en la última página.
  const siguienteVivo =
    $('a.rf-ds-btn-next').filter((_, el) => !/dis(abled)?\b/i.test($(el).attr('class') ?? '')).length > 0;
  if (siguienteVivo) return true;
  // Respaldo: cualquier número mayor que el actual sigue siendo pulsable.
  let mayor = false;
  $('a.rf-ds-nmb-btn').each((_, el) => {
    const n = Number(normalizar($(el).text()));
    if (Number.isInteger(n) && n > paginaActual) mayor = true;
  });
  return mayor;
}

/**
 * Extrae las resoluciones de una página de resultados.
 *
 * Lanza `EstructuraInesperadaError` cuando hay paneles con pinta de resultado
 * pero ninguno rinde un registro identificable: es la señal de que la plantilla
 * cambió, y detenerse con el HTML a la vista vale más que devolver filas a medias
 * que nadie revisará hasta el día de la entrega.
 */
export function parsearResoluciones($: cheerio.CheerioAPI, pagina: number): ProcesoJudicial[] {
  const paneles = $('div.rf-p').filter(
    (_, el) => $(el).find('div.rf-p-hdr').length > 0 && $(el).find('div.rf-p-b').length > 0,
  );

  if (paneles.length === 0) return [];

  const resoluciones: ProcesoJudicial[] = [];
  let descartados = 0;

  paneles.each((_, panel) => {
    const registro = parsearPanel($, panel, pagina);
    if (registro) resoluciones.push(registro);
    else descartados++;
  });

  if (resoluciones.length === 0) {
    const muestra = normalizar(paneles.first().text()).slice(0, 300);
    throw new EstructuraInesperadaError(
      `La página ${pagina} trae ${paneles.length} panel(es) de resultado, pero ninguno publica ni expediente ni ` +
        `enlace de descarga con los que identificarlo. Primer panel: ${JSON.stringify(muestra)}`,
    );
  }

  if (descartados > 0) {
    // `warn` y no `debug`: descartar una resolución es perder un dato que el
    // enunciado pide extraer, y tiene que verse en la salida normal.
    log.warn(`Página ${pagina}: ${descartados} panel(es) sin expediente ni enlace utilizable, descartados`);
  }

  return resoluciones;
}

// ---------------------------------------------------------------- internos

function parsearPanel($: cheerio.CheerioAPI, panel: Elemento, pagina: number): ProcesoJudicial | undefined {
  const $panel = $(panel);
  const cuerpo = $panel.find('div.rf-p-b').first();

  const { tipo, expediente } = parsearCabecera($, $panel.find('div.rf-p-hdr').first());
  const rotulos = parsearRotulos($, cuerpo);
  const documento = parsearDescarga(cuerpo, expediente);

  // Sin ninguna de las dos anclas no hay forma de nombrar el registro ni de
  // deduplicarlo, así que guardarlo produciría duplicados en cada pasada.
  if (!expediente && !documento) return undefined;

  // El uuid identifica LA RESOLUCIÓN; el expediente identifica el EXPEDIENTE, que
  // puede publicar varias. Se prefiere el uuid para no fundir resoluciones
  // distintas del mismo expediente en un solo registro.
  const claveUnica = documento?.id ?? `exp:${expediente}`;

  const registro: ProcesoJudicial = { claveUnica, paginaOrigen: pagina };
  if (expediente) registro.numeroProcesso = expediente;
  if (tipo) registro.classeJudicial = tipo;

  const sala = rotulos.get(ROTULO_SALA);
  if (sala) registro.orgaoJulgador = sala;

  const fecha = rotulos.get(ROTULO_FECHA);
  const iso = fecha === undefined ? undefined : aIsoFecha(fecha);
  if (iso) registro.dataAutuacao = iso;

  const extra: Record<string, string> = {};
  for (const [clave, valor] of rotulos) {
    // Un rótulo ya volcado a un campo del contrato no se repite en `camposExtra`.
    // La fecha es la excepción condicional: si NO se pudo interpretar como ISO,
    // su literal se conserva aquí en vez de tirarse, porque el dato del portal
    // vale aunque su formato cambie.
    if (clave === ROTULO_SALA && registro.orgaoJulgador) continue;
    if (clave === ROTULO_FECHA && registro.dataAutuacao) continue;
    extra[clave] = valor;
  }
  if (Object.keys(extra).length > 0) registro.camposExtra = extra;

  if (documento) registro.documentos = [documento];

  const ficha = parsearFichaEnlace($, cuerpo);
  if (ficha) registro.apertura = { tipo: 'url', url: ficha };

  return registro;
}

/** Tipo de recurso y nº de expediente de la cabecera del panel. */
function parsearCabecera(
  $: cheerio.CheerioAPI,
  cabecera: Seleccion,
): { tipo?: string; expediente?: string } {
  const textos: string[] = [];
  cabecera.find('span, td').each((_, el) => {
    const $el = $(el);
    if ($el.children().length > 0) return;
    const t = texto($, el);
    if (t) textos.push(t);
  });

  // El expediente se reconoce POR SU FORMATO, no por su posición: es la única
  // señal autoverificable de la cabecera, y sobrevive a que el portal reordene
  // las celdas o añada una.
  const expediente = textos.find((t) => RE_EXPEDIENTE.test(t));
  const tipo = textos.find((t) => t !== expediente);
  return {
    ...(tipo ? { tipo } : {}),
    ...(expediente ? { expediente } : {}),
  };
}

/**
 * Pares rótulo→valor del cuerpo, indexados por rótulo normalizado.
 *
 * El valor es el siguiente `div` hermano del rótulo, que es como el portal
 * maqueta cada bloque. Un rótulo sin valor se omite en lugar de emitirse vacío:
 * el contrato dice que un campo ausente no se promete.
 */
function parsearRotulos($: cheerio.CheerioAPI, cuerpo: Seleccion): Map<string, string> {
  const pares = new Map<string, string>();
  cuerpo.find('.txtbold').each((_, el) => {
    const clave = normalizarClave($(el).text().replace(/:\s*$/, ''));
    if (!clave) return;
    const valor = normalizar($(el).next('div').text());
    if (!valor) return;
    // El primero gana: si el portal repitiera un rótulo, sobrescribir dejaría el
    // último, que no tiene por qué ser el del bloque principal.
    if (!pares.has(clave)) pares.set(clave, valor);
  });
  return pares;
}

/** Documento descargable del panel: el enlace a `ServletDescarga`. */
function parsearDescarga(
  cuerpo: Seleccion,
  expediente: string | undefined,
): DocumentoProceso | undefined {
  const href = cuerpo.find('a[href*="ServletDescarga"]').first().attr('href');
  if (!href) return undefined;
  const m = RE_SERVLET.exec(href);
  if (!m) return undefined;

  return {
    id: m[1],
    // Título descriptivo y estable: el portal no rotula el enlace con texto (es
    // una imagen), así que se compone con el dato que sí identifica al documento.
    titulo: expediente ? `Resolucion ${expediente}` : 'Resolucion',
    descarga: { tipo: 'url', url: href },
  };
}

/** Enlace «Ver Ficha», cuando el portal lo publica como URL de verdad. */
function parsearFichaEnlace($: cheerio.CheerioAPI, cuerpo: Seleccion): string | undefined {
  const href = cuerpo
    .find('a')
    .filter((_, el) => $(el).find('img[src*="btn-ver-ficha"]').length > 0)
    .first()
    .attr('href');
  // Un `href="#"` o un `javascript:` no son navegación: emitirlos como `url`
  // haría que la Fase 2 pidiera la página actual creyendo abrir la ficha.
  if (!href || href === '#' || /^javascript:/i.test(href)) return undefined;
  return href;
}
