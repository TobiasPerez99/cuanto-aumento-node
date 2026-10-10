import axios from 'axios';
import { clean, parseValidityText } from '../../cores/promoText.js';

/**
 * 🏷️ Scraper de beneficios de CUENTA DNI (Banco Provincia)
 *
 * Fuente (relevada el 2026-09-23, docs/superpowers/research/2026-09-23-fuentes-de-promos/cuenta-dni.md):
 *   1. GET /cuentadni/contenidos/cdnibeneficios/  → HTML renderizado en el servidor;
 *      cada tarjeta es un `div.callModalCDNI` con `id="{slug}-{idBeneficio}"`.
 *   2. GET /cuentadni/Home/GetBeneficioData2?idBeneficio={id}  → el beneficio en JSON
 *      (ASP.NET MVC 5): título, %, días, condiciones, legal, logos.
 * Sin auth, sin WAF, sin User-Agent obligatorio. Son ~21 requests por corrida.
 *
 * ⚠️ **`fecha_desde`/`fecha_hasta` son la ventana en que se PUBLICA la tarjeta, no la
 * vigencia.** Pueden diferir en días o meses del legal (Coto: legal 19/03→24/09,
 * ventana 01/09→25/09). La vigencia se lee del legal (`parseValidityText`, que cubre
 * los ocho formatos vistos) y la ventana queda como respaldo explícito, marcado en
 * `vigencia_origen`. Contrastado el 2026-10-10: 20 de 20 legales completos se leen.
 *
 * ⚠️ **Con `tipo = 2`, `porcentaje` es la CANTIDAD DE CUOTAS sin interés**, no un %.
 * Mismo gotcha que `discount` en Cencosud: se emite ya desambiguado.
 *
 * ⚠️ **Un beneficio con `urlPagina` trae el JSON incompleto** (el legal del de
 * "localidades" es literalmente "PROMOCIÓN VÁLIDA DEL"): el sitio no abre el modal y
 * manda a un micrositio aparte. Se descartan; no son de supermercados.
 *
 * ⚠️ **Un id inexistente responde 200** con `{ Entity: null, Success: false }`: hay
 * que mirar `Success`, no el status.
 *
 * Origen: la entrega de Prácticas Profesionalizantes de **Thiago Coro** (2026-09),
 * que recorría la grilla con Puppeteer abriendo el modal de cada tarjeta. Acá se
 * reemplazó por el JSON que alimenta ese modal (mismo criterio que con Santander).
 *
 * NO lanza excepciones al caller: ante error devuelve `{ success:false, ... }`.
 */

const BASE_URL = 'https://www.bancoprovincia.com.ar';
const LIST_URL = `${BASE_URL}/cuentadni/contenidos/cdnibeneficios/`;
const DETAIL_URL = `${BASE_URL}/cuentadni/Home/GetBeneficioData2?idBeneficio=`;
const SOURCE = 'cuentadni';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const ARGENTINA_OFFSET_MS = 3 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultHttpGet = (url) =>
  axios.get(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' },
    timeout: 20000,
    validateStatus: () => true,
  });

/** Ids de beneficio de la grilla: `<div class="callModalCDNI …" id="carrefour-1072">`. */
export function parseBenefitIds(html) {
  const ids = [];
  const re = /<div\b[^>]*\bclass="[^"]*\bcallModalCDNI\b[^"]*"[^>]*>/g;
  for (const tag of String(html ?? '').match(re) ?? []) {
    const id = tag.match(/\bid="[^"]*?-(\d+)"/)?.[1];
    if (id && !ids.includes(Number(id))) ids.push(Number(id));
  }
  return ids;
}

/** `"/Date(1790737200000)/"` (serializador de .NET) → epoch en ms, o null. */
export function fromDotNetDate(value) {
  const match = String(value ?? '').match(/Date\((-?\d+)\)/);
  return match ? Number(match[1]) : null;
}

/** Fecha argentina (UTC-3, sin horario de verano desde 2009) de un epoch en ms. */
function argentineDate(ms) {
  return new Date(ms - ARGENTINA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Ventana de publicación como rango de fechas. `fecha_hasta` es la medianoche
 * argentina del día SIGUIENTE al último visible: se le resta un día.
 */
export function publicationWindow(beneficio) {
  const from = fromDotNetDate(beneficio?.fecha_desde);
  const to = fromDotNetDate(beneficio?.fecha_hasta);
  const toIsMidnight = to !== null && (to - ARGENTINA_OFFSET_MS) % DAY_MS === 0;
  return {
    start_date: from === null ? null : argentineDate(from),
    end_date: to === null ? null : argentineDate(toIsMidnight ? to - DAY_MS : to),
  };
}

/** ¿El beneficio viene completo y se puede publicar? Devuelve el motivo si no. */
export function skipReason(entity) {
  const beneficio = entity?.Beneficio;
  if (!beneficio) return 'sin_beneficio';
  if (beneficio.oculto === 1) return 'oculto';
  if (beneficio.urlPagina) return 'micrositio';
  return null;
}

/**
 * Convierte el JSON de un beneficio al contrato de promoción de
 * `App\Services\PromotionsProviders\CuentaDniService`. Función pura.
 */
export function normalizeCuentaDniBenefit(entity, reference = new Date()) {
  const b = entity.Beneficio;
  const isInstallments = Number(b.tipo) === 2;
  const amount = Number(b.porcentaje);
  const validAmount = Number.isFinite(amount) && amount > 0 ? amount : null;

  const fromLegal = parseValidityText(b.legal, reference);
  const window = publicationWindow(b);
  const useLegal = fromLegal.start_date !== null && fromLegal.end_date !== null;

  const condiciones = (Array.isArray(entity.Condiciones) ? entity.Condiciones : [])
    .slice()
    .sort((a, z) => (a?.orden ?? 0) - (z?.orden ?? 0))
    .map((c) => clean(c?.texto))
    .filter(Boolean);

  return {
    external_id: `cdni-${b.id}`,
    source: SOURCE,
    slug: clean(b.url),
    title: clean(b.titulo),
    subtitle: clean(b.subtitulo),
    bajada: clean(b.bajada),
    tipo_beneficio: isInstallments ? 'cuotas' : 'descuento',
    descuento_porcentaje: isInstallments ? null : validAmount,
    cuotas: isInstallments ? validAmount : null,
    dias: clean(b.titulo_fecha),
    condiciones,
    legal: clean(b.legal, 4000),
    rubros: (Array.isArray(entity.Rubros) ? entity.Rubros : []).map((r) => clean(r?.nombre)).filter(Boolean),
    // Las claves de los logos son lo único que nombra a los súper chicos de las
    // promos de "red de adheridos" (el link a la nómina está roto).
    logos: (Array.isArray(entity.Imagenes) ? entity.Imagenes : [])
      .slice()
      .sort((a, z) => (a?.orden ?? 0) - (z?.orden ?? 0))
      .map((i) => clean(i?.url))
      .filter(Boolean),
    start_date: useLegal ? fromLegal.start_date : window.start_date,
    end_date: useLegal ? fromLegal.end_date : window.end_date,
    vigencia_origen: useLegal ? 'legal' : 'ventana',
    url_promo: `${LIST_URL}#${clean(b.url) ?? b.id}`,
  };
}

/** Lee y valida la respuesta de un detalle. Lanza ante status, HTML o `Success: false`. */
export function parseDetailResponse(response, id) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`beneficio ${id}: HTTP ${response.status}`);
  }
  let data = response.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error(`beneficio ${id}: la respuesta no es JSON`);
    }
  }
  if (data?.Success !== true || !data?.Entity) {
    throw new Error(`beneficio ${id}: Success=false (${clean(data?.Message, 120) ?? 'sin mensaje'})`);
  }
  return data.Entity;
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Beneficios de Cuenta DNI
 *
 * Un detalle que falla (con un reintento) no aborta la corrida: se informa en
 * `failed_ids` y ese beneficio no se emite (la staging de Laravel conserva la fila
 * de ayer). Si no se pudo leer la grilla, o fallaron TODOS los detalles, la corrida
 * falla.
 */
export async function getCuentaDniPromotions({
  httpGet = defaultHttpGet,
  sleep = defaultSleep,
  delayMs = 300,
  now = new Date(),
} = {}) {
  console.log('🏷️ Iniciando scraper de beneficios de Cuenta DNI...');

  try {
    const list = await httpGet(LIST_URL);
    if (list.status < 200 || list.status >= 300) throw new Error(`la grilla respondió HTTP ${list.status}`);

    const ids = parseBenefitIds(list.data);
    if (ids.length === 0) {
      throw new Error('la grilla no trajo ningún beneficio (¿cambió el markup de las tarjetas?)');
    }
    console.log(`📋 ${ids.length} beneficios en la grilla`);

    const promotions = [];
    const skipped = [];
    const failedIds = [];

    for (const id of ids) {
      let entity = null;
      for (let attempt = 1; attempt <= 2 && entity === null; attempt++) {
        try {
          entity = parseDetailResponse(await httpGet(`${DETAIL_URL}${id}`), id);
        } catch (error) {
          if (attempt === 2) {
            console.warn(`⚠️ ${error.message}`);
            failedIds.push(id);
          } else {
            await sleep(1000);
          }
        }
      }
      await sleep(delayMs);
      if (entity === null) continue;

      const reason = skipReason(entity);
      if (reason) {
        skipped.push({ id, reason });
        continue;
      }
      promotions.push(normalizeCuentaDniBenefit(entity, now));
    }

    if (promotions.length === 0 && failedIds.length > 0) {
      throw new Error(`fallaron los ${failedIds.length} detalles de la grilla`);
    }

    console.log(
      `🎉 Cuenta DNI: ${promotions.length} beneficios` +
        (skipped.length ? ` · ${skipped.length} descartados (${skipped.map((s) => `${s.id}:${s.reason}`).join(', ')})` : '') +
        (failedIds.length ? ` · ${failedIds.length} fallidos` : '')
    );

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      promotions,
      skipped,
      failed_ids: failedIds,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de Cuenta DNI:', error.message);
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
