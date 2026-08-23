# Nota de protocolo — PJe TRF5 Consulta Pública

Capturado: 2026-08-23 (curl desde IP real + Chrome sin VPN con hook XHR)
Tecnología: JBoss Seam 2 + JSF 1.2 + RichFaces 3.3 (A4J). Servidor `node09`.
Charset: `ISO-8859-1` (HTML) / `windows-1252` declarado por el navegador.

## Dos variantes de la Consulta Pública

El PJe **no publica una sola** Consulta Pública. Conviven dos plantillas que no
comparten ni el id del formulario, ni el botón de búsqueda, ni la política de
CAPTCHA, ni la forma de la tabla de resultados. Enviar el POST de una a la otra
devuelve la página de inicio sin error visible, y el fallo aparece mucho después
al no haber tabla. Por eso `src/variante.ts` la detecta antes de rellenar nada.

| | **Antigua — «seam»** | **Moderna — «fPP»** |
|---|---|---|
| Ejemplo | `https://pje.trf5.jus.br/pjeconsulta/` (**el objetivo del desafío**) | resto de instancias: TRF5 *treinamento*, TRF1, TRF6 |
| Id del formulario | `consultaPublicaForm` | `fPP` |
| Botón de búsqueda | `consultaPublicaForm:pesq` | `fPP:searchProcessos` |
| CAPTCHA | Imagen de Seam en `/seam/resource/captcha`, **validada en servidor**. Campo `…:verifyCaptcha` | Solo el `<script>` de reCAPTCHA (TRF5) o hCaptcha (TRF1); **ningún widget en el DOM**. `executarReCaptcha()` se compila a `if (false) { … }`. El POST devuelve la tabla **sin enviar token** |
| Tabla de resultados | `rich:dataTable` genérico; **forma exacta desconocida** | `<table id="fPP:processosTable">`, `tbody` `…:tb`, filas `tr.rich-table-row`. **3 columnas**: `""` \| `Processo` \| `Última movimentação` |
| Celda «Processo» | desconocida | **compuesta**: clase judicial suelta + `<a><b>SIGLA NNNNNNN-NN.AAAA.N.NN.NNNN - Assunto</b></a>` + `Polo ativo X Polo passivo` |
| Total de resultados | desconocido | `<span class="text-muted">N resultados encontrados</span>` en el `<tfoot>` |
| Apertura de la ficha | desconocida (se supone postback A4J) | **GET simple, sin CAPTCHA**: `openPopUp('…','/<ctx>/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=<hash>')` |
| Estado | ❌ **NO VERIFICADA** | ✅ **VERIFICADA contra HTML real** |

**Qué significa cada estado, sin adornos:**

- **Moderna — VERIFICADA.** Tres capturas reales, versionadas en
  `src/__tests__/fixtures/`: `pje-nuevo-resultados.html` (TRF5, contexto
  `/pjeconsulta`), `pje-nuevo-resultados-trf1.html` (TRF1, contexto
  `/consultapublica`) y `pje-nuevo-ficha.html` (ficha completa). El POST de
  búsqueda devolvió la tabla renderizada **sin token de CAPTCHA** (los filtros se
  ignoran, pero las filas llegan) y la ficha se abrió con un GET sin CAPTCHA.
  `src/__tests__/moderno.test.ts` corre contra esos ficheros, sin red.
- **Antigua — NO VERIFICADA.** De esta plantilla solo hay
  `fixtures/portal-inicio.html`: el formulario de entrada. **Su tabla de
  resultados sigue sin capturarse porque el CAPTCHA de imagen la bloquea**, y con
  ella siguen sin verificar la paginación, la apertura de la ficha y la descarga
  en esa variante. Lo que hay implementado para ella es hipótesis razonada sobre
  los marcadores que RichFaces 3.3 genera siempre, y falla ruidosamente
  (`EstructuraInesperadaError`) si lo que llega no se parece.

**Trampa que atraviesa todo el código:** los sufijos `j_idNNN` que genera JSF
**cambian entre instancias para la MISMA vista** (celda de resultados: `j_id257`
en TRF5, `j_id259` en TRF1, `j_id237` en TRF6), y el `rowKey` del id de celda no
es secuencial (`…:processosTable:583:…`). Nada se localiza aquí por id completo:
se busca por **sufijo** (`[id$=":processosTable"]`, `[id$=":searchProcessos"]`) y
el prefijo se deriva del elemento encontrado. Lo único literal es `fPP`, que lo
escribe la plantilla del PJe y no el contador de JSF.

## Sesión
- Se establece con: `GET /pjeconsulta/ConsultaPublica/listView.seam`
- Se transporta en: cookie `JSESSIONID` (path `/pjeconsulta`, Secure). El servidor
  también la incrusta en cada `action` como `;jsessionid=…` (URL rewriting).
- Cookies del WAF F5: `trf501f89bc9`, `trf5017e6648`, `trf59e68d240027` y
  `trf535f41150029` (`Max-Age=30`). Se regeneran en cada respuesta. El portal
  responde `200` aunque no se reenvíen; se reenvían igualmente.
- Expira: por inactividad (no medido). Atada a IP: no confirmado. Desde una IP
  de salida de VPN comercial el WAF devuelve bloqueo total; desde la IP
  doméstica real de la máquina de pruebas el portal responde con normalidad.
  (Las direcciones concretas no se anotan aquí: son datos de la persona que
  ejecuta el scraper, no del protocolo del portal.)
- Renovación: reabrir desde cero (GET de la página) y resolver CAPTCHA de nuevo.

## Token de estado
- Nombre: `javax.faces.ViewState`
- Origen: input oculto en la página completa; tras cada POST A4J llega en
  `<span id="ajax-view-state"><input name="javax.faces.ViewState" value="…"/></span>`
- Formato: clave corta de estado en servidor (`j_id1` en la carga inicial,
  `j_id2` tras el primer POST). Cambia con cada respuesta.
- Seam `cid`: no aparece en la carga inicial. Aparece en `errorUnexpected.seam?cid=N`.
  Pendiente confirmar si la respuesta de búsqueda lo introduce.

## Llamada 1 — abrir
```
GET /pjeconsulta/ConsultaPublica/listView.seam
Accept: text/html,…   User-Agent: Chrome/149 (Windows)
→ 200, ~101 KB, ISO-8859-1
```
Devuelve: `JSESSIONID`, `ViewState=j_id1`, el formulario `consultaPublicaForm`
con todos sus campos, y la URL de la imagen CAPTCHA:
`/pjeconsulta/seam/resource/captcha;jsessionid=<JSESSIONID>?f=<epoch-ms>`.

## Llamada 2 — CAPTCHA (imagen)
```
GET /pjeconsulta/seam/resource/captcha;jsessionid=<JSESSIONID>?f=<epoch-ms>
→ image/*  (misma sesión; cada GET genera un desafío nuevo ligado a la sesión)
```
Un humano lee la imagen y teclea el texto. **No se automatiza.**

## Llamada 3 — búsqueda (POST A4J, capturado desde el navegador)
```
POST /pjeconsulta/ConsultaPublica/listView.seam
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
(el navegador no envía Faces-Request ni X-Requested-With: A4J 3.3 usa AJAXREQUEST en el cuerpo)
```
Cuerpo (todos los campos, en este orden):
```
AJAXREQUEST=_viewRoot
consultaPublicaForm:Processo:jurisdicaoSecaoDecoration:jurisdicaoSecao=org.jboss.seam.ui.NoSelectionConverter.noSelectionValue
consultaPublicaForm:Processo:ProcessoDecoration:Processo=_______-__.____._.__.____
consultaPublicaForm:Processo:j_id119:numeroProcessoPesqsuisaOriginario=
consultaPublicaForm:nomeParte:nomeParteDecoration:nomeParte=
consultaPublicaForm:nomeParteAdvogado:nomeParteAdvogadoDecoration:nomeParteAdvogadoDecoration:nomeParteAdvogado=
consultaPublicaForm:classeJudicial:idDecorateclasseJudicial:classeJudicial=
consultaPublicaForm:classeJudicial:idDecorateclasseJudicial:j_id207_selection=
consultaPublicaForm:numeroCPFCNPJ:numeroCPFCNPJRadioCPFCNPJ:numeroCPFCNPJCNPJ=
consultaPublicaForm:numeroOABParte:numeroOABParteDecoration:numeroOABParteEstadoCombo=org.jboss.seam.ui.NoSelectionConverter.noSelectionValue
consultaPublicaForm:numeroOABParte:numeroOABParteDecoration:numeroOABParte=
consultaPublicaForm:numeroOABParte:numeroOABParteDecoration:j_id258=
consultaPublicaForm:captcha:j_id268:verifyCaptcha=<TEXTO TECLEADO>
consultaPublicaForm=consultaPublicaForm
autoScroll=
javax.faces.ViewState=j_id1
consultaPublicaForm:pesq=consultaPublicaForm:pesq
AJAX:EVENTS_COUNT=1
```
Regla general: reenviar **todos** los `input`/`select` del formulario tal como
están en la última respuesta, sobrescribir solo los criterios y el CAPTCHA, y
añadir los cuatro marcadores de A4J (`AJAXREQUEST`, `<form>=<form>`,
`<botón>=<botón>`, `AJAX:EVENTS_COUNT`).

Respuesta: `200`, ~42 KB, XML A4J:
```xml
<?xml version="1.0"?>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><title></title>
<script id="org.ajax4jsf.queue_script">…</script>…</head>
<body> …elementos actualizados…
  <meta name="Ajax-Update-Ids" content="id1,id2,…"/>
  <span id="ajax-view-state"><input type="hidden" name="javax.faces.ViewState" value="j_id2"/></span>
</body></html>
```
Los fragmentos a reemplazar en el DOM son los elementos cuyos `id` lista
`Ajax-Update-Ids`. El `ViewState` nuevo está en `#ajax-view-state`.

Observado: con todos los criterios vacíos y un CAPTCHA, la respuesta re-renderizó
el formulario, vació el CAPTCHA y no mostró filas ni mensaje. Pendiente
establecer si fue CAPTCHA incorrecto o búsqueda vacía no permitida. Se resuelve
en la primera ejecución del scraper guardando la respuesta completa.

## Llamada 4 — página siguiente
NO VERIFICADA contra una lista real (el servidor falló antes de devolver una).
Hipótesis por RichFaces 3.3, y es lo que el scraper implementa: POST A4J con
`AJAXREQUEST=_viewRoot`, el formulario completo y el parámetro del
`rich:datascroller` (`<scrollerId>=<n>`) más `ajaxSingle`.

Está codificada —`src/paginacion.ts`— porque el scraper no la fija a mano: lee
del `onclick` del propio scroller el id del formulario, el nombre del parámetro
de página y los parámetros acompañantes. Si la hipótesis es incorrecta, lo que
falla es la lectura de un `onclick` que no existe (`detectarPaginacion` devuelve
`undefined` y el recorrido se para), no un valor inventado que el portal acepte
a medias.

## Llamada 5 — ficha del proceso
**Variante moderna: VERIFICADA.** La fila publica la ficha como una URL, no como
un postback:

```
openPopUp('Consulta pública',
          '/<ctx>/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=<hash>')
→ GET con las cookies de la sesión, 200 text/html, ~92 KB. Sin CAPTCHA.
```

El parámetro `ca` es lo que autoriza la apertura (una URL sin él devuelve error
del portal) y es distinto por proceso; su longitud cambia entre instancias (32
hex en el TRF5, 48 en el TRF1), así que se copia tal cual y no se valida por
longitud. Consecuencia de diseño: en esta variante **la Fase 2 no necesita la
lista**, y por tanto no necesita rehacer la búsqueda ni resolver un CAPTCHA.

**Variante antigua: NO VERIFICADA.** El control que abre la ficha vive en la fila
de resultados, que es justo lo que no se ha capturado. `src/parser.ts` lo lee de
la fila con un criterio estrecho (el control rotulado con el número del proceso, o
el único de la fila) y omite el dato cuando hay ambigüedad; la Fase 2 registra
entonces un fallo de fase `ficha`. Ver `docs/arquitectura.md`, apartado 6 bis.

## Llamada 6 — artefacto (PDF)
NO VERIFICADA. El aviso de la página («para a visualização do processo é
obrigatório a demonstração…») sugiere un segundo CAPTCHA al abrir el proceso.
`src/descarga.ts` soporta las dos formas que publica el contrato
(`DescargaDirecta` por GET y `DescargaPostback` por POST A4J) y valida lo
recibido —content-type, tamaño y bytes mágicos— antes de dar por buena una
descarga.

## Forma de la fila
Depende de la variante (ver «Dos variantes de la Consulta Pública»):

- **Moderna — VERIFICADA.** Tres columnas, con la celda del medio compuesta.
  `src/parserModerno.ts` la descompone usando el enlace como eje: lo que va
  delante es la clase judicial, el `<b>` del enlace trae sigla + número CNJ +
  asunto, y lo que va detrás son los dos polos separados por `" X "`. Pie de
  tabla: `<span class="text-muted">N resultados encontrados</span>`.
- **Antigua — NO VERIFICADA.** Sigue siendo la pieza que bloquea confirmar las
  llamadas 4, 5 y 6 *en esa variante*. `src/parser.ts` está escrito sobre los
  marcadores estructurales que RichFaces 3.3 genera siempre y falla ruidosamente
  (`EstructuraInesperadaError`) si la tabla que encuentra no se parece a la que
  sabe leer.

Dato medido sobre el fixture del TRF1 y que conviene no confundir con un fallo:
de sus **30 filas solo 22 publican número CNJ**. En las otras 8 el `<b>` dice
solo «PJEC - Assunto» y la columna de movimentación llega vacía: son procesos en
*segredo de justiça*. Esas filas **NO se descartan** —hacerlo tiraba el 27 % de
la página—: se emiten con `enSigilo: true`, sin `numeroProcesso` (el número es un
dato del tribunal y no se sustituye por nada) y con una `claveUnica` derivada del
`ca=` de su ficha, con el prefijo `sigilo:`. De ellas se extrae además todo lo que
el portal sí publica: clase judicial, sigla, asunto y las dos partes. Solo se
descarta —y con `log.warn`— la fila que no tiene ni número ni enlace, porque
entonces no hay ninguna clave con la que indexarla. En el fixture del TRF5 las 30
filas traen número y salen 30 procesos, ninguno en sigilo.

## Señales de fallo
| Señal | Significado real | Reacción |
|---|---|---|
| `200` + `Requisição - Rejeitada` (22 KB, F5) | WAF bloqueó la IP de origen | Parar. No reintentar. Cambiar de red (apagar VPN). |
| `302`/`200` → `errorUnexpected.seam?cid=N` con `IJ000655` | Pool de conexiones del servidor agotado (30 s de timeout) | Servidor saturado: espera larga (60–120 s), reintento acotado, sesión nueva |
| `HTTP 000` / `ECONNRESET` | El F5 cortó una conexión demasiado rápida | Un reintento rápido, luego más pausa |
| `429` | Límite de tasa (anunciado por el enunciado para PDFs) | Backoff exponencial con jitter, `Retry-After` si viene, tope de intentos, registrar en `failed.json` |
| A4J sin `Ajax-Update-Ids` o con `ViewExpiredException` | Sesión/estado caducado | Reabrir sesión, nuevo CAPTCHA, reanudar |
| Respuesta A4J sin filas y CAPTCHA vaciado | CAPTCHA incorrecto o criterio inválido | Pedir CAPTCHA de nuevo (máx. 3) |
| `403` / `404` | No autorizado / no existe | Nunca reintentar |

## Volumen
- Total de registros: desconocido hasta ver la primera lista.
- Registros por página: desconocido (RichFaces suele usar 10–20).
- Latencia observada: 1.8–2.1 s por GET con el servidor sano; hasta 31 s saturado.
- Estimación: pendiente de total y tamaño de página.

## Decisiones de diseño derivadas
- El CAPTCHA se resuelve por un humano una vez por sesión. El scraper guarda la
  imagen en `output/captcha.png` y la pide por terminal.
- La VPN no forma parte de la solución; debe estar apagada.
- Decodificar con `iconv-lite` desde `ISO-8859-1`; nunca asumir UTF-8.
- Estado de vista en servidor: reenviar siempre el último `ViewState`.

---

## Descarga de documentos — VERIFICADA en vivo (2026-08-23)

Comprobado contra una instancia del PJe con la plantilla moderna, descargando un
PDF real. La secuencia completa **no requiere CAPTCHA en ningún punto**:

```
1. GET  /<ctx>/ConsultaPublica/DetalheProcessoConsultaPublica/listView.seam?ca=<hash32>
        → 200, text/html, ~95 KB. Establece la sesión y devuelve la ficha.
          El hash `ca` sale del onclick de la fila en la lista de resultados.

2. GET  /<ctx>/Processo/reportReciboPDF.seam?idBin=<n>&idProcessoDoc=<n>&idProcessoTrf=<n>
        Cookies de la sesión anterior + Referer apuntando a la ficha.
        → 200, application/pdf, 18.238 B, bytes mágicos %PDF-1
```

Sin las cookies de la ficha ambas rutas devuelven `302`. La sesión es
imprescindible; el CAPTCHA no.

Los tres identificadores (`idBin`, `idProcessoDoc`, `idProcessoTrf`) se leen del
`onclick` de la fila de la tabla `…:processoDocumentoGridTab` de la ficha:

```
openPopUp('<n>popUpComprovante',
          '/<ctx>/Processo/reportReciboPDF.seam?idBin=7397&idProcessoDoc=7497&idProcessoTrf=11')
```

Existe además un visor HTML del documento,
`documentoSemLoginHTML.seam?ca=<hash96>&idProcessoDoc=`, que devuelve `200` con
`text/html`. En la prueba redirigió a la lista en vez de servir el documento, así
que **el camino fiable para obtener el binario es `reportReciboPDF.seam`**.

Esa prioridad está codificada en `src/ficha.ts` (`esUrlBinaria` antes que
`esUrlVisor`) y fijada por prueba. Importa porque en la rejilla de documentos
**el enlace del comprobante publica las dos cosas a la vez**: la URL del PDF en
un `openPopUp` y, pegado detrás, un `A4J.AJAX.Submit` que solo notifica al
servidor. Quedarse con el postback deja la descarga sin su única fuente
comprobada, y quedarse con el visor la deja con un `text/html` que
`ServicioDescarga` rechaza por firma.

Limitación conocida que de aquí se deriva: los documentos cuyo único enlace es el
visor `documentoSemLoginHTML.seam` se emiten con su título, su fecha y su
`idProcessoDoc` —son información legítima del expediente—, pero su descarga
fallará con `DescargaInvalidaError` («los bytes iniciales no son los de un PDF»)
mientras no se verifique una ruta binaria para ellos. Se prefiere ese fallo
explícito y anotado en `failed.json` a guardar en disco una página HTML con
extensión `.pdf`.

Hay también un `reportPDF.seam?idProcessoTrf=<n>` (botón «Imprimir» de la ficha)
que parece servir el expediente completo. Vive fuera de las tablas de la ficha,
así que `parsearFicha` no lo recoge, y no se ha probado: queda anotado como pista,
no como camino soportado.

Consecuencia de diseño: la Fase 2 abre la ficha por GET (que además renueva la
sesión) y de ahí saca los enlaces de descarga. No depende del documento vigente
de la lista, que era el punto frágil del diseño anterior.
