// scrapper-script/scraper-tests/scraper-selection.test.js
//
// `/scrape/all` y `runAll()` corren sólo scrapers de productos: los de promos y
// sucursales se piden por nombre (Laravel los trae por su cuenta con un pull). Si
// no, cada cron de productos (cada 3 h) corría el scrape completo de Galicia
// (~1.630 requests) sin que nada guardara su resultado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productEntries } from '../scripts/scraperSelection.js';

// Misma forma que SCRAPERS de scripts/populate-db.js (un representante por tipo).
const REGISTRO = {
  disco: { name: 'Disco', isMaster: true },
  carrefour: { name: 'Carrefour' },
  coto: { name: 'Coto' },
  modo: { name: 'Modo Banks', type: 'bank' },
  galicia: { name: 'Banco Galicia Promos', type: 'promo' },
  santander: { name: 'Banco Santander Promos', type: 'promo' },
  jumbostores: { name: 'Jumbo Stores', type: 'stores' },
};

test('productEntries deja afuera promos y sucursales', () => {
  const keys = productEntries(REGISTRO).map(([key]) => key);
  assert.deepEqual(keys, ['disco', 'carrefour', 'coto', 'modo']);
});

test('productEntries conserva el orden y la entrada completa (el maestro sigue marcado)', () => {
  const [primera] = productEntries(REGISTRO);
  assert.equal(primera[0], 'disco');
  assert.equal(primera[1].isMaster, true);
});
