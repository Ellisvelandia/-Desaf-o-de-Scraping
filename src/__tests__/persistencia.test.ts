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

/**
 * Proceso mínimo válido; cada prueba retoca solo lo que le interesa.
 *
 * En un proceso con número, `claveUnica` ES el número: es lo que emiten los dos
 * parsers, y así estas pruebas siguen ejerciendo la deduplicación por número.
 */
function proceso(numero: string, extra: Partial<ProcesoJudicial> = {}): ProcesoJudicial {
  return { claveUnica: numero, numeroProcesso: numero, classeJudicial: 'PROCEDIMENTO COMUM CÍVEL', ...extra };
}

/**
 * Proceso en segredo de justiça: clave derivada del `ca=` de su ficha, sin
 * número, tal como lo emite `parserModerno`.
 */
function procesoEnSigilo(ca: string, extra: Partial<ProcesoJudicial> = {}): ProcesoJudicial {
  return { claveUnica: `sigilo:${ca}`, enSigilo: true, classeJudicial: 'PROCEDIMENTO DO JUIZADO ESPECIAL CÍVEL', ...extra };
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

  // ------------------------------------------------------ segredo de justiça

  it('dos procesos en sigilo distintos NO se funden en uno solo', () => {
    // El fallo que esta prueba impide: indexar por `numeroProcesso` cuando ese
    // campo no existe. Los dos registros compartirían clave (undefined, o peor,
    // una cadena vacía), el segundo se tomaría por duplicado del primero y el
    // scraper informaría de una deduplicación que en realidad es pérdida.
    const mapa = new Map<string, ProcesoJudicial>();

    const insertados = persistencia.anadirProcesos(mapa, [
      procesoEnSigilo('23300a04caaa9cb7577fde2acd412921f12508038c5c97a5'),
      procesoEnSigilo('596acaa9b1d471e7577fde2acd412921f12508038c5c97a5'),
    ]);

    expect(insertados).toBe(2);
    expect(mapa.size).toBe(2);
    expect([...mapa.keys()]).toEqual([
      'sigilo:23300a04caaa9cb7577fde2acd412921f12508038c5c97a5',
      'sigilo:596acaa9b1d471e7577fde2acd412921f12508038c5c97a5',
    ]);
    // Y ninguno de los dos ha ganado un número de proceso por el camino.
    for (const guardado of mapa.values()) {
      expect(guardado.numeroProcesso).toBeUndefined();
      expect(guardado.enSigilo).toBe(true);
    }
  });

  it('el mismo proceso en sigilo repetido entre páginas sí se deduplica', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [procesoEnSigilo('23300a04caaa9cb7577fde2acd412921f12508038c5c97a5')]);

    const nuevos = persistencia.anadirProcesos(mapa, [
      procesoEnSigilo('23300a04caaa9cb7577fde2acd412921f12508038c5c97a5'),
    ]);

    expect(nuevos).toBe(0);
    expect(mapa.size).toBe(1);
  });

  it('el ciclo guardar/cargar conserva un proceso en sigilo sin inventarle número', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [procesoEnSigilo('23300a04caaa9cb7577fde2acd412921f12508038c5c97a5')]);

    persistencia.guardarProcesos(mapa);
    const recargado = persistencia.cargarProcesos();

    const guardado = recargado.get('sigilo:23300a04caaa9cb7577fde2acd412921f12508038c5c97a5');
    expect(recargado.size).toBe(1);
    expect(guardado?.enSigilo).toBe(true);
    expect(guardado?.numeroProcesso).toBeUndefined();
    expect(guardado?.classeJudicial).toBe('PROCEDIMENTO DO JUIZADO ESPECIAL CÍVEL');
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

  it('descarta la entrada sin ninguna clave utilizable y conserva las buenas', () => {
    fs.writeFileSync(
      CONFIG.recordsPath,
      JSON.stringify({
        buena: { claveUnica: '0000001-11.2024.4.05.8300', numeroProcesso: '0000001-11.2024.4.05.8300' },
        mala: { classeJudicial: 'ni clave ni número' },
        peor: { claveUnica: '0000002-22.2024.4.05.8300', partes: 'no es un array' },
      }),
      'utf8',
    );

    const mapa = persistencia.cargarProcesos();

    expect([...mapa.keys()]).toEqual(['0000001-11.2024.4.05.8300']);
  });

  it('un records.json del formato anterior (solo numeroProcesso) se migra al cargarlo', () => {
    // Sin esta migración, actualizar el scraper descartaría en silencio todo lo
    // ya extraído —incluido el `estado: completado`— y la pasada siguiente
    // volvería a bajar los mismos PDF.
    fs.writeFileSync(
      CONFIG.recordsPath,
      JSON.stringify({
        '0000001-11.2024.4.05.8300': {
          numeroProcesso: '0000001-11.2024.4.05.8300',
          estado: 'completado',
          archivos: ['a.pdf'],
        },
      }),
      'utf8',
    );

    const mapa = persistencia.cargarProcesos();
    const guardado = mapa.get('0000001-11.2024.4.05.8300');

    expect(mapa.size).toBe(1);
    // La clave derivada es el número, que es exactamente lo que emite el parser
    // para un proceso que sí lo publica: el fichero migrado y uno nuevo coinciden.
    expect(guardado?.claveUnica).toBe('0000001-11.2024.4.05.8300');
    expect(guardado?.numeroProcesso).toBe('0000001-11.2024.4.05.8300');
    expect(guardado?.estado).toBe('completado');
    expect(guardado?.archivos).toEqual(['a.pdf']);
  });

  it('un failed.json del formato anterior conserva sus intentos ya contados', () => {
    fs.writeFileSync(
      CONFIG.failedPath,
      '[{"numeroProcesso":"0000001-11.2024.4.05.8300","fase":"documento","motivo":"429","intentos":3}]',
      'utf8',
    );

    const fallos = persistencia.cargarFallos();

    expect(fallos).toHaveLength(1);
    expect(fallos[0].claveUnica).toBe('0000001-11.2024.4.05.8300');
    expect(fallos[0].intentos).toBe(3);
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
    persistencia.registrarFallo({ claveUnica: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: '429' });
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
    const fallo = { claveUnica: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: '429 persistente' };

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
    persistencia.registrarFallo({ claveUnica: '0000001-11.2024.4.05.8300', fase: 'ficha', motivo: 'timeout' });
    persistencia.registrarFallo({ claveUnica: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: '429' });

    const fallos = persistencia.cargarFallos();

    expect(fallos).toHaveLength(2);
    expect(fallos.map((f) => f.fase).sort()).toEqual(['documento', 'ficha']);
  });

  it('separa los fallos de DOS documentos distintos del mismo proceso', () => {
    // El enunciado pide «registrar qué documentos fallaron para poder
    // reintentarlos después». Con la clave anterior —(proceso, fase) a secas—
    // dos documentos que fallan una vez cada uno producían UNA entrada con
    // `intentos: 2`, indistinguible de un documento que falló dos veces: del
    // fichero no se podía recuperar cuáles eran, que es justo lo que se pide.
    const proceso = '0000001-11.2024.4.05.8300';
    persistencia.registrarFallo({
      claveUnica: proceso,
      fase: 'documento',
      documento: { id: '16026033', titulo: 'Despacho' },
      motivo: '429 persistente',
    });
    persistencia.registrarFallo({
      claveUnica: proceso,
      fase: 'documento',
      documento: { id: '16026096', titulo: 'Acórdão' },
      motivo: 'HTML en lugar de PDF',
    });

    const fallos = persistencia.cargarFallos();

    expect(fallos).toHaveLength(2);
    expect(fallos.map((f) => f.documento?.id).sort()).toEqual(['16026033', '16026096']);
    // Cada uno cuenta SUS intentos, que es lo que sirve para decidir cuándo
    // rendirse con ese documento concreto.
    expect(fallos.every((f) => f.intentos === 1)).toBe(true);
  });

  it('acumula intentos del MISMO documento en una sola entrada', () => {
    const fallo = {
      claveUnica: '0000001-11.2024.4.05.8300',
      fase: 'documento',
      documento: { id: '16026033', titulo: 'Despacho' },
      motivo: '429',
    };
    persistencia.registrarFallo(fallo);
    persistencia.registrarFallo({ ...fallo, motivo: '429 otra vez' });

    const fallos = persistencia.cargarFallos();
    expect(fallos).toHaveLength(1);
    expect(fallos[0].intentos).toBe(2);
  });

  it('sin id, distingue los documentos por su título', () => {
    const base = { claveUnica: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: '429' };
    persistencia.registrarFallo({ ...base, documento: { titulo: 'Petição inicial' } });
    persistencia.registrarFallo({ ...base, documento: { titulo: 'Certidão' } });

    expect(persistencia.cargarFallos()).toHaveLength(2);
  });

  it('sin id y con el mismo título, distingue por el descriptor de descarga', () => {
    // El caso del PJe: la ficha repite «Despacho» sin id. ServicioDescarga ya
    // hashea el descriptor para el nombre del fichero; failed.json tiene que
    // usar la misma identidad, o dos fallos distintos colapsan en una entrada
    // con un contador de intentos compartido y el fichero no dice cuál falló.
    const base = { claveUnica: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: '429' };
    const titulo = 'Despacho';
    persistencia.registrarFallo({
      ...base,
      documento: { titulo, descarga: { tipo: 'url', url: '/pjeconsulta/documento.seam?id=aaa' } },
    });
    persistencia.registrarFallo({
      ...base,
      documento: { titulo, descarga: { tipo: 'url', url: '/pjeconsulta/documento.seam?id=bbb' } },
    });

    const fallos = persistencia.cargarFallos();
    expect(fallos).toHaveLength(2);
    expect(fallos.every((f) => f.intentos === 1)).toBe(true);
    expect(fallos.every((f) => f.documento?.titulo === titulo)).toBe(true);
  });

  it('sin id, el mismo descriptor acumula intentos en una sola entrada', () => {
    const fallo = {
      claveUnica: '0000001-11.2024.4.05.8300',
      fase: 'documento' as const,
      documento: {
        titulo: 'Despacho',
        descarga: { tipo: 'url' as const, url: '/pjeconsulta/documento.seam?id=aaa' },
      },
      motivo: '429',
    };
    persistencia.registrarFallo(fallo);
    persistencia.registrarFallo({ ...fallo, motivo: '429 otra vez' });

    const fallos = persistencia.cargarFallos();
    expect(fallos).toHaveLength(1);
    expect(fallos[0].intentos).toBe(2);
  });

  it('los fallos que no son de un documento siguen deduplicando por proceso y fase', () => {
    // Una página o una ficha no tienen documento; su clave no debe cambiar de
    // comportamiento por haber añadido el campo nuevo.
    persistencia.registrarFallo({ claveUnica: 'pagina-340', fase: 'pagina', motivo: '429' });
    persistencia.registrarFallo({ claveUnica: 'pagina-340', fase: 'pagina', motivo: '429 de nuevo' });

    const fallos = persistencia.cargarFallos();
    expect(fallos).toHaveLength(1);
    expect(fallos[0].intentos).toBe(2);
  });

  it('normaliza el contador de una entrada escrita sin intentos', () => {
    // Sin normalizar, el incremento daría NaN y el criterio de "cuántas veces
    // reintentar" dejaría de existir en silencio.
    fs.writeFileSync(CONFIG.failedPath, '[{"numeroProcesso":"0000001-11.2024.4.05.8300","fase":"documento","motivo":"x"}]', 'utf8');

    persistencia.registrarFallo({ claveUnica: '0000001-11.2024.4.05.8300', fase: 'documento', motivo: 'y' });

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
      '"claveUnica","numeroProcesso","enSigilo","orgaoJulgador","classeJudicial","dataAutuacao","partes",' +
        '"documentos","archivos","estado","paginaOrigen","vistoEn"',
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
      claveUnica: '0000001-11.2024.4.05.8300',
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

  it('un proceso en sigilo sale con su clave, la columna de número VACÍA y enSigilo', () => {
    const mapa = new Map<string, ProcesoJudicial>();
    persistencia.anadirProcesos(mapa, [
      proceso('0000001-11.2024.4.05.8300'),
      procesoEnSigilo('23300a04caaa9cb7577fde2acd412921f12508038c5c97a5'),
    ]);

    const contenido = fs.readFileSync(persistencia.exportarCsv(mapa), 'utf8');
    const filas = contenido.slice(1).split('\r\n');

    // Fila del proceso normal: las dos primeras columnas coinciden.
    expect(filas[1]?.startsWith('"0000001-11.2024.4.05.8300","0000001-11.2024.4.05.8300","false"')).toBe(true);
    // Fila del proceso en sigilo: clave sí, número NO. La celda vacía es el dato
    // correcto —«el tribunal no lo publica»— y `enSigilo` dice por qué.
    expect(
      filas[2]?.startsWith('"sigilo:23300a04caaa9cb7577fde2acd412921f12508038c5c97a5","","true"'),
    ).toBe(true);
    // Y en ninguna parte del fichero aparece un `undefined` disfrazado de dato.
    expect(contenido).not.toContain('undefined');
  });

  it('acepta una ruta de destino explícita', () => {
    const destino = path.join(temporal, 'subcarpeta', 'otro.csv');

    expect(persistencia.exportarCsv(new Map(), destino)).toBe(destino);
    expect(fs.existsSync(destino)).toBe(true);
  });
});
