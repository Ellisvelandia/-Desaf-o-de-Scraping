/**
 * Explorador de la primera página (hito MVP de la skill web-scraping).
 *
 * Abre sesión, pide el CAPTCHA al operador, envía la búsqueda y vuelca a disco
 * todo lo necesario para escribir el parser con evidencia real:
 *   output/raw/01-inicio.html         página completa
 *   output/raw/02-busqueda-N.xml      respuesta A4J cruda
 *   output/raw/03-documento.html      documento vigente tras parchear
 *   output/raw/03-resumen.json        tablas, filas, enlaces y controles detectados
 *
 * No pagina ni descarga: su única salida es conocimiento del protocolo.
 */
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG } from './config';
import { CaptchaHumano, CaptchaPorArchivo } from './captcha/humano';
import { SesionPje } from './session';
import { log } from './utils/logger';

process.env.GUARDAR_RAW = '1';

async function main(): Promise<void> {
  const resolutor = process.env.CAPTCHA_MODE === 'file' ? new CaptchaPorArchivo(CONFIG.captchaPath) : new CaptchaHumano(CONFIG.captchaPath);
  const sesion = new SesionPje(resolutor);
  await sesion.abrir();

  // Criterio: el portal exige al menos uno. SECAO=0 es 'TRF - 5ª Região', el más amplio del desplegable.
  const ok = await sesion.buscar({ secao: process.env.SECAO ?? '0', nomeParte: process.env.NOME_PARTE });
  const $ = sesion.documento;

  fs.mkdirSync(CONFIG.rawDir, { recursive: true });
  fs.writeFileSync(path.join(CONFIG.rawDir, '03-documento.html'), $.html(), 'utf8');

  const tablas = $('table')
    .map((_, t) => ({
      id: $(t).attr('id') ?? '',
      clase: $(t).attr('class') ?? '',
      filas: $(t).find('tr').length,
      cabeceras: $(t)
        .find('th')
        .map((__, th) => $(th).text().replace(/\s+/g, ' ').trim())
        .get()
        .slice(0, 20),
    }))
    .get()
    .filter((t) => t.filas > 2);

  const enlaces = $('a[href], a[onclick]')
    .map((_, a) => ({
      id: $(a).attr('id') ?? '',
      texto: $(a).text().replace(/\s+/g, ' ').trim().slice(0, 60),
      href: ($(a).attr('href') ?? '').slice(0, 160),
      onclick: ($(a).attr('onclick') ?? '').slice(0, 220),
    }))
    .get()
    .filter((a) => /processo|documento|detalhe|pdf|download|scroller|page|pagina|Prox|Próx|»|&gt;/i.test(a.texto + a.href + a.onclick + a.id))
    .slice(0, 60);

  const scroller = $('[id*="scroller"], .rich-datascr, [class*="datascr"]')
    .map((_, el) => ({ id: $(el).attr('id') ?? '', clase: $(el).attr('class') ?? '', texto: $(el).text().replace(/\s+/g, ' ').trim().slice(0, 120) }))
    .get();

  const resumen = {
    busquedaAceptada: ok,
    mensajes: sesion.mensajesDelServidor(),
    viewState: sesion.formularioActual().viewState,
    tablas,
    scroller,
    enlaces,
    filasConDatos: $('table.rich-table tbody tr, tr.rich-table-row').length,
  };
  fs.writeFileSync(path.join(CONFIG.rawDir, '03-resumen.json'), JSON.stringify(resumen, null, 2), 'utf8');

  log.info(`Búsqueda aceptada: ${ok}. Tablas: ${tablas.length}. Filas: ${resumen.filasConDatos}. Scrollers: ${scroller.length}. Enlaces: ${enlaces.length}.`);
  log.info(`Resumen en ${path.join(CONFIG.rawDir, '03-resumen.json')}`);
}

main().catch((e) => {
  log.error(`Exploración fallida: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
