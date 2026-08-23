/**
 * Pruebas del objetivo peruano (Jurisprudencia Nacional Sistematizada), sin red.
 *
 * QUÉ VALEN Y QUÉ NO, dicho antes de que nadie las sobreinterprete: fijan el
 * contrato del parser y del protocolo parcial de JSF 2 contra la ESTRUCTURA que
 * se leyó del portal en vivo (ver la cabecera de `fixtures/peru-resultados.html`
 * para la procedencia exacta del marcado). No demuestran que el portal siga
 * respondiendo hoy: eso solo lo demuestra una ejecución real, y esa exige salir
 * desde Perú porque el WAF responde 403 a cualquier otra IP.
 *
 * Lo que sí cubren es el conjunto de decisiones donde un scraper de este tipo se
 * rompe en silencio: indexar por rótulo en vez de por posición, no confundir el
 * total de páginas con el de registros, no inventar clave cuando falta el
 * expediente, y no dar por aplicada una respuesta que no es la que se esperaba.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

import { EstructuraInesperadaError } from '../errores';
import { aplicarRespuestaParcial, construirCuerpoParcial, esRespuestaParcial } from '../jsf/partial';
import {
  detectarPaginaActual,
  detectarTotalPaginas,
  hayPaginaSiguiente,
  parsearResoluciones,
} from '../peru/parser';
import { extraerParametrosJsfcljs } from '../peru/session';

function cargar(nombre: string): cheerio.CheerioAPI {
  return cheerio.load(fs.readFileSync(path.join(__dirname, 'fixtures', nombre), 'utf8'));
}

function crudo(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', nombre), 'utf8');
}

beforeEach(() => {
  // El parser avisa por consola de los paneles descartados; no debe ensuciar la
  // salida de la suite, pero sigue siendo observable con el espía.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('parser de resultados', () => {
  it('extrae las resoluciones identificables y descarta solo las que no tienen ninguna clave', () => {
    const resoluciones = parsearResoluciones(cargar('peru-resultados.html'), 1);
    // Cinco paneles en el fixture; solo uno —sin expediente y sin enlace— cae.
    expect(resoluciones).toHaveLength(4);
  });

  it('NO funde dos resoluciones del mismo expediente cuando ninguna publica PDF', () => {
    // Es el caso real de una casación y su aclaración. Con la clave
    // `exp:<expediente>` a secas compartían clave, la segunda se descartaba por
    // duplicada y desaparecía sin entrada en failed.json.
    const resoluciones = parsearResoluciones(cargar('peru-resultados.html'), 1);
    const delMismoExpediente = resoluciones.filter((r) => r.numeroProcesso === '029269-2025');

    expect(delMismoExpediente).toHaveLength(2);
    expect(delMismoExpediente[0].claveUnica).not.toBe(delMismoExpediente[1].claveUnica);
    expect(delMismoExpediente.map((r) => r.classeJudicial)).toEqual(['Casación', 'Aclaración']);
  });

  it('la clave de respaldo es estable: el mismo panel da la misma clave dos veces', () => {
    // Si no lo fuera, cada pasada crearía registros nuevos y la deduplicación
    // dejaría de servir para nada.
    const primera = parsearResoluciones(cargar('peru-resultados.html'), 1);
    const segunda = parsearResoluciones(cargar('peru-resultados.html'), 1);

    expect(primera.map((r) => r.claveUnica)).toEqual(segunda.map((r) => r.claveUnica));
  });

  it('avisa por log del panel descartado en vez de tirarlo en silencio', () => {
    const aviso = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    parsearResoluciones(cargar('peru-resultados.html'), 1);
    const lineas = aviso.mock.calls.map((c) => String(c[0]));
    expect(lineas.some((l) => /panel\(es\) sin expediente ni enlace utilizable/.test(l))).toBe(true);
  });

  it('mapea al contrato los campos con sitio propio y manda el resto a camposExtra', () => {
    const [primera] = parsearResoluciones(cargar('peru-resultados.html'), 1);

    expect(primera.numeroProcesso).toBe('037233-2025');
    expect(primera.classeJudicial).toBe('Apelación');
    expect(primera.orgaoJulgador).toBe('Quinta Sala de Derecho Constitucional y Social Transitoria');
    expect(primera.dataAutuacao).toBe('2026-08-14');
    expect(primera.paginaOrigen).toBe(1);

    // Todo rótulo no mapeado sobrevive, que es como se cumple «extraer toda la
    // información disponible» sin tener que enumerarla de antemano.
    expect(primera.camposExtra).toMatchObject({
      'pretension delito': 'Acción de Amparo',
      'tipo resolucion': 'Ejecutoria Suprema',
      'norma de derecho interno': 'Artículo 200 de la Constitución Política del Perú',
      'palabras clave': 'Artículo 1 de la Constitución Política del Perú, numeral 2 del artículo V',
    });
    expect(primera.camposExtra?.['sumilla']).toMatch(/tercero no ocupante/);

    // Un rótulo ya volcado al contrato no se duplica en camposExtra.
    expect(primera.camposExtra).not.toHaveProperty('sala suprema');
    expect(primera.camposExtra).not.toHaveProperty('fecha resolucion');
  });

  it('publica el PDF como descarga directa, con el uuid por id', () => {
    const [primera] = parsearResoluciones(cargar('peru-resultados.html'), 1);
    expect(primera.documentos).toHaveLength(1);
    const documento = primera.documentos![0];
    expect(documento.id).toBe('aaaaaaaa-1111-4bbb-8ccc-dddddddddddd');
    expect(documento.titulo).toBe('Resolucion 037233-2025');
    expect(documento.descarga).toEqual({
      tipo: 'url',
      url: '/jurisprudenciaweb/ServletDescarga?uuid=aaaaaaaa-1111-4bbb-8ccc-dddddddddddd',
    });
  });

  it('NO emite apertura: «Ver Ficha» es un postback RichFaces con href="#", no una URL', () => {
    // Verificado en el portal en vivo. Emitirlo como `url` haría que la Fase 2
    // pidiera la misma página de resultados creyendo abrir la ficha.
    const [primera] = parsearResoluciones(cargar('peru-resultados.html'), 1);
    expect(primera.apertura).toBeUndefined();
  });

  it('deriva la clave del uuid cuando el panel no publica expediente, sin inventar el número', () => {
    const [, segunda] = parsearResoluciones(cargar('peru-resultados.html'), 1);
    expect(segunda.claveUnica).toBe('bbbbbbbb-2222-4ccc-8ddd-eeeeeeeeeeee');
    // El campo del portal se omite en lugar de rellenarse con un sustituto.
    expect(segunda.numeroProcesso).toBeUndefined();
  });

  it('la clave es el uuid del documento y no el expediente, para no fundir resoluciones del mismo expediente', () => {
    const [primera] = parsearResoluciones(cargar('peru-resultados.html'), 1);
    expect(primera.claveUnica).toBe('aaaaaaaa-1111-4bbb-8ccc-dddddddddddd');
  });

  it('descarta una fecha imposible en vez de dejar que Date la desplace de mes', () => {
    // El fixture trae 31/02/2026 en la segunda resolución. `new Date` lo
    // convertiría en marzo sin avisar; aquí no debe emitirse como fecha.
    const [, segunda] = parsearResoluciones(cargar('peru-resultados.html'), 1);
    expect(segunda.dataAutuacao).toBeUndefined();
    // Pero el literal del portal no se pierde: queda en camposExtra.
    expect(segunda.camposExtra?.['fecha resolucion']).toBe('31/02/2026');
  });

  it('devuelve lista vacía cuando la página no trae ningún panel', () => {
    expect(parsearResoluciones(cheerio.load('<html><body><p>Sin resultados</p></body></html>'), 1)).toEqual([]);
  });

  it('lanza EstructuraInesperadaError si hay paneles pero ninguno es identificable', () => {
    // Es la señal de que la plantilla cambió. Detenerse con el HTML delante vale
    // más que devolver filas a medias que nadie revisará hasta la entrega.
    const roto = cheerio.load(
      '<div class="rf-p"><div class="rf-p-hdr"><span>Apelación</span></div>' +
        '<div class="rf-p-b"><div class="txtbold">Sumilla:</div><div>algo</div></div></div>',
    );
    expect(() => parsearResoluciones(roto, 7)).toThrow(EstructuraInesperadaError);
    expect(() => parsearResoluciones(roto, 7)).toThrow(/página 7/);
  });
});

describe('paginador', () => {
  it('lee el total como PÁGINAS, que es lo que anuncia el portal', () => {
    // Confundirlo con un total de registros daría por terminada la extracción
    // nada más superar las primeras páginas. Y el fixture trae, a propósito, una
    // sumilla con «de la Constitución Política de 1993» y «Decreto Legislativo
    // 768»: con una detección laxa el total habría salido 1993 y la extracción
    // se habría dado por completa en el 13 % del corpus, sin un error en el log.
    expect(detectarTotalPaginas(cargar('peru-resultados.html'))).toBe(15247);
  });

  it('no confunde una cita legal con el contador de páginas', () => {
    const soloProsa = cheerio.load(
      '<div><p>conforme al artículo 2 de la Constitución Política de 1993 y al Decreto Legislativo 768</p></div>',
    );
    expect(detectarTotalPaginas(soloProsa)).toBeUndefined();
  });

  it('lee el contador aunque el portal lo reparta entre varios nodos', () => {
    // El portal pinta «Página:» en un span, la página actual dentro de un <input>
    // —cuyo valor no es texto del nodo— y «de N» como texto suelto del padre. Por
    // eso la detección no puede exigir un nodo hoja.
    const repartido = cheerio.load(
      '<div class="wrap"><div class="pag"><span>Página:</span><input value="3" /> de 4321 <a>IR</a></div></div>',
    );
    expect(detectarTotalPaginas(repartido)).toBe(4321);
  });

  it('lee la página activa del botón marcado', () => {
    expect(detectarPaginaActual(cargar('peru-resultados.html'))).toBe(1);
  });

  it('reconoce que hay página siguiente cuando el botón «»» está vivo', () => {
    expect(hayPaginaSiguiente(cargar('peru-resultados.html'), 1)).toBe(true);
  });

  it('sin botón siguiente, se apoya en que exista un número mayor que el actual', () => {
    const sinSiguiente = cheerio.load(
      '<span class="rf-ds"><a class="rf-ds-nmb-btn">4</a><span class="rf-ds-nmb-btn rf-ds-act">5</span></span>',
    );
    expect(hayPaginaSiguiente(sinSiguiente, 5)).toBe(false);
    expect(hayPaginaSiguiente(sinSiguiente, 3)).toBe(true);
  });
});

describe('protocolo parcial de JSF 2', () => {
  it('distingue una respuesta parcial de una página HTML completa', () => {
    expect(esRespuestaParcial(crudo('peru-partial-actualizacion.xml'))).toBe(true);
    // El portal expulsa una sesión devolviendo 200 con la página de entrada. Si
    // se aplicara igualmente, no actualizaría nada y el scraper repaginaría sobre
    // la misma página informando de un avance que no existe.
    expect(esRespuestaParcial('<html><body>página de entrada</body></html>')).toBe(false);
  });

  it('sustituye el componente actualizado y recoge el ViewState nuevo', () => {
    const $doc = cargar('peru-resultados.html');
    const resultado = aplicarRespuestaParcial($doc, crudo('peru-partial-actualizacion.xml'));

    expect(resultado.idsActualizados).toEqual(['formBuscador:data1']);
    expect(resultado.viewState).toBe('VIEWSTATE-NUEVO-TRAS-SALTAR');
    // El CDATA sobrevivió al parseo en dos etapas: el documento vigente refleja
    // ya la página 2 como activa.
    expect(detectarPaginaActual($doc)).toBe(2);
    // Y el ViewState del documento queda sincronizado, o el POST siguiente
    // viajaría con una vista que el servidor ya no reconoce.
    expect($doc('input[name="javax.faces.ViewState"]').attr('value')).toBe('VIEWSTATE-NUEVO-TRAS-SALTAR');
  });

  it('señala la redirección en vez de tratarla como una actualización vacía', () => {
    const $doc = cargar('peru-resultados.html');
    const resultado = aplicarRespuestaParcial($doc, crudo('peru-partial-redireccion.xml'));
    expect(resultado.redireccion).toBe('/jurisprudenciaweb/faces/page/inicio.xhtml');
    expect(resultado.idsActualizados).toEqual([]);
  });

  it('no añade al body un id que el documento vigente no tiene', () => {
    // Añadirlo produciría dos elementos con el mismo id y el scraper acabaría
    // leyendo el equivocado. Omitirlo deja el hecho visible en idsActualizados.
    const $doc = cheerio.load('<html><body><div id="presente">viejo</div></body></html>');
    const resultado = aplicarRespuestaParcial(
      $doc,
      '<partial-response><changes><update id="ausente"><![CDATA[<div id="ausente">nuevo</div>]]></update></changes></partial-response>',
    );
    expect(resultado.idsActualizados).toEqual([]);
    expect($doc('[id="ausente"]')).toHaveLength(0);
  });

  it('construye el cuerpo del salto de página con los marcadores que envía el portal', () => {
    const cuerpo = construirCuerpoParcial(
      [
        ['formBuscador:txtBusqueda', 'amparo'],
        ['javax.faces.ViewState', 'VIEJO'],
      ],
      'VIGENTE',
      {
        formId: 'formBuscador',
        source: 'formBuscador:data1',
        evento: 'rich:datascroller:onscroll',
        execute: 'formBuscador:data1 @component',
        render: '@component',
        parametros: { 'formBuscador:data1:page': '5' },
      },
    );

    expect(cuerpo.get('formBuscador:txtBusqueda')).toBe('amparo');
    expect(cuerpo.get('javax.faces.source')).toBe('formBuscador:data1');
    expect(cuerpo.get('javax.faces.partial.event')).toBe('rich:datascroller:onscroll');
    expect(cuerpo.get('formBuscador:data1:page')).toBe('5');
    expect(cuerpo.get('javax.faces.partial.ajax')).toBe('true');
    // El formulario se nombra a sí mismo (convención JSF) y el ViewState viaja
    // con el valor VIGENTE, no con el que trajera la lista de campos.
    expect(cuerpo.get('formBuscador')).toBe('formBuscador');
    expect(cuerpo.getAll('javax.faces.ViewState')).toEqual(['VIGENTE']);
  });
});

describe('descubrimiento del control de búsqueda', () => {
  it('lee del onclick los parámetros reales, incluido el sufijo j_idt que JSF genera', () => {
    // Codificar `j_idt31` a mano ataría el scraper a un despliegue concreto: ese
    // sufijo lo genera JSF contando componentes y cambia con cualquier retoque
    // de la plantilla. Es la misma lección que el README recoge para el TRF5.
    const onclick =
      "mojarra.jsfcljs(document.getElementById('formBuscador'),{'formBuscador:j_idt31':'formBuscador:j_idt31','forward':'buscar','busqueda':'especializada'},'');return false";
    expect(extraerParametrosJsfcljs(onclick)).toEqual({
      'formBuscador:j_idt31': 'formBuscador:j_idt31',
      forward: 'buscar',
      busqueda: 'especializada',
    });
  });

  it('devuelve undefined cuando el onclick no es una llamada jsfcljs', () => {
    expect(extraerParametrosJsfcljs("RichFaces.ajax('algo',event,{})")).toBeUndefined();
    expect(extraerParametrosJsfcljs('')).toBeUndefined();
  });
});
