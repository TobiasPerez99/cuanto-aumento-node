import axios from 'axios';

/**
 * 🏬 Scraper de SUCURSALES de Jumbo
 *
 * Fuente: VTEX Master Data (entidad "NT") — JSON público, server-side.
 * Endpoint: https://www.jumbo.com.ar/api/dataentities/NT/search
 *
 * Devuelve un array de registros de sucursal. Los campos relevantes:
 *   - id             → identificador estable de la sucursal
 *   - name           → nombre de la sucursal
 *   - address        → dirección (puede venir en latin-1 / mojibake)
 *   - phone          → teléfono
 *   - schedule       → horarios (string/array; puede venir en latin-1 / mojibake)
 *   - geocoordinates → string "lat,lng" (⚠️ latitud primero). En algunas
 *                      entidades VTEX puede venir como array [lng, lat].
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const BASE_URL = 'https://www.jumbo.com.ar';
const STORES_ENDPOINT =
  `${BASE_URL}/api/dataentities/NT/search` +
  `?_fields=name,geocoordinates,id,state,schedule,services,paymentMethods,opening,address,phone` +
  `&an=jumboargentina`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Corrige mojibake típico de UTF-8 mal interpretado como latin-1
 * (ej: "Ã¡" → "á", "Ã±" → "ñ"). Solo re-decodifica si detecta los
 * marcadores clásicos, para no corromper strings ya correctos.
 */
function fixMojibake(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (!/[ÃÂ]/.test(value)) return value;
  try {
    const fixed = Buffer.from(value, 'latin1').toString('utf8');
    // Si al re-decodificar aparece el caracter de reemplazo, preferimos el original.
    return fixed.includes('�') ? value : fixed;
  } catch {
    return value;
  }
}

/**
 * Aplica fixMojibake recursivamente sobre strings dentro de un valor
 * (string / array / objeto). Se usa para horarios que a veces vienen
 * como array u objeto anidado.
 */
function fixMojibakeDeep(value) {
  if (typeof value === 'string') return fixMojibake(value);
  if (Array.isArray(value)) return value.map(fixMojibakeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = fixMojibakeDeep(v);
    return out;
  }
  return value;
}

/**
 * Convierte un valor a número de forma segura (null si no es parseable).
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
      console.warn(`⚠️ Error de red consultando sucursales Jumbo, reintentando... (${error.code || error.message})`);
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/**
 * Parsea las coordenadas de un registro de Master Data.
 * La entidad NT de Jumbo entrega un string "lat,lng" (latitud primero,
 * con posible espacio tras la coma). Como fallback defensivo se acepta
 * el formato array [lng, lat] que usan otras entidades VTEX.
 */
function parseGeo(raw) {
  if (typeof raw === 'string' && raw.includes(',')) {
    const [a, b] = raw.split(',').map((s) => s.trim());
    return { latitude: toNumberOrNull(a), longitude: toNumberOrNull(b) };
  }
  if (Array.isArray(raw) && raw.length >= 2) {
    return { latitude: toNumberOrNull(raw[1]), longitude: toNumberOrNull(raw[0]) };
  }
  return { latitude: null, longitude: null };
}

/**
 * Mapea un registro crudo de Master Data a la forma de store del contrato.
 */
function normalizeStore(record) {
  const { latitude, longitude } = parseGeo(record.geocoordinates);

  return {
    external_reference: record.id != null ? String(record.id) : null,
    name: fixMojibake(record.name) ?? null,
    address: fixMojibake(record.address) ?? null,
    // Master Data no discrimina ciudad/provincia/CP en esta entidad → null salvo que existan.
    city: fixMojibake(record.city) ?? null,
    province: fixMojibake(record.state) ?? null,
    postal_code: record.postal_code != null ? String(record.postal_code) : null,
    latitude,
    longitude,
    phone: record.phone != null ? String(record.phone) : null,
    // Horarios tal cual los entrega la fuente (string/array/objeto), con encoding corregido.
    opening_hours: record.schedule != null ? fixMojibakeDeep(record.schedule) : null,
  };
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Sucursales de Jumbo
 */
export async function getJumboStores() {
  console.log('🏬 Iniciando scraper de sucursales de Jumbo...');

  try {
    const response = await getWithRetry(STORES_ENDPOINT, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      timeout: 20000,
    });

    const records = Array.isArray(response.data) ? response.data : [];
    console.log(`📊 ${records.length} sucursales recibidas de Master Data`);

    const stores = records
      .map(normalizeStore)
      // Descartamos registros sin identificador o sin coordenadas útiles.
      .filter((s) => s.external_reference && s.latitude !== null && s.longitude !== null);

    console.log(`🎉 Sucursales de Jumbo normalizadas: ${stores.length}`);

    return {
      success: true,
      source: 'jumbo',
      total: stores.length,
      stores,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de sucursales Jumbo:', error.message);
    return {
      success: false,
      source: 'jumbo',
      total: 0,
      stores: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
