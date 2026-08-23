# Scraper · Consulta Pública del PJe TRF5

Scraper en TypeScript que recorre la Consulta Pública del Processo Judicial Eletrônico (PJe) del Tribunal Regional Federal da 5ª Região (`https://pje.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam`), extrae los metadatos de cada proceso listado y descarga los PDF asociados. Trabaja solo con HTTP (axios + cheerio) replicando el protocolo Ajax4jsf de la aplicación JBoss Seam 2 / JSF 1.2 / RichFaces 3.3 que hay detrás, sin ninguna automatización de navegador.

---

## Requisitos previos

| Requisito | Detalle |
|---|---|
| Node.js | 18 o superior (declarado en `engines` de `package.json`) |
| npm | El que acompañe a esa versión de Node |
| Red | Salida directa a Internet, **sin VPN ni proxy de alojamiento** |
| Persona disponible | El portal exige un CAPTCHA; hay que teclearlo una vez por fase |

### Aviso: ejecutar SIN VPN

**Este es el error número uno con el que se topa quien ejecuta el scraper por primera vez.**

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

| Comando | Qué hace |
|---|---|
| `npm start` | Menú interactivo (1 = Fase 1, 2 = Fase 2, 3 = flujo completo) |
| `npm run fase1` | Solo Fase 1: recorre el paginador y extrae metadatos a `records.json` / `records.csv` |
| `npm run fase2` | Solo Fase 2: descarga los PDF de los procesos ya indexados por la Fase 1 |
| `npm run completo` | Fase 1 seguida de Fase 2 en la misma ejecución |
| `npm run explorar` | Diagnóstico: abre sesión, hace una búsqueda y vuelca la estructura del portal a `output/raw/` sin paginar ni descargar |
| `npm test` | Suite de Jest (ver la sección **Pruebas**) |
| `npm run build` | Compila a `dist/` con `tsc` |
| `npm run lint` | Comprobación de tipos sin emitir, del código **y de las pruebas** (`tsconfig.json` + `tsconfig.test.json`) |

### Variables de entorno

| Variable | Por defecto | Efecto |
|---|---|---|
| `SECAO` | `0` | Valor del selector Seção/Subseção. `0` es «TRF - 5ª Região», la opción más amplia del desplegable. El portal exige al menos un criterio de búsqueda, y este es el que se envía siempre. |
| `NOME_PARTE` | (sin valor) | Criterio adicional por nombre de parte. Útil para acotar el conjunto de prueba. |
| `NUMERO_PROCESSO` | (sin valor) | Criterio por número CNJ concreto. Sin él se envía la máscara vacía `_______-__.____._.__.____`, que es lo que manda el navegador. |
| `MAX_DESCARGAS` | `25` | Tope de PDF por ejecución de la Fase 2. El enunciado no exige bajarlos todos. |
| `MAX_PAGINAS` | `10000` | Tope de páginas de la Fase 1. Red de seguridad ante un paginador que no termine. |
| `CAPTCHA_MODE` | (terminal) | Con el valor `file`, la respuesta del CAPTCHA se lee de `output/captcha.txt` en vez de la terminal. |
| `DEBUG` | (sin valor) | Con cualquier valor, traza cada petición HTTP (método, URL, código, bytes) y el detalle de cada respuesta A4J. |
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
  │    publicó (postback A4J o GET), parsearDocumentos() lee sus         │
  │    documentos, y al terminar se restaura la lista para el siguiente  │
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
├── parser.ts             parsearProcesos, parsearDocumentos, detectarTotalResultados,
│                         EstructuraInesperadaError
├── paginacion.ts         detectarPaginacion, construirOpcionesPagina, hayPaginaSiguiente
├── persistencia.ts       Persistencia: JSON atómico, dedupe por número CNJ, estado, fallos, CSV
├── descarga.ts           ServicioDescarga, DescargaInvalidaError, nombres de fichero seguros
├── http/
│   └── client.ts         ClienteHttp: cookies, ISO-8859-1, pausa mínima, errores disfrazados de 200
├── jsf/
│   ├── form.ts           extraerFormulario, fijarCampo, buscarCampo
│   └── a4j.ts            construirCuerpoA4J, aplicarRespuestaA4J
├── captcha/
│   └── humano.ts         CaptchaHumano (terminal), CaptchaPorArchivo (fichero), CaptchaFijo (pruebas)
├── utils/
│   ├── logger.ts         log.info / warn / error / debug con marca de tiempo relativa
│   └── retry.ts          withRetry, sleep, esReintentable, calcularEspera,
│                         ServidorSaturadoError, SesionCaducadaError, BloqueadoPorWafError
└── __tests__/            Suite de Jest (5 ficheros, 121 pruebas, sin red)
    └── fixtures/         portal-inicio.html (captura real, JSESSIONID redactado) y
                          fixtures sintéticos de resultados, paginador y respuestas A4J

tsconfig.json            Configuración de compilación (excluye las pruebas de dist/)
tsconfig.test.json       La misma en modo noEmit, incluyendo las pruebas, para `npm run lint`

docs/
├── protocol.md           Nota de protocolo: sesión, ViewState, cuerpo exacto del POST A4J,
│                         tabla de señales de fallo, lo verificado y lo pendiente
├── scope.md              Alcance, carácter público de la fuente y autorización
└── arquitectura.md       Decisiones de diseño y flujo de datos
```

---

## Salida

Todo se escribe bajo `output/`, que está en `.gitignore` porque contiene datos recogidos del portal.

| Ruta | Contenido |
|---|---|
| `output/records.json` | Los procesos, como objeto **indexado por número CNJ** (no array). La clave la asigna el poder judicial, así que la deduplicación es O(1) y los duplicados son imposibles por construcción. |
| `output/records.csv` | Las columnas estables del contrato, con BOM UTF-8 y CRLF para que Excel en Windows no destroce los acentos. Los documentos van como recuento; el detalle está en el JSON. |
| `output/state.json` | Estado de reanudación: criterio de búsqueda, última página completada, si la extracción terminó y el total anunciado por el portal. |
| `output/failed.json` | Los fallos, con clave (número de proceso, fase), motivo, número de intentos y marca del último. |
| `output/pdfs/` | Los PDF descargados, nombrados `<numeroCNJ>_<idDocumento>_<titulo>.pdf`. |
| `output/captcha.png` | La última imagen de CAPTCHA servida. Es de trabajo, no de resultado. |
| `output/raw/` | Respuestas crudas del portal, solo cuando `GUARDAR_RAW` está activo. |

### Ejemplo de un registro

**Los valores de abajo son ilustrativos**, no una captura real: la forma exacta de la fila de resultados todavía no se ha podido verificar contra una respuesta con resultados (ver **Limitaciones conocidas**). Los nombres de campo sí son los del contrato de `src/types.ts`.

```json
{
  "0801234-56.2023.4.05.8300": {
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

Campos con dos orígenes distintos: `numeroProcesso`, `orgaoJulgador`, `classeJudicial`, `dataAutuacao`, `partes`, `documentos`, `apertura` y `camposExtra` vienen del portal; `paginaOrigen`, `estado`, `archivos` y `vistoEn` los añade el scraper. Ningún campo se emite vacío por defecto: si el portal no publica un dato, el campo se omite en lugar de prometer una columna siempre en blanco.

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
| Tabla de RichFaces con filas pero sin ningún número CNJ | La estructura de la tabla de resultados cambió. | `EstructuraInesperadaError` con una muestra de la primera fila. Se anota como fallo de fase `pagina` y se corta la Fase 1, en lugar de escribir registros a medias. |

Qué queda registrado en `failed.json`: el scraper emite tres fases, `pagina` (una página que no se pudo parsear), `ficha` (un proceso cuya ficha no se pudo abrir, incluido el caso en que la fila no publica de forma inequívoca cómo abrirla) y `documento` (un PDF que no se pudo descargar). Cada entrada es única por (proceso, fase) y acumula `intentos` en vez de duplicarse, de modo que el contador sirve para decidir cuándo rendirse con ese documento en una pasada posterior.

---

## Pruebas

```bash
npm test        # jest + ts-jest
npm run lint    # tsc --noEmit, comprobación de tipos en modo estricto
```

El arnés está configurado en `jest.config.js`: preset `ts-jest`, entorno `node`, y los tests se buscan en `src/__tests__/**/*.test.ts`. Cinco suites, **121 pruebas**, todas sin red:

| Suite | Qué fija |
|---|---|
| `jsf.test.ts` | El contrato que el servidor exige y no se puede negociar: formulario íntegro, `ViewState` vigente y los cuatro marcadores de A4J. Se comprueba contra la captura real del portal. |
| `parser.test.ts` | Mapeo por cabecera, fecha brasileña a ISO, columnas desconocidas a `camposExtra`, extracción del enlace a la ficha, y —la más valiosa— que una estructura cambiada rompa **ruidosamente**. |
| `persistencia.test.ts` | Deduplicación por número CNJ, escritura atómica sin `.tmp` huérfanos, degradación ante ficheros corruptos y formato del CSV. |
| `descarga.test.ts` | Que el nombre de fichero sobreviva a lo que el portal escriba en un título, y que la ruta final solo aparezca si lo descargado es un PDF de verdad. |
| `retry.test.ts` | El requisito 3 del enunciado: detección del `429`, retroceso exponencial con jitter y tope, `Retry-After`, y qué se propaga cuando ya no se puede seguir. |

Dos decisiones del arnés que conviene conocer:

- **Los fixtures están versionados en `src/__tests__/fixtures/`, no en `output/`.** `output/` está en `.gitignore`, así que una prueba anclada ahí pasaría en la máquina donde se capturó y fallaría en cualquier clon limpio. `portal-inicio.html` es la captura real del portal con el `JSESSIONID` sustituido por `SESION-REDACTADA`: un identificador de sesión no entra en el control de versiones, aunque esté caducado, y la forma `;jsessionid=<valor>.<nodo>` —que es lo único que las pruebas comprueban— se conserva intacta.
- **Los fixtures `resultados-*.html` son sintéticos y lo dicen en su cabecera.** Reproducen los marcadores estructurales que RichFaces 3.3 genera siempre, no una fila real del TRF5, que sigue sin estar verificada (ver **Limitaciones conocidas**). Lo que demuestran no es que el parser acierte con el portal, sino que se adapta a lo que reconoce y falla ruidosamente con lo que no.

---

## Limitaciones conocidas

**El CAPTCHA exige una persona, una vez por fase.** No es automatizable sin evadir una detección de bots del titular del sitio, y no se va a hacer. Una ejecución desatendida de principio a fin no es posible; lo más cerca que se puede estar es `CAPTCHA_MODE=file`, que solo cambia por dónde llega la respuesta humana.

**La forma exacta de la fila de resultados no está verificada.** `docs/protocol.md` la deja marcada como PENDIENTE: en las capturas de reconocimiento el servidor del TRF5 falló con `errorUnexpected` antes de devolver una lista con resultados, así que nunca se ha visto una fila real. El parser está escrito sobre los marcadores estructurales que RichFaces 3.3 genera siempre (`rich-table`, `rich-table-row`, `tbody` con sufijo `:tb`), indexa por cabecera con sinónimos tolerantes en vez de por posición, ancla cada fila al formato del número CNJ y manda a `camposExtra` todo lo que no reconoce. Y cuando encuentra una tabla que estructuralmente es la de resultados pero cuyo contenido ya no reconoce, **lanza `EstructuraInesperadaError` en lugar de devolver filas a medias**. Es decir: si la suposición es incorrecta, la ejecución se detiene con un mensaje que incluye la primera fila, no produce datos silenciosamente equivocados. Lo mismo vale para los pasos 5 y 6 del diagrama: si el portal exige un segundo CAPTCHA al abrir un proceso, aún no está confirmado.

**La navegación a la ficha de un proceso no está verificada.** La Fase 2 necesita abrir el expediente para leer sus documentos, y el control que lo abre vive en la fila de resultados, que es justo lo que no se ha podido capturar. `parser.ts` lo lee con un criterio deliberadamente estrecho: acepta el control rotulado con el propio número del proceso —la única señal autoverificable— o, si la fila trae uno solo, ese. Con varios controles y ninguno rotulado con el número **no adivina**: omite el campo `apertura`, y la Fase 2 anota el proceso en `failed.json` con fase `ficha` y sigue. Un `apertura` equivocado descargaría el documento de otra cosa con aspecto de estar funcionando, que es peor que no descargar nada.

Entre ficha y ficha la sesión vuelve a la lista restaurando una copia del documento, en lugar de repetir la búsqueda (que costaría otro CAPTCHA por expediente). Eso reenvía un `ViewState` anterior; JSF 1.2 con estado en servidor conserva varias vistas por sesión, así que suele aceptarse, pero **tampoco está verificado en este portal**. Si el TRF5 lo rechaza, el POST responde con una redirección, el scraper lo reconoce como `SesionCaducadaError`, detiene la Fase 2 con un mensaje explícito y no marca nada como completado.

**El portal es lento e inestable.** Latencia observada de 1,8 a 2,1 s por GET con el servidor sano, y hasta 31 s cuando su pool de conexiones está saturado. El `errorUnexpected` por `IJ000655` aparece con frecuencia y no depende del scraper. Una ejecución puede pasar minutos esperando en la sonda de salud antes de poder siquiera pedir el CAPTCHA.

**El rendimiento está limitado a propósito, por cortesía.** 2 s entre peticiones, 3 s entre descargas de PDF, timeout de 60 s. Son valores conservadores frente a un servidor judicial que ya da muestras de estar al límite, y frente a un WAF con defensa anti-bot. Se pueden bajar en `src/config.ts`, pero no se recomienda: la alternativa realista a ir despacio no es ir rápido, es que el WAF bloquee la IP.

**El volumen total es desconocido.** No se ha llegado a ver cuántos registros publica la consulta ni cuántos caben por página. El scraper no depende de ese número —confirma el final con el paginador y con páginas vacías consecutivas—, pero tampoco puede anunciar un porcentaje de avance fiable.

---

## Cumplimiento del enunciado

| Requisito del desafío | Dónde está resuelto |
|---|---|
| 1. Navegar todo el sitio y extraer la información de cada documento | `src/scraper.ts` (`fase1`) recorre el paginador; `src/paginacion.ts` lee el `rich:datascroller` del HTML vigente y construye cada salto; `src/parser.ts` (`parsearProcesos`) extrae número CNJ, órgano, clase, fecha, partes y todo lo demás a `camposExtra`, y lee de la fila el control que abre la ficha (`apertura`); `fase2` abre la ficha de cada proceso y `parsearDocumentos` extrae sus documentos con su enlace de descarga. La navegación a la ficha **no está verificada** contra el portal: ver **Limitaciones conocidas** |
| 2. Descargar PDF con nombre descriptivo, en carpeta organizada | `src/descarga.ts`: `ServicioDescarga.rutaDestino` compone `<numeroCNJ>_<idDocumento>_<titulo>.pdf` bajo `output/pdfs/`; `nombreSeguro` sanea el texto del portal para el sistema de ficheros |
| 2b. Basta demostrar que puede, sin bajarlos todos | `MAX_DESCARGAS` (por defecto 25) acota la Fase 2 en `src/index.ts` y `src/scraper.ts` |
| 3. Detectar `429` y reintentar con retroceso exponencial | `src/utils/retry.ts`: `esReintentable` incluye `429` en `RETRYABLE`, `calcularEspera` aplica `base·2^(n-1)` con jitter y tope, y respeta `Retry-After` |
| 3b. Continuar con el siguiente si el fallo persiste | `src/scraper.ts` (`fase2`): el `try/catch` por documento registra y sigue; el bucle no se rompe por un documento |
| 3c. Registrar qué documentos fallaron | `src/persistencia.ts` (`registrarFallo`) → `output/failed.json`, con motivo, fase y contador de intentos |
| 4. TypeScript, sin Puppeteer/Playwright/Selenium | `tsconfig.json` en modo `strict`; las únicas dependencias de ejecución son `axios`, `cheerio` e `iconv-lite`. No hay ninguna automatización de navegador |
| 5. Código estructurado y documentado | Capas separadas (`http/`, `jsf/`, `captcha/`, `utils/` y los módulos de dominio); cada fichero abre con el porqué de su diseño; `docs/arquitectura.md` y `docs/protocol.md` |
| 6. Repositorio con fuente, `package.json`, `README.md` y `.gitignore` | Los cuatro están en la raíz del repositorio |
| Tip: delays entre peticiones | `CONFIG.delayBetweenRequestsMs` (2 s), impuesto por `ClienteHttp` en cada petición, y `CONFIG.delayBetweenDownloadsMs` (3 s) entre PDF |
| Tip: retry inteligente | `withRetry` clasifica antes de reaccionar: fatales sin dormir, transitorios con retroceso, y una espera específica de 90 s para el pool agotado del TRF5 |
| Tip: datos en formato estructurado | `output/records.json` (indexado por CNJ) y `output/records.csv` (RFC 4180, BOM UTF-8) |
| Tip: probar con un subconjunto | `NOME_PARTE`, `NUMERO_PROCESSO`, `MAX_PAGINAS` y `MAX_DESCARGAS` |
| Tip: logging del progreso | `src/utils/logger.ts`, con una línea por página, descarga y reintento, y `DEBUG=1` para el detalle HTTP |
| Tip: PDF en carpeta organizada | `output/pdfs/`, con el número de proceso como prefijo para que los documentos de un mismo expediente queden agrupados al ordenar |

---

## Licencia y alcance

MIT. Sobre el carácter público de la fuente, los datos personales que contienen los registros judiciales y la autorización bajo la que se ejecuta este scraper, ver `docs/scope.md`.
