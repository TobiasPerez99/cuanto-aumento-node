/**
 * Scraper de promociones de Banco Patagonia (portal Ahorros y Beneficios).
 *
 * Fuente: https://ahorrosybeneficios.bancopatagonia.com.ar/ahorrosybeneficios/
 * (Magento, HTML server-side). El home lista tarjetas de producto; de ahí
 * extraemos los links de detalle (/ahorrosybeneficios/<slug>.html) y luego
 * scrapeamos cada detalle, cuyos datos (segmentos, porcentajes, topes, medios
 * de pago) vienen renderizados del lado del servidor.
 *
 * Magento suele servir el HTML en latin-1 → fetchCheerio corrige el encoding
 * para evitar mojibake (ej: "PROMOCIÓN" en vez de "PROMOCIÃ“N").
 */
import { fetchCheerio, cleanText, parseMoney, parsePercent, firstAttr } from '../../cores/htmlParse.js';

const SOURCE = 'patagonia';
const ORIGIN = 'https://ahorrosybeneficios.bancopatagonia.com.ar';
const HOME_URL = `${ORIGIN}/ahorrosybeneficios/`;

// Pausa entre requests de detalle para no saturar el servidor.
const THROTTLE_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extrae el slug de una URL de detalle /ahorrosybeneficios/<slug>.html.
 */
function slugFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/ahorrosybeneficios\/([^/?#]+?)\.html/i);
  return match ? match[1] : null;
}

/**
 * Recolecta los links de detalle únicos desde el home.
 * Filtra por el patrón /ahorrosybeneficios/<slug>.html (product-item-photo/link).
 * @param {import('cheerio').CheerioAPI} $
 * @returns {string[]} URLs absolutas únicas
 */
function collectDetailLinks($) {
  const links = new Set();
  $('a.product-item-photo, a.product-item-link').each((_, a) => {
    let href = firstAttr($(a), 'href');
    if (!href) return;
    // Normalizar a URL absoluta.
    try {
      href = new URL(href, ORIGIN).href;
    } catch {
      return;
    }
    if (/\/ahorrosybeneficios\/[^/?#]+\.html/i.test(href)) {
      links.add(href);
    }
  });
  return [...links];
}

/**
 * Parsea un rango de fechas "dd/mm/yyyy ... dd/mm/yyyy" desde un texto.
 * Se usa sobre la vigencia y, como fallback, sobre las condiciones legales
 * ("DESDE EL 02/04/2026 AL 30/09/2026").
 * @returns {{start: string|null, end: string|null}}
 */
function parseDateRange(...textos) {
  for (const texto of textos) {
    if (!texto) continue;
    const fechas = texto.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g);
    if (fechas && fechas.length >= 2) {
      return { start: toIso(fechas[0]), end: toIso(fechas[1]) };
    }
    if (fechas && fechas.length === 1) {
      return { start: toIso(fechas[0]), end: null };
    }
  }
  return { start: null, end: null };
}

/**
 * Convierte "dd/mm/yyyy" a ISO "yyyy-mm-dd" (o null si no es válida).
 */
function toIso(ddmmyyyy) {
  const m = ddmmyyyy.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const day = Number.parseInt(m[1], 10);
  const month = Number.parseInt(m[2], 10);
  const year = Number.parseInt(m[3], 10);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Scrapea una página de detalle de promoción.
 * @param {string} url
 * @returns {Promise<Object|null>} Objeto promoción normalizado, o null si no es válida.
 */
async function scrapeDetalle(url) {
  const $ = await fetchCheerio(url);

  // Nombre: intentamos el bloque de detalle y caemos a selectores genéricos de Magento.
  const nombre =
    cleanText($('.block-info-detalles .name').first().text()) ||
    cleanText($('.page-title .base').first().text()) ||
    cleanText($('h1').first().text()) ||
    null;

  const dias = cleanText($('.block-info-detalles .dias').first().text()) || null;
  const vigencia = cleanText($('.block-info-detalles .vigencia').first().text()) || null;

  // Imagen principal de la galería.
  const $img = $('.gallery-placeholder__image, .product.media img').first();
  const imagen = firstAttr($img, 'src') || firstAttr($img, 'data-src') || null;

  // Código (SKU de Magento).
  const codigo =
    cleanText($('.product.attribute.sku .value').first().text()) ||
    cleanText($('.product.attribute.sku').first().text()) ||
    null;

  // Condiciones / legales (modal de bases y condiciones).
  const condiciones =
    cleanText($('#popup-modal').first().text()) ||
    cleanText($('.block-info-detalles .value').first().text()) ||
    null;

  // Categorías: alt de las imágenes de .product-categories (únicas).
  const categoriasSet = new Set();
  $('.product-categories img').each((_, img) => {
    const alt = cleanText(firstAttr($(img), 'alt'));
    if (alt) categoriasSet.add(alt);
  });
  const categorias = [...categoriasSet];

  // Segmentos: cada bloque .list-benef describe un segmento (Clásica/Plus/Singular)
  // con su porcentaje, tope y medios de pago.
  const segmentos = [];
  $('.list-benef').each((_, bloque) => {
    const $bloque = $(bloque);

    const nombres = [];
    $bloque.find('[class*="misc-"]').each((__, el) => {
      const t = cleanText($(el).text());
      if (t) nombres.push(t);
    });

    const porcentaje = parsePercent(
      cleanText($bloque.find('.list-benef-price-percentage').first().text())
    );
    const tope = parseMoney(cleanText($bloque.find('[data-th="Tope"]').first().text()));

    const medios_pago = [];
    $bloque.find('.add-cards img').each((__, el) => {
      const medio = cleanText(firstAttr($(el), 'title') || firstAttr($(el), 'alt'));
      if (medio) medios_pago.push(medio);
    });

    segmentos.push({ segmentos: nombres, porcentaje, tope, medios_pago });
  });

  // Descartamos páginas sin datos útiles.
  if (!nombre) return null;

  const slug = slugFromUrl(url);
  // external_id estable: preferimos el código (SKU); si falta, el slug de la URL.
  const externalKey = codigo || slug;
  if (!externalKey) return null;

  const { start, end } = parseDateRange(vigencia, condiciones);

  return {
    external_id: `pat-${externalKey}`,
    slug: slug || externalKey,
    nombre,
    dias,
    vigencia,
    categorias,
    imagen,
    codigo,
    condiciones,
    url_promo: url,
    segmentos,
    start_date: start,
    end_date: end,
  };
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de Banco Patagonia
 * Nunca lanza al caller: ante error global devuelve success:false.
 * Cada detalle tiene su propio try/catch para que una falla no aborte el lote.
 */
export async function getPatagoniaPromotions() {
  console.log(`🔵 Iniciando scraper de promociones de Banco Patagonia...`);

  try {
    const $home = await fetchCheerio(HOME_URL);
    const links = collectDetailLinks($home);
    console.log(`📊 ${links.length} promociones (links de detalle) encontradas`);

    const promotions = [];
    const seen = new Set(); // dedupe por external_id
    let errores = 0;

    for (let i = 0; i < links.length; i++) {
      const url = links[i];
      try {
        const promo = await scrapeDetalle(url);
        if (promo && !seen.has(promo.external_id)) {
          seen.add(promo.external_id);
          promotions.push(promo);
          console.log(`   ✅ [${i + 1}/${links.length}] ${promo.nombre}`);
        } else if (!promo) {
          console.log(`   ⏭️  [${i + 1}/${links.length}] Sin datos válidos: ${url}`);
        }
      } catch (error) {
        errores++;
        console.error(`   ❌ [${i + 1}/${links.length}] Error en ${url}: ${error.message}`);
      }

      // Throttle entre requests de detalle.
      if (i < links.length - 1) await sleep(THROTTLE_MS);
    }

    console.log(`🎉 Patagonia: ${promotions.length} promociones extraídas (${errores} errores)`);

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`❌ Error en scraper de Banco Patagonia:`, error.message);
    return {
      success: false,
      source: SOURCE,
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
