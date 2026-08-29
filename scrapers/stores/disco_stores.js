import axios from 'axios';

/**
 * 🏬 Scraper de SUCURSALES de Disco
 *
 * Fuente: VTEX Master Data, entidad "NT" — JSON público, sin browser y sin
 * cookies. Es LA MISMA entidad que usa Jumbo, así que este archivo es hermano
 * directo de `scrapers/stores/jumbo_stores.js` (a diferencia de Dia, cuya
 * entidad "TI" vive bajo `_v/private/` y exige Chromium).
 *
 * Endpoint:
 *   GET https://www.disco.com.ar/api/dataentities/NT/search
 *       ?_fields=id,name,address,postalCode,state,grouping,geocoordinates,
 *                phone,schedule,SellerName,hasPickup,hasDelivery,isActive
 *       &an=discoargentina
 *
 * Cobertura medida (2026-08-29): 76 registros, 71 con isActive=true, 5 en false;
 * 76/76 con geocoordinates.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const BASE_URL = 'https://www.disco.com.ar';

const STORES_ENDPOINT =
  `${BASE_URL}/api/dataentities/NT/search` +
  `?_fields=id,name,address,postalCode,state,grouping,geocoordinates,phone,schedule,SellerName,hasPickup,hasDelivery,isActive` +
  `&an=discoargentina`;

/**
 * ⚠️ El header `REST-Range` NO es opcional: sin él el Master Data devuelve sólo
 * los primeros 16 registros, y lo hace con un 200 silencioso — el único indicio
 * es el header de respuesta `rest-content-range: resources 0-15/76`, que nadie
 * mira. Con el rango puesto, la misma URL devuelve los 76.
 * O sea: omitirlo no rompe, PIERDE 60 sucursales sin avisar. Verificado a mano
 * en 2026-08-29 (16 filas sin header vs 76 con header).
 */
const REST_RANGE = 'resources=0-999';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Corrige mojibake típico de UTF-8 mal interpretado como latin-1
 * ("Ã¡" → "á", "Ã±" → "ñ"). Copiado de `jumbo_stores.js` a propósito: hoy la
 * entidad de Disco viene bien codificada (0/76 registros con marcadores), pero
 * es la misma infraestructura VTEX que sí ensucia la de Jumbo, así que se deja
 * la defensa puesta. Sólo re-decodifica si detecta los marcadores clásicos,
 * para no corromper strings ya correctos.
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
 * Convierte un valor a número finito, o null.
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normaliza un string opcional: null si viene vacío/ausente, con mojibake
 * corregido si viene poblado. Evita emitir "" (que Laravel guardaría como un
 * nombre/dirección vacíos en vez de "no hay dato").
 */
function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = fixMojibake(String(value)).trim();
  return text.length > 0 ? text : null;
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
      console.warn(
        `⚠️ Error de red consultando sucursales Disco, reintentando... (${error.code || error.message})`
      );
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/**
 * Parsea `geocoordinates`.
 *
 * ⚠️ Es un string "latitud,longitud" — LATITUD PRIMERO, igual que la entidad NT
 * de Jumbo y al REVÉS que el campo `geo` de la entidad TI de Dia (que va
 * "lon,lat"). Verificado contra el bounding box de Argentina sobre los 76
 * registros: 76/76 caen dentro leyendo [lat,lon] y 0/76 leyendo [lon,lat].
 * Invertirlo mandaría todas las sucursales al Océano Índico sin fallar en
 * ningún lado — por eso hay un test unitario que fija el orden.
 *
 * Algunos registros traen espacio después de la coma ("-37.02, -56.80") → trim.
 */
export function parseDiscoGeo(raw) {
  if (typeof raw !== 'string' || !raw.includes(',')) {
    return { latitude: null, longitude: null };
  }

  const [lat, lon] = raw.split(',').map((s) => s.trim());

  return {
    latitude: toNumberOrNull(lat),
    longitude: toNumberOrNull(lon),
  };
}

/**
 * Deriva la ciudad de `address`.
 *
 * ⚠️ Los campos `city`, `street`, `number` y `neighborhood` EXISTEN en el
 * esquema de la entidad pero vienen null en 76/76 registros, así que la ciudad
 * hay que sacarla del compuesto `address`, con forma
 * "CALLE - CP - CIUDAD - PROVINCIA" separada por " - " (4 segmentos).
 * La ciudad es el PENÚLTIMO segmento.
 *
 * Funciona en 75/76. El que no matchea ("Ruta 11 km 380 - Costa Esmeralda",
 * 2 segmentos) devuelve null a propósito: preferimos un hueco explícito antes
 * que adivinar "Costa Esmeralda" con una heurística que mañana meta la calle
 * de otro registro corto en el campo ciudad.
 */
export function parseDiscoCity(address) {
  if (typeof address !== 'string') return null;

  const segments = address
    .split(' - ')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Con menos de 3 segmentos no hay forma de saber cuál es la ciudad.
  if (segments.length < 3) return null;

  return cleanString(segments[segments.length - 2]);
}

/**
 * Mapea un registro crudo del Master Data a la forma de store del contrato que
 * consume `App\Services\Stores\StoreSyncService`.
 *
 * Función pura: es la parte unit-testeable, sin red.
 *
 * ⚠️ `external_reference` es `id` (uuid) y NO `SellerName`. `SellerName` parece
 * el candidato natural (es corto y legible) pero COLISIONA: hay sólo 43 valores
 * distintos para las 76 sucursales — `jumboargentinad028` cubre 7 tiendas.
 * Como `StoreSyncService` upsertea por (merchant_id, external_reference), usarlo
 * colapsaría esas 7 en una sola fila. `id` es único 76/76.
 *
 * ⚠️ `province` sale de `state`, no del último segmento de `address`: los dos
 * discrepan en 15/76 registros (ej. una sucursal cuya dirección termina en
 * "CAPITAL FEDERAL" mientras `state` dice "BUENOS AIRES"). Se elige `state` por
 * ser el campo estructurado de la fuente; el texto crudo sigue viajando entero
 * en `address` para poder auditar la discrepancia.
 *
 * ⚠️ `postalCode` es inconsistente entre filas: "7605" numérico en unas y
 * "B1846dgh"/"c1430eph" alfanumérico en otras. Se pasa como STRING tal cual,
 * sin normalizar mayúsculas ni intentar convertirlo a número (un Number() sobre
 * "C1181ACK" daría NaN y perdería el dato).
 *
 * `grouping` (región comercial: "CABA", "COSTA ATLANTICA", "GBA - ZONA SUR"…),
 * `SellerName`, `hasPickup` y `hasDelivery` vienen poblados pero NO forman parte
 * del contrato de StoreSyncService, así que no se emiten.
 */
export function normalizeDiscoStore(record) {
  const { latitude, longitude } = parseDiscoGeo(record?.geocoordinates);
  const address = cleanString(record?.address);

  return {
    external_reference: record?.id != null ? String(record.id) : null,
    name: cleanString(record?.name),
    address,
    city: parseDiscoCity(address),
    province: cleanString(record?.state),
    postal_code: record?.postalCode != null ? String(record.postalCode) : null,
    latitude,
    longitude,
    phone: record?.phone != null ? String(record.phone) : null,
    // Horario como texto libre ("Atención: Lunes a Sábados de 8:30 a 21 hs…").
    // La fuente no lo estructura por día; se pasa tal cual, sin inventar parseo.
    opening_hours: cleanString(record?.schedule),
  };
}

/**
 * Filtra y normaliza el lote crudo.
 *
 * Se descartan: inactivos (isActive !== true), sin identificador y sin
 * coordenadas. El filtro por coordenadas es deliberado y coherente con
 * `jumbo_stores.js` y `dia_stores.js`: una sucursal sin geo no sirve para el
 * "más cercana" y sólo ensucia el selector de sucursal.
 *
 * Función pura: unit-testeable con un fixture.
 */
export function normalizeDiscoStores(records) {
  if (!Array.isArray(records)) return [];

  return records
    .filter((r) => r && r.isActive === true)
    .map(normalizeDiscoStore)
    .filter((s) => s.external_reference && s.latitude !== null && s.longitude !== null);
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Sucursales de Disco
 */
export async function getDiscoStores() {
  console.log('🏬 Iniciando scraper de sucursales de Disco...');

  try {
    const response = await getWithRetry(STORES_ENDPOINT, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        // Ver el comentario de REST_RANGE: sin esto son 16 filas en vez de 76.
        'REST-Range': REST_RANGE,
      },
      timeout: 20000,
    });

    const records = Array.isArray(response.data) ? response.data : [];
    console.log(
      `📊 ${records.length} registros recibidos del Master Data (entidad NT) ` +
        `[rest-content-range: ${response.headers['rest-content-range'] ?? 'n/d'}]`
    );

    const stores = normalizeDiscoStores(records);

    const descartados = records.length - stores.length;
    console.log(
      `🎉 Sucursales de Disco normalizadas: ${stores.length} ` +
        `(${descartados} descartadas: inactivas o sin coordenadas)`
    );

    return {
      success: true,
      source: 'disco',
      total: stores.length,
      stores,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de sucursales Disco:', error.message);

    return {
      success: false,
      source: 'disco',
      total: 0,
      stores: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
