import { getCache, setCache } from '../config/redis.js';
import { teaserName } from '../scrapers/promos/dia.js';

/**
 * 🏷️ Teasers de VTEX juntados DURANTE la corrida de productos
 *
 * Los teasers (`commertialOffer.Teasers`: "2x1", "-50% 2da unidad") son promos de
 * producto que sólo se ven producto por producto. En Farmacity no hay una colección
 * estable que los agrupe, así que verlos todos exige recorrer el catálogo entero:
 * medido el 2026-10-10, **378 requests y 7,5 minutos**. Eso no entra en un pull de
 * promos (Laravel corta a los 300 s), y además la corrida de productos ya recorre ese
 * mismo catálogo cada 3 horas.
 *
 * Entonces: la corrida de productos los junta al pasar (gancho `onRawProducts` de
 * `scrapeVtexCatalog`) y, si terminó COMPLETA, deja una foto. El scraper de promos
 * lee la foto en vez de recorrer de nuevo.
 *
 * Dónde vive la foto: en memoria del proceso (los scrapers corren dentro del mismo
 * Express que sirve `/api/promotions/*`) y en Redis si está configurado, para que
 * sobreviva a un reinicio del contenedor. Sin ninguna de las dos (recién deployado,
 * antes de la primera corrida de productos) no hay foto y las promos de producto
 * simplemente no salen esa vez: la staging de Laravel conserva las de ayer.
 */

/** La foto vale dos días: la corrida de productos es cada 3 h, así que sobra margen. */
const SNAPSHOT_TTL_SECONDS = 2 * 24 * 3600;
const MAX_SAMPLES = 5;

const memory = new Map();

function commercialOffer(product) {
  const item = product?.items?.[0];
  const seller = item?.sellers?.find((s) => s?.sellerDefault) || item?.sellers?.[0];
  return seller?.commertialOffer ?? null;
}

/**
 * Acumula, por nombre de teaser, cuántos productos lo tienen y una muestra con EAN.
 * Un producto se cuenta una vez por teaser aunque aparezca en dos categorías.
 */
export function createTeaserCollector({ maxSamples = MAX_SAMPLES } = {}) {
  const byName = new Map();

  return {
    collect(rawProducts) {
      for (const product of Array.isArray(rawProducts) ? rawProducts : []) {
        const teasers = commercialOffer(product)?.Teasers;
        if (!Array.isArray(teasers)) continue;
        const productKey = String(product?.productId ?? product?.items?.[0]?.ean ?? '');
        for (const teaser of teasers) {
          const name = teaserName(teaser);
          if (!name) continue;
          let entry = byName.get(name);
          if (!entry) {
            entry = { name, products: new Set(), samples: [] };
            byName.set(name, entry);
          }
          if (entry.products.has(productKey)) continue;
          entry.products.add(productKey);
          if (entry.samples.length < maxSamples) {
            entry.samples.push({ ean: product?.items?.[0]?.ean ?? null, name: product?.productName ?? null });
          }
        }
      }
    },

    snapshot(meta = {}) {
      return {
        captured_at: new Date().toISOString(),
        ...meta,
        teasers: [...byName.values()].map(({ name, products, samples }) => ({
          name,
          product_count: products.size,
          sample_products: samples,
        })),
      };
    },
  };
}

const cacheKey = (key) => `teasers:${key}`;

export async function saveTeaserSnapshot(key, snapshot) {
  memory.set(key, snapshot);
  await setCache(cacheKey(key), snapshot, SNAPSHOT_TTL_SECONDS);
}

/**
 * La foto vigente, o null. Una foto más vieja que su TTL no sirve aunque siga en
 * memoria: si la corrida de productos dejó de terminar completa, publicar sus
 * teasers sería afirmar promos que ya nadie vio.
 */
export async function loadTeaserSnapshot(key, now = new Date()) {
  const snapshot = memory.get(key) ?? (await getCache(cacheKey(key))) ?? null;
  if (!snapshot) return null;
  const age = now.getTime() - Date.parse(snapshot.captured_at);
  return Number.isFinite(age) && age <= SNAPSHOT_TTL_SECONDS * 1000 ? snapshot : null;
}

/** Sólo para tests. */
export function forgetTeaserSnapshots() {
  memory.clear();
}
