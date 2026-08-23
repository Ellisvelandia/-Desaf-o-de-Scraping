/**
 * Pruebas de la capa de persistencia.
 *
 * Todo ocurre en un directorio temporal recién creado: `CONFIG.outputDir` se
 * reapunta antes de construir la clase (las rutas se resuelven en el
 * constructor) y se restaura después, para que ninguna prueba escriba en el
 * `output/` real del proyecto ni dependa de lo que dejó la anterior.
 *
 * Lo que se comprueba son las dos garantías que el módulo promete, porque una
 * extracción dura horas y se interrumpe: escritura atómica y lectura defensiva.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CONFIG } from '../config';
import { Persistencia } from '../persistencia';
import { ProcesoJudicial } from '../types';

const OUTPUT_ORIGINAL = CONFIG.outputDir;

let temporal: string;
let persistencia: Persistencia;

/** Proceso mínimo válido; cada prueba retoca solo lo que le interesa. */
function proceso(numero: string, extra: Partial<ProcesoJudicial> = {}): ProcesoJudicial {
  return { numeroProcesso: numero, classeJudicial: 'PROCEDIMENTO COMUM CÍVEL', ...extra };
}

/** Rutas de todos los ficheros que hay bajo el directorio de salida. */
function ficheros(dir: string = temporal): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const ruta = path.join(dir, entrada.name);
    return entrada.isDirectory() ? ficheros(ruta) : [ruta];
  });
}

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  temporal = fs.mkdtempSync(path.join(os.tmpdir(), 'pje-persistencia-'));
  // Se reapunta ANTES de construir: `Persistencia` resuelve sus rutas en el
  // constructor, así que hacerlo después no tendría ningún efecto.
  CONFIG.outputDir = temporal;
  persistencia = new Persistencia();
});

afterEach(() => {
  CONFIG.outputDir = OUTPUT_ORIGINAL;
  fs.rmSync(temporal, { recursive: true, force: true });
});

// ------------------------------------------------------------ deduplicación

describe('anadirProcesos', () => {
  it('inserta los nuevos y devuelve cuántos lo eran de verdad', () => {
    const mapa = new Map<string, ProcesoJudicial>();

    expect(persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300'), proceso('0000002-22.2024.4.05.8300')])).toBe(2);
    expect(mapa.size).toBe(2);
  });

  it('deduplica por numeroProcesso entre páginas y entre ejecuciones', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300')]);

    // La misma fila reaparece en la página siguiente (RichFaces las repite al
    // fijar cabeceras) junto a una nueva: solo debe contar la nueva.
    const nuevos = persistencia.anadirProcesos(mapa, [
      proceso('0000001-11.2024.4.05.8300'),
      proceso('0000003-33.2024.4.05.8300'),
    ]);

    expect(nuevos).toBe(1);
    expect(mapa.size).toBe(2);
  });

  it('no pisa el registro existente con la segunda aparición', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300', { estado: 'completado', archivos: ['a.pdf'] })]);

    persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300', { estado: 'pendiente' })]);

    // Perder el estado 'completado' significaría volver a descargar sus PDF.
    expect(mapa.get('0000001-11.2024.4.05.8300')?.estado).toBe('completado');
    expect(mapa.get('0000001-11.2024.4.05.8300')?.archivos).toEqual(['a.pdf']);
  });

  it('sella vistoEn y estado inicial solo al insertar', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300')]);
    const primerAvistamiento = mapa.get('0000001-11.2024.4.05.8300')?.vistoEn;

    expect(primerAvistamiento).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mapa.get('0000001-11.2024.4.05.8300')?.estado).toBe('pendiente');

    persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300')]);
    // "Primera vez que se vio" dejaría de significar eso si se refrescara.
    expect(mapa.get('0000001-11.2024.4.05.8300')?.vistoEn).toBe(primerAvistamiento);
  });

  it('ignora la fila degenerada sin número de proceso en vez de guardarla sin clave', () => {
    const mapa = new Map<string, ProcesoJudicial>();

    expect(persistencia.anadirProcesos(mapa, [proceso('   '), proceso('0000001-11.2024.4.05.8300')])).toBe(1);
    expect(mapa.size).toBe(1);
  });

  it('el ciclo guardar/cargar conserva los procesos', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300', { orgaoJulgador: '1ª Vara Federal' })]);

    persistencia.guardarProcesos(mapa);
    const recargado = persistencia.cargarProcesos();

    expect(recargado.size).toBe(1);
    expect(recargado.get('0000001-11.2024.4.05.8300')?.orgaoJulgador).toBe('1ª Vara Federal');
  });
});

// -------------------------------------------------------- lectura defensiva

describe('ficheros corruptos', () => {
  it('un records.json ilegible degrada a vacío en vez de tumbar el arranque', () => {
    fs.writeFileSync(CONFIG.recordsPath, '{"0000001-11.2024.4.05.8300": {"numeroProc', 'utf8');

    expect(() => persistencia.cargarProcesos()).not.toThrow();
    expect(persistencia.cargarProcesos().size).toBe(0);
  });

  it('aparta una copia del fichero corrupto: puede tener horas de extracción dentro', () => {
    fs.writeFileSync(CONFIG.recordsPath, 'esto no es json', 'utf8');

    persistencia.cargarProcesos();

    expect(ficheros().some((f) => /records\.json\.corrupto-\d+$/.test(f))).toBe(true);
    expect(fs.existsSync(CONFIG.recordsPath)).toBe(false);
  });

  it('un records.json que es un array (forma antigua) no se interpreta a medias', () => {
    fs.writeFileSync(CONFIG.recordsPath, '[{"numeroProcesso":"0000001-11.2024.4.05.8300"}]', 'utf8');

    expect(persistencia.cargarProcesos().size).toBe(0);
  });

  it('descarta la entrada sin número de proceso y conserva las buenas', () => {
    fs.writeFileSync(
      CONFIG.recordsPath,
      JSON.stringify({
        buena: { numeroProcesso: '0000001-11.2024.4.05.8300' },
        mala: { classeJudicial: 'sin número' },
        peor: { numeroProcesso: '0000002-22.2024.4.05.8300', partes: 'no es un array' },
      }),
      'utf8',
    );

    const mapa = persistencia.cargarProcesos();

    expect([...mapa.keys()]).toEqual(['0000001-11.2024.4.05.8300']);
  });

  it('un fichero ausente es la primera ejecución, no un error', () => {
    expect(persistencia.cargarProcesos().size).toBe(0);
    expect(persistencia.cargarEstado()).toBeUndefined();
    expect(persistencia.cargarFallos()).toEqual([]);
  });

  it('un estado sin ultimaPaginaCompletada se ignora: reanudar por él sería peor que empezar', () => {
    fs.writeFileSync(CONFIG.statePath, '{"criterio":{},"ultimaPaginaCompletada":"tres"}', 'utf8');

    expect(persistencia.cargarEstado()).toBeUndefined();
  });
});

// --------------------------------------------------------- escritura atómica

describe('escritura atómica', () => {
  it('no deja ningún .tmp tras guardar procesos, estado, fallos ni CSV', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300')]);

    persistencia.guardarProcesos(mapa);
    persistencia.guardarEstado({
      criterio: { secao: undefined },
      ultimaPaginaCompletada: 3,
      extraccionCompletada: false,
      actualizadoEn: '',
    });
    persistencia.registrarFallo({ numeroProcesso: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: '429' });
    persistencia.exportarCsv(mapa);

    // Un `.tmp` superviviente confunde al siguiente arranque y, si el fallo fue
    // por disco lleno, retiene el espacio que hace falta para reintentar.
    expect(ficheros().filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(fs.existsSync(CONFIG.recordsPath)).toBe(true);
    expect(fs.existsSync(CONFIG.statePath)).toBe(true);
    expect(fs.existsSync(CONFIG.failedPath)).toBe(true);
  });

  it('el estado guardado sella su propia marca de tiempo', () => {
    persistencia.guardarEstado({
      criterio: {},
      ultimaPaginaCompletada: 7,
      extraccionCompletada: true,
      totalAnunciado: 345,
      // El llamante no sabe cuándo se persistirá: lo sella el escritor.
      actualizadoEn: 'valor que debe ignorarse',
    });

    const estado = persistencia.cargarEstado();

    expect(estado?.ultimaPaginaCompletada).toBe(7);
    expect(estado?.totalAnunciado).toBe(345);
    expect(estado?.actualizadoEn).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ------------------------------------------------------------------- fallos

describe('registrarFallo', () => {
  it('acumula intentos en la entrada existente en vez de duplicarla', () => {
    const fallo = { numeroProcesso: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: '429 persistente' };

    persistencia.registrarFallo(fallo);
    persistencia.registrarFallo({ ...fallo, motivo: '429 otra vez' });
    persistencia.registrarFallo({ ...fallo, motivo: 'HTML en lugar de PDF' });

    const fallos = persistencia.cargarFallos();

    expect(fallos).toHaveLength(1);
    // El contador es lo que permite decidir cuándo rendirse con ese proceso.
    expect(fallos[0].intentos).toBe(3);
    // El motivo refleja el último fallo, no el primero.
    expect(fallos[0].motivo).toBe('HTML en lugar de PDF');
    expect(fallos[0].ultimoIntentoEn).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('separa los fallos del mismo proceso en fases distintas: son dos problemas', () => {
    persistencia.registrarFallo({ numeroProcesso: '0000001-11.2024.4.05.8300', fase: 'ficha', motivo: 'timeout' });
    persistencia.registrarFallo({ numeroProcesso: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: '429' });

    const fallos = persistencia.cargarFallos();

    expect(fallos).toHaveLength(2);
    expect(fallos.map((f) => f.fase).sort()).toEqual(['documento', 'ficha']);
  });

  it('normaliza el contador de una entrada escrita sin intentos', () => {
    // Sin normalizar, el incremento daría NaN y el criterio de "cuántas veces
    // reintentar" dejaría de existir en silencio.
    fs.writeFileSync(CONFIG.failedPath, '[{"numeroProcesso":"0000001-11.2024.4.05.8300","fase":"documento","motivo":"x"}]', 'utf8');

    persistencia.registrarFallo({ numeroProcesso: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: 'y' });

    expect(persistencia.cargarFallos()[0].intentos).toBe(2);
  });
});

// --------------------------------------------------------------------- CSV

describe('exportarCsv', () => {
  it('escribe BOM UTF-8 y filas CRLF para que Excel no destroce los acentos', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [proceso('0000001-11.2024.4.05.8300', { orgaoJulgador: '1ª Vara Federal de Pernambuco' })]);

    const ruta = persistencia.exportarCsv(mapa);
    const contenido = fs.readFileSync(ruta, 'utf8');

    expect(contenido.charCodeAt(0)).toBe(0xfeff);
    expect(contenido).toContain('\r\n');
    expect(contenido).toContain('1ª Vara Federal de Pernambuco');
  });

  it('duplica las comillas internas y entrecomilla siempre, según RFC 4180', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [
      proceso('0000001-11.2024.4.05.8300', {
        orgaoJulgador: '1ª Vara "Federal"',
        // Una coma dentro de un nombre partiría la fila si no se entrecomillara.
        partes: [{ papel: 'AUTOR', nombre: 'FULANO, DE TAL' }],
      }),
    ]);

    const contenido = fs.readFileSync(persistencia.exportarCsv(mapa), 'utf8');
    const filas = contenido.slice(1).split('\r\n');

    expect(filas[0]).toBe(
      '"numeroProcesso","orgaoJulgador","classeJudicial","dataAutuacao","partes","documentos","archivos","estado","paginaOrigen","vistoEn"',
    );
    expect(filas[1]).toContain('"1ª Vara ""Federal"""');
    expect(filas[1]).toContain('"AUTOR: FULANO, DE TAL"');
    // Una sola fila de datos: la coma no partió nada.
    expect(filas.filter((f) => f.length > 0)).toHaveLength(2);
  });

  it('cuenta los documentos en vez de volcarlos, y no revienta con un registro deforme', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    // Simula un records.json escrito por otra versión o editado a mano.
    mapa.set('0000001-11.2024.4.05.8300', {
      numeroProcesso: '0000001-11.2024.4.05.8300',
      documentos: [
        { titulo: 'Petição inicial' },
        { titulo: 'Despacho' },
      ],
      archivos: undefined,
      partes: undefined,
    });

    const contenido = fs.readFileSync(persistencia.exportarCsv(mapa), 'utf8');

    expect(contenido).toContain('"2"');
  });

  it('acepta una ruta de destino explícita', () => {
    const destino = path.join(temporal, 'subcarpeta', 'otro.csv');

    expect(persistencia.exportarCsv(new Map(), destino)).toBe(destino);
    expect(fs.existsSync(destino)).toBe(true);
  });
});
