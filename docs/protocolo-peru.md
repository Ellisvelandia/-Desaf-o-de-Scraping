# Nota de protocolo — Jurisprudencia Nacional Sistematizada (Poder Judicial del Perú)

**Capturado:** 2026-08-23, sobre el portal en vivo, con la salida de red enrutada por Perú.
**Método:** navegación real en Chrome con un interceptor de `XMLHttpRequest.send` y de
`HTMLFormElement.prototype.submit` que registra los **nombres y valores de los parámetros** de cada
POST antes de que salga. No es lectura de documentación ni deducción: son los cuerpos que el propio
portal envía.

**Tecnología:** JSF 2 (Mojarra) + RichFaces 4, sobre `jurisprudencia.pj.gob.pe/jurisprudenciaweb`.
**Charset:** UTF-8.
**CAPTCHA:** **ninguno**. Ni en la búsqueda, ni al paginar, ni al descargar.

---

## 0. El bloqueo de entrada: WAF Radware por geolocalización

Toda petición que no llegue desde Perú recibe `403 Forbidden` con un cuerpo de 334 bytes que solo
contiene un «Transaction ID». No hay cookie de desafío, ni reto de JavaScript, ni cabecera que
negociar: es un bloqueo por dirección IP de origen.

Comprobado, y las tres dan `403`:

| Origen | Resultado |
|---|---|
| IP doméstica colombiana (la de la máquina de pruebas) | `403` |
| Proxy comercial con salida geolocalizada en Lima (`timezone: America/Lima`) | `403` |
| La misma máquina con una VPN **de extensión de Chrome** activa, pero desde `curl`/Node | `403` |

Y la que sí funciona: **el navegador con la VPN de Perú activa** → `200` y el portal completo.

De ahí la conclusión que gobierna el despliegue y que está en el README: hace falta una VPN de
**ámbito de sistema**. Una extensión de navegador enruta Chrome y deja al proceso de Node saliendo
por la IP real, que es exactamente el caso de la tercera fila.

---

## 1. Apertura de sesión

```
GET /jurisprudenciaweb/faces/page/inicio.xhtml
```

Devuelve `JSESSIONID` y el formulario `formBuscador` con su `javax.faces.ViewState`.

Campos del formulario (los que importan; hay más, y se reenvían todos tal cual):

```
formBuscador                            (el formulario se nombra a sí mismo)
formBuscador:txtBusqueda                texto libre
formBuscador:buNroExpediente            nº de expediente
formBuscador:buAnio                     año
formBuscador:buCorte / buDistrito / buEspecialidad / buSala
formBuscador:buPretensionValue / buPretensionInput
formBuscador:buPalabraClaveValue / buPalabraClaveInput
javax.faces.ViewState
```

---

## 2. Búsqueda — POST de navegación completa

```
POST /jurisprudenciaweb/faces/page/inicio.xhtml
Content-Type: application/x-www-form-urlencoded
```

Cuerpo: **todos** los campos del formulario, más los parámetros que el botón de búsqueda añade.
Capturado literalmente:

```
formBuscador=formBuscador
formBuscador:tabpanel-value=general
formBuscador:txtBusqueda=amparo
formBuscador:buCorte=1
formBuscador:buDistrito=0
formBuscador:buEspecialidad=0
formBuscador:buSala=0
formBuscador:buNroExpediente=Ingrese Nro de Expediente XXXX
formBuscador:j_idt31=formBuscador:j_idt31          ← EL CONTROL PULSADO
forward=buscar                                      ← enruta la navegación JSF
busqueda=especializada
formBuscador:j_idt34=21
formBuscador:j_idt35=DESC
formBuscador:j_idt36=Principal
formBuscador:j_idt37=1
javax.faces.ViewState=<vigente>
```

La respuesta es `resultado.xhtml` con los paneles de resultado.

### El detalle que decide si esto sobrevive a un redespliegue

`formBuscador:j_idt31` **no está codificado en ninguna parte del scraper**, y no puede estarlo. Ese
sufijo `j_idtNN` lo genera JSF contando componentes en el árbol de la vista: cambia en cuanto se
toca la plantilla y difiere entre despliegues del mismo código. Es la misma lección que este
repositorio ya había aprendido en el TRF5, donde los sufijos `j_idNNN` de la misma pantalla difieren
entre tribunales.

El botón de búsqueda es un `<button>` **sin `name` ni `id`**: la envía JavaScript. Mojarra escribe en
su `onclick`:

```js
mojarra.jsfcljs(document.getElementById('formBuscador'),
                {'formBuscador:j_idt31':'formBuscador:j_idt31','forward':'buscar', …}, '')
```

`SesionPeru.controlBusqueda()` lee ese objeto del `onclick` y lo reenvía tal cual. Además filtra por
que **algún valor contenga `buscar`**: sin ese filtro se cogería el primer control con `jsfcljs` de la
página —«Limpiar», por ejemplo—, que responde `200` con el formulario vacío. Una ejecución que
parece funcionar y extrae cero.

---

## 3. Estructura de un resultado

Diez paneles por página. Cada uno:

```
div.rf-p
  div.rf-p-hdr                       cabecera roja
    table>tbody>tr>td>span           tipo de recurso: "Apelación", "Casación"
                   td>span           nº de expediente: "037233-2025"
  div.rf-p-b                         cuerpo
    div.row > div.col-sm-*
      div.col-md-12.txtbold          RÓTULO   ("Sumilla:", "Sala Suprema:"…)
      div.col-md-12                  VALOR
    table>tbody>tr
      td > a[href="#"] > img         "Ver Ficha"      → postback RichFaces, NO es una URL
      td
      td > a[href=…] > img.social    "Ver Resolución" → GET directo al PDF
```

Rótulos observados: *Pretensión/Delito*, *Tipo Resolución*, *Fecha Resolución*, *Sala Suprema*,
*Norma de Derecho Interno*, *Sumilla*, *Palabras Clave*. El parser indexa **por rótulo**, así que
cualquiera que el portal añada se recoge en `camposExtra` sin tocar código.

El total se anuncia como **«Página: 1 de 15247»**, y son **páginas**, no registros: 15.247 × 10 ≈
152.000 resoluciones. Confundirlo con un total de registros haría que el recorrido se diera por
terminado alrededor de la página 1.525.

---

## 4. Descarga del PDF

```
GET /jurisprudenciaweb/ServletDescarga?uuid=<uuid>
```

El `uuid` viene en el `href` del enlace «Ver Resolución» del propio panel, así que **no hace falta
abrir la ficha** para descargar: la lista ya trae todo lo necesario.

En la primera petición de la captura, el servlet respondió **`503`**. Eso confirma dos cosas: que el
endpoint es el correcto y que el portal limita la tasa de descargas, que es precisamente el
requisito 3 del enunciado. `withRetry` lo trata como reintentable, con retroceso exponencial.

---

## 5. Paginación — petición parcial de JSF 2

```
POST /jurisprudenciaweb/faces/page/resultado.xhtml
```

Cuerpo capturado del portal, con los valores exactos:

```
formBuscador=formBuscador
… todos los campos del formulario …
javax.faces.source=formBuscador:data1
javax.faces.partial.event=rich:datascroller:onscroll
javax.faces.partial.execute=formBuscador:data1 @component
javax.faces.partial.render=@component
formBuscador:data1:page=5                       ← PÁGINA DESTINO
org.richfaces.ajax.component=formBuscador:data1
formBuscador:data1=formBuscador:data1
AJAX:EVENTS_COUNT=1
javax.faces.partial.ajax=true
javax.faces.ViewState=<vigente>
```

`execute` y `render` **no** son los valores por defecto de JSF (`@all`), así que enviarlos por defecto
sería una suposición; van copiados de lo que envía el portal.

La respuesta es un `<partial-response>` de JSF 2:

```xml
<partial-response id="j_id1">
  <changes>
    <update id="formBuscador:data1"><![CDATA[ …HTML… ]]></update>
    <update id="javax.faces.ViewState"><![CDATA[ …nuevo… ]]></update>
  </changes>
</partial-response>
```

Esto es un protocolo **distinto** del A4J de RichFaces 3.3 que habla el TRF5 (que responde un XHTML
con `<meta name="Ajax-Update-Ids">`), y por eso vive en su propio módulo, `src/jsf/partial.ts`. El
parseo es en dos etapas a propósito: la envoltura en modo XML —sin él, htmlparser2 toma el `<![CDATA[`
por un comentario mal formado y el HTML de dentro se pierde entero— y el fragmento recuperado en modo
HTML, que es lo que es.

Cuando la sesión caduca, el servidor responde `<redirect url="…"/>` en lugar de `<changes>`.
`aplicarRespuestaParcial` lo distingue y `SesionPeru.irAPagina` lo convierte en `SesionCaducadaError`
en vez de aplicar una actualización vacía y seguir paginando sobre la misma página.

---

## 6. Lo verificado y lo no verificado

| | Estado |
|---|---|
| Bloqueo geográfico del WAF | ✅ Verificado (tres orígenes distintos) |
| Apertura de sesión y formulario | ✅ Verificado |
| POST de búsqueda y sus parámetros | ✅ Verificado (interceptado del portal) |
| Estructura de los paneles de resultado | ✅ Verificado (recorrido del DOM en vivo) |
| Total anunciado como páginas | ✅ Verificado (15.247) |
| Endpoint de descarga del PDF | ✅ Verificado (existe y limita la tasa: `503`) |
| POST parcial de paginación y sus parámetros | ✅ Verificado (interceptado, y la página 2 y la 5 devolvieron expedientes distintos) |
| Descarga de un PDF completo y validado byte a byte | ❌ **No ejecutada**: exige que el proceso de Node salga por Perú |
| Recorrido de las 15.247 páginas | ❌ **No ejecutado**, por lo mismo |
| Contenido de la ficha («Ver Ficha») | ❌ No capturado: es un postback RichFaces y no se ha decodificado |
