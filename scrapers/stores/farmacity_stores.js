import axios from 'axios';
import { clean } from '../../cores/promoText.js';

/**
 * 🏬 Scraper de SUCURSALES de Farmacity
 *
 * Fuente: la API del localizador de /farmacity/sucursales (componente
 * `farmacityar.branch-and-services`), que la identificó la pasante Natalia Rojas:
 *   GET  https://app-landing-api-prod.azurewebsites.net/sucursales/all  → ids (~394)
 *   POST https://app-landing-api-prod.azurewebsites.net/sucursales      → detalle de
 *        hasta 20 ids por pedido (body: ["2","3",…]), como hace el sitio
 *
 * ⚠️ **Pide un Bearer token** (sin él, 401). No es un secreto de usuario: viaja fijo
 * dentro del bundle JS del componente. Se lee del bundle en cada corrida (página →
 * versión del componente → bundle → `Bearer …`) y, si eso falla, se usa el último
 * conocido. Si Farmacity lo rota, la lectura del bundle lo sigue sola.
 *
 * ⚠️ **En `/sucursales/all` latitud y longitud vienen INVERTIDAS** ("Latitude":
 * "-58.37", "Longitude": "-34.60"); en el detalle vienen bien. Se usan las del
 * detalle, y además se validan contra la caja de Argentina: un par que sólo entra
 * dado vuelta se da vuelta, y uno que no entra de ninguna forma queda en null.
 *
 * ⚠️ **No todo es una sucursal:** `FormatId` 2 (CDC / droguería) y 7 (e-commerce /
 * logística) son depósitos y se descartan.
 *
 * Horarios: `TimeTables` por día (1 = lunes … 7 = domingo, 8 = feriados), con un
 * segundo turno opcional (`Open2`/`Close2`) y `is24hs`. Un día ausente = cerrado.
 *
 * NO lanza excepciones al caller: ante error devuelve `{ success:false, ... }`.
 */

const API = 'https://app-landing-api-prod.azurewebsites.net';
const LOCATOR_PAGE = 'https://www.farmacity.com/farmacity/sucursales';
const BUNDLE_URL = (version) =>
  `https://farmacityar.vtexassets.com/_v/public/assets/v1/published/farmacityar.branch-and-services@${version}/public/react/AppGeneralApp.min.js`;

/** El token que traía el bundle `farmacityar.branch-and-services@0.0.8` el 2026-10-10. */
export const FALLBACK_TOKEN = 'fc24a657-c4ba-347a-b051-8703fca93b47';

const BATCH_SIZE = 20;

/** Depósitos, no sucursales. */
export const EXCLUDED_FORMATS = { 2: 'CDC / Droguería', 7: 'E-Commerce / Logística' };

const DAYS = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 7: 'Domingo', 8: 'Feriados' };

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const defaultHttp = ({ method = 'GET', url, data, headers = {} }) =>
  axios({
    method,
    url,
    data,
    headers: { 'User-Agent': USER_AGENT, ...headers },
    timeout: 30000,
    validateStatus: () => true,
  });

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Versión del componente del localizador dentro del HTML de la página. */
export function findComponentVersion(html) {
  return String(html ?? '').match(/farmacityar\.branch-and-services@(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

/** El Bearer que el componente manda a la API. */
export function findToken(js) {
  return String(js ?? '').match(/Bearer ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1] ?? null;
}

/** Token vigente: el del bundle publicado, o el último conocido si no se pudo leer. */
export async function resolveToken({ http = defaultHttp } = {}) {
  try {
    const page = await http({ url: LOCATOR_PAGE });
    const version = page.status === 200 ? findComponentVersion(page.data) : null;
    if (!version) throw new Error('no se encontró la versión del componente del localizador');
    const bundle = await http({ url: BUNDLE_URL(version) });
    const token = bundle.status === 200 ? findToken(bundle.data) : null;
    if (!token) throw new Error(`el bundle ${version} no trae el token`);
    return { token, source: 'bundle', version };
  } catch (error) {
    console.warn(`⚠️ Farmacity: no se pudo leer el token del bundle (${error.message}); se usa el último conocido.`);
    return { token: FALLBACK_TOKEN, source: 'fallback', version: null };
  }
}

const inArgentina = (lat, lon) => lat >= -56 && lat <= -21 && lon >= -74 && lon <= -53;

/** "-34,60239" o "-34.60239" → número; null si no es un número distinto de 0. */
function toCoordinate(value) {
  if (value === null || value === undefined) return null;
  let text = String(value).trim().replace(',', '.');
  const parts = text.split('.');
  if (parts.length > 2) text = `${parts[0]}.${parts.slice(1).join('')}`;
  const n = Number(text);
  return Number.isFinite(n) && n !== 0 ? n : null;
}

/** Latitud y longitud validadas contra Argentina (dadas vuelta si sólo entran así). */
export function normalizeCoordinates(rawLat, rawLon) {
  const lat = toCoordinate(rawLat);
  const lon = toCoordinate(rawLon);
  if (lat === null || lon === null) return { latitude: null, longitude: null };
  if (inArgentina(lat, lon)) return { latitude: lat, longitude: lon };
  if (inArgentina(lon, lat)) return { latitude: lon, longitude: lat };
  return { latitude: null, longitude: null };
}

const hhmm = (value) => (typeof value === 'string' && /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : null);

/** `{ "Lunes": "08:30 a 20:00", "Sábado": "09:00 a 13:00 y 16:00 a 20:00", … }`. */
export function formatOpeningHours(timetables) {
  const hours = {};
  const sorted = (Array.isArray(timetables) ? timetables : [])
    .filter((t) => DAYS[t?.DayOfWeek])
    .sort((a, z) => a.DayOfWeek - z.DayOfWeek);

  for (const t of sorted) {
    if (t.is24hs) {
      hours[DAYS[t.DayOfWeek]] = 'Abierto 24 hs';
      continue;
    }
    const shifts = [[t.Open1, t.Close1], [t.Open2, t.Close2]]
      .map(([open, close]) => [hhmm(open), hhmm(close)])
      .filter(([open, close]) => open && close && !(open === '00:00' && close === '00:00'))
      .map(([open, close]) => `${open} a ${close}`);
    if (shifts.length) hours[DAYS[t.DayOfWeek]] = shifts.join(' y ');
  }
  return Object.keys(hours).length ? hours : null;
}

/** Detalle de la API → contrato de `StoreSyncService`. Función pura. */
export function normalizeFarmacityStore(raw) {
  const street = clean(raw?.Address);
  const number = raw?.AddressNumber ? String(raw.AddressNumber).trim() : '';
  return {
    external_reference: raw?.Id != null ? String(raw.Id) : null,
    name: clean(raw?.Name),
    address: street ? clean(`${street} ${number}`) : null,
    city: clean(raw?.City),
    province: clean(raw?.Province),
    postal_code: null,
    ...normalizeCoordinates(raw?.Latitude, raw?.Longitude),
    phone: clean(raw?.Telephone),
    opening_hours: formatOpeningHours(raw?.TimeTables),
  };
}

/** ¿Es una sucursal a la que va la gente, o un depósito? */
export function isRetailStore(raw) {
  return !(Number(raw?.FormatId) in EXCLUDED_FORMATS);
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Sucursales de Farmacity
 */
export async function getFarmacityStores({ http = defaultHttp, sleep = defaultSleep, delayMs = 300 } = {}) {
  console.log('🏬 Iniciando scraper de sucursales de Farmacity...');

  try {
    const { token, source } = await resolveToken({ http });
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' };

    const all = await http({ url: `${API}/sucursales/all`, headers });
    if (all.status === 401) {
      throw new Error(`la API rechazó el token (${source === 'fallback' ? 'el de respaldo: probablemente lo rotaron' : 'recién leído del bundle'})`);
    }
    if (all.status !== 200 || !Array.isArray(all.data?.sucursales)) {
      throw new Error(`/sucursales/all respondió HTTP ${all.status}`);
    }

    const ids = all.data.sucursales.map((s) => String(s?.Id ?? '')).filter(Boolean);
    if (ids.length === 0) throw new Error('/sucursales/all no trajo ninguna sucursal');

    const details = [];
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const response = await http({ method: 'POST', url: `${API}/sucursales`, data: batch, headers });
      if (response.status !== 200 || !Array.isArray(response.data?.sucursales)) {
        throw new Error(`el detalle de las sucursales ${batch[0]}…${batch[batch.length - 1]} respondió HTTP ${response.status}`);
      }
      details.push(...response.data.sucursales);
      if (i + BATCH_SIZE < ids.length) await sleep(delayMs);
    }

    const retail = details.filter(isRetailStore);
    const stores = retail.map(normalizeFarmacityStore).filter((s) => s.external_reference);
    const withCoordinates = stores.filter((s) => s.latitude !== null).length;

    console.log(
      `🎉 Farmacity: ${stores.length} sucursales (${details.length - retail.length} depósitos descartados, ${withCoordinates} con coordenadas)`
    );

    return {
      success: true,
      source: 'farmacity',
      total: stores.length,
      stores,
      token_source: source,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de sucursales Farmacity:', error.message);
    return {
      success: false,
      source: 'farmacity',
      total: 0,
      stores: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
