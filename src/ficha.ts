/**
 * Parser de la ficha de un proceso en la variante moderna del PJe.
 *
 * Es la página que abre `DetalheProcessoConsultaPublica/listView.seam?ca=<hash>`:
 * un GET simple, sin captcha, que devuelve las partes, las movimentaciones y la
 * rejilla de documentos ya renderizadas.
 *
 * Tres decisiones gobiernan el módulo:
 *
 *  - **Las tablas se localizan por sufijo de id, nunca por su id completo.** JSF
 *    antepone a cada id el del formulario que lo contiene (`j_id146:` en el
 *    fixture del TRF5), y ese número cambia entre instancias y entre versiones
 *    del PJe. El sufijo (`:processoEvento`, `:processoDocumentoGridTab`…) es lo
 *    único estable, porque lo escribe la plantilla y no el contador de JSF.
 *  - **El texto de una cabecera de RichFaces viene contaminado.** El `<th>` de
 *    una columna ordenable arrastra el `<script>` con la función `clear_…` que
 *    genera el `commandLink` de ordenación; `.text()` lo concatena al rótulo y
 *    produce «Participantefunction clear_j_id146_3A…». Hay que descontaminarlo
 *    antes de comparar nada.
 *  - **Un documento sin forma conocida de descarga no es un documento.** Se
 *    omite en lugar de emitirlo con `descarga` indefinida: un registro así solo
 *    sirve para que la Fase 2 lo cuente como fallo más adelante.
 */
import * as cheerio from 'cheerio';
import { DescargaDirecta, DescargaPostback, DocumentoProceso, Parte } from './types';

/**
 * Tipos de cheerio derivados de su propia API.
 *
 * Se replica el criterio de `parser.ts`: importar `Element` de `domhandler`
 * ataría el fichero a una dependencia transitiva que nadie ha declarado.
 */
type Seleccion = ReturnType<ReturnType<cheerio.CheerioAPI['root']>['children']>;
type Elemento = Seleccion extends ArrayLike<infer E> ? E : never;

/** Lo que la ficha de un proceso aporta por encima de lo que ya trae la lista. */
export interface DatosFicha {
  /**
   * La página analizada ERA una ficha (trae al menos una de sus cuatro tablas).
   *
   * Sin esta bandera, «esta ficha no publica documentos» y «esto no es una
   * ficha, el portal devolvió la pantalla de sesión caducada» son el mismo
   * `{ partes: [], documentos: [] }`, y el orquestador no puede distinguir un
   * proceso legítimamente vacío de una navegación que se fue al garete. El
   * llamante no puede deducirlo por su cuenta sin duplicar aquí los sufijos de
   * id de las tablas, que es justo el detalle que este módulo encapsula.
   */
  esFicha: boolean;
  partes: Parte[];
  documentos: DocumentoProceso[];
  /** Rótulos del bloque «Dados do Processo», indexados por su etiqueta visible. */
  camposExtra?: Record<string, string>;
}

// ---------------------------------------------------------------- constantes

/**
 * Sufijos de id de las cuatro tablas de la ficha.
 *
 * El prefijo variable (`j_id146:`) se deja fuera a propósito: es el punto en el
 * que un selector literal dejaría de funcionar al cambiar de tribunal.
 */
const SUFIJO_POLO_ACTIVO = ':processoPartesPoloAtivoResumidoList';
const SUFIJO_POLO_PASIVO = ':processoPartesPoloPassivoResumidoList';
const SUFIJO_EVENTOS = ':processoEvento';
const SUFIJO_DOCUMENTOS = ':processoDocumentoGridTab';

/**
 * Los mismos sufijos, expuestos para diagnóstico y pruebas.
 *
 * Se publican para que nadie tenga que reescribirlos fuera: un sufijo copiado a
 * mano en otro fichero es exactamente la clase de dato que se queda atrás
 * cuando el PJe renombra una tabla.
 */
export const TABLAS_FICHA = {
  poloActivo: SUFIJO_POLO_ACTIVO,
  poloPasivo: SUFIJO_POLO_PASIVO,
  eventos: SUFIJO_EVENTOS,
  documentos: SUFIJO_DOCUMENTOS,
} as const;

/**
 * Fecha brasileña con hora opcional: `dd/MM/yyyy`, `dd/MM/yyyy HH:mm` o
 * `dd/MM/yyyy HH:mm:ss`.
 *
 * Los lookarounds de dígito evitan que un número largo se lea como fecha, y se
 * prefieren a `\b` porque el texto de una celda llega concatenado sin espacios.
 */
const RE_FECHA_BR_HORA = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?!\d)/;

/**
 * Informe en PDF que el portal sirve por GET: `reportReciboPDF.seam` (el
 * comprobante de protocolo de un documento) y `reportPDF.seam` (el expediente
 * completo).
 *
 * Es la ÚNICA ruta de este portal verificada sirviendo un binario de verdad:
 * `docs/protocol.md` («Descarga de documentos — VERIFICADA en vivo») registra un
 * `200 application/pdf`, 18.238 B, con los bytes mágicos `%PDF-1`, pidiendo
 * `reportReciboPDF.seam?idBin=…&idProcessoDoc=…&idProcessoTrf=…` con las cookies
 * de la ficha. Por eso encabeza la preferencia de descarga.
 */
const RE_REPORTE_PDF = /report[A-Za-z]*PDF\.seam(?=[?;]|$)/i;

/**
 * Visor HTML del documento: `documentoSemLoginHTML.seam?ca=<hash>&idProcessoDoc=`.
 *
 * Se acepta como respaldo, no como primera opción, y el nombre del servlet dice
 * por qué: devuelve `text/html`. En la prueba en vivo redirigió a la lista en vez
 * de servir el documento, así que `ServicioDescarga` la rechazará por firma
 * («los bytes iniciales no son los de un PDF»). Se emite igualmente porque es la
 * dirección que el portal publica para ese documento y porque de ella salen su
 * `idProcessoDoc` y su fecha; lo que NO se hace es preferirla a un PDF real.
 */
const RE_DOCUMENTO_SIN_LOGIN = /documentoSemLoginHTML\.seam\?/i;

/**
 * Parámetros de la descarga binaria clásica de JSF.
 *
 * Los tres a la vez, porque con menos la URL no es autosuficiente. No aparece en
 * ninguna de las capturas de este portal (`actionMethod` no sale ni una vez en
 * `pje-nuevo-ficha.html`); se conserva porque otras instancias del PJe la usan y
 * exigir los tres impide que reconozca de más.
 */
const RE_ID_BIN = /[?&;]idBin=/i;
const RE_NUMERO_DOCUMENTO = /[?&;]numeroDocumento=/i;
const RE_ACTION_METHOD = /[?&;]actionMethod=/i;

/**
 * Identificadores de documento que pueden viajar en la URL, en orden de
 * preferencia: `idProcessoDoc` es el que la ficha usa como clave del documento;
 * `idBin` apunta al binario concreto y solo se usa si no hay nada mejor.
 */
const CLAVES_ID_DOCUMENTO = ['idProcessoDoc', 'idProcessoDocumento', 'idDocumento', 'idBin', 'numeroDocumento'];

// ----------------------------------------------------------------- utilidades

/** Colapsa espacios y quita los invisibles que el portal cuela en las celdas. */
function normalizar(texto: string): string {
  return texto
    .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deshace los escapes de una cadena literal de JavaScript.
 *
 * RichFaces emite `\x2D` en lugar de `-` dentro del `actionUrl` para no romper
 * el atributo HTML; sin deshacerlo, cualquier valor extraído de un `onclick`
 * llegaría con la secuencia cruda.
 */
export function desescaparJs(valor: string): string {
  return valor.replace(
    /\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\(.)/g,
    (_completo: string, hex?: string, unicode?: string, simple?: string): string => {
      if (hex !== undefined) return String.fromCharCode(parseInt(hex, 16));
      if (unicode !== undefined) return String.fromCharCode(parseInt(unicode, 16));
      switch (simple) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        default:
          return simple ?? '';
      }
    },
  );
}

/**
 * Convierte una fecha brasileña a ISO-8601, con hora si el portal la publica.
 *
 * Sin zona horaria: el PJe publica hora local del tribunal y añadir una `Z`
 * afirmaría un huso que la página no dice.
 */
function aIso(valor: string): string | undefined {
  const m = RE_FECHA_BR_HORA.exec(valor);
  if (!m) return undefined;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const anio = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return undefined;
  // Valida el día real del mes (31/02 no existe) sin fiarse del rollover de Date.
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) return undefined;

  const dd = `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
  if (m[4] === undefined || m[5] === undefined) return dd;
  const hora = Number(m[4]);
  const minuto = Number(m[5]);
  const segundo = m[6] === undefined ? 0 : Number(m[6]);
  // Una hora imposible no invalida la fecha: se devuelve el día, que sí es fiable.
  if (hora > 23 || minuto > 59 || segundo > 59) return dd;
  return `${dd}T${String(hora).padStart(2, '0')}:${String(minuto).padStart(2, '0')}:${String(segundo).padStart(2, '0')}`;
}

/** Un bloque delimitado dentro de un script, con su cuerpo y dónde termina. */
interface Bloque {
  cuerpo: string;
  fin: number;
}

/**
 * Recorta el primer bloque `{…}` o `[…]` a partir de `desde`, contando
 * profundidad y respetando las comillas.
 *
 * Una expresión regular perezosa (`\{.*?\}`) parece equivalente y no lo es: se
 * corta en la primera llave de cierre, así que basta con que un valor lleve una
 * llave —o con que el objeto tenga un objeto anidado, que es el caso de
 * `PrimeFaces.ab`— para que devuelva JSON truncado.
 */
function recortarBloque(script: string, desde: number, apertura: string, cierre: string): Bloque | undefined {
  const inicio = script.indexOf(apertura, desde);
  if (inicio === -1) return undefined;
  let profundidad = 0;
  let comilla = '';
  for (let i = inicio; i < script.length; i++) {
    const c = script[i];
    if (comilla) {
      if (c === '\\') i++;
      else if (c === comilla) comilla = '';
      continue;
    }
    if (c === "'" || c === '"') comilla = c;
    else if (c === apertura) profundidad++;
    else if (c === cierre && --profundidad === 0) return { cuerpo: script.slice(inicio + 1, i), fin: i + 1 };
  }
  return undefined;
}

/**
 * Pares `clave: 'valor'` de un cuerpo de objeto JavaScript.
 *
 * El patrón está anclado a la forma del literal (clave con o sin comillas,
 * valor entrecomillado admitiendo escapes) en lugar de trocear por comas, que
 * partiría cualquier valor que llevase una.
 */
function paresDeObjeto(cuerpo: string): Record<string, string> {
  const re = /(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;
  const pares: Record<string, string> = {};
  let m = re.exec(cuerpo);
  while (m) {
    const clave = m.at(1) ?? m.at(2) ?? m.at(3);
    const valor = m.at(4) ?? m.at(5);
    if (clave !== undefined && valor !== undefined) pares[clave] = desescaparJs(valor);
    m = re.exec(cuerpo);
  }
  return pares;
}

// -------------------------------------------------- localización de las tablas

/**
 * Busca la tabla cuyo id termina en `sufijo`.
 *
 * Se intenta primero con el id sobre el propio `<table>` (lo que hace
 * RichFaces 3.3) y después con un id sobre un contenedor, para no depender de
 * en qué elemento haya decidido colgarlo la plantilla de turno.
 */
function localizarTabla($: cheerio.CheerioAPI, sufijo: string): Seleccion | undefined {
  const selector = `[id$="${sufijo}"]`;
  const directa = $(`table${selector}`).first();
  if (directa.length > 0) return directa;
  const anidada = $(selector).find('table').first();
  return anidada.length > 0 ? anidada : undefined;
}

/**
 * Texto limpio de un `<th>` de RichFaces.
 *
 * Dos pasadas, porque una sola no basta:
 *  1. Se eliminan `<script>` y `<style>`, que es donde vive el grueso del ruido.
 *  2. Se corta por la primera aparición de `function ` en el texto resultante,
 *     porque el script de ordenación puede llegar sin etiqueta cuando el HTML
 *     viene de una respuesta parcial A4J ya insertada como texto.
 */
function textoCabecera($: cheerio.CheerioAPI, th: Elemento): string {
  const copia = $(th).clone();
  copia.find('script, style').remove();
  const bruto = copia.text();
  const corte = /function\s/.exec(bruto);
  return normalizar(corte ? bruto.slice(0, corte.index) : bruto);
}

/** Cabeceras limpias de una tabla, en orden de columna. */
function cabecerasDeTabla($: cheerio.CheerioAPI, tabla: Seleccion): string[] {
  return tabla
    .find('thead th')
    .toArray()
    .map((th) => textoCabecera($, th));
}

/**
 * Cabeceras limpias de una de las tablas de la ficha, por sufijo de id.
 *
 * Se exporta porque la descontaminación del `<th>` es una de las dos trampas de
 * esta página y NINGÚN campo del resultado la deja ver: `DatosFicha` no
 * arrastra ningún rótulo de columna, así que sin esta función no habría forma de
 * comprobar que sigue funcionando. Sobre `pje-nuevo-ficha.html` el `<th>` en
 * bruto dice «Participantefunction clear_j_id146_3Aproceso…» y esta devuelve
 * «Participante».
 *
 * Devuelve `[]` si la tabla no está en el documento.
 */
export function cabecerasDeFicha($: cheerio.CheerioAPI, sufijo: string): string[] {
  const tabla = localizarTabla($, sufijo);
  return tabla ? cabecerasDeTabla($, tabla) : [];
}

// ------------------------------------------------------------------- partes

/**
 * Nombre de la parte que ocupa una celda «Participante».
 *
 * Se descartan tres cosas antes de leer el texto:
 *  - `<script>` y `<style>`: la celda trae un `<style>` con `.none { … }`
 *    incrustado que `.text()` concatenaría al nombre.
 *  - `<ul>`: cuelga la procuraduría o la defensoría que representa a la parte,
 *    que es un dato de la representación y no parte del nombre.
 */
function nombreDeParte($: cheerio.CheerioAPI, celda: Elemento): string {
  const copia = $(celda).clone();
  copia.find('script, style, ul').remove();
  return normalizar(copia.text());
}

/**
 * Partes de uno de los dos polos.
 *
 * El papel se toma del polo y no del paréntesis del nombre («(PARTE AUTORA)»,
 * «(ADVOGADO)»): el paréntesis describe el rol dentro del polo, mientras que lo
 * que el contrato pide es de qué lado del pleito está la parte.
 */
function partesDePolo($: cheerio.CheerioAPI, sufijo: string, papel: string): Parte[] {
  const tabla = localizarTabla($, sufijo);
  if (!tabla) return [];

  // Índice de la columna «Participante»; si la cabecera no se reconoce se cae a
  // la primera columna, que es donde el PJe la ha puesto siempre.
  const cabeceras = cabecerasDeTabla($, tabla);
  const indice = cabeceras.findIndex((c) => /^participante/i.test(c));
  const columna = indice >= 0 ? indice : 0;

  const partes: Parte[] = [];
  for (const fila of tabla.find('tbody tr').toArray()) {
    const celdas = $(fila).children('td').toArray();
    const celda = celdas.at(columna) ?? celdas.at(0);
    if (!celda) continue;
    const nombre = nombreDeParte($, celda);
    // Una fila sin nombre legible no es una parte: es la fila «sin resultados».
    if (!nombre) continue;
    partes.push({ papel, nombre });
  }
  return partes;
}

// --------------------------------------------------------------- documentos

/** URLs candidatas que aparecen en el `href` y en el script de un control. */
function urlsCandidatas($: cheerio.CheerioAPI, enlace: Elemento): string[] {
  const $a = $(enlace);
  const hrefBruto = $a.attr('href');
  const href = hrefBruto === undefined ? undefined : normalizar(hrefBruto);
  const enlaceEsScript = href !== undefined && /^javascript:/i.test(href);

  const urls: string[] = [];
  if (href && !enlaceEsScript && href !== '#') urls.push(href);

  // `openPopUp('nombre', 'url')` y `window.open('url', …)` son las dos formas en
  // que la ficha abre un documento en una ventana aparte. El argumento se lee
  // con un patrón anclado a la llamada, no buscando un «http» suelto.
  const script = `${$a.attr('onclick') ?? ''} ${enlaceEsScript && href ? href : ''}`;
  const rePopUp = /openPopUp\(\s*(?:'([^']*)'|"([^"]*)")\s*,\s*(?:'([^']*)'|"([^"]*)")\s*\)/g;
  let m = rePopUp.exec(script);
  while (m) {
    const url = m.at(3) ?? m.at(4);
    if (url) urls.push(desescaparJs(url));
    m = rePopUp.exec(script);
  }
  const reWindow = /window\.open\(\s*(?:'([^']*)'|"([^"]*)")/g;
  let w = reWindow.exec(script);
  while (w) {
    const url = w.at(1) ?? w.at(2);
    if (url) urls.push(desescaparJs(url));
    w = reWindow.exec(script);
  }

  return urls.filter((u) => u.length > 0 && u !== '#');
}

/**
 * ¿Esta URL sirve un BINARIO con un GET?
 *
 * Es la preferencia máxima y el orden importa de verdad: el mismo enlace de la
 * rejilla de documentos publica a la vez la URL del comprobante en PDF y un
 * postback A4J que solo notifica al servidor. Repetir el POST no trae el
 * archivo; la URL sí.
 */
function esUrlBinaria(url: string): boolean {
  if (RE_REPORTE_PDF.test(url)) return true;
  return RE_ID_BIN.test(url) && RE_NUMERO_DOCUMENTO.test(url) && RE_ACTION_METHOD.test(url);
}

/** ¿Esta URL sirve el documento con un GET, aunque sea el visor HTML? */
function esUrlVisor(url: string): boolean {
  return RE_DOCUMENTO_SIN_LOGIN.test(url);
}

/**
 * Postback de RichFaces (`A4J.AJAX.Submit`) declarado en el `onclick`.
 *
 * El id del formulario es el primer argumento; el control, el
 * `similarityGroupingId` que RichFaces añade siempre. Del bloque `parameters`
 * se descarta el par autorreferente (`control: control`), que es la marca JSF
 * del botón pulsado y el emisor del POST ya añade por su cuenta.
 */
function postbackA4J(script: string, formPorDefecto?: string): DescargaPostback | undefined {
  const llamada = script.indexOf('A4J.AJAX.Submit');
  if (llamada === -1) return undefined;

  const argumentos = /A4J\.AJAX\.Submit\(\s*(?:'([^']*)'|"([^"]*)")/.exec(script.slice(llamada));
  const formId = argumentos?.at(1) ?? argumentos?.at(2) ?? formPorDefecto;
  if (!formId) return undefined;

  const marca = script.indexOf("'parameters'", llamada);
  const bloque = marca === -1 ? undefined : recortarBloque(script, marca + "'parameters'".length, '{', '}');
  const parametros = bloque ? paresDeObjeto(bloque.cuerpo) : {};

  const similar = /'similarityGroupingId'\s*:\s*'([^']*)'/.exec(script.slice(llamada))?.at(1);
  const autoreferente = Object.entries(parametros).find(([k, v]) => k === v && k.startsWith(`${formId}:`));
  const control = similar ?? autoreferente?.[0];
  if (!control) return undefined;

  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(parametros)) {
    if (k === control && v === control) continue;
    extra[k] = v;
  }

  const postback: DescargaPostback = { tipo: 'postback', formId, control };
  if (Object.keys(extra).length > 0) postback.parametros = extra;
  return postback;
}

/**
 * Postback de PrimeFaces (`PrimeFaces.ab({s:…,f:…,pa:[…]})`).
 *
 * Las versiones nuevas del PJe conviven con RichFaces, así que la ficha puede
 * traer cualquiera de los dos. El objeto raíz se recorta contando profundidad
 * porque lleva objetos anidados dentro de `pa`.
 */
function postbackPrimeFaces(script: string, formPorDefecto?: string): DescargaPostback | undefined {
  const llamada = script.indexOf('PrimeFaces.ab');
  if (llamada === -1) return undefined;

  const raiz = recortarBloque(script, llamada, '{', '}');
  if (!raiz) return undefined;
  const opciones = paresDeObjeto(raiz.cuerpo);

  const control = opciones['s'];
  if (!control) return undefined;
  const formId = opciones['f'] ?? formPorDefecto;
  if (!formId) return undefined;

  const postback: DescargaPostback = { tipo: 'postback', formId, control };

  // Los parámetros de usuario viajan en `pa:[{name,value},…]`, no en la raíz.
  const marcaPa = /(?:^|[,{\s])(?:'pa'|"pa"|pa)\s*:\s*\[/.exec(raiz.cuerpo);
  if (marcaPa) {
    const lista = recortarBloque(raiz.cuerpo, marcaPa.index, '[', ']');
    const parametros: Record<string, string> = {};
    if (lista) {
      // Se avanza con el `fin` de cada entrada, nunca volviendo a buscar su
      // contenido: una entrada vacía daría siempre la misma posición.
      let desde = 0;
      for (let entrada = recortarBloque(lista.cuerpo, desde, '{', '}'); entrada !== undefined; ) {
        const par = paresDeObjeto(entrada.cuerpo);
        const nombre = par['name'];
        const valor = par['value'];
        if (nombre !== undefined && valor !== undefined) parametros[nombre] = valor;
        desde = entrada.fin;
        entrada = recortarBloque(lista.cuerpo, desde, '{', '}');
      }
    }
    if (Object.keys(parametros).length > 0) postback.parametros = parametros;
  }
  return postback;
}

/** Identificador del documento, leído de la primera URL que lo publique. */
function identificarDocumento(urls: string[]): string | undefined {
  for (const clave of CLAVES_ID_DOCUMENTO) {
    const re = new RegExp(`[?&;]${clave}=([^&#;]+)`, 'i');
    for (const url of urls) {
      const bruto = re.exec(url)?.at(1);
      if (!bruto) continue;
      try {
        const valor = normalizar(decodeURIComponent(bruto));
        if (valor) return valor;
      } catch {
        // Un porcentaje suelto en la URL no debe tumbar la lectura del documento.
        const valor = normalizar(bruto);
        if (valor) return valor;
      }
    }
  }
  return undefined;
}

/** Texto visible del enlace, sin iconos ni etiquetas para lector de pantalla. */
function textoVisible($: cheerio.CheerioAPI, enlace: Elemento): string {
  const copia = $(enlace).clone();
  copia.find('script, style, i, .sr-only, .fa').remove();
  return normalizar(copia.text());
}

/** Texto de la fila que contiene el enlace, ya descontaminado de scripts. */
function textoDeFila($: cheerio.CheerioAPI, enlace: Elemento): string {
  const fila = $(enlace).closest('tr');
  if (fila.length === 0) return '';
  const copia = fila.clone();
  copia.find('script, style').remove();
  return normalizar(copia.text());
}

/** El título y la fecha que el rótulo de un documento lleva pegados. */
interface RotuloLeido {
  titulo: string;
  fecha?: string;
}

/**
 * Separa la fecha del título dentro del rótulo de un documento.
 *
 * El PJe usa dos formas para el mismo dato: «Nome do movimento (dd/MM/yyyy
 * HH:mm:ss)» en la lista de resultados y «dd/MM/yyyy HH:mm:ss - Nome» en la
 * ficha. Se recorta por posición y no con un `replace` construido a partir del
 * texto encontrado, que obligaría a escapar la propia fecha.
 */
function leerRotulo(rotulo: string): RotuloLeido {
  const m = RE_FECHA_BR_HORA.exec(rotulo);
  if (!m) return { titulo: rotulo };

  let antes = rotulo.slice(0, m.index);
  let despues = rotulo.slice(m.index + m[0].length);
  // Si la fecha venía entre paréntesis, los paréntesis se van con ella.
  if (/\(\s*$/.test(antes) && /^\s*\)/.test(despues)) {
    antes = antes.replace(/\(\s*$/, '');
    despues = despues.replace(/^\s*\)/, '');
  }
  const titulo = normalizar(`${antes} ${despues}`)
    .replace(/^[\s\-–—:·|]+/, '')
    .replace(/[\s\-–—:·|]+$/, '');

  const fecha = aIso(m[0]);
  return fecha ? { titulo, fecha } : { titulo };
}

/**
 * Convierte un enlace de la ficha en un documento descargable.
 *
 * Devuelve `undefined` cuando no hay forma conocida de obtener el archivo: un
 * `DocumentoProceso` sin `descarga` no aporta nada que la fase de descarga
 * pueda usar, y emitirlo solo desplazaría el fallo al final del proceso.
 */
function documentoDeEnlace($: cheerio.CheerioAPI, enlace: Elemento): DocumentoProceso | undefined {
  const urls = urlsCandidatas($, enlace);

  // El GET directo tiene prioridad sobre el postback aunque el enlace declare
  // los dos, que es justo lo que hace la rejilla de documentos: el mismo control
  // abre la ventana con la URL y además notifica al servidor por A4J. Repetir el
  // POST no trae el archivo; la URL sí.
  const directa = urls.find(esUrlBinaria) ?? urls.find(esUrlVisor);
  let descarga: DescargaDirecta | DescargaPostback | undefined;
  if (directa) {
    descarga = { tipo: 'url', url: directa };
  } else {
    const $enlace = $(enlace);
    const hrefBruto = $enlace.attr('href');
    const href = hrefBruto === undefined ? undefined : normalizar(hrefBruto);
    const enlaceEsScript = href !== undefined && /^javascript:/i.test(href);
    const script = `${$enlace.attr('onclick') ?? ''} ${enlaceEsScript && href ? href : ''}`;
    const formPorDefecto = $enlace.closest('form').attr('id');
    descarga = postbackA4J(script, formPorDefecto) ?? postbackPrimeFaces(script, formPorDefecto);
  }
  if (!descarga) return undefined;

  const { titulo, fecha } = leerRotulo(textoVisible($, enlace));

  // Cadena de respaldo para el título: hay controles que son solo un icono (el
  // comprobante de protocolo), y un documento con título vacío es inservible
  // para nombrar el fichero en disco.
  const $a = $(enlace);
  const respaldos = [
    titulo,
    normalizar($a.attr('title') ?? ''),
    normalizar($a.find('.sr-only').first().text()),
    normalizar($a.attr('aria-label') ?? ''),
    leerRotulo(textoDeFila($, enlace)).titulo,
  ];
  const tituloFinal = respaldos.find((t) => t.length > 0);
  if (!tituloFinal) return undefined;

  // La fecha del propio rótulo manda; si el control no la lleva (un icono), se
  // toma la de su fila, que en esta ficha es la del documento al que pertenece.
  const fechaFinal = fecha ?? aIso(textoDeFila($, enlace));
  const id = identificarDocumento(urls);

  const documento: DocumentoProceso = { titulo: tituloFinal, descarga };
  if (id) documento.id = id;
  if (fechaFinal) documento.fecha = fechaFinal;
  return documento;
}

/** Clave de identidad de un documento, para no emitir el mismo dos veces. */
function claveDocumento(doc: DocumentoProceso): string {
  return JSON.stringify([doc.id ?? '', doc.titulo, doc.fecha ?? '', doc.descarga]);
}

/**
 * Documentos de una tabla de la ficha.
 *
 * Solo se recorre el `<tbody>`: el `<thead>` de RichFaces lleva sus propios
 * `<a>` de ordenación, que son postbacks perfectamente válidos y no documentos.
 */
function documentosDeTabla($: cheerio.CheerioAPI, tabla: Seleccion | undefined): DocumentoProceso[] {
  if (!tabla) return [];
  const documentos: DocumentoProceso[] = [];
  for (const enlace of tabla.find('tbody a').toArray()) {
    const doc = documentoDeEnlace($, enlace);
    if (doc) documentos.push(doc);
  }
  return documentos;
}

// ------------------------------------------------------------- campos extra

/**
 * Rótulos del bloque «Dados do Processo».
 *
 * El PJe los pinta con el patrón `div.propertyView > div.name + div.value`. Hay
 * una variante sin rótulo en la que el bloque de valor contiene varios pares
 * `<b>Rótulo</b><br>valor`; se desdobla en lugar de emitir una entrada con la
 * clave vacía y los tres campos pegados dentro.
 */
function camposDeFicha($: cheerio.CheerioAPI): Record<string, string> {
  const campos: Record<string, string> = {};
  for (const vista of $('.propertyView').toArray()) {
    const $vista = $(vista);
    const nombre = normalizar($vista.children('.name').text());
    const $valor = $vista.children('.value');
    if ($valor.length === 0) continue;

    if (nombre) {
      const valor = normalizar($valor.text());
      if (valor) campos[nombre] = valor;
      continue;
    }

    // El valor de cada rótulo son nodos de texto sueltos entre `<br>`, no
    // elementos: `nextUntil('b')` los ignoraría y devolvería siempre cadena
    // vacía. Hay que recorrer `contents()`, que sí incluye los nodos de texto.
    for (const padre of $valor.find('b').parent().toArray()) {
      let clave = '';
      let acumulado = '';
      const guardar = (): void => {
        const valor = normalizar(acumulado);
        if (clave && valor) campos[clave] = valor;
      };
      for (const nodo of $(padre).contents().toArray()) {
        const $nodo = $(nodo);
        if ($nodo.is('b')) {
          guardar();
          clave = normalizar($nodo.text());
          acumulado = '';
        } else if (clave) {
          acumulado += ` ${$nodo.text()}`;
        }
      }
      guardar();
    }
  }
  return campos;
}

// ------------------------------------------------------------------ público

/**
 * Extrae partes, documentos y datos de cabecera de la ficha de un proceso.
 *
 * Sobre una página que no es una ficha devuelve
 * `{ esFicha: false, partes: [], documentos: [] }` sin lanzar: el scraper llama a
 * esta función con lo que le haya devuelto el portal, y una sesión caducada
 * responde con la pantalla de login, no con un error. La bandera `esFicha` es lo
 * que permite a quien llama distinguir «esta ficha no tiene documentos» de «esto
 * no es una ficha» sin volver a mirar el DOM.
 */
export function parsearFicha($: cheerio.CheerioAPI): DatosFicha {
  const tablaEventos = localizarTabla($, SUFIJO_EVENTOS);
  const tablaDocumentos = localizarTabla($, SUFIJO_DOCUMENTOS);
  const tablaPoloActivo = localizarTabla($, SUFIJO_POLO_ACTIVO);
  const tablaPoloPasivo = localizarTabla($, SUFIJO_POLO_PASIVO);

  const partes = [
    ...partesDePolo($, SUFIJO_POLO_ACTIVO, 'ATIVO'),
    ...partesDePolo($, SUFIJO_POLO_PASIVO, 'PASSIVO'),
  ];

  // La rejilla de documentos va primero: cuando el mismo archivo aparece en las
  // dos tablas, la entrada que sobrevive a la deduplicación es la que trae el
  // `idProcessoDoc`, que es el identificador con el que nombrarlo en disco.
  const brutos = [...documentosDeTabla($, tablaDocumentos), ...documentosDeTabla($, tablaEventos)];

  // Deduplicación por identidad completa: la tabla de movimentaciones repite el
  // mismo acórdão en tres filas distintas (una por expedición) apuntando al
  // mismo `ca=`. Emitirlo tres veces haría que la fase de descarga bajase tres
  // veces el mismo PDF.
  const documentos: DocumentoProceso[] = [];
  const vistos = new Set<string>();
  for (const doc of brutos) {
    const clave = claveDocumento(doc);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    documentos.push(doc);
  }

  const esFicha =
    tablaEventos !== undefined ||
    tablaDocumentos !== undefined ||
    tablaPoloActivo !== undefined ||
    tablaPoloPasivo !== undefined;

  const datos: DatosFicha = { esFicha, partes, documentos };
  if (esFicha) {
    // Los campos de cabecera solo se prometen cuando la página es de verdad una
    // ficha: en cualquier otra, `.propertyView` podría existir y significar otra
    // cosa, y el contrato pide exactamente `{ partes: [], documentos: [] }`.
    const camposExtra = camposDeFicha($);
    if (Object.keys(camposExtra).length > 0) datos.camposExtra = camposExtra;
  }
  return datos;
}
