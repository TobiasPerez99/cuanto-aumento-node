import axios from 'axios';

/**
 * 🏷️ Scraper de PROMOCIONES de Dia
 *
 * Fuente: VTEX Catalog System (REST público, server-side, sin auth ni browser).
 * Endpoint: https://diaonline.supermercadosdia.com.ar/api/catalog_system/pub/products/search
 *
 * Estrategia:
 *   La landing /especial-ofertas se arma con "product clusters" de VTEX. Se
 *   recorren las colecciones de promoción (COLLECTIONS) paginando, y se derivan
 *   promociones por dos vías complementarias:
 *
 *   1. **Teasers** (fuente primaria). El `commertialOffer.Teasers` de cada
 *      producto describe la promo multi-unidad ya estructurada: nombre ("3x2",
 *      "6x4", "2do al 70%") y `MinimumQuantity`. Es el dato más fiel: sale del
 *      motor de promociones de VTEX, no de un cartel.
 *   2. **clusterHighlights** (fuente secundaria). Cuando el producto no tiene
 *      teaser, la promo se deriva del nombre del cluster destacado, igual que
 *      hace `jumbo_promos.js`.
 *
 * ⚠️ Los ids de colección son de Dia y pueden cambiar si rearman la landing.
 * Si una colección devuelve 0 productos se loguea un warning explícito en vez
 * de fallar en silencio — un scraper que devuelve 0 sin avisar se lee como
 * "no hay promos" y es indistinguible de "se rompió".
 *
 * ⚠️ Los Teasers vienen serializados con los nombres de campo internos de .NET
 * (`<Name>k__BackingField`) en vez de `Name`. Se soportan ambas formas.
 *
 * Precios: se usa commertialOffer.Price / PriceWithoutDiscount. NUNCA ListPrice,
 * que en VTEX viene con un multiplicador erróneo (ver CLAUDE.md del scraper).
 *
 * Origen: la entrega de Prácticas Profesionalizantes de Joaquin Alodi (2026-08)
 * identificó /especial-ofertas como fuente de promociones de Dia y detectó los
 * badges 2x1/3x2/6x4. Su implementación los leía del DOM con Puppeteer y perdía
 * el EAN; acá se toman de la API pública, que expone los mismos badges como
 * Teasers estructurados y además trae el EAN de cada producto.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const BASE_URL = 'https://diaonline.supermercadosdia.com.ar';
const SEARCH_ENDPOINT = `${BASE_URL}/api/catalog_system/pub/products/search`;

/**
 * Colecciones de promoción a recorrer.
 * - 567  "Todas las Ofertas"  → ~1000 productos con descuento directo.
 * - 7220 "Hasta 2x1"          → productos con promo multi-unidad (traen Teasers).
 */
const COLLECTIONS = [
  { id: '567', label: 'Todas las Ofertas' },
  { id: '7220', label: 'Hasta 2x1' },
];

const PAGE_SIZE = 50; // VTEX: máximo 50 items por request (_to - _from <= 49)
const MAX_PAGES = 24; // cap defensivo → hasta 1200 productos por colección
const MAX_SAMPLE_PRODUCTS = 5;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Genera un slug simple (sin acentos, kebab-case).
 */
function slugify(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
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
    const isNetwork = !error.response;
    if (isNetwork && retries > 0) {
      console.warn(`⚠️ Error de red consultando promos Dia, reintentando... (${error.code || error.message})`);
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/**
 * Lee un campo de un Teaser soportando las dos formas en que VTEX lo serializa:
 * `Name` (normal) y `<Name>k__BackingField` (serialización interna de .NET).
 */
export function teaserField(teaser, field) {
  if (!teaser || typeof teaser !== 'object') return undefined;
  return teaser[`<${field}>k__BackingField`] ?? teaser[field];
}

/**
 * Extrae el nombre normalizado de un teaser (ej. "3x2 " → "3x2").
 */
export function teaserName(teaser) {
  const name = teaserField(teaser, 'Name');
  return typeof name === 'string' ? name.trim() : null;
}

/**
 * Cantidad mínima exigida por el teaser (ej. 3 para un 3x2), o null.
 */
export function teaserMinimumQuantity(teaser) {
  const conditions = teaserField(teaser, 'Conditions');
  const min = teaserField(conditions, 'MinimumQuantity');
  return Number.isFinite(min) ? min : null;
}

/**
 * Devuelve la oferta comercial del seller por defecto (o el primero).
 */
function commercialOffer(product) {
  const item = product?.items?.[0];
  const seller = item?.sellers?.find((s) => s?.sellerDefault) || item?.sellers?.[0];
  return seller?.commertialOffer ?? null;
}

/**
 * Precio de venta. Nunca ListPrice (multiplicador erróneo en VTEX).
 */
function extractPrice(product) {
  const offer = commercialOffer(product);
  if (!offer) return null;
  const price = offer.Price ?? offer.PriceWithoutDiscount ?? null;
  return typeof price === 'number' ? price : null;
}

/**
 * Precio sin descuento (el "tachado"), para poder calcular el ahorro.
 */
function extractListPrice(product) {
  const offer = commercialOffer(product);
  if (!offer) return null;
  const price = offer.PriceWithoutDiscount ?? null;
  return typeof price === 'number' ? price : null;
}

/**
 * Construye el "sample product" de una promoción.
 * A diferencia de jumbo_promos.js, incluye el EAN: es la PK del catálogo y
 * permite cruzar la promoción con los productos que ya scrapea diaonline.js.
 */
export function toSampleProduct(product) {
  const item = product?.items?.[0];
  return {
    ean: item?.ean ?? null,
    id: product?.productId ?? null,
    name: product?.productName ?? null,
    brand: product?.brand ?? null,
    price: extractPrice(product),
    list_price: extractListPrice(product),
  };
}

/**
 * Agrupa productos en promociones.
 *
 * Función pura (sin red): es la parte unit-testeable.
 *
 * @param {Array} products      productos crudos de la API de VTEX
 * @param {Map}   promosByKey   acumulador entre páginas/colecciones
 */
export function collectPromotions(products, promosByKey = new Map()) {
  for (const product of products) {
    const offer = commercialOffer(product);
    const teasers = Array.isArray(offer?.Teasers) ? offer.Teasers : [];

    let matched = false;

    // 1) Teasers: la promo tal como la define el motor de VTEX.
    for (const teaser of teasers) {
      const name = teaserName(teaser);
      if (!name) continue;

      matched = true;
      const key = `teaser:${name.toLowerCase()}`;

      let promo = promosByKey.get(key);
      if (!promo) {
        promo = {
          key,
          kind: 'teaser',
          title: name,
          minimum_quantity: teaserMinimumQuantity(teaser),
          product_count: 0,
          sample_products: [],
        };
        promosByKey.set(key, promo);
      }

      promo.product_count++;
      if (promo.sample_products.length < MAX_SAMPLE_PRODUCTS) {
        promo.sample_products.push(toSampleProduct(product));
      }
    }

    if (matched) continue;

    // 2) clusterHighlights: objeto { "<id>": "<nombre>" }.
    const highlights = product?.clusterHighlights;
    if (!highlights || typeof highlights !== 'object') continue;

    for (const [clusterId, clusterName] of Object.entries(highlights)) {
      const key = `cluster:${clusterId}`;

      let promo = promosByKey.get(key);
      if (!promo) {
        promo = {
          key,
          kind: 'cluster',
          cluster_id: clusterId,
          title: clusterName,
          minimum_quantity: null,
          product_count: 0,
          sample_products: [],
        };
        promosByKey.set(key, promo);
      }

      promo.product_count++;
      if (promo.sample_products.length < MAX_SAMPLE_PRODUCTS) {
        promo.sample_products.push(toSampleProduct(product));
      }
    }
  }

  return promosByKey;
}

/**
 * Convierte el acumulador interno al contrato de promoción que consume
 * `App\Services\PromotionsProviders\DiaService`.
 */
export function toPromotionContract(promo) {
  const externalId =
    promo.kind === 'teaser'
      ? `dia-t-${slugify(promo.title)}`
      : `dia-c-${promo.cluster_id}`;

  return {
    external_id: externalId,
    slug: slugify(`${promo.title}-${promo.cluster_id ?? promo.kind}`),
    title: promo.title,
    source: 'dia',
    promotion_kind: promo.kind,
    minimum_quantity: promo.minimum_quantity,
    product_count: promo.product_count,
    sample_products: promo.sample_products,
    // El catálogo no expone vigencia de colecciones ni de teasers.
    start_date: null,
    end_date: null,
  };
}

/**
 * Descarga una página de productos de una colección.
 */
async function fetchCollectionPage(collectionId, from, to) {
  const url = `${SEARCH_ENDPOINT}?fq=productClusterIds:${collectionId}&_from=${from}&_to=${to}`;

  const response = await getWithRetry(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    timeout: 20000,
    // VTEX devuelve 206 (Partial Content) en los paginados.
    validateStatus: (status) => status >= 200 && status < 300,
  });

  return Array.isArray(response.data) ? response.data : [];
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de Dia
 */
export async function getDiaPromotions() {
  console.log('🏷️ Iniciando scraper de promociones de Dia...');

  const promosByKey = new Map();

  try {
    for (const collection of COLLECTIONS) {
      let seen = 0;

      for (let page = 0; page < MAX_PAGES; page++) {
        const from = page * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;

        let products = [];
        try {
          products = await fetchCollectionPage(collection.id, from, to);
        } catch (err) {
          console.error(
            `❌ Error en colección ${collection.id} (${collection.label}), página ${page}: ${err.message}`
          );
          break;
        }

        if (products.length === 0) break;

        seen += products.length;
        collectPromotions(products, promosByKey);

        if (products.length < PAGE_SIZE) break;

        await new Promise((r) => setTimeout(r, 200));
      }

      if (seen === 0) {
        // Ver comentario de cabecera: 0 productos casi siempre significa que el
        // id de colección cambió, no que Dia se quedó sin ofertas.
        console.warn(
          `⚠️ La colección ${collection.id} ("${collection.label}") no devolvió productos. ` +
            'Puede que Dia haya cambiado el id de la landing de ofertas.'
        );
      } else {
        console.log(`   Colección ${collection.id} (${collection.label}): ${seen} productos`);
      }
    }

    const promotions = Array.from(promosByKey.values()).map(toPromotionContract);

    console.log(`🎉 Promociones de Dia derivadas: ${promotions.length}`);

    return {
      success: true,
      source: 'dia',
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de promociones Dia:', error.message);

    return {
      success: false,
      source: 'dia',
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
