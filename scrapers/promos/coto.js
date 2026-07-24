import axios from 'axios';

/**
 * 🏷️ Scraper de PROMOCIONES de Coto
 *
 * Fuente: BFF público de Coto Digital (ATG/Oracle Commerce), sin sesión ni
 * `_dynSessConf` — un GET plano alcanza.
 * Endpoint: https://www.coto.com.ar/rest/model/atg/actors/cProfileActor/getPromocionesMulticanal?enviroment=ag&pushSite=CotoDigital
 *
 * Forma de la respuesta:
 *   { codigoError, result: { promocionesDigitales: [...], promocionesSucursalesFisicas: [...] } }
 * Ambos arrays comparten exactamente las mismas claves por item (ver abajo);
 * la única diferencia semántica es el flag `isDigital` (true/false respectivamente).
 * `vigenciaDesde`/`vigenciaHasta` vienen SIEMPRE null en la práctica — la vigencia
 * "real" que usa la IA es el texto libre `diasVigencia`/`dias`.
 *
 * Claves de cada promo cruda: id, textoDescuento, descripcion, observacion,
 * diasVigencia, dias[], banco, formaPago, icono, urlTerminos, vigenciaDesde,
 * vigenciaHasta, isDigital, aplicaCompra, tipoTarjetaFidelizada, wildcard.
 *
 * Los ids de `promocionesDigitales` y `promocionesSucursalesFisicas` NO son
 * un namespace único entre sí (ambos empiezan en rangos bajos) → el
 * external_id se prefija con `d`/`f` según `isDigital` para no colisionar.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const SOURCE = 'coto';
const BASE_URL = 'https://www.coto.com.ar';
const PROMOTIONS_ENDPOINT =
  `${BASE_URL}/rest/model/atg/actors/cProfileActor/getPromocionesMulticanal` +
  `?enviroment=ag&pushSite=CotoDigital`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Genera un slug simple a partir de un texto (sin acentos, kebab-case).
 */
function slugify(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '') // quitar diacríticos
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
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
      console.warn(`⚠️ Error de red consultando promos Coto, reintentando... (${error.code || error.message})`);
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/**
 * Mapea una promo cruda de Coto (digital o física) al contrato PULL,
 * conservando los campos ricos que necesita la IA para normalizar.
 * PURA — no hace I/O.
 * @param {object} rawPromo
 */
export function normalizeCotoPromotion(rawPromo) {
  const prefix = rawPromo.isDigital ? 'd' : 'f';

  return {
    external_id: `coto-${prefix}-${rawPromo.id}`,
    slug: slugify(`${rawPromo.textoDescuento}-${rawPromo.id}`),
    title: rawPromo.textoDescuento,
    description: rawPromo.descripcion,
    start_date: rawPromo.vigenciaDesde ?? null,
    end_date: rawPromo.vigenciaHasta ?? null,
    // Campos crudos que la IA necesita para inferir días/medios/bancos/topes.
    observacion: rawPromo.observacion,
    diasVigencia: rawPromo.diasVigencia,
    dias: rawPromo.dias,
    banco: rawPromo.banco,
    formaPago: rawPromo.formaPago,
    urlTerminos: rawPromo.urlTerminos,
    aplicaCompra: rawPromo.aplicaCompra,
    isDigital: rawPromo.isDigital,
  };
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de Coto
 */
export async function getCotoPromotions() {
  console.log('🏷️ Iniciando scraper de promociones de Coto...');

  try {
    const response = await getWithRetry(PROMOTIONS_ENDPOINT, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        Referer: `${BASE_URL}/sitios/cotodigital/`,
      },
      timeout: 20000,
    });

    const result = response?.data?.result ?? {};
    const digitales = Array.isArray(result.promocionesDigitales) ? result.promocionesDigitales : [];
    const fisicas = Array.isArray(result.promocionesSucursalesFisicas) ? result.promocionesSucursalesFisicas : [];
    const rawPromos = [...digitales, ...fisicas];

    console.log(`📊 ${digitales.length} promos digitales + ${fisicas.length} físicas recibidas de Coto`);

    const promotions = rawPromos.map(normalizeCotoPromotion);

    console.log(`🎉 Promociones de Coto normalizadas: ${promotions.length}`);

    return {
      success: true,
      source: SOURCE,
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de promociones Coto:', error.message);
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
