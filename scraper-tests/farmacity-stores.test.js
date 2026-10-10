// scrapper-script/scraper-tests/farmacity-stores.test.js
//
// Tests del scraper de sucursales de Farmacity (API del localizador). Sin red: el
// fixture tiene seis sucursales reales del 2026-10-10 elegidas por su forma (normal,
// 24 hs, doble turno, dos depósitos y una con coordenadas rotas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  FALLBACK_TOKEN,
  findComponentVersion,
  findToken,
  resolveToken,
  normalizeCoordinates,
  formatOpeningHours,
  normalizeFarmacityStore,
  isRetailStore,
  getFarmacityStores,
} from '../scrapers/stores/farmacity_stores.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/farmacity-stores.json'), 'utf8'));
const byId = (id) => fixture.details.find((s) => s.Id === id);

test('lee la versión del componente y el token del bundle', () => {
  assert.equal(findComponentVersion(fixture.page_snippet), '0.0.8');
  assert.equal(findToken(fixture.bundle_snippet), FALLBACK_TOKEN);
  assert.equal(findToken('sin token'), null);
});

test('si el bundle no se puede leer, usa el último token conocido', async () => {
  const http = async () => ({ status: 500, data: '' });
  const resolved = await resolveToken({ http });
  assert.deepEqual(resolved, { token: FALLBACK_TOKEN, source: 'fallback', version: null });
});

test('las coordenadas se validan contra Argentina y se dan vuelta si sólo entran así', () => {
  assert.deepEqual(normalizeCoordinates('-34.60239', '-58.37982'), { latitude: -34.60239, longitude: -58.37982 });
  // Así vienen en /sucursales/all: invertidas.
  assert.deepEqual(normalizeCoordinates('-58.37982', '-34.60239'), { latitude: -34.60239, longitude: -58.37982 });
  assert.deepEqual(normalizeCoordinates('-34,60239', '-58,37982'), { latitude: -34.60239, longitude: -58.37982 });
  // Paseo Aldrey: la longitud repite la latitud. No entra de ninguna forma.
  assert.deepEqual(normalizeCoordinates('-38.01211', '-38.01211'), { latitude: null, longitude: null });
  assert.deepEqual(normalizeCoordinates('0', '0'), { latitude: null, longitude: null });
});

test('horarios por día, con 24 hs y doble turno', () => {
  const centro = formatOpeningHours(byId(2).TimeTables);
  assert.equal(centro.Lunes, '08:30 a 20:00');
  assert.ok('Feriados' in centro);

  const veinticuatro = formatOpeningHours(byId(4).TimeTables);
  assert.ok(Object.values(veinticuatro).includes('Abierto 24 hs'));

  const dobleTurno = formatOpeningHours(byId(173).TimeTables);
  assert.ok(Object.values(dobleTurno).some((h) => / y /.test(h)), JSON.stringify(dobleTurno));

  assert.equal(formatOpeningHours([]), null);
});

test('normaliza al contrato de StoreSyncService', () => {
  const store = normalizeFarmacityStore(byId(2));
  assert.equal(store.external_reference, '2');
  assert.equal(store.name, 'CENTRO [Pellegrini 457]');
  assert.equal(store.address, 'Pellegrini 457');
  assert.equal(store.city, 'Capital Federal');
  assert.equal(store.phone, '4326-0235');
  assert.equal(store.latitude, -34.60239);
});

test('los depósitos (CDC y e-commerce) no son sucursales', () => {
  assert.equal(isRetailStore(byId(170)), false);
  assert.equal(isRetailStore(byId(200)), false);
  assert.equal(isRetailStore(byId(2)), true);
});

/** API falsa del localizador. */
function fakeHttp({ allStatus = 200, detailStatus = 200, calls = [] } = {}) {
  return async ({ method = 'GET', url, data, headers = {} }) => {
    calls.push({ method, url, data, auth: headers.Authorization });
    if (url.includes('farmacity.com/farmacity/sucursales')) return { status: 200, data: fixture.page_snippet };
    if (url.includes('AppGeneralApp.min.js')) return { status: 200, data: fixture.bundle_snippet };
    if (url.endsWith('/sucursales/all')) return { status: allStatus, data: allStatus === 200 ? fixture.all : 'Unauthorized' };
    if (method === 'POST') {
      const wanted = new Set(data);
      return { status: detailStatus, data: { sucursales: fixture.details.filter((s) => wanted.has(String(s.Id))) } };
    }
    return { status: 404, data: '' };
  };
}

test('corrida completa: token del bundle, detalle en lotes, depósitos afuera', async () => {
  const calls = [];
  const result = await getFarmacityStores({ http: fakeHttp({ calls }), sleep: async () => {} });

  assert.equal(result.success, true);
  assert.equal(result.token_source, 'bundle');
  assert.equal(result.total, 4);
  assert.deepEqual(result.stores.map((s) => s.external_reference).sort(), ['173', '2', '395', '4']);
  assert.ok(calls.filter((c) => c.url.includes('azurewebsites')).every((c) => c.auth === `Bearer ${FALLBACK_TOKEN}`));
  const aldrey = result.stores.find((s) => s.external_reference === '395');
  assert.equal(aldrey.latitude, null);
});

test('un token rechazado falla la corrida con el motivo', async () => {
  const result = await getFarmacityStores({ http: fakeHttp({ allStatus: 401 }), sleep: async () => {} });
  assert.equal(result.success, false);
  assert.match(result.error, /rechazó el token/);
});

test('un lote de detalle caído falla la corrida (no se publican sucursales a medias)', async () => {
  const result = await getFarmacityStores({ http: fakeHttp({ detailStatus: 500 }), sleep: async () => {} });
  assert.equal(result.success, false);
});
