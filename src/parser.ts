/**
 * Parser de la lista de resultados y de la ficha de un proceso.
 *
 * Dos decisiones gobiernan todo el módulo:
 *
 *  - **Se indexa por cabecera, no por posición.** El día que el portal inserte
 *    una columna, un mapeo posicional sigue "funcionando" y produce registros
 *    con la clase judicial en el campo del órgano. El mapeo por cabecera falla
 *    de forma visible o se adapta solo. El modo posicional existe únicamente
 *    como red de seguridad y viene con una aserción ancla.
 *  - **Un fallo ruidoso vale más que un registro basura.** Cuando hay una tabla
 *    que estructuralmente es la de resultados pero su contenido ya no se
 *    reconoce, se lanza `EstructuraInesperadaError` en lugar de devolver filas
 *    a medias. La ausencia de tabla, en cambio, no es un error: es una página
 *    sin resultados y devuelve `[]`.
 *
 * Nota sobre la evidencia, que decide qué camino toma cada página: el PJe sirve
 * la Consulta Pública con DOS plantillas incompatibles (ver `docs/protocol.md`,
 * «Dos variantes de la Consulta Pública»).
 *
 *  - Plantilla MODERNA (`fPP`, tabla `…:processosTable`): VERIFICADA contra tres
 *    capturas reales. `parsearProcesos` la reconoce por la tabla y delega en
 *    `parserModerno.ts`, que sabe descomponer su celda «Processo» compuesta.
 *  - Plantilla ANTIGUA (`consultaPublicaForm`, la del TRF5 1.º grado): su tabla
 *    de resultados sigue SIN capturar, porque el CAPTCHA de imagen la bloquea.
 *    Es la que lee el resto de este módulo, con los marcadores estructurales que
 *    RichFaces 3.3 genera siempre (`rich-table`, `rich-table-row`, `tbody` con
 *    sufijo `:tb`); las etiquetas de cabecera se tratan como sinónimos
 *    tolerantes y todo lo que no encaje viaja a `camposExtra` sin perderse.
 */
import * as cheerio from 'cheerio';
import { EstructuraInesperadaError } from './errores';
import { detectarTotalModerno, parsearProcesosModerno } from './parserModerno';
import { DescargaDirecta, DescargaPostback, DocumentoProceso, Parte, ProcesoJudicial } from './types';
import { log } from './utils/logger';

/**
 * Se reexporta desde aquí porque este módulo fue siempre su casa pública: el
 * orquestador y las pruebas lo importan de `./parser`. Su declaración se mudó a
 * `./errores` para que `parserModerno` pueda lanzarlo sin cerrar un ciclo de
 * módulos con este fichero.
 */
export { EstructuraInesperadaError };

/**
 * Tipos de cheerio derivados de su propia API.
 *
 * `domhandler` es una dependencia transitiva, no declarada en package.json:
 * importar `Element` de ahí ataría este fichero a un paquete que nadie ha
 * elegido. Derivarlos de `CheerioAPI` da los mismos tipos sin esa deuda.
 */
type Seleccion = ReturnType<ReturnType<cheerio.CheerioAPI['root']>['children']>;
type Elemento = Seleccion extends ArrayLike<infer E> ? E : never;

// ---------------------------------------------------------------- constantes

/**
 * Marca de la plantilla MODERNA de la Consulta Pública: la tabla de resultados
 * `<…>:processosTable`.
 *
 * Se ancla por SUFIJO de id. El prefijo es el del formulario que la envuelve
 * (`fPP` en las tres instancias capturadas) y el sufijo lo escribe la plantilla,
 * no el contador `j_idNNN` de JSF, que sí cambia de un tribunal a otro.
 */
const SELECTOR_TABLA_MODERNA = '[id$=":processosTable"]';

/**
 * El parámetro `ca=` del enlace a la ficha.
 *
 * Es la ÚNICA fuente de clave que le queda a una fila sin número CNJ. Y es una
 * fuente válida porque `ca` es un identificador de contenido que el portal asigna
 * al expediente: estable entre páginas y entre ejecuciones. Un control de
 * postback NO sirve para lo mismo, porque su nombre lleva dentro el índice de la
 * fila (`…:tabelaProcessos:3:…`), que cambia en cuanto cambia la página.
 */
const RE_PARAMETRO_CA = /[?&]ca=([^&#\s]+)/;

/** Prefijo de la clave derivada, para que no se pueda confundir con un número real. */
const PREFIJO_SIGILO = 'sigilo:';

/** Número CNJ completo: NNNNNNN-DD.AAAA.J.TR.OOOO. Sirve de ancla estructural. */
const RE_NUMERO_CNJ = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;
/** El mismo número, buscado dentro de una celda que además trae enlaces o adornos. */
const RE_NUMERO_CNJ_EN_TEXTO = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/;
/**
 * Fecha brasileña dd/MM/yyyy.
 *
 * Se delimita con lookarounds de dígito y no con `\b`: el texto de una fila
 * llega concatenado sin espacios ("12/03/2024Petição inicial") y un `\b` final
 * exigiría un carácter no alfanumérico que ahí no existe.
 */
const RE_FECHA_BR = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/;
/** Fecha ya en ISO-8601, que se acepta tal cual. */
const RE_FECHA_ISO = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;

/**
 * Columnas mínimas que debe tener una fila para creerse una fila de resultados
 * en modo posicional: el número del proceso más dos datos. Con menos, lo que
 * hay delante no es la lista de procesos.
 */
const COLUMNAS_MINIMAS = 3;

/**
 * Separador que se inyecta donde había un `<br>` antes de aplanar una celda.
 * Se usa un carácter de control (RECORD SEPARATOR) y no `\n` porque el HTML
 * original ya trae saltos de línea de indentación que partirían un mismo nombre
 * en dos.
 */
const SEPARADOR_LINEA = '\u001e';

/** Marcadores estructurales que RichFaces 3.3 pone en una `rich:dataTable`. */
const SELECTORES_TABLA = [
  'table.rich-table',
  'table[id*="dataTable"]',
  'table[id*="DataTable"]',
] as const;

/** Contenedores del `rich:datascroller`, donde a veces vive el total de registros. */
const SELECTORES_PAGINADOR = [
  '.rich-datascr',
  '[class*="datascr"]',
  '[id*="scroller"]',
  '[id*="Scroller"]',
] as const;

/** Campos del contrato que este parser sabe rellenar desde una columna. */
type CampoConocido = 'numeroProcesso' | 'classeJudicial' | 'orgaoJulgador' | 'dataAutuacao' | 'partes';

/**
 * Cabeceras que el PJe usa para cada campo, ya normalizadas.
 *
 * Es una lista de sinónimos, no una promesa: la cabecera real del TRF5 no está
 * verificada (ver la nota de arriba). Lo que no case aquí no se pierde, acaba en
 * `camposExtra` con su cabecera como clave.
 */
const SINONIMOS: ReadonlyArray<readonly [CampoConocido, readonly string[]]> = [
  [
    'numeroProcesso',
    ['processo', 'numero do processo', 'numero processo', 'no do processo', 'n do processo', 'numero unico', 'numero'],
  ],
  ['classeJudicial', ['classe judicial', 'classe', 'classe processual', 'assunto classe']],
  [
    'orgaoJulgador',
    ['orgao julgador', 'orgao', 'orgao jurisdicional', 'vara', 'jurisdicao', 'secao', 'subsecao', 'secao subsecao'],
  ],
  [
    'dataAutuacao',
    [
      'data da autuacao',
      'data de autuacao',
      'data autuacao',
      'autuacao',
      'autuado em',
      'data da distribuicao',
      'data de distribuicao',
      'distribuicao',
      'data',
    ],
  ],
  [
    'partes',
    [
      'partes',
      'partes do processo',
      'polo ativo',
      'polo passivo',
      'autor',
      'reu',
      'requerente',
      'requerido',
      'nome da parte',
      'envolvidos',
    ],
  ],
];

/** Papeles procesales del PJe, normalizados, para reconocer etiquetas dentro de una celda. */
const PAPELES = new Set([
  'autor',
  'reu',
  'requerente',
  'requerido',
  'exequente',
  'executado',
  'impetrante',
  'impetrado',
  'apelante',
  'apelado',
  'agravante',
  'agravado',
  'embargante',
  'embargado',
  'recorrente',
  'recorrido',
  'interessado',
  'terceiro interessado',
  'litisconsorte',
  'assistente',
  'ministerio publico federal',
  'ministerio publico',
  'polo ativo',
  'polo passivo',
  'advogado',
  'procurador',
  'perito',
  'vitima',
  'denunciado',
  'querelante',
  'querelado',
  'credor',
  'devedor',
  'inventariante',
  'sucedido',
  'representante',
]);

/**
 * Pistas de que un control descarga o abre un documento, sobre texto ya
 * normalizado (minúsculas, sin tildes, sin puntuación).
 *
 * Cada alternativa va delimitada por `\b`. Sin ella, un fragmento corto como
 * "ata" casa dentro de "formatações" y convierte una entrada de menú de la
 * página de inicio en un documento inexistente.
 */
const RE_PISTA_DOCUMENTO =
  /\b(documentos?|arquivos?|anexos?|pecas?|processual|download|baixar|pdf|inteiro teor|movimenta\w*|certid\w+|peticao|despachos?|decisao|sentencas?|acordaos?|voto|oficio|laudo|comprovante|visualizar)\b/;

/** Rutas que en el PJe sirven un binario en vez de una vista. */
const RE_HREF_DOCUMENTO =
  /(\.pdf|\.p7s|\.zip|\.doc[xm]?|seam\/resource|servlet|download|documento|arquivo|binario|anexo|conteudo)/i;

// ------------------------------------------------------------ normalización

/** Colapsa espacios (incluidos `&nbsp;`) y quita marcas invisibles. */
function normalizar(texto: string): string {
  return texto.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Clave estable de una cabecera: minúsculas, sin tildes, sin puntuación.
 *
 * Se conserva el espacio como separador para que la clave siga siendo
 * reconocible frente a la cabecera visible ("Órgão Julgador" → "orgao julgador")
 * y quien lea el JSON no tenga que deshacer una segunda transformación.
 */
function normalizarClave(texto: string): string {
  return normalizar(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * dd/MM/yyyy → yyyy-MM-dd, con validación de calendario.
 *
 * `new Date('03/04/2025')` devolvería el 4 de marzo, no el 3 de abril: el
 * parseo de cadenas en JavaScript asume el orden estadounidense y lo hace en
 * silencio. La única `Date` que se usa aquí es la de argumentos numéricos en
 * UTC, que no interpreta nada, y solo para descartar un 31/02.
 */
function aIsoFecha(valor: string): string | undefined {
  const iso = RE_FECHA_ISO.exec(valor);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const m = RE_FECHA_BR.exec(valor);
  if (!m) return undefined;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const anio = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return undefined;
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) return undefined;
  return `${String(anio).padStart(4, '0')}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/** Entero brasileño ("1.234") a número. Devuelve undefined si no es un entero seguro. */
function aEntero(bruto: string): number | undefined {
  const limpio = bruto.replace(/[.\s\u00a0]/g, '');
  if (!/^\d+$/.test(limpio)) return undefined;
  const n = Number.parseInt(limpio, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Texto normalizado de un elemento. */
function texto($: cheerio.CheerioAPI, el: Elemento): string {
  return normalizar($(el).text());
}

/**
 * Aplana una celda en líneas lógicas.
 *
 * Los `<br>` y los bloques marcan separación real entre partes; los saltos de
 * línea del propio HTML son indentación y no deben separar nada.
 */
function lineasDeCelda($: cheerio.CheerioAPI, el: Elemento): string[] {
  const $copia = $(el).clone();
  $copia.find('br').replaceWith(SEPARADOR_LINEA);
  $copia.find('div, p, li, tr').each((_, bloque) => {
    $(bloque).append(SEPARADOR_LINEA);
  });
  return $copia
    .text()
    .split(SEPARADOR_LINEA)
    .map(normalizar)
    .filter((linea) => linea.length > 0);
}

// ------------------------------------------------------- selección de tabla

/** Elementos `tr` que son filas de datos de esta tabla (no de una anidada, ni cabecera ni pie). */
function filasDeDatos($: cheerio.CheerioAPI, tabla: Elemento): Elemento[] {
  return $(tabla)
    .find('tr')
    .toArray()
    .filter((fila) => {
      const $fila = $(fila);
      // `find` desciende a tablas anidadas dentro de una celda; solo interesan las propias.
      if ($fila.closest('table').get(0) !== tabla) return false;
      if ($fila.closest('thead').length > 0 || $fila.closest('tfoot').length > 0) return false;
      if ($fila.children('td').length === 0) return false;
      const clase = $fila.attr('class') ?? '';
      return !/rich-table-(header|subheader|footer|subfooter)/.test(clase);
    });
}

/** Número CNJ que aparezca en la fila, mirando celda a celda. */
function numeroEnFila($: cheerio.CheerioAPI, fila: Elemento): string | undefined {
  const m = RE_NUMERO_CNJ_EN_TEXTO.exec(texto($, fila));
  return m ? m[0] : undefined;
}

interface Candidata {
  tabla: Elemento;
  filas: Elemento[];
  /** Filas cuyo contenido incluye un número de proceso. */
  filasConNumero: number;
  /**
   * Filas de las que se puede extraer una clave: con número CNJ **o** con enlace
   * a su ficha (`ca=`). Son las que se pueden guardar y volver a encontrar.
   *
   * Se cuenta aparte de `filasConNumero` porque cada una responde a una pregunta
   * distinta: esta decide si la tabla es utilizable, y aquella cuál de dos tablas
   * utilizables es la buena.
   */
  filasIdentificables: number;
  /** True si la tabla lleva un marcador estructural de RichFaces. */
  estructural: boolean;
}

/**
 * Enlace a la ficha de una fila, cuando lo publica como URL con `ca=`.
 *
 * Se exige el `ca=` y no cualquier enlace: es el marcador de la página de detalle
 * del PJe, y sin él se contaría como identificable cualquier fila con un enlace
 * de menú, lo que llevaría a elegir como tabla de resultados una que no lo es.
 */
function enlaceFichaEnFila($: cheerio.CheerioAPI, fila: Elemento): string | undefined {
  for (const el of $(fila).find('a[href]').toArray()) {
    const href = $(el).attr('href') ?? '';
    if (RE_PARAMETRO_CA.test(href)) return href;
  }
  return undefined;
}

/** Reúne las tablas que podrían ser la lista de resultados, sin decidir todavía. */
function tablasCandidatas($: cheerio.CheerioAPI): Candidata[] {
  const estructurales = new Set<Elemento>();
  for (const selector of SELECTORES_TABLA) {
    for (const t of $(selector).toArray()) estructurales.add(t);
  }
  // Una `rich:dataTable` sin la clase esperada se delata por sus filas o por el
  // `tbody` que JSF nombra con el sufijo `:tb`.
  $('tr.rich-table-row, tbody[id$=":tb"]').each((_, marcador) => {
    // `parents(...).first()` equivale a `closest` para un ancestro que nunca es
    // el propio elemento, y conserva el tipo de elemento en lugar de ensancharlo.
    const tabla = $(marcador).parents('table').first().get(0);
    if (tabla) estructurales.add(tabla);
  });

  const todas = new Set<Elemento>(estructurales);
  for (const t of $('table').toArray()) todas.add(t);

  const candidatas: Candidata[] = [];
  for (const tabla of todas) {
    const filas = filasDeDatos($, tabla);
    if (filas.length === 0) {
      // Sin filas de datos no hay nada que decidir, pero la tabla estructural
      // vacía se conserva: distingue "cero resultados" de "tabla desaparecida".
      if (estructurales.has(tabla)) {
        candidatas.push({ tabla, filas, filasConNumero: 0, filasIdentificables: 0, estructural: true });
      }
      continue;
    }
    const filasConNumero = filas.filter((f) => numeroEnFila($, f) !== undefined).length;
    const filasIdentificables = filas.filter(
      (f) => numeroEnFila($, f) !== undefined || enlaceFichaEnFila($, f) !== undefined,
    ).length;
    candidatas.push({ tabla, filas, filasConNumero, filasIdentificables, estructural: estructurales.has(tabla) });
  }
  return candidatas;
}

/**
 * Elige la tabla de resultados.
 *
 * Una tabla vale si contiene números de proceso. Si no lleva marcador de
 * RichFaces se le exigen además dos filas, porque una tabla de maquetación con
 * un número suelto en una celda no es una lista de resultados.
 */
function elegirTabla(candidatas: Candidata[]): Candidata | undefined {
  // El umbral mira las filas IDENTIFICABLES, no solo las que traen número. Con el
  // criterio anterior, una página entera de expedientes en segredo de justiça
  // —legítima: en la captura real del TRF1 son 8 de cada 30 filas— no se elegía
  // como tabla de resultados y la extracción devolvía cero. El desempate sigue
  // siendo por número, que es la señal más fuerte.
  const validas = candidatas.filter(
    (c) => c.filasIdentificables > 0 && (c.estructural || c.filasIdentificables >= 2),
  );
  if (validas.length === 0) return undefined;
  return validas.reduce((mejor, c) => {
    if (c.filasConNumero !== mejor.filasConNumero) return c.filasConNumero > mejor.filasConNumero ? c : mejor;
    // A igualdad de contenido gana la que sí lleva marcador de RichFaces.
    return c.estructural && !mejor.estructural ? c : mejor;
  });
}

/** Mensajes con los que el portal anuncia una lista vacía. */
function anunciaListaVacia(textoNormalizado: string): boolean {
  return /(nenhum|nao foram? encontrad|sem registros|sin resultados)/.test(normalizarClave(textoNormalizado));
}

// ------------------------------------------------------------- cabeceras

interface Cabecera {
  clave: string;
  etiqueta: string;
  indice: number;
}

/**
 * Lee la fila de cabeceras respetando `colspan`.
 *
 * Se elige la fila con más celdas del `thead`: RichFaces suele poner encima otra
 * fila de una sola celda con el título de la tabla, que no describe columnas.
 */
function leerCabeceras($: cheerio.CheerioAPI, tabla: Elemento): Cabecera[] {
  const candidatas = $(tabla).find('thead tr').toArray();
  const filas = candidatas.length > 0 ? candidatas : $(tabla).find('tr').toArray().filter((f) => $(f).children('th').length > 0);

  let mejor: Elemento | undefined;
  let mejorCeldas = 0;
  for (const fila of filas) {
    if ($(fila).closest('table').get(0) !== tabla) continue;
    const celdas = $(fila).children('th, td').length;
    if (celdas > mejorCeldas) {
      mejor = fila;
      mejorCeldas = celdas;
    }
  }
  if (!mejor || mejorCeldas < 2) return [];

  const cabeceras: Cabecera[] = [];
  let indice = 0;
  $(mejor)
    .children('th, td')
    .each((_, celda) => {
      const etiqueta = normalizar($(celda).text());
      const clave = normalizarClave(etiqueta);
      if (clave) cabeceras.push({ clave, etiqueta, indice });
      const colspan = Number.parseInt($(celda).attr('colspan') ?? '1', 10);
      indice += Number.isFinite(colspan) && colspan > 0 ? colspan : 1;
    });
  return cabeceras;
}

/** Campo cuyo listado de sinónimos contiene exactamente esta clave. */
function campoExacto(clave: string): CampoConocido | undefined {
  for (const [campo, claves] of SINONIMOS) {
    if (claves.includes(clave)) return campo;
  }
  return undefined;
}

/**
 * Campo cuyo sinónimo aparece dentro de la clave ("data da autuacao do feito").
 * Se exigen cinco caracteres para que un sinónimo corto como "data" no capture
 * "data da ultima movimentacao" antes de que la pasada exacta haya hablado.
 */
function campoPorInclusion(clave: string): CampoConocido | undefined {
  for (const [campo, claves] of SINONIMOS) {
    if (claves.some((k) => k.length >= 5 && clave.includes(k))) return campo;
  }
  return undefined;
}

/** Qué significa cada columna de la tabla elegida. */
interface PlanColumnas {
  numero: number;
  clase?: number;
  orgao?: number;
  /** La fecha guarda también su clave: si no se puede interpretar, se conserva cruda bajo ella. */
  data?: { indice: number; clave: string };
  partes: Array<{ indice: number; papel?: string }>;
  extras: Array<{ indice: number; clave: string }>;
}

/**
 * Columna que realmente contiene los números de proceso, por recuento.
 *
 * Es la única verdad verificable sobre la tabla, así que se usa para corregir el
 * mapeo por cabecera cuando una columna llamada "Número" resulta ser un ordinal
 * y el número CNJ vive en otra. Devuelve -1 si ninguna columna lo contiene.
 */
function columnaAncla($: cheerio.CheerioAPI, filas: Elemento[]): number {
  const aciertos = new Map<number, number>();
  for (const fila of filas) {
    $(fila)
      .children('td, th')
      .each((i, celda) => {
        if (RE_NUMERO_CNJ_EN_TEXTO.test(texto($, celda))) aciertos.set(i, (aciertos.get(i) ?? 0) + 1);
      });
  }
  let mejor = -1;
  let mejorCuenta = 0;
  for (const [indice, cuenta] of aciertos) {
    if (cuenta > mejorCuenta) {
      mejor = indice;
      mejorCuenta = cuenta;
    }
  }
  return mejor;
}

/**
 * Celdas de la fila de datos más ancha.
 *
 * Es el número de columnas que hay que cubrir de verdad: las filas de un
 * `rich:dataTable` pueden llevar una celda de menos cuando el portal omite un
 * valor, y quedarse con la primera fila dejaría columnas fuera del plan.
 */
function anchoDeCuerpo($: cheerio.CheerioAPI, filas: Elemento[]): number {
  let ancho = 0;
  for (const fila of filas) {
    const celdas = $(fila).children('td, th').length;
    if (celdas > ancho) ancho = celdas;
  }
  return ancho;
}

/**
 * Construye el plan a partir de las cabeceras, con el ancla como árbitro.
 *
 * Devuelve undefined cuando ni las cabeceras ni el contenido señalan la columna
 * del número de proceso: sin ancla el plan no es de fiar y se prefiere el modo
 * posicional, que al menos comprueba la forma antes de rendirse.
 *
 * `anchoCuerpo` es el número real de celdas de las filas de datos. Sirve de
 * aserción de forma: las cabeceras se indexan contando `colspan` y las celdas de
 * datos por posición, así que ambos recuentos solo coinciden mientras ninguna
 * cabecera abarque dos columnas. Lo que quede sin cubrir se emite igualmente.
 */
function planPorCabecera(cabeceras: Cabecera[], ancla: number, anchoCuerpo: number): PlanColumnas | undefined {
  if (cabeceras.length === 0) return undefined;

  const asignados = new Map<number, CampoConocido>();
  const tomados = new Set<CampoConocido>();

  const asignar = (cab: Cabecera, campo: CampoConocido): void => {
    // `partes` admite varias columnas (polo activo y polo pasivo); el resto, una.
    if (campo !== 'partes' && tomados.has(campo)) return;
    asignados.set(cab.indice, campo);
    tomados.add(campo);
  };

  for (const cab of cabeceras) {
    const campo = campoExacto(cab.clave);
    if (campo) asignar(cab, campo);
  }
  for (const cab of cabeceras) {
    if (asignados.has(cab.indice)) continue;
    const campo = campoPorInclusion(cab.clave);
    if (campo) asignar(cab, campo);
  }

  const porCabecera = [...asignados.entries()].find(([, campo]) => campo === 'numeroProcesso')?.[0];
  const numero = ancla >= 0 ? ancla : porCabecera;
  if (numero === undefined) return undefined;

  const plan: PlanColumnas = { numero, partes: [], extras: [] };
  const clavesUsadas = new Set<string>();

  for (const cab of cabeceras) {
    if (cab.indice === numero) continue;
    const campo = asignados.get(cab.indice);
    if (campo === 'classeJudicial') {
      plan.clase = cab.indice;
      continue;
    }
    if (campo === 'orgaoJulgador') {
      plan.orgao = cab.indice;
      continue;
    }
    if (campo === 'dataAutuacao') {
      plan.data = { indice: cab.indice, clave: cab.clave };
      continue;
    }
    if (campo === 'partes') {
      // La cabecera de una columna de partes suele ser ya el papel procesal.
      const papel = PAPELES.has(cab.clave) ? cab.etiqueta : undefined;
      plan.partes.push({ indice: cab.indice, papel });
      continue;
    }
    // Columna que no se sabe mapear (incluida la que la cabecera llamaba "número"
    // y el contenido desmintió): se conserva con su cabecera como clave.
    let clave = cab.clave;
    for (let n = 2; clavesUsadas.has(clave); n++) clave = `${cab.clave} ${n}`;
    clavesUsadas.add(clave);
    plan.extras.push({ indice: cab.indice, clave });
  }

  // Columnas de datos que ninguna cabecera describe: la celda de cabecera venía
  // vacía (`leerCabeceras` la descarta), o un `colspan` desplazó la numeración.
  // Sin esto su contenido no aparecería en ninguna parte del registro y la
  // pérdida sería invisible, que es justo lo que el mapeo por cabecera pretendía
  // evitar. Se nombran por su ordinal, que no promete un significado no verificado.
  const descritas = new Set(cabeceras.map((cab) => cab.indice));
  for (let i = 0; i < anchoCuerpo; i++) {
    if (i === numero || descritas.has(i)) continue;
    const base = `columna ${i + 1}`;
    let clave = base;
    for (let n = 2; clavesUsadas.has(clave); n++) clave = `${base} ${n}`;
    clavesUsadas.add(clave);
    plan.extras.push({ indice: i, clave });
  }

  return plan;
}

/**
 * Plan degradado sin cabeceras utilizables: solo se tipa el número de proceso.
 *
 * Deducir qué significa cada columna por su posición es precisamente lo que
 * produce registros basura cuando el portal inserta una columna, así que el
 * resto viaja íntegro a `camposExtra` bajo un nombre que dice la verdad
 * ("columna 3"), en lugar de prometer un campo que no se ha verificado.
 *
 * Antes de eso comprueba la forma: un mínimo de columnas y una celda que case
 * *exacta* con el formato CNJ. En modo degradado no se acepta un número
 * decorado: sin cabeceras que confirmen nada, una coincidencia parcial no basta
 * para creerse la tabla entera.
 */
function planPosicional($: cheerio.CheerioAPI, filas: Elemento[], cabeceras: Cabecera[]): PlanColumnas {
  const primera = filas[0];
  const celdas = primera === undefined ? [] : $(primera).children('td, th').toArray();
  const textos = celdas.map((c) => texto($, c));

  if (celdas.length < COLUMNAS_MINIMAS) {
    throw new EstructuraInesperadaError(
      `La tabla de resultados no expone cabeceras utilizables y su primera fila de datos tiene ${celdas.length} ` +
        `columna(s), cuando se esperaban al menos ${COLUMNAS_MINIMAS}. Contenido leído: ${describir(textos)}`,
    );
  }

  const numero = textos.findIndex((t) => RE_NUMERO_CNJ.test(t.replace(/\s/g, '')));
  if (numero === -1) {
    throw new EstructuraInesperadaError(
      'La tabla de resultados no expone cabeceras utilizables y ninguna de sus columnas casa con el formato CNJ ' +
        '(NNNNNNN-DD.AAAA.J.TR.OOOO). Cambió el formato del número, la columna trae ahora texto añadido o la ' +
        `tabla ya no es la de resultados. Contenido leído: ${describir(textos)}`,
    );
  }

  // Si había cabeceras (aunque no identificaran el número), sus etiquetas siguen
  // siendo mejor clave que un ordinal: se aprovechan para no perder el nombre.
  const etiquetas = new Map(cabeceras.map((c) => [c.indice, c.clave]));
  const plan: PlanColumnas = { numero, partes: [], extras: [] };
  const clavesUsadas = new Set<string>();
  for (let i = 0; i < celdas.length; i++) {
    if (i === numero) continue;
    const base = etiquetas.get(i) ?? `columna ${i + 1}`;
    let clave = base;
    for (let n = 2; clavesUsadas.has(clave); n++) clave = `${base} ${n}`;
    clavesUsadas.add(clave);
    plan.extras.push({ indice: i, clave });
  }
  return plan;
}

/** Resumen acotado de una fila para que el mensaje de error sea accionable sin volcar la página. */
function describir(textos: string[]): string {
  return textos.map((t) => `"${t.slice(0, 40)}"`).join(', ') || '(sin celdas)';
}

// ---------------------------------------------------------------- partes

/**
 * Separa el papel procesal del nombre.
 *
 * Solo se acepta como papel una etiqueta que esté en la lista de papeles del
 * PJe: una heurística del tipo "lo que va antes de los dos puntos" convertiría
 * "FULANO DE TAL - CPF: 000" en un papel inventado.
 */
function partirParte(linea: string, papelPorDefecto?: string): Parte | undefined {
  const conEtiquetaDelante = /^(.{2,40}?)\s*[:\u2013\u2014-]\s*(.+)$/.exec(linea);
  if (conEtiquetaDelante) {
    const posiblePapel = normalizarClave(conEtiquetaDelante[1]);
    if (PAPELES.has(posiblePapel)) {
      const nombre = normalizar(conEtiquetaDelante[2]);
      return nombre ? { papel: normalizar(conEtiquetaDelante[1]), nombre } : undefined;
    }
  }

  const conEtiquetaDetras = /^(.+?)\s*[(\[]\s*(.{2,40}?)\s*[)\]]\s*$/.exec(linea);
  if (conEtiquetaDetras) {
    const posiblePapel = normalizarClave(conEtiquetaDetras[2]);
    if (PAPELES.has(posiblePapel)) {
      const nombre = normalizar(conEtiquetaDetras[1]);
      return nombre ? { papel: normalizar(conEtiquetaDetras[2]), nombre } : undefined;
    }
  }

  const nombre = normalizar(linea);
  if (!nombre || nombre.length < 2 || !/[a-zA-ZÀ-ÿ]/.test(nombre)) return undefined;
  return papelPorDefecto ? { papel: papelPorDefecto, nombre } : { nombre };
}

/** Partes de una celda, deduplicadas por papel + nombre. */
function extraerPartes($: cheerio.CheerioAPI, celda: Elemento, papelPorDefecto?: string): Parte[] {
  const partes: Parte[] = [];
  const vistas = new Set<string>();
  for (const linea of lineasDeCelda($, celda)) {
    const parte = partirParte(linea, papelPorDefecto);
    if (!parte) continue;
    const clave = `${parte.papel ?? ''}\u0000${parte.nombre}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    partes.push(parte);
  }
  return partes;
}

// -------------------------------------------------------------- procesos

/** Construye un registro a partir de una fila y del plan de columnas. */
function construirProceso(
  $: cheerio.CheerioAPI,
  fila: Elemento,
  plan: PlanColumnas,
  pagina: number,
): ProcesoJudicial | undefined {
  const celdas = $(fila).children('td, th').toArray();
  const celdaDe = (indice: number | undefined): Elemento | undefined =>
    indice === undefined ? undefined : celdas[indice];

  const celdaNumero = celdaDe(plan.numero);
  // La columna mapeada manda, pero si el portal movió el número se busca en toda
  // la fila antes de descartarla: perder una fila es peor que leerla de otra celda.
  const bruto = celdaNumero ? texto($, celdaNumero) : '';
  const m = RE_NUMERO_CNJ_EN_TEXTO.exec(bruto) ?? RE_NUMERO_CNJ_EN_TEXTO.exec(texto($, fila));

  // Se mantiene como cadena: el número CNJ tiene ceros a la izquierda que
  // cualquier conversión numérica destruiría.
  const numero = m ? m[0] : undefined;

  // Cómo abrir la ficha de este proceso. Se lee AQUÍ y no en la Fase 2 porque el
  // control vive en la fila, y la fila solo existe mientras esta página está en
  // el documento vigente. Si la fila no lo publica de forma inequívoca, el campo
  // se omite (contrato de types.ts) y la Fase 2 lo registra como fallo.
  const apertura = aperturaDeFila($, fila, numero);

  /**
   * Clave del registro.
   *
   * Con número, ES el número. Sin él —segredo de justiça— se deriva del `ca=` del
   * enlace a la ficha, igual que ya hacía `parserModerno.ts`.
   *
   * ANTES ESTA FILA SE DESCARTABA. Es la variante del objetivo del enunciado, y
   * en la única captura real comparable (TRF1) los expedientes sin número son 8
   * de cada 30: se tiraba el 27 % de cada página, en silencio, contra un
   * enunciado que pide extraer toda la información disponible. Lo que NUNCA se
   * hace es escribir la clave derivada en `numeroProcesso`: la clave es un índice
   * de este scraper y el número es un dato del tribunal.
   */
  const ca = RE_PARAMETRO_CA.exec(enlaceFichaEnFila($, fila) ?? '')?.[1];
  const clave = numero ?? (ca === undefined ? undefined : `${PREFIJO_SIGILO}${ca}`);
  // Sin número y sin enlace no hay clave posible: el registro no se podría
  // deduplicar ni volver a encontrar, así que guardarlo produciría duplicados en
  // cada pasada. El llamante avisa de cuántas filas cayeron por aquí.
  if (clave === undefined) return undefined;

  const proceso: ProcesoJudicial = { claveUnica: clave };
  if (numero !== undefined) proceso.numeroProcesso = numero;
  else proceso.enSigilo = true;

  if (apertura) proceso.apertura = apertura;

  const clase = celdaDe(plan.clase);
  if (clase) {
    const valor = texto($, clase);
    if (valor) proceso.classeJudicial = valor;
  }

  const orgao = celdaDe(plan.orgao);
  if (orgao) {
    const valor = texto($, orgao);
    if (valor) proceso.orgaoJulgador = valor;
  }

  const camposExtra: Record<string, string> = {};

  if (plan.data) {
    const celdaData = celdaDe(plan.data.indice);
    const valor = celdaData ? texto($, celdaData) : '';
    const iso = aIsoFecha(valor);
    if (iso) proceso.dataAutuacao = iso;
    // Una fecha que no se sabe interpretar no se tira ni se inventa: se conserva
    // cruda bajo su propia cabecera, que es donde el lector la irá a buscar.
    else if (valor) camposExtra[plan.data.clave] = valor;
  }

  const partes: Parte[] = [];
  for (const columna of plan.partes) {
    const celda = celdaDe(columna.indice);
    if (celda) partes.push(...extraerPartes($, celda, columna.papel));
  }
  if (partes.length > 0) proceso.partes = partes;

  for (const extra of plan.extras) {
    const celda = celdaDe(extra.indice);
    if (!celda) continue;
    const valor = texto($, celda);
    if (valor) camposExtra[extra.clave] = valor;
  }
  if (Object.keys(camposExtra).length > 0) proceso.camposExtra = camposExtra;

  // La página solo se anota si es un ordinal creíble; un 0 o un NaN mentirían.
  if (Number.isInteger(pagina) && pagina > 0) proceso.paginaOrigen = pagina;

  return proceso;
}

/**
 * Extrae los procesos de la lista de resultados del documento vigente.
 *
 * Devuelve `[]` cuando la página no tiene lista (la de inicio, o una búsqueda
 * sin resultados). Lanza `EstructuraInesperadaError` cuando sí hay una tabla de
 * resultados pero ya no se reconoce su contenido.
 */
export function parsearProcesos($: cheerio.CheerioAPI, pagina: number): ProcesoJudicial[] {
  // La variante se decide por EVIDENCIA en el documento, no por configuración ni
  // por lo que dijera la sesión al abrirse: una respuesta A4J puede traer la
  // tabla de resultados sin el formulario que la identificaba.
  //
  // Por qué no basta con el camino genérico de este módulo: sobre el fixture
  // real `pje-nuevo-resultados.html` sí encuentra las 30 filas y sus números,
  // pero la celda «Processo» de la plantilla moderna es COMPUESTA (clase
  // judicial + sigla + número + asunto + los dos polos en un solo bloque de
  // texto), así que devuelve registros sin `classeJudicial`, sin `partes` y —lo
  // que de verdad importa— sin `apertura`. Sin `apertura`, la Fase 2 marca
  // fallido cada proceso sin haber pedido nada. El parser específico saca los
  // cinco datos y el enlace a la ficha.
  if ($(SELECTOR_TABLA_MODERNA).length > 0) return parsearProcesosModerno($, pagina);

  const candidatas = tablasCandidatas($);
  const elegida = elegirTabla(candidatas);

  if (!elegida) {
    // Una tabla de RichFaces con filas pero sin un solo número de proceso es la
    // señal de que la estructura cambió; sin ella, simplemente no hay lista.
    // El criterio es «ni número NI enlace», no «ni número» a secas. Una página
    // entera de expedientes en segredo de justiça es legítima —no publican número
    // pero sí su ficha—, y con el criterio anterior abortaba la extracción
    // tomándola por una tabla rota.
    const sospechosa = candidatas.find((c) => c.estructural && c.filas.length >= 2 && c.filasIdentificables === 0);
    if (sospechosa && !anunciaListaVacia(texto($, sospechosa.tabla))) {
      const primera = sospechosa.filas[0];
      const muestra = primera === undefined ? [] : $(primera).children('td, th').toArray().map((c) => texto($, c));
      throw new EstructuraInesperadaError(
        `Hay una tabla de RichFaces con ${sospechosa.filas.length} filas pero ninguna publica ni un número de ` +
          'proceso con formato CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO) ni un enlace a su ficha: cambió el formato del ' +
          `número o la tabla ya no es la de resultados. Primera fila: ${describir(muestra)}`,
      );
    }
    return [];
  }

  const cabeceras = leerCabeceras($, elegida.tabla);
  const ancla = columnaAncla($, elegida.filas);
  const plan =
    planPorCabecera(cabeceras, ancla, anchoDeCuerpo($, elegida.filas)) ??
    planPosicional($, elegida.filas, cabeceras);

  const procesos: ProcesoJudicial[] = [];
  const vistos = new Set<string>();
  let descartadas = 0;
  for (const fila of elegida.filas) {
    const proceso = construirProceso($, fila, plan, pagina);
    if (!proceso) {
      // Con aviso, no en silencio: descartar una fila es perder un dato que el
      // enunciado pide extraer, y tiene que verse en la salida normal.
      descartadas++;
      continue;
    }
    // RichFaces duplica filas al fijar cabeceras. En esta variante `claveUnica`
    // es el propio número CNJ, que es la clave que asigna el tribunal.
    if (vistos.has(proceso.claveUnica)) continue;
    vistos.add(proceso.claveUnica);
    procesos.push(proceso);
  }
  if (descartadas > 0) {
    log.warn(
      `Página ${pagina}: ${descartadas} fila(s) sin número CNJ ni enlace a su ficha, descartadas por no ` +
        'tener ninguna clave con la que guardarlas',
    );
  }
  return procesos;
}

// ------------------------------------------------------------------ total

/**
 * Total de resultados que anuncia el portal, o undefined si no lo anuncia.
 *
 * Nunca se deduce del paginador un número que no sea un total explícito: los
 * botones de un `rich:datascroller` numeran páginas, no registros, y devolver
 * "10" como total de resultados sería inventar un dato que luego decide cuándo
 * parar la extracción.
 */
export function detectarTotalResultados($: cheerio.CheerioAPI): number | undefined {
  // La plantilla moderna publica el total en un rótulo propio del pie de la
  // tabla ("106073 resultados encontrados"). Se pregunta primero al lector que
  // conoce ese rótulo; si no lo encuentra se sigue con el barrido genérico, que
  // es un respaldo y no una contradicción: ambos exigen una frase explícita de
  // total y ninguno deduce nada del paginador.
  if ($(SELECTOR_TABLA_MODERNA).length > 0) {
    const moderno = detectarTotalModerno($);
    if (moderno !== undefined) return moderno;
  }

  // "1 a 20 de 345": rango de registros. Los espacios son opcionales porque el
  // texto de las celdas del paginador llega concatenado ("1a20de345").
  const RE_RANGO = /(?:^|\D)[\d.]*\d\s*(?:a|-|até|ate)\s*[\d.]*\d\s*de\s*([\d.]*\d)(?!\d)/i;

  // El paginador es la fuente más fiable cuando dice un rango, así que se mira
  // primero. Un "N de M" suelto NO se lee: en un `rich:datascroller` eso es el
  // contador de páginas, y devolverlo como total de resultados sería inventar
  // el número que luego decide cuándo parar la extracción.
  for (const selector of SELECTORES_PAGINADOR) {
    for (const el of $(selector).toArray()) {
      const m = RE_RANGO.exec(texto($, el));
      const valor = m ? aEntero(m[1]) : undefined;
      if (valor !== undefined) return valor;
    }
  }

  const cuerpo = normalizar($('body').length > 0 ? $('body').text() : $.root().text());
  const patrones: RegExp[] = [
    // "Total de registros: 345"
    /total\s+de\s+(?:registros?|resultados?|processos?)\s*:?\s*([\d.]*\d)/i,
    RE_RANGO,
    // "345 resultados encontrados" / "345 registros". El lookahead descarta
    // "20 processos por página", que anuncia el tamaño de página, no el total.
    /\b([\d.]*\d)\s+(?:resultados?|registros?|processos?)\b(?:\s+(?:encontrad[oa]s?|localizad[oa]s?))?(?!\s+(?:por|em)\b)/i,
  ];

  for (const patron of patrones) {
    const m = patron.exec(cuerpo);
    const valor = m ? aEntero(m[1]) : undefined;
    if (valor !== undefined) return valor;
  }
  return undefined;
}

// -------------------------------------------------------------- documentos

/** Bloque delimitado ya recortado, con la posición desde la que seguir buscando. */
interface Bloque {
  /** Contenido entre los delimitadores, sin incluirlos. */
  cuerpo: string;
  /** Índice inmediatamente posterior al delimitador de cierre. */
  fin: number;
}

/**
 * Recorta el bloque delimitado que empieza en el primer `apertura` desde `desde`.
 *
 * Cuenta profundidad y respeta las comillas. Una expresión regular `\{.*?\}`
 * fallaría con el primer valor que lleve una llave, y el portal los produce: en
 * `01-inicio.html` un `onclick` real trae
 * `'oncomplete':function(request,event,data){Richfaces.showModalPanel('captchaPanel')}`
 * delante del objeto `parameters`.
 *
 * Devuelve también `fin` porque quien recorre una lista de bloques necesita un
 * avance que no dependa de volver a buscar el contenido: un bloque vacío (`{}`)
 * se localizaría en la misma posición una y otra vez.
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
 * Extrae los pares `clave: 'valor'` de un literal de objeto ya recortado.
 *
 * El patrón está anclado en ambos extremos de cada par (clave entrecomillada o
 * desnuda, valor siempre entrecomillado), así que ignora por construcción los
 * valores que no son cadenas: `'control':this` o una función de `oncomplete`.
 * La expresión se crea por llamada para no compartir `lastIndex` entre usos.
 */
function paresDeObjeto(cuerpo: string): Record<string, string> {
  const re = /(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|([A-Za-z_$][\w$]*))\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;
  const pares: Record<string, string> = {};
  let m = re.exec(cuerpo);
  while (m) {
    const clave = m.at(1) ?? m.at(2) ?? m.at(3);
    const valor = m.at(4) ?? m.at(5);
    if (clave !== undefined && valor !== undefined) pares[clave] = valor;
    m = re.exec(cuerpo);
  }
  return pares;
}

/** Lee `A4J.AJAX.Submit('formId', event, {…, 'parameters':{…}})`. */
function postbackA4J(script: string, formPorDefecto?: string): DescargaPostback | undefined {
  const llamada = script.indexOf('A4J.AJAX.Submit');
  if (llamada === -1) return undefined;

  const argumentos = /A4J\.AJAX\.Submit\(\s*'([^']*)'/.exec(script.slice(llamada));
  const formId = argumentos?.at(1) ?? formPorDefecto;
  if (!formId) return undefined;

  const marca = script.indexOf("'parameters'", llamada);
  const bloque = marca === -1 ? undefined : recortarBloque(script, marca + "'parameters'".length, '{', '}');
  const parametros = bloque ? paresDeObjeto(bloque.cuerpo) : {};

  // RichFaces pone el id del componente en `similarityGroupingId`; si falta, el
  // control es el parámetro que se apunta a sí mismo, que es como JSF marca el
  // botón pulsado.
  const similar = /'similarityGroupingId'\s*:\s*'([^']*)'/.exec(script)?.at(1);
  const autoreferente = Object.entries(parametros).find(([k, v]) => k === v && k.startsWith(`${formId}:`));
  const control = similar ?? autoreferente?.[0];
  if (!control) return undefined;

  // `construirCuerpoA4J` ya emite `control=control`; repetirlo aquí lo enviaría dos veces.
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
 * Lee `PrimeFaces.ab({s:'form:btn', f:'form', pa:[{name:'x',value:'y'}]})`.
 *
 * El TRF5 es RichFaces 3.3, así que esta rama no se ejerce hoy; existe porque
 * las instancias del PJe 2.x sirven la misma consulta pública sobre PrimeFaces
 * y el coste de reconocerla es una función.
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

  // Los parámetros de usuario viajan en `pa:[{name,value},…]`, no en el objeto raíz.
  const marcaPa = /(?:^|[,{\s])(?:'pa'|"pa"|pa)\s*:\s*\[/.exec(raiz.cuerpo);
  if (marcaPa && marcaPa.index !== undefined) {
    const lista = recortarBloque(raiz.cuerpo, marcaPa.index, '[', ']');
    const parametros: Record<string, string> = {};
    if (lista) {
      // El recorrido avanza con el `fin` que devuelve cada bloque, nunca buscando
      // de nuevo su contenido: una entrada vacía (`{}`) tiene cuerpo vacío y
      // `indexOf('')` devolvería la misma posición para siempre.
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

/**
 * Lo que un control publica sobre cómo alcanzar su destino, sin juzgar aún qué es.
 *
 * Separar «cómo se activa este control» de «qué significa» permite que la ficha
 * de un proceso y la descarga de un documento compartan la lectura del `onclick`
 * y del `href`, que es la parte delicada, y difieran solo en el criterio.
 */
interface ControlLeido {
  postback?: DescargaPostback;
  /** `href` normalizado, solo si es una URL de verdad (ni `javascript:` ni `#`). */
  url?: string;
}

function leerControl($: cheerio.CheerioAPI, el: Elemento): ControlLeido {
  const $el = $(el);
  const hrefBruto = $el.attr('href');
  const href = hrefBruto === undefined ? undefined : normalizar(hrefBruto);
  const enlaceEsScript = href !== undefined && /^javascript:/i.test(href);
  const script = `${$el.attr('onclick') ?? ''} ${enlaceEsScript ? href : ''}`;
  const formPorDefecto = $el.closest('form').attr('id');

  const postback = postbackA4J(script, formPorDefecto) ?? postbackPrimeFaces(script, formPorDefecto);
  // Se conserva el href tal cual: lleva el `;jsessionid=` que el portal incrusta
  // por reescritura de URL, y reconstruirlo lo perdería.
  const url = href !== undefined && !enlaceEsScript && href !== '#' ? href : undefined;

  return { ...(postback ? { postback } : {}), ...(url ? { url } : {}) };
}

/**
 * Control que abre la ficha del proceso desde su fila de la lista.
 *
 * NO está verificado contra el portal (`docs/protocol.md` deja la forma de la
 * fila como PENDIENTE), así que el criterio es deliberadamente estrecho y solo
 * acepta lo que se puede afirmar mirando la fila:
 *
 *  1. El control cuyo texto visible es el propio número del proceso. Es la única
 *     señal autoverificable: ese enlace no puede ser otra cosa que el expediente.
 *  2. Si no lo hay, el control **único** de la fila. Con uno solo no hay
 *     ambigüedad que resolver adivinando.
 *
 * Con dos o más controles y ninguno rotulado con el número se devuelve
 * `undefined`: elegir por corazonada produciría un `apertura` que descarga el
 * icono equivocado, y prefiero que la Fase 2 registre «no sé abrir esta ficha»
 * a que invente una navegación.
 */
function aperturaDeFila(
  $: cheerio.CheerioAPI,
  fila: Elemento,
  // Opcional porque los expedientes en segredo de justiça no publican número. Sin
  // él se pierde la señal autoverificable —el control rotulado con el propio
  // número—, así que solo queda la regla conservadora: aceptar el control si es
  // el único de la fila, y no adivinar si hay varios.
  numero: string | undefined,
): DescargaDirecta | DescargaPostback | undefined {
  const utiles = $(fila)
    .find('a[href], a[onclick], [onclick]')
    .toArray()
    .map((el) => ({ el, control: leerControl($, el) }))
    .filter(({ control }) => control.postback !== undefined || control.url !== undefined);

  if (utiles.length === 0) return undefined;

  const porNumero =
    numero === undefined ? undefined : utiles.find(({ el }) => normalizar($(el).text()).includes(numero));
  const elegido = porNumero ?? (utiles.length === 1 ? utiles[0] : undefined);
  if (!elegido) return undefined;

  if (elegido.control.postback) return elegido.control.postback;
  return elegido.control.url ? { tipo: 'url', url: elegido.control.url } : undefined;
}

/** Identificador del documento que viaje en la URL o en los parámetros del postback. */
function identificarDocumento(href: string | undefined, parametros: Record<string, string>): string | undefined {
  if (href) {
    const m = /[?&;](?:idDocumento|idProcessoDocumento|idBin|idArquivo|nomeArq|idDoc|id)=([^&#;]+)/i.exec(href);
    const bruto = m?.at(1);
    if (bruto) {
      try {
        const valor = normalizar(decodeURIComponent(bruto));
        if (valor) return valor;
      } catch {
        // Un porcentaje suelto en la URL no debe tumbar el parseo del documento.
        const valor = normalizar(bruto);
        if (valor) return valor;
      }
    }
  }
  for (const [clave, valor] of Object.entries(parametros)) {
    const k = normalizarClave(clave);
    if (/^(id )?(documento|bin|arquivo|processo documento)/.test(k) || /(iddocumento|idbin|idarquivo)/.test(k.replace(/ /g, ''))) {
      const limpio = normalizar(valor);
      if (limpio) return limpio;
    }
  }
  return undefined;
}

/** Primer texto no vacío que sirva de título del documento. */
function tituloDocumento($: cheerio.CheerioAPI, el: Elemento, href: string | undefined, id: string | undefined): string | undefined {
  const $el = $(el);
  const candidatos = [
    normalizar($el.text()),
    normalizar($el.attr('title') ?? ''),
    normalizar($el.attr('aria-label') ?? ''),
    normalizar($el.find('img').first().attr('alt') ?? ''),
    normalizar($el.attr('value') ?? ''),
  ];
  for (const c of candidatos) {
    if (c) return c;
  }

  // Un icono sin texto: el nombre lo pone la fila que lo contiene.
  const $fila = $el.closest('tr');
  if ($fila.length > 0) {
    for (const celda of $fila.children('td, th').toArray()) {
      const valor = texto($, celda);
      if (valor && !RE_FECHA_BR.test(valor) && valor.length > 2) return valor;
    }
  }

  if (href) {
    const ruta = href.split(/[?#;]/)[0];
    let legible = ruta;
    try {
      legible = decodeURI(ruta);
    } catch {
      // Un porcentaje suelto en la URL no debe impedir nombrar el documento.
    }
    const base = normalizar(legible.split('/').filter(Boolean).pop() ?? '');
    if (base) return base;
  }
  return id;
}

/** Fecha visible del documento: la primera de su fila o de su bloque contenedor. */
function fechaDocumento($: cheerio.CheerioAPI, el: Elemento): string | undefined {
  const $el = $(el);
  const propio = aIsoFecha(normalizar($el.text()));
  if (propio) return propio;
  const $contenedor = $el.closest('tr').length > 0 ? $el.closest('tr') : $el.parent();
  return $contenedor.length > 0 ? aIsoFecha(normalizar($contenedor.text())) : undefined;
}

/** ¿Este control tiene pinta de abrir o descargar un documento? */
function pareceDocumento($: cheerio.CheerioAPI, el: Elemento, parametros: Record<string, string>): boolean {
  const $el = $(el);
  const pistas = [
    $el.text(),
    $el.attr('title') ?? '',
    $el.attr('aria-label') ?? '',
    $el.attr('id') ?? '',
    $el.attr('name') ?? '',
    $el.attr('class') ?? '',
    $el.find('img').first().attr('alt') ?? '',
    $el.find('img').first().attr('src') ?? '',
    Object.keys(parametros).join(' '),
  ];
  return RE_PISTA_DOCUMENTO.test(normalizarClave(pistas.join(' ')));
}

/**
 * Extrae los documentos de la ficha de un proceso.
 *
 * Cada enlace se clasifica en descarga directa (hay una URL real a un servlet o
 * a un binario) o postback (el enlace es JavaScript y hay que reproducir el POST
 * JSF). Los controles que no encajan en ninguna de las dos no se emiten: un
 * documento del que no se sabe cómo obtener el archivo no es un documento, es
 * ruido de la barra de menús.
 *
 * La ficha del proceso no está capturada en `output/raw` (el reconocimiento se
 * detuvo en la búsqueda), así que la detección es deliberadamente conservadora y
 * se apoya en las formas que sí están verificadas en `01-inicio.html`.
 */
export function parsearDocumentos($: cheerio.CheerioAPI): DocumentoProceso[] {
  const documentos: DocumentoProceso[] = [];
  const vistos = new Set<string>();

  for (const el of $('a[href], a[onclick], button[onclick], input[onclick], [onclick]').toArray()) {
    const { postback, url } = leerControl($, el);

    let descarga: DescargaDirecta | DescargaPostback | undefined;
    let parametros: Record<string, string> = {};

    if (postback) {
      parametros = postback.parametros ?? {};
      if (!pareceDocumento($, el, parametros)) continue;
      descarga = postback;
    } else if (url && RE_HREF_DOCUMENTO.test(url)) {
      descarga = { tipo: 'url', url };
    }
    if (!descarga) continue;

    const id = identificarDocumento(descarga.tipo === 'url' ? descarga.url : undefined, parametros);
    const titulo = tituloDocumento($, el, descarga.tipo === 'url' ? descarga.url : undefined, id);
    if (!titulo) continue; // sin ninguna identidad legible, no hay nada que registrar

    const clave =
      descarga.tipo === 'url'
        ? `url\u0000${descarga.url}`
        : `post\u0000${descarga.formId}\u0000${descarga.control}\u0000${JSON.stringify(descarga.parametros ?? {})}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    const documento: DocumentoProceso = { titulo, descarga };
    if (id) documento.id = id;
    const fecha = fechaDocumento($, el);
    if (fecha) documento.fecha = fecha;
    documentos.push(documento);
  }

  return documentos;
}
