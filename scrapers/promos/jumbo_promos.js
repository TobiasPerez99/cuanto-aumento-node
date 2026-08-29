import {
  appliesToWebsites,
  buildExternalId as buildCencosudExternalId,
  getCencosudBankPromotions,
  normalizePromotion,
  normalizePromotions,
} from '../../cores/cencosudBankDiscounts.js';

/**
 * 🏷️ Scraper de PROMOCIONES BANCARIAS de Jumbo
 *
 * Wrapper fino sobre `cores/cencosudBankDiscounts.js` (mismo patrón que
 * `vea.js` y `disco.js`): la lógica vive en el core, acá sólo se parametriza la
 * cadena.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ⚠️ POR QUÉ SE REEMPLAZÓ EL ENFOQUE ANTERIOR
 *
 * Hasta esta versión, este scraper derivaba las promociones de los
 * `clusterHighlights` del catálogo de VTEX (`/api/catalog_system/pub/products/
 * search?ft=promociones`), agrupando productos por cluster y usando el nombre
 * del cluster como título de la promoción.
 *
 * El problema es que los `clusterHighlights` de Cencosud NO son texto para el
 * usuario: son **códigos internos de campaña** del backoffice de marketing. Los
 * títulos que salían de ahí eran literalmente así:
 *
 *   "VEA_visaymastercardtmpinst3x-mensualfam47sar"
 *   "DISCO_rpacpay20off-28al02sar"
 *
 * Inservibles por partida doble: ilegibles para el usuario final e imposibles de
 * normalizar para la IA, que no tiene de dónde sacar banco, porcentaje, cuotas,
 * días ni vigencia — el cluster no los expone en ningún campo. Encima el nombre
 * arrastra la cadena equivocada ("VEA_", "DISCO_") aunque el producto se haya
 * leído del catálogo de Jumbo, y el catálogo tampoco expone vigencia de los
 * clusters, así que TODA promo derivada así caía en `needs_review` por
 * `dates_defaulted`.
 *
 * El Master Data `bankDiscount` —que ya usaba Vea— tiene las mismas promociones
 * pero **estructuradas**: banco, descuento, cuotas, medio de pago, días, vigencia
 * y legales. Es la misma fuente que alimenta la página de descuentos del sitio.
 * Migrar era la mejora pendiente anotada desde que se escribió `vea.js`.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ **Jumbo tiene DOS identificadores de sitio** en `websites[]`:
 * `jumboargentina` (138 promos de las 193) y `jumboargentinaio` (149, la tienda
 * online). Hay que aceptar los dos: al 2026-08-29 dan 35 y 34 vigentes, y la
 * unión da 35 — filtrar por uno solo perdería promos de la otra vitrina.
 *
 * Contra la intuición, ese solapamiento NO produce duplicados: cada promo es
 * UNA fila que enumera sus sitios, así que declarar los dos no la hace pasar dos
 * veces (medido: 35 antes y después de deduplicar). Y el dedupe por
 * `external_id` tampoco está tapando un duplicado real: medido el 2026-08-29 no
 * colapsa nada en ninguna cadena. Las 2 colisiones de fingerprint que sí tiene
 * el documento (193 filas, 191 fingerprints) son pares CRUZADOS entre cadenas,
 * que el filtro por sitio separa antes del dedupe. Queda como red de seguridad;
 * el detalle y por qué esas colisiones igual incomodan está en el core.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

/**
 * Los dos ids de sitio de Jumbo. Se aceptan ambos porque una promo puede estar
 * declarada sólo en la tienda online.
 */
const JUMBO_WEBSITES = ['jumboargentina', 'jumboargentinaio'];

const SOURCE = 'jumbo';

const JUMBO_HOST = 'https://www.jumbo.com.ar';

/**
 * ¿Aplica esta promoción a alguno de los dos sitios de Jumbo?
 */
export function appliesToJumbo(raw) {
  return appliesToWebsites(raw, JUMBO_WEBSITES);
}

/**
 * external_id de Jumbo: `jumbo-<sha1[0..12]>` de los campos invariantes.
 *
 * El hash NO incluye el sitio, y eso es deliberado: es exactamente lo que hace
 * que la misma promo vista desde `jumboargentina` y desde `jumboargentinaio`
 * colapse en una sola al deduplicar.
 */
export function buildExternalId(raw) {
  return buildCencosudExternalId(raw, SOURCE);
}

/**
 * Normaliza un registro crudo al contrato de promoción. Función pura.
 */
export function normalizeJumboPromotion(raw) {
  return normalizePromotion(raw, { source: SOURCE, externalIdPrefix: SOURCE });
}

/**
 * Filtra por sitio + vigencia, normaliza y deduplica el lote. Función pura.
 *
 * @param {Array} records  promociones crudas del Master Data
 * @param {Date}  now      referencia temporal (inyectable para tests)
 */
export function normalizeJumboPromotions(records, now = new Date()) {
  return normalizePromotions(records, {
    websites: JUMBO_WEBSITES,
    source: SOURCE,
    externalIdPrefix: SOURCE,
    now,
  });
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones bancarias de Jumbo
 *
 * El nombre se conserva porque `routes/dataRoutes.js` lo importa tal cual para
 * el endpoint `GET /api/promotions/jumbo`; sólo cambió la fuente por detrás.
 */
export async function getJumboPromotions() {
  return getCencosudBankPromotions({
    websites: JUMBO_WEBSITES,
    source: SOURCE,
    externalIdPrefix: SOURCE,
    host: JUMBO_HOST,
    label: 'Jumbo',
  });
}
