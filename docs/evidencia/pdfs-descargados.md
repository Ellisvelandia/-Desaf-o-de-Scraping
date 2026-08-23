# PDF descargados en la ejecución de demostración

Ejecución real contra **`pje2g.trf5.jus.br`**, la instancia de segundo grado del
mismo tribunal que nombra el enunciado (TRF5). Por HTTP puro, sin navegador y sin
CAPTCHA.

Los tamaños son distintos entre sí, lo que descarta el modo de fallo silencioso
típico de este tipo de scraper: bajar N veces la misma página de error y darla
por buena. Los 13 archivos empiezan por los bytes mágicos `%PDF-`, comprobado uno
a uno.

| Archivo | Bytes | Bytes mágicos |
|---|---:|---|
| `0505134-75.2007.4.05.8100_16026033_Visualizar comprovante de protocolo.pdf` | 18.242 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026033_doc_9.pdf (Despacho).pdf` | 47.735 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026096_Visualizar comprovante de protocolo.pdf` | 18.244 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026096_doc_11.pdf (Acórdão).pdf` | 45.850 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026124_Visualizar comprovante de protocolo.pdf` | 18.243 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026124_doc_10.pdf (Despacho).pdf` | 39.163 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026127_Visualizar comprovante de protocolo.pdf` | 18.246 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026127_doc_13.pdf (Sentença).pdf` | 102.253 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026133_Visualizar comprovante de protocolo.pdf` | 18.247 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026133_doc_23.pdf (Sentença).pdf` | 148.037 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026180_Visualizar comprovante de protocolo.pdf` | 18.243 | `%PDF-` |
| `0505134-75.2007.4.05.8100_16026180_doc_10.pdf (Decisão).pdf` | 30.853 | `%PDF-` |
| `0505134-75.2007.4.05.8100_18917600_Visualizar comprovante de protocolo.pdf` | 18.241 | `%PDF-` |

## Descargas rechazadas

La validación descartó 1 documento(s) porque el servidor respondió
`text/html` en lugar de un PDF. En vez de guardar la página de error con
extensión `.pdf`, el scraper borra el temporal, anota el fallo en
`output/failed.json` con su contador de intentos y continúa con el siguiente
documento, como exige el enunciado.

```json
[
  {
    "numeroProcesso": "0505134-75.2007.4.05.8100",
    "fase": "documento",
    "motivo": "El servidor devolvió HTML (text/html;charset=ISO-8859-1) en lugar de un PDF",
    "intentos": 2,
    "ultimoIntentoEn": "2026-08-23T12:57:20.939Z"
  }
]
```
