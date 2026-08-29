import axios from 'axios';

/**
 * 🏷️ Scraper de PROMOCIONES de Josimar
 *
 * Josimar es una cadena VTEX (account `arjosimarprod`). A diferencia de Dia y
 * Vea, acá NO hay ni promociones bancarias ni teasers; hubo que reconstruir las
 * promos desde las COLECCIONES (product clusters) del catálogo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GAPS VERIFICADOS (no re-descubrir: ya se probaron y no sirven)
 * ─────────────────────────────────────────────────────────────────────────────
 * • **No hay promociones bancarias.** El Master Data que usa `promos/vea.js`
 *   (`/api/dataentities/JN/documents/bankDiscount`) responde **403** con
 *   `an=arjosimarprod`; con `an=jumboargentina` sí responde, pero devuelve el
 *   dataset de Cencosud, que no incluye a Josimar. O sea: no existe una fuente
 *   de descuentos por banco para esta cadena. La única promo con medio de pago
 *   que aparece viene embebida en el título de una colección (la 244,
 *   "15off visa master amex", 3092 productos).
 * • **`commertialOffer.Teasers` está SIEMPRE vacío**: 0 de 5691 productos.
 *   Idem `PromotionTeasers` y `DiscountHighLight`. El enfoque primario de
 *   `promos/dia.js` (derivar la promo del motor de promociones de VTEX) NO
 *   sirve acá: no hay nada que leer.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAS DOS FUENTES QUE SÍ HAY
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **`GET /files/flagsConfig-master.json`** — diccionario de 173 "flags"
 *    (clusterId → etiqueta + imagen de cucarda) que el tema usa para pintar los
 *    badges. Incluye colecciones que hoy no están aplicadas a ningún producto.
 *    Se usa como **semilla de descubrimiento** y como **último fallback de
 *    etiqueta**, nunca como fuente de verdad (está desactualizado, ver GOTCHA 1).
 * 2. **El catálogo público de VTEX**, colección por colección:
 *    `GET /api/catalog_system/pub/products/search?fq=productClusterIds:{id}&_from=0&_to=4`
 *    Cada producto trae `clusterHighlights` y `productClusters` (mapas
 *    `{id: etiqueta}`) con la etiqueta **viva**.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ GOTCHA 1 — flagsConfig está DESACTUALIZADO: la etiqueta viva manda
 * ─────────────────────────────────────────────────────────────────────────────
 * El JSON de flags lo edita un operador y quedan entradas viejas. Casos reales
 * medidos el 2026-08-29, flag vs. etiqueta viva del MISMO clusterId:
 *
 *   255  flag "BONAFIDE / SENSACIONES CAFE 15% OFF 06-08 a 16-08"
 *        vivo "COCA COLA 2.250L 15% OFF 15-08 a 05-09"        ← otro producto Y otras fechas
 *   551  flag "35% DE DESCUENTO EN PRODUCTOS DE CCU"
 *        vivo "35% DE DESCUENTO EN UNILEVER"                   ← otra marca
 *   557  flag "AGUAS/CERVEZAS/GASEOSAS 33% OFF 14-07 a 10-08"
 *        vivo "AGUAS/CERVEZAS/GASEOSAS 33% OFF 14-07 a 08-09"  ← la VIGENCIA difiere
 *
 * Tomar la etiqueta del flag habría publicado esas promos como vencidas el 10-08
 * cuando en realidad corren hasta el 08-09. Por eso el orden de resolución es
 * `clusterHighlights` → `productClusters` → flag, y el flag es sólo el último
 * recurso. Además el archivo tiene **7 flagIds duplicados con títulos distintos**
 * (232, 270, 322, 332, 440, 544, 551) y **1 entrada sin `flagId`**: se toma la
 * primera aparición de cada id y se descarta la que no tiene id. Es un fallback
 * best-effort; no vale la pena adivinar cuál de las dos entradas es la buena.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ GOTCHA 2 — hay que mirar `productClusters`, no sólo `clusterHighlights`
 * ─────────────────────────────────────────────────────────────────────────────
 * `productClusters` es un SUPERCONJUNTO de `clusterHighlights` (este último es
 * sólo el subconjunto que además pinta cucarda). Descubrir usando nada más los
 * highlights deja afuera colecciones grandes y reales. Medido: con highlights
 * solos se llega a 47 colecciones; sumando `productClusters` se llega a 48, y
 * **la que aparece es la colección 244 "15off visa master amex", con 3092
 * productos** — la promo más grande del sitio y la única con medio de pago.
 * Es también el único lugar donde vive la etiqueta viva de la colección 565.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ GOTCHA 3 — la semilla de flags NO alcanza: hace falta cierre transitivo
 * ─────────────────────────────────────────────────────────────────────────────
 * De las 48 colecciones con productos, **10 no están en flagsConfig**, y entre
 * ellas están las 5 más grandes (244: 3092 productos, 521: 1017, 483: 652,
 * 388: 609, 517: 492). Por eso no se recorre la lista de flags y punto: se hace
 * un **cierre transitivo** — cada producto muestreado delata las otras
 * colecciones a las que pertenece, y esos ids nuevos entran a la frontera. Con
 * 165 ids semilla el cierre termina en ~175 requests / ~50 s.
 *
 * Es best-effort por construcción (se muestrean 5 productos por colección, no
 * los 5691 del catálogo): una colección aislada, sin ningún producto en común
 * con las semillas, no se descubriría. Recorrer el catálogo entero para tapar
 * ese hueco costaría ~114 páginas extra y no se justifica.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ GOTCHA 4 — el header `resources` evita paginar
 * ─────────────────────────────────────────────────────────────────────────────
 * VTEX responde 206 con `resources: 0-4/609`. El total exacto de productos de la
 * colección sale de ahí, así que **una sola request por colección** alcanza para
 * el `product_count` real Y para los 5 `sample_products`. Una colección vacía
 * responde 200 con `resources: 0-0/0` y `[]` — no es un error.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DECISIÓN DE DISEÑO — se PARSEA la vigencia del título (ver `parseValidity`)
 * ─────────────────────────────────────────────────────────────────────────────
 * Las promos de Dia caen TODAS en `needs_review` con motivo `dates_defaulted`
 * porque su catálogo no expone vigencia. Acá muchos títulos la traen embebida
 * ("CERVEZAS 20% OFF 14-07 a 08-09"), así que se parsea y esas promos pueden
 * publicarse solas. Las que no la declaran emiten `start_date`/`end_date` en
 * **null** — nunca se inventa una fecha.
 *
 * NO lanza excepciones al caller: ante error devuelve { success:false, ... }.
 */

const BASE_URL = 'https://www.josimar.com.ar';
const SEARCH_ENDPOINT = `${BASE_URL}/api/catalog_system/pub/products/search`;
const FLAGS_ENDPOINT = `${BASE_URL}/files/flagsConfig-master.json`;

/** 5 productos por colección: alcanzan para el sample y para el cierre transitivo. */
const MAX_SAMPLE_PRODUCTS = 5;

/**
 * Cap defensivo del cierre transitivo. Con 165 semillas cierra en ~175
 * colecciones; 600 deja margen de sobra sin poder degenerar en un crawl infinito
 * si Josimar rearma el árbol de colecciones.
 */
const MAX_CLUSTERS = 600;

/** Pausa entre requests: el catálogo es público y no tiene rate limit conocido. */
const REQUEST_DELAY_MS = 100;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const REQUEST_CONFIG = {
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  timeout: 20000,
  // VTEX devuelve 206 (Partial Content) en los paginados.
  validateStatus: (status) => status >= 200 && status < 300,
};

/* ═════════════════════════════ helpers genéricos ═════════════════════════════ */

/**
 * Genera un slug simple (sin acentos, kebab-case).
 * Los títulos de Josimar vienen con emojis; `[^a-z0-9]+` los colapsa.
 */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Colapsa espacios y saltos, recorta. null si queda vacío.
 * Importa porque hay títulos reales con doble espacio interno
 * ("FEMSA 20% DE DESCUENTO  06-08 a 05-09").
 */
function clean(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text || null;
}

/**
 * GET con 1 reintento ante error de red / timeout.
 */
async function getWithRetry(url, config, retries = 1) {
  try {
    return await axios.get(url, config);
  } catch (error) {
    const isNetwork = !error.response;
    if (isNetwork && retries > 0) {
      console.warn(
        `⚠️ Error de red consultando promos Josimar, reintentando... (${error.code || error.message})`
      );
      await new Promise((r) => setTimeout(r, 1000));
      return getWithRetry(url, config, retries - 1);
    }
    throw error;
  }
}

/* ═══════════════════════════ flagsConfig-master.json ══════════════════════════ */

/**
 * Extrae el diccionario `clusterId → etiqueta` del JSON de flags.
 *
 * Forma real: `{ master: { flags: [{ __editorItemTitle, flagId, imageUrl, ... }] } }`.
 * Se descarta la entrada sin `flagId` (hay 1) y, ante ids duplicados (hay 7),
 * gana la PRIMERA aparición — ver GOTCHA 1: es un fallback best-effort.
 *
 * Función pura: unit-testeable con el fixture.
 */
export function parseFlags(payload) {
  const flags = payload?.master?.flags;
  if (!Array.isArray(flags)) return new Map();

  const byId = new Map();

  for (const flag of flags) {
    const id = flag?.flagId;
    if (id === null || id === undefined || String(id).trim() === '') continue;

    const key = String(id).trim();
    if (byId.has(key)) continue; // primera aparición gana

    byId.set(key, clean(flag.__editorItemTitle));
  }

  return byId;
}

/* ═════════════════════════ decodificación de etiquetas ════════════════════════ */

/**
 * Algunas etiquetas vienen con un formato interno codificado que el tema usa
 * para elegir la imagen de la cucarda. Casos reales:
 *
 *   "porcentaje--100--2--1---POWERADE COOL CITRUS 2X1:2X1.png"
 *   "porcentaje--100--6--1---OFERTAZOS FEMSA 6X5:6x5.png"
 *   "precio--166667--6--todos---FEMSA LLEVANDO 6 ABONAS 4:llevando6.png"
 *
 * Estructura: `<tipo>--<valor>--<cantidad>--<alcance>---<TÍTULO LEGIBLE>:<imagen>`.
 * Lo que importa para el contrato es el TÍTULO: lo que va después del ÚLTIMO
 * "---" y antes del ":". El sufijo tras ":" es el archivo de imagen.
 *
 * Los 4 campos numéricos del prefijo NO se emiten como campos propios: su
 * significado (¿`100` es "100% off en la 2da unidad"? ¿`166667` es $1666,67?)
 * es una inferencia, no un dato declarado por la fuente. Se preservan enteros en
 * `raw_label` para que los lea el normalizador de IA — mismo criterio que
 * `info`/`legales` en `promos/vea.js`.
 *
 * Medido sobre el archivo real: 54 de 173 etiquetas usan este formato, los
 * únicos dos prefijos son `porcentaje` y `precio`, y todas traen exactamente un
 * "---" y un ":". Aun así el patrón exige el prefijo conocido: **si no matchea,
 * se devuelve la etiqueta cruda** en vez de recortar a ciegas un título legítimo
 * que casualmente tuviera un guión.
 *
 * Función pura: unit-testeable.
 */
export function decodeFlagLabel(rawLabel) {
  const label = clean(rawLabel);
  if (!label) return { title: null, image: null, encoded: false };

  const match = label.match(/^(?:porcentaje|precio)--.*?---(.+)$/i);
  if (!match) return { title: label, image: null, encoded: false };

  const tail = match[1];
  const colon = tail.lastIndexOf(':');

  if (colon === -1) {
    // No observado en el archivo real, pero no hay motivo para perder el título.
    return { title: clean(tail), image: null, encoded: true };
  }

  return {
    title: clean(tail.slice(0, colon)),
    // Hay al menos una entrada con la imagen truncada ("...:llevando2."):
    // se emite tal cual; un valor vacío queda en null.
    image: clean(tail.slice(colon + 1)),
    encoded: true,
  };
}

/* ═══════════════════════════════ ruido interno ════════════════════════════════ */

/**
 * ¿Es una colección de uso interno del operador y no una promoción?
 *
 * Criterio **deliberadamente angosto**: sólo se descarta la etiqueta que se
 * autodenomina interna (la palabra "INTERNA"/"INTERNAS" suelta). Casos reales:
 * el flag "INTERNA 345" y su etiqueta viva "OFERTAS INTERNA" (misma colección
 * 345, 289 productos).
 *
 * NO se filtra por nombre de rubro ("Frescos, Yogures y Lacteos",
 * "Selección de Lácteos y Frescos"): son colecciones de catalogación mezcladas
 * con ofertas reales, y decidir cuál es cuál por el nombre es exactamente la
 * heurística frágil que este scraper vino a evitar. Se emiten con su
 * `promotion_kind` y el gate de `needs_review` del normalizador decide — mismo
 * criterio ya documentado para los `clusterHighlights` de Dia.
 *
 * Función pura: unit-testeable.
 */
export function isInternalNoise(label) {
  const text = clean(label);
  if (!text) return true; // sin etiqueta no hay nada que normalizar
  return /\bINTERNAS?\b/i.test(text);
}

/* ═════════════════════════════ parseo de vigencia ═════════════════════════════ */

/**
 * Rango de fechas embebido en el título: "DD-MM a DD-MM".
 *
 * Se acepta `-` o `/` como separador y `a`/`al` como conector, porque las dos
 * variantes existen en la fuente:
 *   "CERVEZAS 20% OFF 14-07 a 08-09"
 *   "GILLETTE 30% OFF 07-08 A 16-08"
 *   "ALWAYS 30%OFF 22/05 AL 28/05"
 *   "40% DE DESCUENTO JOSIMAR SALE DEL 11/05 AL 17/05"
 *
 * El `\b` alrededor del conector evita comerse la "a" de una palabra pegada.
 */
const VALIDITY_RE = /\b(\d{1,2})\s*[-/]\s*(\d{1,2})\s*\b(?:a|al)\b\s*(\d{1,2})\s*[-/]\s*(\d{1,2})\b/i;

/** Formatea (año, mes 1-12, día) a 'YYYY-MM-DD'. */
function formatDate(year, month, day) {
  return (
    `${String(year).padStart(4, '0')}-` +
    `${String(month).padStart(2, '0')}-` +
    `${String(day).padStart(2, '0')}`
  );
}

/**
 * Construye un Date UTC validando que la fecha EXISTA.
 * `Date.UTC(2026, 1, 31)` no falla: rueda al 3 de marzo. Se comprueba el
 * roundtrip para rechazar un "31-02" en vez de emitir una fecha corrida.
 */
function utcDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/**
 * Parsea la vigencia embebida en el título de la colección.
 *
 * @param {string} title          título legible (ya decodificado)
 * @param {Date}   referenceDate  "hoy" — INYECTABLE para que el test sea determinista
 * @returns {{start_date: string|null, end_date: string|null}} en formato YYYY-MM-DD
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ EL AÑO NO VIENE EN EL TÍTULO. Regla elegida (y por qué):
 * ─────────────────────────────────────────────────────────────────────────────
 * Se prueban TRES ubicaciones del rango — año de inicio = año de referencia − 1,
 * = año de referencia, y = año de referencia + 1 — y se elige **la que queda más
 * cerca de la fecha de referencia**: distancia 0 si `referenceDate` cae dentro
 * del rango, si no la distancia al extremo más próximo. Empate: gana la
 * ubicación más temprana, porque una promo ya empezada es más probable que una
 * idéntica todavía por empezar.
 *
 * Por qué así y no "asumir el año en curso": eso rompe justo en el caso que
 * importa, el rango que **cruza diciembre-enero**. Con referencia 2026-01-05 y
 * título "20-12 a 10-01", el año en curso daría 2026-12-20 → 2027-01-10, una
 * promo a once meses vista; la regla de cercanía elige 2025-12-20 → 2026-01-10,
 * que es el rango que efectivamente contiene al 5 de enero.
 *
 * El cruce de año se detecta comparando mes/día: si el fin es anterior al
 * inicio, el fin cae en el año siguiente al del inicio.
 *
 * ⚠️ LÍMITE CONOCIDO — la regla NO distingue una etiqueta rancia de exactamente
 * un año. Un título viejo que sobreviva en flagsConfig cuyo rango *contenga* al
 * día de hoy en el calendario ("PROMO 01-08 a 31-08" leído el 29-08) da
 * distancia 0 en el año en curso y sale como VIGENTE, aunque fuera de 2025. Sólo
 * las etiquetas cuyo rango no contiene al día de hoy (ej. "11-05 a 17-05" leído
 * en agosto) salen correctamente como vencidas y el filtro de solapamiento
 * mensual de `AbstractScrapperPullProvider` las descarta solo.
 *
 * No es resoluble desde el título: el año simplemente no está en el dato, y
 * cualquier desempate sería adivinar. Se acota por otro lado — las promos que
 * salen SÓLO de flagsConfig (`promotion_kind: 'flag'`, la fuente donde vive el
 * texto rancio) no tienen productos asociados y son las candidatas naturales a
 * revisión; en la corrida real fueron 0. Si esto se vuelve un problema, la
 * salida no es tocar el parser sino dejar de confiar en flagsConfig como fuente
 * de vigencia.
 *
 * Si el título NO trae vigencia devuelve null en AMBAS fechas. Nunca inventa.
 */
export function parseValidity(title, referenceDate = new Date()) {
  const empty = { start_date: null, end_date: null };

  const text = clean(title);
  if (!text) return empty;

  const match = text.match(VALIDITY_RE);
  if (!match) return empty;

  const startDay = Number(match[1]);
  const startMonth = Number(match[2]);
  const endDay = Number(match[3]);
  const endMonth = Number(match[4]);

  const reference = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (Number.isNaN(reference.getTime())) return empty;

  const baseYear = reference.getUTCFullYear();
  const now = reference.getTime();

  let best = null;

  for (const offset of [-1, 0, 1]) {
    const startYear = baseYear + offset;

    // El fin anterior al inicio (por mes, o por día dentro del mismo mes) sólo
    // puede significar que el rango cruza el año nuevo.
    const crossesNewYear =
      endMonth < startMonth || (endMonth === startMonth && endDay < startDay);
    const endYear = startYear + (crossesNewYear ? 1 : 0);

    const start = utcDate(startYear, startMonth, startDay);
    const end = utcDate(endYear, endMonth, endDay);
    if (!start || !end) continue; // fecha inexistente (ej. "31-02") ⇒ se descarta

    const distance =
      now < start.getTime()
        ? start.getTime() - now
        : now > end.getTime()
          ? now - end.getTime()
          : 0;

    // Los offsets se recorren en orden ascendente, así que un `<` estricto ya
    // hace que el empate lo gane la ubicación más temprana.
    if (best === null || distance < best.distance) {
      best = { distance, startYear, endYear };
    }
  }

  if (!best) return empty;

  return {
    start_date: formatDate(best.startYear, startMonth, startDay),
    end_date: formatDate(best.endYear, endMonth, endDay),
  };
}

/* ══════════════════════════════ productos VTEX ════════════════════════════════ */

/**
 * Devuelve la oferta comercial del seller por defecto (o el primero).
 */
function commercialOffer(product) {
  const item = product?.items?.[0];
  const seller = item?.sellers?.find((s) => s?.sellerDefault) || item?.sellers?.[0];
  return seller?.commertialOffer ?? null;
}

/**
 * Construye el "sample product" de una promoción, con el EAN incluido — es la PK
 * del catálogo y permite cruzar la promo con los productos ya scrapeados.
 *
 * ⚠️ `price` sale de `Price` y el "tachado" de `PriceWithoutDiscount`.
 * NUNCA de `ListPrice`: en VTEX viene con un multiplicador erróneo (ver
 * "ListPrice bug" en el CLAUDE.md del scraper).
 *
 * Función pura: unit-testeable.
 */
export function toSampleProduct(product) {
  const item = product?.items?.[0];
  const offer = commercialOffer(product);

  return {
    ean: item?.ean ?? null,
    id: product?.productId ?? null,
    name: product?.productName ?? null,
    brand: product?.brand ?? null,
    price: typeof offer?.Price === 'number' ? offer.Price : null,
    list_price:
      typeof offer?.PriceWithoutDiscount === 'number' ? offer.PriceWithoutDiscount : null,
  };
}

/**
 * Todos los ids de colección a los que pertenece un producto. Se unen los DOS
 * mapas: `productClusters` es superconjunto de `clusterHighlights`, pero se leen
 * ambos por si algún producto trajera un highlight no replicado (GOTCHA 2).
 *
 * Función pura: unit-testeable.
 */
export function productClusterIds(product) {
  const ids = new Set();

  for (const map of [product?.clusterHighlights, product?.productClusters]) {
    if (!map || typeof map !== 'object') continue;
    for (const key of Object.keys(map)) {
      const id = String(key).trim();
      if (id) ids.add(id);
    }
  }

  return ids;
}

/**
 * Resuelve la etiqueta de una colección y de DÓNDE salió.
 *
 * Prioridad (ver GOTCHA 1 y 2):
 *   1. `clusterHighlights[id]` de algún producto muestreado → 'highlight'
 *      (la colección pinta cucarda: la señal más fuerte de que es una promo)
 *   2. `productClusters[id]` → 'cluster'
 *   3. la etiqueta de flagsConfig → 'flag' (último recurso, puede estar vieja)
 *
 * Función pura: unit-testeable.
 */
export function resolveClusterLabel(clusterId, products, flagLabels = new Map()) {
  const id = String(clusterId);
  const list = Array.isArray(products) ? products : [];

  for (const product of list) {
    const label = clean(product?.clusterHighlights?.[id]);
    if (label) return { label, kind: 'highlight' };
  }

  for (const product of list) {
    const label = clean(product?.productClusters?.[id]);
    if (label) return { label, kind: 'cluster' };
  }

  const fallback = clean(flagLabels?.get?.(id));
  if (fallback) return { label: fallback, kind: 'flag' };

  return { label: null, kind: null };
}

/**
 * Convierte una colección al contrato de promoción que consume el provider PULL
 * de Laravel (mismo contrato que `promos/dia.js`).
 *
 * Devuelve `null` si la colección es ruido interno o no tiene etiqueta: es
 * preferible no emitirla a mandar basura a la cola de normalización por IA.
 *
 * Función pura: unit-testeable.
 */
export function buildPromotion(
  { clusterId, label, kind, productCount, products },
  referenceDate = new Date()
) {
  if (isInternalNoise(label)) return null;

  const { title, image, encoded } = decodeFlagLabel(label);
  // El ruido puede estar en el título decodificado y no en el prefijo, así que
  // se vuelve a chequear después de decodificar.
  if (!title || isInternalNoise(title)) return null;

  const { start_date, end_date } = parseValidity(title, referenceDate);

  const id = String(clusterId);
  const sampleProducts = (Array.isArray(products) ? products : [])
    .slice(0, MAX_SAMPLE_PRODUCTS)
    .map(toSampleProduct);

  return {
    external_id: `josimar-c-${id}`,
    slug: slugify(`${title}-${id}`),
    title,
    source: 'josimar',
    // De qué fuente salió la etiqueta: 'highlight' (cucarda) | 'cluster' | 'flag'.
    promotion_kind: kind ?? 'cluster',
    cluster_id: id,
    // Etiqueta cruda, sin decodificar: conserva los 4 campos numéricos del
    // formato interno ("porcentaje--100--2--1---…"), que la IA puede leer y este
    // scraper no interpreta a propósito.
    raw_label: label,
    // Archivo de cucarda del formato codificado ("2X1.png", "llevando6.png").
    // null cuando la etiqueta no venía codificada.
    badge_image: encoded ? image : null,
    product_count: productCount,
    sample_products: sampleProducts,
    start_date,
    end_date,
  };
}

/* ═════════════════════════════════ red ════════════════════════════════════════ */

/**
 * Total real de productos de la colección, leído del header `resources: 0-4/609`
 * (GOTCHA 4: evita paginar sólo para contar). Cae al largo de la página si el
 * header no viene.
 *
 * Función pura: unit-testeable.
 */
export function parseResourcesTotal(resourcesHeader, fallbackLength = 0) {
  const total = Number(String(resourcesHeader ?? '').split('/')[1]);
  return Number.isFinite(total) && total >= 0 ? total : fallbackLength;
}

/**
 * Descarga los primeros productos de una colección.
 */
async function fetchCluster(clusterId) {
  const url =
    `${SEARCH_ENDPOINT}?fq=productClusterIds:${encodeURIComponent(clusterId)}` +
    `&_from=0&_to=${MAX_SAMPLE_PRODUCTS - 1}`;

  const response = await getWithRetry(url, REQUEST_CONFIG);
  const products = Array.isArray(response.data) ? response.data : [];

  return {
    products,
    total: parseResourcesTotal(response.headers?.resources, products.length),
  };
}

/**
 * Descarga el diccionario de flags (semillas del cierre transitivo).
 */
async function fetchFlags() {
  const response = await getWithRetry(FLAGS_ENDPOINT, REQUEST_CONFIG);
  return parseFlags(response.data);
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Promociones de Josimar
 */
export async function getJosimarPromotions() {
  console.log('🏷️ Iniciando scraper de promociones de Josimar...');

  try {
    const flagLabels = await fetchFlags();
    console.log(`📊 ${flagLabels.size} colecciones semilla en flagsConfig-master.json`);

    if (flagLabels.size === 0) {
      // Sin semillas no hay por dónde empezar el cierre transitivo. Se avisa
      // explícitamente: devolver 0 promos en silencio se lee como "no hay
      // ofertas" y es indistinguible de "se rompió".
      console.warn(
        '⚠️ flagsConfig-master.json no devolvió ninguna colección. ' +
          'Puede que Josimar haya cambiado la ruta o la forma del archivo.'
      );
    }

    const visited = new Set();
    const frontier = [...flagLabels.keys()];
    const collections = [];
    let requests = 0;

    while (frontier.length > 0 && visited.size < MAX_CLUSTERS) {
      const clusterId = frontier.shift();
      if (visited.has(clusterId)) continue;
      visited.add(clusterId);

      let page;
      try {
        page = await fetchCluster(clusterId);
        requests++;
      } catch (err) {
        // Una colección que falla no aborta el lote (mismo criterio que el
        // scraper de Santander con una marca caída).
        console.error(`❌ Error consultando la colección ${clusterId}: ${err.message}`);
        continue;
      }

      if (page.total === 0) continue; // colección sin productos aplicados hoy

      const { label, kind } = resolveClusterLabel(clusterId, page.products, flagLabels);

      collections.push({
        clusterId,
        label,
        kind,
        productCount: page.total,
        products: page.products,
      });

      // Cierre transitivo: cada producto delata las otras colecciones a las que
      // pertenece (GOTCHA 3 — así aparecen las 5 colecciones más grandes,
      // ninguna de las cuales está en flagsConfig).
      for (const product of page.products) {
        for (const id of productClusterIds(product)) {
          if (!visited.has(id)) frontier.push(id);
        }
      }

      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }

    if (visited.size >= MAX_CLUSTERS) {
      console.warn(
        `⚠️ Se alcanzó el cap de ${MAX_CLUSTERS} colecciones: el resultado puede estar truncado.`
      );
    }

    console.log(
      `📊 ${requests} requests · ${collections.length} colecciones con productos aplicados`
    );

    const now = new Date();
    const promotions = collections
      .map((collection) => buildPromotion(collection, now))
      .filter(Boolean);

    const conVigencia = promotions.filter((p) => p.start_date !== null).length;
    console.log(`🎉 Promociones de Josimar derivadas: ${promotions.length}`);
    console.log(
      `   ${conVigencia} con vigencia parseada del título, ` +
        `${promotions.length - conVigencia} sin vigencia declarada (start/end en null)`
    );

    return {
      success: true,
      source: 'josimar',
      total: promotions.length,
      promotions,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    console.error('❌ Error en scraper de promociones Josimar:', error.message);

    return {
      success: false,
      source: 'josimar',
      total: 0,
      promotions: [],
      error: error.message,
      timestamp: new Date().toISOString(),
    };
  }
}
