/**
 * Pruebas del parser de la lista de resultados.
 *
 * Aviso de honestidad, porque condiciona lo que estas pruebas demuestran: la
 * forma exacta de la fila de resultados del TRF5 NO está verificada. El servidor
 * agotó su pool de conexiones antes de devolver una búsqueda con resultados (ver
 * `docs/protocol.md`). Los fixtures de `fixtures/resultados-*.html` son
 * sintéticos: reproducen los marcadores estructurales que RichFaces 3.3 genera
 * siempre (`rich-table`, `rich-table-row`, `tbody` con sufijo `:tb`) y cabeceras
 * plausibles del PJe, no una captura real.
 *
 * Lo que sí demuestran, y es lo que importa:
 *  - que el mapeo por cabecera funciona y que lo desconocido no se pierde;
 *  - que la página real sin resultados devuelve `[]` sin lanzar;
 *  - que una estructura cambiada rompe RUIDOSAMENTE. Esta última es la prueba
 *    más valiosa del fichero: convierte una futura rotura silenciosa (registros
 *    con basura en el campo del número) en un test rojo.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { detectarTotalResultados, EstructuraInesperadaError, parsearProcesos } from '../parser';

function cargar(nombre: string): cheerio.CheerioAPI {
  return cheerio.load(fs.readFileSync(path.join(__dirname, 'fixtures', nombre), 'utf8'));
}

/**
 * Página real del portal (sin resultados), versionada junto a las pruebas.
 *
 * Está en `fixtures/` y no en `output/raw/` porque `output/` está en
 * `.gitignore`: una prueba anclada a un fichero ignorado falla en un clon limpio.
 */
function cargarEvidenciaInicio(): cheerio.CheerioAPI {
  return cargar('portal-inicio.html');
}

// -------------------------------------------------------- página con resultados

describe('parsearProcesos sobre una página de resultados', () => {
  const procesos = parsearProcesos(cargar('resultados-3-filas.html'), 2);

  it('extrae una fila por proceso, sin arrastrar la cabecera', () => {
    expect(procesos).toHaveLength(3);
  });

  it('lee el número CNJ como cadena, con sus ceros a la izquierda intactos', () => {
    expect(procesos.map((p) => p.numeroProcesso)).toEqual([
      '0000001-11.2024.4.05.8300',
      '0000002-22.2023.4.05.8100',
      '0000003-33.2022.4.05.8200',
    ]);
  });

  it('rellena claveUnica con el propio número: esta variante ancla cada fila al CNJ', () => {
    // El contrato de `types.ts` exige `claveUnica` siempre. Aquí no hay filas sin
    // número —este parser las descarta antes—, así que la clave del scraper y el
    // dato del tribunal coinciden y la persistencia indexa igual que siempre.
    expect(procesos.map((p) => p.claveUnica)).toEqual([
      '0000001-11.2024.4.05.8300',
      '0000002-22.2023.4.05.8100',
      '0000003-33.2022.4.05.8200',
    ]);
  });

  it('mapea clase y órgano por su cabecera, con los acentos del portugués intactos', () => {
    expect(procesos[0].classeJudicial).toBe('PROCEDIMENTO COMUM CÍVEL');
    expect(procesos[0].orgaoJulgador).toBe('1ª Vara Federal de Pernambuco');
  });

  it('convierte la fecha brasileña a ISO-8601 sin caer en el orden estadounidense', () => {
    // `new Date('12/03/2024')` habría dicho 3 de diciembre. Es 12 de marzo.
    expect(procesos[0].dataAutuacao).toBe('2024-03-12');
    expect(procesos[1].dataAutuacao).toBe('2023-12-01');
  });

  it('conserva cruda la fecha que no sabe interpretar, en vez de inventarla o tirarla', () => {
    expect(procesos[2].dataAutuacao).toBeUndefined();
    expect(procesos[2].camposExtra?.['data da autuacao']).toBe('Não informada');
  });

  it('manda las columnas desconocidas a camposExtra bajo su cabecera normalizada', () => {
    // "Situação" no es ningún campo del contrato: se conserva, no se descarta.
    expect(procesos[0].camposExtra?.['situacao']).toBe('Em andamento');
    expect(procesos[1].camposExtra?.['situacao']).toBe('Arquivado');
    expect(procesos[2].camposExtra?.['situacao']).toBe('Suspenso');
  });

  it('toma el papel procesal de la cabecera de la columna de partes', () => {
    expect(procesos[0].partes).toEqual([
      { papel: 'Polo Ativo', nombre: 'JOÃO DA SILVA' },
      { papel: 'Polo Passivo', nombre: 'UNIÃO FEDERAL' },
    ]);
  });

  it('separa por <br> las partes que comparten celda', () => {
    expect(procesos[1].partes).toEqual([
      { papel: 'Polo Ativo', nombre: 'MARIA SOUZA' },
      { papel: 'Polo Ativo', nombre: 'PEDRO LIMA' },
      { papel: 'Polo Passivo', nombre: 'INSTITUTO NACIONAL DO SEGURO SOCIAL' },
    ]);
  });

  it('el papel escrito dentro de la celda gana al de la cabecera', () => {
    expect(procesos[2].partes?.[0]).toEqual({ papel: 'AUTOR', nombre: 'EMPRESA XPTO LTDA' });
  });

  it('anota la página de origen que le pasa el recorrido del paginador', () => {
    expect(procesos.every((p) => p.paginaOrigen === 2)).toBe(true);
  });

  it('no promete campos que la tabla no publica', () => {
    // El contrato dice que un dato ausente se omite, no se emite vacío.
    expect(procesos[0].documentos).toBeUndefined();
    expect(procesos[0].archivos).toBeUndefined();
  });
});

// ------------------------------------------------- apertura de la ficha

describe('apertura de la ficha del proceso', () => {
  const procesos = parsearProcesos(cargar('resultados-con-apertura.html'), 1);

  it('elige el control rotulado con el número del proceso, no el primero de la fila', () => {
    // En la fila hay además un enlace de ayuda; tomarlo abriría la página
    // equivocada y la Fase 2 descargaría el documento de otra cosa.
    expect(procesos[0].apertura).toEqual({
      tipo: 'postback',
      formId: 'consultaPublicaForm',
      control: 'consultaPublicaForm:lista:0:verProcesso',
      parametros: { idProcesso: '901' },
    });
  });

  it('acepta el control único de la fila y conserva el jsessionid del href', () => {
    // Reconstruir la URL perdería el `;jsessionid=` que el portal incrusta por
    // reescritura de URL, y con él la sesión.
    expect(procesos[1].apertura).toEqual({
      tipo: 'url',
      url: '/pjeconsulta/ConsultaPublica/DetalheProcessoConsultaPublica.seam;jsessionid=SESION-REDACTADA.node09?idProcesso=902',
    });
  });

  it('NO adivina cuando hay varios controles y ninguno lleva el número', () => {
    // Preferimos que la Fase 2 registre «no sé abrir esta ficha» a que invente
    // una navegación: un `apertura` equivocado produce descargas erróneas con
    // aspecto de correctas, que es el fallo más caro de este scraper.
    expect(procesos[2].apertura).toBeUndefined();
  });

  it('la fila que no publica ningún control utilizable omite el campo', () => {
    // El fixture principal solo trae un `href="#"` con `onclick="return false;"`.
    const sinEnlace = parsearProcesos(cargar('resultados-3-filas.html'), 1);

    expect(sinEnlace.every((p) => p.apertura === undefined)).toBe(true);
  });
});

// --------------------------------------------------------- páginas sin lista

describe('parsearProcesos sobre páginas sin lista de resultados', () => {
  it('la página real de inicio del portal devuelve [] sin lanzar', () => {
    // portal-inicio.html es la respuesta real del TRF5: 15 tablas de maquetación y
    // ninguna lista. Confundir "no hay lista" con "la lista cambió" pararía la
    // extracción en la primera página.
    const $ = cargarEvidenciaInicio();

    expect(parsearProcesos($, 1)).toEqual([]);
  });

  it('un documento vacío devuelve [] sin lanzar', () => {
    expect(parsearProcesos(cheerio.load('<html><body></body></html>'), 1)).toEqual([]);
  });

  it('el mensaje de "nenhum registro encontrado" es una lista vacía, no un fallo', () => {
    const $ = cheerio.load(
      '<table class="rich-table"><tbody id="x:tb">' +
        '<tr class="rich-table-row"><td>Nenhum registro encontrado</td></tr>' +
        '<tr class="rich-table-row"><td>&nbsp;</td></tr>' +
        '</tbody></table>',
    );

    expect(parsearProcesos($, 1)).toEqual([]);
  });
});

// ------------------------------------------------- la prueba que más vale

describe('parsearProcesos ante una estructura cambiada', () => {
  it('lanza EstructuraInesperadaError si la tabla de RichFaces ya no trae números CNJ', () => {
    const $ = cargar('resultados-estructura-cambiada.html');

    // Un parser posicional habría devuelto tres registros con "PROC-2024-000001"
    // en el campo del número y nadie se habría enterado hasta la entrega.
    expect(() => parsearProcesos($, 1)).toThrow(EstructuraInesperadaError);
  });

  it('el error dice qué se leyó, para que el diagnóstico no exija reproducir la ejecución', () => {
    const $ = cargar('resultados-estructura-cambiada.html');

    expect(() => parsearProcesos($, 1)).toThrow(/formato CNJ/);
    expect(() => parsearProcesos($, 1)).toThrow(/PROC-2024-000001/);
  });

  it('lanza si la tabla pierde las cabeceras y no le quedan columnas suficientes', () => {
    // Sin cabeceras el parser cae al plan posicional, que comprueba la forma
    // antes de adivinar. Dos columnas no son una lista de resultados.
    expect(() => parsearProcesos(cargar('resultados-sin-cabeceras.html'), 1)).toThrow(EstructuraInesperadaError);
    expect(() => parsearProcesos(cargar('resultados-sin-cabeceras.html'), 1)).toThrow(/al menos 3/);
  });
});

// ------------------------------------------------------ detectarTotalResultados

describe('detectarTotalResultados', () => {
  it('lee el total de un rango de registros del paginador', () => {
    expect(detectarTotalResultados(cargar('paginador-rango.html'))).toBe(345);
  });

  it('devuelve undefined ante un contador de PÁGINAS, no 10', () => {
    // "Página 3 de 10" son páginas, no registros. Devolver 10 como total haría
    // que el scraper se creyera terminado 335 procesos antes de tiempo.
    expect(detectarTotalResultados(cargar('paginador-paginas.html'))).toBeUndefined();
  });

  it('lee el total del propio texto de la página cuando el portal lo declara', () => {
    const $ = cheerio.load('<html><body><span>Total de registros: 1.234</span></body></html>');

    // Entero brasileño: el punto es separador de millares, no decimal.
    expect(detectarTotalResultados($)).toBe(1234);
  });

  it('lee "N resultados encontrados"', () => {
    const $ = cheerio.load('<html><body><div>58 resultados encontrados</div></body></html>');

    expect(detectarTotalResultados($)).toBe(58);
  });

  it('no confunde el tamaño de página con el total', () => {
    const $ = cheerio.load('<html><body><div>20 processos por p&aacute;gina</div></body></html>');

    expect(detectarTotalResultados($)).toBeUndefined();
  });

  it('devuelve undefined cuando el portal no anuncia ningún total', () => {
    const $ = cargarEvidenciaInicio();

    expect(detectarTotalResultados($)).toBeUndefined();
  });
});
