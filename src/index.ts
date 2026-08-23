/**
 * Punto de entrada del scraper.
 *
 * Uso:
 *   npm start              menú interactivo
 *   npm run fase1          solo extracción de metadatos
 *   npm run fase2          solo descarga de PDF
 *   npm run explorar       vuelca la estructura del portal (diagnóstico)
 *
 * Variables de entorno:
 *   SECAO=0                valor del selector Seção/Subseção (0 = TRF 5ª Região)
 *   NOME_PARTE="SILVA"     criterio alternativo por nombre de parte
 *   MAX_DESCARGAS=25       tope de PDF por ejecución de la Fase 2
 *   MAX_PAGINAS=500        tope de páginas de la Fase 1
 *   CAPTCHA_MODE=file      lee la respuesta del CAPTCHA de output/captcha.txt en vez de la terminal
 *   DEBUG=1                traza cada petición HTTP
 *   GUARDAR_RAW=1          guarda las respuestas crudas en output/raw/
 */
import * as readline from 'readline';
import { CONFIG } from './config';
import { CaptchaHumano, CaptchaPorArchivo, ResolutorCaptcha } from './captcha/humano';
import { ScraperPeru } from './peru/scraper';
import { CriteriosPeru } from './peru/session';
import { enteroPositivo, Scraper } from './scraper';
import { CriteriosBusqueda } from './session';
import { log } from './utils/logger';
import { BloqueadoPorWafError, ServidorSaturadoError } from './utils/retry';

/** Veces que se repite la pregunta del menú antes de rendirse. */
const MAX_INTENTOS_MENU = 5;

/** Rótulo del portal activo, para el menú y los mensajes de error. */
const NOMBRE_OBJETIVO =
  CONFIG.objetivo === 'peru' ? 'Jurisprudencia Nacional Sistematizada (Perú)' : 'Consulta Pública PJe TRF5 (Brasil)';

function resolutor(): ResolutorCaptcha {
  return process.env.CAPTCHA_MODE === 'file'
    ? new CaptchaPorArchivo(CONFIG.captchaPath)
    : new CaptchaHumano(CONFIG.captchaPath);
}

function criterios(): CriteriosBusqueda {
  // El portal exige al menos un criterio ("Informe pelo menos 1 critério de pesquisa").
  // Seção = 0 (TRF 5ª Região) es el filtro más amplio del desplegable.
  const c: CriteriosBusqueda = { secao: process.env.SECAO ?? '0' };
  if (process.env.NOME_PARTE) c.nomeParte = process.env.NOME_PARTE;
  if (process.env.NUMERO_PROCESSO) c.numeroProcesso = process.env.NUMERO_PROCESSO;
  return c;
}

/**
 * Criterios del portal peruano.
 *
 * Todos opcionales: a diferencia del PJe, este buscador acepta una consulta sin
 * filtros y devuelve el corpus entero, que es el caso que demuestra el requisito
 * de «navegar por todas las páginas».
 */
function criteriosPeru(): CriteriosPeru {
  const c: CriteriosPeru = {};
  if (process.env.TEXTO) c.texto = process.env.TEXTO;
  if (process.env.EXPEDIENTE) c.expediente = process.env.EXPEDIENTE;
  if (process.env.ANIO) c.anio = process.env.ANIO;
  return c;
}

/**
 * Pregunta por la terminal.
 *
 * El manejador de `close` no es decorativo: si la entrada estándar está cerrada
 * (`npm start < /dev/null`, un runner sin TTY) el callback de `question` no se
 * invoca nunca y la promesa se quedaría pendiente para siempre, con el proceso
 * colgado sin decir por qué. Al cerrarse se resuelve vacío y el bucle del menú
 * lo trata como una elección inválida.
 */
function preguntar(texto: string): Promise<string> {
  // Cortocircuito ANTES de crear la interfaz. El respaldo por `close` solo actúa
  // una vez por proceso: una interfaz nueva sobre un stdin que ya emitió `end` no
  // vuelve a emitir `close`, así que a partir de la segunda pregunta la promesa
  // quedaba pendiente para siempre. Node vaciaba el bucle de eventos y el proceso
  // salía con código 0 sin hacer nada, que es un fallo silencioso con aspecto de
  // éxito. Con la comprobación, las preguntas restantes resuelven vacío al
  // instante y el menú termina por su tope de intentos, con un mensaje.
  if (process.stdin.readableEnded) return Promise.resolve('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolver) => {
    // El guardia NO es decorativo, y su ausencia rompía el menú entero: `rl.close()`
    // emite `close` de forma SÍNCRONA, así que el manejador corría antes que el
    // `resolver(respuesta)` de la línea siguiente y la promesa se quedaba con la
    // cadena vacía. El efecto era que `npm start` —el primer comando del README—
    // rechazaba toda opción tecleada y salía por el tope de intentos.
    let respondido = false;
    rl.on('close', () => {
      if (!respondido) resolver('');
    });
    rl.question(texto, (respuesta) => {
      respondido = true;
      rl.close();
      resolver(respuesta.trim());
    });
  });
}

/**
 * Ejecuta el objetivo peruano.
 *
 * Vive en su propia función para que el flujo del TRF5 —con su CAPTCHA y su
 * resolutor— no tenga que arrastrar parámetros que este portal no usa.
 */
async function ejecutarPeru(modo: string): Promise<void> {
  const scraper = new ScraperPeru();
  const opciones = {
    criterios: criteriosPeru(),
    maxPaginas: enteroPositivo(process.env.MAX_PAGINAS, 10000, 'MAX_PAGINAS'),
    maxDescargas: enteroPositivo(process.env.MAX_DESCARGAS, 25, 'MAX_DESCARGAS'),
  };
  if (modo === 'fase1' || modo === 'completo') await scraper.fase1(opciones);
  if (modo === 'fase2' || modo === 'completo') await scraper.fase2(opciones);
}

/** Ejecuta el objetivo brasileño, el único de los dos que pide un CAPTCHA. */
async function ejecutarTrf5(modo: string): Promise<void> {
  const scraper = new Scraper(resolutor());
  const opciones = {
    criterios: criterios(),
    // Validado, y no `Number(...)` a secas: un valor no numérico daría `NaN`, y
    // `bajados >= NaN` es siempre falso, así que el tope desaparecería en
    // silencio justo donde su función es impedir una descarga masiva.
    maxDescargas: enteroPositivo(process.env.MAX_DESCARGAS, 25, 'MAX_DESCARGAS'),
  };
  if (modo === 'fase1' || modo === 'completo') await scraper.fase1(opciones);
  if (modo === 'fase2' || modo === 'completo') await scraper.fase2(opciones);
}

async function main(): Promise<void> {
  // El token del objetivo no es un modo: se descarta antes de elegir la fase,
  // para que `ts-node src/index.ts peru fase1` no intente ejecutar «peru».
  const argumento = process.argv.slice(2).find((a) => a !== 'peru' && a !== 'trf5');
  let eleccion = argumento;

  if (!eleccion) {
    console.log('\n==================================================');
    console.log(`  Scraper · ${NOMBRE_OBJETIVO}`);
    console.log('==================================================');
    console.log('  1) Fase 1: extraer metadatos y guardarlos en JSON/CSV');
    console.log('  2) Fase 2: descargar los PDF de lo ya extraído');
    console.log('  3) Flujo completo (Fase 1 + Fase 2)');
    console.log('==================================================');
    if (CONFIG.objetivo === 'peru') {
      console.log('  Este portal no pide CAPTCHA: la ejecución es desatendida');
      console.log('  de principio a fin.\n');
    } else {
      console.log('  Nota: el portal exige un CAPTCHA para buscar. Se te pedirá');
      console.log('  una vez por fase; el resto del recorrido es automático.\n');
    }
    // Cota explícita: sin ella, una entrada estándar cerrada convierte el menú en
    // un bucle infinito de preguntas que nadie puede responder.
    for (let i = 0; i < MAX_INTENTOS_MENU && !['1', '2', '3'].includes(eleccion ?? ''); i++) {
      eleccion = await preguntar('  Elige una opción (1-3): ');
    }
  }

  const modo = { '1': 'fase1', '2': 'fase2', '3': 'completo', fase1: 'fase1', fase2: 'fase2', completo: 'completo' }[
    eleccion as string
  ];
  if (!modo) {
    console.error(`Opción no reconocida: ${eleccion}. Usa 1, 2, 3, fase1, fase2 o completo.`);
    process.exit(2);
  }

  if (CONFIG.objetivo === 'peru') await ejecutarPeru(modo);
  else await ejecutarTrf5(modo);

  log.info('Proceso finalizado.');
}

main().catch((e) => {
  if (e instanceof BloqueadoPorWafError) {
    log.error('El WAF del portal bloqueó esta dirección IP.');
    // El consejo es OPUESTO en cada portal, y darlo al revés cuesta una tarde:
    // el TRF5 rechaza los rangos de anonimizadores, mientras que el portal
    // peruano rechaza con 403 todo lo que no salga desde Perú.
    log.error(
      CONFIG.objetivo === 'peru'
        ? 'Este portal solo atiende desde Perú. Necesitas una VPN de ámbito de SISTEMA (no una extensión del navegador: esa no enruta el proceso de Node).'
        : 'Si tienes una VPN activa, apágala: el TRF5 rechaza los rangos de alojamiento y anonimizadores.',
    );
  } else if (e instanceof ServidorSaturadoError) {
    log.error(`El portal (${NOMBRE_OBJETIVO}) no está sirviendo peticiones.`);
    log.error('Es un fallo del tribunal, no del scraper. Reintenta más tarde.');
  } else {
    log.error(`Error no recuperable: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
  process.exit(1);
});
