/**
 * Pruebas de la variante MODERNA del PJe, contra HTML real y sin red.
 *
 * Estas pruebas valen distinto que las de `parser.test.ts`, y conviene decirlo
 * sin adornos: las de allí corren sobre fixtures SINTÉTICOS, porque la tabla de
 * resultados del objetivo del desafío (TRF5 1.º grado, plantilla antigua) sigue
 * sin capturarse —su CAPTCHA de imagen la bloquea—. Las de aquí corren sobre
 * TRES capturas reales:
 *
 *   fixtures/pje-nuevo-resultados.html       lista del TRF5 (contexto /pjeconsulta)
 *   fixtures/pje-nuevo-resultados-trf1.html  la MISMA vista en el TRF1 (/consultapublica)
 *   fixtures/pje-nuevo-ficha.html            ficha completa de un proceso del TRF5
 *
 * La prueba del TRF1 no es una repetición de la del TRF5: es la que demuestra
 * que no hay ids codificados a mano. Las dos instancias sirven la misma pantalla
 * con sufijos `j_idNNN` distintos (`j_id257/259/265` frente a `j_id255/257/263`),
 * con contextos web distintos y con proveedores de CAPTCHA distintos
 * (reCAPTCHA frente a hCaptcha). Un parser anclado a un id literal pasaría la
 * primera y fallaría la segunda.
 */
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';

import { detectarVariante } from '../variante';
import { detectarTotalModerno, parsearProcesosModerno } from '../parserModerno';
import { cabecerasDeFicha, parsearFicha, TABLAS_FICHA } from '../ficha';
import { detectarTotalResultados, parsearProcesos } from '../parser';

function cargar(nombre: string): cheerio.CheerioAPI {
  return cheerio.load(fs.readFileSync(path.join(__dirname, 'fixtures', nombre), 'utf8'));
}

/** Número CNJ completo, anclado: NNNNNNN-DD.AAAA.J.TR.OOOO. */
const RE_CNJ = /^\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}$/;

/** Filas de datos que RichFaces dibuja en la tabla de resultados moderna. */
const SELECTOR_FILAS = '[id$=":processosTable"] tbody tr.rich-table-row';

// ------------------------------------------------------------------ variante

describe('detectarVariante', () => {
  it('clasifica la página de entrada del TRF5 como la plantilla antigua "seam"', () => {
    const perfil = detectarVariante(cargar('portal-inicio.html'));

    expect(perfil.variante).toBe('seam');
    expect(perfil.formId).toBe('consultaPublicaForm');
    expect(perfil.botonBuscar).toBe('consultaPublicaForm:pesq');
    // En esta plantilla el CAPTCHA lo valida el servidor: no es negociable.
    expect(perfil.requiereCaptcha).toBe(true);
    // La página de entrada no trae tabla, así que no puede prometer su id.
    expect(perfil.idTablaResultados).toBeUndefined();
  });

  it('clasifica la lista de resultados moderna como "fpp" y no le pide CAPTCHA', () => {
    const perfil = detectarVariante(cargar('pje-nuevo-resultados.html'));

    expect(perfil.variante).toBe('fpp');
    expect(perfil.formId).toBe('fPP');
    expect(perfil.botonBuscar).toBe('fPP:searchProcessos');
    expect(perfil.idTablaResultados).toBe('fPP:processosTable');
    // La clave del módulo: la página CARGA el script de reCAPTCHA pero no
    // instancia ningún widget, y el servidor devolvió la tabla sin token. Si
    // esto se pusiera en `true`, el scraper se bloquearía solo pidiendo a un
    // humano un CAPTCHA que no existe en el DOM.
    expect(perfil.requiereCaptcha).toBe(false);
  });

  it('clasifica igual la misma vista en otra instancia (TRF1, hCaptcha)', () => {
    const perfil = detectarVariante(cargar('pje-nuevo-resultados-trf1.html'));

    expect(perfil.variante).toBe('fpp');
    expect(perfil.botonBuscar).toBe('fPP:searchProcessos');
    expect(perfil.requiereCaptcha).toBe(false);
  });

  it('no clasifica una página que no es ninguna de las dos consultas públicas', () => {
    // La ficha de un proceso no trae formulario de búsqueda. Lanzar es lo
    // correcto: devolver un perfil por defecto haría enviar un POST a un
    // formulario inexistente y el diagnóstico aparecería páginas después.
    expect(() => detectarVariante(cargar('pje-nuevo-ficha.html'))).toThrow(/consultas públicas conocidas/i);
  });
});

// ----------------------------------------------------- lista de resultados

describe('parsearProcesosModerno sobre la lista real del TRF5', () => {
  const $ = cargar('pje-nuevo-resultados.html');
  const procesos = parsearProcesosModerno($, 1);

  it('extrae los 30 procesos de las 30 filas de la tabla', () => {
    expect($(SELECTOR_FILAS)).toHaveLength(30);
    expect(procesos).toHaveLength(30);
  });

  it('todos los números casan el patrón CNJ y ninguno se repite', () => {
    for (const p of procesos) expect(p.numeroProcesso).toMatch(RE_CNJ);
    expect(new Set(procesos.map((p) => p.numeroProcesso)).size).toBe(procesos.length);
  });

  it('aquí ninguna fila está en sigilo: las 30 publican número y la clave ES el número', () => {
    // El contraste con el fixture del TRF1 es lo que da valor a esta prueba: el
    // camino de sigilo no se activa por su cuenta cuando el portal sí publica
    // los números, así que `claveUnica` no se aparta nunca del dato del tribunal.
    for (const p of procesos) {
      expect(p.enSigilo).toBeUndefined();
      expect(p.claveUnica).toBe(p.numeroProcesso);
      expect(p.claveUnica).not.toMatch(/^sigilo:/);
    }
    expect(new Set(procesos.map((p) => p.claveUnica)).size).toBe(30);
  });

  it('descompone la celda compuesta del primer proceso en sus cinco piezas', () => {
    const primero = procesos[0];
    expect(primero).toBeDefined();
    if (!primero) return;

    // El `<b>` de la fila dice literalmente:
    //   "PUILCiv 0000619-36.2021.4.05.8109 -  Aposentadoria por Tempo de Contribuição (Art. 55/6)"
    // y la clase judicial va SUELTA delante del enlace, sin etiqueta propia.
    expect(primero.numeroProcesso).toBe('0000619-36.2021.4.05.8109');
    expect(primero.classeJudicial).toBe('PEDIDO DE UNIFORMIZAÇÃO DE INTERPRETAÇÃO DE LEI CÍVEL');
    expect(primero.camposExtra?.['sigla']).toBe('PUILCiv');
    expect(primero.camposExtra?.['assunto']).toBe('Aposentadoria por Tempo de Contribuição (Art. 55/6)');

    // Los dos polos salen del texto que queda TRAS el enlace, partido por " X ".
    expect(primero.partes).toEqual([
      { papel: 'ATIVO', nombre: 'INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS e outros (1)' },
      { papel: 'PASSIVO', nombre: 'FRANCISCO DAS CHAGAS SILVA FREITAS' },
    ]);

    // La última movimentação se separa del paréntesis final, que es su fecha.
    expect(primero.camposExtra?.['ultimaMovimentacao']).toBe('Baixa Definitiva');
    expect(primero.camposExtra?.['fechaUltimaMovimentacao']).toBe('2023-02-02T18:27:05');
    expect(primero.paginaOrigen).toBe(1);
  });

  it('lee de cada fila la URL de su ficha, con el parámetro ca que la autoriza', () => {
    for (const p of procesos) {
      expect(p.apertura).toBeDefined();
      expect(p.apertura?.tipo).toBe('url');
      const url = p.apertura?.tipo === 'url' ? p.apertura.url : '';
      expect(url).toContain('/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam');
      expect(url).toMatch(/[?&]ca=[0-9a-f]{8,}/);
    }

    // Un `ca` por proceso: si el parser cogiera siempre el mismo enlace, la
    // Fase 2 bajaría 30 veces el mismo expediente sin que nada fallara.
    const hashes = procesos.map((p) => (p.apertura?.tipo === 'url' ? p.apertura.url : ''));
    expect(new Set(hashes).size).toBe(procesos.length);
  });

  it('anuncia el total que publica el pie de la tabla', () => {
    expect(detectarTotalModerno($)).toBe(106073);
  });
});

describe('parsearProcesosModerno sobre OTRA instancia (TRF1)', () => {
  const $ = cargar('pje-nuevo-resultados-trf1.html');
  const procesos = parsearProcesosModerno($, 1);

  it('extrae las 30 filas: 22 con número y 8 en segredo de justiça, ninguna perdida', () => {
    expect($(SELECTOR_FILAS)).toHaveLength(30);
    // Comprobado sobre el HTML: en 8 filas el `<b>` dice solo «PJEC - Assunto»,
    // sin número CNJ, y su columna de movimentación llega vacía. Antes se
    // descartaban con una traza de depuración y se perdía el 27 % de la página;
    // ahora salen, porque el resto de su información sí es pública.
    expect(procesos).toHaveLength(30);
    expect(procesos.filter((p) => p.enSigilo === true)).toHaveLength(8);
    expect(procesos.filter((p) => p.numeroProcesso !== undefined)).toHaveLength(22);
  });

  it('los 22 con número casan el patrón CNJ, con la numeración propia del TRF1', () => {
    const conNumero = procesos.filter((p) => p.numeroProcesso !== undefined);

    expect(conNumero).toHaveLength(22);
    for (const p of conNumero) expect(p.numeroProcesso).toMatch(RE_CNJ);
    // `.4.01.` es el segmento de tribunal del TRF1; en el fixture del TRF5 es
    // `.4.05.`. Que las dos pasen el mismo parser es el objeto de esta prueba.
    expect(conNumero.every((p) => p.numeroProcesso?.includes('.4.01.'))).toBe(true);
  });

  it('los 8 en sigilo NO traen número: ni inventado ni copiado de la clave', () => {
    const sigilosos = procesos.filter((p) => p.enSigilo === true);

    expect(sigilosos).toHaveLength(8);
    for (const p of sigilosos) {
      // Lo importante de todo el cambio: la ausencia del dato oficial se emite
      // como ausencia. Un `numeroProcesso` con la clave dentro publicaría en el
      // CSV un número CNJ que no existe en ningún tribunal.
      expect(p.numeroProcesso).toBeUndefined();
      expect(p.claveUnica).toMatch(/^sigilo:[0-9a-f]{8,}$/);
      expect(p.claveUnica).not.toMatch(RE_CNJ);
    }
  });

  it('de las filas en sigilo se extrae TODO lo demás que el portal sí publica', () => {
    // La fila no publica número, pero sí clase judicial, sigla, asunto, las dos
    // partes y el enlace a su ficha. Emitir un registro con solo la clave sería
    // otra forma de tirar datos.
    const primero = procesos.filter((p) => p.enSigilo === true)[0];
    expect(primero).toBeDefined();
    if (!primero) return;

    expect(primero.classeJudicial).toBe('PROCEDIMENTO COMUM CÍVEL');
    expect(primero.camposExtra?.['sigla']).toBe('ProceComCiv');
    expect(primero.camposExtra?.['assunto']).toBe('Vícios de Construção');
    expect(primero.partes).toEqual([
      { papel: 'ATIVO', nombre: 'CONDOMINIO EDIFICIO OURO PRETO' },
      { papel: 'PASSIVO', nombre: 'M.R.CONSTRUCOES E EMPREENDIMENTOS IMOBILIARIOS LTDA - EPP e outros (1)' },
    ]);
    // Y la ficha se puede abrir: es de donde sale su clave.
    expect(primero.apertura?.tipo).toBe('url');
    const url = primero.apertura?.tipo === 'url' ? primero.apertura.url : '';
    expect(url).toContain(primero.claveUnica.replace('sigilo:', ''));
  });

  it('las 30 claves son distintas entre sí y ninguna está vacía', () => {
    // Dos procesos en sigilo con la misma clave se fundirían en uno al
    // persistirse, que es el mismo agujero de datos por otra puerta.
    for (const p of procesos) {
      expect(typeof p.claveUnica).toBe('string');
      expect(p.claveUnica).toBeDefined();
      expect(p.claveUnica.length).toBeGreaterThan(0);
      expect(p.claveUnica.trim()).toBe(p.claveUnica);
    }
    expect(new Set(procesos.map((p) => p.claveUnica)).size).toBe(30);
  });

  it('descompone la celda compuesta igual que en el TRF5, con otros ids j_idNNN', () => {
    const primero = procesos[0];
    expect(primero).toBeDefined();
    if (!primero) return;

    expect(primero.numeroProcesso).toBe('1010798-28.2026.4.01.4300');
    expect(primero.classeJudicial).toBe('PROCEDIMENTO DO JUIZADO ESPECIAL CÍVEL');
    expect(primero.camposExtra?.['sigla']).toBe('PJEC');
    expect(primero.camposExtra?.['assunto']).toBe('Aposentadoria por Idade (Art. 48/51)');
    expect(primero.partes).toEqual([
      { papel: 'ATIVO', nombre: 'ZENILDES MARTINS DOS SANTOS' },
      { papel: 'PASSIVO', nombre: 'INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS' },
    ]);
  });

  it('la ficha se abre por una URL del contexto de ESTA instancia', () => {
    const url = procesos[0]?.apertura?.tipo === 'url' ? procesos[0]!.apertura!.url : '';
    // El contexto web del TRF1 es `/consultapublica`, no `/pjeconsulta`: la ruta
    // se guarda tal como la publica el portal en vez de recomponerla a mano.
    expect(url).toContain('/consultapublica/ConsultaPublica/DetalheProcessoConsultaPublica/');
    expect(url).toMatch(/[?&]ca=[0-9a-f]{8,}/);
  });

  it('anuncia el total que publica el pie de la tabla', () => {
    expect(detectarTotalModerno($)).toBe(13790144);
  });
});

describe('parsearProcesosModerno sobre una página sin esa tabla', () => {
  it('devuelve [] sin lanzar sobre la página de entrada de la plantilla antigua', () => {
    const $ = cargar('portal-inicio.html');
    expect(parsearProcesosModerno($, 1)).toEqual([]);
    expect(detectarTotalModerno($)).toBeUndefined();
  });
});

// ------------------------------------------------------------- delegación

describe('parsearProcesos delega en el parser moderno cuando ve su tabla', () => {
  it('sobre la lista del TRF5 devuelve exactamente lo mismo que el parser moderno', () => {
    const $ = cargar('pje-nuevo-resultados.html');
    expect(parsearProcesos($, 1)).toEqual(parsearProcesosModerno($, 1));
  });

  it('sobre la lista del TRF1 también', () => {
    const $ = cargar('pje-nuevo-resultados-trf1.html');
    expect(parsearProcesos($, 1)).toEqual(parsearProcesosModerno($, 1));
  });

  it('la delegación es lo que salva la `apertura`, que el camino genérico pierde', () => {
    // Esta prueba fija POR QUÉ existe la delegación, no solo que existe. El
    // camino genérico también encuentra las 30 filas y sus números, pero la
    // celda «Processo» de esta plantilla es compuesta y se le escapan la clase
    // judicial, las partes y —lo que de verdad importa— el enlace a la ficha.
    // Sin `apertura`, la Fase 2 marca fallido cada proceso sin pedir nada.
    const procesos = parsearProcesos(cargar('pje-nuevo-resultados.html'), 1);
    expect(procesos.every((p) => p.apertura !== undefined)).toBe(true);
    expect(procesos.every((p) => p.classeJudicial !== undefined)).toBe(true);
    expect(procesos.every((p) => (p.partes?.length ?? 0) > 0)).toBe(true);
  });

  it('detectarTotalResultados devuelve el total del pie de la tabla moderna', () => {
    expect(detectarTotalResultados(cargar('pje-nuevo-resultados.html'))).toBe(106073);
    expect(detectarTotalResultados(cargar('pje-nuevo-resultados-trf1.html'))).toBe(13790144);
  });

  it('la página de entrada sigue devolviendo [] sin lanzar', () => {
    expect(parsearProcesos(cargar('portal-inicio.html'), 1)).toEqual([]);
  });
});

// ------------------------------------------------------------------- ficha

describe('parsearFicha sobre la ficha real del TRF5', () => {
  const $ = cargar('pje-nuevo-ficha.html');
  const ficha = parsearFicha($);

  it('reconoce la página como ficha', () => {
    expect(ficha.esFicha).toBe(true);
  });

  it('limpia el JavaScript que RichFaces pega al texto de cada cabecera', () => {
    // En bruto, ese `<th>` dice:
    //   "Participantefunction clear_j_id146_3AprocessoPartesPoloAtivoResumido…"
    // porque el `<script>` del `commandLink` de ordenación vive dentro de él.
    const bruto = $(`table[id$="${TABLAS_FICHA.poloActivo}"] thead th`).first().text();
    expect(bruto).toContain('function clear_');

    expect(cabecerasDeFicha($, TABLAS_FICHA.poloActivo)).toEqual(['Participante', 'Situação']);
    expect(cabecerasDeFicha($, TABLAS_FICHA.poloPasivo)).toEqual(['Participante', 'Situação']);
    expect(cabecerasDeFicha($, TABLAS_FICHA.eventos)).toEqual(['Movimento', 'Documento']);
    expect(cabecerasDeFicha($, TABLAS_FICHA.documentos)).toEqual(['Documento', 'Certidão']);
  });

  it('extrae las partes de los DOS polos, etiquetadas por el lado del pleito', () => {
    const activo = ficha.partes.filter((p) => p.papel === 'ATIVO');
    const pasivo = ficha.partes.filter((p) => p.papel === 'PASSIVO');

    expect(activo.length).toBeGreaterThan(0);
    expect(pasivo.length).toBeGreaterThan(0);
    expect(ficha.partes).toHaveLength(5);

    expect(activo[0]?.nombre).toBe('INSTITUTO NACIONAL DO SEGURO SOCIAL - INSS - CNPJ: 29.979.036/0042-19 (PARTE AUTORA)');
    expect(pasivo[0]?.nombre).toBe('FRANCISCO DAS CHAGAS SILVA FREITAS - CPF: 385.984.343-53 (PARTE RE)');

    // Ningún nombre puede arrastrar el `<style>` incrustado en su celda ni el
    // `<script>` de la cabecera. Es el mismo fallo que la prueba anterior, visto
    // desde el dato que sí acaba en `records.json`.
    for (const parte of ficha.partes) {
      expect(parte.nombre).not.toMatch(/function\s|_clearJSFFormParameters|\.none\s*\{/);
      expect(parte.nombre.trim()).toBe(parte.nombre);
      expect(parte.nombre.length).toBeGreaterThan(0);
    }
  });

  it('lee los rótulos de «Dados do Processo» sin claves ni valores vacíos', () => {
    expect(ficha.camposExtra?.['Número Processo']).toBe('0000619-36.2021.4.05.8109');
    expect(ficha.camposExtra?.['Classe Judicial']).toBe(
      'PEDIDO DE UNIFORMIZAÇÃO DE INTERPRETAÇÃO DE LEI CÍVEL (457)',
    );
    expect(ficha.camposExtra?.['Órgão Julgador']).toBe('Rel. TR/AL');

    for (const [clave, valor] of Object.entries(ficha.camposExtra ?? {})) {
      expect(clave.length).toBeGreaterThan(0);
      expect(valor.length).toBeGreaterThan(0);
      expect(valor).not.toMatch(/function\s|_clearJSFFormParameters/);
    }
  });

  it('cada documento trae título y una forma concreta de descargarlo', () => {
    expect(ficha.documentos.length).toBeGreaterThan(0);
    for (const doc of ficha.documentos) {
      expect(doc.titulo.length).toBeGreaterThan(0);
      expect(doc.descarga).toBeDefined();
      if (doc.descarga?.tipo === 'url') expect(doc.descarga.url.length).toBeGreaterThan(0);
      if (doc.descarga?.tipo === 'postback') {
        expect(doc.descarga.formId.length).toBeGreaterThan(0);
        expect(doc.descarga.control.length).toBeGreaterThan(0);
        // El formId tiene que ser un `<form>` REAL del documento: `ServicioDescarga`
        // reconstruye el cuerpo leyendo ese formulario, y con un id inventado
        // lanzaría «No existe el formulario …» en cada descarga.
        expect($(`form[id="${doc.descarga.formId}"]`)).toHaveLength(1);
      }
      // El título va al nombre del fichero en disco: un título con la fecha
      // pegada delante («22/11/2022 12:59:01 - Acórdão») produciría rutas
      // ilegales en Windows y ficheros imposibles de encontrar.
      expect(doc.titulo).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    }
  });

  it('prefiere el PDF real al visor HTML cuando el mismo enlace publica los dos', () => {
    // Es el único camino de este portal verificado sirviendo un binario:
    // `reportReciboPDF.seam` devolvió 200 application/pdf con bytes `%PDF-1`
    // (ver `docs/protocol.md`). El enlace del comprobante declara además un
    // postback A4J que solo notifica al servidor y NO trae el archivo; quedarse
    // con él dejaba la descarga sin su única fuente comprobada.
    const recibos = ficha.documentos.filter(
      (d) => d.descarga?.tipo === 'url' && /reportReciboPDF\.seam/i.test(d.descarga.url),
    );
    expect(recibos.length).toBeGreaterThan(0);
    for (const doc of recibos) {
      expect(doc.descarga?.tipo).toBe('url');
      expect(doc.id).toMatch(/^\d+$/);
    }
  });

  it('no repite el mismo documento aunque aparezca en varias filas', () => {
    const claves = ficha.documentos.map((d) => JSON.stringify([d.id, d.titulo, d.fecha, d.descarga]));
    expect(new Set(claves).size).toBe(claves.length);
  });
});

describe('parsearFicha sobre una página que no es una ficha', () => {
  it('devuelve el resultado vacío y lo MARCA como no-ficha, sin lanzar', () => {
    const datos = parsearFicha(cargar('portal-inicio.html'));

    // La bandera es lo que separa «esta ficha no tiene documentos» (terminal) de
    // «esto no es una ficha» (reintentable). Sin ella, la Fase 2 retiraría para
    // siempre procesos cuya navegación se fue a la pantalla de sesión caducada.
    expect(datos.esFicha).toBe(false);
    expect(datos.partes).toEqual([]);
    expect(datos.documentos).toEqual([]);
    expect(datos.camposExtra).toBeUndefined();
  });
});
