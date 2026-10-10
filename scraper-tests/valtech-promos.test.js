// scrapper-script/scraper-tests/valtech-promos.test.js
//
// Tests del core de promociones bancarias de Valtech (Carrefour y Masonline). Sin red:
// usan snapshots reales del Master Data (BP + FB + FC) del 2026-10-10 y un `httpGet`
// inyectado para el manejo de fallas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  humanizeName,
  isCurrent,
  normalizeValtechPromotions,
  parseContentRangeTotal,
  getValtechBankPromotions,
} from '../cores/valtechBankPromotions.js';
import { getCarrefourPromotions } from '../scrapers/promos/carrefour.js';
import { getMasonlinePromotions } from '../scrapers/promos/masonline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));
const carrefour = load('carrefour-bank-promotions.json');
const masonline = load('masonline-bank-promotions.json');

const NOW = new Date('2026-10-10T12:00:00Z');

/** Master Data falso: sirve el fixture por entidad, con el header de rango real. */
function fakeHttpGet(fixture, { status = {}, body = {}, calls = [] } = {}) {
  return async (url, headers) => {
    calls.push({ url, headers });
    const entity = url.match(/dataentities\/(\w+)\//)[1];
    if (status[entity]) return { status: status[entity], data: body[entity] ?? '<html>no</html>', headers: {} };
    const rows = fixture[entity.toLowerCase()];
    return { status: 200, data: rows, headers: { 'rest-content-range': `resources 0-${rows.length}/${rows.length}` } };
  };
}

test('humanizeName limpia las etiquetas internas y descarta el ruido de la entidad FC', () => {
  assert.equal(humanizeName('Banco_Nacion'), 'Banco Nacion');
  assert.equal(humanizeName('Tarjeta_Standard_Master_Carrefour'), 'Tarjeta Standard Master Carrefour');
  assert.equal(humanizeName('kimi-probe-inert-please-ignore'), null);
  assert.equal(humanizeName('  '), null);
});

test('parseContentRangeTotal lee el total del header de rango', () => {
  assert.equal(parseContentRangeTotal('resources 0-144/144'), 144);
  assert.equal(parseContentRangeTotal(undefined), null);
});

test('isCurrent replica el filtro del front: activa y dentro de la ventana', () => {
  const base = { active: true, active_from: '2026-10-01T00:00:00+00:00', active_to: '2026-11-01T00:00:00+00:00' };
  assert.equal(isCurrent(base, NOW), true);
  assert.equal(isCurrent({ ...base, active: false }, NOW), false);
  assert.equal(isCurrent({ ...base, active_to: '2026-10-01T00:00:00+00:00', active_from: '2026-09-01T00:00:00+00:00' }, NOW), false);
  assert.equal(isCurrent({ ...base, active_from: 'basura' }, NOW), false);
});

test('Carrefour: sólo las vigentes, con fechas en UTC y fin exclusivo pasado a inclusivo', () => {
  const promos = normalizeValtechPromotions(carrefour, { source: 'carrefour', merchant: 'Carrefour', withFormats: true, now: NOW });
  const vigentes = carrefour.bp.filter((r) => isCurrent(r, NOW));

  assert.equal(promos.length, vigentes.length);
  assert.ok(promos.length > 0);
  for (const promo of promos) {
    assert.match(promo.external_id, /^carrefour-[0-9a-f-]{36}$/);
    assert.equal(promo.comercio, 'Carrefour');
    // active_to 2026-11-01T00:00Z es el fin exclusivo de octubre.
    assert.equal(promo.end_date, '2026-10-31');
    assert.match(promo.start_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(promo.formatos));
    assert.equal('order' in promo, false, 'el orden de la grilla no viaja: cambiaría la huella sin que cambie la promo');
  }
});

test('Carrefour: el banco y la tarjeta salen de los diccionarios, y las cuotas son número', () => {
  const promos = normalizeValtechPromotions(carrefour, { source: 'carrefour', merchant: 'Carrefour', withFormats: true, now: NOW });
  const mp = promos.find((p) => p.title === 'Hasta 6 Cuotas sin interés con Mercado Pago');
  assert.ok(mp);
  assert.equal(mp.banco, 'Mercado Pago');
  assert.equal(mp.cuotas, 6);
  assert.equal(mp.descuento_porcentaje, null);
  assert.deepEqual(mp.dias, ['lunes', 'miercoles']);

  const cuentaDigital = promos.find((p) => p.tarjeta === 'Cuenta Digital');
  assert.ok(cuentaDigital, 'idCard se resuelve contra FC');
  assert.ok(cuentaDigital.descuento_porcentaje > 0);

  const sinMedio = promos.find((p) => p.title?.startsWith('Si sos empleado/a público'));
  assert.ok(sinMedio);
  assert.equal(sinMedio.banco, null);
  assert.equal(sinMedio.tarjeta, null);
  assert.ok(sinMedio.legal, 'sin banco ni tarjeta, el legal es lo único que dice quién accede');
});

test('Masonline: el banco sale de FB (el título no lo dice) y se marca Más Club', () => {
  const promos = normalizeValtechPromotions(masonline, { source: 'masonline', merchant: 'Masonline', now: NOW });
  assert.ok(promos.length > 0);
  for (const promo of promos) {
    assert.match(promo.external_id, /^masonline-/);
    assert.equal('formatos' in promo, false, 'Masonline no usa los booleanos de formato');
    assert.equal(typeof promo.exclusivo_mas_club, 'boolean');
  }

  const sol = promos.find((p) => p.title === 'Con tarjeta de crédito SOL');
  assert.equal(sol.banco, 'Sol');
  assert.equal(sol.descuento_porcentaje, 20);
  assert.equal(sol.cuotas, 4, 'Masonline puede traer % y cuotas en la misma promo');

  // Un fin inclusivo (31/12) no se corre: sólo el 1° de mes a medianoche es exclusivo.
  const masGo = promos.find((p) => p.title === 'Exclusivo MasGo ¡SIN TOPE!');
  assert.equal(masGo.end_date, '2026-12-31');
});

test('getValtechBankPromotions manda REST-Range y arma la corrida completa', async () => {
  const calls = [];
  const result = await getCarrefourPromotions({ httpGet: fakeHttpGet(carrefour, { calls }), now: NOW });

  assert.equal(result.success, true);
  assert.equal(result.source, 'carrefour');
  assert.equal(result.total, result.promotions.length);
  assert.equal(calls.length, 3);
  for (const { headers } of calls) assert.equal(headers['REST-Range'], 'resources=0-999');
});

test('Masonline usa el host propio', async () => {
  const calls = [];
  await getMasonlinePromotions({ httpGet: fakeHttpGet(masonline, { calls }), now: NOW });
  assert.ok(calls.every(({ url }) => url.startsWith('https://www.masonline.com.ar/api/dataentities/')));
});

test('un 403 del Master Data falla la corrida en vez de devolver 0 promos', async () => {
  const result = await getValtechBankPromotions({
    baseUrl: 'https://www.carrefour.com.ar',
    source: 'carrefour',
    merchant: 'Carrefour',
    httpGet: fakeHttpGet(carrefour, { status: { BP: 403 } }),
    now: NOW,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /BP: el Master Data respondió 403/);
});

test('un diccionario caído también falla: sin FB, Masonline emitiría promos sin banco', async () => {
  const result = await getMasonlinePromotions({ httpGet: fakeHttpGet(masonline, { status: { FB: 500 } }), now: NOW });
  assert.equal(result.success, false);
  assert.match(result.error, /^FB:/);
});

test('un cuerpo que no es lista (HTML de un challenge) falla', async () => {
  const httpGet = async () => ({ status: 200, data: '<html>challenge</html>', headers: {} });
  const result = await getCarrefourPromotions({ httpGet, now: NOW });
  assert.equal(result.success, false);
  assert.match(result.error, /no devolvió una lista/);
});

test('pagina con REST-Range cuando el total supera la página', async () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({ ...carrefour.bp[0], id: `id-${i}` }));
  const ranges = [];
  const httpGet = async (url, headers) => {
    const entity = url.match(/dataentities\/(\w+)\//)[1];
    if (entity !== 'BP') return { status: 200, data: carrefour[entity.toLowerCase()], headers: {} };
    ranges.push(headers['REST-Range']);
    const [from, to] = headers['REST-Range'].match(/\d+/g).map(Number);
    return { status: 200, data: many.slice(from, to + 1), headers: { 'rest-content-range': `resources ${from}-${to}/1500` } };
  };
  await getCarrefourPromotions({ httpGet, now: NOW });
  assert.deepEqual(ranges, ['resources=0-999', 'resources=1000-1999']);
});
