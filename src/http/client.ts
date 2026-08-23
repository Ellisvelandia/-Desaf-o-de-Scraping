/**
 * Cliente HTTP del scraper.
 *
 * Responsabilidades:
 *  - Mantener las cookies de la sesión (JSESSIONID y las del WAF) entre peticiones.
 *    Node no gestiona cookies: se guardan en un mapa y se inyectan en cada petición.
 *  - Decodificar las respuestas con el charset real del servidor (ISO-8859-1),
 *    en lugar de asumir UTF-8 y corromper los acentos del portugués.
 *  - Imponer una pausa mínima entre peticiones.
 *  - Traducir las respuestas "200 con página de error" del portal en errores tipados.
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import * as iconv from 'iconv-lite';
import { CONFIG } from '../config';
import { log } from '../utils/logger';
import { sleep, BloqueadoPorWafError, ServidorSaturadoError } from '../utils/retry';

export interface RespuestaTexto {
  status: number;
  headers: Record<string, unknown>;
  /** Cuerpo decodificado con el charset declarado por el servidor. */
  texto: string;
  /** URL final tras redirecciones. */
  urlFinal: string;
}

export class ClienteHttp {
  private readonly axios: AxiosInstance;
  private readonly cookies = new Map<string, string>();
  private ultimaPeticion = 0;

  constructor() {
    this.axios = axios.create({
      baseURL: CONFIG.baseUrl,
      timeout: CONFIG.requestTimeoutMs,
      responseType: 'arraybuffer',
      maxRedirects: 5,
      // La respuesta se bufferiza entera antes de poder validarla (hay que ver los
      // bytes iniciales para saber si un PDF lo es de verdad). Sin tope, una
      // respuesta inesperadamente enorme se lleva por delante la memoria del
      // proceso, y con ella una extracción de horas.
      maxContentLength: CONFIG.maxResponseBytes,
      maxBodyLength: CONFIG.maxResponseBytes,
      // Los códigos 4xx/5xx se evalúan a mano; aquí solo queremos el objeto respuesta.
      validateStatus: () => true,
      headers: {
        'User-Agent': CONFIG.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,es;q=0.8,en;q=0.7',
      },
    });

    this.axios.interceptors.request.use((config) => {
      const cookie = this.cookieHeader();
      if (cookie) {
        config.headers = config.headers ?? {};
        config.headers['Cookie'] = cookie;
      }
      return config;
    });

    this.axios.interceptors.response.use((respuesta) => {
      this.absorberCookies(respuesta);
      return respuesta;
    });
  }

  /** Reinicia el jar de cookies (nueva sesión). */
  reiniciarSesion(): void {
    this.cookies.clear();
  }

  /** Valor actual de JSESSIONID, necesario para las URL con `;jsessionid=`. */
  get jsessionid(): string | undefined {
    return this.cookies.get('JSESSIONID');
  }

  /** GET que devuelve texto decodificado. */
  async getTexto(url: string, config: AxiosRequestConfig = {}): Promise<RespuestaTexto> {
    const r = await this.peticion({ ...config, method: 'GET', url });
    return this.aTexto(r);
  }

  /** POST de formulario urlencoded que devuelve texto decodificado. */
  async postFormulario(url: string, cuerpo: URLSearchParams, config: AxiosRequestConfig = {}): Promise<RespuestaTexto> {
    const r = await this.peticion({
      ...config,
      method: 'POST',
      url,
      data: cuerpo.toString(),
      headers: {
        ...(config.headers ?? {}),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    });
    return this.aTexto(r);
  }

  /** GET binario (imágenes, PDF). Devuelve el buffer completo. */
  async getBinario(url: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse<Buffer>> {
    const r = await this.peticion({ ...config, method: 'GET', url });
    return r as AxiosResponse<Buffer>;
  }

  /** POST binario (descargas que el portal sirve como respuesta a un POST). */
  async postBinario(url: string, cuerpo: URLSearchParams, config: AxiosRequestConfig = {}): Promise<AxiosResponse<Buffer>> {
    const r = await this.peticion({
      ...config,
      method: 'POST',
      url,
      data: cuerpo.toString(),
      headers: {
        ...(config.headers ?? {}),
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    });
    return r as AxiosResponse<Buffer>;
  }

  // ---------------------------------------------------------------- internos

  private async peticion(config: AxiosRequestConfig): Promise<AxiosResponse<Buffer>> {
    await this.respetarPausa();
    const r = (await this.axios.request<Buffer>(config)) as AxiosResponse<Buffer>;
    log.debug(`${config.method} ${config.url} → ${r.status} (${r.data?.length ?? 0} B)`);
    this.detectarErroresDisfrazados(r);
    if (r.status >= 400) {
      const err = new Error(`HTTP ${r.status} en ${config.method} ${config.url}`) as Error & { response: AxiosResponse };
      err.response = r;
      throw err;
    }
    return r;
  }

  /** El portal devuelve 200 para dos páginas de error distintas. Se convierten en errores tipados. */
  private detectarErroresDisfrazados(r: AxiosResponse<Buffer>): void {
    const tipo = String(r.headers['content-type'] ?? '');
    if (!/text\/html/i.test(tipo)) return;
    const cabecera = this.decodificar(r.data.subarray(0, 4096), tipo);
    if (/Requisi[cç][aã]o\s*-?\s*Rejeitada|seu acesso ao servi[cç]o foi bloqueado/i.test(cabecera)) {
      throw new BloqueadoPorWafError();
    }
    const urlFinal = String(r.request?.res?.responseUrl ?? r.config.url ?? '');
    if (/errorUnexpected\.seam/i.test(urlFinal) || /Erro inesperado, por favor tente novamente/i.test(cabecera)) {
      throw new ServidorSaturadoError();
    }
  }

  private aTexto(r: AxiosResponse<Buffer>): RespuestaTexto {
    const tipo = String(r.headers['content-type'] ?? '');
    return {
      status: r.status,
      headers: r.headers as Record<string, unknown>,
      texto: this.decodificar(r.data, tipo),
      urlFinal: String(r.request?.res?.responseUrl ?? r.config.url ?? ''),
    };
  }

  /** Decodifica según el charset del Content-Type; el portal declara ISO-8859-1. */
  private decodificar(buffer: Buffer, contentType: string): string {
    const m = /charset=([\w-]+)/i.exec(contentType);
    const charset = (m?.[1] ?? 'ISO-8859-1').toLowerCase();
    if (charset === 'utf-8' || charset === 'utf8') return buffer.toString('utf8');
    return iconv.decode(buffer, iconv.encodingExists(charset) ? charset : 'ISO-8859-1');
  }

  private cookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private absorberCookies(r: AxiosResponse): void {
    const setCookie = r.headers['set-cookie'] as string[] | undefined;
    if (!setCookie) return;
    for (const linea of setCookie) {
      const par = linea.split(';')[0];
      const idx = par.indexOf('=');
      if (idx <= 0) continue;
      this.cookies.set(par.slice(0, idx).trim(), par.slice(idx + 1).trim());
    }
  }

  private async respetarPausa(): Promise<void> {
    const transcurrido = Date.now() - this.ultimaPeticion;
    const falta = CONFIG.delayBetweenRequestsMs - transcurrido;
    if (falta > 0) await sleep(falta);
    this.ultimaPeticion = Date.now();
  }
}
