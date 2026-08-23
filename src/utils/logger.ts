/**
 * Logger mínimo con marca de tiempo y nivel.
 *
 * Una línea por evento relevante (página, descarga, reintento) para que una
 * ejecución larga sea legible y un bloqueo sea distinguible de un cuelgue.
 */
type Nivel = 'info' | 'warn' | 'error' | 'debug';

const inicio = Date.now();

function marca(): string {
  const s = ((Date.now() - inicio) / 1000).toFixed(1).padStart(7, ' ');
  return `[${s}s]`;
}

function emitir(nivel: Nivel, mensaje: string, extra?: unknown): void {
  const linea = `${marca()} ${nivel.toUpperCase().padEnd(5)} ${mensaje}`;
  const salida = nivel === 'error' || nivel === 'warn' ? console.error : console.log;
  if (extra !== undefined) salida(linea, extra);
  else salida(linea);
}

export const log = {
  info: (m: string, e?: unknown) => emitir('info', m, e),
  warn: (m: string, e?: unknown) => emitir('warn', m, e),
  error: (m: string, e?: unknown) => emitir('error', m, e),
  debug: (m: string, e?: unknown) => {
    if (process.env.DEBUG) emitir('debug', m, e);
  },
};
