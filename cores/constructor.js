// scrapper-script/cores/constructor.js
import axios from 'axios';
import { getMerchantId } from './vtex.js';

const AC_BASE = 'https://ac.cnstrc.com';
const CONSTRUCTOR_KEY = 'key_r6xzz4IAoTWcipni';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ROOT_GROUP_ID = 'categoria';
const MAX_WINDOW = 10000; // tope de la ventana de browse de Constructor.io

/**
 * Precio efectivo de una fila de sucursal.
 *
 * ============================================================================
 * `formatPrice` NO es el precio de venta: es el PRECIO POR UNIDAD DE MEDIDA
 * ============================================================================
 *
 * Es el "precio por litro / por kilo" que la ley argentina obliga a exhibir
 * junto al precio de góndola (Ley 22.802). Coto lo publica en `formatPrice` y
 * el precio real en `listPrice`. Verificado contra la API en vivo:
 *
 *   Coca-Cola   220 ml  → listPrice 1100  formatPrice 5000     (×1000/220)
 *   Coca-Cola   473 ml  → listPrice 2500  formatPrice 5285.41  (×1000/473)
 *   Coca-Cola   1,5 L   → listPrice 3600  formatPrice 2400     (÷1,5)
 *   Coca-Cola   2,25 L  → listPrice 4845  formatPrice 2153.33  (÷2,25)
 *
 * O sea `formatPrice = listPrice / litros`: queda POR ENCIMA en envases chicos
 * y POR DEBAJO en envases grandes. Coinciden sólo cuando el envase es de 1 L o
 * 1 kg — y la fixture de los tests era justamente una leche de 1 L, que es la
 * razón por la que el bug sobrevivió a la suite.
 *
 * El código anterior prefería `formatPrice` y trataba la diferencia como un
 * descuento. Consecuencias medidas sobre la base (BUG-072): de 5255 productos
 * de Coto con precio de lista, 3557 quedaron MÁS CAROS que la realidad y 528
 * MÁS BARATOS. Los caros hacían que la ficha anunciara descuentos falsos de
 * hasta 85%; los baratos son peores todavía, porque la app recomendaba comprar
 * en Coto a un precio que no existe.
 *
 * Por eso acá se usa SIEMPRE `listPrice`. `formatPrice` queda sólo como último
 * recurso cuando no hay precio de venta, y en ese caso no se reporta como
 * precio de lista, porque no lo es.
 */
function resolveStorePrice(row) {
  const list = Number(row.listPrice);
  const format = Number(row.formatPrice);
  const hasList = Number.isFinite(list) && list > 0;
  const hasFormat = Number.isFinite(format) && format > 0;

  // `formatPrice` no sirve como precio de venta, pero SÍ es exactamente el dato que la
  // Ley 22.802 obliga a exhibir: el precio por unidad de medida. Se venía descartando
  // (DATA-001) teniendo las columnas donde guardarlo, y es lo que habilita comparar
  // "precio por litro" entre presentaciones distintas.
  const referencePrice = hasFormat ? format : null;

  if (hasList) {
    return { price: list, listPrice: list, referencePrice };
  }
  if (hasFormat) {
    return { price: format, listPrice: null, referencePrice };
  }
  return { price: null, listPrice: null, referencePrice: null };
}

/** Tamaños en el nombre del producto: "1,5 L", "500 g", "220 ml", "2 kg". */
const MEDIDA_RE = /(\d+(?:[.,]\d+)?)\s*(ml|cc|lts?|litros?|kgs?|kilos?|grs?|gramos?|g|l)\b/i;

/**
 * Tamaño del envase expresado en la unidad base (litros o kilos), leído del nombre.
 *
 * @returns {{cantidad: number, unidad: 'L'|'kg'}|null}
 */
export function parsePackSize(name) {
  const match = MEDIDA_RE.exec(String(name ?? ''));
  if (!match) {
    return null;
  }

  const cantidad = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    return null;
  }

  const unidad = match[2].toLowerCase();

  if (/^(ml|cc)$/.test(unidad)) return { cantidad: cantidad / 1000, unidad: 'L' };
  if (/^(l|lts?|litros?)$/.test(unidad)) return { cantidad, unidad: 'L' };
  if (/^(g|grs?|gramos?)$/.test(unidad)) return { cantidad: cantidad / 1000, unidad: 'kg' };
  if (/^(kgs?|kilos?)$/.test(unidad)) return { cantidad, unidad: 'kg' };

  return null;
}

/**
 * Unidad del precio de referencia — y, de paso, su propia verificación.
 *
 * La API no dice en qué unidad está `formatPrice`; lo que sí se sabe es que
 * `formatPrice = listPrice / tamaño`. Así que el tamaño se lee del nombre y se contrasta
 * contra el que implican los dos precios: si coinciden, la unidad leída es la correcta y
 * el dato queda validado por construcción. Si no coinciden —nombre raro, envase múltiple,
 * precio inconsistente— se devuelve null y la columna queda vacía, que es mejor que
 * rotular un número con una unidad inventada.
 */
export function resolveReferenceUnit(name, listPrice, referencePrice) {
  const medida = parsePackSize(name);
  const lista = Number(listPrice);
  const referencia = Number(referencePrice);

  if (!medida || !Number.isFinite(lista) || !Number.isFinite(referencia) || referencia <= 0) {
    return null;
  }

  const tamanoImplicito = lista / referencia;
  const desvio = Math.abs(tamanoImplicito - medida.cantidad) / medida.cantidad;

  return desvio <= 0.05 ? medida.unidad : null;
}

/**
 * Convierte un item crudo de Constructor.io al shape estándar de producto con
 * precios por sucursal. Devuelve null si no tiene EAN (igual que los VTEX).
 */
export function normalizeConstructorItem(rawItem) {
  const data = rawItem?.data ?? {};
  const eanRaw = data.product_main_ean;
  if (eanRaw === null || eanRaw === undefined || String(eanRaw).trim() === '') {
    return null;
  }

  const nombre = rawItem.value ?? data.sku_display_name ?? null;

  const priceRows = Array.isArray(data.price) ? data.price : [];
  const storePrices = priceRows
    .filter((row) => row && row.store != null)
    .map((row) => {
      const { price, listPrice, referencePrice } = resolveStorePrice(row);
      return {
        code: String(row.store),
        price,
        listPrice,
        referencePrice,
        isAvailable: price !== null,
      };
    })
    .filter((sp) => sp.price !== null);

  // La unidad es del producto, no de la sucursal: se resuelve una vez con la primera fila
  // que tenga los dos precios.
  const filaConReferencia = storePrices.find((sp) => sp.referencePrice != null && sp.listPrice != null);
  const referenceUnit = filaConReferencia
    ? resolveReferenceUnit(nombre, filaConReferencia.listPrice, filaConReferencia.referencePrice)
    : null;

  const image = data.image_url || data.product_large_image_url || data.product_medium_image_url || null;
  const categories = Array.isArray(data.groups)
    ? data.groups.map((g) => g.display_name).filter(Boolean)
    : [];

  return {
    ean: String(eanRaw),
    name: nombre,
    brand: data.product_brand ?? null,
    image,
    images: image ? [image] : [],
    categories,
    link: data.url ? `https://www.coto.com.ar/${String(data.url).replace(/^_\//, '')}` : null,
    storePrices,
    referenceUnit,
  };
}

/**
 * GET a la API de browse de Constructor.io. `httpGet` es inyectable para tests.
 */
export async function fetchConstructorBrowse(groupId, page = 1, perPage = 200, httpGet = defaultGet) {
  const url =
    `${AC_BASE}/browse/group_id/${encodeURIComponent(groupId)}` +
    `?key=${CONSTRUCTOR_KEY}&num_results_per_page=${perPage}&page=${page}` +
    `&c=ciojs-client-2.54.0&i=ahorrapp-scraper&s=1&_dt=1`;

  const { data } = await httpGet(url);
  const r = data?.response ?? {};
  return { results: r.results ?? [], total: r.total_num_results ?? 0, groups: r.groups ?? [] };
}

async function defaultGet(url) {
  return axios.get(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', Referer: 'https://www.coto.com.ar/' },
    timeout: 20000,
  });
}

/**
 * Recorre el árbol de categorías desde rootGroupId y devuelve los group_id de
 * las HOJAS (sin hijos). Se paginan las hojas para mantenerse bajo el tope de
 * 10k de la ventana de browse.
 */
export async function collectLeafGroupIds(rootGroupId = ROOT_GROUP_ID, httpGet = defaultGet) {
  const leaves = [];
  const seen = new Set();

  async function walk(groupId) {
    if (seen.has(groupId)) return;
    seen.add(groupId);

    // La API de browse expone solo UN nivel de hijos por respuesta: para
    // descubrir los hijos de un nodo hay que hacer browse de ESE nodo.
    const { groups } = await fetchConstructorBrowse(groupId, 1, 1, httpGet);
    const node = groups.find((g) => g.group_id === groupId) ?? groups[0];
    const children = node?.children ?? [];

    if (children.length === 0) {
      leaves.push(groupId);
      return;
    }
    for (const child of children) {
      await walk(child.group_id);
    }
  }

  await walk(rootGroupId);
  return leaves;
}

/**
 * Scrapea todo el catálogo de un merchant vía Constructor.io: enumera hojas del
 * árbol, pagina cada una y llama onProductFound(normalized, merchantId) por
 * producto único (dedup por EAN en el run).
 */
export async function scrapeConstructorMerchant({
  merchantName,
  onProductFound,
  rootGroupId = ROOT_GROUP_ID,
  perPage = 200,
  httpGet = defaultGet,
  merchantId,
}) {
  try {
    const resolvedMerchantId = merchantId ?? (await getMerchantId(merchantName));
    const leaves = await collectLeafGroupIds(rootGroupId, httpGet);
    console.log(`🗂️  ${leaves.length} categorías hoja para ${merchantName}`);

    const seenEans = new Set();
    let totalProducts = 0;
    let savedProducts = 0;

    for (const groupId of leaves) {
      let page = 1;
      while (page * perPage <= MAX_WINDOW) {
        const { results, total } = await fetchConstructorBrowse(groupId, page, perPage, httpGet);
        if (results.length === 0) break;

        for (const raw of results) {
          const product = normalizeConstructorItem(raw);
          if (!product || seenEans.has(product.ean)) continue;
          seenEans.add(product.ean);
          totalProducts++;
          const out = await onProductFound(product, resolvedMerchantId);
          if (out?.saved) savedProducts++;
        }

        if (page * perPage >= total || results.length < perPage) break;
        page++;
      }
      if ((page * perPage) > MAX_WINDOW) {
        console.warn(`⚠️ Categoría ${groupId} alcanzó el tope de 10k; posible truncado.`);
      }
    }

    return { success: true, source: merchantName.toLowerCase(), totalProducts, savedProducts };
  } catch (error) {
    console.error(`❌ Error en scrapeConstructorMerchant(${merchantName}):`, error.message);
    return { success: false, source: (merchantName || '').toLowerCase(), totalProducts: 0, savedProducts: 0, error: error.message };
  }
}
