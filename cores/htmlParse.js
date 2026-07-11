/**
 * Helpers compartidos de parsing HTML/texto para los scrapers de promociones.
 *
 * A diferencia de los scrapers VTEX (que consumen JSON), las fuentes de
 * promociones (MercadoPago WordPress, Patagonia Magento) renderizan el HTML
 * del lado del servidor. Estos helpers centralizan:
 *   - descarga con axios + carga en cheerio (con manejo de encoding latin-1)
 *   - limpieza de texto
 *   - parseo de montos ($) y porcentajes (%)
 *
 * NO escriben en la base de datos: son funciones puras reutilizables.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';

// User-Agent realista para evitar bloqueos básicos por WAF.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_TIMEOUT = 25000; // 25s

/**
 * Normaliza espacios en blanco y recorta un string.
 * @param {string|null|undefined} str
 * @returns {string} - Texto limpio (string vacío si la entrada es nula)
 */
export function cleanText(str) {
  if (str == null) return '';
  return String(str).replace(/\s+/g, ' ').trim();
}

/**
 * Extrae un monto en pesos de un texto y lo devuelve como número.
 * Maneja el formato argentino: '.' como separador de miles y ',' como decimal.
 * Ej: "Tope: $10.000" -> 10000 ; "$1.234,50" -> 1234.5 ; "sin tope" -> null
 * @param {string|null|undefined} str
 * @returns {number|null}
 */
export function parseMoney(str) {
  if (str == null) return null;
  // Nos quedamos solo con dígitos, puntos y comas.
  const match = String(str).match(/[\d.,]+/);
  if (!match) return null;

  let raw = match[0];
  // Formato AR: los puntos son separadores de miles, la coma es decimal.
  raw = raw.replace(/\./g, '').replace(',', '.');

  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Extrae un porcentaje de un texto y lo devuelve como número (sin el símbolo %).
 * Ej: "Hasta 45% OFF" -> 45 ; "15" -> 15 ; "20,5%" -> 20.5 ; "off" -> null
 * @param {string|null|undefined} str
 * @returns {number|null}
 */
export function parsePercent(str) {
  if (str == null) return null;
  const text = String(str);

  // Priorizamos un número seguido de '%'.
  let match = text.match(/(\d+(?:[.,]\d+)?)\s*%/);
  // Si no hay '%', tomamos el primer número presente.
  if (!match) match = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;

  const value = Number.parseFloat(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/**
 * Devuelve el atributo del primer elemento de una selección cheerio, o null.
 * @param {import('cheerio').Cheerio} $el - Selección cheerio
 * @param {string} attr - Nombre del atributo
 * @returns {string|null}
 */
export function firstAttr($el, attr) {
  if (!$el || $el.length === 0) return null;
  const value = $el.first().attr(attr);
  return value == null ? null : value;
}

/**
 * Descarga una URL con axios y la carga en cheerio.
 *
 * Maneja encoding: descarga como bytes crudos (arraybuffer) y, si el charset
 * de la respuesta NO es UTF-8 (típico en Magento/latin-1), decodifica como
 * latin1 para evitar mojibake (ej: "PROMOCIÓN" en vez de "PROMOCIÃ“N").
 *
 * @param {string} url
 * @param {Object} [opts] - Opciones opcionales de axios (headers, timeout, params, method)
 * @returns {Promise<import('cheerio').CheerioAPI>} - Instancia cheerio ya cargada
 */
export async function fetchCheerio(url, opts = {}) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer', // bytes crudos → controlamos el decode nosotros
    timeout: opts.timeout || DEFAULT_TIMEOUT,
    headers: {
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate',
      'Accept-Language': 'es-AR,es;q=0.9',
      ...(opts.headers || {}),
    },
    ...opts,
  });

  const buffer = Buffer.from(response.data);

  // 1) Charset declarado en el header Content-Type.
  const contentType = response.headers['content-type'] || '';
  let charset = /charset=([^;]+)/i.exec(contentType)?.[1]?.toLowerCase()?.trim() || null;

  let html;
  if (charset && !/utf-?8/.test(charset)) {
    // Charset explícito no-UTF8 (ej: iso-8859-1 / latin-1).
    html = buffer.toString('latin1');
  } else {
    html = buffer.toString('utf8');
    // 2) Si no había charset en el header, lo buscamos en el <meta> del HTML.
    if (!charset) {
      const meta = /<meta[^>]+charset=["']?([^"'>\s;]+)/i.exec(html);
      if (meta && !/utf-?8/i.test(meta[1])) {
        html = buffer.toString('latin1');
      }
    }
  }

  return cheerio.load(html);
}
