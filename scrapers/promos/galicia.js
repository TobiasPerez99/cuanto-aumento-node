/**
 * Scraper de promociones de Banco Galicia (buscador de promociones "Quiero!").
 *
 * La página www.galicia.ar/personas/buscador-de-promociones es un iframe a
 * beneficios.galicia.ar (Next.js), que lee un BFF JSON público, sin token:
 *   - GET {BFF}/personalizacion/v1/promociones/catalogo?page=&pageSize=  (listado)
 *   - GET {BFF}/catalogo/v1/promociones/idPromocion/{id}                  (detalle)
 * El detalle trae %, cuotas, tope con periodicidad, compra mínima, días, tarjetas,
 * segmento y legales; el listado sólo sirve para saber qué ids hay. Relevamiento
 * completo: docs/superpowers/research/2026-09-23-fuentes-de-promos/galicia.md.
 *
 * Galicia publica UN id por segmento (Masivo 20%, Eminent 25% de la misma promo):
 * los detalles que comparten comercio, vigencia, días, tarjetas, QR/NFC y tipo de
 * beneficio se agrupan en un registro con `segments`, que la IA convierte en niveles.
 *
 * Contrato con Laravel: fechas ISO (YYYY-MM-DD); no se emite nada que cambie entre
 * corridas sin que cambie la promo (la huella de contenido lo tomaría como cambio).
 *
 * Si el host del BFF cambia: buscar `latest:"https://` cerca de `bff` en el chunk
 * pages/index-*.js de beneficios.galicia.ar. Si aparece un challenge de F5, el plan B
 * es el de Santander (fetch desde puppeteer-core).
 */
import axios from 'axios';
import { createHash } from 'node:crypto';

const SOURCE = 'galicia';
const BFF = 'https://loyalty.bff.bancogalicia.com.ar/api/portal';
const LIST_URL = `${BFF}/personalizacion/v1/promociones/catalogo`;
const detailUrl = (id) => `${BFF}/catalogo/v1/promociones/idPromocion/${id}`;
const IMAGE_BASE =
  'https://www.galicia.ar/content/dam/galicia/banco-galicia/personas/promociones/catalogo-de-beneficios/';

const PAGE_SIZE = 500;
const MAX_PAGES = 20; // fusible: hoy son ~1.630 promos (4 páginas)
const DETAIL_CONCURRENCY = Number(process.env.GALICIA_DETAIL_CONCURRENCY) || 3;
const DETAIL_RETRIES = 2;
const RETRY_DELAY_MS = 500;
const LEGAL_MAX_CHARS = 4000;

const HEADERS = {
  Accept: 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
  Origin: 'https://beneficios.galicia.ar',
  Referer: 'https://beneficios.galicia.ar/',
  id_canal: 'Quiero',
  id_channel: 'onlinebanking',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** El BFF respondió algo que no es la API (403, challenge, HTML): no reintentar. */
export class GaliciaBlockedError extends Error {}

/** "dd/mm/yyyy" → "yyyy-mm-dd"; null si no es una fecha real en ese formato. */
export function ddmmyyyyToIso(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(mo) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return `${y}-${mo}-${d}`;
}

function normalizeDays(value) {
  return String(value ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean)
    .join(';');
}

function cardsOf(detail) {
  return (detail.mediosDePago ?? [])
    .map((m) => ({ card: String(m.tarjeta ?? '').trim(), type: String(m.tipoTarjeta ?? '').trim() || null }))
    .filter((c) => c.card)
    .sort((a, b) => a.card.localeCompare(b.card));
}

function benefitKind(detail) {
  return (detail.porcentajeAhorro ?? 0) > 0 ? 'ahorro' : 'cuotas';
}

function segmentKey(detail) {
  return `${detail.modeloAtencion?.nombre ?? ''}|${detail.haberes ? 'haberes' : ''}`;
}

/** Lo que tienen que compartir dos detalles para ser niveles de la misma promo. */
export function groupKey(detail) {
  const merchant = detail.marca?.id != null ? `m${detail.marca.id}` : `c${detail.categoria?.id ?? 'x'}`;
  return [
    merchant,
    detail.fechaDesde ?? '',
    detail.fechaHasta ?? '',
    normalizeDays(detail.diasAplicacion),
    cardsOf(detail).map((c) => c.card).join('|'),
    detail.flagQR ? 'qr' : '',
    detail.flagNFC ? 'nfc' : '',
    benefitKind(detail),
  ].join('#');
}

/**
 * Agrupa los detalles por groupKey. Dentro de un grupo cada segmento aparece una
 * sola vez: un segundo detalle del MISMO segmento es otra promo y va a su propio
 * grupo (con el id en la clave, que así sigue siendo estable).
 */
export function groupDetails(details) {
  const groups = new Map();
  for (const d of [...details].sort((a, b) => a.id - b.id)) {
    const key = groupKey(d);
    const current = groups.get(key);
    if (!current) {
      groups.set(key, [d]);
    } else if (current.some((x) => segmentKey(x) === segmentKey(d))) {
      groups.set(`${key}#${d.id}`, [d]);
    } else {
      current.push(d);
    }
  }
  return [...groups.entries()].map(([key, members]) => ({ key, members }));
}

export function externalIdFor(key) {
  return `gal-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

function cleanLegal(text) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, LEGAL_MAX_CHARS) : null;
}

function segmentOf(detail, listItem) {
  return {
    galicia_id: detail.id,
    segment: detail.modeloAtencion?.nombre ?? null,
    payroll: Boolean(detail.haberes ?? listItem?.haberes),
    headline: listItem?.promocion ?? null,
    discount_percent: detail.porcentajeAhorro || null,
    installments_from: detail.cuotaSinInteresDesde ?? null,
    installments_to: detail.cuotaSinInteresHasta ?? null,
    cap_amount: detail.topeReintegro || null,
    cap_type: detail.tipoTope ?? null,
    cap_period: detail.periodicidad ?? null,
    cap_note: detail.leyendaTope ?? null,
    min_purchase: detail.minimoCompra ?? null,
    legal: cleanLegal(detail.legales),
  };
}

export function normalizeGaliciaGroup({ key, members }, listById = new Map()) {
  const first = members[0];
  const merchantName = first.marca?.nombre?.trim() || null;
  const segments = members.map((m) => segmentOf(m, listById.get(m.id)));
  const headlines = [...new Set(segments.map((s) => s.headline).filter(Boolean))];

  return {
    external_id: externalIdFor(key),
    source: SOURCE,
    title: [merchantName ?? first.categoria?.descripcion ?? 'Banco Galicia', headlines.join(' / ')]
      .filter(Boolean)
      .join(': '),
    merchant_name: merchantName,
    category: first.marca?.categoria?.descripcion ?? first.categoria?.descripcion ?? null,
    start_date: ddmmyyyyToIso(first.fechaDesde),
    end_date: ddmmyyyyToIso(first.fechaHasta),
    days: normalizeDays(first.diasAplicacion),
    payment: {
      cards: cardsOf(first),
      qr: Boolean(first.flagQR),
      nfc: Boolean(first.flagNFC),
      note: first.descripcionAdicional ?? null,
    },
    channels: { online: Boolean(first.tiendaOnline), physical: Boolean(first.tiendaFisica) },
    segments,
    image_url: first.marca?.imagen ? IMAGE_BASE + first.marca.imagen : null,
  };
}

/** Valida la respuesta del BFF y devuelve `data`. */
export function parseBffResponse({ status, body, contentType }, url) {
  if (status === 403 || status === 429 || status === 503) {
    throw new GaliciaBlockedError(`Galicia respondió ${status} en ${url}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Galicia respondió ${status} en ${url}`);
  }
  let json;
  try {
    json = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    throw new GaliciaBlockedError(`Galicia devolvió algo que no es JSON en ${url} (${contentType || 'sin content-type'})`);
  }
  if (json?.errors) {
    throw new Error(`Galicia devolvió errores en ${url}: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return json?.data;
}

async function defaultGet(url, params) {
  const res = await axios.get(url, {
    params,
    headers: HEADERS,
    timeout: 20000,
    responseType: 'text',
    transformResponse: (d) => d,
    validateStatus: () => true,
  });
  return { status: res.status, body: res.data, contentType: res.headers?.['content-type'] ?? '' };
}

async function fetchCatalog(get) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = parseBffResponse(await get(LIST_URL, { page, pageSize: PAGE_SIZE }), LIST_URL);
    const list = data?.list ?? [];
    items.push(...list);
    if (list.length === 0 || items.length >= (data?.totalSize ?? 0)) break;
  }
  return items;
}

async function fetchDetail(get, id, retryDelayMs) {
  const url = detailUrl(id);
  for (let attempt = 0; ; attempt++) {
    try {
      return parseBffResponse(await get(url), url);
    } catch (error) {
      if (error instanceof GaliciaBlockedError || attempt >= DETAIL_RETRIES) throw error;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }
}

async function fetchDetails(get, ids, concurrency, retryDelayMs) {
  const details = [];
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      try {
        const detail = await fetchDetail(get, id, retryDelayMs);
        if (detail?.id != null) details.push(detail);
        else failed++;
      } catch (error) {
        if (error instanceof GaliciaBlockedError) throw error;
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { details, failed };
}

export async function getGaliciaPromotions({
  get = defaultGet,
  concurrency = DETAIL_CONCURRENCY,
  retryDelayMs = RETRY_DELAY_MS,
} = {}) {
  try {
    const items = await fetchCatalog(get);
    const listById = new Map(items.map((i) => [i.id, i]));
    const { details, failed } = await fetchDetails(get, [...listById.keys()], concurrency, retryDelayMs);
    const promotions = groupDetails(details).map((g) => normalizeGaliciaGroup(g, listById));

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      listed: items.length,
      failed_details: failed,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de Banco Galicia:', error.message);
    return {
      success: false,
      source: SOURCE,
      blocked: error instanceof GaliciaBlockedError,
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
