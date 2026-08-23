/**
 * Pruebas del contrato de paginación.
 *
 * POR QUÉ EXISTEN: `paginacion.ts` decide si la Fase 1 recorre el portal entero
 * o se queda en la primera página, y hasta ahora era el único módulo del camino
 * crítico sin una sola prueba. Eso importa más de lo que parece, porque su modo
 * de fallo NO es una excepción: `detectarPaginacion` devuelve `undefined`, el
 * orquestador lo interpreta como «no hay más páginas» y la ejecución termina en
 * verde habiendo extraído una página de cuarenta. Un fallo así no se ve en los
 * logs; solo se ve en el recuento final, y solo si alguien lo mira.
 *
 * Todo es sin red, sobre HTML sintético que reproduce lo que emite RichFaces 3.3.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

import { construirOpcionesPagina, detectarPaginacion, hayPaginaSiguiente } from '../paginacion';

function cargar(nombre: string): cheerio.CheerioAPI {
  return cheerio.load(fs.readFileSync(path.join(__dirname, 'fixtures', nombre), 'utf8'));
}

describe('detectarPaginacion', () => {
  it('lee el scroller clásico completo: id, formulario, página actual y ventana', () => {
    const control = detectarPaginacion(cargar('paginador-datascroller.html'));
    expect(control).toEqual({
      tipo: 'datascroller',
      id: 'consultaPublicaForm:scroller',
      formId: 'consultaPublicaForm',
      // El control «pulsado» NO puede ser el id del scroller: el cuerpo A4J
      // enviaría dos veces ese nombre (`…=<id>` y `…=<n>`) y el contenedor
      // entrega a JSF el PRIMER valor, con lo que el datascroller recibiría un
      // texto donde espera un número y la lista se quedaría en la misma página.
      control: 'consultaPublicaForm',
      parametros: { ajaxSingle: 'consultaPublicaForm:scroller' },
      paginaActual: 3,
      ultimaPagina: 5,
    });
  });

  it('no confunde los valores simbólicos de los botones con números de página', () => {
    // El fixture tiene botones con 'first' y 'next'. Si se tomaran por números,
    // `ultimaPagina` saldría absurda y el recorrido se rompería.
    const control = detectarPaginacion(cargar('paginador-datascroller.html'));
    expect(control?.ultimaPagina).toBe(5);
    expect(control?.paginaActual).toBe(3);
  });

  it('analiza el onclick aunque `parameters` no sea la primera clave de las opciones', () => {
    // RichFaces antepone `oncomplete` cuando el componente declara un manejador.
    // Asumir que `parameters` va primero rompería la detección en esas instancias.
    const $ = cheerio.load(
      '<form id="fPP"><table class="rich-dtascroller-table">' +
        '<tr><td class="rich-datascr-inact" onclick="A4J.AJAX.Submit(\'fPP\',event,' +
        "{'oncomplete':function(r,e,d){},'parameters':{'fPP:sc':'7','ajaxSingle':'fPP:sc'} ,'actionUrl':'/x'} )\">7</td></tr>" +
        '</table></form>',
    );
    const control = detectarPaginacion($);
    expect(control?.id).toBe('fPP:sc');
    expect(control?.formId).toBe('fPP');
  });

  it('devuelve undefined ante el hueco de paginación vacío de la plantilla moderna', () => {
    // Caso REAL, no teórico: sin filtros el portal renderiza el contenedor sin
    // nada dentro. Debe tratarse como «no hay paginador», nunca lanzar.
    expect(detectarPaginacion(cheerio.load('<div title="Paginação"></div>'))).toBeUndefined();
  });

  it('devuelve undefined en una página sin ningún paginador', () => {
    expect(detectarPaginacion(cheerio.load('<html><body><p>sin resultados</p></body></html>'))).toBeUndefined();
  });
});

describe('construirOpcionesPagina', () => {
  it('pone el número de página bajo el client-id del scroller y conserva ajaxSingle', () => {
    const control = detectarPaginacion(cargar('paginador-datascroller.html'))!;
    expect(construirOpcionesPagina(control, 4)).toEqual({
      formId: 'consultaPublicaForm',
      control: 'consultaPublicaForm',
      parametros: {
        'consultaPublicaForm:scroller': '4',
        ajaxSingle: 'consultaPublicaForm:scroller',
      },
    });
  });

  it('no muta el control entre llamadas: dos páginas seguidas dan dos cuerpos distintos', () => {
    // `construirOpcionesPagina` copia los parámetros; si los reutilizara, la
    // segunda página heredaría el número de la primera.
    const control = detectarPaginacion(cargar('paginador-datascroller.html'))!;
    const p2 = construirOpcionesPagina(control, 2);
    const p9 = construirOpcionesPagina(control, 9);
    expect(p2.parametros?.['consultaPublicaForm:scroller']).toBe('2');
    expect(p9.parametros?.['consultaPublicaForm:scroller']).toBe('9');
    expect(control.parametros).toEqual({ ajaxSingle: 'consultaPublicaForm:scroller' });
  });

  it('rechaza un número de página que no es un entero positivo', () => {
    const control = detectarPaginacion(cargar('paginador-datascroller.html'))!;
    expect(() => construirOpcionesPagina(control, 0)).toThrow(/inválido/);
    expect(() => construirOpcionesPagina(control, -1)).toThrow(/inválido/);
    expect(() => construirOpcionesPagina(control, 1.5)).toThrow(/inválido/);
    expect(() => construirOpcionesPagina(control, NaN)).toThrow(/inválido/);
  });
});

describe('hayPaginaSiguiente', () => {
  it('sin control, no hay siguiente', () => {
    expect(hayPaginaSiguiente(undefined, 1)).toBe(false);
  });

  it('hay siguiente mientras la página actual no alcance el último número dibujado', () => {
    const control = detectarPaginacion(cargar('paginador-datascroller.html'))!;
    expect(hayPaginaSiguiente(control, 3)).toBe(true);
    expect(hayPaginaSiguiente(control, 4)).toBe(true);
  });

  it('se detiene en el último número de la ventana, que el llamante debe re-detectar', () => {
    // `ultimaPagina` es el mayor número DIBUJADO, no el total: RichFaces usa una
    // ventana deslizante. Por eso el orquestador vuelve a detectar el control en
    // cada página y corrobora el final con páginas vacías consecutivas.
    const control = detectarPaginacion(cargar('paginador-datascroller.html'))!;
    expect(hayPaginaSiguiente(control, 5)).toBe(false);
  });

  it('ante la duda responde true: sin último número conocido, se pide la siguiente', () => {
    // Pedir una página de más cuesta una petición; pararse de más pierde datos
    // en silencio, que es el fallo caro.
    expect(hayPaginaSiguiente({ tipo: 'datascroller', id: 'x', formId: 'f', control: 'f' }, 99)).toBe(true);
  });
});
