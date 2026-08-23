# Muestra de PDF descargados

PDF **reales**, descargados de cada portal por el mecanismo que implementa el
scraper (`GET` con las cookies de la sesión), como evidencia de que la Fase 2
funciona de punta a punta. Es una muestra, no el corpus completo: el enunciado
pide demostrar que el scraper *puede* descargarlos, no entregarlos todos.

Todos empiezan por los bytes mágicos `%PDF-` y cierran con `%%EOF`, y sus
tamaños y huellas son distintos entre sí, lo que descarta el modo de fallo
silencioso de «bajar N veces la misma página de error y darla por buena».

## `peru/` — Jurisprudencia Nacional Sistematizada (Poder Judicial del Perú)

Servidos por `GET /jurisprudenciaweb/ServletDescarga?uuid=<uuid>`, con
`Content-Type: application/octet-stream`. Verificación en `docs/protocolo-peru.md`, §4.

| Fichero | Bytes | Páginas | SHA-256 (16) |
|---|---:|---:|---|
| `037233-2025_Apelacion.pdf` | 291.432 | 16 | `bbb0c60f8e72a20f` |
| `029269-2025_Casacion.pdf` | 572.048 | 66 | `cffcb9f77d922d81` |
| `031275-2025_Casacion.pdf` | 468.180 | 36 | `ff708ba0415142db` |

## `trf5/` — Consulta Pública del PJe (TRF 5ª Região, Brasil)

Tres de los 13 descargados en la ejecución de demostración (`docs/evidencia/pdfs-descargados.md`),
servidos por `reportReciboPDF.seam`. El expediente `0505134-75.2007.4.05.8100`,
con dos documentos judiciales (acórdão y sentença) y un comprobante de protocolo.

| Fichero | Bytes |
|---|---:|
| `…_16026096_Acordao.pdf` | 45.850 |
| `…_16026133_Sentenca.pdf` | 148.037 |
| `…_16026033_Comprovante.pdf` | 18.242 |

## Nota sobre los nombres

Aquí los nombres van simplificados para que se lean de un vistazo. El scraper los
compone como `<expediente>_<idDocumento>_<titulo>.pdf` (ver `src/descarga.ts`);
la versión sin simplificar de los del TRF5 está en `output/pdfs/`, fuera del
control de versiones.
