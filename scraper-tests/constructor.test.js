// scrapper-script/scraper-tests/constructor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeConstructorItem, collectLeafGroupIds, scrapeConstructorMerchant } from '../cores/constructor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const item = JSON.parse(readFileSync(join(__dirname, 'fixtures/coto-item.json'), 'utf8'));

test('extrae EAN como string y campos básicos', () => {
  const p = normalizeConstructorItem(item);
  assert.equal(p.ean, '7790742363107');
  assert.equal(p.name, 'Leche Larga Vida Parcialmente Descremada Liviana 1% La Serenisima 1l');
  assert.equal(p.brand, 'LA SERENISIMA');
  assert.ok(p.image.includes('cotodigital'));
});

test('mapea precios por sucursal usando listPrice (el precio de venta)', () => {
  const p = normalizeConstructorItem(item);
  const s060 = p.storePrices.find((s) => s.code === '060');
  assert.equal(s060.price, 2300);
  assert.equal(s060.listPrice, 2300);
});

test('ignora formatPrice aunque sea absurdamente bajo', () => {
  const p = normalizeConstructorItem(item);
  const s133 = p.storePrices.find((s) => s.code === '133');
  // La sucursal 133 devuelve formatPrice 29.05 con listPrice 2495.
  assert.equal(s133.price, 2495);
});

/*
 * BUG-072 — `formatPrice` es el precio POR UNIDAD DE MEDIDA (por litro/kilo) que
 * exige exhibir la Ley 22.802, no el precio de venta. Los tres casos de abajo son
 * respuestas reales de la API de Coto.
 *
 * La fixture del resto de los tests es una leche de 1 L, el único envase donde
 * ambos campos coinciden: por eso el bug sobrevivió a la suite durante meses.
 */
const filaCoto = (listPrice, formatPrice) => ({
  value: 'Producto', data: { product_main_ean: 7790000000009, price: [{ store: '300', listPrice, formatPrice }] },
});

test('BUG-072: en envase chico formatPrice queda MUY por encima y no debe usarse', () => {
  // Coca-Cola 220 ml: 1100 el envase, 5000 el litro.
  const p = normalizeConstructorItem(filaCoto(1100, 5000));
  assert.equal(p.storePrices[0].price, 1100);
});

test('BUG-072: en envase grande formatPrice queda por DEBAJO y tampoco debe usarse', () => {
  // Coca-Cola 2,25 L: 4845 el envase, 2153.33 el litro. Este caso es el peligroso:
  // usar formatPrice hacía que la app recomendara comprar a un precio inexistente.
  const p = normalizeConstructorItem(filaCoto(4845, 2153.33));
  assert.equal(p.storePrices[0].price, 4845);
});

test('BUG-072: enjuague de 250 ml — el caso testigo del reporte', () => {
  const p = normalizeConstructorItem(filaCoto(6275.99, 25103.96));
  assert.equal(p.storePrices[0].price, 6275.99);
});

test('sin listPrice cae a formatPrice, pero no lo reporta como precio de lista', () => {
  const p = normalizeConstructorItem(filaCoto(null, 1800));
  assert.equal(p.storePrices[0].price, 1800);
  assert.equal(p.storePrices[0].listPrice, null);
});

test('el mínimo entre sucursales es 2300, NO 29.05', () => {
  const p = normalizeConstructorItem(item);
  const min = Math.min(...p.storePrices.map((s) => s.price));
  assert.equal(min, 2300);
});

test('sin EAN devuelve null', () => {
  const noEan = { value: 'x', data: { price: [] } };
  assert.equal(normalizeConstructorItem(noEan), null);
});

test('collectLeafGroupIds recorre el árbol hasta las hojas (un nivel por respuesta)', async () => {
  // La API real de Constructor.io anida `children` un solo nivel: para
  // descubrir los hijos de una categoría hay que hacer browse de ESA
  // categoría. El fake modela eso: cada group_id devuelve solo sus hijos
  // directos (sin nietos).
  const tree = { root: ['A', 'B'], A: [], B: ['B1'], B1: [] };
  const fakeGet = async (url) => {
    const gid = decodeURIComponent(url.match(/group_id\/([^?]+)/)[1]);
    const children = (tree[gid] || []).map((id) => ({ group_id: id }));
    return { data: { response: { total_num_results: 0, results: [], groups: [{ group_id: gid, children }] } } };
  };
  const leaves = await collectLeafGroupIds('root', fakeGet);
  assert.deepEqual(leaves.sort(), ['A', 'B1']);
});

test('scrapeConstructorMerchant pagina y llama onProductFound por producto único', async () => {
  const item = JSON.parse(readFileSync(join(__dirname, 'fixtures/coto-item.json'), 'utf8'));
  const item2 = JSON.parse(JSON.stringify(item));
  item2.data.product_main_ean = 7790000000001;

  const fakeGet = async (url) => {
    const u = new URL(url);
    const perPage = Number(u.searchParams.get('num_results_per_page'));
    if (perPage === 1) {
      // llamada del árbol (collectLeafGroupIds usa perPage=1): root sin hijos
      // → es su propia hoja
      return { data: { response: { total_num_results: 2, results: [], groups: [{ group_id: 'root', children: [] }] } } };
    }
    // paginación de la hoja 'root': page 1 devuelve 2 items, page 2 vacío
    const page = Number(u.searchParams.get('page'));
    const results = page === 1 ? [item, item2] : [];
    return { data: { response: { total_num_results: 2, results } } };
  };

  const saved = [];
  const res = await scrapeConstructorMerchant({
    merchantName: 'Coto',
    rootGroupId: 'root',
    perPage: 200,
    httpGet: fakeGet,
    merchantId: 999,
    onProductFound: async (p) => { saved.push(p.ean); return { saved: true }; },
  });

  assert.equal(res.success, true);
  assert.deepEqual(saved.sort(), ['7790000000001', '7790742363107']);
});
