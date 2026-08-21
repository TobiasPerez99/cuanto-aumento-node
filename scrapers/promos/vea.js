import axios from 'axios';
import { createHash } from 'crypto';

/**
 * 🏷️ Scraper de PROMOCIONES BANCARIAS de Vea
 *
 * Fuente: VTEX Master Data de Cencosud, entidad "JN", documento `bankDiscount`.
 *   GET https://www.vea.com.ar/api/dataentities/JN/documents/bankDiscount
 *       ?_fields=value,id&an=jumboargentina
 *
 * Es un endpoint PÚBLICO (sin auth, sin cookies, sin browser) que devuelve UN
 * documento cuyo campo `value` es un **string con un JSON adentro** (doble parse)
 * con ~193 promociones bancarias ya estructuradas: banco, días, porcentaje,
 * cuotas, medio de pago, vigencia y el texto legal completo.
 *
 * ⚠️ El documento es de la cuenta `jumboargentina` y es COMPARTIDO por las tres
 * cadenas de Cencosud (Vea, Disco, Jumbo). Cada promoción declara a qué sitios
 * aplica en `websites[]` (con repetidos), así que se filtra por `veaargentina`.
 * El mismo endpoint serviría para Disco y Jumbo cambiando ese filtro — hoy
 * `jumbo_promos.js` deriva las promos de Jumbo de `clusterHighlights`, que da
 * títulos crípticos; migrarlo a esta fuente es una mejora pendiente anotada.
 *
 * ⚠️ Mapeo de días: `days` usa 1=lunes … 6=sábado. Confirmado contra el texto
 * legal de una promo cuyo `days` es ["1","4"] y cuyo `info` dice "entrega para
 * Lunes y Jueves". PERO el campo no es totalmente confiable: lo carga un
 * operador en el backoffice de Cencosud y hay al menos un caso cuyo `info` dice
 * "Viernes, Sábado y Domingo" mientras `days` trae sólo ["5","6"]; el valor
 * domingo no aparece nunca en el dataset. Por eso se emite `dias` (derivado) y
 * TAMBIÉN `info`/`legals` crudos: la fuente de verdad para resolver la
 * ambigüedad es el texto libre, que es lo que normaliza la IA — mismo criterio
 * que se usa con `diasVigencia` en el scraper de Coto.
 *
 * Origen: la entrega de Prácticas Profesionalizantes de Joaquin Alodi (2026-08)
 * identificó que las promos bancarias de Vea son el dato valioso del sitio y
 * que /descuentos-del-dia no es server-rendered. Su implementación las leía como
 * texto plano del DOM (19 bloques, sin estructura); acá se toman del Master Data
 * que alimenta esa misma página, con los campos ya discriminados.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const ENDPOINT =
  'https://www.vea.com.ar/api/dataentities/JN/documents/bankDiscount?_fields=value,id&an=jumboargentina';

/** Identificador del sitio de Vea dentro de `websites[]`. */
const VEA_WEBSITE = 'veaargentina';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 1=lunes … 7=domingo (ver caveat de cabecera sobre la confiabilidad). */
const DAY_NAMES = {
  1: 'lunes',
  2: 'martes',
  3: 'miercoles',
  4: 'jueves',
  5: 'viernes',
  6: 'sabado',
  7: 'domingo',
};

/**
 * GET con 1 reintento ante error de red / timeout.
 */
async function getWithRetry(url, config, retries = 1) {
  try {
    return await axios.get(url, config);
  } catch (error) {
    const isNetwork = !error.response;
    if (isNetwork && retries > 0) {
      console.warn(`⚠️ Error de red consultando promos Vea, reintentando... (${error.code || error.message})`);
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/**
 * Normaliza un texto: colapsa espacios y saltos, recorta. null si queda vacío.
 */
function clean(value, maxLength = null) {
  if (value === null || value === undefined) return null;
  let text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (maxLength && text.length > maxLength) text = text.slice(0, maxLength);
  return text;
}

/**
 * Offset fijo de Argentina (UTC-3), en segundos.
 * El país no aplica horario de verano desde 2009, así que no hace falta una
 * librería de zonas horarias.
 */
const ARGENTINA_UTC_OFFSET_SECONDS = 3 * 3600;

/**
 * Convierte el timestamp Unix (en segundos, como string) a 'YYYY-MM-DD'
 * **en hora argentina**. Devuelve null si no es parseable — nunca inventa una fecha.
 *
 * ⚠️ El offset NO es cosmético. Cencosud graba estos timestamps en hora local y
 * usa las **23:59 ART** como centinela de "último día de vigencia". Leídas en
 * UTC, esas 23:59 del 31/08 son las 02:59 UTC del 01/09, así que recortar el
 * `toISOString()` directo corre `end_date` un día hacia adelante — pasaba en 150
 * de las 193 promos del dataset (78%). Importa porque `start_date`/`end_date`
 * alimentan el filtro de overlap mensual de `AbstractScrapperPullProvider`: una
 * promo vencida el 31/08 se publicaba un día de más y, al caer justo en el corte
 * de mes, se contaba como de septiembre.
 *
 * `dateStart` no estaba afectado (00:00 ART = 03:00 UTC, mismo día), pero se
 * aplica el mismo offset por consistencia.
 */
export function toDate(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date((n - ARGENTINA_UTC_OFFSET_SECONDS) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Mapea el array `days` a nombres de día en español.
 * Descarta valores fuera de 1..7 en vez de adivinar.
 */
export function mapDays(days) {
  if (!Array.isArray(days)) return [];
  const names = days
    .map((d) => DAY_NAMES[Number(d)])
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Lista de nombres de banco de una promoción.
 * `banks` viene como array de objetos {name,...} o, en algunos registros,
 * como array de strings sueltos.
 */
export function mapBanks(banks) {
  if (!Array.isArray(banks)) return [];
  const names = banks
    .map((b) => (typeof b === 'string' ? b : b?.name))
    .map((n) => clean(n))
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * ¿Aplica esta promoción al sitio de Vea?
 * `websites` trae el account repetido una vez por sucursal; basta con que
 * aparezca al menos una vez.
 */
export function appliesToVea(raw) {
  const websites = Array.isArray(raw?.websites) ? raw.websites : [];
  return websites.some((w) => String(w).trim().toLowerCase() === VEA_WEBSITE);
}

/**
 * Deriva un identificador estable para la promoción.
 *
 * El dataset NO trae un id por promoción (el `id` del endpoint es el del
 * documento contenedor, igual para las 193). Sin un external_id estable, el
 * `firstOrCreate` de `PromotionForProcess` duplicaría todo en cada corrida, así
 * que se hashean los campos que identifican la promo y que no cambian entre
 * ejecuciones. Se excluyen `priority` y `stores` a propósito: varían con la
 * operación diaria sin que la promoción sea otra.
 */
export function buildExternalId(raw) {
  const fingerprint = JSON.stringify({
    banks: mapBanks(raw?.banks),
    discount: raw?.discount ?? null,
    discountText: clean(raw?.discountText),
    installments: raw?.installments ?? null,
    installmentsText: clean(raw?.installmentsText),
    dateStart: raw?.dateStart ?? null,
    dateEnd: raw?.dateEnd ?? null,
    days: Array.isArray(raw?.days) ? [...raw.days].sort() : [],
  });

  const hash = createHash('sha1').update(fingerprint).digest('hex').slice(0, 12);
  return `vea-${hash}`;
}

/**
 * Formatea el número de `discount` como lo muestra la tarjeta: "3.00" → "3",
 * "12.50" → "12.5".
 */
function formatAmount(discount) {
  const n = Number(discount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n % 1 === 0 ? String(n.toFixed(0)) : String(n);
}

/**
 * Reconstruye la etiqueta de la promoción.
 *
 * ⚠️ CRÍTICO — `discount` y `discountText` NO son dos datos independientes:
 * son el NÚMERO y su SUFIJO, y la tarjeta los muestra CONCATENADOS. Leerlos por
 * separado inventa promociones que no existen. Casos reales del dataset:
 *
 *   discount=3.00  + "cuotas sin interés"       → "3 cuotas sin interés"
 *   discount=20.00 + "%"                        → "20%"
 *   discount=20.00 + ""                         → "20%"  (el % es implícito)
 *   discount=3.00  + ",6 y 12 Cuotas sin Interés" → "3,6 y 12 Cuotas sin Interés"
 *   discount=25.00 + "% y 3 cuotas sin interés" → "25% y 3 cuotas sin interés"
 *
 * O sea: un `discount=12` con texto "Cuotas sin interés" son DOCE CUOTAS, no un
 * 12% de descuento. Por eso `descuento_porcentaje` sólo se completa cuando el
 * sufijo confirma que el número es un porcentaje (ver `splitDiscount`).
 *
 * El espacio sólo se agrega cuando el sufijo empieza con letra; con "%" o ","
 * va pegado.
 */
export function buildDiscountLabel(raw) {
  const amount = formatAmount(raw?.discount);
  const suffix = clean(raw?.discountText);

  if (!amount) return suffix;
  if (!suffix) return `${amount}%`; // sufijo vacío ⇒ porcentaje implícito

  const separator = /^[a-záéíóúñ]/i.test(suffix) ? ' ' : '';
  return `${amount}${separator}${suffix}`;
}

/**
 * Decide qué representa el número de `discount` según su sufijo.
 *
 * Devuelve { porcentaje, cuotas }, ambos posiblemente null. Ante un sufijo
 * mixto o ambiguo se prefiere dejar el campo en null y que la IA resuelva
 * leyendo `etiqueta`/`info`: es preferible un null explícito a un número con
 * la unidad equivocada.
 */
export function splitDiscount(raw) {
  const n = Number(raw?.discount);
  if (!Number.isFinite(n) || n <= 0) return { porcentaje: null, cuotas: null };

  const suffix = clean(raw?.discountText) ?? '';

  // Sufijo vacío o que arranca con "%" ⇒ el número es un porcentaje.
  if (suffix === '' || suffix.startsWith('%')) {
    return { porcentaje: n, cuotas: null };
  }

  // Sufijo que habla de cuotas (o "CSI") sin empezar con % ⇒ son cuotas.
  if (/cuota|csi/i.test(suffix)) {
    return { porcentaje: null, cuotas: n };
  }

  return { porcentaje: null, cuotas: null };
}

/**
 * Arma el título legible de la promoción: etiqueta + bancos.
 */
export function buildTitle(raw) {
  const bancos = mapBanks(raw?.banks);

  const head =
    buildDiscountLabel(raw) || clean(raw?.installmentsText, 120) || 'Promoción bancaria';

  return bancos.length ? `${head} — ${bancos.join(', ')}` : head;
}

/**
 * Convierte un registro crudo al contrato de promoción que consume
 * `App\Services\PromotionsProviders\VeaService`.
 *
 * Función pura: es la parte unit-testeable, sin red.
 */
export function normalizeVeaPromotion(raw) {
  const { porcentaje, cuotas } = splitDiscount(raw);

  return {
    external_id: buildExternalId(raw),
    title: buildTitle(raw),
    source: 'vea',
    bancos: mapBanks(raw?.banks),
    // Etiqueta tal como la muestra Cencosud (número + sufijo concatenados).
    // Es el campo más fiel; `descuento_porcentaje`/`cuotas` son la lectura
    // desambiguada y quedan en null cuando el sufijo es mixto o ambiguo.
    etiqueta: buildDiscountLabel(raw),
    descuento_porcentaje: porcentaje,
    cuotas: cuotas,
    cuotas_texto: clean(raw?.installmentsText),
    medios_de_pago: raw?.paymentMethod && typeof raw.paymentMethod === 'object'
      ? Object.keys(raw.paymentMethod)
      : [],
    dias: mapDays(raw?.days),
    // Texto libre: es la fuente de verdad ante la ambigüedad de `days`
    // (ver caveat de cabecera). Se pasa sin interpretar, con tope de largo.
    info: clean(raw?.info, 4000),
    legales: clean(raw?.legals, 4000),
    cft: clean(raw?.cft),
    exclusiva: raw?.isExclusive === true,
    solo_checkout: raw?.checkout === true,
    sucursales: Array.isArray(raw?.stores) ? raw.stores.length : 0,
    start_date: toDate(raw?.dateStart),
    end_date: toDate(raw?.dateEnd),
  };
}

/**
 * Filtra y normaliza el lote crudo.
 *
 * @param {Array}  records  promociones crudas del Master Data
 * @param {Date}   now      referencia temporal (inyectable para tests)
 *
 * Función pura: unit-testeable con un fixture.
 */
export function normalizeVeaPromotions(records, now = new Date()) {
  if (!Array.isArray(records)) return [];

  const cutoff = Math.floor(now.getTime() / 1000);

  const promotions = records
    .filter(appliesToVea)
    // Se descartan las ya vencidas: el dataset arrastra promos de 2022/2023.
    // El recorte fino por mes lo hace igual `AbstractScrapperPullProvider`.
    .filter((raw) => {
      const end = Number(raw?.dateEnd);
      return !Number.isFinite(end) || end <= 0 || end >= cutoff;
    })
    .map(normalizeVeaPromotion);

  // Dedupe defensivo: dos filas idénticas colapsan al mismo external_id.
  const byId = new Map();
  for (const promo of promotions) {
    if (!byId.has(promo.external_id)) byId.set(promo.external_id, promo);
  }

  return [...byId.values()];
}

/**
 * Extrae el array de promociones del envoltorio del Master Data.
 * `value` llega como string con JSON adentro (doble parse).
 */
export function unwrapDocument(payload) {
  const value = payload?.value;
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones bancarias de Vea
 */
export async function getVeaPromotions() {
  console.log('🏷️ Iniciando scraper de promociones de Vea...');

  try {
    const response = await getWithRetry(ENDPOINT, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: 20000,
    });

    const records = unwrapDocument(response.data);
    console.log(`📊 ${records.length} promociones bancarias en el Master Data de Cencosud`);

    const promotions = normalizeVeaPromotions(records);

    console.log(`🎉 Promociones de Vea vigentes: ${promotions.length}`);

    if (records.length > 0 && promotions.length === 0) {
      // El documento respondió pero nada quedó: o cambió el nombre del sitio en
      // `websites`, o el dataset quedó desactualizado. Avisar explícitamente.
      console.warn(
        `⚠️ El Master Data devolvió ${records.length} registros pero ninguno vigente para "${VEA_WEBSITE}".`
      );
    }

    return {
      success: true,
      source: 'vea',
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de promociones Vea:', error.message);

    return {
      success: false,
      source: 'vea',
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
