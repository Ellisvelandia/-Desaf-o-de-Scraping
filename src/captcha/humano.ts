/**
 * Resolución del CAPTCHA por una persona.
 *
 * El portal exige un CAPTCHA de imagen para buscar. No se resuelve de forma
 * automática: se guarda la imagen en disco, se indica la ruta por terminal y
 * se espera a que el operador teclee los caracteres. Es el único punto del
 * scraper que requiere intervención humana, y ocurre una vez por sesión.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { log } from '../utils/logger';

export interface ResolutorCaptcha {
  resolver(imagen: Buffer, contentType: string): Promise<string>;
}

/** Implementación interactiva por terminal. */
export class CaptchaHumano implements ResolutorCaptcha {
  constructor(private readonly rutaImagen: string) {}

  async resolver(imagen: Buffer, contentType: string): Promise<string> {
    fs.mkdirSync(path.dirname(this.rutaImagen), { recursive: true });
    fs.writeFileSync(this.rutaImagen, imagen);
    log.info(`CAPTCHA guardado en ${this.rutaImagen} (${contentType}, ${imagen.length} B)`);
    console.log('\n  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │  Abre la imagen y teclea los caracteres que ves.         │');
    console.log(`  │  ${this.rutaImagen.padEnd(56)}│`);
    console.log('  │  Enter vacío = pedir una imagen nueva.                   │');
    console.log('  └──────────────────────────────────────────────────────────┘');
    const texto = await preguntar('  CAPTCHA: ');
    return texto.trim();
  }
}

/**
 * Implementación por archivo, para entornos sin terminal interactiva (CI, ejecución
 * supervisada desde otro proceso): guarda la imagen y espera a que alguien escriba
 * la respuesta en `<rutaImagen>.txt`. El archivo se consume y se borra.
 */
export class CaptchaPorArchivo implements ResolutorCaptcha {
  /**
   * @param timeoutMs Espera máxima. `0` o negativo significa esperar
   *   indefinidamente, útil cuando el operador no está delante y el proceso
   *   puede quedarse a la escucha todo el tiempo que haga falta.
   */
  constructor(
    private readonly rutaImagen: string,
    private readonly timeoutMs = Number(process.env.CAPTCHA_TIMEOUT_MS ?? 60 * 60 * 1000),
  ) {}

  async resolver(imagen: Buffer, contentType: string): Promise<string> {
    fs.mkdirSync(path.dirname(this.rutaImagen), { recursive: true });
    const rutaTexto = this.rutaImagen.replace(/\.[a-z]+$/i, '') + '.txt';
    if (fs.existsSync(rutaTexto)) fs.unlinkSync(rutaTexto);
    fs.writeFileSync(this.rutaImagen, imagen);
    log.info(`CAPTCHA guardado en ${this.rutaImagen} (${contentType}, ${imagen.length} B). Esperando ${rutaTexto}…`);
    const sinLimite = !Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0;
    const limite = Date.now() + this.timeoutMs;
    while (sinLimite || Date.now() < limite) {
      if (fs.existsSync(rutaTexto)) {
        const texto = fs.readFileSync(rutaTexto, 'utf8').trim();
        fs.unlinkSync(rutaTexto);
        if (texto) return texto;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Nadie escribió el CAPTCHA en ${rutaTexto} en ${this.timeoutMs / 1000} s`);
  }
}

/** Implementación para pruebas: devuelve un valor fijo sin tocar la terminal. */
export class CaptchaFijo implements ResolutorCaptcha {
  constructor(private readonly valor: string) {}
  async resolver(): Promise<string> {
    return this.valor;
  }
}

/**
 * Pregunta por la terminal, fallando de forma explícita si no hay nadie.
 *
 * El manejador de `close` no es decorativo. Con la entrada estándar cerrada
 * —`npm run fase1 < /dev/null`, nohup, cron, un runner de CI, cualquier
 * orquestador sin TTY— el callback de `question` no se invoca nunca. Sin este
 * guardia la promesa se quedaba pendiente para siempre: Node vaciaba el bucle de
 * eventos y **el proceso terminaba con código 0**, sin descargar nada y sin decir
 * por qué. Un fallo silencioso con aspecto de éxito, que es el peor que puede
 * dar este scraper.
 *
 * `respondido` distingue el cierre tras una respuesta del cierre sin ella:
 * `rl.close()` emite `close` de forma síncrona, así que sin la bandera el
 * rechazo pisaría a la respuesta legítima.
 */
function preguntar(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    let respondido = false;
    rl.on('close', () => {
      if (respondido) return;
      reject(
        new Error(
          'La entrada estándar se cerró sin responder al CAPTCHA. Este portal exige una persona: ' +
            'ejecuta el scraper en una terminal interactiva, o usa CAPTCHA_MODE=file para que la ' +
            'respuesta llegue por output/captcha.txt.',
        ),
      );
    });
    rl.question(prompt, (r) => {
      respondido = true;
      rl.close();
      resolve(r);
    });
  });
}
