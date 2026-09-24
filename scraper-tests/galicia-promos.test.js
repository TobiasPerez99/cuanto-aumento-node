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

/** Sin esperas reales entre reintentos. */
const FAST = { retryDelaysMs: [0, 0], finalPassDelayMs: 0 };

/**
 * `get` falso: sirve el fixture como si fuera el BFF.
 *   failDetail    ids cuyo detalle responde 500 siempre
 *   failTimes     { id: n } — el detalle responde 500 las primeras n veces y después anda
 *   statuses      { id | 'catalogo': [status, ...] } — status de cada intento; agotada la lista, lo normal
 *   extraList / extraDetails  promos que se suman al fixture
 *   calls         array donde se anotan los ids de detalle pedidos
 */
function fakeGet({ failDetail = [], failTimes = {}, statuses = {}, extraList = [], extraDetails = {}, calls = [] } = {}) {
  const list = {
    ...fixture.list,
    data: { list: [...fixture.list.data.list, ...extraList], totalSize: fixture.list.data.totalSize + extraList.length },
  };
  const allDetails = { ...fixture.details, ...extraDetails };
  const intentos = {};
  const scripted = (key) => {
    intentos[key] = (intentos[key] ?? 0) + 1;
    return statuses[key]?.[intentos[key] - 1];
  };
  return async (url) => {
    if (url.includes('/promociones/catalogo')) {
      const status = scripted('catalogo');
      if (status) return { status, body: 'espera', contentType: 'text/plain' };
      return { status: 200, body: JSON.stringify(list), contentType: 'application/json' };
    }
    const id = Number(url.split('/').pop());
    calls.push(id);
    const status = scripted(id);
    if (status) return { status, body: '<html>no</html>', contentType: 'text/html' };
    if (failDetail.includes(id) || (failTimes[id] ?? 0) >= intentos[id]) {
      return { status: 500, body: 'boom', contentType: 'text/plain' };
    }
    return { status: 200, body: JSON.stringify({ data: allDetails[id], errors: null }), contentType: 'application/json' };
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
  const r = await getGaliciaPromotions({ get: fakeGet({ failDetail: [177518] }), concurrency: 1, ...FAST });
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

// ─── Un segmento que no llegó no muta la promo agrupada (F4) ───────────────────

const eltenDe = (r) => r.promotions.filter((p) => p.merchant_name === 'Tiendas Elten');

test('el Eminent de Elten falla siempre: no sale Elten, ni siquiera con un segmento', async () => {
  const r = await getGaliciaPromotions({ get: fakeGet({ failDetail: [178590] }), concurrency: 2, ...FAST });
  assert.equal(r.success, true);
  assert.equal(eltenDe(r).length, 0);
  assert.equal(r.failed_details, 1);
  assert.deepEqual(r.failed_ids, [178590]);
  assert.equal(r.dropped_groups, 1);
  assert.equal(r.total, 2); // Coto y Carrefour
});

test('un detalle que falla en la pasada concurrente y anda en la final deja el grupo completo', async () => {
  // 3 = el intento más los 2 reintentos de la pasada concurrente; el 4º es la pasada final.
  const r = await getGaliciaPromotions({ get: fakeGet({ failTimes: { 178590: 3 } }), concurrency: 2, ...FAST });
  assert.equal(r.success, true);
  assert.equal(eltenDe(r).length, 1);
  assert.equal(eltenDe(r)[0].segments.length, 2);
  assert.equal(r.failed_details, 0);
  assert.deepEqual(r.failed_ids, []);
  assert.equal(r.dropped_groups, 0);
});

test('una promo por categoría (sin idMarca) que falla saca todos los grupos por categoría', async () => {
  const base = fixture.details[177518];
  const porCategoria = (id, categoriaId, segmento) => ({
    ...base,
    id,
    marca: null,
    categoria: { id: categoriaId, descripcion: `Categoría ${categoriaId}` },
    modeloAtencion: { nombre: segmento, exclusivo: false },
  });
  const extraDetails = {
    900001: porCategoria(900001, 8, 'Masivo'),
    900002: porCategoria(900002, 9, 'Masivo'),
    900003: porCategoria(900003, 10, 'Eminent'),
  };
  const extraList = [900001, 900002, 900003].map((id) => ({ ...fixture.list.data.list[0], id, idMarca: null }));

  const ok = await getGaliciaPromotions({ get: fakeGet({ extraList, extraDetails }), concurrency: 2, ...FAST });
  assert.equal(ok.total, 6); // 3 por marca + 3 por categoría

  const r = await getGaliciaPromotions({
    get: fakeGet({ extraList, extraDetails, failDetail: [900003] }),
    concurrency: 2,
    ...FAST,
  });
  assert.equal(r.success, true);
  assert.equal(r.total, 3); // quedan sólo las de marca
  assert.equal(r.dropped_groups, 2);
  assert.ok(r.promotions.every((p) => p.merchant_name !== null));
});

// ─── 429/503 son pasajeros; 403 es bloqueo; un bloqueo frena a todos (F8) ──────

test('429 y después 200 en un detalle: se reintenta y entra', async () => {
  const r = await getGaliciaPromotions({ get: fakeGet({ statuses: { 178590: [429] } }), concurrency: 1, ...FAST });
  assert.equal(r.success, true);
  assert.equal(r.failed_details, 0);
  assert.equal(eltenDe(r)[0].segments.length, 2);
});

test('429 en todos los intentos: el detalle cuenta como fallido, no como bloqueo', async () => {
  const r = await getGaliciaPromotions({
    get: fakeGet({ statuses: { 177518: Array(10).fill(429) } }),
    concurrency: 1,
    ...FAST,
  });
  assert.equal(r.success, true);
  assert.equal(r.failed_details, 1);
  assert.deepEqual(r.failed_ids, [177518]);
  assert.equal(r.total, 2);
});

test('503 en el listado y después 200: el listado reintenta una vez', async () => {
  const r = await getGaliciaPromotions({ get: fakeGet({ statuses: { catalogo: [503] } }), concurrency: 1, ...FAST });
  assert.equal(r.success, true);
  assert.equal(r.total, 3);
});

test('503 en el listado dos veces: la corrida falla, pero no como bloqueo', async () => {
  const r = await getGaliciaPromotions({ get: fakeGet({ statuses: { catalogo: [503, 503] } }), concurrency: 1, ...FAST });
  assert.equal(r.success, false);
  assert.equal(r.blocked, false);
});

test('403 en un detalle: bloqueo, falla fuerte', async () => {
  const r = await getGaliciaPromotions({ get: fakeGet({ statuses: { 178590: [403] } }), concurrency: 1, ...FAST });
  assert.equal(r.success, false);
  assert.equal(r.blocked, true);
});

test('un bloqueo frena a los demás workers: nadie toma ids nuevos', async () => {
  const calls = [];
  const r = await getGaliciaPromotions({ get: fakeGet({ statuses: { 177518: [403] }, calls }), concurrency: 2, ...FAST });
  await new Promise((resolve) => setTimeout(resolve, 20)); // que termine lo que quedó en vuelo
  assert.equal(r.blocked, true);
  // 177518 (bloqueado) y 178589 (ya en vuelo en el otro worker); 178590 y 181863 no se piden.
  assert.deepEqual([...calls].sort(), [177518, 178589]);
});
