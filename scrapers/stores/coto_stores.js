import axios from 'axios';
import * as cheerio from 'cheerio';

/**
 * 🏬 Scraper de SUCURSALES de Coto
 *
 * Fuente: landing pública `/sucursales/` — HTML server-rendered (NO el SPA
 * autenticado). Contiene 9 `<table>` (CABA + 8 regiones: ZONA NORTE, ZONA SUR,
 * ZONA OESTE, COSTA ATLÁNTICA, SANTA FE, ENTRE RIOS, NEUQUÉN, MENDOZA), cada
 * fila con: Suc (código), Sucursal/Barrio (nombre), Dirección, Tipo (badge
 * HIPER/SUPER — merchandising, no el enum physical/online, se ignora),
 * horarios Lunes a Jueves / Viernes / Sábado / Domingo, y Teléfono.
 *
 * ⚠️ REGLA CRÍTICA DE PADDING: la API de precios de productos (Constructor.io,
 * `cores/constructor.js` → `saveCotoProduct`) entrega el código de sucursal
 * ZERO-PADDED a 3 dígitos ("091", "060", "092", "220"), y ya bootstrapeó filas
 * en `merchant_stores` con ese `external_reference`. La tabla de `/sucursales/`
 * muestra el código SIN padding ("91", "60", "92", "220" sin cambios porque ya
 * tiene 3 dígitos). El enriquecimiento de Laravel (`StoreSyncService`) upsertea
 * por `(merchant_id, external_reference)`, así que este scraper DEBE emitir
 * `external_reference = String(suc).trim().padStart(3, '0')` — si no, crea
 * filas huérfanas en vez de enriquecer las que ya tienen precios.
 *
 * Coordenadas: esta fuente NO las trae (gap documentado). El selector
 * "elegí tu sucursal" del SPA (`cCarritoActor/getSucursales` o similar) sí las
 * tendría, pero requiere sesión/login del flujo de compra — fuera de alcance
 * por ahora (no se adivinan endpoints ATG autenticados). `latitude`/`longitude`
 * quedan en `null`; la función "sucursal más cercana" no está disponible para
 * Coto hasta que se consiga otra fuente (login o geocoding por dirección).
 *
 * NO lanza excepciones al caller: ante error de red devuelve { success:false, ... }.
 */

const BASE_URL = 'https://www.coto.com.ar';
const STORES_URL = `${BASE_URL}/sucursales/`;

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
 * Colapsa espacios/saltos de línea repetidos y recorta.
 */
function collapseWhitespace(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Extrae y limpia el texto de una celda cheerio (con fix de mojibake).
 */
function cellText($, el) {
  return fixMojibake(collapseWhitespace($(el).text()));
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
      console.warn(`⚠️ Error de red consultando sucursales Coto, reintentando... (${error.code || error.message})`);
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/**
 * Deriva la ciudad/región desde la dirección: el segmento después del último
 * " - " (ej: "Agüero 616 - CAPITAL FEDERAL" → "CAPITAL FEDERAL"). `null` si el
 * separador no aparece.
 */
function cityFromAddress(address) {
  if (!address) return null;
  const idx = address.lastIndexOf(' - ');
  if (idx === -1) return null;
  const city = address.slice(idx + 3).trim();
  return city.length > 0 ? city : null;
}

/**
 * 🧩 FUNCIÓN PURA - parsea el HTML de /sucursales/ y devuelve los stores.
 *
 * Recorre cada `<table>` (una por región); el heading de región más cercano
 * hacia atrás (`h1`-`h4`) da la `province` — la tabla de CABA no tiene heading
 * como hermano directo (está anidado en un `<div>` previo), así que su
 * `province` queda en `null` (documentado, no es un bug).
 *
 * Solo se quedan las filas cuyo primer `<td>` es puramente numérico (filtra
 * filas de header renderizadas como `<td>` sueltos, si las hubiera) y con
 * `name` no vacío.
 */
export function parseCotoStores(html) {
  const $ = cheerio.load(html);
  const stores = [];

  $('table').each((_, tableEl) => {
    const $table = $(tableEl);
    const headingText = $table.prevAll('h1,h2,h3,h4').first().text();
    const province = headingText ? fixMojibake(collapseWhitespace(headingText)) : null;

    $table.find('tr').each((__, trEl) => {
      const tds = $(trEl).find('td');
      if (tds.length < 9) return;

      const sucRaw = collapseWhitespace($(tds[0]).text());
      if (!/^\d+$/.test(sucRaw)) return; // fila de header/basura, no una sucursal

      const name = cellText($, tds[1]);
      if (!name) return;

      const address = cellText($, tds[2]) || null;

      stores.push({
        external_reference: sucRaw.padStart(3, '0'),
        name,
        address,
        city: cityFromAddress(address),
        province,
        postal_code: null,
        store_type: 'physical',
        phone: cellText($, tds[8]) || null,
        opening_hours: {
          lun_jue: cellText($, tds[4]),
          vie: cellText($, tds[5]),
          sab: cellText($, tds[6]),
          dom: cellText($, tds[7]),
        },
        latitude: null,
        longitude: null,
      });
    });
  });

  return stores;
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Sucursales de Coto
 */
export async function getCotoStores() {
  console.log('🏬 Iniciando scraper de sucursales de Coto (/sucursales/)...');

  try {
    const response = await getWithRetry(STORES_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: BASE_URL,
      },
      timeout: 20000,
    });

    const stores = parseCotoStores(response.data);
    console.log(`🎉 Sucursales de Coto parseadas: ${stores.length}`);

    return {
      success: true,
      source: 'coto',
      total: stores.length,
      stores,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de sucursales Coto:', error.message);
    return {
      success: false,
      source: 'coto',
      total: 0,
      stores: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
