import axios from 'axios';
import { clean, exclusiveEndToInclusive, utcDateOnly } from './promoText.js';

/**
 * 🏦 Core compartido de PROMOCIONES BANCARIAS de la plantilla de Valtech
 *    (Carrefour · Masonline)
 *
 * Carrefour (`valtech.carrefourar-bank-promotions`) y Masonline/ChangoMás
 * (`valtech.gdn-banks-promotions`) usan el mismo componente de Valtech, que lee
 * tres entidades del Master Data de VTEX. Las tres responden por REST, sin
 * GraphQL, sin hash, sin cookies y sin token:
 *
 *   GET /api/dataentities/BP/search?_fields=…&_where=active=true&_sort=order ASC
 *       → las promociones (título, %, cuotas, días en booleanos, vigencia, legal)
 *   GET /api/dataentities/FB/search?_fields=id,name   → bancos y billeteras (idBank)
 *   GET /api/dataentities/FC/search?_fields=id,name   → tarjetas (idCard)
 *
 * ⚠️ **El header `REST-Range` es obligatorio.** Sin él el Master Data devuelve
 * 15 filas con un 200 silencioso (`rest-content-range: resources 0-15/170`):
 * parece que el comercio tiene 15 promos. Mismo gotcha que las sucursales de Disco.
 *
 * ⚠️ **Fechas en UTC y con fin EXCLUSIVO.** `active_from`/`active_to` vienen como
 * `2026-10-01T00:00:00+00:00` / `2026-11-01T00:00:00+00:00` y el legal dice
 * "HASTA EL 31/10/2026". Leídas en hora argentina correrían el inicio un día para
 * atrás (el caso opuesto a Cencosud, que graba en hora local). Ver
 * `exclusiveEndToInclusive` en `cores/promoText.js`: Masonline también carga
 * fines inclusivos, así que sólo el 1° de mes a medianoche se toma como exclusivo.
 *
 * ⚠️ **En Masonline el dato estructurado miente** (relevado el 2026-09-23): un
 * "martes 29" con `monday: true`, un 20% con legal de 30%, booleanos que no
 * pueden expresar "el cuarto fin de semana de cada mes". Por eso se emiten el
 * `legal` y `validText` completos junto a los campos estructurados: la IA tiene la
 * regla "si el dato contradice al legal, vale el legal" (prompt v2.6).
 *
 * ⚠️ **En Masonline el título NO dice el banco** ("SIN TOPE DE REINTEGRO"): el
 * banco sale sólo de `idBank` → FB. Por eso un diccionario que no responde hace
 * fallar la corrida en vez de emitir promos sin banco.
 *
 * Las funciones de normalización son PURAS (sin red): son la parte testeable.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Lo que pide el componente del front, más los campos propios de Masonline. */
const BP_FIELDS = [
  'id', 'title', 'sub_title', 'discount_percentage', 'discounts_amount_installments',
  'discounts_text_installments', 'discount_text_info', 'order', 'active_from', 'active_to',
  'active', 'validText', 'hyper', 'market', 'ecommerce', 'express', 'maxi', 'legal',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'idBank', 'idCard', 'isMasClub',
].join(',');

const PAGE = 1000;
/** Tope defensivo de documentos (Carrefour tiene 144 contando los históricos). */
const MAX_DOCUMENTS = 5000;

const DAYS = [
  ['monday', 'lunes'],
  ['tuesday', 'martes'],
  ['wednesday', 'miercoles'],
  ['thursday', 'jueves'],
  ['friday', 'viernes'],
  ['saturday', 'sabado'],
  ['sunday', 'domingo'],
];

/** Formatos de tienda de Carrefour (el legal los confirma: Hiper, Market, Online, Express, Maxi). */
const FORMATS = [
  ['hyper', 'hiper'],
  ['market', 'market'],
  ['ecommerce', 'online'],
  ['express', 'express'],
  ['maxi', 'maxi'],
];

/**
 * Nombre legible de un banco o tarjeta del diccionario. Son etiquetas internas
 * ("Banco_Nacion", "Tarjeta_Standard_Master_Carrefour", "ICBC_Sueldos").
 *
 * ⚠️ Masonline tiene en FC una fila "kimi-probe-inert-please-ignore": alguien
 * escribió en la entidad. Es ruido y no se mapea.
 */
export function humanizeName(name) {
  const text = clean(name);
  if (!text) return null;
  if (/please-ignore|probe-inert/i.test(text)) return null;
  return clean(text.replace(/_/g, ' '));
}

/** Mapa id → nombre legible de un diccionario FB/FC. */
export function buildDictionary(records) {
  const map = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.id == null) continue;
    const name = humanizeName(record.name);
    if (name) map.set(String(record.id), name);
  }
  return map;
}

/** Cuotas: viene como STRING ("6"); null si no es un entero positivo. */
export function parseInstallments(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** El mismo filtro que el front: activa y con `active_from < ahora < active_to`. */
export function isCurrent(record, now = new Date()) {
  if (record?.active !== true) return false;
  const from = Date.parse(record.active_from);
  const to = Date.parse(record.active_to);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  const t = now.getTime();
  return from < t && t < to;
}

/**
 * Convierte un documento BP al contrato de promoción que consumen los
 * `App\Services\PromotionsProviders\{Carrefour,Masonline}Service`.
 *
 * No se emiten `order` ni `img_card`: el orden y el logo cambian sin que cambie
 * la promo, y meterlos en el payload la mandaría a la IA de nuevo (la huella de
 * contenido de `PromotionStaging` mira todo el registro).
 */
export function normalizeValtechPromotion(record, { source, merchant, banks, cards, withFormats = false }) {
  const percentage = Number(record?.discount_percentage);
  const promotion = {
    external_id: `${source}-${record.id}`,
    source,
    comercio: merchant,
    title: clean(record?.title),
    subtitle: clean(record?.sub_title),
    banco: banks.get(String(record?.idBank)) ?? null,
    tarjeta: cards.get(String(record?.idCard)) ?? null,
    descuento_porcentaje: Number.isFinite(percentage) && percentage > 0 ? percentage : null,
    descuento_etiqueta: clean(record?.discount_text_info),
    cuotas: parseInstallments(record?.discounts_amount_installments),
    cuotas_texto: clean(record?.discounts_text_installments),
    dias: DAYS.filter(([key]) => record?.[key] === true).map(([, name]) => name),
    dias_texto: clean(record?.validText),
    legal: clean(record?.legal, 4000),
    start_date: utcDateOnly(record?.active_from),
    end_date: exclusiveEndToInclusive(record?.active_to),
  };

  if (withFormats) {
    promotion.formatos = FORMATS.filter(([key]) => record?.[key] === true).map(([, name]) => name);
  }
  if (typeof record?.isMasClub === 'boolean') {
    promotion.exclusivo_mas_club = record.isMasClub;
  }

  return promotion;
}

/**
 * Filtra las vigentes y las normaliza. Función pura.
 *
 * @param {Object} raw      { bp, fb, fc } tal como los devuelve el Master Data
 * @param {Object} options  { source, merchant, withFormats, now }
 */
export function normalizeValtechPromotions(raw, { source, merchant, withFormats = false, now = new Date() }) {
  const banks = buildDictionary(raw?.fb);
  const cards = buildDictionary(raw?.fc);
  const records = Array.isArray(raw?.bp) ? raw.bp : [];

  const byId = new Map();
  for (const record of records) {
    if (record?.id == null || !isCurrent(record, now)) continue;
    const promotion = normalizeValtechPromotion(record, { source, merchant, banks, cards, withFormats });
    if (!byId.has(promotion.external_id)) byId.set(promotion.external_id, promotion);
  }
  return [...byId.values()];
}

/** "resources 0-144/144" → 144; null si no se puede leer. */
export function parseContentRangeTotal(header) {
  const match = String(header ?? '').match(/\/(\d+)\s*$/);
  return match ? Number(match[1]) : null;
}

const defaultHttpGet = (url, headers) =>
  axios.get(url, { headers, timeout: 20000, validateStatus: () => true });

/**
 * Trae una entidad completa del Master Data, paginando con `REST-Range` si el
 * total declarado supera la página. Lanza ante un status no-2xx o un cuerpo que
 * no es un array: mejor una corrida fallida que un "no hay promos".
 */
export async function fetchEntity(baseUrl, entity, query, { httpGet = defaultHttpGet } = {}) {
  const all = [];
  for (let from = 0; from < MAX_DOCUMENTS; from += PAGE) {
    const url = `${baseUrl}/api/dataentities/${entity}/search?${query}`;
    const response = await httpGet(url, {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.vtex.ds.v10+json',
      'REST-Range': `resources=${from}-${from + PAGE - 1}`,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${entity}: el Master Data respondió ${response.status}`);
    }
    if (!Array.isArray(response.data)) {
      throw new Error(`${entity}: el Master Data no devolvió una lista (¿cambió la entidad o pide auth?)`);
    }

    all.push(...response.data);
    const headers = response.headers ?? {};
    const total = parseContentRangeTotal(headers['rest-content-range'] ?? headers['REST-Content-Range']);
    if (total === null || all.length >= total || response.data.length < PAGE) break;
  }
  return all;
}

/**
 * 🎯 Corrida completa para un comercio. NO lanza: ante error devuelve
 * `{ success:false, ... }`, que el route convierte en 502.
 *
 * @param {Object} options
 *   - baseUrl      https://www.carrefour.com.ar
 *   - source       slug del provider y prefijo del external_id
 *   - merchant     nombre del comercio en Ahorrapp (va en `comercio`)
 *   - withFormats  emitir los formatos de tienda (sólo Carrefour los usa)
 *   - httpGet, now inyectables para tests
 */
export async function getValtechBankPromotions({
  baseUrl,
  source,
  merchant,
  withFormats = false,
  httpGet = defaultHttpGet,
  now = new Date(),
}) {
  console.log(`🏷️ Iniciando scraper de promociones bancarias de ${merchant}...`);

  try {
    const bp = await fetchEntity(
      baseUrl,
      'BP',
      `_fields=${BP_FIELDS}&_where=active=true&_sort=order%20ASC`,
      { httpGet }
    );
    const fb = await fetchEntity(baseUrl, 'FB', '_fields=id,name', { httpGet });
    const fc = await fetchEntity(baseUrl, 'FC', '_fields=id,name', { httpGet });

    const promotions = normalizeValtechPromotions({ bp, fb, fc }, { source, merchant, withFormats, now });

    console.log(`📊 ${bp.length} promos activas en el Master Data de ${merchant}; vigentes hoy: ${promotions.length}`);
    if (bp.length > 0 && promotions.length === 0) {
      // Respondió pero nada quedó vigente: o cambió el formato de las fechas, o el
      // operador no renovó nada. Un 0 silencioso es indistinguible de "no hay promos".
      console.warn(`⚠️ ${merchant}: ${bp.length} promos activas y ninguna dentro de su ventana de vigencia.`);
    }

    return {
      success: true,
      source,
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`❌ Error en scraper de promociones ${merchant}:`, error.message);
    return {
      success: false,
      source,
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
