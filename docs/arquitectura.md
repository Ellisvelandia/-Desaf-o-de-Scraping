# Arquitectura

Decisiones de diseño y flujo de datos del scraper de la Consulta Pública del PJe TRF5. Este documento explica el porqué; el cómo del protocolo está en `docs/protocol.md` y las instrucciones de uso en el `README.md`.

---

## 1. Capas

El proyecto se divide en cuatro capas. Cada una depende solo de las de abajo, y ninguna capa de transporte sabe nada del dominio judicial.

| Capa | Módulos | Responsabilidad | De qué no sabe nada |
|---|---|---|---|
| Transporte | `http/client.ts`, `utils/retry.ts`, `utils/logger.ts` | Cookies, charset, pausa mínima, clasificación de fallos, reintentos | Del PJe, de JSF y de procesos judiciales |
| Protocolo | `jsf/form.ts`, `jsf/a4j.ts` | Leer un formulario JSF y reproducir el ciclo petición/parcheo de RichFaces | De qué se está buscando |
| Dominio del portal | `session.ts`, `parser.ts`, `paginacion.ts`, `captcha/humano.ts` | La conversación concreta con la Consulta Pública y la lectura de sus tablas | De dónde se guardan los datos |
| Aplicación | `scraper.ts`, `persistencia.ts`, `descarga.ts`, `index.ts` | Orquestar las fases, persistir, descargar, hablar con el operador | De cómo se construye un cuerpo A4J |

`config.ts` y `types.ts` son transversales: el primero concentra todo valor que afecte al ritmo de peticiones o a las rutas de salida, para que el comportamiento sea auditable en un solo sitio; el segundo fija el contrato de datos.

Un corte concreto merece explicación: **`descarga.ts` no duerme**. Impone las tres invariantes de un fichero descargado, pero es `scraper.ts` quien espera `CONFIG.delayBetweenDownloadsMs` entre dos llamadas, porque solo el orquestador sabe cuántas descargas quedan y si hubo pausas por medio. La pausa que `ClienteHttp` impone entre peticiones es un suelo, no un sustituto.

---

## 2. Por qué HTTP puro y no un navegador

El enunciado prohíbe Puppeteer, Playwright y Selenium, así que la restricción viene dada. Pero la decisión se sostiene por sí sola, y conviene decir qué se gana y qué se paga.

Lo que se gana:

- **Coste por petición.** Un POST A4J son unos 3 KB de cuerpo y unos 42 KB de respuesta. Un navegador ejecutaría además el JavaScript de RichFaces, cargaría hojas de estilo e imágenes, y multiplicaría por cinco o por diez el tráfico contra un servidor judicial que ya da muestras de estar al límite. Ir ligero no es una optimización: es parte de la cortesía.
- **Determinismo.** No hay carrera entre el DOM y el scraper. Cada estado del documento es consecuencia explícita de una respuesta que se puede guardar en `output/raw/` y volver a parsear sin red.
- **Diagnóstico.** Cuando algo falla, lo que se tiene delante es una petición y una respuesta, no un navegador headless con una excepción de timeout.

Lo que se paga:

- Hay que **reimplementar el protocolo Ajax4jsf a mano**, que es donde está la dificultad real de este portal.
- El JavaScript del portal hace cosas que el scraper debe replicar explícitamente, como la máscara del campo `Processo` (`_______-__.____._.__.____`) que el navegador envía cuando ese campo está vacío.
- No hay ejecución de script, así que cualquier valor que el portal calcule en cliente hay que reconstruirlo leyendo el `onclick`. Es lo que hace `paginacion.ts` con `A4J.AJAX.Submit(...)`.

Consecuencia de diseño: el scraper **nunca inventa un valor que el portal ya publica**. Los ids que genera JSF (`j_idNNN`) cambian con cada versión de la vista, así que se leen del HTML vigente —id del scroller, id del formulario, parámetros acompañantes, `action` con su `;jsessionid=` incrustado— en lugar de codificarlos.

---

## 3. El documento vigente

Esta es la pieza central de la arquitectura y merece su propia sección.

Una aplicación JSF 1.2 con RichFaces no navega: mantiene el árbol de componentes en el servidor y cada interacción es un POST del formulario completo por XMLHttpRequest. La respuesta no es una página, es un XML con los fragmentos actualizados:

```xml
<meta name="Ajax-Update-Ids" content="id1,id2,…"/>
<span id="ajax-view-state"><input name="javax.faces.ViewState" value="j_id2"/></span>
```

El navegador toma esos fragmentos y sustituye en su DOM los elementos con esos ids. `SesionPje` hace exactamente lo mismo: guarda un documento cheerio **vigente** y lo parchea con cada respuesta (`aplicarRespuestaA4J`).

Por qué no las dos alternativas obvias:

- **Parsear cada respuesta A4J por separado y olvidarla.** No funciona: la respuesta trae solo los fragmentos que cambiaron. Tras paginar puede llegar la tabla pero no el formulario, y el POST siguiente necesita el formulario íntegro para ser válido. Sin documento acumulado no hay interacción siguiente.
- **Volver a pedir la página completa entre interacción e interacción.** Duplica el tráfico contra un servidor frágil y, peor, **pierde el estado**: la lista de resultados vive en la sesión del servidor y un GET limpio devuelve el formulario vacío, no la página 7 de resultados.

Del documento vigente se derivan tres propiedades útiles:

1. `extraerFormulario` siempre lee el formulario **real de este instante**, con su `ViewState` actual. El `ViewState` cambia con cada respuesta (`j_id1` en la carga inicial, `j_id2` tras el primer POST) y JSF valida el de la última; guardar uno junto a un documento para usarlo más tarde sería guardar algo ya caducado. Por eso `descarga.ts` reconstruye el cuerpo del postback sobre el formulario vigente de la sesión, y no sobre lo que se leyó al parsear la ficha.
2. El parser y el detector de paginación reciben un documento normal y son funciones puras sobre él. Se pueden probar con un fichero guardado, sin red.
3. Tras aplicar un parcheo, todos los `input[name="javax.faces.ViewState"]` del documento se sincronizan con el valor nuevo, de modo que da igual qué formulario se lea después.

Detalle de implementación que no es accidental: la respuesta A4J es XHTML, pero se parsea en modo HTML. Re-serializar en XML fragmentos que contienen `<script>` con CDATA no sobrevive a un segundo parseo.

---

## 4. Flujo de datos

```
   Portal TRF5
        │  HTML ISO-8859-1 / XML A4J
        ▼
   ClienteHttp ───────────── cookies (JSESSIONID + WAF), iconv-lite,
        │                    pausa mínima, 200-disfrazado-de-error → error tipado
        ▼
   SesionPje ─────────────── documento cheerio VIGENTE
        │                    (parcheado con cada Ajax-Update-Ids)
        ├──────────────► parser.ts ──────► ProcesoJudicial[]
        ├──────────────► paginacion.ts ──► ControlPaginacion → OpcionesA4J
        │
        ▼
   Scraper.fase1 ─────────── Map<numeroCNJ, ProcesoJudicial> en memoria
        │                    (flush por página)
        ▼
   Persistencia ──────────── records.json · records.csv · state.json · failed.json
        │
        ▼
   Scraper.fase2 ─────────── ServicioDescarga ──► output/pdfs/*.pdf
                                    │
                                    └─ fallo ──► Persistencia.registrarFallo
```

Las dos fases son **independientes y reanudables**. La Fase 1 se puede repetir sin duplicar nada (el mapa está indexado por número CNJ) y la Fase 2 se puede lanzar en otro momento sobre lo que la Fase 1 dejó en disco. Cada una abre su propia sesión y pide su propio CAPTCHA, porque el portal ata los identificadores de descarga al árbol de componentes de la sesión que los emitió.

---

## 5. Política de reintentos

La regla es **clasificar antes de reaccionar**. `esReintentable()` responde una sola pregunta —¿puede esto cambiar por esperar?— y de ella salen tres familias.

| Familia | Códigos y errores | Reacción |
|---|---|---|
| Fatal | `400`, `401`, `403`, `404`, `405`, `410`, `422`, `BloqueadoPorWafError`, `SesionCaducadaError`, `DescargaInvalidaError` | Se propaga en el primer intento, **sin dormir** |
| Transitorio de tasa o transporte | `408`, `429`, `500`, `502`, `503`, `504`, `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `ECONNABORTED`, `EPIPE` | Retroceso exponencial con jitter y tope |
| Saturación del portal | `ServidorSaturadoError` (`errorUnexpected.seam`, `IJ000655`) | Espera fija larga de 90 s, sesión nueva, reintento acotado |

La espera del intento `n` (1-based) es `min(baseDelayMs · 2^(n-1), maxDelayMs) + random(0, jitterMs)`, es decir 2 s, 4 s, 8 s… con tope de 60 s y hasta 500 ms de jitter. Si el servidor envía `Retry-After`, ese valor manda (acotado al mismo tope). El jitter existe para que varios reintentos no se sincronicen; el tope, para que un `429` persistente no acabe durmiendo horas.

Por qué cada familia es como es:

- **Los fatales no se reintentan, y el caso importante es el WAF.** Insistir contra un F5 que ya rechazó la IP convierte un bloqueo blando en uno duro. Que `BloqueadoPorWafError` sea explícitamente no reintentable es una decisión de seguridad operativa, no una omisión.
- **`SesionCaducadaError` tampoco se reintenta**, aunque «suene» transitorio: repetir el mismo POST con un `ViewState` muerto da el mismo resultado. La reparación es reabrir sesión, lo que implica un CAPTCHA nuevo, y esa decisión pertenece al orquestador, no al bucle de reintentos.
- **La saturación tiene su propia espera** porque su escala es otra: el pool de conexiones del TRF5 tarda decenas de segundos en recuperarse, y un retroceso de 2-4-8 s solo consigue cuatro fracasos rápidos.

Sobre la saturación hay además una defensa que no está en `retry.ts` sino en `session.ts`: antes de pedir un CAPTCHA, `esperarServidorSano()` sondea el portal con un GET barato y comprueba que la página trae el formulario. El motivo es de diseño de producto, no técnico: el CAPTCHA cuesta trabajo humano, y gastarlo en una búsqueda que el servidor no va a poder atender es el peor fallo posible de esta herramienta. Si la búsqueda falla por saturación después de todo, no se consume un intento de CAPTCHA: el fallo no fue del operador.

Y una tercera capa: `DescargaInvalidaError` es fatal a propósito. El portal responde `200` con la página de sesión caducada en lugar del artefacto, y reintentarlo produce N copias de la misma página de error. Por eso solo la petición entra en el bucle de reintentos; la validación queda fuera.

---

## 6. Modelo de reanudación

Una extracción contra este portal dura horas y se interrumpe: Ctrl+C, un `429` que agota reintentos, un corte de red, o el servidor del tribunal cayéndose. El diseño asume la interrupción en lugar de tratarla como excepción.

**Unidad de progreso: la página.** Tras cada página de resultados se escriben `records.json` y `state.json`. El coste máximo de una interrupción en la Fase 1 es una página; en la Fase 2, un proceso.

`ultimaPaginaCompletada` guarda la última página que se llegó a **parsear entera**, que no siempre es la página en curso: si el bucle se corta antes de procesarla —`EstructuraInesperadaError`, por ejemplo— anotar la página en curso haría que la ejecución siguiente reanudara *después* de una página que nunca se leyó, y esa página se perdería en silencio.

**Qué se guarda en `state.json`:**

| Campo | Para qué |
|---|---|
| `criterio` | Con qué se buscó. Una reanudación con otro criterio no es la misma extracción |
| `ultimaPaginaCompletada` | Desde dónde seguir |
| `extraccionCompletada` | Si el paginador se agotó **con evidencia**, no por una página vacía suelta |
| `totalAnunciado` | El total que dijo el portal, si lo dijo |
| `actualizadoEn` | Sellado por el escritor, no por el llamante: su significado es «cuándo se persistió esto» |

**Cómo se reanuda.** Una sesión nueva siempre empieza en la página 1 —el estado vive en el servidor y no hay forma de saltar—, así que la Fase 1 avanza el paginador en vacío hasta `ultimaPaginaCompletada` y solo entonces empieza a acumular. Es una petición por página saltada, y es el precio de un portal sin URLs navegables.

**Idempotencia.** La deduplicación es por `claveUnica`: el `numeroProcesso` cuando el portal lo publica —la clave que asigna el poder judicial, estable entre páginas y entre ejecuciones, a diferencia de cualquier id propio— y un identificador derivado del `ca=` del enlace a la ficha, con prefijo `sigilo:`, para los procesos en *segredo de justiça*, que no publican número. Son dos campos y no uno a propósito: `numeroProcesso` es un dato del portal y `claveUnica` un índice del scraper, y confundirlos es lo que lleva a rellenar el primero con un número inventado. `records.json` se escribe como **objeto indexado por `claveUnica`, no como array**, de modo que un duplicado es imposible por construcción y no depende de que nadie haga `push` dos veces. Un `records.json` del formato anterior (indexado por número, sin `claveUnica`) se migra al cargarlo, derivando la clave del número. El campo `vistoEn` marca el primer avistamiento y nunca se refresca; si se refrescara, dejaría de significar «primera vez».

**Cuándo se declara terminada la extracción.** Con tres señales, y ninguna de ellas por sí sola basta siempre:

1. El total anunciado por el portal se alcanzó. Se cuentan los procesos vistos **en esta ejecución**, no el tamaño del mapa acumulado: ese mapa arrastra lo que dejaron ejecuciones anteriores, quizá con otro criterio de búsqueda, y usarlo daría por terminada una búsqueda nueva y más estrecha en su primera página.
2. `hayPaginaSiguiente()` dice que no. Este control se re-detecta en **cada** página, porque el `rich:datascroller` dibuja una ventana deslizante: estando en la página 3 de 40 puede mostrar solo «1 2 3 4 5», así que su último número es un mínimo, no el total.
3. Dos páginas vacías **consecutivas**. Una sola puede ser un hipo del servidor, y declarar el final por ella marcaría `extraccionCompletada` y bloquearía futuras ejecuciones sobre datos incompletos.

Ante la duda, `hayPaginaSiguiente()` responde `true`: pedir una página de más cuesta una petición; pararse de más pierde datos en silencio.

**Lectura defensiva.** Todo `JSON.parse` va acorralado y cada fichero pasa por una guarda de tipo. Un `records.json` escrito por otra versión o editado a mano degrada a «empezar de cero con un aviso por log», nunca a una excepción no capturada que tumbe el arranque. Un fichero ilegible se aparta a `<ruta>.corrupto-<epoch>` en vez de dejar que el siguiente guardado lo pise: puede contener horas de extracción rescatables a mano.

**Escritura atómica.** Todo guardado es temporal + `rename`. `rename` es atómico dentro del mismo volumen y en Windows reemplaza el destino, así que el fichero final nunca existe a medias: o es el contenido anterior completo, o el nuevo completo. Un proceso muerto a mitad de un `writeFileSync` dejaría un JSON truncado que reventaría la ejecución siguiente, justo cuando más importa poder reanudar. Si la escritura falla, el `.tmp` se limpia antes de propagar el error real: un temporal huérfano confunde en el arranque siguiente y, si el fallo fue por disco lleno, retiene el espacio que hace falta para reintentar.

---

## 6 bis. Cómo la Fase 2 llega a los documentos

Los documentos de un proceso están en **su** ficha, no en la lista de resultados. Es una distinción que parece obvia y cuya violación es difícil de ver: leer los enlaces del documento vigente sin haber navegado a ninguna ficha atribuye a *todos* los procesos los mismos controles de la página de resultados, y produce descargas equivocadas con aspecto de correctas. Ese es el fallo más caro posible aquí, porque no se manifiesta como un error.

El control que abre la ficha vive en la fila, y la fila solo existe mientras esa página está en el documento vigente. Por eso se lee en la **Fase 1** (`apertura`, en el contrato de `types.ts`) y se persiste junto al proceso, en lugar de intentar redescubrirlo en la Fase 2 cuando la página ya no está.

El criterio de lectura es estrecho a propósito, porque la forma de la fila no está verificada:

1. El control cuyo texto visible es el propio número del proceso. Es la única señal autoverificable: ese enlace no puede ser otra cosa que el expediente.
2. Si no lo hay, el control **único** de la fila: con uno solo no hay ambigüedad que resolver adivinando.
3. Con dos o más y ninguno rotulado con el número, se omite el campo. La Fase 2 registra entonces `failed.json` con fase `ficha` y sigue con el proceso siguiente.

La ficha se abre **siempre**, aunque `records.json` ya traiga los documentos de ese proceso de una pasada anterior. Un `DescargaPostback` se reconstruye sobre el formulario vigente, y el control que descarga un documento solo existe —con un `ViewState` que JSF acepte— mientras su ficha es el documento vigente. Reutilizar la lista guardada para ahorrarse la navegación enviaría el postback contra el formulario de la lista, que no conoce ese control. Los documentos se persisten al leerlos aunque la descarga falle después: son parte de «toda la información de cada documento» que pide el enunciado y valen por sí mismos.

Entre ficha y ficha la sesión vuelve a la lista **restaurando una copia del documento** en vez de repetir la búsqueda, que costaría un CAPTCHA por expediente. Eso reenvía un `ViewState` anterior. JSF 1.2 con estado en servidor guarda cada vista con su clave y conserva varias por sesión, así que suele aceptarse; no está verificado en este portal. Si el TRF5 lo rechaza, el POST responde con una redirección, `enviarA4J` lo convierte en `SesionCaducadaError` y la Fase 2 se detiene con un mensaje explícito en lugar de recorrer los procesos restantes marcándolos fallidos uno a uno.

---

## 7. Garantías de la descarga

`ServicioDescarga` mantiene tres invariantes, y las tres nacen de fallos reales de scrapers contra este tipo de portal.

### La ruta final solo aparece cuando el fichero está completo y validado

Se escribe a `<destino>.part` y se renombra al final. La consecuencia es que **«si el fichero existe, sáltalo» es una decisión segura**: no puede dar por buena una descarga cortada a la mitad. Sin el temporal, un Ctrl+C en mitad de un PDF dejaría en el directorio un fichero con el nombre correcto y el contenido truncado, y la ejecución siguiente lo saltaría para siempre.

La escritura entra en el mismo `try` que la validación. Un fallo a mitad de `writeFileSync` —disco lleno, permisos— deja un `.part` truncado, y fuera del `try` nadie lo borraría: este es el único camino que limpia temporales.

### Un `200` no es un PDF

El portal responde `200` con la página de sesión caducada en lugar del artefacto. Es el fallo silencioso más caro de este scraper: sin validar se acaba con un directorio lleno de ficheros del mismo tamaño que nadie mira hasta el día de la entrega. Tres filtros, en este orden:

| Filtro | Rechaza |
|---|---|
| `Content-Type` es `text/html` o `application/xhtml` | La página de error servida como si fuera el documento |
| Tamaño en disco < 1024 B | Respuestas truncadas y escrituras cortas |
| Los primeros bytes no son `%PDF-` | Todo lo demás, y es el único filtro que no se puede falsear con cabeceras |

El tamaño se mide **en disco y no sobre el buffer**: así el mismo control cubre también una escritura corta, no solo una respuesta corta. Y el tamaño se registra en el log de cada descarga, porque una corrida donde todos los ficheros pesan igual es una corrida que bajó N veces la misma página de error.

### Un documento que falla es un documento perdido, no una ejecución perdida

Los errores se propagan al llamante, que los anota en `failed.json` con `(claveUnica, fase)` y continúa con el siguiente documento. Es literalmente lo que pide el enunciado, y es también la única política sensata contra un portal que falla de forma intermitente.

### Nombres de fichero

`<numeroCNJ>_<idDocumento>_<titulo>.pdf`, bajo `output/pdfs/`.

- El **número de proceso va primero** para que cada fichero sea trazable a su expediente sin abrir el JSON, y para que los documentos de un mismo proceso queden agrupados al ordenar el directorio.
- El **id del documento va antes del título** porque el título **no es único** dentro de un proceso: la ficha repite «Petição», «Certidão» o «Despacho» tantas veces como movimientos haya. Sin el id, el segundo documento homónimo encontraría el destino ya creado, se daría por descargado y se perdería en silencio. Va antes del título para que sobreviva al truncado por longitud.
- `nombreSeguro()` aplica, en este orden: sustitución de caracteres que Windows prohíbe (`<>:"/\|?*` y los de control), colapso de espacios, recorte de puntos y espacios finales —Windows los descarta al crear el fichero, y entonces la ruta que se cree escrita deja de coincidir con la que existe—, escape de los nombres de dispositivo heredados de DOS (`CON.pdf` abre la consola; `_CON.pdf` es un fichero) y truncado a 120 caracteres. El truncado va **al final** para que no reintroduzca un punto o un espacio final que el recorte anterior ya había quitado.

---

## 8. Formato de salida

Dos formatos con propósitos distintos, y la diferencia entre ellos es deliberada.

**`records.json`** es la fuente de verdad: objeto indexado por número CNJ, con toda la estructura anidada (partes, documentos, sus enlaces de descarga, `camposExtra`). Es lo que consume la Fase 2 y lo que permite reanudar.

**`records.csv`** es para que una persona lo abra en una hoja de cálculo. Solo lleva las **columnas estables del contrato**; `camposExtra` queda fuera a propósito, porque su forma depende de las cabeceras que publique el portal ese día y una cabecera variable rompe cualquier consumidor del CSV. Los documentos van como recuento, no volcados: sus títulos son largos y convertirían la celda en un párrafo ilegible.

Tres detalles del CSV que no son adorno: se entrecomilla **siempre**, no solo cuando hace falta, para que una coma o un salto de línea dentro del nombre de una parte no pueda partir la fila; las comillas internas se duplican, que es el escape de RFC 4180 y el único que entiende Excel; y el fichero lleva BOM UTF-8 y saltos CRLF, porque sin ellos Excel en Windows abre el fichero en la ANSI local y destroza los acentos del portugués (Órgão, Réu).

Las colecciones se comprueban con `Array.isArray` en vez de con `?? []`: el registro puede venir de un `records.json` escrito por otra versión o editado a mano, y un `.join` sobre algo que no es un array abortaría la exportación entera justo después de una extracción de horas.

---

## 9. Fallar ruidosamente

Dos módulos prefieren detenerse a producir datos sospechosos, y conviene entender por qué es la elección correcta aquí.

**`parser.ts` indexa por cabecera, no por posición.** El día que el portal inserte una columna, un mapeo posicional sigue «funcionando» y produce registros con la clase judicial en el campo del órgano. El mapeo por cabecera falla de forma visible o se adapta solo. El modo posicional existe únicamente como red de seguridad, y viene con una aserción ancla: cada fila debe contener un número con formato CNJ.

Cuando hay una tabla que estructuralmente es la de resultados (los marcadores de `rich:dataTable`) pero ninguna de sus filas contiene un número CNJ, se lanza `EstructuraInesperadaError` con una muestra de la primera fila, en lugar de devolver filas a medias. La ausencia de tabla, en cambio, **no** es un error: es una página sin resultados y devuelve `[]`. La distinción importa, porque confundir «no hay datos» con «no sé leer los datos» es exactamente el fallo que produce un `records.json` vacío que parece correcto.

Esto es especialmente relevante dado el estado de la verificación: `docs/protocol.md` deja la forma de la fila marcada como PENDIENTE, porque el servidor del TRF5 falló antes de devolver una lista con resultados en las capturas de reconocimiento. El parser está construido sobre marcadores estructurales que RichFaces 3.3 genera siempre y sobre sinónimos tolerantes de cabecera, y manda a `camposExtra` todo lo que no reconoce. Si la suposición resulta incorrecta, la ejecución se detiene con un mensaje accionable; no produce datos silenciosamente equivocados.

**`http/client.ts` traduce los `200` disfrazados antes de que nadie los parsee.** La página del WAF y la de `errorUnexpected` llegan con código `200` y `Content-Type: text/html`. Detectarlas en el cliente —inspeccionando los primeros 4 KB decodificados— significa que ninguna capa superior tiene que preguntarse si lo que recibió es de verdad lo que pidió.

---

## 10. Lo que esta arquitectura no resuelve

- **El CAPTCHA.** Es un punto de intervención humana por diseño, una vez por fase. `ResolutorCaptcha` es una interfaz con tres implementaciones (terminal, fichero, valor fijo para pruebas) precisamente para que el punto de intervención esté aislado y sea sustituible, pero ninguna de las tres lo resuelve automáticamente, y no es un hueco pendiente de rellenar: automatizarlo sería evadir una detección de bots del titular del sitio.
- **La estabilidad del portal.** El scraper espera, sondea y reintenta, pero no puede hacer que el pool de conexiones del TRF5 deje de agotarse.
- **El paralelismo.** No hay concurrencia en ninguna capa, y es intencionado: contra un servidor frágil detrás de un WAF anti-bot, la alternativa realista a ir despacio no es ir rápido, es que el WAF bloquee la IP.
