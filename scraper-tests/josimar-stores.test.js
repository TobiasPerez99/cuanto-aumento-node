// scrapper-script/scraper-tests/josimar-stores.test.js
//
// Tests unitarios de la parte PURA del scraper de sucursales de Josimar
// (normalización). No pegan a la red: usan dos fixtures reales,
//   - josimar-pickup-points.json  → respuesta completa de
//     GET /api/checkout/pub/pickup-points?geoCoordinates=-58.3916;-34.7036
//     (las 11 entradas tal como las devolvió la API, recortadas a los campos
//      que el scraper lee)
//   - josimar-store-selector.json → las 5 tiendas con venta online de
//     /files/storeSelectorConfig-master.json, fuente de los teléfonos
//
// Los dos casos que este archivo existe para blindar:
//   1. `address.geoCoordinates` es [longitud, latitud] — longitud PRIMERO.
//   2. El mapeo de `businessHours` (DayOfWeek 0 = domingo) y el dedupe de la
//      sucursal de Quilmes, que llega dos veces y con horarios en una sola.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parsePickupGeo,
  storeCode,
  mapBusinessHours,
  slugifyStoreName,
  buildPhoneIndex,
  normalizeJosimarStore,
  normalizeJosimarStores,
} from '../scrapers/stores/josimar_stores.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const payload = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/josimar-pickup-points.json'), 'utf8')
);
const selectorConfig = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/josimar-store-selector.json'), 'utf8')
);

const items = payload.items;
const phoneIndex = buildPhoneIndex(selectorConfig);

const pickupByAddressId = (addressId) =>
  items.find((it) => it.pickupPoint.address.addressId === addressId)?.pickupPoint;

/* --------------------------------- fixture -------------------------------- */

test('el fixture es la respuesta real completa: 11 entradas para 9 sucursales', () => {
  assert.equal(items.length, 11);
  assert.equal(payload.paging.total, 11);

  // 1 inactiva (el Berazategui viejo) + 1 duplicada (Quilmes) = 9 reales.
  assert.equal(items.filter((it) => it.pickupPoint.isActive === false).length, 1);

  const codes = items.map((it) => storeCode(it.pickupPoint.id));
  assert.equal(new Set(codes).size, 10, 'Quilmes aparece dos veces con el mismo código');
});

/* ------------------ parsePickupGeo — EL test del archivo ------------------ */

/**
 * ⚠️ EL test del archivo. VTEX serializa `geoCoordinates` como un ARRAY
 * [longitud, latitud] — longitud PRIMERO (GeoJSON). Leerlo como [lat,lon]
 * manda las 9 sucursales del GBA sur al Océano Índico y el "más cercana" queda
 * inservible sin fallar ruidosamente en ningún lado.
 */
test('parsePickupGeo lee el array como [lon, lat] (NO al revés)', () => {
  const geo = parsePickupGeo([-58.37862, -34.707043]);

  assert.equal(geo.longitude, -58.37862, 'la longitud es el PRIMER elemento');
  assert.equal(geo.latitude, -34.707043, 'la latitud es el SEGUNDO elemento');
});

test('parsePickupGeo: sin array, corto o vacío ⇒ sin coordenadas', () => {
  const vacio = { latitude: null, longitude: null };

  assert.deepEqual(parsePickupGeo(null), vacio);
  assert.deepEqual(parsePickupGeo(undefined), vacio);
  assert.deepEqual(parsePickupGeo([]), vacio);
  assert.deepEqual(parsePickupGeo([-58.37862]), vacio, 'un solo valor no alcanza');
  assert.deepEqual(
    parsePickupGeo('-58.37862,-34.707043'),
    vacio,
    'acá es un ARRAY, no el string que usa el Master Data de Dia'
  );
});

test('parsePickupGeo descarta valores no numéricos sin explotar', () => {
  assert.deepEqual(parsePickupGeo(['x', 'y']), { latitude: null, longitude: null });
  assert.deepEqual(parsePickupGeo([null, -34.7]), { longitude: null, latitude: -34.7 });
});

test('la sucursal real de Pringles mantiene el orden lon,lat', () => {
  const pringles = pickupByAddressId('arjosimarprod-S003001');
  assert.ok(pringles, 'el fixture debe traer la sucursal Pringles');
  assert.deepEqual(pringles.address.geoCoordinates, [-58.37862, -34.707043]);

  const store = normalizeJosimarStore(pringles, phoneIndex);

  assert.equal(store.latitude, -34.707043);
  assert.equal(store.longitude, -58.37862);
  assert.equal(store.name, 'Pringles');
  assert.equal(store.address, 'Coronel Pringles 1775');
  assert.equal(store.city, 'Lanús');
  assert.equal(store.province, 'Buenos Aires');
  assert.equal(store.postal_code, '1820');
  assert.equal(store.external_reference, 'S003001');
});

/**
 * Red de seguridad contra la inversión lon/lat: si alguien da vuelta el parseo,
 * las coordenadas caen fuera del país y este test se pone rojo.
 */
test('todas las coordenadas caen dentro del bounding box de Argentina', () => {
  const stores = normalizeJosimarStores(items, phoneIndex);
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

/**
 * Más fino que el bounding box del país: son todas del GBA sur, así que si el
 * orden se invirtiera parcialmente (o la coordenada de consulta cambiara de
 * región) también salta.
 */
test('todas las sucursales caen en el AMBA sur', () => {
  const stores = normalizeJosimarStores(items, phoneIndex);

  for (const store of stores) {
    assert.ok(
      store.latitude >= -34.9 && store.latitude <= -34.5,
      `latitud fuera del AMBA: ${store.latitude} (${store.name})`
    );
    assert.ok(
      store.longitude >= -58.6 && store.longitude <= -58.1,
      `longitud fuera del AMBA: ${store.longitude} (${store.name})`
    );
  }
});

/* ----------------------------- mapBusinessHours --------------------------- */

/**
 * ⚠️ `DayOfWeek` sigue la convención de VTEX/JS: 0 = DOMINGO. Evidencia en el
 * dato real: el día 0 es el único que abre 08:30 (los demás 08:00), y el
 * storeSelectorConfig dice "Lunes a Sabados de 8 a 21hs" para esta misma
 * sucursal. Si 0 fuese lunes, el lunes abriría más tarde que el resto y
 * contradiría ese texto.
 */
test('mapBusinessHours mapea DayOfWeek 0 a domingo y 6 a sábado', () => {
  const pringles = pickupByAddressId('arjosimarprod-S003001');
  const hours = mapBusinessHours(pringles.businessHours);

  assert.deepEqual(hours, {
    domingo: '08:30-21:00',
    lunes: '08:00-21:30',
    martes: '08:00-21:30',
    miercoles: '08:00-21:30',
    jueves: '08:00-21:30',
    viernes: '08:00-21:30',
    sabado: '08:00-21:30',
  });

  // El domingo es el que abre más tarde: el dato que confirma el mapeo.
  assert.notEqual(hours.domingo, hours.lunes);
  assert.equal(hours.lunes, hours.sabado, 'lunes a sábado tienen el mismo horario');
});

test('mapBusinessHours recorta los segundos de la hora', () => {
  const hours = mapBusinessHours([
    { DayOfWeek: 1, OpeningTime: '08:00:00', ClosingTime: '21:30:00' },
  ]);

  assert.deepEqual(hours, { lunes: '08:00-21:30' });
});

test('mapBusinessHours descarta días fuera de 0..6 en vez de adivinar', () => {
  const hours = mapBusinessHours([
    { DayOfWeek: 7, OpeningTime: '08:00:00', ClosingTime: '21:00:00' },
    { DayOfWeek: -1, OpeningTime: '08:00:00', ClosingTime: '21:00:00' },
    { DayOfWeek: 'lunes', OpeningTime: '08:00:00', ClosingTime: '21:00:00' },
    { DayOfWeek: 2, OpeningTime: '09:00:00', ClosingTime: '20:00:00' },
  ]);

  assert.deepEqual(hours, { martes: '09:00-20:00' });
});

test('mapBusinessHours devuelve null cuando no hay nada usable', () => {
  assert.equal(mapBusinessHours([]), null, 'el array vacío de Quilmes duplicado');
  assert.equal(mapBusinessHours(null), null);
  assert.equal(mapBusinessHours(undefined), null);
  assert.equal(mapBusinessHours('08 a 21'), null);
  assert.equal(
    mapBusinessHours([{ DayOfWeek: 1, OpeningTime: null, ClosingTime: null }]),
    null,
    'un día sin horas no cuenta'
  );
});

test('las 9 sucursales resultantes tienen los 7 días de horario', () => {
  const stores = normalizeJosimarStores(items, phoneIndex);

  for (const store of stores) {
    assert.ok(store.opening_hours, `sin horarios: ${store.name}`);
    assert.equal(
      Object.keys(store.opening_hours).length,
      7,
      `esperaba 7 días en ${store.name}, hubo ${Object.keys(store.opening_hours).length}`
    );
  }
});

/* ---------------------------------- storeCode ----------------------------- */

/**
 * ⚠️ La MISMA sucursal de Quilmes llega con dos identificadores distintos.
 * Sin normalizar el código, el dedupe no las encuentra y `StoreSyncService`
 * crea dos filas en `merchant_stores` para la misma tienda.
 */
test('storeCode colapsa las dos formas del id de Quilmes', () => {
  assert.equal(storeCode('1_arjosimarprod-S009001'), 'S009001');
  assert.equal(storeCode('1_S009001'), 'S009001');
  assert.equal(storeCode('arjosimarprod-S009001'), 'S009001');
  assert.equal(storeCode('S009001'), 'S009001');
});

test('storeCode no inventa un código', () => {
  assert.equal(storeCode(null), null);
  assert.equal(storeCode(''), null);
  assert.equal(storeCode('   '), null);
  assert.equal(storeCode(undefined), null);
});

test('storeCode sobre los 11 ids reales da 10 códigos distintos', () => {
  const codes = items.map((it) => storeCode(it.pickupPoint.id));

  assert.ok(codes.every(Boolean), 'ningún id real debe quedar sin código');
  assert.ok(codes.every((c) => /^S\d{6}$/.test(c)), `formato inesperado: ${codes}`);

  // Los 11 registros son 10 códigos: Quilmes está repetido.
  assert.equal(new Set(codes).size, 10);
  assert.equal(codes.filter((c) => c === 'S009001').length, 2);
});

/* -------------------------- normalizeJosimarStores ------------------------ */

test('normalizeJosimarStores devuelve las 9 sucursales reales', () => {
  const stores = normalizeJosimarStores(items, phoneIndex);

  assert.equal(stores.length, 9, '11 entradas − 1 inactiva − 1 duplicada');

  const refs = stores.map((s) => s.external_reference);
  assert.equal(new Set(refs).size, refs.length, 'external_reference duplicado');
});

test('normalizeJosimarStores descarta la sucursal inactiva', () => {
  const stores = normalizeJosimarStores(items, phoneIndex);
  const inactiva = items.find((it) => it.pickupPoint.isActive === false).pickupPoint;

  assert.equal(storeCode(inactiva.id), 'S010001', 'el Berazategui viejo');
  assert.ok(!stores.some((s) => s.external_reference === 'S010001'));

  // Pero la Berazategui activa sí tiene que estar.
  assert.ok(stores.some((s) => s.external_reference === 'S001001'));
});

/**
 * ⚠️ El dedupe no puede quedarse con "la primera": de las dos entradas de
 * Quilmes, la que trae los 7 días de horario es `1_S009001` y la que viene con
 * `businessHours: []` es `1_arjosimarprod-S009001`. Quedarse con la equivocada
 * publica la sucursal sin horarios.
 */
test('el dedupe de Quilmes se queda con la entrada que TIENE horarios', () => {
  const conHoras = pickupByAddressId('S009001');
  const sinHoras = pickupByAddressId('arjosimarprod-S009001');

  assert.equal(conHoras.businessHours.length, 7);
  assert.equal(sinHoras.businessHours.length, 0, 'la variante con prefijo de cuenta viene vacía');
  assert.deepEqual(
    conHoras.address.geoCoordinates,
    sinHoras.address.geoCoordinates,
    'control: son la MISMA sucursal física'
  );

  const stores = normalizeJosimarStores(items, phoneIndex);
  const quilmes = stores.filter((s) => s.external_reference === 'S009001');

  assert.equal(quilmes.length, 1, 'Quilmes no puede aparecer dos veces');
  assert.ok(quilmes[0].opening_hours, 'y tiene que ser la que trae los horarios');
  assert.equal(Object.keys(quilmes[0].opening_hours).length, 7);
  assert.equal(quilmes[0].opening_hours.domingo, '08:30-22:00');
});

test('el dedupe no depende del orden en que lleguen los duplicados', () => {
  const alReves = [...items].reverse();

  const stores = normalizeJosimarStores(alReves, phoneIndex);
  const quilmes = stores.filter((s) => s.external_reference === 'S009001');

  assert.equal(quilmes.length, 1);
  assert.equal(Object.keys(quilmes[0].opening_hours ?? {}).length, 7);
});

test('normalizeJosimarStores descarta los registros sin coordenadas', () => {
  // Se parte de un registro REAL y se le anula sólo el campo de coordenadas,
  // para que el test siga midiendo el filtro y no una forma inventada.
  const real = items.find((it) => it.pickupPoint.isActive !== false).pickupPoint;

  const sinGeo = {
    pickupPoint: {
      ...real,
      id: '1_arjosimarprod-S999001',
      address: { ...real.address, geoCoordinates: [] },
    },
  };
  const sinId = { pickupPoint: { ...real, id: null, address: { ...real.address, addressId: null } } };

  const stores = normalizeJosimarStores([...items, sinGeo, sinId], phoneIndex);

  assert.equal(stores.length, 9, 'los dos registros inválidos no deben sumar');
  assert.ok(!stores.some((s) => s.external_reference === 'S999001'));
});

test('normalizeJosimarStores no explota con entradas no-array', () => {
  assert.deepEqual(normalizeJosimarStores(null), []);
  assert.deepEqual(normalizeJosimarStores(undefined), []);
  assert.deepEqual(normalizeJosimarStores({}), []);
  assert.deepEqual(normalizeJosimarStores([null, undefined]), []);
});

test('normalizeJosimarStores acepta pickupPoints sueltos (sin el envoltorio)', () => {
  const sueltos = items.map((it) => it.pickupPoint);
  assert.equal(normalizeJosimarStores(sueltos, phoneIndex).length, 9);
});

test('el contrato completo sale con los campos esperados', () => {
  const stores = normalizeJosimarStores(items, phoneIndex);
  const campos = [
    'external_reference',
    'name',
    'address',
    'city',
    'province',
    'postal_code',
    'latitude',
    'longitude',
    'phone',
    'opening_hours',
  ];

  for (const store of stores) {
    assert.deepEqual(Object.keys(store).sort(), [...campos].sort());
    assert.equal(typeof store.external_reference, 'string');
    assert.ok(store.name, `sucursal sin nombre: ${store.external_reference}`);
    assert.ok(store.address, `sucursal sin dirección: ${store.name}`);
  }
});

test('las 9 sucursales cubren el sur del GBA', () => {
  const stores = normalizeJosimarStores(items, phoneIndex);
  const ciudades = new Set(stores.map((s) => s.city));

  assert.ok(ciudades.has('Lanús'));
  assert.ok(ciudades.has('Lomas de Zamora'));
  assert.ok(ciudades.has('Quilmes'));
  assert.ok(ciudades.has('Berazategui'));
  assert.ok(ciudades.size >= 6, `esperaba >=6 ciudades, hubo ${ciudades.size}`);
});

/* ------------------------- teléfonos (enriquecimiento) -------------------- */

test('slugifyStoreName saca el prefijo "Josimar" y los acentos', () => {
  assert.equal(slugifyStoreName('Josimar Pringles'), 'pringles');
  assert.equal(slugifyStoreName('Pringles'), 'pringles');
  assert.equal(slugifyStoreName('Josimar Monte Grande'), 'monte-grande');
  assert.equal(slugifyStoreName('Monte Grande'), 'monte-grande');
  assert.equal(slugifyStoreName('  Lanús Este '), 'lanus-este');
  assert.equal(slugifyStoreName(''), null);
  assert.equal(slugifyStoreName(null), null);
});

test('buildPhoneIndex indexa las 5 tiendas con venta online', () => {
  assert.equal(phoneIndex.size, 5);
  assert.equal(phoneIndex.get('pringles'), '4225-2253');
  assert.equal(phoneIndex.get('colombres'), '4239-9610');
  assert.equal(phoneIndex.get('barracas'), '4301-5888');
  assert.equal(phoneIndex.get('quilmes'), '+54 9 11 2283-6454');
  assert.equal(phoneIndex.get('berazategui'), '1136042384');
});

/**
 * El cruce tiene que ser INEQUÍVOCO: un teléfono equivocado en la ficha de una
 * sucursal es peor que un teléfono ausente.
 */
test('buildPhoneIndex descarta los slugs ambiguos', () => {
  const ambiguo = {
    master: {
      provinces: [
        {
          stores: [
            { name: 'Josimar Centro', phone: '111' },
            { name: 'Centro', phone: '222' },
            { name: 'Josimar Unico', phone: '333' },
          ],
        },
      ],
    },
  };

  const index = buildPhoneIndex(ambiguo);

  assert.equal(index.has('centro'), false, 'dos tiendas colapsan al mismo slug ⇒ sin teléfono');
  assert.equal(index.get('unico'), '333');
});

test('buildPhoneIndex no explota con un archivo con otra forma', () => {
  assert.equal(buildPhoneIndex(null).size, 0);
  assert.equal(buildPhoneIndex({}).size, 0);
  assert.equal(buildPhoneIndex({ master: {} }).size, 0);
  assert.equal(buildPhoneIndex({ master: { provinces: 'x' } }).size, 0);
});

test('el teléfono llega a las 5 sucursales que lo tienen y las otras 4 quedan en null', () => {
  const stores = normalizeJosimarStores(items, phoneIndex);

  const conTelefono = stores.filter((s) => s.phone);
  assert.equal(conTelefono.length, 5, 'sólo las 5 tiendas con venta online tienen teléfono');

  const pringles = stores.find((s) => s.external_reference === 'S003001');
  assert.equal(pringles.phone, '4225-2253');

  // Roldán no está en el storeSelectorConfig ⇒ null, nunca el de otra sucursal.
  const roldan = stores.find((s) => s.external_reference === 'S004001');
  assert.equal(roldan.name, 'Roldan');
  assert.equal(roldan.phone, null);
});

test('sin índice de teléfonos el scraper sigue funcionando (enriquecimiento opcional)', () => {
  const stores = normalizeJosimarStores(items);

  assert.equal(stores.length, 9, 'las sucursales salen igual');
  assert.ok(stores.every((s) => s.phone === null));
});

/**
 * ⚠️ Las coordenadas del storeSelectorConfig están ROTAS y por eso el scraper
 * usa SÓLO su teléfono. Este test fija el dato para que nadie caiga en la
 * tentación de "completar" desde ahí.
 */
test('las coordenadas del storeSelectorConfig no son usables', () => {
  const berazategui = selectorConfig.master.provinces
    .flatMap((p) => p.stores)
    .find((s) => s.name === 'Josimar Berazategui');

  assert.ok(berazategui);
  assert.ok(
    Math.abs(berazategui.longitude) > 180,
    `esperaba una longitud imposible, vino ${berazategui.longitude}`
  );

  // La buena es la de pickup-points.
  const store = normalizeJosimarStores(items, phoneIndex).find(
    (s) => s.external_reference === 'S001001'
  );
  assert.ok(store.longitude > -59 && store.longitude < -58);
});
