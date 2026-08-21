import puppeteer from 'puppeteer-core';

/**
 * 🏬 Scraper de SUCURSALES de Dia
 *
 * Fuente: VTEX Master Data, entidad "TI" (tiendas), consumida por la landing
 * https://diaonline.supermercadosdia.com.ar/tiendas
 *   GET /_v/private/store-services/masterdata-info/TI
 *       ?_fields=active,address,city,geo,hours,id,name,province,tipo,...
 *       &_where=(active=true OR active=false)
 *
 * ⚠️ Por qué Puppeteer y no axios: la ruta vive bajo `_v/private/` y responde
 * 404 a cualquier request que no traiga la cookie de sesión VTEX (`vtex_session`)
 * emitida al cargar la página. Replicar la cookie a mano es frágil (expira y va
 * firmada), así que se abre la landing UNA vez con Chromium headless y la llamada
 * se hace con `fetch()` DENTRO del contexto de la página — mismo patrón, y misma
 * razón, que `scrapers/promos/santander.js`. NO se scrapea el DOM: el markup es
 * React y cambia por build; el Master Data es estable.
 *
 * ⚠️ El header `rest-range: resources=0-4999` NO es opcional: sin él la entidad
 * responde 404 (no un 206 truncado, que sería lo intuitivo). Junto con el
 * parámetro `_where` son las dos condiciones para que el endpoint conteste.
 *
 * Cobertura: ~1000 registros / ~970 activos en 8 provincias (CABA, Buenos Aires,
 * Entre Ríos, Salta, Corrientes, Santa Fe, Córdoba, Jujuy), ~100% con coordenadas.
 *
 * Origen: la entrega de Prácticas Profesionalizantes de Joaquin Alodi (2026-08)
 * identificó `/tiendas` como fuente de sucursales de Dia. Su implementación leía
 * `document.body.innerText` y reconstruía las tarjetas por heurística de líneas
 * (787 sucursales, sin coordenadas ni horarios); acá se reemplaza por el Master
 * Data que alimenta esa misma página, que devuelve los registros estructurados y
 * CON geo — el dato que habilita la búsqueda de sucursal más cercana.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const STORES_URL = 'https://diaonline.supermercadosdia.com.ar/tiendas';

const MASTERDATA_PATH =
  '/_v/private/store-services/masterdata-info/TI' +
  '?_fields=active,address,bajaTemporal,city,geo,hours,id,name,new,province,service,tipo,whitelabel' +
  '&_where=(active=true OR active=false)';

// Sin este rango la entidad responde 404. 5000 cubre holgado los ~1000 registros.
const REST_RANGE = 'resources=0-4999';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const NAV_TIMEOUT = 120000;

/**
 * Convierte un valor a número finito, o null.
 */
function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parsea el campo `geo` del Master Data.
 *
 * ⚠️ Viene como string "longitud,latitud" — longitud PRIMERO, al revés que la
 * entidad NT de Jumbo (que usa "lat,lng"). Verificado contra el bounding box de
 * Argentina sobre los 970 registros activos: 965 caen dentro leyendo [lon,lat]
 * y 0 leyendo [lat,lon]. Invertirlo mandaría todas las sucursales al Índico.
 *
 * Los registros dados de baja traen geo="0" (sin coma) → {null, null}.
 */
export function parseDiaGeo(raw) {
  if (typeof raw !== 'string' || !raw.includes(',')) {
    return { latitude: null, longitude: null };
  }

  const [lon, lat] = raw.split(',').map((s) => s.trim());

  return {
    latitude: toNumberOrNull(lat),
    longitude: toNumberOrNull(lon),
  };
}

/**
 * Normaliza los horarios. En la práctica el Master Data trae `hours` en null
 * para casi todos los registros (2 de 1000), así que esto es defensivo: se
 * pasa el valor tal cual si existe. Los horarios reales están en la API de
 * pickup-points, pero esa fuente sólo cubre AMBA y no comparte identificador
 * con el Master Data, así que no se puede cruzar de forma confiable.
 */
function normalizeHours(hours) {
  if (hours === null || hours === undefined || hours === '') return null;
  return hours;
}

/**
 * Mapea un registro crudo del Master Data a la forma de store del contrato
 * que consume `App\Services\Stores\StoreSyncService`.
 *
 * Función pura: es la parte unit-testeable, sin red ni browser.
 */
export function normalizeDiaStore(record) {
  const { latitude, longitude } = parseDiaGeo(record?.geo);

  const name = record?.name ?? null;

  return {
    external_reference: record?.id != null ? String(record.id) : null,
    name: name || null,
    address: record?.address ?? null,
    city: record?.city ?? null,
    province: record?.province ?? null,
    // El Master Data de Dia no expone código postal ni teléfono en esta entidad.
    postal_code: null,
    latitude,
    longitude,
    phone: null,
    opening_hours: normalizeHours(record?.hours),
  };
}

/**
 * Filtra y normaliza el lote crudo.
 *
 * Se descartan: registros inactivos, dados de baja temporal, sin identificador
 * y sin coordenadas. El filtro por coordenadas es deliberado y coherente con
 * `jumbo_stores.js`: una sucursal sin geo no sirve para el "más cercana" y
 * ensucia el selector de sucursal.
 *
 * Función pura: unit-testeable con un fixture.
 */
export function normalizeDiaStores(records) {
  if (!Array.isArray(records)) return [];

  return records
    .filter((r) => r && r.active === true && r.bajaTemporal !== true)
    .map(normalizeDiaStore)
    .filter((s) => s.external_reference && s.latitude !== null && s.longitude !== null);
}

/**
 * Resuelve el ejecutable de Chromium.
 * En Docker el Dockerfile instala chromium via apk y setea PUPPETEER_EXECUTABLE_PATH;
 * en dev local sin esa variable se cae al Chrome instalado en el sistema.
 */
function launchOptions() {
  const options = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    options.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    options.channel = 'chrome';
  }

  return options;
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Sucursales de Dia
 */
export async function getDiaStores() {
  console.log('🏬 Iniciando scraper de sucursales de Dia...');

  let browser;

  try {
    browser = await puppeteer.launch(launchOptions());

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT);

    // La navegación sólo existe para que VTEX emita la cookie de sesión que
    // habilita la ruta privada del Master Data.
    await page.goto(STORES_URL, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });

    const result = await page.evaluate(
      async (path, restRange) => {
        const response = await fetch(path, {
          headers: { Accept: 'application/json', 'rest-range': restRange },
        });

        if (response.status !== 200) {
          return { error: `Master Data respondió ${response.status}` };
        }

        return { records: await response.json() };
      },
      MASTERDATA_PATH,
      REST_RANGE
    );

    if (result.error) {
      throw new Error(result.error);
    }

    const records = Array.isArray(result.records) ? result.records : [];
    console.log(`📊 ${records.length} registros recibidos del Master Data (entidad TI)`);

    const stores = normalizeDiaStores(records);

    const descartados = records.length - stores.length;
    console.log(
      `🎉 Sucursales de Dia normalizadas: ${stores.length} (${descartados} descartadas: inactivas, de baja o sin coordenadas)`
    );

    return {
      success: true,
      source: 'dia',
      total: stores.length,
      stores,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de sucursales Dia:', error.message);

    return {
      success: false,
      source: 'dia',
      total: 0,
      stores: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
