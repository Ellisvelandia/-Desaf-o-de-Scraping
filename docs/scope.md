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
