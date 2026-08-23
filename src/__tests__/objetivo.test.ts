/**
 * Pruebas de la resolución del objetivo activo.
 *
 * POR QUÉ IMPORTA: el objetivo decide contra QUÉ PORTAL se ejecuta y en qué
 * carpeta se escribe. Equivocarlo no da error: `npm run peru` se pondría a pedir
 * un CAPTCHA del TRF5, o los registros de una jurisdicción acabarían mezclados
 * con los de la otra en el mismo `records.json`.
 *
 * `CONFIG` se resuelve al cargar el módulo, así que cada caso lo recarga en
 * aislamiento con su propio `process.argv` y su propio entorno.
 */
type ModuloConfig = typeof import('../config');

/** Carga `config.ts` de cero con el argv y el TARGET dados. */
function cargarConfig(argv: string[], target?: string): ModuloConfig {
  const argvOriginal = process.argv;
  const targetOriginal = process.env.TARGET;

  process.argv = ['node', 'index.js', ...argv];
  if (target === undefined) delete process.env.TARGET;
  else process.env.TARGET = target;

  let modulo!: ModuloConfig;
  jest.isolateModules(() => {
    modulo = require('../config') as ModuloConfig;
  });

  process.argv = argvOriginal;
  if (targetOriginal === undefined) delete process.env.TARGET;
  else process.env.TARGET = targetOriginal;

  return modulo;
}

describe('objetivo activo', () => {
  it('sin argumento ni TARGET es trf5: el comportamiento de siempre no cambia', () => {
    expect(cargarConfig([]).OBJETIVO).toBe('trf5');
  });

  it('el argumento explícito selecciona el objetivo', () => {
    expect(cargarConfig(['peru', 'fase1']).OBJETIVO).toBe('peru');
    expect(cargarConfig(['trf5', 'fase1']).OBJETIVO).toBe('trf5');
  });

  it('TARGET selecciona el objetivo cuando no hay argumento', () => {
    expect(cargarConfig(['fase1'], 'peru').OBJETIVO).toBe('peru');
  });

  it('un TARGET VACÍO no anula el argumento explícito', () => {
    // El caso real: un job de CI declara `TARGET: ${{ inputs.objetivo }}` y la
    // entrada llega sin valor, así que TARGET existe pero está vacío. Con la
    // precedencia al revés, `npm run peru` ejecutaba el scraper brasileño en
    // silencio: sin error, sin aviso, contra el portal equivocado.
    expect(cargarConfig(['peru', 'completo'], '').OBJETIVO).toBe('peru');
  });

  it('el argumento manda sobre un TARGET con otro valor: es lo más específico', () => {
    expect(cargarConfig(['peru', 'completo'], 'trf5').OBJETIVO).toBe('peru');
  });

  it('un valor desconocido cae en trf5 en vez de fallar', () => {
    expect(cargarConfig(['fase1'], 'marte').OBJETIVO).toBe('trf5');
  });

  it('el objetivo trf5 conserva EXACTAMENTE su carpeta de salida histórica', () => {
    // `path.resolve(..., 'output', '')` ignora el segmento vacío. Si no lo
    // hiciera, la ruta cambiaría y toda la evidencia ya documentada en
    // `docs/evidencia/` apuntaría a un sitio que no existe.
    const { CONFIG } = cargarConfig([]);
    expect(CONFIG.outputDir.endsWith('output')).toBe(true);
    expect(CONFIG.baseUrl).toBe('https://pje.trf5.jus.br');
  });

  it('el objetivo peru escribe en su propia subcarpeta, para no mezclar jurisdicciones', () => {
    // `records.json` y `state.json` se indexan por clave de proceso y guardan la
    // página por la que iba la extracción: compartir carpeta haría que una
    // ejecución peruana reanudara por donde dejó la brasileña.
    const { CONFIG } = cargarConfig(['peru']);
    expect(CONFIG.outputDir.replace(/\\/g, '/').endsWith('output/peru')).toBe(true);
    expect(CONFIG.baseUrl).toBe('https://jurisprudencia.pj.gob.pe');
  });
});
