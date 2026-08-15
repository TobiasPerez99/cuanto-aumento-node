// scrapper-script/scraper-tests/santander-promos.test.js
//
// Tests unitarios de la parte PURA del scraper de Santander (normalización).
// No pegan a la red: usan el fixture santander-brand.json (snapshot real del
// BFF /bff-benefits, 2026-08-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeSantanderPublication,
  daysFromPublication,
  stripHtml,
  toIsoDate,
} from '../scrapers/promos/santander.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/santander-brand.json'), 'utf8')
);

const brand = fixture.brand;
const [pubAhorro, pubCuotas] = fixture.detail.items;

test('normaliza una publicación de ahorro al contrato PULL', () => {
  const p = normalizeSantanderPublication(brand, pubAhorro);

  assert.equal(p.external_id, 'san-7476');
  assert.equal(p.banco, 'Santander');
  assert.equal(p.marca, 'Coto');
  assert.equal(p.nombre, 'Coto: 30% de ahorro');
  assert.equal(p.descuento_porcentaje, 30);
  assert.equal(p.cuotas_sin_interes, null);
  assert.deepEqual(p.dias, ['jueves']);
  assert.equal(p.start_date, '2026-07-16');
  assert.equal(p.end_date, '2026-08-27');
  assert.equal(p.medio_pago, 'Contactless');
  assert.ok(p.url_promo.endsWith('brandId=131'));
  assert.equal(p.imagen, brand.desktopImage);
});

test('el HTML de condiciones/legales llega limpio (sin tags ni entidades)', () => {
  const p = normalizeSantanderPublication(brand, pubAhorro);
  assert.ok(!p.condiciones.includes('<'), 'condiciones sin tags');
  assert.ok(p.condiciones.includes('NFC'));
  assert.ok(p.condiciones.includes('Apple Pay'));
  assert.ok(!p.legales.includes('<p>'), 'legales sin tags');
});

test('publicación de cuotas sin interés: fullWeek => 7 días y cuotas del finalQuote', () => {
  const p = normalizeSantanderPublication(brand, pubCuotas);

  assert.equal(p.external_id, 'san-7481');
  assert.equal(p.nombre, 'Coto: 12 cuotas sin interés');
  assert.equal(p.descuento_porcentaje, null);
  assert.equal(p.cuotas_sin_interes, 12);
  assert.equal(p.tope_reintegro, 25000);
  assert.equal(p.dias.length, 7);
  assert.equal(p.metodo_pago, 'Visa');
});

test('daysFromPublication: sin flags y sin fullWeek significa "todos los días"', () => {
  assert.equal(daysFromPublication({}).length, 7);
  assert.deepEqual(daysFromPublication({ monday: true, friday: true }), ['lunes', 'viernes']);
});

test('stripHtml decodifica entidades y colapsa espacios', () => {
  assert.equal(stripHtml('<p>a &amp; b</p><p>c</p>'), 'a & b c');
  assert.equal(stripHtml(''), null);
  assert.equal(stripHtml(null), null);
});

test('toIsoDate recorta el timestamp del BFF a fecha ISO', () => {
  assert.equal(toIsoDate('2026-07-16T00:00:00'), '2026-07-16');
  assert.equal(toIsoDate('garbage'), null);
  assert.equal(toIsoDate(null), null);
});

test('publicación inválida (sin id) devuelve null', () => {
  assert.equal(normalizeSantanderPublication(brand, null), null);
  assert.equal(normalizeSantanderPublication(brand, {}), null);
  assert.equal(normalizeSantanderPublication(null, pubAhorro), null);
});
