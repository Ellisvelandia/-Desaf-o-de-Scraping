/**
 * Parser de la tabla de resultados de la plantilla MODERNA del PJe (variante 'fpp').
 *
 * Esta tabla no se parece a la del portal antiguo y por eso no la lee
 * `parser.ts`: no hay una columna por dato, hay tres columnas y la del medio es
 * una celda compuesta que mezcla clase judicial, sigla, número, asunto y las dos
 * partes en un único bloque de texto con un enlace en medio.
 *
 *   td[0] → enlace "Ver detalhes do processo" (openPopUp con la URL de la ficha)
 *   td[1] → CLASE JUDICIAL <a><b>SIGLA NNNNNNN-NN.AAAA.N.NN.NNNN - Assunto</b></a> POLO ATIVO X POLO PASSIVO
 *   td[2] → Nome do movimento (dd/MM/yyyy HH:mm:ss)
 *
 * DOS TRAMPAS QUE CONDICIONAN TODO EL FICHERO:
 *
 *  1. Los sufijos `j_idNNN` de los ids cambian de instancia a instancia (la
 *     misma celda es `j_id257` en TRF5 y `j_id259` en TRF1) y el rowKey del id
 *     de celda no es secuencial (`…:processosTable:583:…`). Cualquier id
 *     literal convertiría el parser en específico de un tribunal, así que aquí
 *     todo se localiza por sufijo de id y por posición dentro de la fila.
 *
 *  2. Hay filas SIN número de proceso (las de sigilo: el `<b>` dice solo
 *     "PJEC - Assunto"). Se descartan en silencio verificable —con una línea de
 *     debug— porque `numeroProcesso` es la clave de deduplicación de todo el
 *     scraper y no hay nada que inventar en su lugar.
 */

import * as cheerio from 'cheerio';

import type { DescargaDirecta, Parte, ProcesoJudicial } from './types';
// Del módulo de errores y NO de `./parser`: es `parser.ts` quien delega en este
// fichero, y tomar el error de allí cerraría un ciclo entre los dos módulos.
import { EstructuraInesperadaError } from './errores';
import { log } from './utils/logger';

/**
 * Tipos de elemento derivados de la propia API de cheerio.
 *
 * `domhandler` es una dependencia transitiva, no declarada en package.json:
 * importar `Element` de ahí ataría este fichero a un paquete que nadie eligió.
 */
type Seleccion = ReturnType<ReturnType<cheerio.CheerioAPI['root']>['children']>;
type Elemento = Seleccion extends ArrayLike<infer E> ? E : never;

// ---------------------------------------------------------------- constantes

/** La tabla, por sufijo de id: el prefijo del formulario puede cambiar. */
const SELECTOR_TABLA = '[id$=":processosTable"]';
/** Las filas de datos las marca RichFaces con esta clase; las de cabecera, no. */
const SELECTOR_FILAS = 'tbody tr.rich-table-row';

/** Número CNJ completo NNNNNNN-DD.AAAA.J.TR.OOOO buscado dentro de un texto. */
const RE_NUMERO_CNJ = /\b\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}\b/;

/**
 * Separador de polos: " X " entre el polo activo y el pasivo.
 *
 * Se exige espacio a ambos lados y X mayúscula suelta para no partir por la "x"
 * interior de un nombre. Solo se usa la PRIMERA aparición: el portal publica un
 * único separador y tratar los siguientes como más polos partiría un nombre.
 */
const RE_SEPARADOR_POLOS = /\s+X\s+/;

/**
 * Fecha brasileña con hora opcional: dd/MM/yyyy [HH:mm[:ss]].
 * Los lookarounds de dígito evitan casar dentro de un número más largo.
 */
const RE_FECHA_BR = /(?<!\d)(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?(?!\d)/;

/** Grupo entre paréntesis pegado al final de la celda de movimiento. */
const RE_PARENTESIS_FINAL = /\(([^()]+)\)\s*$/;

/** "106073 resultados encontrados", con punto de millar brasileño opcional. */
const RE_TOTAL = /(?<![\d.])([\d.]*\d)\s+resultados?\s+encontrad[oa]s?/i;

/**
 * Marca temporal que sustituye al enlace dentro de una COPIA de la celda.
 *
 * Trocear la celda por posición del enlace es lo único que distingue la clase
 * judicial (va delante) de los polos (van detrás); ambos son texto suelto sin
 * etiqueta propia. Se usa un carácter de control tipográfico que no aparece en
 * texto judicial, y se hace sobre un clon para no mutar el documento vigente,
 * del que dependen otros parsers y la paginación.
 */
const SENTINELA = '␟';

// ------------------------------------------------------------------ utilidades

/** Colapsa espacios (incluido &nbsp;) y recorta. */
function normalizar(bruto: string): string {
  return bruto.replace(/[\s ]+/g, ' ').trim();
}

/** Entero brasileño ("1.234") a número. Devuelve undefined si no es un entero seguro. */
function aEntero(bruto: string): number | undefined {
  const limpio = bruto.replace(/[.\s ]/g, '');
  if (!/^\d+$/.test(limpio)) return undefined;
  const n = Number.parseInt(limpio, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * dd/MM/yyyy [HH:mm:ss] → ISO-8601, con validación de calendario.
 *
 * Se hace a mano y NUNCA con `new Date(cadena)`: ese constructor interpreta las
 * cadenas con barras en orden estadounidense, así que leería 03/04/2025 como el
 * 4 de marzo en lugar del 3 de abril, y lo haría en silencio. La única `Date`
 * que aparece aquí es la de argumentos numéricos en UTC, que no interpreta
 * nada, y solo sirve para descartar un 31/02.
 *
 * El resultado no lleva sufijo de zona: el portal publica la hora local del
 * tribunal sin declarar su desfase, y añadir una "Z" desplazaría el instante
 * hasta tres horas afirmando una precisión que el dato no tiene.
 */
function aIso8601(valor: string): string | undefined {
  const m = RE_FECHA_BR.exec(valor);
  if (!m) return undefined;

  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const anio = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return undefined;
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
    return undefined;
  }

  const dosDigitos = (n: number): string => String(n).padStart(2, '0');
  const soloFecha = `${String(anio).padStart(4, '0')}-${dosDigitos(mes)}-${dosDigitos(dia)}`;
  if (m[4] === undefined || m[5] === undefined) return soloFecha;

  const hora = Number(m[4]);
  const minuto = Number(m[5]);
  const segundo = m[6] === undefined ? 0 : Number(m[6]);
  // Una hora imposible no invalida la fecha: se devuelve el día, que sí es firme.
  if (hora > 23 || minuto > 59 || segundo > 59) return soloFecha;
  return `${soloFecha}T${dosDigitos(hora)}:${dosDigitos(minuto)}:${dosDigitos(segundo)}`;
}

/** Asigna la clave solo si el valor tiene contenido: el contrato prohíbe cadenas vacías. */
function anotar(destino: Record<string, string>, clave: string, valor: string | undefined): void {
  if (valor !== undefined && valor.length > 0) destino[clave] = valor;
}

// ------------------------------------------------------- enlace a la ficha

/**
 * URL de la ficha escondida en un `onclick` / `href` de la fila.
 *
 * El control real es `openPopUp('Consulta pública','/<ctx>/ConsultaPublica/
 * DetalheProcessoConsultaPublica/listView.seam?ca=<hash>')`. En vez de exigir
 * la forma exacta de la llamada se recorren las cadenas entrecomilladas del
 * atributo y se elige la que apunta al detalle Y lleva `ca=`: ese parámetro es
 * el que autoriza la apertura, y una URL sin él devuelve un error del portal.
 *
 * La ruta se guarda tal como la publica el portal (relativa). `ClienteHttp`
 * tiene `baseURL` configurada, así que resolverla aquí contra un host escrito a
 * mano solo serviría para equivocarse de instancia.
 */
function urlFichaEn(atributo: string | undefined): string | undefined {
  if (atributo === undefined) return undefined;
  for (const m of atributo.matchAll(/['"]([^'"]+)['"]/g)) {
    const candidata = m[1];
    if (candidata === undefined) continue;
    if (!candidata.includes('DetalheProcessoConsultaPublica')) continue;
    if (!/[?&]ca=[^&#\s]+/.test(candidata)) continue;
    const url = normalizar(candidata);
    if (url.length > 0) return url;
  }
  return undefined;
}

/** Primera URL de ficha que publique cualquier control de la fila. */
function aperturaDeFila($: cheerio.CheerioAPI, fila: Elemento): DescargaDirecta | undefined {
  for (const el of $(fila).find('a[onclick], a[href], [onclick]').toArray()) {
    const url = urlFichaEn($(el).attr('onclick')) ?? urlFichaEn($(el).attr('href'));
    if (url !== undefined) return { tipo: 'url', url };
  }
  return undefined;
}

// --------------------------------------------------------- celda compuesta

/** Lo que se puede leer de la celda "Processo" una vez descompuesta. */
interface CeldaProceso {
  numero?: string;
  sigla?: string;
  assunto?: string;
  classeJudicial?: string;
  poloActivo?: string;
  poloPasivo?: string;
}

/**
 * Descompone la celda compuesta usando el enlace como eje.
 *
 * Antes de trocear se aplanan los `<br>` a un salto de línea: sin eso, dos
 * líneas separadas por `<br>` llegan pegadas ("INSSFULANO") y el nombre de la
 * parte saldría corrupto. Los fixtures actuales no traen `<br>` en esta celda,
 * pero otras instancias del PJe sí los usan para separar los polos.
 */
function leerCeldaProceso($: cheerio.CheerioAPI, celda: Elemento): CeldaProceso {
  const $celda = $(celda).clone();
  $celda.find('br').replaceWith('\n');

  const anclas = $celda.find('a').toArray();
  const ancla =
    anclas.find((a) => RE_NUMERO_CNJ.test(normalizar($(a).text()))) ??
    anclas.find((a) => $(a).find('b').length > 0) ??
    anclas[0];

  const textoAncla = ancla === undefined ? '' : normalizar($(ancla).text());
  if (ancla !== undefined) $(ancla).replaceWith(SENTINELA);

  const trozos = $celda.text().split(SENTINELA);
  const antes = normalizar(trozos[0] ?? '');
  // Todo lo que quede tras el enlace son los polos, aunque hubiera más enlaces.
  const despues = normalizar(trozos.slice(1).join(' '));

  const resultado: CeldaProceso = {};

  // "SIGLA 0000619-36.2021.4.05.8109 -  Assunto" → las tres piezas.
  const m = RE_NUMERO_CNJ.exec(textoAncla);
  if (m?.index !== undefined) {
    resultado.numero = m[0];
    const sigla = normalizar(textoAncla.slice(0, m.index));
    if (sigla.length > 0) resultado.sigla = sigla;
    // El asunto va tras el guion; el portal deja doble espacio y a veces nada.
    const assunto = normalizar(textoAncla.slice(m.index + m[0].length).replace(/^\s*-\s*/, ''));
    if (assunto.length > 0) resultado.assunto = assunto;
  } else {
    // Sin enlace utilizable solo se rescata el número, si es que está suelto en
    // la celda. Repartir el resto entre clase, sigla y asunto sin el eje del
    // enlace sería adivinar dónde acaba cada campo.
    const suelto = RE_NUMERO_CNJ.exec(normalizar($celda.text()));
    if (suelto) resultado.numero = suelto[0];
    return resultado;
  }

  if (antes.length > 0) resultado.classeJudicial = antes;

  if (despues.length > 0) {
    const corte = RE_SEPARADOR_POLOS.exec(despues);
    if (corte?.index !== undefined) {
      const activo = normalizar(despues.slice(0, corte.index));
      const pasivo = normalizar(despues.slice(corte.index + corte[0].length));
      if (activo.length > 0) resultado.poloActivo = activo;
      if (pasivo.length > 0) resultado.poloPasivo = pasivo;
    } else {
      // Un solo polo publicado: se guarda como activo en vez de descartarlo.
      resultado.poloActivo = despues;
    }
  }

  return resultado;
}

// ------------------------------------------------------- celda de movimiento

/** Nombre y fecha de la última movimentação. */
interface Movimiento {
  nombre?: string;
  fechaIso?: string;
}

/**
 * "Baixa Definitiva (02/02/2023 18:27:05)" → nombre + fecha.
 *
 * La fecha se toma del ÚLTIMO paréntesis de la celda, no del primero: hay
 * movimientos cuyo propio nombre lleva fecha ("Publicado Decisão em
 * 12/08/2026. (12/08/2026 00:31:50)") y quedarse con la primera aparición
 * mezclaría el texto del movimiento con su marca de tiempo.
 */
function leerMovimiento($: cheerio.CheerioAPI, celda: Elemento): Movimiento {
  const $celda = $(celda).clone();
  $celda.find('br').replaceWith('\n');
  const texto = normalizar($celda.text());
  if (texto.length === 0) return {};

  const m = RE_PARENTESIS_FINAL.exec(texto);
  if (!m || m.index === undefined || m[1] === undefined) {
    return { nombre: texto };
  }

  const fechaIso = aIso8601(m[1]);
  // Si el paréntesis final no era una fecha, no se amputa: era parte del nombre.
  if (fechaIso === undefined) return { nombre: texto };

  const nombre = normalizar(texto.slice(0, m.index));
  return { ...(nombre.length > 0 ? { nombre } : {}), fechaIso };
}

// ---------------------------------------------------------------- procesos

/** Construye el registro de una fila, o undefined si la fila no trae número. */
function construirProceso($: cheerio.CheerioAPI, fila: Elemento, pagina: number): ProcesoJudicial | undefined {
  const celdas = $(fila).children('td, th').toArray();
  const celdaProceso = celdas[1];
  const datos = celdaProceso === undefined ? {} : leerCeldaProceso($, celdaProceso);
  if (datos.numero === undefined) return undefined;

  // Se mantiene como cadena: el número CNJ tiene ceros a la izquierda que
  // cualquier conversión numérica destruiría.
  const proceso: ProcesoJudicial = { numeroProcesso: datos.numero };

  if (datos.classeJudicial !== undefined) proceso.classeJudicial = datos.classeJudicial;

  const partes: Parte[] = [];
  if (datos.poloActivo !== undefined) partes.push({ papel: 'ATIVO', nombre: datos.poloActivo });
  if (datos.poloPasivo !== undefined) partes.push({ papel: 'PASSIVO', nombre: datos.poloPasivo });
  if (partes.length > 0) proceso.partes = partes;

  // El control de apertura se lee AQUÍ porque solo existe mientras esta página
  // es el documento vigente; la Fase 2 ya no tendría de dónde sacarlo.
  const apertura = aperturaDeFila($, fila);
  if (apertura) proceso.apertura = apertura;

  const camposExtra: Record<string, string> = {};
  anotar(camposExtra, 'sigla', datos.sigla);
  anotar(camposExtra, 'assunto', datos.assunto);

  const celdaMovimiento = celdas[2];
  if (celdaMovimiento !== undefined) {
    const movimiento = leerMovimiento($, celdaMovimiento);
    anotar(camposExtra, 'ultimaMovimentacao', movimiento.nombre);
    anotar(camposExtra, 'fechaUltimaMovimentacao', movimiento.fechaIso);
  }

  if (Object.keys(camposExtra).length > 0) proceso.camposExtra = camposExtra;

  // La página solo se anota si es un ordinal creíble; un 0 o un NaN mentirían.
  if (Number.isInteger(pagina) && pagina > 0) proceso.paginaOrigen = pagina;

  return proceso;
}

/**
 * Extrae los procesos de la tabla de resultados de la plantilla moderna.
 *
 * Devuelve `[]` cuando el documento no tiene esa tabla (la página de inicio, o
 * la plantilla antigua). Lanza `EstructuraInesperadaError` cuando la tabla está
 * ahí con filas pero ninguna contiene un número CNJ: eso ya no es "cero
 * resultados", es que la celda compuesta cambió de forma y seguir devolviendo
 * `[]` haría creer al scraper que terminó bien con las manos vacías.
 */
export function parsearProcesosModerno($: cheerio.CheerioAPI, pagina: number): ProcesoJudicial[] {
  const tabla: Elemento | undefined = $(SELECTOR_TABLA).toArray()[0];
  if (tabla === undefined) return [];

  const filas = $(tabla).find(SELECTOR_FILAS).toArray();
  // Cero filas es una búsqueda sin resultados, no una estructura rota.
  if (filas.length === 0) return [];

  const procesos: ProcesoJudicial[] = [];
  const vistos = new Set<string>();
  let sinNumero = 0;

  for (const fila of filas) {
    const proceso = construirProceso($, fila, pagina);
    if (!proceso) {
      sinNumero++;
      continue;
    }
    // RichFaces repite filas al fijar cabeceras; el número es la clave del tribunal.
    if (vistos.has(proceso.numeroProcesso)) continue;
    vistos.add(proceso.numeroProcesso);
    procesos.push(proceso);
  }

  if (procesos.length === 0) {
    const primera = filas[0];
    const muestra =
      primera === undefined
        ? '(sin filas)'
        : $(primera)
            .children('td, th')
            .toArray()
            .map((c) => JSON.stringify(normalizar($(c).text()).slice(0, 120)))
            .join(' | ');
    throw new EstructuraInesperadaError(
      `La tabla ${String($(tabla).attr('id'))} tiene ${filas.length} filas pero ninguna contiene un número de ` +
        'proceso con formato CNJ (NNNNNNN-DD.AAAA.J.TR.OOOO): cambió la celda compuesta "Processo" o la tabla ' +
        `ya no es la de resultados. Primera fila: ${muestra}`,
    );
  }

  if (sinNumero > 0) {
    // Normal y esperado: los procesos en sigilo se listan sin número. Se deja
    // constancia para que una caída del recuento no se confunda con un fallo.
    log.debug(`Página ${pagina}: ${sinNumero} de ${filas.length} filas sin número de proceso (sigilo); omitidas`);
  }

  return procesos;
}

/**
 * Total de resultados que anuncia el pie de la tabla, o undefined si no lo anuncia.
 *
 * Solo se acepta la frase explícita "N resultados encontrados". No se deduce
 * nada del paginador: sus botones numeran páginas, no registros, y devolver un
 * "10" como total decidiría mal cuándo parar la extracción.
 */
export function detectarTotalModerno($: cheerio.CheerioAPI): number | undefined {
  // El pie de la tabla es la fuente precisa; el barrido del cuerpo es el respaldo
  // por si otra instancia rotula ese contador con otra clase.
  const candidatos = $('span.text-muted')
    .toArray()
    .map((el) => normalizar($(el).text()));
  candidatos.push(normalizar($('body').length > 0 ? $('body').text() : $.root().text()));

  for (const texto of candidatos) {
    const m = RE_TOTAL.exec(texto);
    const valor = m?.[1] === undefined ? undefined : aEntero(m[1]);
    if (valor !== undefined) return valor;
  }
  return undefined;
}
