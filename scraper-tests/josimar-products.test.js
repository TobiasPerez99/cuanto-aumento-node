// scrapper-script/scraper-tests/josimar-products.test.js
//
// Tests unitarios de la parte PURA del scraper de productos de Josimar
// (normalización + parseo del header de paginación). No pegan a la red: usan
// josimar-products.json, 6 productos reales del Catalog System
// (GET /api/catalog_system/pub/products/search?fq=C:/{id}/), recortados a los
// campos que el normalizador lee.
//
// Los 6 están elegidos para cubrir lo que importa:
//   - Tomate Perita: Price 2850 < PriceWithoutDiscount 5300 (producto con descuento)
//   - Tomate Perita y Limón: unitMultiplier 0.5 en kg (precio de referencia)
//   - Pelón Blanco: IsAvailable false / AvailableQuantity 0
//   - tres tapas de tarta: el caso normal (un SKU, un EAN, precio plano)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseResourcesTotal,
  topLevelCategories,
  normalizeJosimarProduct,
  normalizeJosimarProducts,
} from '../scrapers/josimar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/josimar-products.json'), 'utf8')
);

const byEan = (ean) => records.find((p) => p.items[0].ean === ean);

/* --------------------------------- fixture -------------------------------- */

test('el fixture cubre los casos que importan', () => {
  assert.equal(records.length, 6);

  const conDescuento = records.filter((p) => {
    const o = p.items[0].sellers[0].commertialOffer;
    return o.PriceWithoutDiscount > o.Price;
  });
  assert.equal(conDescuento.length, 1, '1 producto con descuento');

  assert.equal(
    records.filter((p) => p.items[0].unitMultiplier !== 1).length,
    2,
    '2 productos vendidos por peso (unitMultiplier 0.5)'
  );

  assert.equal(
    records.filter((p) => p.items[0].sellers[0].commertialOffer.IsAvailable === false).length,
    1,
    '1 producto sin stock'
  );

  // Un SKU por producto y EAN en el 100% del catálogo: los dos supuestos
  // sobre los que se apoya el scraper.
  assert.ok(records.every((p) => p.items.length === 1));
  assert.ok(records.every((p) => typeof p.items[0].ean === 'string' && p.items[0].ean.length > 0));
});

/* ---------------------------- parseResourcesTotal ------------------------- */

/**
 * El total de una categoría no viene en el body sino en el header `resources`
 * ("0-49/2260"). Es lo que decide cuántas páginas pedir y si hay que bajar a
 * las subcategorías por el tope de _from=2500.
 */
test('parseResourcesTotal lee el total del header de VTEX', () => {
  assert.equal(parseResourcesTotal('0-49/2260'), 2260);
  assert.equal(parseResourcesTotal('0-0/61'), 61);
  assert.equal(parseResourcesTotal('2450-2499/5691'), 5691);
  assert.equal(parseResourcesTotal('0-0/0'), 0);
  assert.equal(parseResourcesTotal('0-49/2260 '), 2260, 'tolera espacio al final');
});

test('parseResourcesTotal nunca inventa un total', () => {
  assert.equal(parseResourcesTotal(null), null);
  assert.equal(parseResourcesTotal(undefined), null);
  assert.equal(parseResourcesTotal(''), null);
  assert.equal(parseResourcesTotal('0-49'), null, 'sin barra no hay total');
  assert.equal(parseResourcesTotal('muchos'), null);
  assert.equal(parseResourcesTotal(2260), null, 'un número no es el header');
});

/* ----------------------------- topLevelCategories ------------------------- */

test('topLevelCategories normaliza el árbol y conserva los hijos', () => {
  const tree = [
    { id: 1, name: 'Almacen', children: [{ id: 2, name: 'Aceites', children: [] }] },
    { id: 79, name: 'Bebidas', children: [] },
    { id: null, name: 'Rota' },
  ];

  const nodes = topLevelCategories(tree);

  assert.equal(nodes.length, 2, 'el nodo sin id se descarta');
  assert.deepEqual(nodes[0], {
    id: '1',
    name: 'Almacen',
    children: [{ id: 2, name: 'Aceites', children: [] }],
  });
  assert.equal(typeof nodes[1].id, 'string', 'el id viaja como string');
  assert.deepEqual(nodes[1].children, []);
});

test('topLevelCategories no explota con entradas no-array', () => {
  assert.deepEqual(topLevelCategories(null), []);
  assert.deepEqual(topLevelCategories(undefined), []);
  assert.deepEqual(topLevelCategories({}), []);
});

/* -------------------------- normalizeJosimarProduct ----------------------- */

test('normalizeJosimarProduct emite el contrato completo', () => {
  const p = normalizeJosimarProduct(byEan('7798105510168'));

  assert.equal(p.ean, '7798105510168');
  assert.equal(p.source, 'josimar');
  assert.equal(p.name, 'Tapa Pascualina Hojaldre Delicias Doradas 400 gr');
  assert.equal(p.brand, 'Delicias Doradas');
  assert.equal(p.price, 2500);
  assert.equal(p.list_price, 2500);
  assert.equal(p.reference_unit, 'un');
  assert.equal(p.reference_price, 2500, 'unitMultiplier 1 ⇒ igual al precio');
  assert.equal(p.is_available, true);
  assert.equal(p.unavailable, false);
  assert.equal(typeof p.external_id, 'string');
  assert.match(p.link, /^https:\/\/www\.josimar\.com\.ar\//);
  assert.ok(p.image.startsWith('https://'));
  assert.ok(Array.isArray(p.images) && p.images.length > 0);
  assert.ok(Array.isArray(p.categories) && p.categories.length > 0);
});

/**
 * ⚠️ El precio "tachado" es `PriceWithoutDiscount`, NUNCA `ListPrice`: en VTEX
 * ese campo viene con un multiplicador erróneo (documentado en el CLAUDE.md
 * del scraper). En Josimar hoy los dos coinciden, así que el test lo fija
 * sobre el producto con descuento real y con un caso construido donde difieren.
 */
test('normalizeJosimarProduct usa PriceWithoutDiscount como precio de lista', () => {
  const tomate = normalizeJosimarProduct(byEan('2304332000000'));

  assert.equal(tomate.price, 2850, 'el precio de venta');
  assert.equal(tomate.list_price, 5300, 'el tachado');
  assert.ok(tomate.list_price > tomate.price);

  // Con un ListPrice inflado (el bug de VTEX), el normalizador lo ignora.
  const conListPriceRoto = JSON.parse(JSON.stringify(byEan('7798105510168')));
  conListPriceRoto.items[0].sellers[0].commertialOffer.ListPrice = 205000;

  assert.equal(normalizeJosimarProduct(conListPriceRoto).list_price, 2500);
});

test('normalizeJosimarProduct calcula el precio de referencia con unitMultiplier', () => {
  const tomate = normalizeJosimarProduct(byEan('2304332000000'));

  // Tomate Perita 500 gr: $2850 el paquete, unitMultiplier 0.5 kg ⇒ $5700 el kilo.
  assert.equal(tomate.reference_unit, 'kg');
  assert.equal(tomate.reference_price, 5700);

  const limon = normalizeJosimarProduct(byEan('2304561000000'));
  assert.equal(limon.reference_price, 3400, '$1700 / 0.5 kg');
});

test('normalizeJosimarProduct respeta IsAvailable', () => {
  const pelon = normalizeJosimarProduct(byEan('2004789000000'));

  assert.equal(pelon.is_available, false);
  assert.equal(pelon.unavailable, true);
  // Un producto sin stock igual se emite: el precio sigue siendo información
  // válida y `merchant_products.is_available` es justamente el campo que lo dice.
  assert.equal(pelon.price, 320);
});

test('normalizeJosimarProduct cae a AvailableQuantity si falta el flag', () => {
  const raw = JSON.parse(JSON.stringify(byEan('7798105510168')));
  delete raw.items[0].sellers[0].commertialOffer.IsAvailable;

  raw.items[0].sellers[0].commertialOffer.AvailableQuantity = 0;
  assert.equal(normalizeJosimarProduct(raw).is_available, false);

  raw.items[0].sellers[0].commertialOffer.AvailableQuantity = 7;
  assert.equal(normalizeJosimarProduct(raw).is_available, true);
});

/**
 * ⚠️ Sin EAN el producto no se puede cruzar con el maestro (`products.ean` es
 * la PK del catálogo de Ahorrapp), así que se descarta — mismo criterio que
 * `normalizeProduct()` de `cores/vtex.js`.
 */
test('normalizeJosimarProduct descarta lo que no tiene EAN', () => {
  const sinEan = JSON.parse(JSON.stringify(byEan('7798105510168')));
  sinEan.items[0].ean = '';
  assert.equal(normalizeJosimarProduct(sinEan), null);

  sinEan.items[0].ean = null;
  assert.equal(normalizeJosimarProduct(sinEan), null);

  delete sinEan.items[0].ean;
  assert.equal(normalizeJosimarProduct(sinEan), null);
});

/**
 * ⚠️ Un precio 0/null escrito en `merchant_products` pondría a Josimar como
 * "el más barato" de todo el comparador. Un producto menos es mucho mejor que
 * un precio falso.
 */
test('normalizeJosimarProduct descarta lo que no tiene precio positivo', () => {
  const base = () => JSON.parse(JSON.stringify(byEan('7798105510168')));

  for (const price of [0, -1, null, undefined, 'gratis', NaN]) {
    const raw = base();
    raw.items[0].sellers[0].commertialOffer.Price = price;
    assert.equal(
      normalizeJosimarProduct(raw),
      null,
      `debería descartar Price=${JSON.stringify(price)}`
    );
  }

  const sinSeller = base();
  sinSeller.items[0].sellers = [];
  assert.equal(normalizeJosimarProduct(sinSeller), null);
});

/**
 * A diferencia del core, no se exige imagen: Josimar es FOLLOWER y
 * `saveFollowerProduct` sólo escribe precio/disponibilidad/URL — la metadata la
 * tiene el maestro (Disco). Descartar por falta de imagen tiraría un precio válido.
 */
test('normalizeJosimarProduct NO descarta por falta de imagen (es follower)', () => {
  const raw = JSON.parse(JSON.stringify(byEan('7798105510168')));
  raw.items[0].images = [];

  const p = normalizeJosimarProduct(raw);

  assert.ok(p, 'el producto sobrevive sin imagen');
  assert.equal(p.image, null);
  assert.deepEqual(p.images, []);
  assert.equal(p.price, 2500, 'que es lo único que le importa a un follower');
});

test('normalizeJosimarProduct resuelve el link por linkText si falta el absoluto', () => {
  const raw = JSON.parse(JSON.stringify(byEan('7798105510168')));
  delete raw.link;

  assert.equal(
    normalizeJosimarProduct(raw).link,
    `https://www.josimar.com.ar/${raw.linkText}/p`
  );

  delete raw.linkText;
  assert.equal(normalizeJosimarProduct(raw).link, null, 'nunca inventa una URL');
});

test('normalizeJosimarProduct prefiere el seller por defecto', () => {
  const raw = JSON.parse(JSON.stringify(byEan('7798105510168')));
  const original = raw.items[0].sellers[0];

  raw.items[0].sellers = [
    { ...original, sellerId: '2', sellerDefault: false, commertialOffer: { ...original.commertialOffer, Price: 9999 } },
    { ...original, sellerDefault: true },
  ];

  assert.equal(normalizeJosimarProduct(raw).price, 2500);
});

test('normalizeJosimarProduct no explota con basura', () => {
  assert.equal(normalizeJosimarProduct(null), null);
  assert.equal(normalizeJosimarProduct(undefined), null);
  assert.equal(normalizeJosimarProduct({}), null);
  assert.equal(normalizeJosimarProduct({ items: [] }), null);
  assert.equal(normalizeJosimarProduct({ items: [{}] }), null);
});

/* -------------------------- normalizeJosimarProducts ---------------------- */

test('normalizeJosimarProducts normaliza el lote completo del fixture', () => {
  const products = normalizeJosimarProducts(records);

  assert.equal(products.length, 6, 'los 6 del fixture pasan el filtro');
  assert.ok(products.every((p) => p.ean && p.price > 0));
  assert.ok(products.every((p) => p.source === 'josimar'));

  const eans = products.map((p) => p.ean);
  assert.equal(new Set(eans).size, eans.length, 'EAN duplicado en el lote');
});

test('normalizeJosimarProducts filtra los descartados sin dejar huecos', () => {
  const roto = { productId: '1', items: [{ ean: null }] };
  const products = normalizeJosimarProducts([...records, roto, null, {}]);

  assert.equal(products.length, 6);
  assert.ok(products.every((p) => p !== null));
});

test('normalizeJosimarProducts no explota con entradas no-array', () => {
  assert.deepEqual(normalizeJosimarProducts(null), []);
  assert.deepEqual(normalizeJosimarProducts(undefined), []);
  assert.deepEqual(normalizeJosimarProducts({}), []);
});
