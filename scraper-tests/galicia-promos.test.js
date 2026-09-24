// scrapper-script/scraper-tests/galicia-promos.test.js
//
// Tests de la parte pura del scraper de Galicia (agrupado, fechas, ids) y del manejo
// de fallas con un `get` inyectado. No pegan a la red: usan el fixture galicia-promos.json
// (snapshot real del BFF de beneficios, 2026-09-23).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ddmmyyyyToIso,
  groupDetails,
  externalIdFor,
  normalizeGaliciaGroup,
  getGaliciaPromotions,
} from '../scrapers/promos/galicia.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/galicia-promos.json'), 'utf8'));
const details = Object.values(fixture.details);
const listById = new Map(fixture.list.data.list.map((i) => [i.id, i]));

/** `get` falso: sirve el fixture como si fuera el BFF. */
function fakeGet({ failDetail = [] } = {}) {
  return async (url) => {
    if (url.includes('/promociones/catalogo')) {
      return { status: 200, body: JSON.stringify(fixture.list), contentType: 'application/json' };
    }
    const id = Number(url.split('/').pop());
    if (failDetail.includes(id)) return { status: 500, body: 'boom', contentType: 'text/plain' };
    return { status: 200, body: JSON.stringify({ data: fixture.details[id], errors: null }), contentType: 'application/json' };
  };
}

test('ddmmyyyyToIso convierte día/mes/año y rechaza imposibles', () => {
  assert.equal(ddmmyyyyToIso('05/03/2026'), '2026-03-05');
  assert.equal(ddmmyyyyToIso('31/02/2026'), null);
  assert.equal(ddmmyyyyToIso('2026-03-05'), null);
  assert.equal(ddmmyyyyToIso(null), null);
});

test('los dos segmentos de Elten son UNA promo con dos niveles', () => {
  const groups = groupDetails(details);
  const elten = groups.find((g) => g.members.some((m) => m.id === 178589));
  assert.deepEqual(elten.members.map((m) => m.id).sort(), [178589, 178590]);

  const promo = normalizeGaliciaGroup(elten, listById);
  assert.equal(promo.segments.length, 2);
  assert.deepEqual(promo.segments.map((s) => s.segment).sort(), ['Eminent', 'Masivo']);
  assert.deepEqual(promo.segments.map((s) => s.discount_percent).sort(), [20, 25]);
});

test('dos detalles del MISMO segmento no se agrupan (Review Focus 5)', () => {
  const copia = { ...fixture.details[178589], id: 999001, porcentajeAhorro: 30 };
  const groups = groupDetails([fixture.details[178589], copia]);
  assert.equal(groups.length, 2);
  assert.notEqual(externalIdFor(groups[0].key), externalIdFor(groups[1].key));
});

test('external_id estable entre corridas y ante otro orden', () => {
  const ids1 = groupDetails(details).map((g) => externalIdFor(g.key)).sort();
  const ids2 = groupDetails([...details].reverse()).map((g) => externalIdFor(g.key)).sort();
  assert.deepEqual(ids1, ids2);
  for (const id of ids1) assert.match(id, /^gal-[0-9a-f]{12}$/);
});

test('Carrefour: fechas ISO, tope, mínimo, días y tarjetas', () => {
  const g = groupDetails(details).find((x) => x.members[0].id === 181863);
  const p = normalizeGaliciaGroup(g, listById);
  assert.equal(p.source, 'galicia');
  assert.equal(p.merchant_name, 'Carrefour');
  assert.equal(p.category, 'Supermercados');
  assert.equal(p.start_date, '2026-09-23');
  assert.equal(p.end_date, '2026-09-30');
  assert.equal(p.days, 'Mi');
  assert.equal(p.payment.qr, true);
  assert.equal(p.segments[0].cap_amount, 10000);
  assert.equal(p.segments[0].cap_period, 'Mensual');
  assert.equal(p.segments[0].min_purchase, 15000);
  assert.ok(p.segments[0].legal.length > 50);
});

test('la salida no lleva campos volátiles', () => {
  const p = normalizeGaliciaGroup(groupDetails(details)[0], listById);
  const json = JSON.stringify(p);
  for (const k of ['proximamente', 'flagNovedad', 'esRegresiva']) {
    assert.ok(!json.includes(k), `no debería emitir ${k}`);
  }
});

test('corrida completa con get falso', async () => {
  const r = await getGaliciaPromotions({ get: fakeGet(), concurrency: 2 });
  assert.equal(r.success, true);
  assert.equal(r.listed, 4);
  assert.equal(r.total, 3); // Coto, Carrefour y Elten (2 segmentos)
  assert.equal(r.failed_details, 0);
});

test('un detalle que falla se saltea y se cuenta', async () => {
  const r = await getGaliciaPromotions({ get: fakeGet({ failDetail: [177518] }), concurrency: 1, retryDelayMs: 0 });
  assert.equal(r.success, true);
  assert.equal(r.failed_details, 1);
  assert.equal(r.total, 2);
});

test('403 o HTML en vez de JSON: falla fuerte, nunca "0 promos"', async () => {
  const bloqueado = async () => ({ status: 403, body: '<html>Access denied</html>', contentType: 'text/html' });
  const r1 = await getGaliciaPromotions({ get: bloqueado });
  assert.equal(r1.success, false);
  assert.equal(r1.blocked, true);

  const html = async () => ({ status: 200, body: '<html>challenge</html>', contentType: 'text/html' });
  const r2 = await getGaliciaPromotions({ get: html });
  assert.equal(r2.success, false);
  assert.equal(r2.blocked, true);
});
