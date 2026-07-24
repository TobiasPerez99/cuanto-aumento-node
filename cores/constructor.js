// scrapper-script/cores/constructor.js
import axios from 'axios';

const AC_BASE = 'https://ac.cnstrc.com';
const CONSTRUCTOR_KEY = 'key_r6xzz4IAoTWcipni';

/**
 * Umbral del guard anti-anomalía: si formatPrice es menor a este ratio del
 * listPrice, se considera basura (ej. Coto store 133 devuelve 29.05 con
 * listPrice 2495) y se usa listPrice. Solo atrapa "descuentos" > 90%, que en
 * la práctica siempre son errores de datos — nunca colapsa un descuento real.
 */
const ANOMALY_RATIO = 0.1;

/**
 * Precio efectivo de una fila de sucursal, con guard anti-anomalía.
 */
function resolveStorePrice(row) {
  const list = Number(row.listPrice);
  const format = Number(row.formatPrice);
  const hasList = Number.isFinite(list) && list > 0;
  const hasFormat = Number.isFinite(format) && format > 0;

  if (hasFormat && (!hasList || format >= list * ANOMALY_RATIO)) {
    return { price: format, listPrice: hasList ? list : null };
  }
  if (hasList) {
    return { price: list, listPrice: list };
  }
  return { price: null, listPrice: null };
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

  const priceRows = Array.isArray(data.price) ? data.price : [];
  const storePrices = priceRows
    .filter((row) => row && row.store != null)
    .map((row) => {
      const { price, listPrice } = resolveStorePrice(row);
      return {
        code: String(row.store),
        price,
        listPrice,
        isAvailable: price !== null,
      };
    })
    .filter((sp) => sp.price !== null);

  const image = data.image_url || data.product_large_image_url || data.product_medium_image_url || null;
  const categories = Array.isArray(data.groups)
    ? data.groups.map((g) => g.display_name).filter(Boolean)
    : [];

  return {
    ean: String(eanRaw),
    name: rawItem.value ?? data.sku_display_name ?? null,
    brand: data.product_brand ?? null,
    image,
    images: image ? [image] : [],
    categories,
    link: data.url ? `https://www.coto.com.ar/${String(data.url).replace(/^_\//, '')}` : null,
    storePrices,
  };
}
