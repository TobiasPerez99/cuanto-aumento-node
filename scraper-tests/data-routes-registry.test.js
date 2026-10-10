/**
 * Registro de fuentes de los endpoints de PULL (routes/dataRoutes.js).
 *
 * Laravel pide promos y sucursales por `/api/promotions/:source` y `/api/stores/:source`:
 * una fuente que existe en populate-db.js pero no en estos mapas responde 404 en
 * producción aunque su scraper y sus tests estén bien (pasó el 2026-10-10 con las cinco
 * fuentes de la etapa 2: se importaron y nunca se registraron).
 *
 * Correr: node --test scraper-tests/data-routes-registry.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PROMOTION_SOURCES, STORE_SOURCES } from '../routes/dataRoutes.js';
import { SCRAPERS } from '../scripts/populate-db.js';

test('todo scraper de promos de populate-db se puede pedir por /api/promotions', () => {
  const registered = new Set(Object.values(PROMOTION_SOURCES));
  const missing = Object.entries(SCRAPERS)
    .filter(([, s]) => s.type === 'promo' && !registered.has(s.fn))
    .map(([key]) => key);

  assert.deepEqual(missing, []);
});

test('todo scraper de sucursales de populate-db se puede pedir por /api/stores', () => {
  const registered = new Set(Object.values(STORE_SOURCES));
  const missing = Object.entries(SCRAPERS)
    .filter(([, s]) => s.type === 'stores' && !registered.has(s.fn))
    .map(([key]) => key);

  assert.deepEqual(missing, []);
});

test('las fuentes que piden los providers de Laravel están registradas', () => {
  // Los paths de App\Services\PromotionsProviders\*Service y de StoreSyncService.
  const promos = ['carrefour', 'masonline', 'farmacity', 'naranjax', 'cuentadni', 'galicia', 'santander'];
  for (const source of promos) {
    assert.equal(typeof PROMOTION_SOURCES[source], 'function', `falta /api/promotions/${source}`);
  }
  for (const source of ['jumbo', 'coto', 'dia', 'disco', 'josimar', 'farmacity']) {
    assert.equal(typeof STORE_SOURCES[source], 'function', `falta /api/stores/${source}`);
  }
});
