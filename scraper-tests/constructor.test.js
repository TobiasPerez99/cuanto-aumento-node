// scrapper-script/scraper-tests/constructor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeConstructorItem } from '../cores/constructor.js';

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

test('el mínimo entre sucursales es 2300, NO 29.05', () => {
  const p = normalizeConstructorItem(item);
  const min = Math.min(...p.storePrices.map((s) => s.price));
  assert.equal(min, 2300);
});

test('sin EAN devuelve null', () => {
  const noEan = { value: 'x', data: { price: [] } };
  assert.equal(normalizeConstructorItem(noEan), null);
});
