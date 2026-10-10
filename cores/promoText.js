import { createHash } from 'crypto';

/**
 * 🧰 Núcleo compartido de texto y fechas para los scrapers de PROMOCIONES
 *
 * Nació con la etapa 2 de fuentes de promos (Carrefour, Masonline, Farmacity,
 * Naranja X, Cuenta DNI), que repetían las mismas tres necesidades:
 *   - limpiar texto libre y HTML de legales;
 *   - convertir fechas al contrato `YYYY-MM-DD` (o null) sin adivinar;
 *   - leer la VIGENCIA escrita en castellano dentro de un legal ("todos los
 *     miércoles de octubre del 2026", "entre el 13 de agosto y el 11 de diciembre
 *     de 2026", "Vigencia 08.10 al 10.10").
 *
 * Contrato de fechas (ver "Contrato de fechas" en `CLAUDE.md`): lo que no matchea
 * un formato conocido sale `null`, nunca una fecha inventada. Todas las funciones
 * son puras.
 */

/** Colapsa espacios y saltos, recorta. null si queda vacío. */
export function clean(value, maxLength = null) {
  if (value === null || value === undefined) return null;
  let text = String(value).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (maxLength && text.length > maxLength) text = text.slice(0, maxLength);
  return text;
}

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * Texto plano de un fragmento HTML de legales.
 *
 * Farmacity guarda los legales en una planilla exportada a CSV, así que las
 * comillas de los atributos llegan dobladas (`style=""font-size: 30px""`): se
 * sacan las etiquetas enteras sin intentar parsear atributos.
 */
export function stripHtml(html, maxLength = null) {
  if (html === null || html === undefined) return null;
  const text = String(html)
    .replace(/<br\s*\/?>|<\/br>|<\/p>|<\/li>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, (entity) => ENTITIES[entity.toLowerCase()] ?? ' ');
  return clean(text, maxLength);
}

/** sha1 recortado a 12 caracteres: el sufijo de los external_id derivados. */
export function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

const pad = (n) => String(n).padStart(2, '0');

/** Fecha real (con round-trip) o null. Meses 1-12. */
function isoFromParts(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Último día del mes (1-12) de un año. */
function lastDayOfMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "dd/mm/yyyy" (o "d/m/yyyy") → "yyyy-mm-dd"; null si no es una fecha real. */
export function ddmmyyyyToIso(value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return isoFromParts(m[3], m[2], m[1]);
}

/**
 * Fecha de un timestamp ISO leída en **UTC**.
 *
 * El Master Data de Valtech (Carrefour, Masonline) graba medianoche UTC
 * (`2026-10-01T00:00:00+00:00`). Leído en hora argentina sería el 30/09 a las
 * 21:00 y correría el inicio un día para atrás: el caso opuesto al de Cencosud,
 * que graba en hora local.
 */
export function utcDateOnly(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Fin de vigencia de Valtech, que es **exclusivo** cuando cae el 1° de un mes a
 * medianoche (Carrefour siempre: `active_to` 2026-11-01 con un legal "HASTA EL
 * 31/10/2026"). Cualquier otra fecha se toma tal cual: Masonline también carga
 * fines inclusivos (`2026-12-31` con un legal "HASTA EL 31/12/2026").
 */
export function exclusiveEndToInclusive(value) {
  const day = utcDateOnly(value);
  if (day === null) return null;
  const date = new Date(value);
  const atMidnight =
    date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  if (!atMidnight || date.getUTCDate() !== 1) return day;
  const previous = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
  return previous.toISOString().slice(0, 10);
}

const MONTHS = {
  ENERO: 1,
  FEBRERO: 2,
  MARZO: 3,
  ABRIL: 4,
  MAYO: 5,
  JUNIO: 6,
  JULIO: 7,
  AGOSTO: 8,
  SEPTIEMBRE: 9,
  SETIEMBRE: 9,
  OCTUBRE: 10,
  NOVIEMBRE: 11,
  DICIEMBRE: 12,
};

const MES = `(${Object.keys(MONTHS).join('|')})`;
/** Conector opcional entre el mes y el año: "de octubre del 2026", "diciembre, de 2026", "diciembre 2026". */
const YEAR = `,?\\s*(?:DE |DEL )?(\\d{4})`;

const EMPTY = Object.freeze({ start_date: null, end_date: null });

/** Mayúsculas, sin tildes y con espacios simples: los legales vienen en cualquier caja. */
function normalizeForDates(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/** Rango con el año del fin; el inicio cae un año antes si el rango cruza el año nuevo. */
function rangeEndingIn(year, startDay, startMonth, endDay, endMonth) {
  const crosses = startMonth > endMonth || (startMonth === endMonth && startDay > endDay);
  const start = isoFromParts(crosses ? year - 1 : year, startMonth, startDay);
  const end = isoFromParts(year, endMonth, endDay);
  return start && end ? { start_date: start, end_date: end } : EMPTY;
}

/**
 * Rango sin año ("08.10 al 10.10"): se elige el año que deja el rango más cerca de
 * la referencia (0 si la contiene), con -1/0/+1 años de candidatos. Mismo criterio
 * que `parseValidity` de Josimar; resuelve bien los rangos que cruzan diciembre.
 */
function nearestRange(startDay, startMonth, endDay, endMonth, reference) {
  const ref = reference.getTime();
  const crosses = endMonth < startMonth || (endMonth === startMonth && endDay < startDay);
  let best = null;
  for (const offset of [-1, 0, 1]) {
    const startYear = reference.getUTCFullYear() + offset;
    const start = isoFromParts(startYear, startMonth, startDay);
    const end = isoFromParts(startYear + (crosses ? 1 : 0), endMonth, endDay);
    if (!start || !end) continue;
    const from = Date.parse(`${start}T00:00:00Z`);
    const to = Date.parse(`${end}T23:59:59Z`);
    const distance = ref >= from && ref <= to ? 0 : Math.min(Math.abs(ref - from), Math.abs(ref - to));
    if (best === null || distance < best.distance) best = { distance, start, end };
  }
  return best ? { start_date: best.start, end_date: best.end } : EMPTY;
}

/**
 * Cada patrón devuelve `{ index, read }`: `read()` arma el rango. Se queda el que
 * aparece PRIMERO en el texto (la vigencia abre el legal; una fecha posterior suele
 * ser un ejemplo o un plazo de acreditación).
 */
const PATTERNS = [
  // "desde 01/10/2025 hasta el 30/09/2026", "del 01/07/2026 al 31/12/2026"
  {
    re: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})\D{1,40}?(\d{1,2})\/(\d{1,2})\/(\d{4})/,
    read: (m) => {
      const start = isoFromParts(m[3], m[2], m[1]);
      const end = isoFromParts(m[6], m[5], m[4]);
      return start && end ? { start_date: start, end_date: end } : EMPTY;
    },
  },
  // "entre el 13 de agosto y el 11 de diciembre de 2026", "desde el 1 de junio, hasta el 31 de octubre de 2026"
  {
    re: new RegExp(`\\b(\\d{1,2}) DE ${MES}\\b[^\\d]{0,40}?\\b(\\d{1,2}) DE ${MES}\\b${YEAR}`),
    read: (m) => rangeEndingIn(Number(m[5]), Number(m[1]), MONTHS[m[2]], Number(m[3]), MONTHS[m[4]]),
  },
  // "del 1 al 31 de octubre del 2026"
  {
    re: new RegExp(`\\b(\\d{1,2}) AL (\\d{1,2}) DE ${MES}\\b${YEAR}`),
    read: (m) => rangeEndingIn(Number(m[4]), Number(m[1]), MONTHS[m[3]], Number(m[2]), MONTHS[m[3]]),
  },
  // "los martes 1, 8, 15 y 29 de septiembre del 2026": del primero al último día listado
  {
    re: new RegExp(`\\b(\\d{1,2}(?:\\s*,\\s*\\d{1,2})*\\s*Y\\s*\\d{1,2}) DE ${MES}\\b${YEAR}`),
    read: (m) => {
      const days = m[1].match(/\d{1,2}/g).map(Number);
      const month = MONTHS[m[2]];
      return rangeEndingIn(Number(m[3]), Math.min(...days), month, Math.max(...days), month);
    },
  },
  // "de los meses de septiembre y octubre, del 2026": del 1° del primero al último día del último
  {
    re: new RegExp(`MESES DE ${MES}((?:\\s*(?:,|Y)\\s*${MES})+)${YEAR}`),
    read: (m) => {
      const months = [m[1], ...m[2].match(new RegExp(MES, 'g'))].map((name) => MONTHS[name]);
      const first = months[0];
      const last = months[months.length - 1];
      const year = Number(m[m.length - 1]);
      return rangeEndingIn(year, 1, first, lastDayOfMonth(year, last), last);
    },
  },
  // "todos los miércoles de octubre del 2026", "del mes de octubre de 2026": el mes entero
  {
    re: new RegExp(`(?<!\\d )(?:DEL MES DE|MES DE|DE) ${MES}\\b${YEAR}`),
    read: (m) => {
      const month = MONTHS[m[1]];
      const year = Number(m[2]);
      return rangeEndingIn(year, 1, month, lastDayOfMonth(year, month), month);
    },
  },
  // "Vigencia 08.10 al 10.10" (planilla de Farmacity), "#01/09 - 21/09" (teasers de
  // Farmacity): sin año, se ubica cerca de la referencia
  {
    re: /(?<![\d./])(\d{1,2})[./](\d{1,2})(?![./]?\d)\s*(?:AL|-)\s*(\d{1,2})[./](\d{1,2})(?![./]?\d)/,
    read: (m, reference) => {
      const [startDay, startMonth, endDay, endMonth] = m.slice(1, 5).map(Number);
      if (startMonth < 1 || startMonth > 12 || endMonth < 1 || endMonth > 12) return EMPTY;
      return nearestRange(startDay, startMonth, endDay, endMonth, reference);
    },
  },
];

/**
 * Lee la vigencia escrita en un texto libre (legal, condiciones, título).
 *
 * Devuelve `{ start_date, end_date }` en `YYYY-MM-DD`, o los dos en null si no
 * hay una vigencia legible. Si el patrón que aparece primero arma una fecha
 * imposible (31 de febrero) se devuelve vacío: no se sigue buscando otra frase
 * que quizás hable de otra cosa.
 *
 * @param {string} text
 * @param {Date}   reference  sólo la usan los rangos sin año
 */
export function parseValidityText(text, reference = new Date()) {
  if (text === null || text === undefined) return EMPTY;
  const normalized = normalizeForDates(text);
  const ref = reference instanceof Date ? reference : new Date(reference);
  if (Number.isNaN(ref.getTime())) return EMPTY;

  let first = null;
  for (const pattern of PATTERNS) {
    const match = normalized.match(pattern.re);
    if (match && (first === null || match.index < first.match.index)) first = { pattern, match };
  }
  if (!first) return EMPTY;

  return { ...first.pattern.read(first.match, ref) };
}
