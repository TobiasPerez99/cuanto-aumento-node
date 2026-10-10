// scrapper-script/scraper-tests/cuentadni-promos.test.js
//
// Tests del scraper de Cuenta DNI. Sin red: la grilla y los detalles son snapshots
// reales del 2026-10-10 (cuentadni-beneficios.html, cuentadni-details.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseBenefitIds,
  fromDotNetDate,
  publicationWindow,
  skipReason,
  normalizeCuentaDniBenefit,
  getCuentaDniPromotions,
} from '../scrapers/promos/cuentadni.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'fixtures/cuentadni-beneficios.html'), 'utf8');
const { details } = JSON.parse(readFileSync(join(__dirname, 'fixtures/cuentadni-details.json'), 'utf8'));
const entity = (id) => details[id].Entity;

const NOW = new Date('2026-10-10T12:00:00Z');

test('parseBenefitIds saca los ids de las tarjetas de la grilla, sin repetir', () => {
  const ids = parseBenefitIds(html);
  assert.equal(ids.length, 21);
  assert.ok(ids.includes(1072));
  assert.ok(ids.includes(519));
  assert.deepEqual(parseBenefitIds('<div class="otra">'), []);
});

test('fromDotNetDate y la ventana de publicación (fecha_hasta es la medianoche del día siguiente)', () => {
  assert.equal(fromDotNetDate('/Date(1790737200000)/'), 1790737200000);
  assert.equal(fromDotNetDate('basura'), null);
  assert.deepEqual(publicationWindow(entity(1072).Beneficio), { start_date: '2026-09-30', end_date: '2026-10-31' });
});

test('Carrefour: la vigencia sale del legal, no de la ventana de publicación', () => {
  const promo = normalizeCuentaDniBenefit(entity(1072), NOW);
  assert.equal(promo.external_id, 'cdni-1072');
  assert.equal(promo.slug, 'carrefour');
  assert.equal(promo.tipo_beneficio, 'descuento');
  assert.equal(promo.descuento_porcentaje, 10);
  assert.equal(promo.cuotas, null);
  assert.equal(promo.dias, 'Miércoles');
  // La ventana arranca el 30/09; el legal dice "todos los miércoles de octubre del 2026".
  assert.equal(promo.start_date, '2026-10-01');
  assert.equal(promo.end_date, '2026-10-31');
  assert.equal(promo.vigencia_origen, 'legal');
  assert.ok(promo.condiciones.length > 0);
  assert.deepEqual(promo.rubros, ['Supermercados']);
  assert.ok(promo.legal.length > 100);
});

test('con tipo = 2, porcentaje son cuotas, no un descuento', () => {
  const promo = normalizeCuentaDniBenefit(entity(519), NOW);
  assert.equal(promo.tipo_beneficio, 'cuotas');
  assert.equal(promo.cuotas, 3);
  assert.equal(promo.descuento_porcentaje, null);
});

test('Día: un legal con rango entre dos fechas escritas', () => {
  const promo = normalizeCuentaDniBenefit(entity(1076), NOW);
  assert.equal(promo.start_date, '2026-10-01');
  assert.equal(promo.end_date, '2026-12-31');
});

test('sin vigencia legible en el legal se usa la ventana, marcada como tal', () => {
  const sinLegal = structuredClone(entity(1072));
  sinLegal.Beneficio.legal = 'Consultá las bases en la web.';
  const promo = normalizeCuentaDniBenefit(sinLegal, NOW);
  assert.equal(promo.vigencia_origen, 'ventana');
  assert.equal(promo.start_date, '2026-09-30');
  assert.equal(promo.end_date, '2026-10-31');
});

test('los beneficios con micrositio (JSON incompleto) u ocultos se descartan', () => {
  assert.equal(skipReason(entity(1069)), 'micrositio');
  const oculto = structuredClone(entity(1072));
  oculto.Beneficio.oculto = 1;
  assert.equal(skipReason(oculto), 'oculto');
  assert.equal(skipReason(entity(1072)), null);
});

test('la salida no lleva los links de los botones (traen parámetros de rastreo que cambian)', () => {
  const promo = normalizeCuentaDniBenefit(entity(1072), NOW);
  assert.equal(JSON.stringify(promo).includes('srsltid'), false);
});

/** Sitio falso: la grilla del fixture y los detalles que haya; el resto, Success=false. */
function fakeHttpGet({ failIds = [], listStatus = 200, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    if (url.includes('cdnibeneficios')) return { status: listStatus, data: html };
    const id = Number(url.split('=').pop());
    if (failIds.includes(id)) return { status: 500, data: 'error' };
    if (details[id]) return { status: 200, data: details[id] };
    return { status: 200, data: { Entity: null, Success: false, Message: 'Error: Object reference not set' } };
  };
}

const FAST = { sleep: async () => {}, delayMs: 0, now: NOW };

test('corrida completa: emite los del fixture, descarta el micrositio y cuenta los inexistentes como fallidos', async () => {
  const result = await getCuentaDniPromotions({ httpGet: fakeHttpGet(), ...FAST });
  assert.equal(result.success, true);
  assert.deepEqual(result.promotions.map((p) => p.external_id).sort(), ['cdni-1052', 'cdni-1072', 'cdni-1073', 'cdni-1076', 'cdni-519']);
  assert.deepEqual(result.skipped, [{ id: 1069, reason: 'micrositio' }]);
  // 21 en la grilla, 6 en el fixture: los otros 15 responden Success=false.
  assert.equal(result.failed_ids.length, 15);
});

test('un detalle que falla una vez se reintenta', async () => {
  let intentos = 0;
  const base = fakeHttpGet();
  const httpGet = async (url) => {
    if (url.endsWith('=1072') && intentos++ === 0) return { status: 503, data: 'ocupado' };
    return base(url);
  };
  const result = await getCuentaDniPromotions({ httpGet, ...FAST });
  assert.ok(result.promotions.some((p) => p.external_id === 'cdni-1072'));
});

test('sin grilla legible la corrida falla en vez de devolver 0 promos', async () => {
  const caida = await getCuentaDniPromotions({ httpGet: fakeHttpGet({ listStatus: 500 }), ...FAST });
  assert.equal(caida.success, false);

  const vacia = await getCuentaDniPromotions({ httpGet: async () => ({ status: 200, data: '<html></html>' }), ...FAST });
  assert.equal(vacia.success, false);
  assert.match(vacia.error, /ningún beneficio/);
});

test('si fallan todos los detalles, la corrida falla', async () => {
  const httpGet = async (url) => (url.includes('cdnibeneficios') ? { status: 200, data: html } : { status: 500, data: 'x' });
  const result = await getCuentaDniPromotions({ httpGet, ...FAST });
  assert.equal(result.success, false);
  assert.match(result.error, /fallaron los 21 detalles/);
});
