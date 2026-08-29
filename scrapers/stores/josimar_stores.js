import axios from 'axios';

/**
 * 🏬 Scraper de SUCURSALES de Josimar
 *
 * Fuente primaria: API pública de checkout de VTEX (sin auth, sin cookie, sin
 * browser — a diferencia de Dia, cuya entidad vive bajo `_v/private/`):
 *   GET /api/checkout/pub/pickup-points?geoCoordinates={lon};{lat}
 *
 * ⚠️ `geoCoordinates` es OBLIGATORIO: sin el parámetro la API responde 400. Y
 * NO es un filtro cosmético — devuelve los pickup points cercanos al punto que
 * se le pase. Desde cualquier coordenada del GBA sur devuelve las 11 entradas
 * (las 9 sucursales reales, ver dedupe abajo); desde Mar del Plata, Rosario o
 * Córdoba devuelve **0**. Por eso la coordenada de consulta está fija en el
 * centro geográfico de la cadena (Lanús/Lomas), y no es un dato de prueba que
 * se pueda "limpiar": cambiarla por el centro del país vaciaría el scraper.
 *
 * ⚠️ **`address.geoCoordinates` es un ARRAY `[longitud, latitud]` — longitud
 * PRIMERO.** Es el formato canónico de VTEX (GeoJSON), y coincide con el orden
 * del string `geo` del Master Data de Dia, pero está al revés del string
 * "lat,lng" de la entidad NT de Jumbo. Verificado contra el bounding box de
 * Argentina sobre las 11 entradas: leyendo `[lon,lat]` las 11 caen dentro del
 * país; leyendo `[lat,lon]` caen 0 (terminarían en el Océano Índico, cerca de
 * las Kerguelen). Hay un test unitario que fija este orden.
 *
 * ⚠️ **Dedupe por código de tienda, no por `id`.** La API devuelve la MISMA
 * sucursal de Quilmes dos veces con dos identificadores distintos:
 * `1_S009001` y `1_arjosimarprod-S009001` (misma dirección, mismas coordenadas).
 * Y la de peor identificador es la que trae los datos buenos: la variante
 * `arjosimarprod-S009001` viene con `businessHours: []` mientras la otra trae
 * los 7 días. Por eso el `external_reference` se deriva del CÓDIGO de tienda
 * (`S009001`, sacándole el prefijo de seller `1_` y el de cuenta
 * `arjosimarprod-`) y, ante dos registros con el mismo código, se queda el que
 * tenga más horarios. Deduplicar por `id` crudo dejaría dos filas para la misma
 * sucursal en `merchant_stores`, y quedarse con la primera perdería los horarios.
 *
 * ⚠️ Se descartan los `isActive: false`: la API devuelve una segunda entrada de
 * Berazategui (`S010001`) con coordenadas 30 cm corridas y código postal
 * distinto respecto de la activa (`S001001`) — es un registro viejo, no una
 * sucursal más. 11 entradas − 1 inactiva − 1 duplicada = **9 sucursales**.
 *
 * Complemento: `GET /files/storeSelectorConfig-master.json` es el archivo que
 * alimenta el selector "elegí tu tienda" del sitio y trae TELÉFONO de las 5
 * tiendas con venta online. Se usa SÓLO para el teléfono, y sólo cuando el
 * cruce por nombre es inequívoco (ver `buildPhoneIndex`). Deliberadamente NO se
 * toman de ahí las coordenadas: la entrada de Berazategui declara
 * `longitude: -582085048049979` (le falta el punto decimal), o sea 13 órdenes
 * de magnitud fuera del planeta. Las coordenadas buenas son las de pickup-points.
 * Si el archivo no responde, los teléfonos quedan en null y el scraper sigue:
 * un enriquecimiento opcional no puede tumbar la fuente principal.
 *
 * Precios: hoy estas sucursales sirven para el "más cercana" y la ficha del
 * comercio, NO para precios por sucursal — Josimar no escribe
 * `merchant_store_prices` ni entra al `StorePricingRegistry`. Ojo con leer eso
 * como "el precio no varía por sucursal": sí varía, en el 1,4% del catálogo
 * medido y con spreads de hasta 25%. El detalle y el porqué de que la decisión
 * siga pendiente están en la cabecera de `scrapers/josimar.js`. Además sólo 5
 * de estas 9 sucursales tienen sales channel propio (Berazategui, Pringles,
 * Barracas, Colombres, Quilmes); las otras 4 no cotizan por separado.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const BASE_URL = 'https://www.josimar.com.ar';

/**
 * Centro geográfico de la cadena (Lanús / Lomas de Zamora), en el orden
 * "lon;lat" que exige el parámetro. Ver el caveat de cabecera: NO es un valor
 * arbitrario, es lo que hace que la API devuelva las 11 entradas.
 */
const QUERY_GEO = '-58.3916;-34.7036';

const PICKUP_POINTS_ENDPOINT = `${BASE_URL}/api/checkout/pub/pickup-points?geoCoordinates=${QUERY_GEO}`;
const STORE_SELECTOR_ENDPOINT = `${BASE_URL}/files/storeSelectorConfig-master.json`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const REQUEST_CONFIG = {
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  timeout: 20000,
};

/**
 * `businessHours[].DayOfWeek` sigue la convención de VTEX/JS: **0 = domingo**.
 *
 * Evidencia (no es una suposición por la convención): en las 10 sucursales con
 * horarios, el día 0 es siempre el que abre más tarde (08:30 contra 08:00 de
 * los días 1..6). Y el `timetable` en texto del storeSelectorConfig dice
 * "Lunes a Sabados de 8 a 21hs" para Pringles, cuyos días 1..6 abren
 * efectivamente a las 08:00. Si 0 fuese lunes, el lunes abriría 08:30 y el
 * domingo 08:00, que contradice ese texto.
 */
const DAY_NAMES = {
  0: 'domingo',
  1: 'lunes',
  2: 'martes',
  3: 'miercoles',
  4: 'jueves',
  5: 'viernes',
  6: 'sabado',
};

/**
 * GET con 1 reintento ante error de red / timeout.
 */
async function getWithRetry(url, config = REQUEST_CONFIG, retries = 1) {
  try {
    return await axios.get(url, config);
  } catch (error) {
    const isNetwork = !error.response;
    if (isNetwork && retries > 0) {
      console.warn(
        `⚠️ Error de red consultando sucursales Josimar, reintentando... (${error.code || error.message})`
      );
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/**
 * Convierte un valor a número finito, o null.
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Colapsa espacios y recorta; null si queda vacío.
 */
function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

/* ------------------------------------------------------------------------ *
 *  Funciones PURAS (sin red) — es lo que se testea con fixtures              *
 * ------------------------------------------------------------------------ */

/**
 * Parsea `address.geoCoordinates`.
 *
 * ⚠️ Es un ARRAY `[longitud, latitud]` — longitud PRIMERO (GeoJSON, el formato
 * canónico de VTEX). Invertirlo manda las 9 sucursales del GBA sur al Índico
 * sin que falle nada ruidosamente. Ver el caveat de cabecera.
 */
export function parsePickupGeo(raw) {
  if (!Array.isArray(raw) || raw.length < 2) {
    return { latitude: null, longitude: null };
  }

  return {
    longitude: toNumberOrNull(raw[0]),
    latitude: toNumberOrNull(raw[1]),
  };
}

/**
 * Deriva el código de tienda estable a partir del identificador del pickup
 * point o de su `addressId`.
 *
 * Formas reales observadas para la MISMA sucursal de Quilmes:
 *   "1_arjosimarprod-S009001" / "arjosimarprod-S009001" → "S009001"
 *   "1_S009001"               / "S009001"               → "S009001"
 *
 * Se saca el prefijo de seller (`{sellerId}_`) y el de cuenta VTEX
 * (`arjosimarprod-`). Sin esta normalización el dedupe no encuentra el par y
 * quedan dos filas para la misma tienda en `merchant_stores`.
 */
export function storeCode(rawId) {
  const text = clean(rawId);
  if (!text) return null;

  return (
    text
      // prefijo de seller: "1_"
      .replace(/^\d+_/, '')
      // prefijo de cuenta VTEX: "arjosimarprod-"
      .replace(/^arjosimarprod-/i, '')
      .trim() || null
  );
}

/**
 * Recorta "08:30:00" → "08:30". Deja el valor tal cual si no matchea.
 */
function shortTime(value) {
  const text = clean(value);
  if (!text) return null;
  const match = text.match(/^(\d{1,2}):(\d{2})/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : text;
}

/**
 * Mapea `businessHours` a `{ lunes: "08:00-21:30", ..., domingo: "08:30-21:00" }`.
 *
 * Devuelve null si no hay horarios (pasa con la entrada duplicada de Quilmes,
 * que trae el array vacío). Los días con `DayOfWeek` fuera de 0..6 se descartan
 * en vez de adivinar a qué día corresponden.
 */
export function mapBusinessHours(businessHours) {
  if (!Array.isArray(businessHours) || businessHours.length === 0) return null;

  const hours = {};

  for (const entry of businessHours) {
    const day = DAY_NAMES[Number(entry?.DayOfWeek)];
    if (!day) continue;

    const open = shortTime(entry?.OpeningTime);
    const close = shortTime(entry?.ClosingTime);
    if (!open || !close) continue;

    hours[day] = `${open}-${close}`;
  }

  return Object.keys(hours).length > 0 ? hours : null;
}

/**
 * Slug de nombre de sucursal para cruzar pickup-points con storeSelectorConfig.
 * Saca acentos, el prefijo "josimar" y todo lo que no sea alfanumérico:
 * "Josimar Monte Grande" y "Monte Grande" colapsan al mismo slug.
 */
export function slugifyStoreName(name) {
  const text = clean(name);
  if (!text) return null;

  const slug = text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/^josimar\s+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return slug || null;
}

/**
 * Índice slug-de-nombre → teléfono, a partir del storeSelectorConfig.
 *
 * ⚠️ Sólo se indexan los slugs que aparecen UNA vez. Si dos tiendas del archivo
 * colapsaran al mismo slug el cruce dejaría de ser inequívoco y se prefiere no
 * asignar teléfono antes que asignar el de otra sucursal: un teléfono
 * equivocado en la ficha es peor que un teléfono ausente.
 *
 * Del archivo se toma SÓLO el teléfono. Sus coordenadas están rotas (ver el
 * caveat de cabecera) y su dirección viene en formatos heterogéneos.
 */
export function buildPhoneIndex(config) {
  const provinces = config?.master?.provinces;
  if (!Array.isArray(provinces)) return new Map();

  const counts = new Map();
  const phones = new Map();

  for (const province of provinces) {
    const stores = Array.isArray(province?.stores) ? province.stores : [];

    for (const store of stores) {
      const slug = slugifyStoreName(store?.name);
      if (!slug) continue;

      counts.set(slug, (counts.get(slug) ?? 0) + 1);

      const phone = clean(store?.phone);
      if (phone) phones.set(slug, phone);
    }
  }

  // Descartar los ambiguos.
  for (const [slug, count] of counts) {
    if (count > 1) phones.delete(slug);
  }

  return phones;
}

/**
 * Mapea un pickup point crudo al contrato de sucursal que consume
 * `App\Services\Stores\StoreSyncService`.
 *
 * Función pura: es la parte unit-testeable, sin red.
 */
export function normalizeJosimarStore(pickupPoint, phoneIndex = new Map()) {
  const address = pickupPoint?.address ?? {};
  const { latitude, longitude } = parsePickupGeo(address.geoCoordinates);

  const name = clean(pickupPoint?.friendlyName);

  // La calle y la altura vienen en campos separados; el contrato pide una sola
  // línea. `neighborhood` NO se concatena: es dato de zona, no de dirección, y
  // sólo 3 de las 9 sucursales lo traen.
  const street = clean(address.street);
  const number = clean(address.number);
  const fullAddress = [street, number].filter(Boolean).join(' ') || null;

  const slug = slugifyStoreName(name);

  return {
    // El código de tienda, no el `id`: ver el caveat de dedupe en la cabecera.
    external_reference: storeCode(pickupPoint?.id ?? address.addressId),
    name,
    address: fullAddress,
    city: clean(address.city),
    province: clean(address.state),
    postal_code: clean(address.postalCode),
    latitude,
    longitude,
    // Teléfono sólo si el cruce con el storeSelectorConfig es inequívoco.
    phone: (slug && phoneIndex.get(slug)) || null,
    opening_hours: mapBusinessHours(pickupPoint?.businessHours),
  };
}

/**
 * Filtra, normaliza y deduplica el lote crudo de pickup-points.
 *
 * Orden de las decisiones (importa):
 *   1. Se descartan los `isActive: false` (el Berazategui viejo).
 *   2. Se normaliza cada uno.
 *   3. Se descartan los que no tienen `external_reference` o no tienen
 *      coordenadas — mismo criterio que `jumbo_stores.js` y `dia_stores.js`:
 *      una sucursal sin geo no sirve para el "más cercana" y ensucia el selector.
 *   4. Se deduplica por `external_reference` quedándose con el registro que
 *      trae MÁS horarios (la variante `arjosimarprod-S009001` de Quilmes viene
 *      con `businessHours: []`; quedarse con la primera perdería los 7 días).
 *
 * Función pura: unit-testeable con un fixture.
 *
 * @param {Array} items       `items[]` de la respuesta de pickup-points
 * @param {Map}   phoneIndex  slug de nombre → teléfono (ver `buildPhoneIndex`)
 */
export function normalizeJosimarStores(items, phoneIndex = new Map()) {
  if (!Array.isArray(items)) return [];

  const byReference = new Map();

  for (const item of items) {
    const pickupPoint = item?.pickupPoint ?? item;
    if (!pickupPoint || pickupPoint.isActive === false) continue;

    const store = normalizeJosimarStore(pickupPoint, phoneIndex);

    if (!store.external_reference) continue;
    if (store.latitude === null || store.longitude === null) continue;

    const previous = byReference.get(store.external_reference);

    if (!previous) {
      byReference.set(store.external_reference, store);
      continue;
    }

    // Duplicado: gana el que tenga más días de horario cargados.
    const previousDays = previous.opening_hours ? Object.keys(previous.opening_hours).length : 0;
    const currentDays = store.opening_hours ? Object.keys(store.opening_hours).length : 0;

    if (currentDays > previousDays) {
      byReference.set(store.external_reference, store);
    }
  }

  return [...byReference.values()];
}

/* ------------------------------------------------------------------------ *
 *  Capa de red                                                              *
 * ------------------------------------------------------------------------ */

/**
 * Trae el índice de teléfonos del storeSelectorConfig.
 * Best-effort: si el archivo falla, devuelve un índice vacío y los teléfonos
 * quedan en null. Un enriquecimiento opcional no puede tumbar el scraper.
 */
async function fetchPhoneIndex() {
  try {
    const response = await getWithRetry(STORE_SELECTOR_ENDPOINT);
    const index = buildPhoneIndex(response.data);
    console.log(`📞 ${index.size} teléfonos disponibles en el storeSelectorConfig`);
    return index;
  } catch (error) {
    console.warn(
      `⚠️ No se pudo leer el storeSelectorConfig (${error.message}); los teléfonos quedan en null.`
    );
    return new Map();
  }
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Sucursales de Josimar
 */
export async function getJosimarStores() {
  console.log('🏬 Iniciando scraper de sucursales de Josimar...');

  try {
    const response = await getWithRetry(PICKUP_POINTS_ENDPOINT);

    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    console.log(`📊 ${items.length} pickup points recibidos de la API de checkout`);

    if (items.length === 0) {
      // Devolver 0 en silencio se lee como "Josimar no tiene sucursales" y es
      // indistinguible de "se rompió". La causa más probable es que la
      // coordenada de consulta dejó de caer cerca de la cadena.
      console.warn(
        `⚠️ La API no devolvió pickup points para geoCoordinates=${QUERY_GEO}. ` +
          'Revisar que la coordenada siga cayendo en el GBA sur.'
      );
    }

    const phoneIndex = await fetchPhoneIndex();
    const stores = normalizeJosimarStores(items, phoneIndex);

    const descartados = items.length - stores.length;
    const conTelefono = stores.filter((s) => s.phone).length;

    console.log(
      `🎉 Sucursales de Josimar normalizadas: ${stores.length} ` +
        `(${descartados} descartadas: inactivas, duplicadas o sin coordenadas; ${conTelefono} con teléfono)`
    );

    return {
      success: true,
      source: 'josimar',
      total: stores.length,
      stores,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de sucursales Josimar:', error.message);

    return {
      success: false,
      source: 'josimar',
      total: 0,
      stores: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
