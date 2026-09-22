import axios from 'axios';
import { getMerchantId as defaultGetMerchantId, tallyProductCategory } from './vtex.js';

/**
 * Recorrido del Catalog System REST de VTEX (SCRAPER-001).
 *
 *   GET /api/segments                                   → canal de venta de la tienda
 *   GET /api/catalog_system/pub/category/tree/3         → árbol de categorías
 *   GET /api/catalog_system/pub/products/search?fq=C:/{path}/&_from=&_to=
 *
 * Reemplaza a la búsqueda de texto de `productSuggestions` (`cores/vtex.js`), que
 * pedía el top-50 del autocompletado para cada uno de 279 términos: lo que veía
 * dependía de qué ranqueaba el buscador, variaba de corrida en corrida y dependía
 * de un hash de persisted query que caduca solo. Esto recorre el catálogo entero,
 * no depende de ningún hash y pagina de verdad.
 *
 * ⚠️ **Disco, Jumbo y Vea comparten UN catálogo** (el mismo árbol, 381.255
 * productos medidos el 2026-09-22). Lo que separa a cada cadena es el sales
 * channel (33, 32 y 34). Por eso el recorrido de los 7 comercios va con el canal
 * y con `fq=isAvailablePerSalesChannel_{canal}:1`: sin el filtro serían cientos de
 * miles de productos que la cadena no vende (y el maestro los crearía), y con un
 * canal equivocado el filtro no es más laxo, es un catálogo VACÍO (el canal 1 en
 * el host de Disco devuelve 0). Es la misma semántica que tenía
 * `hideUnavailableItems: true` en el camino de GraphQL.
 *
 * ⚠️ **`fq=C:` lleva el path completo.** `C:/17/` (una subcategoría sola) devuelve
 * 0; `C:/1/17/` devuelve sus 167 productos. El descenso a los hijos arma el path
 * desde la raíz. (El recorrido original de Josimar usaba el id suelto y habría
 * perdido un departamento entero el día que uno pasara la ventana.)
 *
 * ⚠️ **"Exitosa" no es "completa".** Una categoría que falla después de los
 * reintentos no aborta la corrida —los precios que llegaron se guardan— pero la
 * deja `complete: false`, y Laravel no cuenta ausencias de una corrida incompleta.
 * Lo mismo el modo `eans` y las corridas acotadas a algunas categorías, que por
 * definición no recorren el catálogo.
 *
 * NO lanza excepciones al caller: ante error devuelve `{ success: false, ... }`.
 */

/** VTEX exige `_to - _from <= 49`: 50 productos por request como máximo. */
export const PAGE_SIZE = 50;

/** Un `_from` mayor a esto responde HTTP 400. */
export const MAX_FROM = 2500;

/** Productos alcanzables por consulta: el último `_from` válido más su página. */
export const WINDOW = MAX_FROM + PAGE_SIZE;

/** Tope defensivo de nodos a consultar al resolver el árbol (Masonline usa 117). */
const MAX_CATEGORY_NODES = 1500;

/** EANs por request en modo `eans` (varios `fq` del mismo campo son un OR). */
const EAN_BATCH_SIZE = 25;

/** Pausa entre requests. Mismo ritmo que el camino de GraphQL. */
const REQUEST_DELAY_MS = 200;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

/** 429 y 403 son el WAF pidiendo que bajemos el ritmo: se espera bastante más. */
const COOLDOWN_DELAY_MS = 15000;

/**
 * Categorías seguidas que fallan (ya con sus reintentos) antes de cortar la
 * corrida. Una suelta es un 500 pasajero; tres seguidas son un bloqueo, y seguir
 * golpeando sólo lo empeora.
 */
const ABORT_AFTER_CONSECUTIVE_FAILURES = 3;

/** Pausa antes de la pasada final sobre las categorías que fallaron sueltas. */
const RETRY_FAILED_PAUSE_MS = 30000;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const REQUEST_CONFIG = {
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  timeout: 20000,
};

const defaultHttpGet = (url) => axios.get(url, REQUEST_CONFIG);
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const trimSlash = (url) => (url.endsWith('/') ? url.slice(0, -1) : url);
const asArray = (value) => (Array.isArray(value) ? value : []);

/** Mensaje corto de un error de axios (o de cualquier cosa que se le parezca). */
function describeError(error) {
  const status = error?.response?.status;
  if (status) return `HTTP ${status}`;
  return error?.message || error?.code || String(error);
}

/* ------------------------------------------------------------------------ *
 *  Funciones puras                                                          *
 * ------------------------------------------------------------------------ */

/**
 * Total de resultados del header `resources` de VTEX ("0-49/3524"). `null` si
 * falta o no se entiende: nunca inventa un total, porque un total inventado se
 * traduce en páginas que no se piden.
 */
export function parseResourcesTotal(header) {
  if (typeof header !== 'string') return null;
  const match = header.match(/\/(\d+)\s*$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

/**
 * URL de búsqueda del Catalog System.
 *
 * Sin `path` ni `eans` cuenta el catálogo entero. Sin `salesChannel` el host usa
 * su canal por defecto (lo que hace Josimar); con `onlyAvailable` el canal es
 * obligatorio, porque el filtro de disponibilidad es por canal.
 */
export function buildSearchUrl(
  baseUrl,
  { path = null, eans = null, from = 0, to = from + PAGE_SIZE - 1, salesChannel = null, onlyAvailable = false } = {}
) {
  if (onlyAvailable && salesChannel == null) {
    throw new Error(
      'No se puede filtrar disponibilidad sin el canal de venta: el filtro es por canal y con uno equivocado el catálogo sale vacío'
    );
  }

  const params = [];
  if (path) params.push(`fq=C:${path}`);
  for (const ean of eans ?? []) params.push(`fq=alternateIds_Ean:${encodeURIComponent(ean)}`);
  if (onlyAvailable) params.push(`fq=isAvailablePerSalesChannel_${salesChannel}:1`);
  if (salesChannel != null) params.push(`sc=${salesChannel}`);
  params.push(`_from=${from}`, `_to=${to}`);

  return `${trimSlash(baseUrl)}/api/catalog_system/pub/products/search?${params.join('&')}`;
}

/** Oferta comercial del seller por defecto (o del primero). */
function commercialOffer(item) {
  const seller = item?.sellers?.find((s) => s?.sellerDefault) || item?.sellers?.[0];
  return seller?.commertialOffer ?? null;
}

/**
 * Normaliza un producto crudo del Catalog System al formato que consumen los
 * save handlers (el mismo que emite `normalizeProduct()` de `cores/vtex.js`).
 *
 * Devuelve `null` cuando el producto no sirve:
 *   - sin EAN → no se puede cruzar con el maestro (`products.ean` es la PK).
 *   - sin precio positivo → un $0 pondría al comercio como "el más barato" de
 *     todo el comparador. Un producto menos es mucho mejor que un precio falso.
 *   - sin imagen, SÓLO si `requireImage` (el maestro, que es dueño de la metadata
 *     del catálogo; un follower no mira las imágenes y descartarlo tiraría un
 *     precio válido).
 *
 * ⚠️ NUNCA se usa `ListPrice`: en VTEX viene multiplicado (×90 en el fixture). El
 * precio tachado correcto es `PriceWithoutDiscount`.
 *
 * El link se arma con el dominio que se está recorriendo y `linkText`, igual que el
 * camino de GraphQL: el catálogo de Cencosud es compartido y el link tiene que
 * llevar a la tienda del comercio, no a la de otra cadena. El link absoluto que
 * trae VTEX es sólo el respaldo.
 *
 * Se toma `items[0]`, igual que el camino de GraphQL: casi todo el catálogo de
 * súper tiene un SKU por producto.
 */
export function normalizeCatalogProduct(rawProduct, { baseUrl, source, requireImage = false } = {}) {
  const item = rawProduct?.items?.[0];
  if (!item) return null;

  const ean = typeof item.ean === 'string' ? item.ean.trim() : null;
  if (!ean) return null;

  const offer = commercialOffer(item);
  const price = Number(offer?.Price);
  if (!offer || !Number.isFinite(price) || price <= 0) return null;

  const images = Array.isArray(item.images)
    ? item.images.map((img) => img?.imageUrl).filter(Boolean)
    : [];
  if (requireImage && images.length === 0) return null;

  const withoutDiscount = Number(offer.PriceWithoutDiscount);
  const listPrice = Number.isFinite(withoutDiscount) && withoutDiscount > 0 ? withoutDiscount : price;

  // Precio de referencia (ej: precio por kg). `unitMultiplier` es 1 para la mayoría.
  const multiplier = Number(item.unitMultiplier);
  const referencePrice = Number.isFinite(multiplier) && multiplier > 0 ? price / multiplier : null;

  // `IsAvailable` es el flag explícito; `AvailableQuantity`, el respaldo.
  const isAvailable =
    typeof offer.IsAvailable === 'boolean' ? offer.IsAvailable : Number(offer.AvailableQuantity) > 0;

  const link = rawProduct.linkText
    ? `${trimSlash(baseUrl)}/${rawProduct.linkText}/p`
    : rawProduct.link ?? null;

  return {
    ean,
    external_id: rawProduct.productId != null ? String(rawProduct.productId) : null,
    source,
    name: rawProduct.productName ?? null,
    link,
    image: images[0] ?? null,
    images,
    price,
    list_price: listPrice,
    reference_price: referencePrice,
    reference_unit: item.measurementUnit ?? null,
    is_available: isAvailable,
    brand: rawProduct.brand ?? null,
    categories: Array.isArray(rawProduct.categories) ? rawProduct.categories : [],
    description: rawProduct.description ?? null,
    unavailable: !isAvailable, // deprecado, se mantiene por compat con el core de GraphQL
  };
}

/* ------------------------------------------------------------------------ *
 *  Reintentos                                                               *
 * ------------------------------------------------------------------------ */

/**
 * ¿Es un error pasajero que vale reintentar enseguida? Red (sin respuesta HTTP) y
 * 5xx: el VTEX de Josimar devuelve 500 intermitentes y la misma URL contesta un
 * minuto después. Un 4xx es determinista y repetirlo sólo esconde el problema.
 */
export function isRetryableError(error) {
  const status = error?.response?.status;
  if (status === undefined) return true;
  return status >= 500 && status < 600;
}

/**
 * Cuánto esperar antes del próximo intento, o `null` si no hay que reintentar.
 * `attempt` es la cantidad de intentos fallidos hasta ahora (arranca en 1).
 *
 * 429 y 403 se reintentan, pero con enfriamiento: el WAF está pidiendo que bajemos
 * el ritmo, y un reintento inmediato es exactamente lo contrario.
 */
export function retryDelayMs(error, attempt) {
  if (attempt >= MAX_ATTEMPTS) return null;
  if (isRetryableError(error)) return RETRY_DELAY_MS * attempt;
  const status = error?.response?.status;
  if (status === 429 || status === 403) return COOLDOWN_DELAY_MS * attempt;
  return null;
}

/** Ejecuta `fn` con la política de `retryDelayMs`. Propaga el último error. */
export async function withRetry(fn, { sleep = defaultSleep, label = null } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = retryDelayMs(error, attempt);
      if (delay === null) throw error;
      console.warn(
        `⚠️ ${describeError(error)}${label ? ` en ${label}` : ''}; ` +
          `reintento ${attempt}/${MAX_ATTEMPTS - 1} en ${delay / 1000}s`
      );
      await sleep(delay);
    }
  }
}

/* ------------------------------------------------------------------------ *
 *  Canal de venta y árbol                                                   *
 * ------------------------------------------------------------------------ */

/**
 * Canal de venta que publica la tienda, leído de su segmento por defecto.
 *
 * Se resuelve en cada corrida en vez de confiar en una constante: si el comercio
 * mueve su catálogo a otro canal, el filtro de disponibilidad con el canal viejo
 * devolvería un catálogo vacío. `fallback` (el canal configurado) sólo se usa si
 * la tienda no contesta o contesta algo ilegible.
 */
export async function resolveSalesChannel(baseUrl, { fallback = null, httpGet = defaultHttpGet, sleep = defaultSleep } = {}) {
  const url = `${trimSlash(baseUrl)}/api/segments`;
  try {
    const response = await withRetry(() => httpGet(url), { sleep, label: url });
    const channel = Number(response?.data?.channel);
    if (Number.isInteger(channel) && channel > 0) return { channel, source: 'segments' };
    console.warn(`⚠️ ${url} no trajo un canal legible (${JSON.stringify(response?.data?.channel)}); se usa el configurado: ${fallback}`);
  } catch (error) {
    console.warn(`⚠️ No se pudo leer el canal de ${url} (${describeError(error)}); se usa el configurado: ${fallback}`);
  }
  return { channel: fallback, source: 'fallback' };
}

/**
 * Resuelve qué categorías recorrer.
 *
 * Arranca por los departamentos y baja a los hijos **sólo** cuando uno no entra en
 * la ventana de paginación (`WINDOW`). Una hoja que no entra se recorre igual
 * (hasta donde llega la ventana) y queda en `oversized`: desde ahí el recorrido
 * pierde productos y la corrida no puede declararse completa. Un total desconocido
 * se recorre igual —la paginación corta sola en la página vacía— y uno en cero se
 * saltea, que es la mayoría de los departamentos "Sin Categoría" y de temporada.
 *
 * Un nodo con hijos y total desconocido también baja: no se sabe si entra en la
 * ventana, y recorrerlo plano arriesgaría un truncado que se repetiría en cada corrida.
 *
 * Un conteo que falla queda en `failed` y se sigue con los hermanos, salvo que el
 * error sea un aborto de la corrida (`catalogAbort`), que se propaga.
 *
 * `hanging` son los productos que cuelgan del padre y no de ningún hijo (el total del
 * padre supera la suma de los hijos): ninguna consulta los alcanza, así que su precio
 * no se refresca y dejar que venzan es lo correcto. No vuelven incompleta la corrida
 * —no hay nada que reintentar—, pero se informan. Es una cota inferior: un producto
 * en dos subcategorías suma dos veces y puede tapar a uno colgado.
 */
export async function resolveCategoryTargets(
  tree,
  { countTotal, maxNodes = MAX_CATEGORY_NODES, window = WINDOW, parentPath = '/' } = {}
) {
  const targets = [];
  const oversized = [];
  const failed = [];
  const hanging = [];
  let visitedNodes = 0;
  let truncatedByCap = false;

  // Devuelve el total del nodo, o `null` si no se pudo saber.
  async function visit(node, parent) {
    if (node?.id == null) return 0;
    if (visitedNodes >= maxNodes) {
      if (!truncatedByCap) {
        console.warn(`⚠️ Tope de ${maxNodes} categorías alcanzado; el recorrido queda incompleto.`);
      }
      truncatedByCap = true;
      return null;
    }
    visitedNodes++;

    const path = `${parent}${node.id}/`;
    const name = node.name ?? null;

    let total;
    try {
      total = await countTotal(path);
    } catch (error) {
      if (error?.catalogAbort) throw error;
      failed.push({ path, name, error: describeError(error) });
      return null;
    }

    if (total === 0) return 0;

    const children = Array.isArray(node.children) ? node.children : [];
    if (children.length === 0 || (total !== null && total <= window)) {
      if (total !== null && total > window) {
        console.warn(
          `⚠️ La categoría hoja ${path} ("${name}") tiene ${total} productos y la API corta en ${window}: quedan ${total - window} sin recorrer.`
        );
        oversized.push({ path, name, total });
      }
      targets.push({ path, name, total });
      return total;
    }

    console.log(
      `   ↳ "${name}" (${path}) tiene ${total ?? 'un total desconocido de'} productos (> ${window}): bajando a sus ${children.length} subcategorías`
    );
    const childTotals = [];
    for (const child of children) childTotals.push(await visit(child, path));

    if (total !== null && childTotals.every((t) => t !== null)) {
      const missing = total - childTotals.reduce((sum, t) => sum + t, 0);
      if (missing > 0) {
        console.warn(`⚠️ ${missing} productos cuelgan de "${name}" (${path}) y de ninguna subcategoría: no se pueden recorrer.`);
        hanging.push({ path, name, count: missing });
      }
    }
    return total;
  }

  const rootTotals = [];
  for (const node of asArray(tree)) rootTotals.push(await visit(node, parentPath));

  return {
    targets,
    oversized,
    failed,
    hanging,
    // Suma de los nodos de arriba, para comparar con el total del catálogo: la
    // diferencia son productos fuera del árbol. `null` si alguno no se supo.
    rootTotal: rootTotals.every((t) => t !== null) ? rootTotals.reduce((sum, t) => sum + t, 0) : null,
    truncatedByCap,
    visitedNodes,
    complete: !truncatedByCap && oversized.length === 0 && failed.length === 0,
  };
}

/**
 * Recorre una categoría paginando hasta agotarla o hasta el tope de la ventana.
 * Llama `onBatch` con los productos crudos de cada página. Una página que falla
 * propaga el error: las anteriores ya se procesaron.
 */
export async function walkTarget(target, { fetchPage, onBatch, sleep = defaultSleep, delayMs = REQUEST_DELAY_MS }) {
  let from = 0;
  let fetched = 0;
  let truncated = false;

  for (;;) {
    const { products, total } = await fetchPage(target.path, from);
    if (products.length === 0) break;

    await onBatch(products);
    fetched += products.length;

    const knownTotal = total ?? target.total;
    if (knownTotal != null && from + products.length >= knownTotal) break;
    if (products.length < PAGE_SIZE) break;

    if (from + PAGE_SIZE > MAX_FROM) {
      truncated = true;
      break;
    }

    from += PAGE_SIZE;
    await sleep(delayMs);
  }

  return { fetched, truncated };
}

/** `/1/17/` → `/1/`: el path del padre, para volver a resolver un nodo suelto. */
const parentPathOf = (path) => path.replace(/[^/]+\/$/, '');

/** Índice path → nodo del árbol, para reintentar un nodo cuyo conteo falló. */
function indexTree(tree, parent = '/', index = new Map()) {
  for (const node of asArray(tree)) {
    if (node?.id == null) continue;
    const path = `${parent}${node.id}/`;
    index.set(path, node);
    indexTree(node.children, path, index);
  }
  return index;
}

/* ------------------------------------------------------------------------ *
 *  Orquestador                                                              *
 * ------------------------------------------------------------------------ */

/**
 * 🎯 Recorre el catálogo de un comercio VTEX y llama `onProductFound(product,
 * merchantId)` una vez por EAN.
 *
 * @param {Object}   options
 * @param {string}   options.merchantName   nombre del comercio (para `getMerchantId`)
 * @param {string}   options.baseUrl        https://www.disco.com.ar
 * @param {string}   [options.source]       default: merchantName en minúsculas
 * @param {number|null} [options.salesChannel] canal configurado (respaldo de /api/segments).
 *                   `null` = no mandar canal y dejar que el host use el suyo (Josimar).
 * @param {boolean}  [options.onlyAvailable] filtrar por disponibilidad en el canal
 * @param {boolean}  [options.requireImage] descartar productos sin imagen (el maestro)
 * @param {Function|null} [options.onProductFound] `null` = corrida en seco, sin tocar la base
 * @param {'categories'|'eans'} [options.mode]
 * @param {string[]} [options.eans]         EANs del modo `eans`
 * @param {string[]|null} [options.categoryPaths] recorrer sólo estas categorías ('/1/', '/1/17/')
 */
export async function scrapeVtexCatalog({
  merchantName,
  baseUrl,
  source = merchantName.toLowerCase(),
  salesChannel = null,
  onlyAvailable = false,
  requireImage = false,
  onProductFound = null,
  mode = 'categories',
  eans = [],
  categoryPaths = null,
  httpGet = defaultHttpGet,
  sleep = defaultSleep,
  getMerchantId = defaultGetMerchantId,
  delayMs = REQUEST_DELAY_MS,
  retryFailedPauseMs = RETRY_FAILED_PAUSE_MS,
  maxCategoryNodes = MAX_CATEGORY_NODES,
}) {
  const base = trimSlash(baseUrl);
  const startedAt = Date.now();

  const seenEans = new Set();
  const categoryCounts = new Map();
  let savedCount = 0;
  let skippedCount = 0;
  let discardedCount = 0;
  let rawCount = 0;
  let requestCount = 0;

  let channel = null;
  let expectedTotal = null;
  let targets = [];
  const visitedPaths = new Set();
  // Corrida acotada a algunas categorías (`categoryPaths`): no recorre el catálogo.
  let partial = false;
  let truncatedByCap = false;
  let rootTotal = null;
  const failed = [];
  const oversized = [];
  const hanging = [];

  console.log(`🛒 Recorriendo el catálogo de ${merchantName} [modo: ${mode}]...`);

  const report = ({ success, error = null, aborted = null }) => {
    // Por qué la corrida no sirve para inferir ausencias. Laravel lo muestra en el aviso;
    // el orden es el de prioridad para decidir qué se le dice al operador.
    const incompleteReasons = [];
    if (mode === 'eans') incompleteReasons.push('eans_mode');
    if (partial) incompleteReasons.push('partial');
    if (failed.length > 0) incompleteReasons.push('failed_categories');
    if (oversized.length > 0) incompleteReasons.push('oversized_categories');
    if (truncatedByCap) incompleteReasons.push('node_cap');
    const complete = success && incompleteReasons.length === 0;

    // Productos que ninguna consulta alcanza: colgados de un padre sin estar en un hijo,
    // o fuera del árbol (el catálogo declara más de lo que suman los departamentos).
    // Su precio no se refresca, así que no vuelven incompleta la corrida: se informan.
    const outsideTree = expectedTotal != null && rootTotal != null ? Math.max(0, expectedTotal - rootTotal) : 0;
    const unreachableProducts = hanging.reduce((sum, h) => sum + h.count, 0) + outsideTree;

    const result = {
      success,
      complete,
      aborted,
      source,
      strategy: 'catalog',
      mode,
      salesChannel: channel,
      totalProducts: seenEans.size,
      savedProducts: savedCount,
      skippedProducts: skippedCount,
      discardedProducts: discardedCount,
      rawProducts: rawCount,
      expectedTotal,
      totalCategories: targets.length,
      visitedCategories: visitedPaths.size,
      failedCategories: failed.map(({ path, name, error: message }) => ({ path, name, error: message })),
      oversizedCategories: oversized,
      incompleteReasons,
      truncatedByCap,
      unreachableProducts,
      requestCount,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      // Desglose liviano por categoría (lo consume slackNotifier). NO se devuelve la
      // lista de productos: retenerla es lo que causó el OOM del 2026-09-04.
      categoryStats: Array.from(categoryCounts.entries()),
      timestamp: new Date().toISOString(),
    };
    if (error) result.error = error;

    console.log(`\n🎉 Recorrido de ${merchantName} terminado (${result.durationSeconds}s, ${requestCount} requests):`);
    console.log(`   📊 Productos únicos: ${seenEans.size}${expectedTotal != null ? ` de ${expectedTotal} que declara el catálogo` : ''}`);
    console.log(`   💾 Guardados: ${savedCount}${skippedCount ? ` · ⏭️ fuera del maestro: ${skippedCount}` : ''}${discardedCount ? ` · 🗑️ descartados: ${discardedCount}` : ''}`);
    if (unreachableProducts > 0) console.log(`   🔒 ${unreachableProducts} productos que ninguna consulta alcanza (fuera del árbol o colgados de un padre)`);
    if (failed.length) console.warn(`   ⚠️ ${failed.length} categoría(s) sin recorrer: ${failed.map((f) => f.name || f.path).join(', ')}`);
    if (!success) console.error(`   ❌ ${error}`);
    else if (!complete) console.warn('   ⚠️ Corrida INCOMPLETA: no recorrió el catálogo entero, no sirve para inferir ausencias.');
    return result;
  };

  // Corta la corrida ante una racha de categorías caídas: con reintentos incluidos,
  // tres seguidas ya no son un 500 pasajero sino un bloqueo.
  let streak = 0;
  const guarded = async (fn) => {
    try {
      const value = await fn();
      streak = 0;
      return value;
    } catch (error) {
      if (error?.catalogAbort) throw error;
      streak++;
      if (streak >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
        const abort = new Error(
          `Abort: ${streak} categorías seguidas fallaron en ${merchantName} (última: ${describeError(error)})`
        );
        abort.catalogAbort = true;
        abort.diag = {
          kind: 'consecutive_failures',
          hint: 'Posible bloqueo del WAF o caída de la API de catálogo; la corrida se corta para no seguir golpeando.',
        };
        throw abort;
      }
      throw error;
    }
  };

  const get = (url) => {
    requestCount++;
    return withRetry(() => httpGet(url), { sleep, label: url });
  };

  try {
    let merchantId = null;
    if (onProductFound) {
      merchantId = await getMerchantId(merchantName);
      if (!merchantId) throw new Error(`No se pudo obtener el ID del comercio ${merchantName}`);
    } else {
      console.warn('⚠️ Corrida en seco: no se guarda nada en la base.');
    }

    if (salesChannel != null) {
      const resolved = await resolveSalesChannel(base, { fallback: salesChannel, httpGet, sleep });
      channel = resolved.channel;
      if (resolved.source === 'segments' && channel !== salesChannel) {
        console.warn(`⚠️ ${merchantName} publica el canal ${channel}, no el ${salesChannel} configurado: se sigue a la tienda.`);
      }
    }
    if (onlyAvailable && channel == null) {
      throw new Error(`No hay canal de venta para ${merchantName}: sin canal no se puede filtrar disponibilidad`);
    }

    const searchUrl = (params) => buildSearchUrl(base, { salesChannel: channel, onlyAvailable, ...params });

    const handleBatch = async (rawProducts) => {
      rawCount += rawProducts.length;
      for (const raw of rawProducts) {
        const product = normalizeCatalogProduct(raw, { baseUrl: base, source, requireImage });
        if (!product) {
          discardedCount++;
          continue;
        }
        if (seenEans.has(product.ean)) continue;
        seenEans.add(product.ean);
        tallyProductCategory(categoryCounts, product);

        if (!merchantId) continue;
        const result = await onProductFound(product, merchantId);
        if (result === true || result?.saved === true) savedCount++;
        else if (result?.reason === 'not_in_master') skippedCount++;
      }
    };

    if (mode === 'eans') {
      const list = asArray(eans).map((e) => String(e).trim()).filter(Boolean);
      if (list.length === 0) throw new Error('Modo "eans" sin EANs: definí PRODUCT_EANS en el entorno');

      console.log(`🔎 Consultando ${list.length} EANs puntuales`);
      for (let i = 0; i < list.length; i += EAN_BATCH_SIZE) {
        const batch = list.slice(i, i + EAN_BATCH_SIZE);
        try {
          const response = await guarded(() => get(searchUrl({ eans: batch })));
          await handleBatch(asArray(response.data));
        } catch (error) {
          if (error?.catalogAbort) throw error;
          failed.push({ path: `eans[${i}..${i + batch.length - 1}]`, name: null, error: describeError(error) });
        }
        if (i + EAN_BATCH_SIZE < list.length) await sleep(delayMs);
      }
      return report({ success: true });
    }

    const countTotal = async (path) => {
      const response = await get(searchUrl({ path, from: 0, to: 0 }));
      await sleep(delayMs);
      const total = parseResourcesTotal(response.headers?.resources);
      // Sin header y sin productos no hay nada que recorrer.
      if (total === null && Array.isArray(response.data) && response.data.length === 0) return 0;
      return total;
    };

    // El total del catálogo es la vara contra la que se lee el recorrido, y la
    // firma de un canal mal resuelto: si es cero, la corrida falla en vez de
    // reportar un éxito vacío que Laravel leería como "no hay nada".
    expectedTotal = await guarded(() => countTotal(null));
    if (expectedTotal === 0) {
      throw new Error(
        `El catálogo de ${merchantName} no devolvió ningún producto` +
          (onlyAvailable ? ` disponible en el canal ${channel}` : '') +
          ': canal mal resuelto o API caída'
      );
    }

    const fetchPage = async (path, from) => {
      const response = await get(searchUrl({ path, from }));
      return { products: asArray(response.data), total: parseResourcesTotal(response.headers?.resources) };
    };

    const walk = async (target) => {
      visitedPaths.add(target.path);
      const label = target.name ? `${target.name} (${target.path})` : target.path;
      try {
        const { fetched, truncated } = await guarded(() =>
          walkTarget(target, { fetchPage, onBatch: handleBatch, sleep, delayMs })
        );
        if (truncated && !oversized.some((o) => o.path === target.path)) {
          oversized.push({ path: target.path, name: target.name, total: target.total });
        }
        console.log(`   ✅ ${label}: ${fetched} productos (${seenEans.size} únicos acumulados)`);
      } catch (error) {
        if (error?.catalogAbort) throw error;
        failed.push({ ...target, stage: 'walk', error: describeError(error) });
        console.error(`   ❌ ${label} falló y se saltea: ${describeError(error)}`);
      }
      await sleep(delayMs);
    };

    const resolveNodes = async (nodes, parentPath) => {
      const resolved = await resolveCategoryTargets(nodes, {
        countTotal: (path) => guarded(() => countTotal(path)),
        parentPath,
        maxNodes: maxCategoryNodes,
      });
      failed.push(...resolved.failed.map((f) => ({ ...f, stage: 'count' })));
      oversized.push(...resolved.oversized);
      hanging.push(...resolved.hanging);
      truncatedByCap = truncatedByCap || resolved.truncatedByCap;
      return resolved;
    };

    let treeIndex = new Map();
    if (categoryPaths && categoryPaths.length > 0) {
      partial = true;
      targets = categoryPaths.map((path) => ({ path, name: null, total: null }));
      console.log(`📋 Corrida acotada a ${targets.length} categorías: ${categoryPaths.join(', ')}`);
    } else {
      const treeResponse = await guarded(() => get(`${base}/api/catalog_system/pub/category/tree/3`));
      const tree = asArray(treeResponse.data);
      if (tree.length === 0) throw new Error('El árbol de categorías vino vacío');
      treeIndex = indexTree(tree);

      console.log(`🗂️  ${tree.length} departamentos; ${expectedTotal ?? '?'} productos${onlyAvailable ? ` disponibles en el canal ${channel}` : ''}`);
      const resolved = await resolveNodes(tree, '/');
      targets = resolved.targets;
      rootTotal = resolved.rootTotal;
      console.log(`📋 ${targets.length} categorías a recorrer`);
    }

    for (const target of targets) await walk(target);

    // Pasada final: lo que falló suelto suele ser un 500 pasajero, y una sola
    // categoría caída alcanza para que la corrida no pueda contar ausencias.
    if (failed.length > 0) {
      console.log(`🔁 Reintentando ${failed.length} categoría(s) en ${retryFailedPauseMs / 1000}s...`);
      await sleep(retryFailedPauseMs);
      // La racha arranca de cero: dos fallos al final del recorrido más el primer
      // reintento no son "tres categorías seguidas caídas", y abortar acá tiraría a
      // "error" una corrida que ya guardó casi todos sus precios.
      streak = 0;
      const pending = failed.splice(0);
      for (const entry of pending) {
        const node = entry.stage === 'count' ? treeIndex.get(entry.path) : null;
        if (node) {
          const { targets: recovered } = await resolveNodes([node], parentPathOf(entry.path));
          targets.push(...recovered);
          for (const target of recovered) await walk(target);
        } else if (entry.stage === 'walk') {
          await walk(entry);
        } else {
          failed.push(entry);
        }
      }
    }

    return report({ success: true });
  } catch (error) {
    if (error?.catalogAbort) {
      return report({
        success: false,
        error: error.message,
        aborted: { kind: error.diag?.kind, hint: error.diag?.hint, message: error.message },
      });
    }
    return report({ success: false, error: error.message ?? describeError(error) });
  }
}
