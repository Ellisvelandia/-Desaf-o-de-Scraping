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
  constructor(private readonly rutaImagen: string, private readonly timeoutMs = 60 * 60 * 1000) {}

  async resolver(imagen: Buffer, contentType: string): Promise<string> {
    fs.mkdirSync(path.dirname(this.rutaImagen), { recursive: true });
    const rutaTexto = this.rutaImagen.replace(/\.[a-z]+$/i, '') + '.txt';
    if (fs.existsSync(rutaTexto)) fs.unlinkSync(rutaTexto);
    fs.writeFileSync(this.rutaImagen, imagen);
    log.info(`CAPTCHA guardado en ${this.rutaImagen} (${contentType}, ${imagen.length} B). Esperando ${rutaTexto}…`);
    const limite = Date.now() + this.timeoutMs;
    while (Date.now() < limite) {
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

function preguntar(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, (r) => {
      rl.close();
      resolve(r);
    }),
  );
}
