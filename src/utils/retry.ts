/**
 * Política de reintentos con retroceso exponencial, jitter y tope.
 *
 * Principio: clasificar el fallo antes de reaccionar. Un 429 o un corte de red
 * merecen esperar y repetir; un 400, 403 o 404 no van a cambiar por esperar, y
 * repetirlos contra un WAF convierte un bloqueo blando en uno duro.
 */
import { CONFIG } from '../config';
import { log } from './logger';

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Códigos que nunca se reintentan: la petición está mal o no estamos autorizados. */
const FATAL = new Set([400, 401, 403, 404, 405, 410, 422]);

/** Códigos que sí se reintentan: límite de tasa o servidor transitoriamente caído. */
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** Errores de transporte que se reintentan. */
const TRANSPORT = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED', 'EPIPE']);

/** Error de dominio para señalar que el servidor del portal está saturado (pool de BD agotado). */
export class ServidorSaturadoError extends Error {
  constructor(mensaje = 'El servidor devolvió errorUnexpected (pool de conexiones agotado)') {
    super(mensaje);
    this.name = 'ServidorSaturadoError';
  }
}

/** Error de dominio para señalar que la sesión o el estado de vista caducaron. */
export class SesionCaducadaError extends Error {
  constructor(mensaje = 'La sesión JSF o el ViewState ya no son válidos') {
    super(mensaje);
    this.name = 'SesionCaducadaError';
  }
}

/** Error de dominio: el WAF rechazó la IP de origen. No tiene sentido reintentar. */
export class BloqueadoPorWafError extends Error {
  constructor(mensaje = 'El WAF del portal bloqueó esta IP (Requisição Rejeitada)') {
    super(mensaje);
    this.name = 'BloqueadoPorWafError';
  }
}

export interface OpcionesReintento {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  /** Etiqueta para los logs. */
  etiqueta?: string;
}

interface ErrorHttp {
  response?: { status?: number; headers?: Record<string, unknown> };
  code?: string;
  message?: string;
}

/** Devuelve true si el error merece un nuevo intento. */
export function esReintentable(err: unknown): boolean {
  if (err instanceof ServidorSaturadoError) return true;
  if (err instanceof BloqueadoPorWafError) return false;
  if (err instanceof SesionCaducadaError) return false;
  const e = err as ErrorHttp;
  const status = e.response?.status;
  if (status !== undefined) {
    if (FATAL.has(status)) return false;
    return RETRYABLE.has(status);
  }
  return e.code !== undefined && TRANSPORT.has(e.code);
}

/** Calcula la espera del intento n (1-based), respetando Retry-After si el servidor lo envía. */
export function calcularEspera(err: unknown, intento: number, o: Required<OpcionesReintento>): number {
  if (err instanceof ServidorSaturadoError) {
    return CONFIG.retry.serverOverloadDelayMs;
  }
  const e = err as ErrorHttp;
  const retryAfter = Number(e.response?.headers?.['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, o.maxDelayMs);
  }
  const exponencial = o.baseDelayMs * Math.pow(2, intento - 1);
  return Math.min(exponencial, o.maxDelayMs) + Math.random() * o.jitterMs;
}

/**
 * Ejecuta `operacion` y la repite ante fallos reintentables.
 *
 * Garantías: cada camino termina, la espera está acotada, y un error fatal
 * se propaga en el primer intento sin dormir.
 */
export async function withRetry<T>(operacion: () => Promise<T>, opciones: OpcionesReintento = {}): Promise<T> {
  const o: Required<OpcionesReintento> = {
    attempts: opciones.attempts ?? CONFIG.retry.attempts,
    baseDelayMs: opciones.baseDelayMs ?? CONFIG.retry.baseDelayMs,
    maxDelayMs: opciones.maxDelayMs ?? CONFIG.retry.maxDelayMs,
    jitterMs: opciones.jitterMs ?? CONFIG.retry.jitterMs,
    etiqueta: opciones.etiqueta ?? 'peticion',
  };

  for (let intento = 1; ; intento++) {
    try {
      return await operacion();
    } catch (err) {
      if (!esReintentable(err) || intento >= o.attempts) throw err;
      const espera = calcularEspera(err, intento, o);
      const e = err as ErrorHttp;
      const motivo = e.response?.status ?? e.code ?? (err as Error).name ?? 'error';
      log.warn(`${o.etiqueta}: fallo (${motivo}). Reintento ${intento}/${o.attempts - 1} en ${Math.round(espera / 1000)} s`);
      await sleep(espera);
    }
  }
}
