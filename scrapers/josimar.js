import axios from 'axios';
import { getMerchantId } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { productEans } from '../cores/categories.js';

/**
 * 🛒 Scraper de PRODUCTOS de Josimar (FOLLOWER)
 *
 * Josimar (www.josimar.com.ar, cuenta VTEX `arjosimarprod`) es una cadena del
 * sur del GBA — Lanús, Lomas de Zamora, Avellaneda, Quilmes, Berazategui,
 * Monte Grande y Barracas — fundada en 1964. Es un comercio NUEVO del proyecto.
 *
 * Fuente: VTEX **Catalog System REST** (público, sin auth, sin browser):
 *   GET /api/catalog_system/pub/category/tree/3      → árbol de categorías
 *   GET /api/catalog_system/pub/products/search?fq=C:/{categoryId}/&_from=&_to=
 *
 * ⚠️ NO usa `cores/vtex.js`. Ese core resuelve el catálogo con la query GraphQL
 * `productSuggestions` (búsqueda full-text por nombre de categoría) y su
 * `normalizeProduct()` exige `rawProduct.priceRange`, campo que el Catalog
 * System REST no devuelve. Adaptar el core para soportar recorrido por
 * categoryId numérico obligaría a tocar el camino que comparten los otros 7
 * comercios VTEX; se prefirió que Josimar traiga su propio recorrido, que es
 * además el que su paginación obliga (ver abajo).
 *
 * ⚠️ **Por qué recorrer por categoría y no paginar el catálogo plano**: la API
 * responde HTTP 400 (Parameter _from can not be greater than 2500) en cuanto se
 * pide `_from > 2500`. El catálogo son 5691 productos, o sea que NO entra en una
 * sola ventana, pero sí entra departamento por departamento: el más grande es
 * Almacén (id 1) con 2260 productos, holgadamente por debajo del tope. Igual el
 * recorrido es **adaptativo**: si un departamento supera la ventana se baja a
 * sus hijos recursivamente, para que el día que Josimar cargue 300 productos más
 * de almacén el scraper no empiece a perder la cola en silencio (que es
 * exactamente lo que pasaría con una lista fija de 14 ids).
 *
 * ⚠️ **El recorrido por departamento NO cubre el 100% del catálogo, y la
 * paginación no es la culpable.** Los headers `resources` dan 5691 para la
 * búsqueda sin `fq`, contra 5663 sumando los 14 departamentos de
 * `category/tree/3`: hay **~28 productos que no cuelgan de ningún departamento**
 * (categoría inactiva o fuera del árbol) y que ninguna consulta `fq=C:/{id}/`
 * puede alcanzar. Dentro de cada categoría no se pierde nada — una corrida
 * completa recorre los 5663 crudos exactos y deja 5633 EANs únicos (3 descartados
 * por no tener precio, 27 EANs repetidos entre categorías). Es ~0,5% del catálogo
 * y son precios de un follower, así que se convive con eso; lo que NO hay que
 * hacer es repetir que el recorrido cubre el catálogo entero, porque comparar los
 * 5663 recorridos contra los 5663 de la suma es circular: mide la paginación, no
 * la cobertura. La referencia honesta es el 5691 del catálogo plano.
 *
 * ⚠️ **El precio de Josimar es casi siempre chain-wide, pero NO siempre.**
 * La cadena expone un sales channel por tienda con venta online
 * (`sc=1` Berazategui, `3` Pringles, `5` Barracas, `6` Colombres, `11` Quilmes)
 * y el `Price` del mismo EAN puede diferir entre ellos. Medición sobre 140 EANs
 * (los 10 primeros de cada uno de los 14 departamentos), consultando los 5
 * canales: **2 de 140 (1,4%) con precios distintos**, y no por centavos —
 * Coca Cola 2.25 lt sale 4930 en Pringles/Barracas/Colombres y 5800 en
 * Berazategui/Quilmes (spread 15%), y la Zero 2.2 lt 4350 contra 5800
 * (spread 25%). Lo que varía con más frecuencia es la DISPONIBILIDAD: hay EANs
 * que directamente no existen en algunos canales (la Zero no aparece en `sc=11`).
 *
 * ⚠️ **Consecuencia para el comparador, y decisión de diseño PENDIENTE.** Este
 * scraper pide el catálogo SIN `sc`, o sea el canal por defecto de la cuenta, y
 * en los dos casos medidos ese precio por defecto resultó ser el MÁS BARATO de
 * los cinco (4930 y 4350). O sea: hoy Josimar publica en `merchant_products` un
 * precio que en 2 de sus 5 tiendas el cliente no paga — la misma clase de
 * problema que BUG-073 en Coto, aunque a una escala muchísimo menor (1,4% del
 * catálogo contra el 94% de las filas de Coto).
 *
 * Mientras tanto Josimar usa `saveFollowerProduct` (una fila en
 * `merchant_products`, precio único de cadena) y **NO** el camino de
 * `saveCotoProduct` / `merchant_store_prices`, y no entra al
 * `StorePricingRegistry` de Laravel. Migrarlo a precio por sucursal es una
 * decisión de producto (implica 5× requests, mirror en `merchant_store_prices`,
 * banda de plausibilidad y selector de tienda para 5 de sus 9 sucursales — las
 * otras 4 no tienen canal propio), no una corrección: queda anotada acá para que
 * se tome con el dato a la vista, y no dada por resuelta con un "no varía".
 *
 * ⚠️ Josimar es FOLLOWER: nunca crea productos. El maestro del catálogo es
 * Disco; los EANs que no estén en `products` se descartan con `not_in_master`.
 *
 * EAN: el 100% del catálogo trae `items[0].ean` válido, y un solo SKU por
 * producto. Es el dato crítico — `products.ean` es la PK del catálogo de
 * Ahorrapp, y sin EAN el producto no se puede cruzar con el maestro.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const BASE_URL = 'https://www.josimar.com.ar';
const SEARCH_ENDPOINT = `${BASE_URL}/api/catalog_system/pub/products/search`;
const CATEGORY_TREE_ENDPOINT = `${BASE_URL}/api/catalog_system/pub/category/tree/3`;

/** VTEX exige `_to - _from <= 49`, o sea 50 items por request como máximo. */
const PAGE_SIZE = 50;

/**
 * Tope duro de la API: un `_from` mayor a esto devuelve HTTP 400. Es el número
 * que obliga al recorrido por categoría y el umbral del descenso adaptativo.
 */
const MAX_FROM = 2500;

/** Cap defensivo de nodos a recorrer: el árbol completo son 454. */
const MAX_CATEGORY_NODES = 500;

/** EANs por request en modo `eans` (varios `fq` del mismo campo son un OR). */
const EAN_BATCH_SIZE = 25;

/** Pausa entre requests para no saturar la API. Mismo criterio que el core VTEX. */
const REQUEST_DELAY_MS = 200;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const REQUEST_CONFIG = {
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  timeout: 20000,
};

/**
 * GET con 1 reintento ante error de red / timeout.
 * No reintenta ante respuesta HTTP: un 400 por `_from` fuera de rango o un 404
 * no se arreglan repitiendo, y reintentarlos sólo esconde el problema.
 */
async function getWithRetry(url, config = REQUEST_CONFIG, retries = 1) {
  try {
    return await axios.get(url, config);
  } catch (error) {
    const isNetwork = !error.response;
    if (isNetwork && retries > 0) {
      console.warn(
        `⚠️ Error de red consultando el catálogo de Josimar, reintentando... (${error.code || error.message})`
      );
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------------ *
 *  Funciones PURAS (sin red) — es lo que se testea con fixtures              *
 * ------------------------------------------------------------------------ */

/**
 * Extrae el total de resultados del header `resources` de VTEX ("0-49/2260").
 * Devuelve null si el header falta o no es parseable: nunca inventa un total,
 * porque un total inventado se traduce en páginas que no se piden.
 */
export function parseResourcesTotal(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/\/(\d+)\s*$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

/**
 * Aplana el árbol de categorías a la lista de departamentos de nivel 1,
 * conservando sus hijos para el descenso adaptativo.
 */
export function topLevelCategories(tree) {
  if (!Array.isArray(tree)) return [];
  return tree
    .filter((node) => node && node.id != null)
    .map((node) => ({
      id: String(node.id),
      name: node.name ?? null,
      children: Array.isArray(node.children) ? node.children : [],
    }));
}

/**
 * Oferta comercial del seller por defecto (o el primero).
 * Josimar tiene un único seller ("Josimar SA", sellerId 1), pero se resuelve
 * igual por `sellerDefault` para no depender de ese detalle.
 */
function commercialOffer(item) {
  const seller = item?.sellers?.find((s) => s?.sellerDefault) || item?.sellers?.[0];
  return seller?.commertialOffer ?? null;
}

/**
 * Normaliza un producto crudo del Catalog System al formato que consumen los
 * save handlers (el mismo que emite `normalizeProduct()` de `cores/vtex.js`).
 *
 * Devuelve `null` cuando el producto no sirve. Los dos motivos de descarte:
 *   - sin EAN → no se puede cruzar con el maestro (`products.ean` es la PK).
 *   - sin precio positivo → escribirlo pondría a Josimar como "el más barato"
 *     de todo el comparador con un $0. Un producto menos es mucho mejor que un
 *     precio falso.
 *
 * ⚠️ A diferencia de `normalizeProduct()` del core, acá **no** se exige imagen.
 * El core descarta el producto sin imágenes porque nació para Disco, que es el
 * MAESTRO y es dueño de la metadata. Josimar es follower: `saveFollowerProduct`
 * sólo escribe precio/disponibilidad/URL y ni siquiera mira las imágenes, así
 * que descartar por falta de imagen tiraría un precio válido a la basura. En la
 * práctica el 100% del catálogo trae imagen; el criterio importa el día que no.
 *
 * ⚠️ NUNCA se usa `ListPrice`: en VTEX viene con un multiplicador erróneo
 * (documentado en el CLAUDE.md del scraper). El precio "tachado" correcto es
 * `PriceWithoutDiscount`.
 *
 * Función pura: es la parte unit-testeable, sin red.
 */
export function normalizeJosimarProduct(rawProduct, baseUrl = BASE_URL) {
  const item = rawProduct?.items?.[0];
  if (!item) return null;

  const ean = typeof item.ean === 'string' ? item.ean.trim() : null;
  if (!ean) return null;

  const offer = commercialOffer(item);
  const price = Number(offer?.Price);
  if (!Number.isFinite(price) || price <= 0) return null;

  const withoutDiscount = Number(offer?.PriceWithoutDiscount);
  const listPrice =
    Number.isFinite(withoutDiscount) && withoutDiscount > 0 ? withoutDiscount : price;

  const images = Array.isArray(item.images)
    ? item.images.map((img) => img?.imageUrl).filter(Boolean)
    : [];

  // Precio de referencia (ej: precio por litro). `unitMultiplier` es 1 para la
  // mayoría del catálogo, en cuyo caso coincide con el precio de venta.
  const multiplier = Number(item.unitMultiplier);
  const referencePrice =
    Number.isFinite(multiplier) && multiplier > 0 ? price / multiplier : null;

  // `IsAvailable` es el flag explícito de VTEX; `AvailableQuantity` es el
  // respaldo por si el flag no viniera en la respuesta.
  const isAvailable =
    typeof offer?.IsAvailable === 'boolean'
      ? offer.IsAvailable
      : Number(offer?.AvailableQuantity) > 0;

  return {
    ean,
    external_id: rawProduct?.productId != null ? String(rawProduct.productId) : null,
    source: 'josimar',
    name: rawProduct?.productName ?? null,
    // El Catalog System ya devuelve el link absoluto; `linkText` es el respaldo.
    link:
      rawProduct?.link ?? (rawProduct?.linkText ? `${baseUrl}/${rawProduct.linkText}/p` : null),
    image: images[0] ?? null,
    images,
    price,
    list_price: listPrice,
    reference_price: referencePrice,
    reference_unit: item.measurementUnit ?? null,
    is_available: isAvailable,
    brand: rawProduct?.brand ?? null,
    categories: Array.isArray(rawProduct?.categories) ? rawProduct.categories : [],
    description: rawProduct?.description ?? null,
    unavailable: !isAvailable, // deprecado, se mantiene por compat con el core
  };
}

/**
 * Normaliza un lote crudo descartando los que no pasan el filtro.
 * Función pura: unit-testeable con un fixture.
 */
export function normalizeJosimarProducts(rawProducts, baseUrl = BASE_URL) {
  if (!Array.isArray(rawProducts)) return [];
  return rawProducts
    .map((raw) => normalizeJosimarProduct(raw, baseUrl))
    .filter((product) => product !== null);
}

/* ------------------------------------------------------------------------ *
 *  Capa de red                                                              *
 * ------------------------------------------------------------------------ */

/**
 * Una página de una categoría. Devuelve `{ products, total }`.
 * `total` sale del header `resources` (ver `parseResourcesTotal`).
 */
async function fetchCategoryPage(categoryId, from) {
  const to = from + PAGE_SIZE - 1;
  const url = `${SEARCH_ENDPOINT}?fq=C:/${categoryId}/&_from=${from}&_to=${to}`;
  const response = await getWithRetry(url);

  return {
    products: Array.isArray(response.data) ? response.data : [],
    total: parseResourcesTotal(response.headers?.resources),
  };
}

/**
 * Cantidad de productos de una categoría, con el request más barato posible
 * (una sola fila). Se usa para decidir si la categoría entra en la ventana de
 * paginación o hay que bajar a sus hijos.
 */
async function fetchCategoryTotal(categoryId) {
  const url = `${SEARCH_ENDPOINT}?fq=C:/${categoryId}/&_from=0&_to=0`;
  const response = await getWithRetry(url);
  return parseResourcesTotal(response.headers?.resources);
}

/**
 * Resuelve la lista de categorías a recorrer.
 *
 * Arranca por los departamentos de nivel 1 y **baja a los hijos sólo cuando el
 * departamento no entra en la ventana de `_from <= 2500`**. Hoy ningún
 * departamento la supera (el mayor, Almacén, tiene 2260), así que el resultado
 * son los 14 departamentos y 14 requests; el descenso existe para que el
 * catálogo pueda crecer sin que el scraper empiece a truncar en silencio.
 *
 * Un total desconocido (header ausente) se trata como "entra": es preferible
 * pedir de más y que la paginación corte sola por página vacía, a saltear la
 * categoría entera.
 */
async function resolveCategoryTargets(nodes, acc = []) {
  for (const node of nodes) {
    if (acc.length >= MAX_CATEGORY_NODES) {
      console.warn(
        `⚠️ Tope de ${MAX_CATEGORY_NODES} categorías alcanzado; el recorrido puede quedar corto.`
      );
      return acc;
    }

    const total = await fetchCategoryTotal(node.id);
    await sleep(REQUEST_DELAY_MS);

    const children = Array.isArray(node.children) ? node.children : [];
    const fitsInWindow = total === null || total <= MAX_FROM;

    if (fitsInWindow || children.length === 0) {
      if (!fitsInWindow) {
        // Hoja que no entra en la ventana: no hay a dónde bajar. Se avisa
        // fuerte porque desde acá el scraper SÍ pierde productos.
        console.warn(
          `⚠️ La categoría hoja ${node.id} ("${node.name}") tiene ${total} productos y la API corta en ${MAX_FROM}: quedan ${total - MAX_FROM} sin scrapear.`
        );
      }
      acc.push({ id: node.id, name: node.name, total });
      continue;
    }

    console.log(
      `   ↳ "${node.name}" (${node.id}) tiene ${total} productos (> ${MAX_FROM}): bajando a sus ${children.length} subcategorías`
    );

    await resolveCategoryTargets(
      children.map((c) => ({
        id: String(c.id),
        name: c.name ?? null,
        children: Array.isArray(c.children) ? c.children : [],
      })),
      acc
    );
  }

  return acc;
}

/**
 * Recorre una categoría paginando hasta agotarla (o hasta el tope de la API).
 * Llama `onBatch` con los productos crudos de cada página.
 */
async function walkCategory(target, onBatch) {
  let from = 0;
  let fetched = 0;

  while (from <= MAX_FROM) {
    const { products, total } = await fetchCategoryPage(target.id, from);
    if (products.length === 0) break;

    await onBatch(products);
    fetched += products.length;

    const knownTotal = total ?? target.total;
    if (knownTotal != null && from + products.length >= knownTotal) break;
    if (products.length < PAGE_SIZE) break;

    from += PAGE_SIZE;

    if (from > MAX_FROM) {
      console.warn(
        `⚠️ Categoría ${target.id} ("${target.name}") alcanzó el tope de _from=${MAX_FROM}; el resto queda sin scrapear.`
      );
      break;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return fetched;
}

/**
 * Recorrido en modo `eans`: consulta EANs puntuales en lotes.
 * Varios `fq=alternateIds_Ean:` en la misma URL funcionan como OR en VTEX.
 */
async function walkEans(eans, onBatch) {
  let fetched = 0;

  for (let i = 0; i < eans.length; i += EAN_BATCH_SIZE) {
    const batch = eans.slice(i, i + EAN_BATCH_SIZE);
    const query = batch
      .map((ean) => `fq=alternateIds_Ean:${encodeURIComponent(ean)}`)
      .join('&');
    const url = `${SEARCH_ENDPOINT}?${query}&_from=0&_to=${PAGE_SIZE - 1}`;

    const response = await getWithRetry(url);
    const products = Array.isArray(response.data) ? response.data : [];

    if (products.length > 0) {
      await onBatch(products);
      fetched += products.length;
    }

    if (i + EAN_BATCH_SIZE < eans.length) await sleep(REQUEST_DELAY_MS);
  }

  return fetched;
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Productos de Josimar (FOLLOWER)
 *
 * @param {'categories'|'eans'} mode
 * @param {Object}   [options]
 * @param {string[]} [options.categoryIds]     recorrer sólo estas categorías (corridas acotadas).
 * @param {Function|null} [options.onProductFound] handler de guardado; `null` = corrida en seco,
 *                        sin tocar la base (verificar la fuente sin escribir precios).
 */
export async function getJosimarMainProducts(mode = 'categories', options = {}) {
  const { categoryIds = null, onProductFound = saveFollowerProduct } = options;

  console.log(`🛒 Iniciando scraper de productos de Josimar [modo: ${mode}]...`);

  try {
    let merchantId = null;
    if (onProductFound) {
      merchantId = await getMerchantId('Josimar');
      if (!merchantId) {
        throw new Error('No se pudo obtener el ID del comercio Josimar');
      }
    } else {
      console.warn('⚠️ Corrida en seco: no se guarda nada en la base.');
    }

    // Dedupe global: un producto puede aparecer en más de una categoría.
    const seenEans = new Set();
    let savedCount = 0;
    let skippedCount = 0;
    let discardedCount = 0;
    let rawCount = 0;

    const handleBatch = async (rawProducts) => {
      rawCount += rawProducts.length;

      for (const raw of rawProducts) {
        const product = normalizeJosimarProduct(raw, BASE_URL);

        if (!product) {
          discardedCount++;
          continue;
        }
        if (seenEans.has(product.ean)) continue;
        seenEans.add(product.ean);

        if (!merchantId || !onProductFound) continue;

        const result = await onProductFound(product, merchantId);
        if (result === true || result?.saved === true) {
          savedCount++;
        } else if (result?.reason === 'not_in_master') {
          skippedCount++;
        }
      }
    };

    let visitedCategories = 0;

    if (mode === 'eans') {
      if (productEans.length === 0) {
        throw new Error('Modo "eans" sin EANs: definí PRODUCT_EANS en el entorno');
      }
      console.log(`🔎 Consultando ${productEans.length} EANs puntuales`);
      await walkEans(productEans, handleBatch);
    } else {
      let targets;

      if (categoryIds && categoryIds.length > 0) {
        // Corrida acotada: se respetan las categorías pedidas tal cual.
        targets = categoryIds.map((id) => ({ id: String(id), name: null, total: null }));
        console.log(
          `📋 Corrida acotada a ${targets.length} categorías: ${targets.map((t) => t.id).join(', ')}`
        );
      } else {
        const treeResponse = await getWithRetry(CATEGORY_TREE_ENDPOINT);
        const departments = topLevelCategories(treeResponse.data);

        if (departments.length === 0) {
          throw new Error('El árbol de categorías vino vacío');
        }

        console.log(`🗂️  ${departments.length} departamentos de nivel 1`);
        targets = await resolveCategoryTargets(departments);
        console.log(`📋 ${targets.length} categorías a recorrer`);
      }

      for (const target of targets) {
        visitedCategories++;
        const label = target.name ? `${target.name} (${target.id})` : target.id;
        console.log(`[${visitedCategories}/${targets.length}] 🔍 Categoría: ${label}`);

        const fetched = await walkCategory(target, handleBatch);
        console.log(`   ✅ ${fetched} productos recorridos (${seenEans.size} únicos acumulados)`);

        await sleep(REQUEST_DELAY_MS);
      }
    }

    const totalProducts = seenEans.size;

    console.log('\n🎉 Scraping completado para Josimar:');
    console.log(`   📊 Productos únicos encontrados: ${totalProducts}`);
    console.log(`   💾 Guardados en DB: ${savedCount}`);
    if (skippedCount > 0) console.log(`   ⏭️ Ignorados (no están en el maestro): ${skippedCount}`);
    if (discardedCount > 0) console.log(`   🗑️ Descartados (sin EAN o sin precio): ${discardedCount}`);

    return {
      success: true,
      source: 'josimar',
      totalProducts,
      savedProducts: savedCount,
      skippedProducts: skippedCount,
      discardedProducts: discardedCount,
      rawProducts: rawCount,
      visitedCategories,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de productos Josimar:', error.message);

    return {
      success: false,
      source: 'josimar',
      totalProducts: 0,
      savedProducts: 0,
      products: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
