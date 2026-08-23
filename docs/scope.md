# Alcance y autorización

**Objetivo.** Consulta Pública del PJe (Processo Judicial Eletrônico) del Tribunal
Regional Federal da 5ª Região, Brasil:
`https://pje.trf5.jus.br/pjeconsulta/ConsultaPublica/listView.seam`.

**Qué se recoge.** Toda la información disponible de cada documento listado y el
PDF asociado a cada uno, según el enunciado del Desafío de Scraping de
magnar-ai. El enunciado exige TypeScript, HTTP puro (axios + cheerio), sin
automatización de navegador, manejo de `429` con retroceso exponencial, registro
de los documentos fallidos y datos en formato estructurado.

**Volumen.** Desconocido hasta el reconocimiento. El enunciado acepta una entrega
que demuestre que el scraper puede llegar al final sin haberlo recorrido entero.

**Fuente masiva.** El PJe no publica una API de consulta pública ni una descarga
masiva de documentos. El CNJ expone DataJud como API de metadatos procesales,
pero no entrega los documentos, que son el objeto del desafío. Se confirma en el
reconocimiento.

**Carácter público.** La consulta pública del PJe es, por diseño, de acceso
libre y sin autenticación (publicidad procesal, art. 93 IX CF/88). No hay
`robots.txt` (404) ni términos que prohíban la ruta. El portal responde `200`
desde la IP doméstica de la máquina de pruebas, sin necesidad de VPN.

**Datos personales.** Los registros judiciales contienen nombres de las partes.
Son datos publicados por el propio tribunal para consulta pública y el
organizador del desafío declara que ya posee la información y que el scraper se
usa únicamente como prueba técnica. Se recoge lo que el portal publica y nada
más; no se redistribuye.

**Señales de protección.** Las cookies `trf5…` con `Max-Age=30` corresponden a
un WAF F5 con defensa anti-bot. Ritmo conservador desde el primer request.

**Nota sobre la VPN.** La VPN usada durante el reconocimiento es una extensión
de Chrome: enruta solo el tráfico del navegador. curl y Node salen por la IP
real de la máquina, y el portal los atiende. La VPN no forma parte de la
solución. Las direcciones IP concretas no se anotan en el repositorio: son
datos de quien ejecuta el scraper, no del portal.

**Bloqueos abiertos.** El reconocimiento confirmó que el formulario de consulta
exige un CAPTCHA de imagen para lanzar una búsqueda. No se automatiza su
resolución: automatizarla sería evadir una detección de bots del titular del
sitio. La decisión tomada, y consultada con el organizador del desafío, es
mantener a una persona en ese punto —una vez por fase— y automatizar todo lo
demás. Ver `README.md`, apartado «El CAPTCHA».

---

# Alcance y autorización — objetivo `peru`

**Objetivo.** Jurisprudencia Nacional Sistematizada del Poder Judicial del Perú:
`https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml`.
Es el sitio que el enunciado nombra en su «Paso 1» y en su «Entregable».

**Qué se recoge.** De cada resolución publicada: tipo de recurso, nº de
expediente, pretensión o delito, tipo y fecha de resolución, sala suprema, norma
de derecho interno, sumilla, palabras clave, y el PDF de la resolución.

**Volumen.** El portal anuncia 15.247 páginas de diez resultados, unas 152.000
resoluciones. El enunciado acepta una entrega que demuestre que el scraper puede
llegar al final sin haberlo recorrido entero.

**Carácter público.** Es un portal de difusión de jurisprudencia, de acceso libre
y sin autenticación: su propósito declarado es «exponer los preceptos jurídicos
vigentes … orientado a litigantes, abogados y ciudadanos». No exige registro ni
acepta términos para consultar.

**Datos personales.** Las resoluciones publicadas en este portal vienen
sistematizadas por materia y sumilla; a diferencia del PJe brasileño, la lista no
publica nombres de las partes. Se recoge lo que el portal publica y nada más; no
se redistribuye.

**Señales de protección.** WAF Radware que responde `403` a las peticiones que no
llegan desde Perú. Es un control de acceso por geolocalización, no un mecanismo
anti-bot con reto: no hay CAPTCHA, ni desafío de JavaScript, ni cookie que
resolver. **No se evade nada**: la única forma soportada de ejecutar este
objetivo es disponer de salida de red legítima desde Perú.

**Ritmo.** Los mismos valores conservadores que en el otro objetivo: 2 s entre
peticiones, 3 s entre descargas. El servlet de descarga ya devolvió un `503` en
la primera petición del reconocimiento, así que el límite de tasa es real y el
retroceso exponencial no es decorativo.

**Bloqueos abiertos.** El botón «Ver Ficha» es un postback de RichFaces y no se
ha decodificado. No se sigue, y el parser no finge un enlace para él.
