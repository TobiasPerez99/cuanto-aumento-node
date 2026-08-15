/**
 * Scraper de promociones (beneficios) de Banco Santander Argentina.
 *
 * Fuente: https://www.santander.com.ar/personas/beneficios (SPA Next.js).
 * La SPA consume un BFF JSON público, mismo origen, sin auth:
 *   - GET /bff-benefits/brands?limit=500&page=N  -> { items: Brand[], totalItems }
 *   - GET /bff-benefits/brands/{id}              -> { items: Publication[] } (los
 *     beneficios vigentes de esa marca, con descuento, tope, días, cuotas,
 *     vigencia y legales ya estructurados)
 *
 * ⚠️ Por qué Puppeteer y no axios: el WAF de Santander (fingerprinting TLS)
 * deja colgada cualquier conexión que no venga de un browser real — curl/axios
 * ni siquiera reciben respuesta. Por eso se abre la página UNA vez con
 * Chromium headless y todas las llamadas al BFF se hacen con fetch() DENTRO
 * del contexto de la página (mismo origen, mismas cookies, mismo TLS).
 *
 * Origen del proyecto: entrega de Prácticas Profesionalizantes (Thiago Coro,
 * EEST N°1 de Monte Grande, 2026-08). Su script original scrapeaba el DOM
 * clickeando tarjeta por tarjeta; esta adaptación conserva su enfoque de
 * browser real (necesario por el WAF) pero reemplaza la heurística de DOM por
 * el BFF estructurado, que es estable ante cambios de markup/estilos.
 *
 * Ejecutable de Chromium:
 *   - Docker (Alpine): PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
 *     (instalado vía apk en el Dockerfile).
 *   - Dev local: sin la env var, puppeteer-core resuelve el Chrome instalado
 *     vía channel 'chrome'.
 */

import puppeteer from 'puppeteer-core';

const SOURCE = 'santander';
const ORIGIN = 'https://www.santander.com.ar';
const BENEFITS_URL = `${ORIGIN}/personas/beneficios`;

const BRANDS_PAGE_SIZE = 500;
const MAX_BRAND_PAGES = 10; // fusible: hoy son ~644 marcas (2 páginas)
const DETAIL_CONCURRENCY = 5; // fetches in-page simultáneos al BFF
const DETAIL_BATCH_PAUSE_MS = 100;
const LEGAL_MAX_CHARS = 4000; // los legales llegan a ~4k chars de HTML

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Quita tags HTML y decodifica las entidades comunes de los textos del BFF
 * (additionalText/legal vienen como HTML de un rich-text editor).
 * @param {string|null|undefined} html
 * @returns {string|null}
 */
export function stripHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const text = html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text || null;
}

/**
 * Días de vigencia de una publicación como nombres en español.
 * `fullWeek` (o todos los flags apagados, que en el BFF significa "sin
 * restricción de día") -> los 7 días.
 * @param {Object} pub Publicación del BFF
 * @returns {string[]}
 */
export function daysFromPublication(pub) {
  const map = [
    ['monday', 'lunes'],
    ['tuesday', 'martes'],
    ['wednesday', 'miercoles'],
    ['thursday', 'jueves'],
    ['friday', 'viernes'],
    ['saturday', 'sabado'],
    ['sunday', 'domingo'],
  ];
  const days = map.filter(([key]) => pub?.[key] === true).map(([, label]) => label);
  if (pub?.fullWeek === true || days.length === 0) {
    return map.map(([, label]) => label);
  }
  return days;
}

/**
 * "2026-07-16T00:00:00" -> "2026-07-16" (o null si no parsea).
 * @param {string|null|undefined} isoLike
 */
export function toIsoDate(isoLike) {
  if (!isoLike || typeof isoLike !== 'string') return null;
  const m = isoLike.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Titular legible del beneficio (la IA igual recibe todos los campos).
 */
function headlineFor(pub) {
  if (pub?.customerDiscount) {
    return `${pub.customerDiscount}% de ahorro`;
  }
  if (pub?.interestFreeFees) {
    const cuotas = pub.finalQuote || pub.initialQuote;
    return cuotas ? `${cuotas} cuotas sin interés` : 'Cuotas sin interés';
  }
  return pub?.benefitType?.description || 'Beneficio Santander';
}

/**
 * Normaliza una publicación del BFF al contrato PULL que consume Laravel
 * (AbstractScrapperPullProvider -> promotion_for_processes -> IA).
 *
 * @param {Object} brand Marca del listado /bff-benefits/brands
 * @param {Object} pub   Publicación de /bff-benefits/brands/{id}
 * @returns {Object|null} Promo normalizada, o null si faltan datos mínimos.
 */
export function normalizeSantanderPublication(brand, pub) {
  if (!brand || !pub || pub.id == null) return null;

  const marca = stripHtml(brand.name) || `Marca ${brand.id}`;
  const headline = headlineFor(pub);
  const cuotas = pub.interestFreeFees ? pub.finalQuote || pub.initialQuote || null : null;

  return {
    external_id: `san-${pub.id}`,
    slug: `santander-${slugify(marca)}-${pub.id}`,
    banco: 'Santander',
    marca,
    nombre: `${marca}: ${headline}`,
    descuento_porcentaje: pub.customerDiscount ?? null,
    tope_reintegro: pub.topAmount ?? null,
    tope_mensual: pub.monthlyCut === true,
    cuotas_sin_interes: cuotas,
    dias: daysFromPublication(pub),
    tipo_beneficio: pub.benefitType?.description ?? null,
    medio_pago: pub.paymentType?.description ?? null,
    metodo_pago: pub.paymentMethod?.description ?? null,
    frecuencia: pub.frecuency?.description ?? null,
    condiciones: stripHtml(pub.additionalText),
    condicion_especial:
      typeof pub.specialCondition === 'string'
        ? stripHtml(pub.specialCondition)
        : (stripHtml(pub.specialCondition?.description) ?? null),
    legales: (stripHtml(pub.legal) || '').slice(0, LEGAL_MAX_CHARS) || null,
    imagen: brand.desktopImage || brand.desktopMinImage || null,
    url_promo: `${BENEFITS_URL}#/?brandId=${brand.id}`,
    start_date: toIsoDate(pub.startDatePublication),
    end_date: toIsoDate(pub.endDatePublication),
    // Crudos útiles para auditoría/desambiguación de la IA:
    id_publicacion: pub.id,
    id_promocion: pub.idPromotion ?? null,
    brand_id: brand.id,
    brand_headline: brand.benefitDescription ?? null,
  };
}

/**
 * fetch() JSON dentro del contexto de la página (mismo origen).
 * Devuelve { ok, status, data } — nunca lanza hacia Node por errores HTTP.
 */
async function fetchJsonInPage(page, path) {
  return page.evaluate(async (p) => {
    try {
      const res = await fetch(p, { headers: { Accept: 'application/json' } });
      if (!res.ok) return { ok: false, status: res.status, data: null };
      return { ok: true, status: res.status, data: await res.json() };
    } catch (err) {
      return { ok: false, status: 0, data: null, error: String(err) };
    }
  }, path);
}

/**
 * Lista completa de marcas activas, paginando el BFF.
 * @returns {Promise<Object[]>}
 */
async function fetchAllBrands(page) {
  const brands = [];
  let totalItems = Infinity;

  for (let pageNum = 1; pageNum <= MAX_BRAND_PAGES && brands.length < totalItems; pageNum++) {
    const res = await fetchJsonInPage(
      page,
      `/bff-benefits/brands?limit=${BRANDS_PAGE_SIZE}&page=${pageNum}`
    );

    if (!res.ok || !Array.isArray(res.data?.items)) {
      throw new Error(
        `BFF /brands página ${pageNum} respondió ${res.status}${res.error ? ` (${res.error})` : ''}`
      );
    }

    brands.push(...res.data.items);
    totalItems = Number.isFinite(res.data.totalItems) ? res.data.totalItems : brands.length;

    if (res.data.items.length === 0) break; // página vacía: no seguir de largo
  }

  return brands;
}

/**
 * Publicaciones (beneficios) de cada marca, con concurrencia acotada.
 * Una marca que falla no aborta el lote (se loguea y sigue).
 * @returns {Promise<Array<{brand: Object, publications: Object[]}>>}
 */
async function fetchPublicationsForBrands(page, brands) {
  const results = [];
  let errores = 0;

  for (let i = 0; i < brands.length; i += DETAIL_CONCURRENCY) {
    const batch = brands.slice(i, i + DETAIL_CONCURRENCY);

    const settled = await Promise.all(
      batch.map(async (brand) => {
        const res = await fetchJsonInPage(page, `/bff-benefits/brands/${brand.id}`);
        if (!res.ok || !Array.isArray(res.data?.items)) {
          return { brand, publications: null, status: res.status };
        }
        return { brand, publications: res.data.items };
      })
    );

    for (const item of settled) {
      if (item.publications === null) {
        errores++;
        console.warn(`   ⚠️ Marca ${item.brand.id} (${item.brand.name}): HTTP ${item.status}`);
      } else {
        results.push(item);
      }
    }

    if (i + DETAIL_CONCURRENCY < brands.length) await sleep(DETAIL_BATCH_PAUSE_MS);

    const done = Math.min(i + DETAIL_CONCURRENCY, brands.length);
    if (done % 100 < DETAIL_CONCURRENCY) {
      console.log(`   … ${done}/${brands.length} marcas consultadas`);
    }
  }

  if (errores > 0) {
    console.warn(`   ⚠️ ${errores} marcas fallaron al consultar sus publicaciones`);
  }

  return results;
}

/**
 * Lanza Chromium headless. En Docker usa PUPPETEER_EXECUTABLE_PATH; en dev
 * local cae al Chrome instalado (channel 'chrome').
 */
async function launchBrowser() {
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  return puppeteer.launch({
    headless: true,
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--mute-audio',
    ],
  });
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de Banco Santander
 * Nunca lanza al caller: ante error global devuelve success:false.
 */
export async function getSantanderPromotions() {
  console.log('🔴 Iniciando scraper de promociones de Banco Santander...');

  let browser = null;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);

    console.log(`   Navegando a ${BENEFITS_URL} (pasa el WAF con browser real)...`);
    await page.goto(BENEFITS_URL, { waitUntil: 'networkidle2', timeout: 90000 });

    // Probe: el WAF puede tardar en "bendecir" la sesión; reintentamos el
    // primer hit al BFF un par de veces antes de rendirnos.
    let probeOk = false;
    for (let intento = 0; intento < 3 && !probeOk; intento++) {
      const probe = await fetchJsonInPage(page, '/bff-benefits/brands?limit=1');
      probeOk = probe.ok;
      if (!probeOk) await sleep(3000);
    }
    if (!probeOk) {
      throw new Error('El BFF de beneficios no respondió dentro de la sesión del browser');
    }

    const brands = await fetchAllBrands(page);
    console.log(`📊 ${brands.length} marcas con beneficios encontradas`);

    const perBrand = await fetchPublicationsForBrands(page, brands);

    const promotions = [];
    const seen = new Set(); // dedupe por external_id
    for (const { brand, publications } of perBrand) {
      for (const pub of publications) {
        const promo = normalizeSantanderPublication(brand, pub);
        if (promo && !seen.has(promo.external_id)) {
          seen.add(promo.external_id);
          promotions.push(promo);
        }
      }
    }

    console.log(`🎉 Santander: ${promotions.length} promociones extraídas`);

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de Banco Santander:', error.message);
    return {
      success: false,
      source: SOURCE,
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
