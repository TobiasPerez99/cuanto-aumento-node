import axios from 'axios';
import { prisma } from '../config/prisma.js';
/**
 * Obtiene o crea el ID del supermercado
 */
async function getMerchantId(name) {
  try {
    // Find or create merchant (atomic operation)
    const merchant = await prisma.merchant.upsert({
      where: { name },
      update: {}, // No updates needed if exists
      create: { name, cuit: null, slug: null },
      select: { id: true },
    });

    return merchant.id;
  } catch (error) {
    console.error('Error creating/finding merchant:', error);
    return null;
  }
}
/**
 * Función genérica para scrapear un supermercado VTEX
 * @param {Object} config - Configuración del scraper
 * @param {string} config.merchantName - Nombre del supermercado (ej: 'Disco')
 * @param {string} config.baseUrl - URL base (ej: 'https://www.disco.com.ar')
 * @param {string[]} config.categories - Lista de categorías a buscar
 * @param {Function} config.onProductFound - Callback async (product, merchantId) => { saved: boolean, reason?: string }
 * @param {number} [config.count=50] - Cantidad de productos a buscar por query (default: 50)
 */
export async function scrapeVtexMerchant({ merchantName, baseUrl, categories, onProductFound, count = 50 }) {
  const sourceName = merchantName.toLowerCase();
  console.log(`🛒 Iniciando scraper para ${merchantName}...`);
  
  // Obtener ID del supermercado
  let merchantId = null;
  if (prisma) {
    merchantId = await getMerchantId(merchantName);
    if (!merchantId) {
      return { success: false, error: `No se pudo obtener el ID del supermercado ${merchantName}` };
    }
  } else {
    console.warn('⚠️ Prisma no disponible. Saltando guardado en DB.');
  }
  console.log(`📋 Buscando en ${categories.length} categorías`);
  
  const allProducts = new Map();
  let successfulQueries = 0;
  let savedCount = 0;
  let skippedCount = 0; // Para contar productos ignorados (ej: no en maestro)
  let aborted = null;   // Si fetchVtexProducts decide abortar, guardamos el diagnóstico

  for (let i = 0; i < categories.length; i++) {
    const category = categories[i];
    console.log(`[${i+1}/${categories.length}] 🔍 Categoría: "${category}"`);

    let products = [];
    try {
      products = await fetchVtexProducts(baseUrl, category, sourceName, count);
    } catch (err) {
      if (err.vtexAbort) {
        console.error(`🛑 Abortando scraper de ${merchantName}: ${err.message}`);
        aborted = err;
        break;
      }
      throw err;
    }

    if (products.length > 0) {
      for (const product of products) {
        if (!allProducts.has(product.ean)) {
          allProducts.set(product.ean, product);
          
          // Ejecutar lógica específica de guardado si hay conexión
          if (merchantId && onProductFound) {
            const result = await onProductFound(product, merchantId);
            if (result === true || result?.saved === true) {
              savedCount++;
            } else if (result?.reason === 'not_in_master') {
              skippedCount++;
            }
          }
        }
      }
      
      console.log(`   ✅ ${products.length} productos encontrados`);
      successfulQueries++;
    } else {
      console.log(`   ❌ Sin resultados`);
    }
    
    // Pequeña pausa para no saturar
    if (i < categories.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  const uniqueProducts = Array.from(allProducts.values());
  console.log(`\n🎉 Scraping completado para ${merchantName}:`);
  console.log(`   📊 Total productos únicos encontrados: ${uniqueProducts.length}`);
  console.log(`   💾 Operaciones exitosas en DB: ${savedCount}`);
  console.log(`   ✅ Queries exitosas: ${successfulQueries}/${categories.length}`);
  if (skippedCount > 0) {
    console.log(`   ⏭️ Ignorados (ej: no en maestro): ${skippedCount}`);
  }
  if (aborted) {
    console.log(`   🛑 Scraper abortado: ${aborted.diag?.kind} — ${aborted.diag?.hint}`);
  }
  return {
    success: !aborted,
    aborted: aborted ? { kind: aborted.diag?.kind, hint: aborted.diag?.hint, message: aborted.message } : null,
    source: sourceName,
    totalProducts: uniqueProducts.length,
    savedProducts: savedCount,
    skippedProducts: skippedCount,
    successfulQueries,
    totalQueries: categories.length,
    timestamp: new Date().toISOString(),
    products: uniqueProducts
  };
}
// Hash VTEX desde variables de entorno
const VTEX_SHA256_HASH = process.env.VTEX_SHA256_HASH;
if (!VTEX_SHA256_HASH) {
  throw new Error('❌ VTEX_SHA256_HASH no está configurado en las variables de entorno');
}
/**
 * Codifica una cadena a Base64
 */
function encodeBase64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}
/**
 * Codifica una cadena para URL
 */
function encodeUrl(str) {
  return encodeURIComponent(str);
}
/**
 * Genera las variables para la query de VTEX
 */
function getVariablesWithQuery(query, count = 60) {
  return {
    productOriginVtex: true,
    simulationBehavior: "default",
    hideUnavailableItems: true,
    fullText: query,
    count: count,
    shippingOptions: [],
    variant: null
  };
}
/**
 * Genera las extensiones con la query para VTEX
 */
function getExtensionsWithQuery(query, count) {
  const variables = getVariablesWithQuery(query, count);
  return {
    persistedQuery: {
      version: 1,
      sha256Hash: VTEX_SHA256_HASH,
      sender: "vtex.store-resources@0.x",
      provider: "vtex.search-graphql@0.x"
    },
    variables: encodeBase64(JSON.stringify(variables))
  };
}
/**
 * Construye los parámetros de query
 */
function encodeQueryParams(params) {
  const queryParams = [];
  for (const [key, value] of Object.entries(params)) {
    queryParams.push(key + "=" + value);
  }
  return "?" + queryParams.join("&");
}
/**
 * Codifica la query completa para la URL
 */
function encodeQuery(query, count) {
  const extensions = JSON.stringify(getExtensionsWithQuery(query, count));
  const params = {
    workspace: "master",
    maxAge: "medium",
    appsEtag: "remove",
    domain: "store",
    locale: "es-AR",
    operationName: "productSuggestions",
    variables: encodeUrl("{}"),
    extensions: encodeUrl(extensions)
  };
  return encodeQueryParams(params);
}
/**
 * Normaliza un producto de la respuesta de VTEX al formato estándar
 */
export function normalizeProduct(rawProduct, baseUrl, source) {
  // Verificaciones de seguridad
  if (!rawProduct.items || rawProduct.items.length === 0) {
    return null;
  }
  
  const item = rawProduct.items[0]; // Tomamos el primer item (SKU) por defecto
  
  if (!item.images || item.images.length === 0) {
    return null;
  }
  if (!rawProduct.priceRange || !rawProduct.priceRange.sellingPrice) {
    return null;
  }
  // Intentar extraer EAN
  let ean = item.ean;
  
  // Si no hay EAN, descartamos el producto
  if (!ean) {
    return null;
  }
  
  // Extraer todas las imágenes
  const images = item.images.map(img => img.imageUrl);

  // Definir seller antes de calcular precios
  // VTEX suele tener commertialOffer.AvailableQuantity o sellers[0].commertialOffer.AvailableQuantity
  const seller = item.sellers?.find(s => s.sellerDefault) || item.sellers?.[0];

  // Precios
  // Cambiamos a usar la oferta comercial del vendedor (commertialOffer) del SKU
  // Esto es más preciso que product.priceRange que puede traer valores de otros SKUs o vendedores.
  let sellingPrice = 0;
  let listPrice = 0;
  
  if (seller && seller.commertialOffer) {
    sellingPrice = seller.commertialOffer.Price;
    // ListPrice en VTEX (Cencosud) viene con un valor erróneo (x82 aprox).
    // Usamos PriceWithoutDiscount que parece ser el correcto.
    listPrice = seller.commertialOffer.PriceWithoutDiscount || sellingPrice;
  } else {
    // Fallback a priceRange si no hay info en seller (raro)
    sellingPrice = rawProduct.priceRange.sellingPrice.lowPrice;
    listPrice = rawProduct.priceRange.listPrice?.lowPrice || sellingPrice;
  }

  // Calculo de precio de referencia (ej: precio x litro)
  // VTEX suele devolver measurementUnit y unitMultiplier en el item
  let referencePrice = null;
  let referenceUnit = item.measurementUnit; // ej: 'un', 'kg', 'lt'

  if (item.unitMultiplier && item.unitMultiplier > 0) {
    // Si el sellingPrice es por la unidad de venta (ej: botella 1.5L sale $1500)
    // y el unitMultiplier es 1.5, el precio por litro sería 1500 / 1.5 = 1000.
    referencePrice = sellingPrice / item.unitMultiplier;
  }

  // Stock / Disponibilidad
  let isAvailable = true;
  if (seller && seller.commertialOffer) {
     isAvailable = seller.commertialOffer.AvailableQuantity > 0;
  }
  
  return {
    ean: ean,
    external_id: rawProduct.productId, // ID de producto en VTEX
    source: source,
    name: rawProduct.productName,
    link: `${baseUrl}/${rawProduct.linkText}/p`,
    image: images[0],
    images: images,
    
    // Campos de precios normalizados
    price: sellingPrice,
    list_price: listPrice,
    reference_price: referencePrice,
    reference_unit: referenceUnit,
    
    is_available: isAvailable,

    // Mantenemos compatibilidad con campos viejos si es necesario, 
    // o simplemente devolvemos este objeto enriquecido.
    brand: rawProduct.brand,
    categories: rawProduct.categories,
    description: rawProduct.description,
    unavailable: !isAvailable // Deprecated, prefer is_available
  };
}
/**
 * Busca productos en una tienda VTEX
 * @param {string} baseUrl - URL base de la tienda (ej: https://www.disco.com.ar)
 * @param {string} query - Término de búsqueda o categoría
 * @param {string} source - Nombre de la fuente (ej: 'disco', 'carrefour')
 * @param {number} [count=50] - Cantidad de resultados
 */
/**
 * Trunca un string para logs (evita volcar 200KB de HTML en stdout).
 */
function truncate(value, max = 500) {
  if (value == null) return value;
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  return str.length > max ? `${str.slice(0, max)}… [truncated ${str.length - max} chars]` : str;
}

/**
 * Diagnóstico humano-legible de un error de VTEX.
 * Devuelve { kind, hint } para que el caller pueda decidir si abortar.
 *
 * kinds:
 *  - 'persisted_query_not_found' → VTEX_SHA256_HASH desactualizado/inválido
 *  - 'rate_limited'              → la API nos está limitando (429)
 *  - 'forbidden'                 → bloqueo (WAF / Cloudflare 403)
 *  - 'http_error'                → otro status no-2xx
 *  - 'timeout'                   → axios timeout
 *  - 'network'                   → ENOTFOUND / ECONNRESET / etc.
 *  - 'graphql_error'             → errors[] genérico
 *  - 'bad_shape'                 → respuesta 200 pero sin data.productSuggestions
 *  - 'unknown'
 */
function classifyVtexError(error) {
  // GraphQL error explícito (lanzado por nosotros desde data.errors)
  if (error.vtexGraphqlError) {
    const gqlErr = error.vtexGraphqlError;
    const code = gqlErr?.extensions?.code || gqlErr?.extensions?.exception?.name;
    if (code === 'PERSISTED_QUERY_NOT_FOUND' || /PersistedQueryNotFound/i.test(gqlErr.message || '')) {
      return {
        kind: 'persisted_query_not_found',
        hint: 'El VTEX_SHA256_HASH está desactualizado o no coincide con el workspace. Ejecutá `node scripts/extractVtexHash.js` para obtener uno nuevo y actualizá la env var.',
      };
    }
    return { kind: 'graphql_error', hint: `errors[0]=${truncate(gqlErr)}` };
  }
  if (error.vtexBadShape) {
    return { kind: 'bad_shape', hint: `Respuesta 200 sin data.productSuggestions. body=${truncate(error.vtexBody)}` };
  }
  // Axios
  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message)) {
    return { kind: 'timeout', hint: 'La API tardó >15s en responder.' };
  }
  if (error.response) {
    const status = error.response.status;
    const bodyPreview = truncate(error.response.data);
    if (status === 429) return { kind: 'rate_limited', hint: `HTTP 429. body=${bodyPreview}` };
    if (status === 403) return { kind: 'forbidden', hint: `HTTP 403 (posible WAF/Cloudflare). body=${bodyPreview}` };
    return { kind: 'http_error', hint: `HTTP ${status}. body=${bodyPreview}` };
  }
  if (error.code) {
    return { kind: 'network', hint: `${error.code} ${error.message}` };
  }
  return { kind: 'unknown', hint: error.message };
}

// Contador por source para detectar fallos sistémicos (mismo error en N queries seguidas).
const consecutiveErrorCounters = new Map();
const ABORT_AFTER_CONSECUTIVE = 5;

export async function fetchVtexProducts(baseUrl, query, source, count = 50) {
  // Asegurar que baseUrl no tenga barra al final
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const endpoint = `${cleanBaseUrl}/_v/segment/graphql/v1/`;
  const url = endpoint + encodeQuery(query, count);
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 15000,
      validateStatus: () => true, // no tirar excepción por status — lo manejamos abajo
    });

    // Errores HTTP (4xx/5xx) — los convertimos en una "axios error" equivalente
    if (response.status < 200 || response.status >= 300) {
      const httpErr = new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
      httpErr.response = response;
      throw httpErr;
    }

    const data = response.data;

    if (data && data.errors && data.errors.length > 0) {
      const gqlErr = data.errors[0];
      const wrapped = new Error(`API Error: ${gqlErr.message}`);
      wrapped.vtexGraphqlError = gqlErr;
      throw wrapped;
    }
    if (!data || !data.data || !data.data.productSuggestions || !data.data.productSuggestions.products) {
      const shapeErr = new Error('Estructura de respuesta inesperada de la API');
      shapeErr.vtexBadShape = true;
      shapeErr.vtexBody = data;
      throw shapeErr;
    }
    const rawProducts = data.data.productSuggestions.products;

    // Query OK → reseteamos contador de fallos para esta source
    consecutiveErrorCounters.set(source, 0);

    const normalizedProducts = rawProducts
      .map(product => normalizeProduct(product, cleanBaseUrl, source))
      .filter(product => product !== null);
    return normalizedProducts;
  } catch (error) {
    const diag = classifyVtexError(error);

    // Log estructurado: kind + hint + url útil para reproducir
    console.error(
      `❌ Error buscando "${query}" en ${source}: [${diag.kind}] ${error.message}` +
      `\n   ↳ hint: ${diag.hint}` +
      `\n   ↳ endpoint: ${endpoint}` +
      (diag.kind === 'persisted_query_not_found'
        ? `\n   ↳ sha256Hash en uso: ${VTEX_SHA256_HASH ? VTEX_SHA256_HASH.slice(0, 12) + '…' : '(vacío!)'}`
        : '')
    );

    // Si el mismo source viene fallando seguido, abortamos: probablemente el hash expiró
    // o la API nos está bloqueando — no tiene sentido machacar 294 categorías más.
    const counter = (consecutiveErrorCounters.get(source) || 0) + 1;
    consecutiveErrorCounters.set(source, counter);
    if (counter >= ABORT_AFTER_CONSECUTIVE) {
      const abortErr = new Error(
        `Abort: ${counter} fallos consecutivos en ${source} (último: ${diag.kind}). ${diag.hint}`
      );
      abortErr.vtexAbort = true;
      abortErr.diag = diag;
      throw abortErr;
    }

    return [];
  }
}
