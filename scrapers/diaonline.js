import { scrapeVtexProducts } from '../cores/vtexProducts.js';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Dia (FOLLOWER)
 *
 * Recorre el catálogo REST de VTEX (ver `cores/vtexProducts.js` y
 * `cores/vtexCatalog.js`). Modos: `categories` (default), `eans` y `search`
 * (la búsqueda de texto de GraphQL, como vuelta atrás).
 */
export async function getDiaMainProducts(mode = 'categories') {
  return scrapeVtexProducts('dia', mode);
}
