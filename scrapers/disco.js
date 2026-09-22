import { scrapeVtexProducts } from '../cores/vtexProducts.js';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Disco (MAESTRO)
 *
 * Recorre el catálogo REST de VTEX (ver `cores/vtexProducts.js` y
 * `cores/vtexCatalog.js`). Modos: `categories` (default), `eans` y `search`
 * (la búsqueda de texto de GraphQL, como vuelta atrás).
 */
export async function getDiscoMainProducts(mode = 'categories') {
  return scrapeVtexProducts('disco', mode);
}
