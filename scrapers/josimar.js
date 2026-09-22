import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { productEans } from '../cores/categories.js';
import {
  isRetryableError,
  normalizeCatalogProduct,
  parseResourcesTotal,
  scrapeVtexCatalog,
} from '../cores/vtexCatalog.js';

// Se re-exportan para los consumidores (y tests) que ya los importaban de acá.
export { isRetryableError, parseResourcesTotal };

/**
 * 🛒 Scraper de PRODUCTOS de Josimar (FOLLOWER)
 *
 * Josimar (www.josimar.com.ar, cuenta VTEX `arjosimarprod`) es una cadena del
 * sur del GBA — Lanús, Lomas de Zamora, Avellaneda, Quilmes, Berazategui,
 * Monte Grande y Barracas — fundada en 1964. Es un comercio NUEVO del proyecto.
 *
 * Fuente: VTEX **Catalog System REST** (público, sin auth, sin browser), recorrido
 * con el core compartido `cores/vtexCatalog.js`, el mismo que usan los otros 7
 * comercios VTEX desde SCRAPER-001. Este archivo fue el origen de ese core: el
 * recorrido por categoría con descenso adaptativo nació acá y se generalizó.
 *
 * ⚠️ **Por qué recorrer por categoría y no paginar el catálogo plano**: la API
 * responde HTTP 400 (Parameter _from can not be greater than 2500) en cuanto se
 * pide `_from > 2500`. El catálogo son 5691 productos, o sea que NO entra en una
 * sola ventana, pero sí entra departamento por departamento: el más grande es
 * Almacén (id 1) con 2260 productos, holgadamente por debajo del tope. Si un
 * departamento supera la ventana, el core baja a sus hijos — **con el path
 * completo** (`C:/1/17/`): el recorrido propio que tenía este archivo consultaba el
 * hijo suelto (`C:/17/`), que en VTEX devuelve 0, y habría perdido el
 * departamento entero en silencio el día que Almacén pasara el tope.
 *
 * ⚠️ **Josimar recorre SIN canal y SIN filtro de disponibilidad**, a diferencia de
 * los otros 7. Su catálogo no es compartido con otra cadena (el de Disco, Jumbo y
 * Vea sí), así que no hace falta filtrar, y recorrer también lo que está sin stock
 * es lo que permite escribir `is_available = false` en vez de contarlo como
 * ausencia. Sin `sc` la API usa el canal por defecto del host (el 5).
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
 * la cobertura. La referencia honesta es el 5691 del catálogo plano (el
 * `expectedTotal` que ahora reporta cada corrida).
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

/**
 * Normaliza un producto crudo del Catalog System al formato de los save handlers.
 *
 * Es `normalizeCatalogProduct` con la configuración de Josimar: **no** exige
 * imagen, porque es follower (`saveFollowerProduct` sólo escribe precio,
 * disponibilidad y URL) y descartar por falta de imagen tiraría un precio válido.
 * En la práctica el 100% del catálogo trae imagen; el criterio importa el día que no.
 */
export function normalizeJosimarProduct(rawProduct, baseUrl = BASE_URL) {
  return normalizeCatalogProduct(rawProduct, { baseUrl, source: 'josimar' });
}

/** Normaliza un lote crudo descartando los que no pasan el filtro. */
export function normalizeJosimarProducts(rawProducts, baseUrl = BASE_URL) {
  if (!Array.isArray(rawProducts)) return [];
  return rawProducts
    .map((raw) => normalizeJosimarProduct(raw, baseUrl))
    .filter((product) => product !== null);
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Productos de Josimar (FOLLOWER)
 *
 * @param {'categories'|'eans'} mode  cualquier otro valor (incluido `search`, que es
 *                        la vuelta atrás de los otros 7) recorre las categorías.
 * @param {Object}   [options]
 * @param {string[]} [options.categoryIds]     recorrer sólo estos departamentos (corridas acotadas).
 * @param {Function|null} [options.onProductFound] handler de guardado; `null` = corrida en seco,
 *                        sin tocar la base (verificar la fuente sin escribir precios).
 * @param {Function} [options.httpGet] / [options.sleep]  inyectables para tests.
 */
export async function getJosimarMainProducts(mode = 'categories', options = {}) {
  const { categoryIds = null, onProductFound = saveFollowerProduct, ...overrides } = options;

  return scrapeVtexCatalog({
    merchantName: 'Josimar',
    baseUrl: BASE_URL,
    source: 'josimar',
    salesChannel: null,
    onlyAvailable: false,
    requireImage: false,
    onProductFound,
    mode: mode === 'eans' ? 'eans' : 'categories',
    eans: productEans,
    categoryPaths: categoryIds && categoryIds.length > 0 ? categoryIds.map((id) => `/${id}/`) : null,
    ...overrides,
  });
}
