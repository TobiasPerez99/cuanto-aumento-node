// scrapper-script/scraper-tests/coto-stores.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCotoStores } from '../scrapers/stores/coto_stores.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'fixtures/coto-sucursales.html'), 'utf8');

/**
 * Tests offline (no red) sobre el fixture real de https://www.coto.com.ar/sucursales/
 * (9 tablas: CABA + 8 regiones, 121 sucursales). Cubren especialmente la regla
 * crítica de padding de `external_reference` (ver coto_stores.js): la API de
 * precios de productos entrega el código de sucursal zero-padded a 3 dígitos
 * ("091", "060", "092", "220"), pero la tabla de /sucursales/ lo muestra sin
 * padding ("91", "60", "92", "220") — si el parser no lo normaliza, el
 * enriquecimiento por (merchant_id, external_reference) crea filas huérfanas
 * en vez de completar las que ya bootstrapeó saveCotoProduct.
 */

test('parsea al menos 100 sucursales del fixture', () => {
  const stores = parseCotoStores(html);
  assert.ok(stores.length >= 100, `esperaba >=100 sucursales, obtuve ${stores.length}`);
});

test('sucursal ABASTO: padding de codigo + campos del contrato', () => {
  const stores = parseCotoStores(html);
  const abasto = stores.find((s) => s.name === 'ABASTO');

  assert.ok(abasto, 'debe existir la sucursal ABASTO');
  assert.equal(abasto.external_reference, '091', 'el codigo "91" debe quedar zero-padded a "091"');
  assert.equal(abasto.name, 'ABASTO');
  assert.ok(abasto.address.includes('Agüero 616'), `address inesperada: ${abasto.address}`);
  assert.equal(abasto.phone, '4865-7515');
  assert.equal(abasto.store_type, 'physical');
  assert.equal(typeof abasto.opening_hours.lun_jue, 'string');
  assert.ok(abasto.opening_hours.lun_jue.length > 0, 'lun_jue no debe estar vacio');
  assert.equal(abasto.latitude, null);
});

test('todas las sucursales tienen external_reference zero-padded (>=3 digitos)', () => {
  const stores = parseCotoStores(html);
  assert.ok(stores.length > 0);
  for (const store of stores) {
    assert.match(
      store.external_reference,
      /^\d{3,}$/,
      `external_reference invalido: ${JSON.stringify(store.external_reference)} (sucursal ${store.name})`
    );
  }
});

test('codigos ya de 3 digitos quedan sin cambios (ej. "220")', () => {
  const stores = parseCotoStores(html);
  const barracas = stores.find((s) => s.name === 'BARRACAS');
  assert.ok(barracas, 'debe existir la sucursal BARRACAS');
  assert.equal(barracas.external_reference, '220');
});

test('longitude tambien es null (la fuente no trae coordenadas)', () => {
  const stores = parseCotoStores(html);
  for (const store of stores) {
    assert.equal(store.longitude, null);
  }
});
