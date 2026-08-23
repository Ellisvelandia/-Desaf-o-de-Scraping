/**
 * Pruebas de la política de reintentos.
 *
 * Este fichero es la evidencia del requisito 3 del enunciado ("detectar el 429,
 * reintentar con retroceso exponencial, continuar si persiste y registrar qué
 * documentos fallaron"). Por eso cada prueba comprueba un hecho observable y no
 * un detalle de implementación:
 *
 *  - cuántas veces se invocó de verdad la operación,
 *  - cuánto se durmió entre intentos,
 *  - y qué error acaba propagándose cuando ya no se puede seguir.
 *
 * Todo corre sin red y sin dormir de verdad: el retroceso se comprueba llamando
 * a `calcularEspera` directamente, y el único caso que necesita ver pasar el
 * tiempo usa los temporizadores falsos de Jest.
 */
import { CONFIG } from '../config';
import { enteroPositivo } from '../scraper';
import {
  BloqueadoPorWafError,
  calcularEspera,
  esReintentable,
  OpcionesReintento,
  ServidorSaturadoError,
  SesionCaducadaError,
  withRetry,
} from '../utils/retry';

// --------------------------------------------------------------- utilidades

/** Operación instrumentada con su contador de invocaciones. */
interface OperacionEspiada {
  ejecutar: () => Promise<string>;
  readonly llamadas: number;
}

/**
 * Operación que falla las primeras `fallos` veces y luego resuelve.
 *
 * Se escribe a mano en vez de con `jest.fn()` porque lo que estas pruebas
 * afirman es el número EXACTO de invocaciones, y un contador explícito deja ese
 * hecho a la vista en la propia aserción.
 */
function operacion(fallos: number, error: unknown): OperacionEspiada {
  let llamadas = 0;
  return {
    ejecutar: async (): Promise<string> => {
      llamadas++;
      if (llamadas <= fallos) throw error;
      return 'ok';
    },
    get llamadas(): number {
      return llamadas;
    },
  };
}

/** Error con la forma que produce axios ante una respuesta HTTP de error. */
function errorHttp(status: number, cabeceras: Record<string, string> = {}): unknown {
  return { response: { status, headers: cabeceras }, message: `Request failed with status code ${status}` };
}

/** Política completa; cada prueba solo escribe el valor que le importa. */
function politica(extra: Partial<Required<OpcionesReintento>> = {}): Required<OpcionesReintento> {
  return { attempts: 4, baseDelayMs: 2000, maxDelayMs: 60000, jitterMs: 0, etiqueta: 'prueba', ...extra };
}

/**
 * Esperas insignificantes para las pruebas que sí ejecutan `withRetry` con
 * temporizadores reales: ahí lo que se mide es el número de intentos, y dormir
 * de verdad solo alargaría la suite sin comprobar nada más.
 */
const SIN_ESPERA: OpcionesReintento = { baseDelayMs: 1, maxDelayMs: 2, jitterMs: 0, etiqueta: 'prueba' };

/** Operación que nunca deja de fallar. */
const SIEMPRE = Number.POSITIVE_INFINITY;

beforeEach(() => {
  // `withRetry` avisa por consola de cada reintento. Es deseable en producción y
  // ruido en la suite: se silencia la salida, no el logger.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

// ------------------------------------------------- 429: el caso del enunciado

describe('429 (Too Many Requests)', () => {
  it('se reintenta y la operación acaba resolviendo si el servidor se recupera', async () => {
    const op = operacion(2, errorHttp(429));

    await expect(withRetry(op.ejecutar, { ...SIN_ESPERA, attempts: 4 })).resolves.toBe('ok');

    // Dos 429 seguidos de un éxito: tres invocaciones en total.
    expect(op.llamadas).toBe(3);
  });

  it('se propaga el error cuando el 429 persiste, tras agotar exactamente el tope de intentos', async () => {
    const op = operacion(SIEMPRE, errorHttp(429));

    await expect(withRetry(op.ejecutar, { ...SIN_ESPERA, attempts: 3 })).rejects.toMatchObject({
      response: { status: 429 },
    });

    // `attempts` cuenta el primer intento: 3 significa 1 original + 2 reintentos.
    // Que el error se propague es lo que permite al llamante anotar el documento
    // en failed.json y seguir con el siguiente, como pide el enunciado.
    expect(op.llamadas).toBe(3);
  });

  it('un 429 se clasifica como reintentable', () => {
    expect(esReintentable(errorHttp(429))).toBe(true);
  });
});

// ----------------------------------------------- errores que no se reintentan

describe('errores fatales', () => {
  it.each([400, 401, 403, 404, 422])('un %i invoca la operación exactamente UNA vez', async (status) => {
    const op = operacion(SIEMPRE, errorHttp(status));

    await expect(withRetry(op.ejecutar, { ...SIN_ESPERA, attempts: 5 })).rejects.toMatchObject({
      response: { status },
    });

    // Repetir un 403 contra un WAF convierte un bloqueo blando en uno duro.
    expect(op.llamadas).toBe(1);
    expect(esReintentable(errorHttp(status))).toBe(false);
  });

  it('un bloqueo del WAF no se reintenta', async () => {
    const op = operacion(SIEMPRE, new BloqueadoPorWafError());

    await expect(withRetry(op.ejecutar, { ...SIN_ESPERA, attempts: 5 })).rejects.toBeInstanceOf(BloqueadoPorWafError);
    expect(op.llamadas).toBe(1);
  });

  it('una sesión caducada no se reintenta: hay que renovarla, no repetir', async () => {
    const op = operacion(SIEMPRE, new SesionCaducadaError());

    await expect(withRetry(op.ejecutar, { ...SIN_ESPERA, attempts: 5 })).rejects.toBeInstanceOf(SesionCaducadaError);
    expect(op.llamadas).toBe(1);
  });
});

describe('clasificación de errores', () => {
  it.each([408, 500, 502, 503, 504])('un %i es reintentable', (status) => {
    expect(esReintentable(errorHttp(status))).toBe(true);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNABORTED'])('un corte de red %s es reintentable', (code) => {
    expect(esReintentable({ code })).toBe(true);
  });

  it('el servidor saturado del TRF5 (errorUnexpected) es reintentable', () => {
    expect(esReintentable(new ServidorSaturadoError())).toBe(true);
  });

  it('un error sin código ni respuesta HTTP no se reintenta a ciegas', () => {
    expect(esReintentable(new Error('algo raro'))).toBe(false);
    expect(esReintentable({ code: 'EPERM' })).toBe(false);
  });
});

// ------------------------------------------------------ retroceso exponencial

describe('retroceso exponencial', () => {
  it('duplica la espera en cada intento', () => {
    const o = politica({ baseDelayMs: 2000, maxDelayMs: 600000, jitterMs: 0 });

    expect(calcularEspera(errorHttp(429), 1, o)).toBe(2000);
    expect(calcularEspera(errorHttp(429), 2, o)).toBe(4000);
    expect(calcularEspera(errorHttp(429), 3, o)).toBe(8000);
    expect(calcularEspera(errorHttp(429), 4, o)).toBe(16000);
  });

  it('está acotada por maxDelayMs por muchos intentos que se acumulen', () => {
    const o = politica({ baseDelayMs: 2000, maxDelayMs: 10000, jitterMs: 0 });

    // 2 s · 2^6 = 128 s, muy por encima del tope: la espera se recorta.
    expect(calcularEspera(errorHttp(429), 7, o)).toBe(10000);
    expect(calcularEspera(errorHttp(429), 20, o)).toBe(10000);
  });

  it('el jitter añade tiempo pero nunca lo resta', () => {
    const o = politica({ baseDelayMs: 2000, maxDelayMs: 60000, jitterMs: 500 });

    // Se repite porque el jitter es aleatorio: una sola muestra no dice nada.
    for (let i = 0; i < 50; i++) {
      const espera = calcularEspera(errorHttp(429), 1, o);
      // El jitter existe para desincronizar reintentos, no para adelantarlos.
      expect(espera).toBeGreaterThanOrEqual(2000);
      expect(espera).toBeLessThan(2500);
    }
  });

  it('el servidor saturado usa su propia espera larga, no el exponencial', () => {
    const o = politica({ baseDelayMs: 2000, maxDelayMs: 60000, jitterMs: 0 });

    // Su pool de conexiones tarda minutos en recuperarse: 2 s no sirven de nada.
    expect(calcularEspera(new ServidorSaturadoError(), 1, o)).toBe(CONFIG.retry.serverOverloadDelayMs);
  });
});

// ---------------------------------------------------------------- Retry-After

describe('cabecera Retry-After', () => {
  it('manda sobre el exponencial cuando el servidor la envía', () => {
    const o = politica({ baseDelayMs: 2000, maxDelayMs: 60000, jitterMs: 0 });

    // El servidor pide 30 s; el exponencial habría esperado 2 s y vuelto a chocar.
    expect(calcularEspera(errorHttp(429, { 'retry-after': '30' }), 1, o)).toBe(30000);
  });

  it('sigue acotada por maxDelayMs: un Retry-After absurdo no cuelga la ejecución', () => {
    const o = politica({ maxDelayMs: 60000, jitterMs: 0 });

    expect(calcularEspera(errorHttp(429, { 'retry-after': '3600' }), 1, o)).toBe(60000);
  });

  it('un Retry-After no numérico (fecha HTTP) cae al exponencial en vez de romper', () => {
    const o = politica({ baseDelayMs: 2000, maxDelayMs: 60000, jitterMs: 0 });

    expect(calcularEspera(errorHttp(429, { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }), 2, o)).toBe(4000);
  });

  it('withRetry duerme de verdad lo que dice Retry-After antes de repetir', async () => {
    jest.useFakeTimers();
    try {
      const op = operacion(1, errorHttp(429, { 'retry-after': '30' }));
      const promesa = withRetry(op.ejecutar, { attempts: 2, maxDelayMs: 60000, jitterMs: 0, etiqueta: 'prueba' });

      // A los 29 s todavía no se ha vuelto a llamar: la espera se respeta entera.
      await jest.advanceTimersByTimeAsync(29000);
      expect(op.llamadas).toBe(1);

      await jest.advanceTimersByTimeAsync(1000);
      await expect(promesa).resolves.toBe('ok');
      expect(op.llamadas).toBe(2);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------- éxito

describe('camino feliz', () => {
  it('una operación que no falla se invoca una sola vez', async () => {
    const op = operacion(0, errorHttp(429));

    await expect(withRetry(op.ejecutar, SIN_ESPERA)).resolves.toBe('ok');
    expect(op.llamadas).toBe(1);
  });

  it('sin opciones toma la política de CONFIG', async () => {
    const op = operacion(0, errorHttp(429));

    await expect(withRetry(op.ejecutar)).resolves.toBe('ok');
    // Con un solo intento configurado, "reintentos" sería una promesa vacía.
    expect(CONFIG.retry.attempts).toBeGreaterThanOrEqual(2);
  });
});

// ------------------------------------------------- topes leídos del entorno

describe('enteroPositivo (topes de MAX_PAGINAS y MAX_DESCARGAS)', () => {
  it('acepta un entero positivo', () => {
    expect(enteroPositivo('50', 10, 'X')).toBe(50);
  });

  it('un valor ausente o vacío cae al valor por defecto', () => {
    expect(enteroPositivo(undefined, 10, 'X')).toBe(10);
    expect(enteroPositivo('   ', 10, 'X')).toBe(10);
  });

  it('un valor no numérico NO se convierte en NaN: el tope debe seguir existiendo', () => {
    // `Number('quinientas')` es NaN, y `n >= NaN` es siempre falso: el tope
    // desaparecería en silencio justo donde su función es acotar la ejecución.
    expect(enteroPositivo('quinientas', 25, 'MAX_DESCARGAS')).toBe(25);
  });

  it('rechaza cero, negativos y decimales', () => {
    expect(enteroPositivo('0', 25, 'X')).toBe(25);
    expect(enteroPositivo('-3', 25, 'X')).toBe(25);
    expect(enteroPositivo('2.5', 25, 'X')).toBe(25);
  });
});
