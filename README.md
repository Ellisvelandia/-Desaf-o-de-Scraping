# Scraper · Dos portales judiciales, un solo scraper

Scraper en TypeScript, solo HTTP (axios + cheerio) y **sin ninguna automatización de navegador**, que recorre los **dos** portales que nombra el enunciado del desafío, extrae los metadatos de cada documento y descarga sus PDF.

| Objetivo | Portal | Tecnología | CAPTCHA | Comando |
|---|---|---|---|---|
| `peru` | [Jurisprudencia Nacional Sistematizada](https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml) (Poder Judicial del Perú) | JSF 2 + RichFaces 4 | **No** | `npm run peru` |
| `trf5` | [Consulta Pública del PJe](https://pje.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam) (Tribunal Regional Federal da 5ª Região, Brasil) | JBoss Seam 2 / JSF 1.2 / RichFaces 3.3 | Sí, de imagen | `npm start` |

### Por qué hay dos objetivos y no uno

Porque **el enunciado nombra dos sitios distintos y no dice cuál manda**. Bajo el epígrafe «Sitio web a scrapear» aparece el PJe del TRF5; pero tanto el «Paso 1: Explorar el sitio web» como el **Entregable** dicen literalmente *«Asegúrate de que funcione correctamente con el sitio»* y ahí el sitio es `jurisprudencia.pj.gob.pe`.

Implementar los dos es la única lectura que cumple el enunciado entero en vez de apostar por una mitad. Y resulta que se complementan: el TRF5 exige un CAPTCHA de imagen que impide una ejecución desatendida, mientras que **el portal peruano no pide CAPTCHA**, publica **15.247 páginas** de resultados y cuelga el PDF de cada resolución como un enlace directo. Es el objetivo que sí puede demostrar el requisito «navegar por todas las páginas» de principio a fin.

El código común —cliente HTTP, política de reintentos, persistencia, exportación CSV, servicio de descarga— es exactamente el mismo para ambos. Lo que cambia por objetivo es el parser, la sesión y el dialecto AJAX de JSF.

---

## Requisitos previos

| Requisito | Detalle |
|---|---|
| Node.js | 18 o superior (declarado en `engines` de `package.json`) |
| npm | El que acompañe a esa versión de Node |
| Red (`trf5`) | Salida directa a Internet, **sin VPN ni proxy de alojamiento** |
| Red (`peru`) | **Salida desde Perú**: el portal responde `403` a cualquier otra IP. Ver el aviso de abajo. |
| Persona disponible | Solo para `trf5`: su CAPTCHA hay que teclearlo una vez por fase. El objetivo `peru` es desatendido. |

### Aviso: el objetivo `peru` exige salir desde Perú, con VPN **de sistema**

`jurisprudencia.pj.gob.pe` está detrás de un WAF Radware que responde `403 Forbidden` —con un «Transaction ID» y nada más— a toda petición que no llegue desde Perú. Comprobado: falla igual desde una IP europea, desde una IP colombiana y desde un proxy comercial geolocalizado en Lima.

El detalle que cuesta una tarde: **una VPN de extensión de navegador no sirve**. Esas extensiones enrutan únicamente el tráfico de Chrome; el proceso de Node sigue saliendo por la IP real de la máquina y recibe el mismo `403`. Hace falta una VPN de **ámbito de sistema** (cliente de escritorio o la VPN de Windows), de modo que también salga por ella el proceso que lanza `npm run peru`.

Para comprobarlo antes de lanzar nada:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/inicio.xhtml
```

`200` significa que Node llegará al portal. `403` significa que la VPN no está cubriendo a Node, por mucho que el sitio se vea bien en el navegador.

### Aviso: el objetivo `trf5` exige ejecutar SIN VPN

**El consejo es el OPUESTO al del portal peruano, y darlo al revés cuesta una tarde.** El punto de entrada emite el correcto según el objetivo activo.

El TRF5 está detrás de un WAF F5 que rechaza los rangos de VPN y de proveedores de alojamiento. Cuando la IP de origen cae en uno de esos rangos, el portal responde `HTTP 200` con una página de bloqueo titulada **«Requisição Rejeitada»** en lugar del formulario. No es un fallo del scraper y no se arregla reintentando: el bloqueo es por dirección IP.

El cliente HTTP detecta esa página y lanza `BloqueadoPorWafError`, que `esReintentable()` clasifica como fatal a propósito —repetir peticiones contra un WAF convierte un bloqueo blando en uno duro—. El punto de entrada lo traduce en un mensaje explícito por consola.

Si aparece ese mensaje: apagar la VPN, comprobar que Node sale por la IP real de la máquina y volver a lanzar.

---

## Instalación

```bash
git clone <url-del-repositorio>
cd Desafio-de-Scraping
npm install
```

No hay paso de compilación obligatorio: los comandos de uso corren el TypeScript con `ts-node`. `npm run build` existe para generar `dist/` si se prefiere ejecutar el JavaScript compilado.

---

## Uso

### Comandos

Los comandos sin prefijo apuntan al objetivo `trf5`; los `peru:*`, al peruano.

| Comando | Qué hace |
|---|---|
| `npm run peru` | **Objetivo peruano, flujo completo y desatendido**: recorre el paginador, extrae y descarga los PDF |
| `npm run peru:fase1` | Solo extracción de metadatos del portal peruano |
| `npm run peru:fase2` | Solo descarga de los PDF ya indexados del portal peruano |
| `npm start` | Menú interactivo del TRF5 (1 = Fase 1, 2 = Fase 2, 3 = flujo completo) |
| `npm run fase1` | Solo Fase 1: recorre el paginador y extrae metadatos a `records.json` / `records.csv` |
| `npm run fase2` | Solo Fase 2: descarga los PDF de los procesos ya indexados por la Fase 1 |
| `npm run completo` | Fase 1 seguida de Fase 2 en la misma ejecución |
| `npm run explorar` | Diagnóstico: abre sesión, hace una búsqueda y vuelca la estructura del portal a `output/raw/` sin paginar ni descargar |
| `npm test` | Suite de Jest (ver la sección **Pruebas**) |
| `npm run build` | Compila a `dist/` con `tsc` |
| `npm run lint` | Comprobación de tipos sin emitir, del código **y de las pruebas** (`tsconfig.json` + `tsconfig.test.json`) |

### Variables de entorno

#### Comunes a los dos objetivos

| Variable | Por defecto | Efecto |
|---|---|---|
| `TARGET` | `trf5` | Objetivo activo: `peru` o `trf5`. Equivale a pasarlo como primer argumento (`ts-node src/index.ts peru fase1`). |
| `PJE_BASE_URL` | Según el objetivo | Origen del portal. El PJe es el mismo software desplegado en decenas de tribunales, así que apuntar a otra instancia es cambiar esta variable, no tocar código. Con ella se hizo la ejecución de demostración contra `https://pje2g.trf5.jus.br`. |
| `PJE_LANDING_PATH` | Según el objetivo | Ruta de la página de entrada, para instancias que la sirvan en otro contexto web (`/consultapublica` en vez de `/pjeconsulta`, por ejemplo). |
| `PJE_RESULTADO_PATH` | Según el objetivo | Ruta que atiende los POST de paginación. |
| `MAX_DESCARGAS` | `25` | Tope de PDF por ejecución de la Fase 2. El enunciado no exige bajarlos todos. |
| `MAX_PAGINAS` | `10000` | Tope de páginas de la Fase 1. Red de seguridad ante un paginador que no termine. |
| `DEBUG` | (sin valor) | Con cualquier valor, traza cada petición HTTP (método, URL, código, bytes) y el detalle de cada respuesta AJAX. |

#### Solo del objetivo `peru`

Los tres son opcionales: el buscador peruano acepta una consulta **sin filtros** y devuelve el corpus entero, que es el caso que demuestra «navegar por todas las páginas».

| Variable | Efecto |
|---|---|
| `TEXTO` | Búsqueda por texto libre (`TEXTO=amparo`). |
| `EXPEDIENTE` | Nº de expediente exacto (`EXPEDIENTE=037233-2025`). |
| `ANIO` | Año de la resolución. |

#### Solo del objetivo `trf5`

| Variable | Por defecto | Efecto |
|---|---|---|
| `SECAO` | `0` | Valor del selector Seção/Subseção. `0` es «TRF - 5ª Região», la opción más amplia del desplegable. El portal exige al menos un criterio de búsqueda, y este es el que se envía siempre. |
| `NOME_PARTE` | (sin valor) | Criterio adicional por nombre de parte. Útil para acotar el conjunto de prueba. |
| `NUMERO_PROCESSO` | (sin valor) | Criterio por número CNJ concreto. Sin él se envía la máscara vacía `_______-__.____._.__.____`, que es lo que manda el navegador. |
| `CAPTCHA_MODE` | (terminal) | Con el valor `file`, la respuesta del CAPTCHA se lee de `output/captcha.txt` en vez de la terminal. |
| `GUARDAR_RAW` | (sin valor) | Con cualquier valor, guarda las respuestas crudas del portal en `output/raw/`. `npm run explorar` lo activa por su cuenta. |

Ejemplo:

```bash
# Fase 1 acotada a un nombre de parte, con trazas y respuestas crudas
NOME_PARTE=SILVA DEBUG=1 GUARDAR_RAW=1 npm run fase1

# Fase 2 con un tope bajo, solo para demostrar la descarga
MAX_DESCARGAS=5 npm run fase2
```

En PowerShell las variables se fijan antes con `$env:NOME_PARTE = 'SILVA'`.

---

## El CAPTCHA

El formulario de consulta del PJe TRF5 exige un CAPTCHA de imagen para lanzar una búsqueda. La imagen se sirve en `/pjeconsulta/seam/resource/captcha;jsessionid=<JSESSIONID>` y cada GET genera un desafío nuevo ligado a la sesión.

**Este scraper no resuelve el CAPTCHA de forma automática, y es una decisión deliberada, no una carencia.** Un CAPTCHA es una detección de bots explícita del titular del sitio; automatizar su resolución sería evadirla. El scraper hace lo contrario: pone la imagen delante de una persona y le pide que la lea.

Cómo encaja en el flujo:

- Se pide **una vez por fase**. La Fase 1 abre una sesión y busca; la Fase 2 abre otra sesión y vuelve a buscar, porque el portal ata los identificadores de descarga al árbol de componentes de la sesión que los emitió.
- Todo lo demás es automático: el recorrido del paginador, el parseo de cada página y la descarga de los PDF no vuelven a requerir intervención.
- Si la búsqueda no devuelve resultados, el portal re-renderiza el formulario con un CAPTCHA nuevo y el scraper vuelve a pedirlo, hasta `maxCaptchaAttempts` (3) veces.
- Antes de gastar el trabajo de la persona, la sesión sondea el portal con un GET barato. Si el servidor no está sirviendo, espera en lugar de pedir un CAPTCHA para una búsqueda condenada de antemano.

### Modo terminal (por defecto)

`CaptchaHumano`. Guarda la imagen en `output/captcha.png`, imprime la ruta por consola y espera a que se teclee el texto. Un Enter vacío pide una imagen nueva. Es el modo para ejecutar el scraper a mano delante de una terminal.

### Modo fichero (`CAPTCHA_MODE=file`)

`CaptchaPorArchivo`. Guarda la imagen en `output/captcha.png` y se queda esperando a que aparezca `output/captcha.txt` con el texto. Cuando lo encuentra, lo lee, lo borra y continúa. Espera hasta una hora antes de rendirse.

Es el modo para cuando no hay una terminal interactiva conectada: ejecución supervisada desde otro proceso, sesión lanzada en segundo plano, o una persona que mira la imagen desde otra máquina y escribe la respuesta en el fichero compartido.

---

## Cómo funciona

El portal no navega por URL: es una aplicación JSF con estado en servidor donde cada interacción es un POST del formulario completo por XMLHttpRequest. El scraper reproduce exactamente esa conversación.

**Antes de nada, el scraper detecta automáticamente con cuál de las dos Consultas Públicas del PJe está hablando.** No hay una sola: conviven dos plantillas incompatibles, y enviar el POST de una a la otra devuelve la página de inicio sin error visible, de modo que el fallo aparecería mucho después, al no haber tabla. `src/variante.ts` clasifica la página nada más abrirla, y todo lo que viene detrás se adapta a lo que diga:

| | **Antigua — «seam»** | **Moderna — «fPP»** |
|---|---|---|
| Ejemplo | `pje.trf5.jus.br/pjeconsulta/` — **el objetivo del desafío** | resto de instancias (TRF5 *treinamento*, TRF1, TRF6…) |
| Formulario / botón | `consultaPublicaForm` / `…:pesq` | `fPP` / `fPP:searchProcessos` |
| CAPTCHA | imagen de Seam, **validada en servidor** | ninguno: el widget no llega a instanciarse y el POST devuelve la tabla sin enviar token |
| Tabla de resultados | `rich:dataTable` genérico → `src/parser.ts` | `…:processosTable` con celda «Processo» compuesta → `src/parserModerno.ts` |
| Ficha del proceso | postback A4J (supuesto) | **GET** a `…DetalheProcessoConsultaPublica/listView.seam?ca=<hash>` → `src/ficha.ts` |
| Verificada contra HTML real | **no** | **sí**, en tres instancias distintas |

Tres consecuencias prácticas, y ninguna se configura —se deciden por lo que trae el HTML—: en la variante moderna **no se le pide ningún CAPTCHA a la persona** (pedirlo sería trabajo humano tirado a la basura), `parsearProcesos` **delega** en el parser que sabe descomponer la celda compuesta, y la Fase 2 abre cada ficha por su URL **sin rehacer la búsqueda**, con lo que desaparece el punto en el que un CAPTCHA fallido tumbaba la fase entera. El diagrama que sigue describe el camino de la variante antigua, que es la del objetivo del desafío.

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 1. GET /pjeconsulta/ConsultaPublica/listView.seam                    │
  │    → cookie JSESSIONID + cookies del WAF (trf5…)                     │
  │    → javax.faces.ViewState                                           │
  │    → formulario consultaPublicaForm completo (~101 KB, ISO-8859-1)   │
  └──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 2. GET /pjeconsulta/seam/resource/captcha;jsessionid=…?f=<epoch>     │
  │    → imagen → output/captcha.png → LA PERSONA teclea el texto        │
  └──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 3. POST listView.seam   (búsqueda, protocolo A4J)                    │
  │    cuerpo = TODOS los campos del formulario vigente                  │
  │           + criterios sobrescritos + texto del CAPTCHA               │
  │           + AJAXREQUEST=_viewRoot                                    │
  │           + consultaPublicaForm=consultaPublicaForm                  │
  │           + <botón pesq>=<botón pesq>                                │
  │           + javax.faces.ViewState                                    │
  │           + AJAX:EVENTS_COUNT=1                                      │
  │    → XML A4J: <meta name="Ajax-Update-Ids"> + #ajax-view-state       │
  │    → se parchea el documento vigente con esos fragmentos             │
  └──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼  (se repite por cada página)
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 4. POST listView.seam   (paginación, protocolo A4J)                  │
  │    el rich:datascroller viaja como <idDelScroller>=<n>               │
  │    → mismo parcheo → parsearProcesos() lee la tabla del documento    │
  └──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 5. Ficha del proceso (Fase 2): se activa el control que la fila      │
  │    publicó. Si es una URL (variante moderna) → GET directo y         │
  │    parsearFicha() lee partes, documentos y «Dados do Processo»;      │
  │    si es un postback A4J → se reproduce el POST y se lee con         │
  │    parsearDocumentos(). Con URL no hace falta volver a la lista;     │
  │    con postback sí, y se restaura la copia guardada                  │
  └──────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 6. GET o POST del artefacto → <destino>.part → validación → rename   │
  │    → output/pdfs/<numeroCNJ>_<idDoc>_<titulo>.pdf                    │
  └──────────────────────────────────────────────────────────────────────┘
```

La pieza central es la réplica del protocolo **Ajax4jsf (A4J) de RichFaces 3.3**, que vive en `src/jsf/a4j.ts` y consta de dos mitades:

- **Envío** (`construirCuerpoA4J`). JSF 1.2 valida el `ViewState` de la última respuesta y espera el formulario íntegro, así que no basta con mandar los campos que cambian: se reenvían todos los `input`/`select`/`textarea` del formulario tal como los dejó la respuesta anterior, en orden de documento, se sobrescriben solo los criterios y se añaden los cuatro marcadores que RichFaces pone (`AJAXREQUEST`, el formulario nombrándose a sí mismo, el control «pulsado» y `AJAX:EVENTS_COUNT`).
- **Recepción** (`aplicarRespuestaA4J`). La respuesta no es una página: es un XML con los fragmentos actualizados, un `<meta name="Ajax-Update-Ids">` que dice qué ids sustituir y un `#ajax-view-state` con el `ViewState` nuevo. El scraper mantiene un documento cheerio **vigente** y lo parchea sustituyendo esos elementos, que es lo que hace el navegador. Así el formulario y la tabla siempre se leen del estado real, y la interacción siguiente parte de él.

Detalles del transporte que importan (`src/http/client.ts`):

- Las cookies se guardan en un mapa propio y se reinyectan en cada petición: Node no tiene jar de cookies.
- El cuerpo se decodifica con el charset declarado por el servidor —`ISO-8859-1`— con `iconv-lite`. Asumir UTF-8 corrompe los acentos del portugués.
- Se impone una pausa mínima entre peticiones consecutivas.
- Dos páginas de error que el portal sirve con código `200` se traducen a errores tipados antes de que nadie intente parsearlas.

---

## Estructura del proyecto

```
src/
├── config.ts             CONFIG: URL base, rutas de salida, delays y política de reintentos
├── types.ts              Contrato de datos: ProcesoJudicial, Parte, DocumentoProceso,
│                         DescargaDirecta/DescargaPostback, EstadoEjecucion, Fallo
├── index.ts              CLI: menú, lectura de variables de entorno, mensajes de error finales
├── explorar.ts           Diagnóstico del portal: vuelca tablas, enlaces y scrollers detectados
├── scraper.ts            Orquestador: Scraper.fase1 (metadatos) y Scraper.fase2 (PDF)
├── session.ts            SesionPje: abrir, buscar, accionA4J, sonda de salud del servidor
├── variante.ts           detectarVariante: cuál de las dos Consultas Públicas sirve el portal
├── parser.ts             parsearProcesos (delega en el moderno si ve su tabla),
│                         parsearDocumentos, detectarTotalResultados
├── parserModerno.ts      parsearProcesosModerno, detectarTotalModerno: tabla de la variante fPP
├── ficha.ts              parsearFicha: partes, documentos y «Dados do Processo» del expediente
├── errores.ts            EstructuraInesperadaError, compartido por los dos parsers
├── paginacion.ts         detectarPaginacion, construirOpcionesPagina, hayPaginaSiguiente
├── persistencia.ts       Persistencia: JSON atómico, dedupe por claveUnica, estado, fallos, CSV
├── descarga.ts           ServicioDescarga, DescargaInvalidaError, nombres de fichero seguros
├── http/
│   └── client.ts         ClienteHttp: cookies, ISO-8859-1, pausa mínima, errores disfrazados de 200
├── jsf/
│   ├── form.ts           extraerFormulario, fijarCampo, buscarCampo (común a los dos objetivos)
│   ├── a4j.ts            RichFaces 3.3 sobre JSF 1.2 (TRF5): construirCuerpoA4J, aplicarRespuestaA4J
│   └── partial.ts        JSF 2 estándar (Perú): construirCuerpoParcial, aplicarRespuestaParcial,
│                         esRespuestaParcial. Son dos protocolos distintos, no dos formas del mismo
├── peru/                 Objetivo peruano. Solo lo que difiere; todo lo demás se reutiliza
│   ├── session.ts        SesionPeru: abrir, buscar (descubre el control JSF del onclick), irAPagina
│   ├── parser.ts         parsearResoluciones, detectarTotalPaginas, detectarPaginaActual
│   └── scraper.ts        ScraperPeru: fase1 (metadatos) y fase2 (PDF), sin CAPTCHA
├── captcha/
│   └── humano.ts         CaptchaHumano (terminal), CaptchaPorArchivo (fichero), CaptchaFijo (pruebas)
├── utils/
│   ├── logger.ts         log.info / warn / error / debug con marca de tiempo relativa
│   └── retry.ts          withRetry, sleep, esReintentable, calcularEspera,
│                         ServidorSaturadoError, SesionCaducadaError, BloqueadoPorWafError
└── __tests__/            Suite de Jest (10 ficheros, sin red)
    └── fixtures/         Capturas REALES: portal-inicio.html (variante antigua, JSESSIONID
                          redactado), pje-nuevo-resultados.html y -trf1.html (listas de dos
                          instancias) y pje-nuevo-ficha.html. Más fixtures sintéticos de
                          resultados, paginador y respuestas A4J

tsconfig.json            Configuración de compilación (excluye las pruebas de dist/)
tsconfig.test.json       La misma en modo noEmit, incluyendo las pruebas, para `npm run lint`

docs/
├── protocol.md           Protocolo del TRF5: sesión, ViewState, cuerpo exacto del POST A4J,
│                         tabla de señales de fallo, lo verificado y lo pendiente
├── protocolo-peru.md     Protocolo del portal peruano, capturado del sitio en vivo: bloqueo
│                         geográfico, POST de búsqueda, estructura del resultado, endpoint de
│                         descarga y petición parcial de paginación, con lo verificado y lo no
├── scope.md              Alcance, carácter público de la fuente y autorización
└── arquitectura.md       Decisiones de diseño y flujo de datos
```

---

## Salida

Todo se escribe bajo `output/`, que está en `.gitignore` porque contiene datos recogidos del portal.

| Ruta | Contenido |
|---|---|
| `output/records.json` | Los procesos, como objeto **indexado por `claveUnica`** (no array). La deduplicación es O(1) y los duplicados son imposibles por construcción. |
| `output/records.csv` | Las columnas estables del contrato, con BOM UTF-8 y CRLF para que Excel en Windows no destroce los acentos. Los documentos van como recuento; el detalle está en el JSON. |
| `output/state.json` | Estado de reanudación: criterio de búsqueda, última página completada, si la extracción terminó y el total anunciado por el portal. |
| `output/failed.json` | Los fallos, con clave (`claveUnica`, fase), motivo, número de intentos y marca del último. |
| `output/pdfs/` | Los PDF descargados, nombrados `<numeroCNJ>_<idDocumento>_<titulo>.pdf`, o `sigilo_<hash>_<idDocumento>_<titulo>.pdf` cuando el proceso corre en segredo de justiça y no tiene número. Cuando el documento no publica `id`, su lugar lo ocupa la fecha más un resumen corto de su enlace: sin ese discriminante, dos documentos homónimos del mismo proceso compartían ruta y el segundo se perdía en silencio. |
| `output/captcha.png` | La última imagen de CAPTCHA servida. Es de trabajo, no de resultado. |
| `output/raw/` | Respuestas crudas del portal, solo cuando `GUARDAR_RAW` está activo. |

### Ejemplo de un registro

**Los valores de abajo son ilustrativos**, no una captura real: la forma exacta de la fila de resultados todavía no se ha podido verificar contra una respuesta con resultados (ver **Limitaciones conocidas**). Los nombres de campo sí son los del contrato de `src/types.ts`.

```json
{
  "0801234-56.2023.4.05.8300": {
    "claveUnica": "0801234-56.2023.4.05.8300",
    "numeroProcesso": "0801234-56.2023.4.05.8300",
    "orgaoJulgador": "12ª Vara Federal da Seção Judiciária de Pernambuco",
    "classeJudicial": "PROCEDIMENTO COMUM CÍVEL",
    "dataAutuacao": "2023-04-17",
    "partes": [
      { "papel": "AUTOR", "nombre": "NOMBRE DE LA PARTE AUTORA" },
      { "papel": "RÉU", "nombre": "UNIÃO FEDERAL" }
    ],
    "documentos": [
      {
        "id": "1234567",
        "titulo": "Petição inicial",
        "fecha": "2023-04-17",
        "descarga": { "tipo": "url", "url": "/pjeconsulta/Processo/documento.seam?idDoc=1234567" }
      }
    ],
    "camposExtra": { "situacao": "Em tramitação" },
    "apertura": { "tipo": "postback", "formId": "consultaPublicaForm", "control": "consultaPublicaForm:lista:0:verProcesso" },
    "paginaOrigen": 1,
    "estado": "completado",
    "archivos": ["output/pdfs/0801234-56.2023.4.05.8300_1234567_Petição inicial.pdf"],
    "vistoEn": "2026-08-23T14:12:07.441Z"
  }
}
```

Campos con dos orígenes distintos: `numeroProcesso`, `orgaoJulgador`, `classeJudicial`, `dataAutuacao`, `partes`, `documentos`, `apertura` y `camposExtra` vienen del portal; `claveUnica`, `enSigilo`, `paginaOrigen`, `estado`, `archivos` y `vistoEn` los añade el scraper. Ningún campo se emite vacío por defecto: si el portal no publica un dato, el campo se omite en lugar de prometer una columna siempre en blanco.

#### `claveUnica` y `numeroProcesso` no son el mismo campo

`numeroProcesso` es un **dato del portal**: el número CNJ que asigna el poder judicial. `claveUnica` es un **índice del scraper**, y existe solo para no guardar dos veces la misma fila. En la mayoría de procesos coinciden, y precisamente por eso conviene decir por qué son dos campos: **hay procesos que el portal publica sin número** —los que corren en *segredo de justiça*—, y con el número como única clave esas filas solo tenían dos destinos, perderse o forzar a inventarles uno. Ambos son inaceptables: el primero tira información pública, el segundo publica un número CNJ que no existe en ningún tribunal.

Así que la regla es explícita:

- Si el portal publica el número → `claveUnica` **es** ese número.
- Si no lo publica → `numeroProcesso` **se omite**, `enSigilo` vale `true` y `claveUnica` se deriva del parámetro `ca=` del enlace a la ficha (el identificador con el que el propio portal abre ese expediente), con el prefijo `sigilo:` delante para que nunca se confunda con un número real.

Un registro en segredo de justiça, con todo lo demás que el portal **sí** publica de él:

```json
{
  "sigilo:23300a04caaa9cb7577fde2acd412921f12508038c5c97a5": {
    "claveUnica": "sigilo:23300a04caaa9cb7577fde2acd412921f12508038c5c97a5",
    "enSigilo": true,
    "classeJudicial": "PROCEDIMENTO COMUM CÍVEL",
    "partes": [
      { "papel": "ATIVO", "nombre": "CONDOMINIO EDIFICIO OURO PRETO" },
      { "papel": "PASSIVO", "nombre": "M.R.CONSTRUCOES E EMPREENDIMENTOS IMOBILIARIOS LTDA - EPP e outros (1)" }
    ],
    "camposExtra": { "sigla": "ProceComCiv", "assunto": "Vícios de Construção" },
    "apertura": {
      "tipo": "url",
      "url": "/consultapublica/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=23300a04caaa9cb7577fde2acd412921f12508038c5c97a5"
    },
    "paginaOrigen": 1,
    "estado": "pendiente",
    "vistoEn": "2026-08-23T14:12:07.441Z"
  }
}
```

Este registro **no es ilustrativo**: sale de ejecutar el parser contra `src/__tests__/fixtures/pje-nuevo-resultados-trf1.html`, y es la fila 3 de esa captura real.

En el CSV eso se traduce en tres columnas al principio —`claveUnica`, `numeroProcesso`, `enSigilo`—, con la celda de `numeroProcesso` **vacía** cuando el tribunal no lo publica. La celda en blanco es el dato correcto: significa «el portal no lo dice», y la columna de al lado explica por qué.

Compatibilidad: un `records.json` escrito por una versión anterior (indexado por número y sin `claveUnica`) **se migra al cargarlo**, derivando la clave del número. Sin eso, actualizar el scraper habría descartado en silencio todo lo ya extraído, incluidos los procesos marcados `completado`, y la pasada siguiente habría vuelto a descargar los mismos PDF. Lo mismo vale para un `failed.json` anterior, que conserva sus intentos ya contados.

---

## Manejo de errores

`src/utils/retry.ts` clasifica el fallo antes de reaccionar. Un `429` o un corte de red merecen esperar y repetir; un `403` no va a cambiar por esperar.

| Señal | Qué significa en realidad | Reacción del scraper |
|---|---|---|
| `200` + página «Requisição Rejeitada» | El WAF F5 bloqueó la IP de origen. Suele ser una VPN activa. | `BloqueadoPorWafError`. **No se reintenta nunca.** El CLI imprime el aviso de apagar la VPN y termina con código 1. |
| Redirección o cuerpo con `errorUnexpected.seam` / `IJ000655` | El pool de conexiones del servidor del TRF5 está agotado. Es un fallo del tribunal, transitorio. | `ServidorSaturadoError`. Espera `serverOverloadDelayMs` (90 s), reabre la sesión y reintenta, hasta `maxSessionRenewals` (5) veces. La búsqueda además sondea el portal antes de pedir un CAPTCHA. |
| `429 Too Many Requests` | Límite de tasa. Es lo que dispara la descarga masiva de PDF. | Retroceso exponencial `base·2^(n-1)` (2 s, 4 s, 8 s…) con jitter aleatorio de hasta 500 ms y tope de 60 s por espera; si el servidor envía `Retry-After`, manda ese valor. Agotados los 4 intentos, el documento se anota en `failed.json` y **la ejecución continúa con el siguiente**. |
| `408`, `500`, `502`, `503`, `504` | Servidor transitoriamente caído. | Mismo retroceso exponencial con jitter y tope. |
| `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNABORTED`, `EPIPE` | Corte de transporte; el F5 corta conexiones demasiado rápidas. | Se reintenta con el mismo retroceso. |
| `400`, `401`, `403`, `404`, `405`, `410`, `422` | La petición está mal o no estamos autorizados. | **Nunca se reintentan.** Se propagan en el primer intento, sin dormir: insistir contra un WAF convierte un bloqueo blando en uno duro. |
| Respuesta A4J sin `Ajax-Update-Ids`, o `<meta name="Location">` que no apunta a `errorUnexpected` | La sesión JSF o el `ViewState` caducaron. | `SesionCaducadaError`. No se reintenta la petición: hay que reabrir sesión, lo que implica un CAPTCHA nuevo. |
| `200` con `Content-Type: text/html` en una descarga, fichero < 1 KB, o bytes iniciales distintos de `%PDF-` | El portal sirvió una página de error en lugar del documento. | `DescargaInvalidaError`, clasificado como fatal a propósito: repetir no convierte una página de sesión caducada en un PDF. El `.part` se borra, el fallo se anota en `failed.json` y se sigue. |
| `403` cuyo cuerpo es solo «403 Forbidden» y un «Transaction ID» | Bloqueo geográfico del WAF Radware del portal peruano: la petición no salió desde Perú. | `BloqueadoPorWafError`, fatal a propósito. El mensaje final dice lo único que resuelve el caso: hace falta una VPN de **ámbito de sistema**, porque una extensión de navegador no enruta el proceso de Node. |
| Tabla de RichFaces con filas pero sin ningún número CNJ **ni enlace a la ficha** | La estructura de la tabla de resultados cambió. Con número o con enlace la fila se extrae; sin ninguno de los dos no hay clave posible. | `EstructuraInesperadaError` con una muestra de la primera fila. Se anota como fallo de fase `pagina` y se corta la Fase 1, en lugar de escribir registros a medias. |

Qué queda registrado en `failed.json`: el scraper emite tres fases, `pagina` (una página que no se pudo parsear), `ficha` (un proceso cuya ficha no se pudo abrir, incluido el caso en que la fila no publica de forma inequívoca cómo abrirla) y `documento` (un PDF que no se pudo descargar). Cada entrada es única por (proceso, fase, **documento**) y acumula `intentos` en vez de duplicarse, de modo que el contador cuenta los intentos de ESE documento y sirve para decidir cuándo rendirse con él. Y el proceso al que pertenece queda en estado `parcial`, no `completado`, así que la pasada siguiente vuelve a intentarlo: sin eso, el registro del fallo era información que nadie podía usar.

---

## Pruebas

```bash
npm test        # jest + ts-jest
npm run lint    # tsc --noEmit, comprobación de tipos en modo estricto
```

El arnés está configurado en `jest.config.js`: preset `ts-jest`, entorno `node`, y los tests se buscan en `src/__tests__/**/*.test.ts`. **Diez suites, todas sin red.** El recuento exacto lo da `npm test`; aquí no se repite un número que envejece con cada commit.

| Suite | Qué fija |
|---|---|
| `jsf.test.ts` | El contrato que el servidor exige y no se puede negociar: formulario íntegro, `ViewState` vigente y los cuatro marcadores de A4J. Se comprueba contra la captura real del portal. |
| `parser.test.ts` | Mapeo por cabecera, fecha brasileña a ISO, columnas desconocidas a `camposExtra`, extracción del enlace a la ficha, y —la más valiosa— que una estructura cambiada rompa **ruidosamente**. |
| `moderno.test.ts` | La variante moderna contra **HTML real**: detección de plantilla, las 30 filas del TRF5 y las 30 del TRF1 —22 con número y 8 en segredo de justiça, ninguna descartada— (misma vista, **otra instancia** — es la prueba de que no hay ids codificados), los totales del pie de tabla, la delegación de `parsearProcesos`, y de la ficha: partes de los dos polos, cabeceras descontaminadas del JavaScript de RichFaces y preferencia del PDF real sobre el visor HTML. |
| `persistencia.test.ts` | Deduplicación por `claveUnica` —incluida la de dos procesos en sigilo distintos, que NO se funden en uno—, migración de un `records.json` del formato anterior, escritura atómica sin `.tmp` huérfanos, degradación ante ficheros corruptos y formato del CSV. |
| `descarga.test.ts` | Que el nombre de fichero sobreviva a lo que el portal escriba en un título, y que la ruta final solo aparezca si lo descargado es un PDF de verdad. |
| `retry.test.ts` | El requisito 3 del enunciado: detección del `429`, retroceso exponencial con jitter y tope, `Retry-After`, y qué se propaga cuando ya no se puede seguir. |
| `peru.test.ts` | El objetivo peruano: indexación por rótulo (no por posición), el total leído como **páginas** y no como registros, la clave derivada del `uuid` cuando falta el expediente, que «Ver Ficha» **no** se emita como URL porque es un postback, el descarte ruidoso de un panel sin clave, y el protocolo parcial de JSF 2 —CDATA, `<redirect>` y el rechazo de un id que el documento vigente no tiene—. |
| `paginacion.test.ts` | El contrato de navegación, que antes no tenía ninguna prueba: lectura del `rich:datascroller` (id, formulario, página activa y ventana), que los valores simbólicos (`first`, `next`) no se confundan con números de página, que el `onclick` se analice aunque `parameters` no sea la primera clave, y que el control «pulsado» no sea el id del scroller —enviaría dos veces ese nombre y el datascroller recibiría un texto donde espera un número—. |
| `reanudacion.test.ts` | Que reanudar exija el **mismo criterio de búsqueda**: la página 50 de una búsqueda no es la página 50 de otra. |
| `objetivo.test.ts` | Qué portal se activa y dónde escribe: que el argumento explícito mande sobre `TARGET` (un `TARGET` vacío heredado de un CI hacía que `npm run peru` corriera el scraper brasileño en silencio), que `trf5` conserve **exactamente** su carpeta de salida histórica y que `peru` use la suya, para no mezclar dos jurisdicciones en un mismo `records.json`. |

Dos decisiones del arnés que conviene conocer:

- **Los fixtures están versionados en `src/__tests__/fixtures/`, no en `output/`.** `output/` está en `.gitignore`, así que una prueba anclada ahí pasaría en la máquina donde se capturó y fallaría en cualquier clon limpio. `portal-inicio.html` es la captura real del portal con el `JSESSIONID` sustituido por `SESION-REDACTADA`: un identificador de sesión no entra en el control de versiones, aunque esté caducado, y la forma `;jsessionid=<valor>.<nodo>` —que es lo único que las pruebas comprueban— se conserva intacta.
- **Hay dos clases de fixture y valen cosas distintas.** Los `resultados-*.html` son **sintéticos** y lo dicen en su cabecera: reproducen los marcadores estructurales que RichFaces 3.3 genera siempre, no una fila real de la variante antigua del TRF5, que sigue sin verificarse (ver **Limitaciones conocidas**). Lo que demuestran no es que el parser acierte con ese portal, sino que se adapta a lo que reconoce y falla ruidosamente con lo que no. Los `pje-nuevo-*.html` y `portal-inicio.html`, en cambio, son **capturas reales**, y las pruebas de `moderno.test.ts` que corren sobre ellas sí demuestran acierto contra HTML servido por el PJe.

---

## Limitaciones conocidas

### Del objetivo `peru`

**Solo se puede ejecutar desde Perú.** El WAF Radware responde `403` a todo lo demás. No es una limitación del scraper y no se arregla con reintentos: hay que salir por una IP peruana, y con una VPN de **ámbito de sistema**, no de extensión de navegador. Consecuencia práctica: **el recorrido completo no se ha ejecutado desde esta máquina**, porque no había ruta de red hacia el portal para el proceso de Node. Lo que sí está verificado en vivo, con el navegador saliendo por Perú, es el protocolo entero: el POST de búsqueda con sus parámetros, el POST parcial de paginación con `formBuscador:data1:page=N`, la estructura de los paneles de resultado y **la propia descarga, byte a byte** — tres resoluciones distintas servidas por `ServletDescarga?uuid=` con `200`, firma `%PDF-` y tamaños y SHA-256 distintos (`docs/protocolo-peru.md`, §4); el `503` de la primera sesión confirma además el límite de tasa. El código reproduce ese protocolo; la ejecución de punta a punta la tiene que hacer quien disponga de la salida de red.

**«Ver Ficha» no se sigue.** Se comprobó en el portal que ese botón es `href="#"` con un postback de RichFaces, no una URL navegable, así que el parser **no emite `apertura`** para él en lugar de fabricar un enlace que devolvería la misma página de resultados. No es una pérdida de información del enunciado: los rótulos que el panel de la lista publica —tipo de recurso, expediente, pretensión o delito, tipo y fecha de resolución, sala suprema, norma de derecho interno, sumilla y palabras clave— se extraen todos, y el PDF de la resolución cuelga de la propia lista. Lo que la ficha añada por encima de eso queda fuera.

**Los fixtures del objetivo peruano son estructuralmente reales pero no un volcado literal.** Se reconstruyeron recorriendo el DOM del portal en vivo; los `uuid` van sustituidos por marcadores y no se incluye ningún `ViewState` de sesión real. La cabecera del fixture lo dice con esas mismas palabras.

### Del objetivo `trf5`

**El CAPTCHA exige una persona, una vez por fase.** No es automatizable sin evadir una detección de bots del titular del sitio, y no se va a hacer. Una ejecución desatendida de principio a fin no es posible; lo más cerca que se puede estar es `CAPTCHA_MODE=file`, que solo cambia por dónde llega la respuesta humana.

**La fila de resultados está verificada en la variante moderna; en la del objetivo, no.** Aquí hay que separar dos cosas que antes se contaban como una sola:

- **Variante moderna («fPP»): VERIFICADA contra tres capturas reales de tres instancias distintas** — `pje-nuevo-resultados.html` (TRF5 *treinamento*, contexto `/pjeconsulta`), `pje-nuevo-resultados-trf1.html` (TRF1, contexto `/consultapublica`) y `pje-nuevo-ficha.html` (una ficha completa). Están versionadas en `src/__tests__/fixtures/` y `src/__tests__/moderno.test.ts` corre contra ellas sin red. De ahí sale la estructura real: tres columnas, celda «Processo» compuesta (clase judicial + sigla + número CNJ + asunto + los dos polos), total en `<span class="text-muted">N resultados encontrados</span>` y ficha abierta por GET con `?ca=<hash>`. La captura del TRF1 no es una repetición: es la que demuestra que **no hay ids codificados a mano**, porque los sufijos `j_idNNN` de la misma vista cambian de un tribunal a otro (`j_id257` frente a `j_id259`).
- **Variante antigua («seam»), que es la del objetivo — `pje.trf5.jus.br/pjeconsulta/`, 1.er grado: SIGUE SIN VERIFICAR, y el motivo es su CAPTCHA de imagen.** Ese CAPTCHA está validado en servidor y bloquea la lista de resultados, así que nunca se ha visto una fila real de esa instancia. Lo que hay para ella es hipótesis razonada: marcadores estructurales que RichFaces 3.3 genera siempre (`rich-table`, `rich-table-row`, `tbody` con sufijo `:tb`), indexación por cabecera con sinónimos tolerantes en vez de por posición, cada fila anclada al número CNJ **o, si el expediente corre en segredo de justiça y no lo publica, al `ca=` de su enlace a la ficha**, y todo lo no reconocido a `camposExtra`. Cuando encuentra una tabla que estructuralmente es la de resultados pero cuyo contenido ya no reconoce, **lanza `EstructuraInesperadaError` en lugar de devolver filas a medias**: si la suposición es incorrecta, la ejecución se detiene con un mensaje que incluye la primera fila, no produce datos silenciosamente equivocados.

**Dato medido que no es un fallo, y el agujero que abrió:** en el fixture del TRF1, de sus 30 filas solo **22 publican número CNJ**; en las otras 8 el rótulo dice solo «PJEC - *Assunto*» y la columna de movimentación llega vacía. Son procesos en *segredo de justiça*.

Durante un tiempo esas 8 filas **se descartaban** con una traza de depuración, porque `numeroProcesso` era la clave de deduplicación de todo el scraper y no había con qué sustituirlo. Es decir: se tiraba el **27 % de la página** en silencio, contra un enunciado que pide extraer toda la información disponible. Ya no. Ahora salen las **30**, con `enSigilo: true`, sin `numeroProcesso` y con una `claveUnica` derivada del `ca=` de su ficha (ver **`claveUnica` y `numeroProcesso` no son el mismo campo**), y de ellas se extrae todo lo que el portal sí publica: clase judicial, sigla, asunto, las dos partes y el enlace a su ficha. Lo único que se descarta ahora es la fila que no tiene **ni** número **ni** enlace —no hay clave posible con la que guardarla—, y eso se dice con un `log.warn`, no con un `debug`.

Por el mismo motivo, `EstructuraInesperadaError` ya no se lanza cuando ninguna fila trae número, sino cuando ninguna trae **ni número ni enlace**: una página entera de procesos en segredo de justiça es legítima, y con el criterio anterior habría abortado la extracción tomándola por rota.

En el fixture del TRF5 las 30 filas traen número y salen 30 procesos, ninguno en sigilo.

**La navegación a la ficha está verificada en la variante moderna.** La fila publica la ficha como una URL (`openPopUp('…','/<ctx>/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=<hash>')`) y el portal la sirve con un GET normal y las cookies de la sesión, sin CAPTCHA. La Fase 2 la usa tal cual y **ni siquiera necesita rehacer la búsqueda**. En la variante antigua ese control sigue sin capturarse: `parser.ts` lo lee con un criterio deliberadamente estrecho —el control rotulado con el propio número del proceso, la única señal autoverificable, o el único de la fila—, y con varios controles y ninguno rotulado con el número **no adivina**: omite `apertura`, y la Fase 2 anota el proceso en `failed.json` con fase `ficha` y sigue. Un `apertura` equivocado descargaría el documento de otra cosa con aspecto de estar funcionando, que es peor que no descargar nada.

**Volver a la lista entre fichas solo hace falta con `apertura` de tipo postback, y eso no está verificado.** Cuando toca, la sesión restaura una copia del documento en lugar de repetir la búsqueda (que costaría otro CAPTCHA por expediente), lo que reenvía un `ViewState` anterior; JSF 1.2 con estado en servidor conserva varias vistas por sesión, así que suele aceptarse, pero no está comprobado en este portal. Si el TRF5 lo rechaza, el POST responde con una redirección, el scraper lo reconoce como `SesionCaducadaError`, detiene la Fase 2 con un mensaje explícito y no marca nada como completado.

**No todo documento de la ficha se puede bajar como PDF.** El único camino verificado sirviendo un binario es `reportReciboPDF.seam` (200 `application/pdf`, bytes `%PDF-1`), y es el que `ficha.ts` prefiere. Los documentos cuyo único enlace es el visor `documentoSemLoginHTML.seam` se emiten igualmente —con su título, su fecha y su `idProcessoDoc`, que son información legítima del expediente—, pero ese servlet devuelve `text/html`, así que `ServicioDescarga` los rechaza por firma y quedan anotados en `failed.json`. Es deliberado: un fallo explícito vale más que una página HTML guardada en disco con extensión `.pdf`.

**El portal es lento e inestable.** Latencia observada de 1,8 a 2,1 s por GET con el servidor sano, y hasta 31 s cuando su pool de conexiones está saturado. El `errorUnexpected` por `IJ000655` aparece con frecuencia y no depende del scraper. Una ejecución puede pasar minutos esperando en la sonda de salud antes de poder siquiera pedir el CAPTCHA.

**El rendimiento está limitado a propósito, por cortesía.** 2 s entre peticiones, 3 s entre descargas de PDF, timeout de 60 s. Son valores conservadores frente a un servidor judicial que ya da muestras de estar al límite, y frente a un WAF con defensa anti-bot. Se pueden bajar en `src/config.ts`, pero no se recomienda: la alternativa realista a ir despacio no es ir rápido, es que el WAF bloquee la IP.

**El volumen total es desconocido.** No se ha llegado a ver cuántos registros publica la consulta ni cuántos caben por página. El scraper no depende de ese número —confirma el final con el paginador y con páginas vacías consecutivas—, pero tampoco puede anunciar un porcentaje de avance fiable.

---
## Cumplimiento del enunciado

Cada fila dice **dónde** está resuelto y **con qué evidencia**. La columna de evidencia distingue tres cosas que no valen lo mismo, y distinguirlas es el punto de la tabla:

- **En vivo** — ejercitado contra el portal real, con log en `docs/evidencia/`.
- **Probado** — fijado por una prueba automática sin red.
- **Sin verificar** — implementado y razonado, pero nunca ejercitado. Se dice, no se disimula.

| Requisito del enunciado | Dónde está resuelto | Evidencia |
|---|---|---|
| **1. Navegar por todo el sitio** | `peru`: `src/peru/scraper.ts` recorre el paginador; `src/peru/session.ts` (`irAPagina`) envía la petición parcial de JSF 2 con `formBuscador:data1:page=N`. `trf5`: `src/paginacion.ts` + `src/scraper.ts`. | **Probado** (`paginacion.test.ts`, `peru.test.ts`). El protocolo de paginación peruano se capturó del portal en vivo (POST y parámetros exactos en `docs/protocol.md`); el recorrido completo de las 15.247 páginas **no se ha ejecutado entero**. |
| **1b. Extraer toda la información de cada documento** | `peru`: `src/peru/parser.ts` indexa **por rótulo**, así que todo campo publicado se emite —los mapeados al contrato y el resto a `camposExtra`—. `trf5`: `src/parser.ts`, `src/parserModerno.ts`, `src/ficha.ts`. | **Probado** en ambos. En `trf5`, además **en vivo**: 30 procesos reales con partes, clase, asunto y documentos. |
| **2. Descargar los PDF asociados** | `src/descarga.ts` (`ServicioDescarga`), compartido por los dos objetivos. En `peru` el enlace (`ServletDescarga?uuid=`) viene en la propia lista; en `trf5`, de la ficha. | **En vivo** en `trf5`: 13 PDF reales, tamaños distintos y firma `%PDF-` comprobada uno a uno (`docs/evidencia/pdfs-descargados.md`). En `peru`, la descarga está **verificada byte a byte** contra el portal en vivo: tres resoluciones distintas, `200` con firma `%PDF-`, tamaños y SHA-256 distintos (tabla en `docs/protocolo-peru.md`, §4); el `503` de la primera sesión confirma además que el endpoint limita la tasa. Pendiente solo la ejecución desde Node, que exige VPN de ámbito de sistema. |
| **2b. Nombre descriptivo, carpeta organizada** | `ServicioDescarga.rutaDestino` compone `<proceso>_<idDocumento>_<titulo>.pdf` bajo `output/pdfs/`; `nombreSeguro` sanea para Windows (caracteres ilegales, dispositivos DOS, puntos finales, longitud). | **Probado** (`descarga.test.ts`) y **en vivo**. |
| **2c. Basta demostrar que puede, sin bajarlos todos** | `MAX_DESCARGAS` (25 por defecto) acota la Fase 2; `MAX_PAGINAS` acota la Fase 1. La reanudación por `state.json` es lo que hace que «dejarlo corriendo hasta el final» sea real y no teórico. | **En vivo**. |
| **3. Detectar el `429`** | `src/utils/retry.ts`: `429` está en `RETRYABLE`. | **Probado** (`retry.test.ts`). |
| **3b. Reintentos con retroceso exponencial** | `calcularEspera`: `base·2^(n-1)` con jitter y tope, y respeta `Retry-After`. | **Probado**. |
| **3c. Continuar con el siguiente si el fallo persiste** | El `try/catch` por documento de ambas Fase 2 registra y sigue; el bucle no se rompe. Un `429` persistente **al paginar** también termina el recorrido de forma ordenada, exportando el CSV de lo ya extraído en vez de morir con «Error no recuperable». | **Probado** y **en vivo** (un documento se rechazó por venir en HTML y la ejecución continuó). |
| **3d. Registrar qué documentos fallaron para reintentarlos** | `src/persistencia.ts` (`registrarFallo`) → `output/failed.json`, con **el documento concreto** (`id` y título), el motivo, la fase y el contador de intentos **por documento**. Y el proceso queda en estado `parcial`, no `completado`, así que la pasada siguiente **sí lo reintenta**. | **Probado** (`persistencia.test.ts`). |
| **4. TypeScript, sin Puppeteer/Playwright/Selenium** | `tsconfig.json` en modo `strict`. Dependencias de ejecución: `axios`, `cheerio`, `iconv-lite`. Ninguna automatización de navegador, en ningún objetivo. | **Verificable** en `package.json`. |
| **5. Código estructurado y documentado** | Capas separadas (`http/`, `jsf/`, `peru/`, `captcha/`, `utils/` y los módulos de dominio); cada fichero abre con el porqué de su diseño; `docs/arquitectura.md` y `docs/protocol.md`. | — |
| **6. Repositorio con fuente, `package.json`, `README.md` y `.gitignore`** | Los cuatro en la raíz. | — |
| Tip: delays entre peticiones | `CONFIG.delayBetweenRequestsMs` (2 s) impuesto por `ClienteHttp` en **cada** petición, y `delayBetweenDownloadsMs` (3 s) entre PDF. | **En vivo**. |
| Tip: retry inteligente | `withRetry` clasifica antes de reaccionar: fatales sin dormir, transitorios con retroceso, y una espera específica para el pool agotado del TRF5. | **Probado**. |
| Tip: datos en formato estructurado | `records.json` (indexado por `claveUnica`) y `records.csv` (RFC 4180, BOM UTF-8). | **En vivo**. |
| Tip: probar con un subconjunto | `TEXTO`/`EXPEDIENTE`/`ANIO` en `peru`; `NOME_PARTE`/`NUMERO_PROCESSO` en `trf5`; `MAX_PAGINAS` y `MAX_DESCARGAS` en ambos. | **En vivo**. |
| Tip: logging del progreso | `src/utils/logger.ts`: una línea por página, descarga y reintento; `DEBUG=1` para el detalle HTTP. | **En vivo**. |
| Tip: PDF en carpeta organizada | `output/pdfs/` (`output/peru/pdfs/` en el objetivo peruano), con el identificador del expediente como prefijo para que los documentos de un mismo proceso queden juntos al ordenar. | **En vivo**. |

### Lo que esta tabla NO afirma

Que el recorrido completo de cualquiera de los dos portales se haya ejecutado de principio a fin. No se ha hecho, y el enunciado tampoco lo exige: pide demostrar que el scraper *puede* llegar al final si se deja corriendo. Lo que sostiene esa afirmación es la reanudación por `state.json`, la deduplicación por `claveUnica` y el corte del recorrido con evidencia (paginador agotado, total alcanzado o páginas vacías consecutivas), no una ejecución de ocho horas que nadie ha visto.

---

## Licencia y alcance

MIT. Sobre el carácter público de la fuente, los datos personales que contienen los registros judiciales y la autorización bajo la que se ejecuta este scraper, ver `docs/scope.md`.
