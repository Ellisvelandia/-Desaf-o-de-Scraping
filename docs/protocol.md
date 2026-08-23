# Nota de protocolo — PJe TRF5 Consulta Pública

Capturado: 2026-08-23 (curl desde IP real + Chrome sin VPN con hook XHR)
Tecnología: JBoss Seam 2 + JSF 1.2 + RichFaces 3.3 (A4J). Servidor `node09`.
Charset: `ISO-8859-1` (HTML) / `windows-1252` declarado por el navegador.

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
NO VERIFICADA. El control que abre la ficha vive en la fila de resultados, que es
justo lo que no se ha capturado. `src/parser.ts` lo lee de la fila con un
criterio estrecho (el control rotulado con el número del proceso, o el único de
la fila) y omite el dato cuando hay ambigüedad; la Fase 2 registra entonces un
fallo de fase `ficha`. Ver `docs/arquitectura.md`, apartado 6 bis.

## Llamada 6 — artefacto (PDF)
NO VERIFICADA. El aviso de la página («para a visualização do processo é
obrigatório a demonstração…») sugiere un segundo CAPTCHA al abrir el proceso.
`src/descarga.ts` soporta las dos formas que publica el contrato
(`DescargaDirecta` por GET y `DescargaPostback` por POST A4J) y valida lo
recibido —content-type, tamaño y bytes mágicos— antes de dar por buena una
descarga.

## Forma de la fila
NO VERIFICADA. Es la pieza que bloquea confirmar las llamadas 4, 5 y 6. El
parser está escrito sobre los marcadores estructurales que RichFaces 3.3 genera
siempre y falla ruidosamente (`EstructuraInesperadaError`) si la tabla que
encuentra no se parece a la que sabe leer.

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
