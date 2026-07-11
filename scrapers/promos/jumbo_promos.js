import axios from 'axios';

/**
 * 🏷️ Scraper de PROMOCIONES de Jumbo
 *
 * Fuente: VTEX Catalog System (REST público, server-side, sin auth).
 * Endpoint: https://www.jumbo.com.ar/api/catalog_system/pub/products/search
 *
 * Estrategia:
 *   La página /promociones de Jumbo se apoya en "clusters de highlight" de VTEX.
 *   Cada producto trae un objeto `clusterHighlights` con la forma { "<id>": "<nombre>" }.
 *   Recorremos productos (paginando con _from/_to), agrupamos por cluster id y
 *   derivamos una promoción por cada cluster distinto.
 *
 * Supuestos sobre el paginado/params de VTEX (documentados por si cambian):
 *   - Usamos búsqueda full-text con el término "promociones" (?ft=promociones)
 *     como aproximación de lo que consulta la landing. Es un endpoint público
 *     y estable; si Jumbo cambia la colección, basta ajustar QUERY_PARAMS.
 *   - VTEX limita cada página a 50 items (rango _to-_from <= 49). Paginamos de a 50.
 *   - Cap defensivo de ~200 productos (PAGE_SIZE * MAX_PAGES) para no abusar de la API.
 *   - Precios: usamos commertialOffer.Price / PriceWithoutDiscount (NUNCA ListPrice,
 *     que en VTEX/Cencosud viene con un multiplicador erróneo).
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const BASE_URL = 'https://www.jumbo.com.ar';
const SEARCH_ENDPOINT = `${BASE_URL}/api/catalog_system/pub/products/search`;

// Término full-text que aproxima la landing de promociones.
const QUERY_PARAMS = 'ft=promociones';

const PAGE_SIZE = 50; // VTEX: máximo 50 items por request (_to - _from <= 49)
const MAX_PAGES = 4; // cap defensivo → ~200 productos
const MAX_SAMPLE_PRODUCTS = 5; // productos de muestra por promoción

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Genera un slug simple a partir de un texto (sin acentos, kebab-case).
 */
function slugify(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // quitar diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * GET con 1 reintento ante error de red / timeout.
 */
async function getWithRetry(url, config, retries = 1) {
  try {
    return await axios.get(url, config);
  } catch (error) {
    const isNetwork = !error.response; // timeout / ENOTFOUND / ECONNRESET / etc.
    if (isNetwork && retries > 0) {
      console.warn(`⚠️ Error de red consultando promos Jumbo, reintentando... (${error.code || error.message})`);
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/**
 * Extrae el precio de venta de un producto VTEX desde el primer seller disponible.
 * Usa commertialOffer.Price (y PriceWithoutDiscount como fallback). Nunca ListPrice.
 */
function extractPrice(product) {
  const item = product?.items?.[0];
  const seller = item?.sellers?.find((s) => s?.sellerDefault) || item?.sellers?.[0];
  const offer = seller?.commertialOffer;
  if (!offer) return null;
  const price = offer.Price ?? offer.PriceWithoutDiscount ?? null;
  return typeof price === 'number' ? price : null;
}

/**
 * Construye un objeto "sample product" a partir de un producto VTEX.
 */
function toSampleProduct(product) {
  const item = product?.items?.[0];
  return {
    ean: item?.ean ?? null,
    id: product?.productId ?? null,
    name: product?.productName ?? null,
    price: extractPrice(product),
  };
}

/**
 * Descarga una página de productos. Devuelve [] ante cualquier problema de shape.
 */
async function fetchProductsPage(from, to) {
  const url = `${SEARCH_ENDPOINT}?${QUERY_PARAMS}&_from=${from}&_to=${to}`;
  const response = await getWithRetry(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    timeout: 20000,
    // La API devuelve 206 (Partial Content) con el header REST-Content-Range en paginados.
    validateStatus: (status) => status >= 200 && status < 300,
  });
  return Array.isArray(response.data) ? response.data : [];
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de Jumbo
 */
export async function getJumboPromotions() {
  console.log('🏷️ Iniciando scraper de promociones de Jumbo...');

  // Map<clusterId, { name, product_count, sample_products[] }>
  const promosByCluster = new Map();

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;

      let products = [];
      try {
        products = await fetchProductsPage(from, to);
      } catch (err) {
        // Un fallo de página no debe tumbar todo el scraping: logueamos y cortamos el paginado.
        console.error(`❌ Error en página ${page} (_from=${from}): ${err.message}`);
        break;
      }

      if (products.length === 0) break; // no hay más resultados

      for (const product of products) {
        // clusterHighlights: objeto { "<id>": "<nombre>" }. Puede faltar (optional chaining).
        const highlights = product?.clusterHighlights;
        if (!highlights || typeof highlights !== 'object') continue;

        for (const [clusterId, clusterName] of Object.entries(highlights)) {
          let promo = promosByCluster.get(clusterId);
          if (!promo) {
            promo = { name: clusterName, product_count: 0, sample_products: [] };
            promosByCluster.set(clusterId, promo);
          }
          promo.product_count++;
          if (promo.sample_products.length < MAX_SAMPLE_PRODUCTS) {
            promo.sample_products.push(toSampleProduct(product));
          }
        }
      }

      // Si la página vino incompleta, ya no hay más para pedir.
      if (products.length < PAGE_SIZE) break;

      // Pequeña pausa entre páginas para no saturar la API.
      if (page < MAX_PAGES - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const promotions = Array.from(promosByCluster.entries()).map(([clusterId, data]) => ({
      external_id: `jum-${clusterId}`,
      slug: slugify(`${data.name}-${clusterId}`),
      title: data.name,
      source: 'jumbo',
      product_count: data.product_count,
      sample_products: data.sample_products,
      // La API de catálogo no expone vigencia de los clusters de highlight.
      start_date: null,
      end_date: null,
    }));

    console.log(`🎉 Promociones de Jumbo derivadas: ${promotions.length}`);

    return {
      success: true,
      source: 'jumbo',
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de promociones Jumbo:', error.message);
    return {
      success: false,
      source: 'jumbo',
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
