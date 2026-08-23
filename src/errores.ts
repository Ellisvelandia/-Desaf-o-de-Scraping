/**
 * Errores compartidos por los parsers.
 *
 * Vive en su propio módulo por una razón concreta y no por gusto de organizar:
 * `parser.ts` delega en `parserModerno.ts` cuando el documento trae la tabla de
 * la plantilla moderna, y `parserModerno.ts` necesita lanzar el MISMO error que
 * `parser.ts` para que `Scraper.fase1` lo reconozca con un solo `instanceof`.
 * Si cada uno lo importara del otro habría un ciclo de módulos: en CommonJS
 * funcionaría por accidente (las referencias se resuelven al llamar, no al
 * cargar), pero basta con que alguien mueva el uso a la inicialización del
 * módulo para que uno de los dos vea `undefined` y el fallo aparezca como un
 * `TypeError` opaco en producción. Un tercer módulo sin dependencias corta el
 * ciclo de raíz.
 */

/** La página tiene una tabla de resultados, pero ya no se parece a la que se sabe leer. */
export class EstructuraInesperadaError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'EstructuraInesperadaError';
  }
}
