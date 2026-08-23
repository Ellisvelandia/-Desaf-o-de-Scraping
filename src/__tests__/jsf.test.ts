/**
 * Pruebas del protocolo JSF 1.2 / RichFaces 3.3 (Ajax4jsf).
 *
 * A diferencia de las del parser, estas NO usan fixtures inventados: se apoyan
 * en `fixtures/portal-inicio.html`, que es la respuesta real del portal
 * capturada durante el reconocimiento (con el JSESSIONID redactado, ver la
 * cabecera del propio fichero). Es la única evidencia verificada del proyecto,
 * así que todo lo que se pueda comprobar contra ella se comprueba contra ella.
 *
 * Lo que aquí se fija es el contrato que el servidor exige y que no se puede
 * negociar: un POST solo se acepta si reenvía el formulario íntegro con su
 * ViewState y los cuatro marcadores de A4J. Si alguno se pierde en una
 * refactorización, el portal responde con la página de inicio y el scraper se
 * queda dando vueltas sin saber por qué.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { aplicarRespuestaA4J, construirCuerpoA4J } from '../jsf/a4j';
import { buscarCampo, CamposFormulario, extraerFormulario, fijarCampo } from '../jsf/form';

const FORM_ID = 'consultaPublicaForm';

function cargarFixture(nombre: string): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', nombre), 'utf8');
}

/**
 * Evidencia real del portal, versionada junto a las pruebas.
 *
 * Vive en `fixtures/` y no en `output/raw/` a propósito: `output/` está en
 * `.gitignore`, y una prueba que dependa de un fichero ignorado pasa en la
 * máquina donde se capturó y falla en cualquier clon limpio.
 */
const $inicio = cheerio.load(cargarFixture('portal-inicio.html'));

// --------------------------------------------------------- extraerFormulario

describe('extraerFormulario sobre la página real del portal', () => {
  it('encuentra consultaPublicaForm con su ViewState y su action con jsessionid', () => {
    const form = extraerFormulario($inicio, FORM_ID);

    expect(form.id).toBe(FORM_ID);
    expect(form.viewState).toBe('j_id1');
    // El portal incrusta la sesión en la ruta; perderla al reenviar cuesta la sesión.
    expect(form.action).toContain('/pjeconsulta/ConsultaPublica/listView.seam');
    expect(form.action).toContain(';jsessionid=');
  });

  it('recoge los campos que el navegador enviaría: ocultos, textos y selects', () => {
    const nombres = extraerFormulario($inicio, FORM_ID).campos.map(([n]) => n);

    // Los ocultos que JSF exige de vuelta.
    expect(nombres).toContain('javax.faces.ViewState');
    expect(nombres).toContain('autoScroll');
    // El par autorreferente que JSF 1.2 usa para saber qué formulario se envió.
    expect(nombres).toContain(FORM_ID);
    // El campo del CAPTCHA y el de búsqueda por número, que el scraper rellena.
    expect(nombres).toContain('consultaPublicaForm:captcha:j_id268:verifyCaptcha');
    expect(nombres).toContain('consultaPublicaForm:Processo:ProcessoDecoration:Processo');
    // El select de Seção/Subseção.
    expect(nombres).toContain('consultaPublicaForm:Processo:jurisdicaoSecaoDecoration:jurisdicaoSecao');
  });

  it('NO incluye botones: enviar dos equivaldría a pulsar dos acciones a la vez', () => {
    const nombres = extraerFormulario($inicio, FORM_ID).campos.map(([n]) => n);

    // JSF resuelve la acción por el nombre del botón presente en el cuerpo.
    expect(nombres).not.toContain('consultaPublicaForm:pesq');
    expect(nombres).not.toContain('consultaPublicaForm:limpa');
  });

  it('NO incluye checkboxes sin marcar, igual que un navegador', () => {
    const nombres = extraerFormulario($inicio, FORM_ID).campos.map(([n]) => n);

    expect(nombres).not.toContain('consultaPublicaForm:numeroCPFCNPJ:numeroCPFCNPJRadioCPFCNPJ:j_id229');
  });

  it('no inventa campos: solo hay un ViewState y su valor es el de la página', () => {
    const campos = extraerFormulario($inicio, FORM_ID).campos;
    const viewStates = campos.filter(([n]) => n === 'javax.faces.ViewState');

    expect(viewStates).toHaveLength(1);
    expect(viewStates[0][1]).toBe('j_id1');
  });

  it('falla ruidosamente si se pide un formulario que no existe', () => {
    expect(() => extraerFormulario($inicio, 'formularioInexistente')).toThrow(/No existe el formulario/);
  });
});

describe('buscarCampo y fijarCampo', () => {
  const campos = extraerFormulario($inicio, FORM_ID).campos;

  it('buscarCampo resuelve el nombre completo desde el sufijo que usa el código', () => {
    // El scraper no puede escribir los ids `j_idNNN`: cambian con cada despliegue.
    expect(buscarCampo(campos, 'verifyCaptcha')).toBe('consultaPublicaForm:captcha:j_id268:verifyCaptcha');
    expect(buscarCampo(campos, 'jurisdicaoSecao')).toBe(
      'consultaPublicaForm:Processo:jurisdicaoSecaoDecoration:jurisdicaoSecao',
    );
    expect(buscarCampo(campos, 'campoQueNoExiste')).toBeUndefined();
  });

  it('fijarCampo sustituye sin duplicar y conserva el orden del documento', () => {
    const nombre = buscarCampo(campos, 'verifyCaptcha');
    expect(nombre).toBeDefined();

    const modificados = fijarCampo(campos, nombre as string, 'ABC123');

    expect(modificados).toHaveLength(campos.length);
    expect(modificados.filter(([n]) => n === nombre)).toHaveLength(1);
    expect(modificados.find(([n]) => n === nombre)?.[1]).toBe('ABC123');
    expect(modificados.map(([n]) => n)).toEqual(campos.map(([n]) => n));
  });

  it('fijarCampo añade al final el campo que no existía', () => {
    const modificados = fijarCampo(campos, 'campoNuevo', 'valor');

    expect(modificados).toHaveLength(campos.length + 1);
    expect(modificados[modificados.length - 1]).toEqual(['campoNuevo', 'valor']);
  });
});

// -------------------------------------------------------- construirCuerpoA4J

describe('construirCuerpoA4J', () => {
  const form = extraerFormulario($inicio, FORM_ID);
  const control = 'consultaPublicaForm:pesq';

  /** Claves en el orden en que viajarían por el cable. */
  function claves(cuerpo: URLSearchParams): string[] {
    return [...cuerpo.keys()];
  }

  it('emite los marcadores de A4J en las posiciones que espera RichFaces', () => {
    const cuerpo = construirCuerpoA4J(form.campos, form.viewState, { formId: FORM_ID, control });
    const orden = claves(cuerpo);

    // La región va primero: es lo que le dice al servidor qué re-renderizar.
    expect(orden[0]).toBe('AJAXREQUEST');
    expect(cuerpo.get('AJAXREQUEST')).toBe('_viewRoot');
    // El contador de eventos cierra el cuerpo, como en A4J.AJAX.Submit.
    expect(orden[orden.length - 1]).toBe('AJAX:EVENTS_COUNT');
    expect(cuerpo.get('AJAX:EVENTS_COUNT')).toBe('1');
  });

  it('reenvía el par autorreferente del formulario exactamente una vez', () => {
    const cuerpo = construirCuerpoA4J(form.campos, form.viewState, { formId: FORM_ID, control });

    // La página real ya trae el oculto `consultaPublicaForm=consultaPublicaForm`;
    // añadirlo otra vez lo enviaría duplicado.
    expect(cuerpo.getAll(FORM_ID)).toEqual([FORM_ID]);
    expect(cuerpo.getAll('autoScroll')).toEqual(['']);
  });

  it('añade el par autorreferente y autoScroll cuando el formulario no los trae', () => {
    const campos: CamposFormulario = [['javax.faces.ViewState', 'j_id1']];

    const cuerpo = construirCuerpoA4J(campos, 'j_id1', { formId: FORM_ID, control });

    expect(cuerpo.getAll(FORM_ID)).toEqual([FORM_ID]);
    expect(cuerpo.getAll('autoScroll')).toEqual(['']);
  });

  it('marca el control pulsado con el par nombre=nombre que JSF interpreta como "botón"', () => {
    const cuerpo = construirCuerpoA4J(form.campos, form.viewState, { formId: FORM_ID, control });

    expect(cuerpo.get(control)).toBe(control);
  });

  it('coloca javax.faces.ViewState una sola vez, después de los campos y con el valor vigente', () => {
    const cuerpo = construirCuerpoA4J(form.campos, 'j_id9', { formId: FORM_ID, control });
    const orden = claves(cuerpo);

    // Un ViewState duplicado o caducado es un 'ViewExpiredException' garantizado.
    expect(cuerpo.getAll('javax.faces.ViewState')).toEqual(['j_id9']);
    // Va después del último campo del formulario y antes del control pulsado,
    // que es el orden en que lo serializa el JavaScript de RichFaces.
    expect(orden.indexOf('javax.faces.ViewState')).toBeGreaterThan(orden.indexOf('autoScroll'));
    expect(orden.indexOf('javax.faces.ViewState')).toBeLessThan(orden.indexOf(control));
  });

  it('propaga region, ajaxSingle y los parámetros del datascroller', () => {
    const cuerpo = construirCuerpoA4J(form.campos, form.viewState, {
      formId: FORM_ID,
      control: 'consultaPublicaForm:scroller',
      region: 'consultaPublicaReRenderDiv',
      ajaxSingle: true,
      parametros: { 'ajax.page': '3' },
    });

    expect(cuerpo.get('AJAXREQUEST')).toBe('consultaPublicaReRenderDiv');
    expect(cuerpo.get('ajaxSingle')).toBe('consultaPublicaForm:scroller');
    expect(cuerpo.get('ajax.page')).toBe('3');
  });

  it('no pierde ningún campo del formulario real por el camino', () => {
    const cuerpo = construirCuerpoA4J(form.campos, form.viewState, { formId: FORM_ID, control });

    for (const [nombre] of form.campos) {
      expect(cuerpo.has(nombre)).toBe(true);
    }
  });
});

// ------------------------------------------------------- aplicarRespuestaA4J

describe('aplicarRespuestaA4J', () => {
  it('parchea el documento vigente y recoge el ViewState nuevo', () => {
    const $doc = cheerio.load(cargarFixture('documento-vigente.html'));

    const resultado = aplicarRespuestaA4J($doc, cargarFixture('a4j-actualizacion.xml'));

    expect(resultado.idsActualizados).toEqual(['consultaPublicaReRenderDiv']);
    expect(resultado.viewState).toBe('j_id7');
    expect(resultado.redireccion).toBeUndefined();

    // El fragmento viejo desaparece y el nuevo ocupa su sitio: es lo que permite
    // seguir leyendo la tabla y el formulario del estado real tras cada acción.
    expect($doc('#marcaAntigua')).toHaveLength(0);
    expect($doc('#marcaNueva').text()).toBe('CON RESULTADOS');
  });

  it('sincroniza el ViewState del formulario vigente con el que devolvió el servidor', () => {
    const $doc = cheerio.load(cargarFixture('documento-vigente.html'));
    expect(extraerFormulario($doc, FORM_ID).viewState).toBe('j_id1');

    aplicarRespuestaA4J($doc, cargarFixture('a4j-actualizacion.xml'));

    // Sin esta sincronización el siguiente POST reenviaría el ViewState caducado.
    expect(extraerFormulario($doc, FORM_ID).viewState).toBe('j_id7');
  });

  it('detecta la redirección por meta Location y no toca el documento', () => {
    const $doc = cheerio.load(cargarFixture('documento-vigente.html'));

    const resultado = aplicarRespuestaA4J($doc, cargarFixture('a4j-redireccion.xml'));

    // El portal responde 200 con <meta name="Location"> cuando Seam explota; la
    // sesión lo traduce a ServidorSaturadoError si apunta a errorUnexpected.
    expect(resultado.redireccion).toBe('/pjeconsulta/errorUnexpected.seam');
    expect(resultado.idsActualizados).toEqual([]);
    expect($doc('#marcaAntigua').text()).toBe('SIN RESULTADOS');
  });

  it('una respuesta que no es A4J no actualiza nada ni inventa un ViewState', () => {
    const $doc = cheerio.load(cargarFixture('documento-vigente.html'));

    const resultado = aplicarRespuestaA4J($doc, '<html><body><p>Requisi&ccedil;&atilde;o Rejeitada</p></body></html>');

    expect(resultado.idsActualizados).toEqual([]);
    expect(resultado.viewState).toBeUndefined();
    expect($doc('#marcaAntigua').text()).toBe('SIN RESULTADOS');
  });
});
