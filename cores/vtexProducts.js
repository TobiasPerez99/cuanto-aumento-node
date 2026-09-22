import { scrapeVtexMerchant } from './vtex.js';
import { scrapeVtexCatalog } from './vtexCatalog.js';
import { saveMasterProduct, saveFollowerProduct } from './saveHandlers.js';
import { DETAILED_CATEGORIES, getCategories, productEans } from './categories.js';

/**
 * Los 7 comercios VTEX de productos y cómo se recorre cada uno.
 *
 * `salesChannel` es el canal que publicaba cada tienda en `/api/segments` el
 * 2026-09-22. Es sólo el RESPALDO: el recorrido lo vuelve a leer de la tienda en
 * cada corrida (ver `resolveSalesChannel`). Disco, Jumbo y Vea comparten el mismo
 * catálogo y lo único que separa sus precios es este número.
 *
 * `legacyTerms` es la lista de términos del modo `search` (el camino viejo de
 * GraphQL). Jumbo la pedía a la API central; el resto usa la lista fija.
 */
export const VTEX_MERCHANTS = {
  disco: { merchantName: 'Disco', baseUrl: 'https://www.disco.com.ar', salesChannel: 33, master: true },
  carrefour: { merchantName: 'Carrefour', baseUrl: 'https://www.carrefour.com.ar', salesChannel: 1 },
  jumbo: { merchantName: 'Jumbo', baseUrl: 'https://www.jumbo.com.ar', salesChannel: 32, legacyTerms: getCategories },
  vea: { merchantName: 'Vea', baseUrl: 'https://www.vea.com.ar', salesChannel: 34 },
  dia: { merchantName: 'Dia', baseUrl: 'https://diaonline.supermercadosdia.com.ar', salesChannel: 1 },
  masonline: { merchantName: 'Masonline', baseUrl: 'https://www.masonline.com.ar', salesChannel: 1 },
  farmacity: { merchantName: 'Farmacity', baseUrl: 'https://www.farmacity.com', salesChannel: 4 },
};

/**
 * Qué corrida hacer para un comercio y un modo.
 *
 *   categories (default) → recorrer el catálogo REST entero (`cores/vtexCatalog.js`)
 *   eans                 → los EANs de PRODUCT_EANS, por el mismo catálogo REST
 *   search               → la búsqueda de texto de `productSuggestions` sobre la lista
 *                          de términos: el camino anterior, que quedó como vuelta
 *                          atrás desde el backoffice (`scrapper.schedule_mode`) por si
 *                          el WAF empieza a bloquear el catálogo REST. Necesita
 *                          VTEX_SHA256_HASH.
 *
 * Un modo desconocido recorre el catálogo: antes cualquier cosa que no fuera `eans`
 * recorría las categorías.
 *
 * `overrides` pisa opciones de la corrida (p. ej. `onProductFound: null` para una
 * corrida en seco, o `httpGet` en tests). En `search` sólo se puede pisar el handler:
 * el core de GraphQL no inyecta red ni base, y aceptar el resto en silencio haría
 * creer que una "corrida en seco" de ese modo no escribe.
 */
export async function resolveVtexRun(key, mode = 'categories', overrides = {}) {
  const config = VTEX_MERCHANTS[key];
  if (!config) throw new Error(`No hay comercio VTEX de productos con clave "${key}"`);

  const onProductFound = config.master ? saveMasterProduct : saveFollowerProduct;

  if (mode === 'search') {
    return {
      strategy: 'search',
      options: {
        merchantName: config.merchantName,
        baseUrl: config.baseUrl,
        categories: config.legacyTerms ? await config.legacyTerms() : DETAILED_CATEGORIES,
        onProductFound: 'onProductFound' in overrides ? overrides.onProductFound : onProductFound,
        count: 50,
      },
    };
  }

  return {
    strategy: 'catalog',
    options: {
      merchantName: config.merchantName,
      baseUrl: config.baseUrl,
      salesChannel: config.salesChannel,
      onlyAvailable: true,
      // El maestro es dueño de la metadata del catálogo: sin imagen no se crea el
      // producto, igual que en el camino de GraphQL. Un follower sólo escribe precio.
      requireImage: Boolean(config.master),
      onProductFound,
      mode: mode === 'eans' ? 'eans' : 'categories',
      eans: productEans,
      ...overrides,
    },
  };
}

/**
 * El resultado de una corrida de `search`, declarado incompleto.
 *
 * La búsqueda de texto es el top 50 de cada término: nunca recorre el catálogo. Si
 * Laravel la tomara por completa (un resultado sin `complete` cuenta como completo),
 * activar la vuelta atrás encendería el vencimiento sobre todo lo que la búsqueda no
 * ve, y a la tercera corrida lo escondería.
 */
export function markSearchResult(result) {
  return { ...result, strategy: 'search', mode: 'search', complete: false, incompleteReasons: ['search_mode'] };
}

/** Corre los productos de un comercio VTEX. Nunca lanza: devuelve `{ success, ... }`. */
export async function scrapeVtexProducts(key, mode = 'categories', overrides = {}) {
  const { strategy, options } = await resolveVtexRun(key, mode, overrides);
  return strategy === 'search'
    ? markSearchResult(await scrapeVtexMerchant(options))
    : scrapeVtexCatalog(options);
}
