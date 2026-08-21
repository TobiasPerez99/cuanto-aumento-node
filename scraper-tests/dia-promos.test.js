// scrapper-script/scraper-tests/dia-promos.test.js
//
// Tests unitarios de la parte PURA del scraper de promociones de Dia
// (agrupación + contrato). No pegan a la red: usan el fixture
// dia-promos-products.json, un recorte real del VTEX Catalog System
// (colección 7220 "Hasta 2x1").
//
// El fixture son 8 de los 50 productos de la primera página, elegidos para
// cubrir las dos vías de derivación de promos:
//   - 4 CON `commertialOffer.Teasers` ("2do al 70%" ×2, "3x2 ", "6x4"), todos
//     serializados con los nombres internos de .NET (`<Name>k__BackingField`)
//     y TAMBIÉN con clusterHighlights {"632": "Exclusivo Online"} — que NO se
//     deben contar, porque el teaser tiene prioridad.
//   - 4 SIN teaser, con clusterHighlights ("572" Ahorrames ×4, "632" ×3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  teaserField,
  teaserName,
  teaserMinimumQuantity,
  toSampleProduct,
  collectPromotions,
  toPromotionContract,
} from '../scrapers/promos/dia.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const products = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/dia-promos-products.json'), 'utf8')
);

/** Oferta comercial del seller por defecto, igual que hace el scraper. */
function offerOf(product) {
  const item = product?.items?.[0];
  const seller = item?.sellers?.find((s) => s?.sellerDefault) || item?.sellers?.[0];
  return seller?.commertialOffer ?? null;
}

const teasersOf = (p) => offerOf(p)?.Teasers ?? [];
const withTeasers = products.filter((p) => teasersOf(p).length > 0);
const withoutTeasers = products.filter((p) => teasersOf(p).length === 0);

const promosOf = (list) => Array.from(collectPromotions(list).values());
const byKey = (list, key) => promosOf(list).find((p) => p.key === key);

test('el fixture trae ambas vías de derivación', () => {
  assert.equal(products.length, 8);
  assert.equal(withTeasers.length, 4, '4 productos con Teasers');
  assert.equal(withoutTeasers.length, 4, '4 productos sin Teasers');
});

/* ------------------------ teaserField / teaserName ------------------------ */

test('teaserField lee la serialización interna de .NET y la normal', () => {
  assert.equal(teaserField({ '<Name>k__BackingField': '3x2' }, 'Name'), '3x2');
  assert.equal(teaserField({ Name: '3x2' }, 'Name'), '3x2');
  // El backing field gana cuando están los dos.
  assert.equal(
    teaserField({ '<Name>k__BackingField': 'backing', Name: 'normal' }, 'Name'),
    'backing'
  );
  assert.equal(teaserField(null, 'Name'), undefined);
  assert.equal(teaserField('no-objeto', 'Name'), undefined);
});

test('teaserName soporta ambas formas y hace trim', () => {
  // Caso real del fixture: VTEX devuelve "3x2 " con espacio al final.
  assert.equal(teaserName({ '<Name>k__BackingField': '3x2 ' }), '3x2');
  assert.equal(teaserName({ Name: '  6x4  ' }), '6x4');
  assert.equal(teaserName({}), null);
  assert.equal(teaserName(null), null);
  assert.equal(teaserName({ Name: 123 }), null, 'un no-string no se cuela');
});

test('teaserName lee los teasers reales del fixture (incluido el "3x2 ")', () => {
  const nombres = withTeasers.map((p) => teaserName(teasersOf(p)[0]));

  assert.deepEqual([...new Set(nombres)].sort(), ['2do al 70%', '3x2', '6x4']);

  // El crudo SÍ trae el espacio: si el trim desapareciera, "3x2 " y "3x2"
  // serían dos promociones distintas.
  const crudo = withTeasers
    .map((p) => teaserField(teasersOf(p)[0], 'Name'))
    .find((n) => n.startsWith('3x2'));
  assert.equal(crudo, '3x2 ', 'el fixture debe conservar el espacio original');
});

/* -------------------------- teaserMinimumQuantity ------------------------- */

test('teaserMinimumQuantity extrae MinimumQuantity del backing field', () => {
  const teaser = {
    '<Name>k__BackingField': '3x2',
    '<Conditions>k__BackingField': { '<MinimumQuantity>k__BackingField': 3 },
  };
  assert.equal(teaserMinimumQuantity(teaser), 3);

  assert.equal(
    teaserMinimumQuantity({ Conditions: { MinimumQuantity: 2 } }),
    2,
    'también la forma normal'
  );
  assert.equal(teaserMinimumQuantity({}), null);
  assert.equal(teaserMinimumQuantity(null), null);
  assert.equal(
    teaserMinimumQuantity({ Conditions: { MinimumQuantity: null } }),
    null
  );
});

test('teaserMinimumQuantity sobre el teaser real "2do al 70%" da 2', () => {
  const producto = withTeasers.find((p) => teaserName(teasersOf(p)[0]) === '2do al 70%');
  assert.ok(producto, 'el fixture debe traer un "2do al 70%"');
  assert.equal(teaserMinimumQuantity(teasersOf(producto)[0]), 2);
});

/* ------------------------------ toSampleProduct --------------------------- */

test('toSampleProduct incluye el ean (es la PK del catálogo)', () => {
  const producto = products[0];
  const sample = toSampleProduct(producto);

  assert.equal(sample.ean, producto.items[0].ean);
  assert.ok(sample.ean, 'el ean no puede ser vacío');
  assert.equal(sample.id, producto.productId);
  assert.equal(sample.name, producto.productName);
  assert.equal(sample.brand, producto.brand);
  assert.equal(typeof sample.price, 'number');
});

test('toSampleProduct: todos los productos del fixture aportan ean', () => {
  for (const producto of products) {
    const sample = toSampleProduct(producto);
    assert.ok(sample.ean, `producto ${producto.productId} sin ean en el sample`);
  }
});

test('toSampleProduct no explota con un producto vacío', () => {
  const sample = toSampleProduct({});
  assert.deepEqual(sample, {
    ean: null,
    id: null,
    name: null,
    brand: null,
    price: null,
    list_price: null,
  });
});

/* ----------------------------- collectPromotions -------------------------- */

test('collectPromotions agrupa por teaser y cuenta bien product_count', () => {
  const dosAlSetenta = byKey(withTeasers, 'teaser:2do al 70%');
  const tresXdos = byKey(withTeasers, 'teaser:3x2');
  const seisXcuatro = byKey(withTeasers, 'teaser:6x4');

  assert.ok(dosAlSetenta && tresXdos && seisXcuatro, 'las 3 promos de teaser');

  // 2 productos comparten el mismo teaser: deben colapsar en UNA promo con 2.
  assert.equal(dosAlSetenta.product_count, 2);
  assert.equal(tresXdos.product_count, 1);
  assert.equal(seisXcuatro.product_count, 1);

  assert.equal(dosAlSetenta.kind, 'teaser');
  assert.equal(dosAlSetenta.title, '2do al 70%');
  assert.equal(dosAlSetenta.minimum_quantity, 2);
  assert.equal(tresXdos.title, '3x2', 'el título va trimmeado');

  // El total de conteos debe igualar la cantidad de productos con teaser.
  const total = [dosAlSetenta, tresXdos, seisXcuatro].reduce(
    (acc, p) => acc + p.product_count,
    0
  );
  assert.equal(total, withTeasers.length);
});

test('collectPromotions acumula entre llamadas (páginas/colecciones)', () => {
  const acc = new Map();
  collectPromotions(withTeasers, acc);
  collectPromotions(withTeasers, acc);

  const dosAlSetenta = acc.get('teaser:2do al 70%');
  assert.equal(dosAlSetenta.product_count, 4, 'dos pasadas duplican el conteo');
  // sample_products está capado en 5.
  assert.ok(dosAlSetenta.sample_products.length <= 5);
});

test('collectPromotions cae a clusterHighlights SOLO si no hay teaser', () => {
  const todas = promosOf(products);

  // Los 4 productos con teaser TAMBIÉN traen clusterHighlights {"632": ...},
  // pero no deben sumar ahí: el cluster 632 sólo cuenta los 3 SIN teaser.
  const cluster632 = todas.find((p) => p.key === 'cluster:632');
  const cluster572 = todas.find((p) => p.key === 'cluster:572');

  const esperado632 = withoutTeasers.filter((p) => '632' in p.clusterHighlights).length;
  const esperado572 = withoutTeasers.filter((p) => '572' in p.clusterHighlights).length;

  assert.equal(esperado632, 3, 'control del fixture');
  assert.equal(esperado572, 4, 'control del fixture');

  assert.equal(cluster632.product_count, esperado632, 'los del teaser no cuentan acá');
  assert.equal(cluster572.product_count, esperado572);

  assert.equal(cluster632.kind, 'cluster');
  assert.equal(cluster632.cluster_id, '632');
  assert.equal(cluster632.title, 'Exclusivo Online');
  assert.equal(cluster632.minimum_quantity, null);

  // Y el reparto total: 4 promos (3 teasers + 2 clusters).
  assert.equal(todas.length, 5);
  assert.equal(todas.filter((p) => p.kind === 'teaser').length, 3);
  assert.equal(todas.filter((p) => p.kind === 'cluster').length, 2);
});

test('collectPromotions ignora productos sin teaser y sin clusterHighlights', () => {
  const acc = collectPromotions([{ productId: '1' }, { clusterHighlights: null }]);
  assert.equal(acc.size, 0);
});

test('un producto con un teaser cuenta en UNA sola promo, no en las dos vías', () => {
  const conTeaser = withTeasers[0];
  const todas = promosOf([conTeaser]);

  assert.equal(todas.length, 1);
  assert.equal(todas[0].kind, 'teaser');
  assert.ok(
    Object.keys(conTeaser.clusterHighlights).length > 0,
    'el producto SÍ tiene clusterHighlights (por eso el test tiene sentido)'
  );
});

/* ---------------------------- toPromotionContract ------------------------- */

test('toPromotionContract: prefijo dia-t- para teasers y dia-c- para clusters', () => {
  const todas = promosOf(products);

  const tresXdos = todas.find((p) => p.key === 'teaser:3x2');
  const dosAlSetenta = todas.find((p) => p.key === 'teaser:2do al 70%');
  const cluster632 = todas.find((p) => p.key === 'cluster:632');

  const cTres = toPromotionContract(tresXdos);
  const cDos = toPromotionContract(dosAlSetenta);
  const cCluster = toPromotionContract(cluster632);

  assert.equal(cTres.external_id, 'dia-t-3x2');
  assert.equal(cDos.external_id, 'dia-t-2do-al-70', 'el % se cae en el slug');
  assert.equal(cCluster.external_id, 'dia-c-632');

  assert.ok(cTres.external_id.startsWith('dia-t-'));
  assert.ok(cCluster.external_id.startsWith('dia-c-'));
});

test('toPromotionContract emite el contrato completo que consume DiaService', () => {
  const promo = promosOf(products).find((p) => p.key === 'teaser:2do al 70%');
  const contrato = toPromotionContract(promo);

  assert.equal(contrato.title, '2do al 70%');
  assert.equal(contrato.source, 'dia');
  assert.equal(contrato.promotion_kind, 'teaser');
  assert.equal(contrato.minimum_quantity, 2);
  assert.equal(contrato.product_count, 2);
  assert.equal(contrato.sample_products.length, 2);
  assert.ok(contrato.sample_products.every((s) => s.ean));
  // El catálogo no expone vigencia ni de colecciones ni de teasers.
  assert.equal(contrato.start_date, null);
  assert.equal(contrato.end_date, null);
  assert.ok(contrato.slug.length > 0);
});

test('los external_id de todas las promos del fixture son únicos', () => {
  const ids = promosOf(products).map((p) => toPromotionContract(p).external_id);
  assert.equal(new Set(ids).size, ids.length, `external_id duplicado en ${ids}`);
});
