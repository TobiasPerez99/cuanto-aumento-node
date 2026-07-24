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

test('mapea precios por sucursal usando formatPrice', () => {
  const p = normalizeConstructorItem(item);
  const s060 = p.storePrices.find((s) => s.code === '060');
  assert.equal(s060.price, 2300);
  assert.equal(s060.listPrice, 2300);
});

test('guard anti-anomalía: formatPrice basura cae a listPrice', () => {
  const p = normalizeConstructorItem(item);
  const s133 = p.storePrices.find((s) => s.code === '133');
  // formatPrice 29.05 es basura frente a listPrice 2495 → se usa listPrice.
  assert.equal(s133.price, 2495);
});

test('un descuento legítimo (formatPrice = 50% del listPrice) se conserva, no se clobbea', () => {
  const item = { value: 'Producto en oferta', data: { product_main_ean: 7790000000009, price: [
    { store: '300', listPrice: 2000, formatPrice: 1000 }, // 50% off — descuento real
  ] } };
  const p = normalizeConstructorItem(item);
  const s = p.storePrices.find((x) => x.code === '300');
  assert.equal(s.price, 1000);      // formatPrice conservado (no cae a listPrice)
  assert.equal(s.listPrice, 2000);
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
