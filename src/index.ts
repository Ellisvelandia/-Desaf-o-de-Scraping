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
import { enteroPositivo, Scraper } from './scraper';
import { CriteriosBusqueda } from './session';
import { log } from './utils/logger';
import { BloqueadoPorWafError, ServidorSaturadoError } from './utils/retry';

/** Veces que se repite la pregunta del menú antes de rendirse. */
const MAX_INTENTOS_MENU = 5;

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
 * Pregunta por la terminal.
 *
 * El manejador de `close` no es decorativo: si la entrada estándar está cerrada
 * (`npm start < /dev/null`, un runner sin TTY) el callback de `question` no se
 * invoca nunca y la promesa se quedaría pendiente para siempre, con el proceso
 * colgado sin decir por qué. Al cerrarse se resuelve vacío y el bucle del menú
 * lo trata como una elección inválida.
 */
function preguntar(texto: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolver) => {
    rl.on('close', () => resolver(''));
    rl.question(texto, (respuesta) => {
      rl.close();
      resolver(respuesta.trim());
    });
  });
}

async function main(): Promise<void> {
  const scraper = new Scraper(resolutor());
  const opciones = {
    criterios: criterios(),
    // Validado, y no `Number(...)` a secas: un valor no numérico daría `NaN`, y
    // `bajados >= NaN` es siempre falso, así que el tope desaparecería en
    // silencio justo donde su función es impedir una descarga masiva.
    maxDescargas: enteroPositivo(process.env.MAX_DESCARGAS, 25, 'MAX_DESCARGAS'),
  };

  const argumento = process.argv[2];
  let eleccion = argumento;

  if (!eleccion) {
    console.log('\n==================================================');
    console.log('  Scraper · Consulta Pública PJe TRF5');
    console.log('==================================================');
    console.log('  1) Fase 1: extraer metadatos y guardarlos en JSON/CSV');
    console.log('  2) Fase 2: descargar los PDF de lo ya extraído');
    console.log('  3) Flujo completo (Fase 1 + Fase 2)');
    console.log('==================================================');
    console.log('  Nota: el portal exige un CAPTCHA para buscar. Se te pedirá');
    console.log('  una vez por fase; el resto del recorrido es automático.\n');
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

  if (modo === 'fase1' || modo === 'completo') await scraper.fase1(opciones);
  if (modo === 'fase2' || modo === 'completo') await scraper.fase2(opciones);

  log.info('Proceso finalizado.');
}

main().catch((e) => {
  if (e instanceof BloqueadoPorWafError) {
    log.error('El WAF del portal bloqueó esta dirección IP.');
    log.error('Si tienes una VPN activa, apágala: el TRF5 rechaza los rangos de alojamiento y anonimizadores.');
  } else if (e instanceof ServidorSaturadoError) {
    log.error('El portal del TRF5 no está sirviendo peticiones (pool de conexiones agotado en su servidor).');
    log.error('Es un fallo del tribunal, no del scraper. Reintenta más tarde.');
  } else {
    log.error(`Error no recuperable: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  }
  process.exit(1);
});
