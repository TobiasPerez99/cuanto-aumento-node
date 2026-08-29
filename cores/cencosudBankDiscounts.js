import axios from 'axios';
import { createHash } from 'crypto';

/**
 * 🏦 Core compartido de PROMOCIONES BANCARIAS de Cencosud (Disco · Jumbo · Vea)
 *
 * Fuente: VTEX Master Data de Cencosud, entidad "JN", documento `bankDiscount`.
 *   GET https://<host>/api/dataentities/JN/documents/bankDiscount
 *       ?_fields=value,id&an=jumboargentina
 *
 * Endpoint PÚBLICO (sin auth, sin cookies, sin browser) que devuelve UN documento
 * cuyo campo `value` es un **string con un JSON adentro** (doble parse) con 193
 * promociones bancarias ya estructuradas: banco, días, porcentaje, cuotas, medio
 * de pago, vigencia y el texto legal completo.
 *
 * ⚠️ **`an=jumboargentina` es OBLIGATORIO.** Con `an=discoargentina`, o sin el
 * parámetro, el endpoint responde **200 con cuerpo VACÍO (0 bytes)** — no un 404
 * ni un error, así que el fallo sería silencioso: un `success:true` con 0 promos.
 * El documento vive en la cuenta `jumboargentina` y las otras cadenas lo leen
 * desde ahí.
 *
 * ⚠️ **Un solo documento, tres cadenas.** Verificado el 2026-08-29 pidiéndolo a
 * los tres hosts (`www.disco.com.ar`, `www.vea.com.ar`, `www.jumbo.com.ar`) y
 * comparando el sha1 del cuerpo crudo: idéntico en los tres, byte a byte. No se
 * fija acá el sha1 concreto porque el documento es dato vivo y Cencosud lo
 * reescribe; lo que se afirma es la IGUALDAD entre hosts, no un contenido.
 * Cada promoción
 * declara a qué sitios aplica en `websites[]` (con el account repetido una vez
 * por sucursal), así que la cadena se resuelve **filtrando**, no cambiando de
 * endpoint. Distribución medida sobre las 193: discoargentina 146,
 * jumboargentina 138, jumboargentinaio 149, veaargentina 144.
 *
 * ⚠️ **Jumbo tiene DOS identificadores de sitio**: `jumboargentina` y
 * `jumboargentinaio` (el segundo es la tienda online). Por eso el core acepta
 * una LISTA de websites: al 2026-08-29 dan 35 y 34 vigentes respectivamente y
 * la unión da 35, o sea que casi todas están declaradas en los dos — pero como
 * cada promo es UNA fila que enumera sus sitios, el solapamiento no duplica
 * nada por sí solo.
 *
 * ⚠️ **El dedupe por `external_id` hoy no colapsa nada: es una red, no una
 * necesidad medida.** Medido el 2026-08-29: el documento trae 193 filas y 191
 * fingerprints distintos, pero las 2 colisiones son pares CRUZADOS entre
 * cadenas (una fila Jumbo+Disco contra una fila Vea; una fila Jumbo contra una
 * fila Disco). Como el filtro por sitio corre ANTES del dedupe y el prefijo
 * namespacea por cadena, esos pares nunca se encuentran: disco 33→33,
 * jumbo 35→35, vea 25→25. No borrar el dedupe igual — protege contra filas
 * realmente repetidas que Cencosud podría cargar mañana.
 *
 * ⚠️ Esas 2 colisiones sí dicen algo incómodo del fingerprint: los pares
 * difieren únicamente en `info`, `legals` y `priority`, y el fingerprint no
 * mira ninguno de los dos primeros. O sea que dos promos de la MISMA cadena que
 * compartan banco, descuento, cuotas, fechas y días pero cuyo texto libre las
 * distinga (una para electro y otra para almacén, por ejemplo) colapsarían y
 * una se perdería en silencio. Hoy no pasa (0 colapsos por cadena); si alguna
 * vez pasa, la salida es sumar `info`/`legals` al fingerprint — con el costo de
 * que un retoque de texto del operador genere un external_id nuevo y una fila
 * duplicada en `promotion_for_processes`.
 *
 * Este archivo nació de extraer la lógica que vivía en `scrapers/promos/vea.js`,
 * cuando se agregaron Disco y se migró Jumbo a esta misma fuente. Los scrapers
 * por cadena son wrappers finos sobre `getCencosudBankPromotions()`.
 *
 * Las funciones de normalización son PURAS (sin red): son la parte testeable.
 */

/** El documento vive en esta cuenta; `an` no es negociable (ver cabecera). */
const MASTER_DATA_ACCOUNT = 'jumboargentina';

const MASTER_DATA_PATH =
  `/api/dataentities/JN/documents/bankDiscount?_fields=value,id&an=${MASTER_DATA_ACCOUNT}`;

/**
 * Host por defecto. Cualquiera de los tres sirve (mismo sha1); se usa el de
 * Disco porque es el que se verificó byte a byte al escribir este core.
 */
export const DEFAULT_CENCOSUD_HOST = 'https://www.disco.com.ar';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 1=lunes … 7=domingo (ver caveat de `mapDays` sobre la confiabilidad). */
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
 * `label` sólo entra en el log, para saber qué cadena reintentó.
 */
async function getWithRetry(url, config, label, retries = 1) {
  try {
    return await axios.get(url, config);
  } catch (error) {
    const isNetwork = !error.response;
    if (isNetwork && retries > 0) {
      console.warn(
        `⚠️ Error de red consultando promos ${label}, reintentando... (${error.code || error.message})`
      );
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, label, retries - 1);
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
 * ⚠️ **En `dateStart` el mismo offset corría la fecha para atrás; por eso el
 * inicio NO usa esta función sino `toStartDate` (ver abajo).** 152 de las 193 filas graban el inicio a
 * las 03:00 UTC (= 00:00 ART, mismo día: el offset es inocuo), pero 26 lo graban
 * ANTES de las 03:00 — típicamente 02:59 o 02:30 UTC, o sea las 23:59/23:30 ART
 * del día anterior. Cencosud usa esa medianoche como frontera ENTRE dos días y
 * la interpreta distinto según el extremo: en `dateEnd` nombra el día que
 * cierra, en `dateStart` el que abre (el siguiente). Contrastado contra el rango
 * que el propio `info` escribe en texto: `dateEnd` acierta 44/67 leído en ART
 * contra 1/67 leído en UTC, pero `dateStart` acierta 23/61 en ART contra 29/61
 * en UTC.
 *
 * Impacto medido sobre lo que se publica: 2 promos vigentes de Disco, 3 de
 * Jumbo y 3 de Vea salen con `start_date` un día antes, y una de cada cadena
 * cruza el borde de mes (ej. inicio 02:59 UTC del 01/02 ⇒ "2025-01-31"), que es
 * el caso que ensancha de más el filtro de overlap mensual de
 * `AbstractScrapperPullProvider`. No se corrige acá porque elegir la lectura
 * autoritativa de `dateStart` — leerlo en UTC, o redondear al día siguiente
 * cuando cae en la ventana 23:00–23:59 ART — es una decisión de diseño, y
 * cambiarla mueve también las fechas ya publicadas de Vea.
 */
export function toDate(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date((n - ARGENTINA_UTC_OFFSET_SECONDS) * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Hora del día (0-23) del timestamp, ya en hora argentina.
 */
function argentineHour(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date((n - ARGENTINA_UTC_OFFSET_SECONDS) * 1000);
  return Number.isNaN(d.getTime()) ? null : d.getUTCHours();
}

/**
 * Fecha de FIN de vigencia. Es `toDate` tal cual: las 23:59 ART son el
 * centinela de "último día", y ese día es justamente el que hay que nombrar.
 */
export function toEndDate(unixSeconds) {
  return toDate(unixSeconds);
}

/**
 * Fecha de INICIO de vigencia.
 *
 * Misma frontera de medianoche que `toEndDate`, leída al revés: cuando el
 * timestamp cae en la última hora del día (23:00-23:59 ART) Cencosud está
 * nombrando el día que ABRE, no el que cierra, así que la fecha correcta es la
 * del día siguiente. Sin este ajuste, 26 de las 193 filas arrancaban un día
 * antes de lo real, y las que caen en cambio de mes ensanchaban el filtro de
 * overlap mensual de `AbstractScrapperPullProvider` hacia el mes anterior.
 *
 * Las 152 filas que graban el inicio a las 03:00 UTC (= 00:00 ART) no se ven
 * afectadas: ahí la hora es 0 y `toDate` ya devuelve el día correcto.
 */
export function toStartDate(unixSeconds) {
  const day = toDate(unixSeconds);
  if (day === null) return null;

  const hour = argentineHour(unixSeconds);
  if (hour === null || hour < 23) return day;

  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/**
 * Mapea el array `days` a nombres de día en español.
 * Descarta valores fuera de 1..7 en vez de adivinar.
 *
 * ⚠️ El campo no es totalmente confiable: lo carga un operador en el backoffice
 * de Cencosud y hay al menos un caso cuyo `info` dice "Viernes, Sábado y Domingo"
 * mientras `days` trae sólo ["5","6"]; el valor domingo no aparece nunca en el
 * dataset. Por eso la promoción emite `dias` (derivado) y TAMBIÉN `info`/`legales`
 * crudos: la fuente de verdad ante la ambigüedad es el texto libre, que es lo que
 * normaliza la IA — mismo criterio que `diasVigencia` en el scraper de Coto.
 */
export function mapDays(days) {
  if (!Array.isArray(days)) return [];
  const names = days.map((d) => DAY_NAMES[Number(d)]).filter(Boolean);
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
 * ¿Aplica esta promoción a alguno de los sitios pedidos?
 *
 * `websites` trae el account repetido una vez por sucursal; basta con que
 * aparezca al menos una vez. La comparación es exacta (lowercase + trim) a
 * propósito: en el dataset conviven `discoargentina` (146 promos) y un `disco`
 * a secas (3 promos), que NO son el mismo sitio. Un `includes()` los mezclaría.
 */
export function appliesToWebsites(raw, websites) {
  const wanted = new Set(
    (Array.isArray(websites) ? websites : [websites])
      .map((w) => String(w).trim().toLowerCase())
      .filter(Boolean)
  );
  if (wanted.size === 0) return false;

  const declared = Array.isArray(raw?.websites) ? raw.websites : [];
  return declared.some((w) => wanted.has(String(w).trim().toLowerCase()));
}

/**
 * Deriva un identificador estable para la promoción.
 *
 * El dataset NO trae un id por promoción (el `id` del endpoint es el del
 * documento contenedor, igual para las 193). Sin un external_id estable, el
 * `firstOrCreate` de `PromotionForProcess` duplicaría todo en cada corrida —y
 * con ello el gasto en tokens de IA—, así que se hashean los campos que
 * identifican la promo y que no cambian entre ejecuciones. Se excluyen
 * `priority` y `stores` a propósito: varían con la operación diaria sin que la
 * promoción sea otra.
 *
 * El `prefix` separa el namespace por cadena: la MISMA promo compartida entre
 * Disco y Vea debe entrar como dos filas distintas, porque cada PULL provider
 * la asocia a su propio merchant.
 */
export function buildExternalId(raw, prefix) {
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
  return `${prefix}-${hash}`;
}

/**
 * Formatea el número de `discount` como lo muestra la tarjeta: "3.00" → "3",
 * "12.50" → "12.5".
 */
export function formatAmount(discount) {
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
 * Convierte un registro crudo al contrato de promoción que consumen los
 * `App\Services\PromotionsProviders\{Disco,Jumbo,Vea}Service`.
 *
 * Función pura: es la parte unit-testeable, sin red.
 *
 * @param {Object} raw     registro crudo del Master Data
 * @param {Object} options { source, externalIdPrefix }
 */
export function normalizePromotion(raw, { source, externalIdPrefix }) {
  const { porcentaje, cuotas } = splitDiscount(raw);

  return {
    external_id: buildExternalId(raw, externalIdPrefix),
    title: buildTitle(raw),
    source,
    bancos: mapBanks(raw?.banks),
    // Etiqueta tal como la muestra Cencosud (número + sufijo concatenados).
    // Es el campo más fiel; `descuento_porcentaje`/`cuotas` son la lectura
    // desambiguada y quedan en null cuando el sufijo es mixto o ambiguo.
    etiqueta: buildDiscountLabel(raw),
    descuento_porcentaje: porcentaje,
    cuotas: cuotas,
    cuotas_texto: clean(raw?.installmentsText),
    medios_de_pago:
      raw?.paymentMethod && typeof raw.paymentMethod === 'object'
        ? Object.keys(raw.paymentMethod)
        : [],
    dias: mapDays(raw?.days),
    // Texto libre: es la fuente de verdad ante la ambigüedad de `days`
    // (ver caveat de `mapDays`). Se pasa sin interpretar, con tope de largo.
    info: clean(raw?.info, 4000),
    legales: clean(raw?.legals, 4000),
    cft: clean(raw?.cft),
    exclusiva: raw?.isExclusive === true,
    solo_checkout: raw?.checkout === true,
    sucursales: Array.isArray(raw?.stores) ? raw.stores.length : 0,
    start_date: toStartDate(raw?.dateStart),
    end_date: toEndDate(raw?.dateEnd),
  };
}

/**
 * Filtra y normaliza el lote crudo para una cadena.
 *
 * @param {Array}  records  promociones crudas del Master Data
 * @param {Object} options  { websites, source, externalIdPrefix, now }
 *
 * `now` se inyecta para que el filtro de vencidas sea determinista en tests.
 *
 * Función pura: unit-testeable con un fixture.
 */
export function normalizePromotions(
  records,
  { websites, source, externalIdPrefix, now = new Date() }
) {
  if (!Array.isArray(records)) return [];

  const cutoff = Math.floor(now.getTime() / 1000);

  const promotions = records
    .filter((raw) => appliesToWebsites(raw, websites))
    // Se descartan las ya vencidas: el dataset arrastra promos de 2022/2023.
    // El recorte fino por mes lo hace igual `AbstractScrapperPullProvider`.
    .filter((raw) => {
      const end = Number(raw?.dateEnd);
      return !Number.isFinite(end) || end <= 0 || end >= cutoff;
    })
    .map((raw) => normalizePromotion(raw, { source, externalIdPrefix }));

  // Dedupe por external_id: red de seguridad, no un problema vivo. Medido el
  // 2026-08-29 no colapsa NADA en ninguna cadena (disco 33→33, jumbo 35→35,
  // vea 25→25). Ojo con las dos intuiciones fáciles, las dos falsas:
  //   - una promo que declara `jumboargentina` Y `jumboargentinaio` NO se
  //     duplica acá: es UNA sola fila que enumera sus dos sitios;
  //   - las 2 colisiones de fingerprint del documento (193 filas, 191
  //     fingerprints) son pares CRUZADOS entre cadenas, que el filtro por sitio
  //     ya separa antes de llegar hasta acá.
  // Ver la cabecera del archivo por qué esas colisiones igual importan.
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
 * Trae el documento `bankDiscount` y devuelve los registros crudos ya
 * desenvueltos. Es la única función del core que hace red.
 *
 * @param {Object} options { host, label }  label sólo se usa para loguear.
 */
export async function fetchCencosudBankDiscounts({
  host = DEFAULT_CENCOSUD_HOST,
  label = 'Cencosud',
} = {}) {
  const response = await getWithRetry(
    `${host}${MASTER_DATA_PATH}`,
    {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      timeout: 20000,
    },
    label
  );

  return unwrapDocument(response.data);
}

/**
 * 🎯 Corrida completa para una cadena: red + filtro + normalización.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 *
 * @param {Object} options
 *   - websites          string | string[] con los ids de sitio en `websites[]`
 *   - source            slug del provider ('disco' | 'jumbo' | 'vea')
 *   - externalIdPrefix  prefijo del external_id (default: `source`)
 *   - host              host de Cencosud desde el que leer el documento
 *   - label             nombre para los logs
 */
export async function getCencosudBankPromotions({
  websites,
  source,
  externalIdPrefix = source,
  host = DEFAULT_CENCOSUD_HOST,
  label = source,
}) {
  const sites = Array.isArray(websites) ? websites : [websites];

  console.log(`🏷️ Iniciando scraper de promociones de ${label}...`);

  try {
    const records = await fetchCencosudBankDiscounts({ host, label });
    console.log(`📊 ${records.length} promociones bancarias en el Master Data de Cencosud`);

    const promotions = normalizePromotions(records, {
      websites: sites,
      source,
      externalIdPrefix,
    });

    console.log(`🎉 Promociones de ${label} vigentes: ${promotions.length}`);

    if (records.length > 0 && promotions.length === 0) {
      // El documento respondió pero nada quedó: o cambió el nombre del sitio en
      // `websites`, o el dataset quedó desactualizado. Avisar explícitamente —
      // un 0 silencioso es indistinguible de "no hay promos".
      console.warn(
        `⚠️ El Master Data devolvió ${records.length} registros pero ninguno vigente para "${sites.join(', ')}".`
      );
    }

    return {
      success: true,
      source,
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error(`❌ Error en scraper de promociones ${label}:`, error.message);

    return {
      success: false,
      source,
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
