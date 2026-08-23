/**
 * Firmas de error que el cliente HTTP traduce en errores tipados.
 *
 * El caso que importa es el 403 de Radware: cuerpo plano sin Content-Type HTML.
 */
import { errorDisfrazadoDelPortal } from '../http/client';
import { BloqueadoPorWafError, ServidorSaturadoError } from '../utils/retry';

/** Cuerpo capturado del WAF Radware del portal peruano (~334 B, sin HTML). */
const CUERPO_RADWARE =
  '403 Forbidden\n\n' +
  'Request forbidden by administrative rules.\n\n' +
  'Transaction ID: 0a1b2c3d-4e5f-6789-abcd-ef0123456789\n';

describe('errorDisfrazadoDelPortal', () => {
  it('reconoce el 403 de Radware aunque el Content-Type no sea text/html', () => {
    // Sin esto, el early-return por HTML convertía el bloqueo geo en un HTTP 403
    // genérico y el CLI nunca imprimía el aviso de VPN de ámbito de sistema.
    const error = errorDisfrazadoDelPortal(403, 'text/plain', CUERPO_RADWARE, 'https://jurisprudencia.pj.gob.pe/');

    expect(error).toBeInstanceOf(BloqueadoPorWafError);
    expect(error?.message).toMatch(/geolocalizaci/i);
  });

  it('también lo reconoce sin Content-Type (cabecera ausente)', () => {
    const error = errorDisfrazadoDelPortal(403, '', CUERPO_RADWARE, '/');
    expect(error).toBeInstanceOf(BloqueadoPorWafError);
  });

  it('no confunde un 403 cualquiera con el de Radware', () => {
    expect(errorDisfrazadoDelPortal(403, 'text/plain', 'Forbidden', '/')).toBeUndefined();
  });

  it('sigue detectando el WAF F5 en HTML 200', () => {
    const html = '<html><body>Requisição Rejeitada — seu acesso ao serviço foi bloqueado</body></html>';
    expect(errorDisfrazadoDelPortal(200, 'text/html;charset=ISO-8859-1', html, '/')).toBeInstanceOf(
      BloqueadoPorWafError,
    );
  });

  it('sigue detectando la página Seam de saturación', () => {
    const html = '<html>Erro inesperado, por favor tente novamente</html>';
    expect(
      errorDisfrazadoDelPortal(200, 'text/html', html, '/pjeconsulta/errorUnexpected.seam'),
    ).toBeInstanceOf(ServidorSaturadoError);
  });
});
