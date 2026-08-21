// scrapper-script/scraper-tests/dia-stores.test.js
//
// Tests unitarios de la parte PURA del scraper de sucursales de Dia
// (normalización). No pegan a la red ni levantan Chromium: usan el fixture
// dia-stores-masterdata.json, un recorte real del Master Data (entidad "TI")
// que alimenta https://diaonline.supermercadosdia.com.ar/tiendas.
//
// El fixture son 18 de los ~1000 registros, elegidos para cubrir los casos que
// importan: 12 activos con geo válida repartidos en 6 provincias, 2 con
// geo="0" (el marcador de "sin coordenadas"), 4 inactivos y 2 con
// bajaTemporal=true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseDiaGeo,
  normalizeDiaStore,
  normalizeDiaStores,
} from '../scrapers/stores/dia_stores.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/dia-stores-masterdata.json'), 'utf8')
);

/**
 * ⚠️ EL test del archivo. El Master Data serializa `geo` como
 * "longitud,latitud" — longitud PRIMERO, al revés que la entidad NT de Jumbo.
 * Leerlo como [lat,lon] manda las ~970 sucursales al Océano Índico y el
 * "más cercana" queda inservible sin fallar ruidosamente en ningún lado.
 */
test('parseDiaGeo lee "lon,lat" en el orden correcto (NO al revés)', () => {
  const geo = parseDiaGeo('-58.379245,-34.64908');

  assert.equal(geo.latitude, -34.64908, 'la latitud es el SEGUNDO valor');
  assert.equal(geo.longitude, -58.379245, 'la longitud es el PRIMER valor');
});

test('parseDiaGeo: "0", null, "" y undefined no tienen coordenadas', () => {
  const vacio = { latitude: null, longitude: null };

  assert.deepEqual(parseDiaGeo('0'), vacio, 'geo="0" es el marcador de baja');
  assert.deepEqual(parseDiaGeo(null), vacio);
  assert.deepEqual(parseDiaGeo(''), vacio);
  assert.deepEqual(parseDiaGeo(undefined), vacio);
  assert.deepEqual(parseDiaGeo(123), vacio, 'un no-string tampoco explota');
});

test('parseDiaGeo tolera espacios alrededor de los valores', () => {
  assert.deepEqual(parseDiaGeo(' -58.5 , -34.6 '), {
    latitude: -34.6,
    longitude: -58.5,
  });
});

test('el registro real de Av General Iriarte 2295 mantiene el orden lon,lat', () => {
  const iriarte = records.find((r) => r.name === 'Av General Iriarte 2295');
  assert.ok(iriarte, 'el fixture debe traer la sucursal Av General Iriarte 2295');
  assert.equal(iriarte.geo, '-58.379245,-34.64908');

  const store = normalizeDiaStore(iriarte);

  assert.equal(store.latitude, -34.64908);
  assert.equal(store.longitude, -58.379245);
  assert.equal(store.external_reference, iriarte.id);
  assert.equal(store.province, 'Capital Federal');
  // El Master Data no expone estos campos en la entidad TI.
  assert.equal(store.postal_code, null);
  assert.equal(store.phone, null);
});

test('normalizeDiaStores descarta inactivos y bajaTemporal', () => {
  const stores = normalizeDiaStores(records);

  const activos = records.filter((r) => r.active === true && r.bajaTemporal !== true);
  assert.equal(stores.length, activos.length);
  assert.equal(stores.length, 12, 'el fixture tiene 12 sucursales operativas');

  // Ningún id de un registro descartado puede aparecer en el resultado.
  const idsResultado = new Set(stores.map((s) => s.external_reference));

  for (const r of records.filter((r) => r.active === false)) {
    assert.ok(!idsResultado.has(r.id), `sucursal inactiva no descartada: ${r.name}`);
  }

  for (const r of records.filter((r) => r.bajaTemporal === true)) {
    assert.ok(!idsResultado.has(r.id), `sucursal de baja temporal no descartada: ${r.name}`);
  }
});

test('normalizeDiaStores descarta los registros sin coordenadas', () => {
  // En el dataset real ningún registro activo viene con geo="0" (los 26 que la
  // tienen ya están dados de baja), así que el filtro por coordenadas se ejerce
  // partiendo de un registro REAL y anulándole sólo el campo `geo`.
  const real = records.find((r) => r.active === true && r.bajaTemporal !== true);
  assert.ok(real, 'el fixture debe traer al menos una sucursal operativa');

  const sinGeo = { ...real, id: 'sin-geo-test', geo: '0' };
  const sinId = { ...real, id: null };

  const stores = normalizeDiaStores([...records, sinGeo, sinId]);

  assert.equal(stores.length, 12, 'los dos registros inválidos no deben sumar');
  assert.ok(!stores.some((s) => s.external_reference === 'sin-geo-test'));
});

test('normalizeDiaStores no explota con entradas no-array', () => {
  assert.deepEqual(normalizeDiaStores(null), []);
  assert.deepEqual(normalizeDiaStores(undefined), []);
  assert.deepEqual(normalizeDiaStores({}), []);
  assert.deepEqual(normalizeDiaStores([null, undefined]), []);
});

test('todas las sucursales resultantes tienen external_reference no vacío', () => {
  const stores = normalizeDiaStores(records);
  assert.ok(stores.length > 0);

  for (const store of stores) {
    assert.equal(typeof store.external_reference, 'string');
    assert.ok(
      store.external_reference.length > 0,
      `external_reference vacío en ${store.name}`
    );
  }

  // Además debe ser único: StoreSyncService upsertea por (merchant, ref).
  const refs = stores.map((s) => s.external_reference);
  assert.equal(new Set(refs).size, refs.length, 'external_reference duplicado');
});

/**
 * Red de seguridad contra la inversión lon/lat: si alguien da vuelta el parseo,
 * las coordenadas caen fuera del país y este test se pone rojo.
 */
test('las coordenadas caen dentro del bounding box de Argentina', () => {
  const stores = normalizeDiaStores(records);
  assert.ok(stores.length > 0);

  for (const store of stores) {
    assert.ok(
      store.latitude >= -55 && store.latitude <= -21,
      `latitud fuera de Argentina: ${store.latitude} (${store.name})`
    );
    assert.ok(
      store.longitude >= -74 && store.longitude <= -53,
      `longitud fuera de Argentina: ${store.longitude} (${store.name})`
    );
  }
});

test('el fixture cubre varias provincias y todas llegan al resultado', () => {
  const stores = normalizeDiaStores(records);
  const provincias = new Set(stores.map((s) => s.province));

  assert.ok(provincias.size >= 4, `esperaba >=4 provincias, hubo ${provincias.size}`);
  assert.ok(provincias.has('Capital Federal'));
  assert.ok(provincias.has('Buenos Aires'));
});
