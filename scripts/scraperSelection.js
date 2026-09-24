/**
 * Qué entradas de SCRAPERS corren en una corrida "de todos" (`POST /api/scrape/all`
 * y `runAll()`).
 *
 * Sólo los scrapers de productos (y `modo`, tipo 'bank', que se queda como estaba:
 * no está claro quién consume su resultado). Los de promociones y sucursales NO:
 * Laravel los trae con su propio pull (`promotions:get`, `stores:sync`) y nada
 * guarda lo que devuelven dentro de una corrida de productos. Antes cada cron de
 * productos (cada 3 h) corría, por ejemplo, el scrape completo de Galicia
 * (~1.630 requests) para tirarlo. Se siguen pudiendo correr por nombre
 * (`POST /api/scrape/:scraperName`, `node scripts/populate-db.js galicia`).
 */
export const NON_PRODUCT_TYPES = ['promo', 'stores'];

/**
 * @param {Record<string, {type?: string, isMaster?: boolean}>} scrapers
 * @returns {Array<[string, object]>} entradas de productos, en el orden del registro
 */
export function productEntries(scrapers) {
  return Object.entries(scrapers).filter(([, s]) => !NON_PRODUCT_TYPES.includes(s.type));
}
