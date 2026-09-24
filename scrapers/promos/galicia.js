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
// Espera antes de cada reintento de un detalle (uno por elemento): 429/503 piden aire.
// El listado usa sólo la primera (un reintento).
const RETRY_DELAYS_MS = [1000, 3000];
// Pausa entre ids de la pasada final, que reintenta en serie los detalles que fallaron.
const FINAL_PASS_DELAY_MS = 300;
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

/** 429 o 503: el BFF pide que esperemos. Se reintenta con backoff; no es un bloqueo. */
export class GaliciaTransientError extends Error {}

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
  if (status === 403) {
    throw new GaliciaBlockedError(`Galicia respondió ${status} en ${url}`);
  }
  if (status === 429 || status === 503) {
    throw new GaliciaTransientError(`Galicia respondió ${status} en ${url}`);
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

/**
 * Corre `attempt` y, si falla con algo que no es un bloqueo (429/503, 5xx, red), lo
 * reintenta una vez por cada espera de `delaysMs`. Un bloqueo corta en el acto.
 */
async function withRetries(attempt, delaysMs) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (error) {
      if (error instanceof GaliciaBlockedError || i >= delaysMs.length) throw error;
      await sleep(delaysMs[i]);
    }
  }
}

async function fetchCatalog(get, retryDelaysMs) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    // Un hipo del listado se reintenta una vez: sin listado no hay corrida.
    const data = await withRetries(
      async () => parseBffResponse(await get(LIST_URL, { page, pageSize: PAGE_SIZE }), LIST_URL),
      retryDelaysMs.slice(0, 1),
    );
    const list = data?.list ?? [];
    items.push(...list);
    if (list.length === 0 || items.length >= (data?.totalSize ?? 0)) break;
  }
  return items;
}

async function fetchDetail(get, id, retryDelaysMs) {
  const url = detailUrl(id);
  return withRetries(async () => parseBffResponse(await get(url), url), retryDelaysMs);
}

async function fetchDetails(get, ids, concurrency, retryDelaysMs) {
  const details = [];
  const failedIds = [];
  let next = 0;
  // Un bloqueo en cualquier worker corta la corrida: los demás no toman ids nuevos
  // (seguir golpeando a un BFF que ya nos bloqueó sólo lo empeora).
  let aborted = false;
  const worker = async () => {
    while (!aborted && next < ids.length) {
      const id = ids[next++];
      try {
        const detail = await fetchDetail(get, id, retryDelaysMs);
        if (detail?.id != null) details.push(detail);
        else failedIds.push(id);
      } catch (error) {
        if (error instanceof GaliciaBlockedError) {
          aborted = true;
          throw error;
        }
        failedIds.push(id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return { details, failedIds };
}

/** Segunda oportunidad, en serie y con una pausa, para los detalles que fallaron. */
async function retryFailedDetails(get, failedIds, delayMs) {
  const recovered = [];
  const stillFailed = [];
  for (const id of failedIds) {
    await sleep(delayMs);
    const url = detailUrl(id);
    try {
      const detail = parseBffResponse(await get(url), url);
      if (detail?.id != null) recovered.push(detail);
      else stillFailed.push(id);
    } catch (error) {
      if (error instanceof GaliciaBlockedError) throw error;
      stillFailed.push(id);
    }
  }
  return { recovered, stillFailed: stillFailed.sort((a, b) => a - b) };
}

/**
 * Saca los grupos a los que podría pertenecer un detalle que no llegó.
 *
 * Un segmento que falta no puede publicarse como una promo con un nivel menos: el grupo
 * conserva su `external_id` (la clave no depende de quién está adentro), así que cambiaría la
 * huella, la IA la re-normalizaría (pago) sin ese nivel y al día siguiente volvería a cambiar.
 * Y con la clave `key#id` de los segmentos repetidos, que falte uno puede mover otra promo a la
 * clave base. Como no se sabe a qué grupo iba el detalle perdido, se saca todo lo de su comercio
 * (`m{idMarca}` del listado) o, si la promo es por categoría (sin idMarca), todos los grupos por
 * categoría (`c…`). Esas promos no salen en esta corrida: la staging de Laravel deja la fila de
 * ayer como está (ausente no es cambiada) y vuelven en la próxima.
 */
export function dropGroupsOfFailed(groups, failedIds, listById) {
  const merchants = new Set();
  let categories = false;
  for (const id of failedIds) {
    const idMarca = listById.get(id)?.idMarca;
    if (idMarca != null) merchants.add(`m${idMarca}`);
    else categories = true;
  }

  const kept = groups.filter(({ key }) => {
    const merchant = key.split('#')[0];
    return !merchants.has(merchant) && !(categories && merchant.startsWith('c'));
  });

  return { kept, dropped: groups.length - kept.length };
}

export async function getGaliciaPromotions({
  get = defaultGet,
  concurrency = DETAIL_CONCURRENCY,
  retryDelaysMs = RETRY_DELAYS_MS,
  finalPassDelayMs = FINAL_PASS_DELAY_MS,
} = {}) {
  try {
    const items = await fetchCatalog(get, retryDelaysMs);
    const listById = new Map(items.map((i) => [i.id, i]));
    const firstPass = await fetchDetails(get, [...listById.keys()], concurrency, retryDelaysMs);
    const finalPass = await retryFailedDetails(get, firstPass.failedIds, finalPassDelayMs);

    const details = [...firstPass.details, ...finalPass.recovered];
    const { kept, dropped } = dropGroupsOfFailed(groupDetails(details), finalPass.stillFailed, listById);
    const promotions = kept.map((g) => normalizeGaliciaGroup(g, listById));

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      listed: items.length,
      failed_details: finalPass.stillFailed.length,
      failed_ids: finalPass.stillFailed,
      dropped_groups: dropped,
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
