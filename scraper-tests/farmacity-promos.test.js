// scrapper-script/scraper-tests/farmacity-promos.test.js
//
// Tests de las promos de Farmacity: la planilla de medios de pago (fixture reducido del
// HTML real del 2026-10-10), la foto de teasers (nombres reales de la entrega de Natalia
// Rojas, 2026-09-08) y cómo la junta la corrida de productos. Sin red.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractRuntimeExtensions,
  extractPaymentRows,
  isBenefitText,
  buildBankPromotions,
  parseTeaserName,
  buildTeaserPromotions,
  getFarmacityPromotions,
} from '../scrapers/promos/farmacity.js';
import {
  createTeaserCollector,
  loadTeaserSnapshot,
  forgetTeaserSnapshots,
} from '../cores/teaserSnapshots.js';
import { scrapeVtexProducts } from '../cores/vtexProducts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'fixtures/farmacity-medios-de-pago.html'), 'utf8');
const snapshot = JSON.parse(readFileSync(join(__dirname, 'fixtures/farmacity-teaser-snapshot.json'), 'utf8'));
const rows = extractPaymentRows(extractRuntimeExtensions(html));

const NOW = new Date('2026-10-10T12:00:00Z');

beforeEach(() => forgetTeaserSnapshots());

/* ------------------------------ planilla bancaria ----------------------------- */

test('extrae la planilla del template del Site Editor (doble parse)', () => {
  assert.ok(rows.length > 30);
  assert.ok('Promoción' in rows[0] && 'Legales' in rows[0] && 'Banco' in rows[0]);
});

test('sin el bloque de la planilla, falla con un mensaje claro', () => {
  assert.throws(() => extractPaymentRows({ otra: {} }), /planilla de medios de pago/);
  assert.throws(() => extractRuntimeExtensions('<html></html>'), /template de extensiones/);
});

test('isBenefitText descarta las filas informativas', () => {
  assert.equal(isBenefitText('Pagá al contado con tu Tarjeta de débito. TIENDA ON LINE Y SUCURSALES'), false);
  assert.equal(isBenefitText('Todos los días, 3 cuotas sin interés'), true);
  assert.equal(isBenefitText('Jueves 25% de Ahorro'), true);
});

test('una promo por texto de promoción, con banco, legales y un id estable', () => {
  const { promotions, informative } = buildBankPromotions(rows, NOW);
  assert.ok(promotions.length > 10);
  assert.ok(informative >= 1, 'la fila "Pagá al contado" no es una promo');

  for (const promo of promotions) {
    assert.match(promo.external_id, /^fcy-banco-[0-9a-f]{12}$/);
    assert.equal(promo.comercio, 'Farmacity');
    assert.equal(promo.tipo, 'bancaria');
    assert.ok(promo.promocion);
    assert.equal('tarjeta' in promo, false, 'la columna Tarjeta de la fila no es la de la promo');
    if (promo.legales_de_la_fila) assert.match(promo.aviso, /vale el texto de "promocion"/);
  }

  const again = buildBankPromotions(rows, NOW).promotions.map((p) => p.external_id);
  assert.deepEqual(again, promotions.map((p) => p.external_id));
});

test('la vigencia sale del texto de la promo cuando la trae', () => {
  const { promotions } = buildBankPromotions(rows, NOW);
  const amex = promotions.find((p) => p.promocion.startsWith('Obtené un reintegro de $30.000'));
  assert.equal(amex.start_date, '2026-07-01');
  assert.equal(amex.end_date, '2026-12-31');

  const ddm = promotions.find((p) => p.promocion.includes('Vigencia 08.10 al 10.10'));
  assert.equal(ddm.start_date, '2026-10-08');
  assert.equal(ddm.end_date, '2026-10-10');

  const sinFecha = promotions.find((p) => p.promocion.startsWith('Todos los días, 3 cuotas sin interés con Tarjetas American Express'));
  assert.equal(sinFecha.start_date, null);
  assert.equal(sinFecha.end_date, null);
});

test('una promo cuyo propio texto dice que terminó se descarta', () => {
  const vencida = { Banco: 'SANTANDER', Nombre: 'Banco Santander', 'Promoción': 'Viernes 35% de descuento. Vigencia: del 01/09/2026 al 18/09/2026.', Legales: '' };
  const { promotions, expired } = buildBankPromotions([vencida], NOW);
  assert.equal(promotions.length, 0);
  assert.equal(expired, 1);
});

/* --------------------------------- teasers --------------------------------- */

test('parseTeaserName separa el título de la marca interna y lee la vigencia sin año', () => {
  const ref = new Date('2026-09-08T08:00:00Z');
  assert.deepEqual(parseTeaserName('2x1 Combinable Tu Farmacity#01/09 - 21/09 // ID: 250077 (Bot carga: 28-08)', ref), {
    title: '2x1 Combinable Tu Farmacity',
    start_date: '2026-09-01',
    end_date: '2026-09-21',
  });
  assert.deepEqual(parseTeaserName('-50% 2da unidad Tu Farmacity#01/09 - 13/09 (emergente)', ref), {
    title: '-50% 2da unidad Tu Farmacity',
    start_date: '2026-09-01',
    end_date: '2026-09-13',
  });
  assert.deepEqual(parseTeaserName('3x2 sin vigencia', ref), { title: '3x2 sin vigencia', start_date: null, end_date: null });
});

test('las promos de producto agrupan teasers equivalentes y descartan las vencidas', () => {
  const vistaEl = new Date('2026-09-08T12:00:00Z');
  const promos = buildTeaserPromotions(snapshot, vistaEl);
  assert.ok(promos.length > 0);
  for (const promo of promos) {
    assert.match(promo.external_id, /^fcy-promo-[0-9a-f]{12}$/);
    assert.equal(promo.tipo, 'producto');
    assert.ok(promo.end_date === null || promo.end_date >= '2026-09-08');
  }
  const tuFarmacity = promos.find((p) => p.title === '2x1 Tu Farmacity' && p.end_date === '2026-09-21');
  assert.equal(tuFarmacity.exclusivo_tu_farmacity, true);
  assert.equal(tuFarmacity.solo_web, false);

  // Un mes después, las de septiembre ya no salen.
  assert.equal(buildTeaserPromotions(snapshot, new Date('2026-10-25T12:00:00Z')).length, 0);
});

test('dos teasers internos de la misma promo (sólo cambia la marca de carga) son una sola', () => {
  const foto = {
    captured_at: '2026-10-05T00:00:00Z',
    teasers: [
      { name: '2x1#01/10 - 31/10 (Bot carga: 28-09)', product_count: 3, sample_products: [{ ean: '1' }] },
      { name: '2x1#01/10 - 31/10 // ID: 99 (Bot carga: 30-09)', product_count: 2, sample_products: [{ ean: '2' }] },
    ],
  };
  const promos = buildTeaserPromotions(foto, NOW);
  assert.equal(promos.length, 1);
  assert.equal(promos[0].product_count, 5);
  assert.deepEqual(promos[0].sample_products, [{ ean: '1' }, { ean: '2' }]);
});

test('sin foto no hay promos de producto', () => {
  assert.deepEqual(buildTeaserPromotions(null, NOW), []);
});

/* ------------------------------ corrida completa ----------------------------- */

const servePage = (status = 200, data = html) => async () => ({ status, data });

test('corrida completa: bancarias + producto, e informa la foto usada', async () => {
  const result = await getFarmacityPromotions({
    httpGet: servePage(),
    loadSnapshot: async () => snapshot,
    now: new Date('2026-09-08T12:00:00Z'),
  });
  assert.equal(result.success, true);
  assert.ok(result.promotions.some((p) => p.tipo === 'bancaria'));
  assert.ok(result.promotions.some((p) => p.tipo === 'producto'));
  assert.deepEqual(result.teaser_snapshot, { captured_at: snapshot.captured_at, teasers: snapshot.teasers.length });
});

test('sin foto de teasers salen sólo las bancarias, sin fallar', async () => {
  const result = await getFarmacityPromotions({ httpGet: servePage(), loadSnapshot: async () => null, now: NOW });
  assert.equal(result.success, true);
  assert.ok(result.promotions.every((p) => p.tipo === 'bancaria'));
  assert.equal(result.teaser_snapshot, null);
});

test('una página caída o sin planilla falla en vez de devolver 0 promos', async () => {
  const caida = await getFarmacityPromotions({ httpGet: servePage(503, 'x'), loadSnapshot: async () => null, now: NOW });
  assert.equal(caida.success, false);

  const sinPlanilla = await getFarmacityPromotions({ httpGet: servePage(200, '<html></html>'), loadSnapshot: async () => null, now: NOW });
  assert.equal(sinPlanilla.success, false);
});

/* ------------------------- la foto la deja la corrida de productos ------------------------- */

test('el colector cuenta cada producto una vez por teaser y guarda una muestra con EAN', () => {
  const collector = createTeaserCollector({ maxSamples: 1 });
  const product = (id, ean, teasers) => ({
    productId: id,
    productName: `Producto ${id}`,
    items: [{ ean, sellers: [{ sellerDefault: true, commertialOffer: { Teasers: teasers } }] }],
  });
  const dosPorUno = { '<Name>k__BackingField': '2x1#01/10 - 31/10' };
  collector.collect([product('1', '111', [dosPorUno]), product('2', '222', [dosPorUno])]);
  collector.collect([product('1', '111', [dosPorUno])]); // el mismo producto en otra categoría

  const { teasers } = collector.snapshot();
  assert.deepEqual(teasers, [{ name: '2x1#01/10 - 31/10', product_count: 2, sample_products: [{ ean: '111', name: 'Producto 1' }] }]);
});

/** VTEX falso mínimo: un departamento con dos productos de Farmacity, uno con teaser. */
function fakeFarmacityVtex({ failProducts = false } = {}) {
  const products = [
    {
      productId: 'p1',
      productName: 'Shampoo',
      linkText: 'shampoo',
      brand: 'X',
      categories: ['/Cuidado Personal/'],
      items: [{ ean: '7790000000011', images: [], sellers: [{ sellerDefault: true, commertialOffer: { Price: 100, PriceWithoutDiscount: 100, IsAvailable: true, Teasers: [{ '<Name>k__BackingField': '2x1 Tu Farmacity#01/10 - 31/10' }] } }] }],
    },
    {
      productId: 'p2',
      productName: 'Jabón',
      linkText: 'jabon',
      brand: 'Y',
      categories: ['/Cuidado Personal/'],
      items: [{ ean: '7790000000028', images: [], sellers: [{ sellerDefault: true, commertialOffer: { Price: 50, PriceWithoutDiscount: 50, IsAvailable: true, Teasers: [] } }] }],
    },
  ];
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === '/api/segments') return { status: 200, data: { channel: '4' }, headers: {} };
    if (u.pathname.endsWith('/category/tree/3')) return { status: 200, data: [{ id: 1, name: 'Cuidado Personal', children: [] }], headers: {} };
    if (failProducts && u.searchParams.get('_to') !== '0' && u.searchParams.getAll('fq').some((f) => f.startsWith('C:'))) {
      throw { response: { status: 500 } };
    }
    const from = Number(u.searchParams.get('_from'));
    const to = Number(u.searchParams.get('_to'));
    return { status: 206, data: products.slice(from, to + 1), headers: { resources: `${from}-${to}/${products.length}` } };
  };
}

const dry = (httpGet) => ({ httpGet, sleep: async () => {}, onProductFound: null, retryFailedPauseMs: 0 });

test('la corrida de productos de Farmacity deja la foto de teasers sólo si fue completa', async () => {
  const saved = [];
  const result = await scrapeVtexProducts('farmacity', 'categories', dry(fakeFarmacityVtex()), {
    saveSnapshot: async (key, snap) => saved.push({ key, snap }),
  });
  assert.equal(result.complete, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, 'farmacity');
  assert.deepEqual(saved[0].snap.teasers.map((t) => t.name), ['2x1 Tu Farmacity#01/10 - 31/10']);
  assert.equal(result.teaserSnapshot.teasers, 1);

  const savedIncomplete = [];
  const failed = await scrapeVtexProducts('farmacity', 'categories', dry(fakeFarmacityVtex({ failProducts: true })), {
    saveSnapshot: async (key, snap) => savedIncomplete.push(snap),
  });
  assert.equal(failed.complete, false);
  assert.equal(savedIncomplete.length, 0, 'una corrida incompleta vio una parte: la foto diría que el resto terminó');
});

test('los demás comercios no juntan teasers', async () => {
  const saved = [];
  await scrapeVtexProducts('dia', 'categories', dry(fakeFarmacityVtex()), { saveSnapshot: async (k, s) => saved.push(s) });
  assert.equal(saved.length, 0);
});

test('una foto vencida no se lee aunque siga en memoria', async () => {
  const { saveTeaserSnapshot } = await import('../cores/teaserSnapshots.js');
  await saveTeaserSnapshot('farmacity', { ...snapshot, captured_at: '2026-10-01T00:00:00Z' });
  assert.ok(await loadTeaserSnapshot('farmacity', new Date('2026-10-02T00:00:00Z')));
  assert.equal(await loadTeaserSnapshot('farmacity', new Date('2026-10-10T00:00:00Z')), null);
});
