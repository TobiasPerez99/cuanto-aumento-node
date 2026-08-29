import {
  appliesToWebsites,
  buildExternalId as buildCencosudExternalId,
  getCencosudBankPromotions,
  normalizePromotion,
  normalizePromotions,
} from '../../cores/cencosudBankDiscounts.js';

/**
 * 🏷️ Scraper de PROMOCIONES BANCARIAS de Disco
 *
 * Wrapper fino sobre `cores/cencosudBankDiscounts.js` (mismo patrón que
 * `vea.js`): toda la lógica —fuente, doble parse, concatenación número+sufijo,
 * fechas en hora argentina, external_id estable— vive en el core; acá sólo se
 * parametriza la cadena.
 *
 * ⚠️ El documento NO se pide con `an=discoargentina`. Vive en la cuenta
 * `jumboargentina` y es COMPARTIDO por las tres cadenas de Cencosud; pedirlo con
 * el account de Disco devuelve **200 con cuerpo vacío**, un fallo silencioso.
 * La cadena se resuelve filtrando `websites[]` por `discoargentina`, no
 * cambiando el parámetro `an` (el core ya lo fija).
 *
 * Medido el 2026-08-29 sobre las 193 promos del documento: 146 declaran
 * `discoargentina`, de las cuales 33 siguen vigentes.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

/** Identificador del sitio de Disco dentro de `websites[]`. */
const DISCO_WEBSITE = 'discoargentina';

const SOURCE = 'disco';

const DISCO_HOST = 'https://www.disco.com.ar';

/**
 * ¿Aplica esta promoción al sitio de Disco?
 *
 * ⚠️ La comparación es exacta: en el dataset conviven `discoargentina` (146
 * promos) y un `disco` a secas (3 promos), que no son el mismo sitio.
 */
export function appliesToDisco(raw) {
  return appliesToWebsites(raw, [DISCO_WEBSITE]);
}

/**
 * external_id de Disco: `disco-<sha1[0..12]>` de los campos invariantes.
 *
 * El prefijo separa el namespace por cadena: una promo que Cencosud declara para
 * Disco y Vea a la vez debe entrar como dos filas distintas, porque cada PULL
 * provider la asocia a su propio merchant.
 */
export function buildExternalId(raw) {
  return buildCencosudExternalId(raw, SOURCE);
}

/**
 * Normaliza un registro crudo al contrato de promoción. Función pura.
 */
export function normalizeDiscoPromotion(raw) {
  return normalizePromotion(raw, { source: SOURCE, externalIdPrefix: SOURCE });
}

/**
 * Filtra por sitio + vigencia y normaliza el lote. Función pura.
 *
 * @param {Array} records  promociones crudas del Master Data
 * @param {Date}  now      referencia temporal (inyectable para tests)
 */
export function normalizeDiscoPromotions(records, now = new Date()) {
  return normalizePromotions(records, {
    websites: [DISCO_WEBSITE],
    source: SOURCE,
    externalIdPrefix: SOURCE,
    now,
  });
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones bancarias de Disco
 */
export async function getDiscoPromotions() {
  return getCencosudBankPromotions({
    websites: [DISCO_WEBSITE],
    source: SOURCE,
    externalIdPrefix: SOURCE,
    host: DISCO_HOST,
    label: 'Disco',
  });
}
