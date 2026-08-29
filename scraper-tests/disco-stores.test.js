// scrapper-script/scraper-tests/disco-stores.test.js
//
// Tests unitarios de la parte PURA del scraper de sucursales de Disco
// (normalización). No pegan a la red: usan el fixture
// disco-stores-masterdata.json, un recorte real del VTEX Master Data
// (entidad "NT", an=discoargentina).
//
// El fixture son 16 de los 76 registros, elegidos para cubrir los casos que
// importan: 13 activos en las 4 provincias y 8 regiones comerciales del
// dataset, 3 inactivos, los tres formatos de `postalCode` que conviven
// ("7605" numérico, "C1181ACK" y "c1430eph" alfanuméricos), 3 sucursales que
// COMPARTEN `SellerName` ("jumboargentinad028") y la única dirección del
// dataset que no permite derivar la ciudad ("Ruta 11 km 380 - Costa
// Esmeralda", 2 segmentos, que además viene sin teléfono y con espacio
// después de la coma en geocoordinates).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseDiscoGeo,
  parseDiscoCity,
  normalizeDiscoStore,
  normalizeDiscoStores,
} from '../scrapers/stores/disco_stores.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/disco-stores-masterdata.json'), 'utf8')
);

const byName = (name) => records.find((r) => r.name === name);

/* --------------------------------- fixture -------------------------------- */

test('el fixture cubre los casos que importan', () => {
  assert.equal(records.length, 16);
  assert.equal(records.filter((r) => r.isActive === true).length, 13, '13 activos');
  assert.equal(records.filter((r) => r.isActive !== true).length, 3, '3 inactivos');

  // Una dirección que NO permite derivar ciudad (2 segmentos).
  const sinCiudad = records.filter(
    (r) => String(r.address).split(' - ').map((s) => s.trim()).filter(Boolean).length < 3
  );
  assert.equal(sinCiudad.length, 1);
  assert.equal(sinCiudad[0].name, 'Disco Costa Esmeralda');
});

/* ------------------------------- parseDiscoGeo ---------------------------- */

/**
 * ⚠️ EL test del archivo. La entidad NT serializa `geocoordinates` como
 * "latitud,longitud" — latitud PRIMERO, igual que Jumbo y al REVÉS que el campo
 * `geo` de la entidad TI de Dia. Leerlo como [lon,lat] manda las 71 sucursales
 * al Océano Índico sin fallar ruidosamente en ningún lado.
 */
test('parseDiscoGeo lee "lat,lon" en el orden correcto (NO al revés)', () => {
  const geo = parseDiscoGeo('-37.9600017000000,-57.5668298000000');

  assert.equal(geo.latitude, -37.9600017, 'la latitud es el PRIMER valor');
  assert.equal(geo.longitude, -57.5668298, 'la longitud es el SEGUNDO valor');
});

test('parseDiscoGeo tolera el espacio después de la coma', () => {
  // Forma real de "Disco Costa Esmeralda" en el dataset.
  assert.deepEqual(parseDiscoGeo('-37.02565468014194, -56.805006218500054'), {
    latitude: -37.02565468014194,
    longitude: -56.805006218500054,
  });
});

test('parseDiscoGeo devuelve nulls ante valores no parseables', () => {
  const vacio = { latitude: null, longitude: null };

  assert.deepEqual(parseDiscoGeo(null), vacio);
  assert.deepEqual(parseDiscoGeo(undefined), vacio);
  assert.deepEqual(parseDiscoGeo(''), vacio);
  assert.deepEqual(parseDiscoGeo('0'), vacio, 'sin coma no hay par de coordenadas');
  assert.deepEqual(parseDiscoGeo(123), vacio, 'un no-string tampoco explota');
  assert.deepEqual(parseDiscoGeo('foo,bar'), vacio, 'texto no numérico → null, no NaN');
});

/**
 * Red de seguridad contra la inversión lat/lon: si alguien da vuelta el parseo,
 * las coordenadas caen fuera del país y este test se pone rojo.
 * Medición sobre el dataset completo: 76/76 dentro leyendo [lat,lon], 0/76
 * leyendo [lon,lat].
 */
test('las coordenadas caen dentro del bounding box de Argentina', () => {
  const stores = normalizeDiscoStores(records);
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

/* ------------------------------ parseDiscoCity ---------------------------- */

test('parseDiscoCity toma el PENÚLTIMO segmento de "CALLE - CP - CIUDAD - PROVINCIA"', () => {
  assert.equal(
    parseDiscoCity('AVENIDA CONSTITUCION 6069  - 7605 - MAR DEL PLATA - BUENOS AIRES'),
    'MAR DEL PLATA'
  );
  assert.equal(
    parseDiscoCity('CUBA 1714  - C1426BFB - CIUDAD AUTONOMA BUENOS AIRES - CAPITAL FEDERAL'),
    'CIUDAD AUTONOMA BUENOS AIRES'
  );
});

/**
 * La dirección corta NO se adivina. "Ruta 11 km 380 - Costa Esmeralda" tiene
 * sólo 2 segmentos: tomar el penúltimo devolvería la CALLE como ciudad, así que
 * se emite null. Un hueco explícito es mejor que un dato inventado.
 */
test('parseDiscoCity devuelve null cuando la dirección no alcanza a tener ciudad', () => {
  assert.equal(parseDiscoCity('Ruta 11 km 380 - Costa Esmeralda'), null);
  assert.equal(parseDiscoCity('AVENIDA SIEMPREVIVA 742'), null);
  assert.equal(parseDiscoCity(''), null);
  assert.equal(parseDiscoCity(null), null);
  assert.equal(parseDiscoCity(undefined), null);
  assert.equal(parseDiscoCity(42), null);
});

/* ---------------------------- normalizeDiscoStore ------------------------- */

test('el registro real de Av Constitucion 6069 se mapea al contrato completo', () => {
  const raw = byName('Disco Av Constitucion 6069');
  assert.ok(raw, 'el fixture debe traer Disco Av Constitucion 6069');

  const store = normalizeDiscoStore(raw);

  assert.equal(store.external_reference, '55cc798c-0133-11ec-82ac-0ac17ffb3dd1');
  assert.equal(store.name, 'Disco Av Constitucion 6069');
  assert.equal(
    store.address,
    'AVENIDA CONSTITUCION 6069  - 7605 - MAR DEL PLATA - BUENOS AIRES'
  );
  assert.equal(store.city, 'MAR DEL PLATA', 'la ciudad sale del penúltimo segmento');
  assert.equal(store.province, 'BUENOS AIRES', 'la provincia sale de `state`');
  assert.equal(store.postal_code, '7605');
  assert.equal(store.latitude, -37.9600017);
  assert.equal(store.longitude, -57.5668298);
  assert.equal(store.phone, '2234790305');
  assert.equal(
    store.opening_hours,
    'Atención: Lunes a Sábados de  8:30 a 21 hs. Domingos y Feriados 9 a 21 hs'
  );

  // El contrato de StoreSyncService no incluye grouping/SellerName/hasPickup.
  assert.deepEqual(Object.keys(store).sort(), [
    'address',
    'city',
    'external_reference',
    'latitude',
    'longitude',
    'name',
    'opening_hours',
    'phone',
    'postal_code',
    'province',
  ]);
});

/**
 * ⚠️ `postalCode` es inconsistente entre filas: numérico en unas, alfanumérico
 * (y con mayúsculas mezcladas) en otras. Va como string tal cual — un Number()
 * sobre "C1181ACK" daría NaN y perdería el dato.
 */
test('postal_code viaja como string tal cual, sea numérico o alfanumérico', () => {
  assert.equal(normalizeDiscoStore(byName('Disco Av Constitucion 6069')).postal_code, '7605');
  assert.equal(normalizeDiscoStore(byName('Disco Gascon 649')).postal_code, 'C1181ACK');
  assert.equal(
    normalizeDiscoStore(byName('Disco Naon 2142')).postal_code,
    'c1430eph',
    'no se normaliza a mayúsculas: se preserva la fuente'
  );
});

/**
 * ⚠️ `state` y la provincia escrita en `address` discrepan en 15/76 registros.
 * Se elige `state` (campo estructurado) y se preserva `address` entera para
 * poder auditar la discrepancia. Este test fija esa decisión.
 */
test('province sale de `state`, aunque la dirección diga otra cosa', () => {
  const raw = byName('Disco Las Heras 3925');
  assert.ok(raw.address.endsWith('CAPITAL FEDERAL'), 'la dirección dice CAPITAL FEDERAL');
  assert.equal(raw.state, 'BUENOS AIRES', 'pero `state` dice BUENOS AIRES');

  const store = normalizeDiscoStore(raw);

  assert.equal(store.province, 'BUENOS AIRES');
  assert.equal(store.city, 'CIUDAD AUTONOMA BUENOS AIRES');
  assert.ok(store.address.includes('CAPITAL FEDERAL'), 'la fuente queda auditable');
});

test('un registro sin teléfono ni ciudad parseable emite null, no basura', () => {
  const store = normalizeDiscoStore(byName('Disco Costa Esmeralda'));

  assert.equal(store.phone, null, 'la fuente trae phone:null');
  assert.equal(store.city, null, 'la dirección no permite derivar ciudad');
  // Lo que sí hay sigue viniendo completo.
  assert.equal(store.address, 'Ruta 11 km 380 - Costa Esmeralda');
  assert.equal(store.province, 'BUENOS AIRES');
  assert.equal(store.latitude, -37.02565468014194);
});

test('normalizeDiscoStore no explota con un registro vacío o basura', () => {
  const vacio = normalizeDiscoStore({});

  assert.equal(vacio.external_reference, null);
  assert.equal(vacio.name, null);
  assert.equal(vacio.city, null);
  assert.equal(vacio.latitude, null);

  assert.doesNotThrow(() => normalizeDiscoStore(null));
  assert.doesNotThrow(() => normalizeDiscoStore(undefined));
});

/* --------------------------- normalizeDiscoStores ------------------------- */

test('normalizeDiscoStores descarta los inactivos', () => {
  const stores = normalizeDiscoStores(records);

  assert.equal(stores.length, 13, 'el fixture tiene 13 sucursales operativas');

  const idsResultado = new Set(stores.map((s) => s.external_reference));
  for (const r of records.filter((r) => r.isActive !== true)) {
    assert.ok(!idsResultado.has(r.id), `sucursal inactiva no descartada: ${r.name}`);
  }
});

test('normalizeDiscoStores descarta los registros sin id o sin coordenadas', () => {
  const real = records.find((r) => r.isActive === true);

  const sinGeo = { ...real, id: 'sin-geo-test', geocoordinates: '0' };
  const geoNula = { ...real, id: 'geo-nula-test', geocoordinates: null };
  const sinId = { ...real, id: null };

  const stores = normalizeDiscoStores([...records, sinGeo, geoNula, sinId]);

  assert.equal(stores.length, 13, 'los tres registros inválidos no deben sumar');
  assert.ok(!stores.some((s) => s.external_reference === 'sin-geo-test'));
  assert.ok(!stores.some((s) => s.external_reference === 'geo-nula-test'));
});

test('normalizeDiscoStores no explota con entradas no-array', () => {
  assert.deepEqual(normalizeDiscoStores(null), []);
  assert.deepEqual(normalizeDiscoStores(undefined), []);
  assert.deepEqual(normalizeDiscoStores({}), []);
  assert.deepEqual(normalizeDiscoStores([null, undefined]), []);
});

/**
 * ⚠️ `external_reference` DEBE ser `id` (uuid) y no `SellerName`.
 * `SellerName` es el candidato tentador (corto y legible) pero colisiona: 43
 * valores distintos para 76 sucursales, y `jumboargentinad028` cubre 7 tiendas.
 * `StoreSyncService` upsertea por (merchant_id, external_reference), así que
 * usarlo colapsaría esas 7 en una sola fila. El fixture trae 3 filas activas
 * con el mismo SellerName justamente para fijar esto.
 */
test('external_reference es único: `id`, NUNCA `SellerName`', () => {
  const stores = normalizeDiscoStores(records);

  const refs = stores.map((s) => s.external_reference);
  assert.equal(new Set(refs).size, refs.length, 'external_reference duplicado');

  for (const store of stores) {
    assert.equal(typeof store.external_reference, 'string');
    assert.ok(store.external_reference.length > 0, `external_reference vacío en ${store.name}`);
  }

  // Prueba viva de la colisión que motiva la decisión.
  const compartido = records.filter(
    (r) => r.isActive === true && r.SellerName === 'jumboargentinad028'
  );
  assert.equal(compartido.length, 3, 'el fixture debe traer 3 tiendas con el mismo SellerName');

  const refsCompartidas = compartido.map((r) => normalizeDiscoStore(r).external_reference);
  assert.equal(new Set(refsCompartidas).size, 3, 'las 3 conservan referencias distintas');
  assert.ok(
    refsCompartidas.every((ref) => ref !== 'jumboargentinad028'),
    'ninguna referencia puede ser el SellerName'
  );
});

test('el fixture cubre varias provincias y todas llegan al resultado', () => {
  const stores = normalizeDiscoStores(records);
  const provincias = new Set(stores.map((s) => s.province));

  assert.ok(provincias.size >= 4, `esperaba >=4 provincias, hubo ${provincias.size}`);
  assert.ok(provincias.has('BUENOS AIRES'));
  assert.ok(provincias.has('CAPITAL FEDERAL'));
  assert.ok(provincias.has('CORDOBA'));
  assert.ok(provincias.has('SANTA FE'));
});

test('todas las sucursales operativas traen ciudad y horario', () => {
  const stores = normalizeDiscoStores(records);

  // Medición sobre el dataset completo: 75/76 direcciones permiten derivar
  // ciudad, y el único que no está inactivo — así que entre las operativas del
  // fixture no debe quedar ninguna sin ciudad.
  for (const store of stores) {
    assert.ok(store.city, `sin ciudad: ${store.name} (${store.address})`);
    assert.ok(store.opening_hours, `sin horario: ${store.name}`);
  }
});
