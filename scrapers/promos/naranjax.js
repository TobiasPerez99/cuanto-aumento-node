import axios from 'axios';
import { clean, ddmmyyyyToIso } from '../../cores/promoText.js';

/**
 * 🏷️ Scraper de promociones de NARANJA X — sólo las cadenas que compara Ahorrapp
 *
 * Fuente: el BFF JSON público del buscador de promociones
 * (`https://bkn-promotions.naranjax.com/bff-promotions-web/api`), sin token ni
 * cookies. Relevamiento: docs/superpowers/research/2026-09-23-fuentes-de-promos/naranja-x.md
 *   POST /binder/{slug}                       → los planes vigentes del comercio (`current`)
 *   POST /binder/{slug}/detail/{planUrl}      → tope, legal, medios de pago, días
 *
 * **Alcance (decisión del titular, 2026-10-10):** sólo nuestras cadenas. Naranja X
 * tiene ~19.000 comercios; traerlos todos eran ~10.000 promos de cuotas de comercios
 * chicos. Se recorre una lista fija de "binders" (así llama el BFF a cada comercio)
 * → comercio de Ahorrapp, y se descarta el **Plan Zeta genérico** (el mismo
 * beneficio de la tarjeta, repetido en casi todos los comercios). Un "10% off y Plan
 * Zeta" sí entra: tiene descuento propio.
 *
 * ⚠️ **Cloudflare filtra el cliente.** Con el User-Agent por defecto de axios o de
 * curl responde 403 (challenge); con uno de navegador, 200. Medido el 2026-10-10:
 * el `fetch` nativo de Node recibe el challenge AUNQUE lleve User-Agent de
 * navegador, y axios con el mismo UA pasa. No cambiar a `fetch`.
 * Un 403 o HTML en vez de JSON es un bloqueo: la corrida falla, nunca "0 promos".
 *
 * ⚠️ **Una cadena son varios binders** (`disco` es la tienda física y
 * `disco_com_ar` la online, con el mismo "12 cuotas"). Se agrupan por (comercio,
 * plan) en una sola promo con `comercios_nx` listando los binders.
 *
 * ⚠️ **El sufijo del plan es su estado** (`-C` vigente, `-A` próximo): se quita del
 * `external_id`, o la promo cambiaría de id al entrar en vigencia.
 *
 * ⚠️ **`status` no sirve para filtrar vigencia** (mezcla próximos y vencidos): se
 * filtra por `dateTo`.
 *
 * NO lanza excepciones al caller: ante error devuelve `{ success:false, ... }`.
 */

const BFF = 'https://bkn-promotions.naranjax.com/bff-promotions-web/api';
const SOURCE = 'naranjax';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

/**
 * Binders de Naranja X → comercio de Ahorrapp. Verificado el 2026-10-10: Josimar no
 * está en Naranja X, y Carrefour, Dia y Farmacity no tienen binder online aparte.
 * Un binder que deja de existir responde 404 y se informa sin tirar la corrida.
 */
export const BINDERS = {
  disco: 'Disco',
  disco_com_ar: 'Disco',
  jumbo: 'Jumbo',
  jumbo_com_ar: 'Jumbo',
  vea: 'Vea',
  vea_com_ar: 'Vea',
  carrefour: 'Carrefour',
  dia: 'Dia',
  coto: 'Coto',
  cotodigital: 'Coto',
  changomas: 'Masonline',
  hiperchangomas: 'Masonline',
  superchangomas: 'Masonline',
  masonline_com: 'Masonline',
  farmacity: 'Farmacity',
};

const WEEKDAYS = { 1: 'lunes', 2: 'martes', 3: 'miercoles', 4: 'jueves', 5: 'viernes', 6: 'sabado', 7: 'domingo' };

const PAYMENT_METHODS = {
  credito: 'Tarjeta de crédito Naranja X',
  debito: 'Tarjeta de débito Naranja X Visa',
  dinero: 'Dinero en cuenta Naranja X',
};

const RENEWAL = { weekly: 'semanal', monthly: 'mensual', daily: 'diario' };
const REFUND_DESTINATION = { account: 'reintegro en la cuenta Naranja X', card: 'en el resumen de la tarjeta' };

export class NaranjaXBlockedError extends Error {}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultHttpPost = (url, body) =>
  axios.post(url, body, {
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', Accept: 'application/json' },
    timeout: 20000,
    validateStatus: () => true,
  });

/** `exclusiva_turbo-25_off-25_de_descuento-C` → sin el sufijo de estado. */
export function planKey(planUrl) {
  return String(planUrl ?? '').replace(/-[A-Z]$/, '');
}

const numberOrNull = (value) => {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) && n > 0 ? n : null;
};

/** ¿Es el Plan Zeta genérico (sin descuento propio)? */
export function isGenericPlanZeta(plan) {
  const title = `${plan?.title ?? ''} ${plan?.benefitName ?? ''}`;
  return /plan\s*z/i.test(title) && numberOrNull(plan?.benefit?.discountPercentage) === null;
}

/** Fecha de hoy en Argentina (UTC-3), para comparar contra `dateTo`. */
function argentineToday(now) {
  return new Date(now.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Texto de `promotionDetails.description`, que a veces es el string literal "true"/"false". */
function description(value) {
  const text = clean(value);
  return text && !/^(true|false|null)$/i.test(text) ? text : null;
}

/**
 * Convierte el detalle de un plan al contrato de promoción de
 * `App\Services\PromotionsProviders\NaranjaXService`. Función pura.
 *
 * No viajan `commerces` (la nómina de sucursales adheridas cambia sola), `tags`
 * (repiten lo estructurado) ni las imágenes (el fondo rota entre corridas): todo eso
 * cambiaría la huella sin que cambie la promo.
 */
export function normalizeNaranjaXPlan(detail, { merchant, binderNames, plan }) {
  const details = detail?.promotionDetails ?? {};
  const days = detail?.days ?? {};
  const title = clean(detail?.benefitName) ?? clean(plan?.title);
  const installments = title?.match(/(\d+)\s*cuotas/i);

  return {
    external_id: `nx-${merchant.toLowerCase()}-${planKey(plan.url)}`,
    source: SOURCE,
    comercio: merchant,
    comercios_nx: binderNames,
    title,
    descuento_porcentaje: numberOrNull(detail?.benefit?.discountPercentage ?? plan?.benefit?.discountPercentage),
    cuotas: installments ? Number(installments[1]) : null,
    elegibilidad: clean(detail?.ephemeris?.description),
    medios_de_pago: (detail?.paymentMethods ?? []).map((m) => PAYMENT_METHODS[m] ?? m),
    captura: (detail?.captureMethods ?? []).map((c) => c?.key).filter(Boolean),
    dias: [...new Set(days.weekdaysApplied ?? [])].sort((a, z) => a - z).map((d) => WEEKDAYS[d]).filter(Boolean),
    fechas_puntuales: (days.daysApplied ?? []).map(ddmmyyyyToIso).filter(Boolean),
    start_date: ddmmyyyyToIso(days.dateFrom),
    end_date: ddmmyyyyToIso(days.dateTo),
    tope: numberOrNull(details.refundLimit),
    tope_periodo: RENEWAL[details.renewalType] ?? null,
    compra_minima: numberOrNull(details.forPurchasesOver),
    online: details.appliesOnline === true,
    presencial: details.appliesInStore === true,
    productos_seleccionados: details.validOnSelectedProducts === true,
    acreditacion: REFUND_DESTINATION[detail?.refundDestination] ?? null,
    // Promo de un tercero que Naranja X sólo lista (p. ej. un QR de otra billetera).
    tercero: detail?.isThirdParty === true,
    descripcion: description(details.description),
    legal: clean(detail?.legal, 4000),
  };
}

/** Lee una respuesta del BFF. 403 o HTML es un bloqueo de Cloudflare. */
export function parseBffResponse(response, label) {
  const isJson = response.data !== null && typeof response.data === 'object';
  if (response.status === 403 || (response.status >= 200 && response.status < 300 && !isJson)) {
    throw new NaranjaXBlockedError(`${label}: Cloudflare bloqueó el pedido (HTTP ${response.status})`);
  }
  if (response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`${label}: HTTP ${response.status}`);
  }
  return response.data;
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de Naranja X en nuestras cadenas
 */
export async function getNaranjaXPromotions({
  httpPost = defaultHttpPost,
  sleep = defaultSleep,
  delayMs = 400,
  now = new Date(),
  binders = BINDERS,
} = {}) {
  console.log('🏷️ Iniciando scraper de promociones de Naranja X (cadenas de Ahorrapp)...');

  const today = argentineToday(now);
  const missingBinders = [];
  const failed = [];
  const groups = new Map();
  let binderHits = 0;

  const call = async (url, label) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return parseBffResponse(await httpPost(url, {}), label);
      } catch (error) {
        if (error instanceof NaranjaXBlockedError || attempt >= 2) throw error;
        await sleep(1000);
      }
    }
  };

  try {
    for (const [slug, merchant] of Object.entries(binders)) {
      let binder;
      try {
        binder = await call(`${BFF}/binder/${slug}`, `binder ${slug}`);
      } catch (error) {
        if (error instanceof NaranjaXBlockedError) throw error;
        failed.push({ binder: slug, error: error.message });
        continue;
      } finally {
        await sleep(delayMs);
      }

      if (binder === null) {
        missingBinders.push(slug);
        continue;
      }
      binderHits++;

      const plans = [...(binder.current ?? []), ...(binder.nearCurrent ?? [])];
      for (const plan of plans) {
        if (!plan?.url || isGenericPlanZeta(plan)) continue;
        const key = `${merchant}|${planKey(plan.url)}`;
        const group = groups.get(key);
        const binderName = clean(binder.commerceName) ?? slug;

        // El mismo plan en el binder online de la misma cadena: se suma al grupo sin
        // volver a pedir el detalle.
        if (group) {
          if (!group.binderNames.includes(binderName)) group.binderNames.push(binderName);
          continue;
        }

        let detail;
        try {
          detail = await call(`${BFF}/binder/${slug}/detail/${plan.url}`, `detalle ${slug}/${plan.url}`);
        } catch (error) {
          if (error instanceof NaranjaXBlockedError) throw error;
          failed.push({ binder: slug, plan: plan.url, error: error.message });
          continue;
        } finally {
          await sleep(delayMs);
        }
        if (!detail) {
          failed.push({ binder: slug, plan: plan.url, error: 'detalle inexistente (404)' });
          continue;
        }

        groups.set(key, { merchant, plan, detail, binderNames: [binderName] });
      }
    }

    if (binderHits === 0) {
      throw new Error(`ningún binder de nuestras cadenas respondió (${missingBinders.length} inexistentes, ${failed.length} fallidos)`);
    }

    const promotions = [...groups.values()]
      .map(({ merchant, plan, detail, binderNames }) => normalizeNaranjaXPlan(detail, { merchant, binderNames, plan }))
      // `status` mezcla próximos y vencidos: la vigencia se decide por la fecha de fin.
      .filter((promo) => promo.end_date === null || promo.end_date >= today);

    if (missingBinders.length) console.warn(`⚠️ Binders que ya no existen en Naranja X: ${missingBinders.join(', ')}`);
    console.log(`🎉 Naranja X: ${promotions.length} promociones en ${binderHits} binders${failed.length ? ` · ${failed.length} fallidos` : ''}`);

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      promotions,
      missing_binders: missingBinders,
      failed,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de Naranja X:', error.message);
    return {
      success: false,
      source: SOURCE,
      blocked: error instanceof NaranjaXBlockedError,
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
