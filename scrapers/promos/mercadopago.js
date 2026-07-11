/**
 * Scraper de promociones de MercadoPago.
 *
 * Fuente: https://promociones.mercadopago.com.ar/?_sf_ppp=100 (WordPress).
 * Todas las ~100 tarjetas de promoción vienen en el HTML estático bajo
 * '.kiyo__cards--col', por lo que alcanza con axios + cheerio (sin navegador).
 *
 * Se descartó el enrichment por-detalle del script original de pasantes
 * (que abría cada URL con puppeteer y traía basura del catálogo del comercio):
 * solo conservamos el listado, que es confiable.
 */
import { fetchCheerio, cleanText, firstAttr } from '../../cores/htmlParse.js';

const SOURCE = 'mercadopago';
const URL = 'https://promociones.mercadopago.com.ar/?_sf_ppp=100';

// Meses en español → índice 0-based (para parsear vigencias).
const MESES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};

/**
 * Genera un slug URL-safe a partir de un texto arbitrario.
 */
function slugify(str) {
  return cleanText(str)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sacar acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Extrae el slug del comercio desde la URL /seller/<slug>/.
 * La URL puede venir percent-encoded y con emojis (ej: "mercado-libre-%f0%9f%94%a5").
 * Devuelve un slug limpio o null.
 */
function sellerSlugFromUrl(url) {
  if (!url) return null;
  try {
    const decoded = decodeURIComponent(url);
    const match = decoded.match(/\/seller\/([^/?#]+)/i);
    if (!match) return null;
    const slug = slugify(match[1]);
    return slug || null;
  } catch {
    // decodeURIComponent puede tirar si el encoding está roto → fallback crudo.
    const match = url.match(/\/seller\/([^/?#]+)/i);
    return match ? slugify(match[1]) : null;
  }
}

/**
 * Deriva el tipo de promoción a partir del beneficio y la descripción.
 * @returns {'descuento'|'reintegro'|'cuotas sin interes'|'2x1'|'3x2'|null}
 */
function detectarTipoPromocion(beneficio, descripcion) {
  const texto = `${beneficio || ''} ${descripcion || ''}`.toLowerCase();
  if (/reintegro|devoluci[oó]n|cash.?back/.test(texto)) return 'reintegro';
  if (/sin.?inter[eé]s/.test(texto) && /cuota/.test(texto)) return 'cuotas sin interes';
  if (/\b2x1\b/.test(texto)) return '2x1';
  if (/\b3x2\b/.test(texto)) return '3x2';
  if (/\d+\s*%/.test(texto) || /\boff\b|descuento|dto|desc\b/.test(texto)) return 'descuento';
  return null;
}

/**
 * Parsea el texto de vigencia de MercadoPago a fechas ISO (o null).
 * Soporta:
 *   - "Válido del 11 al 17 de mayo"          (mismo mes)
 *   - "del 30 de abril al 5 de mayo"         (meses distintos)
 *   - "del 11 al 17 de mayo de 2026"         (con año)
 * El año, si no está presente, se asume el actual (con wrap si el mes de fin
 * es menor al de inicio).
 * @returns {{start: string|null, end: string|null}}
 */
function parseVigencia(vigencia) {
  const empty = { start: null, end: null };
  if (!vigencia) return empty;
  const texto = vigencia.toLowerCase();

  const yearMatch = texto.match(/\bde\s+(20\d{2})/);
  const baseYear = yearMatch ? Number.parseInt(yearMatch[1], 10) : new Date().getFullYear();

  // Caso "del <d1> de <mes1> al <d2> de <mes2>"
  let m = texto.match(/del?\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+al?\s+(\d{1,2})\s+de\s+([a-záéíóú]+)/);
  if (m) {
    const d1 = Number.parseInt(m[1], 10);
    const mes1 = MESES[m[2]];
    const d2 = Number.parseInt(m[3], 10);
    const mes2 = MESES[m[4]];
    if (mes1 == null || mes2 == null) return empty;
    const startYear = baseYear;
    const endYear = mes2 < mes1 ? baseYear + 1 : baseYear;
    return {
      start: toIso(startYear, mes1, d1),
      end: toIso(endYear, mes2, d2),
    };
  }

  // Caso "del <d1> al <d2> de <mes>" (mismo mes)
  m = texto.match(/del?\s+(\d{1,2})\s+al?\s+(\d{1,2})\s+de\s+([a-záéíóú]+)/);
  if (m) {
    const d1 = Number.parseInt(m[1], 10);
    const d2 = Number.parseInt(m[2], 10);
    const mes = MESES[m[3]];
    if (mes == null) return empty;
    return {
      start: toIso(baseYear, mes, d1),
      end: toIso(baseYear, mes, d2),
    };
  }

  return empty;
}

/**
 * Construye una fecha ISO (YYYY-MM-DD) a partir de año, mes (0-based) y día.
 */
function toIso(year, month0, day) {
  const d = new Date(Date.UTC(year, month0, day));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de MercadoPago
 * Nunca lanza al caller: ante error devuelve success:false con el detalle.
 */
export async function getMercadoPagoPromotions() {
  console.log(`🟡 Iniciando scraper de promociones de MercadoPago...`);

  try {
    const $ = await fetchCheerio(URL);
    const columnas = $('.kiyo__cards--col');
    console.log(`📊 ${columnas.length} tarjetas encontradas en el HTML`);

    const seen = new Map(); // dedupe por url_promocion

    columnas.each((_, col) => {
      const $col = $(col);
      // El contenido puede estar en '.kiyo__data' o en '.kiyo__cards--item'.
      const $data = $col.find('.kiyo__data').first();
      const $scope = $data.length ? $data : $col.find('.kiyo__cards--item').first();
      if (!$scope.length) return;

      const comercio = cleanText($scope.find('h3').first().text());
      const beneficio = cleanText(
        $scope.find('.kiyo__cards--badge:not(.kiyo__cards--badge2) span').first().text()
      );
      const cuotas = cleanText($scope.find('.kiyo__cards--badge2 span').first().text());
      const descripcion = cleanText($scope.find('.kiyo__data--details-row1 p').first().text());
      const vigencia = cleanText($scope.find('.kiyo__data--details-row2 small').first().text());

      const $img = $scope.find('img').first();
      const imagen = firstAttr($img, 'src') || firstAttr($img, 'data-src') || null;

      const url_promocion =
        firstAttr($scope.find('.kiyo__data--details-btn a').first(), 'href') || null;

      // Sin URL no podemos generar un external_id estable → descartamos.
      if (!url_promocion || seen.has(url_promocion)) return;

      const sellerSlug = sellerSlugFromUrl(url_promocion) || slugify(comercio) || null;
      if (!sellerSlug) return;

      const { start, end } = parseVigencia(vigencia);

      seen.set(url_promocion, {
        external_id: `mp-${sellerSlug}`,
        slug: sellerSlug,
        comercio: comercio || null,
        beneficio: beneficio || null,
        cuotas: cuotas || null,
        tipo_promocion: detectarTipoPromocion(beneficio, descripcion),
        descripcion: descripcion || null,
        vigencia: vigencia || null,
        imagen,
        url_promocion,
        start_date: start,
        end_date: end,
      });
    });

    const promotions = [...seen.values()];
    console.log(`🎉 MercadoPago: ${promotions.length} promociones únicas extraídas`);

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`❌ Error en scraper de MercadoPago:`, error.message);
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
