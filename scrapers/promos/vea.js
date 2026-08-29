import {
  appliesToWebsites,
  buildDiscountLabel,
  buildExternalId as buildCencosudExternalId,
  buildTitle,
  getCencosudBankPromotions,
  mapBanks,
  mapDays,
  normalizePromotion,
  normalizePromotions,
  splitDiscount,
  toDate,
  unwrapDocument,
} from '../../cores/cencosudBankDiscounts.js';

/**
 * 🏷️ Scraper de PROMOCIONES BANCARIAS de Vea
 *
 * Wrapper fino sobre `cores/cencosudBankDiscounts.js`, que es donde vive toda la
 * lógica (fuente, doble parse, concatenación número+sufijo, fechas en hora
 * argentina, external_id estable). Este archivo sólo aporta la parametrización
 * de la cadena: sitio `veaargentina`, source `vea`, prefijo de external_id `vea`.
 *
 * El core nació de extraer esta misma lógica, que originalmente vivía acá, al
 * sumar Disco y migrar Jumbo a la misma fuente. Los caveats están documentados
 * en el core; los dos que más cuestan si se ignoran:
 *   - `discount` + `discountText` son NÚMERO y SUFIJO de una misma etiqueta y se
 *     muestran concatenados ("3" + "cuotas sin interés" ⇒ 3 CUOTAS, no un 3%).
 *   - `toDate` lee el timestamp en hora ARGENTINA (UTC-3): Cencosud usa las
 *     23:59 ART como centinela de último día y leerlo en UTC corre `end_date`.
 *
 * Origen: la entrega de Prácticas Profesionalizantes de Joaquin Alodi (2026-08)
 * identificó que las promos bancarias de Vea son el dato valioso del sitio y
 * que /descuentos-del-dia no es server-rendered. Su implementación las leía como
 * texto plano del DOM (19 bloques, sin estructura); acá se toman del Master Data
 * que alimenta esa misma página, con los campos ya discriminados.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

/** Identificador del sitio de Vea dentro de `websites[]`. */
const VEA_WEBSITE = 'veaargentina';

const SOURCE = 'vea';

/**
 * Host desde el que se lee el documento. Los tres hosts de Cencosud devuelven
 * el mismo documento byte a byte; se conserva el de Vea por trazabilidad.
 */
const VEA_HOST = 'https://www.vea.com.ar';

/*
 * Re-exports del core.
 *
 * No son azúcar: `scraper-tests/vea-promos.test.js` importa estos símbolos desde
 * este módulo, y varios consumidores razonan sobre "las funciones de Vea". Se
 * mantiene la superficie pública intacta tras la extracción al core.
 */
export {
  toDate,
  mapDays,
  mapBanks,
  buildDiscountLabel,
  splitDiscount,
  buildTitle,
  unwrapDocument,
};

/**
 * ¿Aplica esta promoción al sitio de Vea?
 * `websites` trae el account repetido una vez por sucursal; basta con que
 * aparezca al menos una vez.
 */
export function appliesToVea(raw) {
  return appliesToWebsites(raw, [VEA_WEBSITE]);
}

/**
 * external_id de Vea: `vea-<sha1[0..12]>` de los campos invariantes de la promo.
 */
export function buildExternalId(raw) {
  return buildCencosudExternalId(raw, SOURCE);
}

/**
 * Normaliza un registro crudo al contrato que consume
 * `App\Services\PromotionsProviders\VeaService`. Función pura.
 */
export function normalizeVeaPromotion(raw) {
  return normalizePromotion(raw, { source: SOURCE, externalIdPrefix: SOURCE });
}

/**
 * Filtra por sitio + vigencia y normaliza el lote. Función pura.
 *
 * @param {Array} records  promociones crudas del Master Data
 * @param {Date}  now      referencia temporal (inyectable para tests)
 */
export function normalizeVeaPromotions(records, now = new Date()) {
  return normalizePromotions(records, {
    websites: [VEA_WEBSITE],
    source: SOURCE,
    externalIdPrefix: SOURCE,
    now,
  });
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones bancarias de Vea
 */
export async function getVeaPromotions() {
  return getCencosudBankPromotions({
    websites: [VEA_WEBSITE],
    source: SOURCE,
    externalIdPrefix: SOURCE,
    host: VEA_HOST,
    label: 'Vea',
  });
}
