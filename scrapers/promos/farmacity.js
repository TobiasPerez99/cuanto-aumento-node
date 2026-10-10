import axios from 'axios';
import { clean, parseValidityText, shortHash, stripHtml } from '../../cores/promoText.js';
import { loadTeaserSnapshot } from '../../cores/teaserSnapshots.js';

/**
 * 🏷️ Scraper de PROMOCIONES de Farmacity
 *
 * Dos fuentes, una corrida:
 *
 * 1. **Promos bancarias** — la planilla de /Farmacity/medios-de-pago. No hay Master
 *    Data accesible (BP y FB dan 403): es contenido del Site Editor que viaja ENTERO
 *    en el HTML, dentro de `<template data-field="extensions">`. El bloque que termina
 *    en `/payment-methods` (`farmacityar.payment-methods`) tiene en `content.jsonData`
 *    un STRING con un JSON adentro (doble parse): ~600 filas de una planilla con las
 *    columnas `Banco, Tarjeta, Nombre, Cuotas, CFT…, Tienda, Promoción, Legales`.
 *    Sólo ~70 filas traen `Promoción`; el resto son las tasas de cada plan de cuotas.
 *
 * 2. **Promos de producto** — los teasers de VTEX ("2x1 Tu Farmacity#01/09 - 21/09",
 *    "-50% 2da unidad"), que identificó la pasante (ver "Origen"). Verlos todos exige
 *    recorrer el catálogo (7,5 min): los junta la corrida de productos de Farmacity y
 *    acá se lee esa foto (`cores/teaserSnapshots.js`). Sin foto, salen sólo las
 *    bancarias.
 *
 * ⚠️ **La planilla está desalineada** (relevado el 2026-09-23): `Promoción` y
 *    `Legales` de la misma fila pueden describir promos distintas del mismo banco, y la
 *    columna `Tarjeta` de la fila de la promo no es la tarjeta de la promo (se asigna
 *    por posición). Por eso la promo se arma desde el texto de `Promoción`, que es
 *    autocontenido (días, %, tope, cuotas, canal), los legales viajan aparte con un
 *    aviso, y la tarjeta no se emite.
 *
 * ⚠️ **No hay ids.** El `external_id` es un hash de banco + texto de la promo: un
 *    retoque del texto genera una promo nueva (la vieja vence sola). Aceptado.
 *
 * ⚠️ **Fechas:** sólo algunas promos traen su vigencia en el texto ("Vigencia: del
 *    01/07/2026 al 31/12/2026", "Vigencia 08.10 al 10.10"); se emite ésa. Una promo
 *    cuyo propio texto dice que ya terminó se descarta (la planilla deja publicadas
 *    algunas vencidas). Sin fecha en el texto viajan null y la IA lee los legales.
 *
 * Los banners de la página ("¡Aprovechá las promociones del día!") quedan afuera: su
 * texto vive en la imagen y sus fechas son la ventana de exhibición, no la vigencia.
 *
 * Origen: la entrega de Prácticas Profesionalizantes de **Natalia Rojas** (2026-10),
 * que identificó los teasers del catálogo y las promos en banners de /promociones, y la
 * API del localizador de sucursales (ver `scrapers/stores/farmacity_stores.js`).
 *
 * NO lanza excepciones al caller: ante error devuelve `{ success:false, ... }`.
 */

const SOURCE = 'farmacity';
const MERCHANT = 'Farmacity';
const PAYMENT_PAGE = 'https://www.farmacity.com/Farmacity/medios-de-pago';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LEGALES_AVISO =
  'Los legales de la planilla de Farmacity pueden corresponder a otra promoción del mismo banco: ' +
  'ante una contradicción, vale el texto de "promocion".';

const defaultHttpGet = (url) =>
  axios.get(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    timeout: 30000,
    responseType: 'text',
    validateStatus: () => true,
  });

/** Fecha de hoy en Argentina (UTC-3). */
function argentineToday(now) {
  return new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Las extensiones del render-runtime de VTEX embebidas en el HTML (contenido del Site
 * Editor). El template envuelve el JSON en un `<script>`.
 */
export function extractRuntimeExtensions(html) {
  const match = String(html ?? '').match(/<template[^>]*data-field="extensions"[^>]*>([\s\S]*?)<\/template>/);
  if (!match) throw new Error('la página no trae el template de extensiones del Site Editor');
  const body = match[1].replace(/^\s*<script[^>]*>/, '').replace(/<\/script>\s*$/, '');
  return JSON.parse(body);
}

/** Filas de la planilla de medios de pago (doble parse de `content.jsonData`). */
export function extractPaymentRows(extensions) {
  const key = Object.keys(extensions ?? {}).find((k) => k.endsWith('/payment-methods'));
  const jsonData = key ? extensions[key]?.content?.jsonData : null;
  if (typeof jsonData !== 'string') {
    throw new Error('no se encontró la planilla de medios de pago (¿cambió el bloque del Site Editor?)');
  }
  const rows = JSON.parse(jsonData);
  if (!Array.isArray(rows)) throw new Error('la planilla de medios de pago no es una lista');
  return rows;
}

/**
 * ¿El texto describe un beneficio? Descarta filas informativas como "Pagá al
 * contado con tu Tarjeta de débito".
 */
export function isBenefitText(text) {
  return /%|cuota|\bcsi\b|reintegro|descuento|ahorro/i.test(String(text ?? ''));
}

/** Primera oración, para el título. */
function firstSentence(text, max = 140) {
  const sentence = text.split(/(?<=\.)\s/)[0];
  return clean(sentence, max);
}

/**
 * Promos bancarias desde las filas de la planilla. Función pura.
 *
 * @returns {{ promotions: Array, expired: number, informative: number }}
 */
export function buildBankPromotions(rows, now = new Date()) {
  const today = argentineToday(now);
  const byId = new Map();
  let expired = 0;
  let informative = 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const promocion = clean(row?.['Promoción']);
    if (!promocion) continue;
    if (!isBenefitText(promocion)) {
      informative++;
      continue;
    }

    const banco = clean(row?.Nombre) ?? clean(row?.Banco);
    const { start_date, end_date } = parseValidityText(promocion, now);
    if (end_date !== null && end_date < today) {
      expired++;
      continue;
    }

    const externalId = `fcy-banco-${shortHash(`${clean(row?.Banco) ?? ''}|${promocion}`)}`;
    if (byId.has(externalId)) continue;

    const legales = stripHtml(row?.Legales, 4000);
    byId.set(externalId, {
      external_id: externalId,
      source: SOURCE,
      comercio: MERCHANT,
      tipo: 'bancaria',
      title: banco ? `${banco}: ${firstSentence(promocion)}` : firstSentence(promocion),
      banco,
      promocion,
      legales_de_la_fila: legales,
      ...(legales ? { aviso: LEGALES_AVISO } : {}),
      start_date,
      end_date,
    });
  }

  return { promotions: [...byId.values()], expired, informative };
}

/**
 * "2x1 Combinable Tu Farmacity#01/09 - 21/09 // ID: 250077 (Bot carga: 28-08)" →
 * título sin la marca interna, y la vigencia del tramo después de `#` (sin año: se
 * ubica cerca de la fecha de la foto).
 */
export function parseTeaserName(name, reference = new Date()) {
  const raw = String(name ?? '');
  const [head, ...rest] = raw.split('#');
  const title = clean(head.replace(/\/\/.*$/, '').replace(/\([^)]*\)/g, ''));
  const validity = rest.length ? parseValidityText(rest.join('#'), reference) : { start_date: null, end_date: null };
  return { title, ...validity };
}

/**
 * Promos de producto desde la foto de teasers. Función pura.
 *
 * Varios teasers internos pueden ser la misma promo (difieren sólo en la marca de
 * carga "Bot carga: 28-08"): se agrupan por título + vigencia.
 */
export function buildTeaserPromotions(snapshot, now = new Date()) {
  if (!snapshot || !Array.isArray(snapshot.teasers)) return [];
  const today = argentineToday(now);
  const reference = new Date(snapshot.captured_at ?? now);
  const groups = new Map();

  for (const teaser of snapshot.teasers) {
    const { title, start_date, end_date } = parseTeaserName(teaser?.name, reference);
    if (!title) continue;
    if (end_date !== null && end_date < today) continue;

    const key = `${title}|${start_date}|${end_date}`;
    const group = groups.get(key);
    if (group) {
      group.product_count += teaser.product_count ?? 0;
      for (const sample of teaser.sample_products ?? []) {
        if (group.sample_products.length < 5) group.sample_products.push(sample);
      }
      continue;
    }
    groups.set(key, {
      external_id: `fcy-promo-${shortHash(key)}`,
      source: SOURCE,
      comercio: MERCHANT,
      tipo: 'producto',
      title,
      exclusivo_tu_farmacity: /tu farmacity/i.test(title),
      solo_web: /solo web/i.test(title),
      combinable: /combinable/i.test(title),
      start_date,
      end_date,
      // Volátiles: cambian con el catálogo sin que cambie la promo. FarmacityService
      // los saca de la huella (`volatileKeys`), igual que Dia y Josimar.
      product_count: teaser.product_count ?? 0,
      sample_products: (teaser.sample_products ?? []).slice(0, 5),
    });
  }

  return [...groups.values()];
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de Farmacity
 */
export async function getFarmacityPromotions({
  httpGet = defaultHttpGet,
  loadSnapshot = loadTeaserSnapshot,
  now = new Date(),
} = {}) {
  console.log('🏷️ Iniciando scraper de promociones de Farmacity...');

  try {
    const page = await httpGet(PAYMENT_PAGE);
    if (page.status < 200 || page.status >= 300) throw new Error(`medios de pago respondió HTTP ${page.status}`);

    const rows = extractPaymentRows(extractRuntimeExtensions(page.data));
    const bank = buildBankPromotions(rows, now);
    if (bank.promotions.length === 0) {
      // ~600 filas y ninguna promo: la planilla cambió de columnas. Fallar, no "0 promos".
      throw new Error(`la planilla trajo ${rows.length} filas y ninguna promo vigente con texto de beneficio`);
    }

    const snapshot = await loadSnapshot(SOURCE, now);
    const product = buildTeaserPromotions(snapshot, now);
    if (!snapshot) {
      console.warn('⚠️ Farmacity: todavía no hay foto de teasers (la deja la corrida de productos); salen sólo las bancarias.');
    }

    const promotions = [...bank.promotions, ...product];
    console.log(
      `🎉 Farmacity: ${bank.promotions.length} bancarias (${bank.expired} vencidas descartadas) + ${product.length} de producto`
    );

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      promotions,
      teaser_snapshot: snapshot ? { captured_at: snapshot.captured_at, teasers: snapshot.teasers.length } : null,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de promociones de Farmacity:', error.message);
    return {
      success: false,
      source: SOURCE,
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
