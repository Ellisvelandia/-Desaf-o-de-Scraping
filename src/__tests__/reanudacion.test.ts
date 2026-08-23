/**
 * Pruebas de la comparación de criterios que gobierna la reanudación.
 *
 * POR QUÉ IMPORTA: `state.json` guarda «última página completada», y ese número
 * solo significa algo dentro de LA MISMA búsqueda. La página 50 de «SILVA» no es
 * la página 50 de «SOUZA». Sin comparar el criterio, cambiar de búsqueda tras una
 * interrupción hacía que el avance rápido saltara las primeras 50 páginas de la
 * búsqueda nueva y las diera por extraídas: 50 páginas perdidas sin un solo error
 * en el log, que es el modo de fallo más caro de este scraper.
 */
import { mismoCriterio } from '../scraper';

describe('mismoCriterio', () => {
  it('reconoce como iguales dos criterios con los mismos pares', () => {
    expect(mismoCriterio({ secao: '0', nomeParte: 'SILVA' }, { nomeParte: 'SILVA', secao: '0' })).toBe(true);
  });

  it('distingue criterios que buscan cosas distintas', () => {
    expect(mismoCriterio({ nomeParte: 'SILVA' }, { nomeParte: 'SOUZA' })).toBe(false);
  });

  it('ignora las claves sin valor, para no descartar una reanudación legítima', () => {
    // `{a:'1'}` y `{a:'1', b:undefined}` describen la misma búsqueda. Un
    // `JSON.stringify` los daría por distintos y tiraría la reanudación solo
    // porque una versión del código añadió un campo opcional que nadie rellenó.
    expect(mismoCriterio({ secao: '0' }, { secao: '0', nomeParte: undefined })).toBe(true);
    expect(mismoCriterio({ secao: '0' }, { secao: '0', nomeParte: '' })).toBe(true);
  });

  it('detecta que se añadió un criterio con valor', () => {
    expect(mismoCriterio({ secao: '0' }, { secao: '0', nomeParte: 'SILVA' })).toBe(false);
  });

  it('dos criterios vacíos son el mismo criterio', () => {
    // Es el caso del portal peruano, cuyo buscador acepta una consulta sin filtros.
    expect(mismoCriterio({}, {})).toBe(true);
  });
});
