// scrapper-script/scraper-tests/vtex-products.test.js
//
// Cómo se despacha una corrida de productos VTEX (`cores/vtexProducts.js`): qué
// estrategia usa cada modo y con qué configuración recorre cada comercio. Sin red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VTEX_MERCHANTS, resolveVtexRun, markSearchResult } from '../cores/vtexProducts.js';
import { saveMasterProduct, saveFollowerProduct } from '../cores/saveHandlers.js';
import { DETAILED_CATEGORIES } from '../cores/categories.js';

const KEYS = ['disco', 'carrefour', 'jumbo', 'vea', 'dia', 'masonline', 'farmacity'];

test('los 7 comercios VTEX están registrados', () => {
  assert.deepEqual(Object.keys(VTEX_MERCHANTS).sort(), [...KEYS].sort());
});

test('categories recorre el catálogo REST filtrando por disponibilidad en el canal', async () => {
  for (const key of KEYS) {
    const run = await resolveVtexRun(key, 'categories');

    assert.equal(run.strategy, 'catalog', key);
    assert.equal(run.options.mode, 'categories', key);
    assert.equal(run.options.onlyAvailable, true, `${key}: sin filtro, Cencosud son 381k productos que no vende`);
    assert.ok(Number.isInteger(run.options.salesChannel) && run.options.salesChannel > 0, `${key}: canal de respaldo`);
    assert.match(run.options.baseUrl, /^https:\/\//, key);
  }
});

/**
 * Disco, Jumbo y Vea comparten UN catálogo VTEX: lo único que separa los precios
 * de una cadena de los de otra es el canal. Dos con el mismo canal publicarían
 * los precios de una como si fueran de la otra.
 */
test('las tres cadenas de Cencosud recorren canales distintos', async () => {
  const channels = await Promise.all(
    ['disco', 'jumbo', 'vea'].map(async (key) => (await resolveVtexRun(key, 'categories')).options.salesChannel)
  );

  assert.equal(new Set(channels).size, 3, `canales: ${channels.join(', ')}`);
});

test('Disco es el único maestro: crea productos y exige imagen', async () => {
  for (const key of KEYS) {
    const { options } = await resolveVtexRun(key, 'categories');
    const isMaster = key === 'disco';

    assert.equal(options.onProductFound, isMaster ? saveMasterProduct : saveFollowerProduct, key);
    assert.equal(options.requireImage, isMaster, key);
  }
});

test('eans consulta los EANs puntuales por el mismo catálogo REST', async () => {
  const run = await resolveVtexRun('vea', 'eans');

  assert.equal(run.strategy, 'catalog');
  assert.equal(run.options.mode, 'eans');
  assert.ok(Array.isArray(run.options.eans));
});

test('search es la vuelta atrás: la búsqueda de texto de GraphQL con la lista de términos', async () => {
  const run = await resolveVtexRun('carrefour', 'search');

  assert.equal(run.strategy, 'search');
  assert.equal(run.options.merchantName, 'Carrefour');
  assert.deepEqual(run.options.categories, DETAILED_CATEGORIES);
  assert.equal(run.options.count, 50);
  assert.equal(run.options.onProductFound, saveFollowerProduct);
});

/**
 * La búsqueda de texto nunca recorre el catálogo (es el top 50 de cada término): si
 * Laravel la tomara por completa, activar la vuelta atrás encendería el vencimiento
 * sobre el 25-35% del catálogo que la búsqueda no ve, y a la tercera corrida lo escondería.
 */
test('una corrida de search se declara incompleta', () => {
  const out = markSearchResult({ success: true, totalProducts: 8899, savedProducts: 8800 });

  assert.equal(out.success, true);
  assert.equal(out.complete, false);
  assert.equal(out.strategy, 'search');
  assert.equal(out.mode, 'search');
  assert.deepEqual(out.incompleteReasons, ['search_mode']);
  assert.equal(out.totalProducts, 8899);
});

test('search sólo acepta pisar el handler: el core de GraphQL ignora el resto', async () => {
  const { options } = await resolveVtexRun('disco', 'search', {
    onProductFound: null,
    httpGet: async () => ({}),
    getMerchantId: async () => -1,
  });

  assert.equal(options.onProductFound, null);
  assert.equal('httpGet' in options, false);
  assert.equal('getMerchantId' in options, false);
});

test('un modo desconocido recorre el catálogo, como antes lo hacía cualquier modo que no fuera eans', async () => {
  assert.equal((await resolveVtexRun('dia', undefined)).options.mode, 'categories');
  assert.equal((await resolveVtexRun('dia', 'otra-cosa')).options.mode, 'categories');
});

test('un comercio desconocido es un error de programación, no una corrida vacía', async () => {
  await assert.rejects(resolveVtexRun('coto', 'categories'), /coto/);
});

test('se puede pisar el handler para una corrida en seco', async () => {
  const { options } = await resolveVtexRun('disco', 'categories', { onProductFound: null });

  assert.equal(options.onProductFound, null);
});
