// scrapper-script/scraper-tests/vtex-catalog.test.js
//
// Tests del recorrido del Catalog System REST de VTEX (`cores/vtexCatalog.js`), el
// camino que reemplazó a la búsqueda de texto de `productSuggestions` para los 7
// comercios VTEX (SCRAPER-001). No pegan a la red: la parte pura se prueba con
// `vtex-catalog-products.json` (4 productos reales, recortados a los campos que se
// leen) y el orquestador con un VTEX falso en memoria.
//
// El fixture cubre:
//   - Palta Hass (Disco): el caso normal. `ListPrice` viene ×90 (108507 contra un
//     precio de 1199): el bug documentado de VTEX que obliga a usar PriceWithoutDiscount.
//   - Banana x kg (Disco): unitMultiplier 0.5 (precio de referencia por kg).
//   - Rollo de cocina (Carrefour): con descuento real (2064.3 contra 2949).
//   - Corrector Maybelline (Farmacity): 7 SKU con EAN propio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PAGE_SIZE,
  MAX_FROM,
  parseResourcesTotal,
  buildSearchUrl,
  normalizeCatalogProduct,
  retryDelayMs,
  withRetry,
  resolveSalesChannel,
  resolveCategoryTargets,
  walkTarget,
  scrapeVtexCatalog,
} from '../cores/vtexCatalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/vtex-catalog-products.json'), 'utf8')
);
const byEan = (ean) => structuredClone(records.find((p) => p.items[0].ean === ean));

const PALTA = '2947607000003';
const BANANA = '2999239000005';
const ROLLO = '7790250056881';
const CORRECTOR = '41554259254';

const noSleep = async () => {};

/* ------------------------------- constantes ------------------------------- */

test('la ventana de VTEX: 50 por página y _from hasta 2500', () => {
  // Medido en vivo: `_to - _from` > 49 da 400 ("_to can't be greater than 50") y
  // `_from` > 2500 da 400. Todo el diseño del descenso depende de estos dos números.
  assert.equal(PAGE_SIZE, 50);
  assert.equal(MAX_FROM, 2500);
});

/* ---------------------------- parseResourcesTotal ------------------------- */

test('parseResourcesTotal lee el total del header de VTEX', () => {
  assert.equal(parseResourcesTotal('0-49/3524'), 3524);
  assert.equal(parseResourcesTotal('0-0/0'), 0);
  assert.equal(parseResourcesTotal('2500-2549/3524 '), 3524);
});

test('parseResourcesTotal nunca inventa un total', () => {
  assert.equal(parseResourcesTotal(undefined), null);
  assert.equal(parseResourcesTotal(''), null);
  assert.equal(parseResourcesTotal('0-49'), null);
});

/* ------------------------------ buildSearchUrl ---------------------------- */

test('buildSearchUrl pide una categoría por su path completo, con canal y filtro de disponibilidad', () => {
  assert.equal(
    buildSearchUrl('https://www.disco.com.ar/', {
      path: '/1/17/',
      from: 50,
      salesChannel: 33,
      onlyAvailable: true,
    }),
    'https://www.disco.com.ar/api/catalog_system/pub/products/search' +
      '?fq=C:/1/17/&fq=isAvailablePerSalesChannel_33:1&sc=33&_from=50&_to=99'
  );
});

test('buildSearchUrl sin canal ni filtro deja que el host use su canal por defecto', () => {
  assert.equal(
    buildSearchUrl('https://www.josimar.com.ar', { path: '/3/' }),
    'https://www.josimar.com.ar/api/catalog_system/pub/products/search?fq=C:/3/&_from=0&_to=49'
  );
});

test('buildSearchUrl sin path cuenta el catálogo entero del canal', () => {
  assert.equal(
    buildSearchUrl('https://www.vea.com.ar', { from: 0, to: 0, salesChannel: 34, onlyAvailable: true }),
    'https://www.vea.com.ar/api/catalog_system/pub/products/search' +
      '?fq=isAvailablePerSalesChannel_34:1&sc=34&_from=0&_to=0'
  );
});

test('buildSearchUrl consulta EANs puntuales como un OR de fq', () => {
  assert.equal(
    buildSearchUrl('https://www.jumbo.com.ar', { eans: ['779 1', '7792'], salesChannel: 32, onlyAvailable: true }),
    'https://www.jumbo.com.ar/api/catalog_system/pub/products/search' +
      '?fq=alternateIds_Ean:779%201&fq=alternateIds_Ean:7792&fq=isAvailablePerSalesChannel_32:1&sc=32&_from=0&_to=49'
  );
});

test('buildSearchUrl se niega a filtrar disponibilidad sin saber el canal', () => {
  // `isAvailablePerSalesChannel_1:1` en el host de Disco devuelve 0 productos: un
  // canal equivocado no es un filtro más laxo, es un catálogo vacío.
  assert.throws(() => buildSearchUrl('https://www.disco.com.ar', { path: '/1/', onlyAvailable: true }), /canal/);
});

/* -------------------------- normalizeCatalogProduct ----------------------- */

const DISCO = { baseUrl: 'https://www.disco.com.ar', source: 'disco' };

test('normalizeCatalogProduct emite el contrato que consumen los save handlers', () => {
  const p = normalizeCatalogProduct(byEan(PALTA), DISCO);

  assert.deepEqual(p, {
    ean: PALTA,
    external_id: '19417',
    source: 'disco',
    name: 'Palta Hass Elegida X Un',
    link: 'https://www.disco.com.ar/palta-hass-elegida-x-un/p',
    image: p.images[0],
    images: p.images,
    price: 1199,
    list_price: 1199,
    reference_price: 1199,
    reference_unit: 'un',
    is_available: true,
    brand: records[0].brand,
    categories: [
      '/Frutas y Verduras/Frutas/Frutas Sueltas/',
      '/Frutas y Verduras/Frutas/',
      '/Frutas y Verduras/',
    ],
    description: records[0].description,
    unavailable: false,
  });
  assert.ok(p.images.length > 0 && p.images.every((url) => url.startsWith('https://')));
});

test('normalizeCatalogProduct nunca usa ListPrice: viene multiplicado ×90', () => {
  const raw = byEan(PALTA);
  assert.equal(raw.items[0].sellers[0].commertialOffer.ListPrice, 108507, 'precondición del fixture');

  assert.equal(normalizeCatalogProduct(raw, DISCO).list_price, 1199);
});

test('normalizeCatalogProduct toma el precio tachado de PriceWithoutDiscount', () => {
  const p = normalizeCatalogProduct(byEan(ROLLO), { baseUrl: 'https://www.carrefour.com.ar', source: 'carrefour' });

  assert.equal(p.price, 2064.3);
  assert.equal(p.list_price, 2949);
});

test('normalizeCatalogProduct calcula el precio de referencia con unitMultiplier', () => {
  const p = normalizeCatalogProduct(byEan(BANANA), DISCO);

  assert.equal(p.price, 3599);
  assert.equal(p.reference_price, 7198);
  assert.equal(p.reference_unit, 'kg');
});

test('normalizeCatalogProduct toma el primer SKU, como el camino de GraphQL', () => {
  const raw = byEan(CORRECTOR);
  assert.equal(raw.items.length, 7, 'precondición del fixture');

  assert.equal(normalizeCatalogProduct(raw, { baseUrl: 'https://www.farmacity.com', source: 'farmacity' }).ean, CORRECTOR);
});

test('normalizeCatalogProduct arma el link con el dominio del comercio y cae al absoluto', () => {
  // Disco, Jumbo y Vea comparten catálogo: el link tiene que salir del host que se
  // está recorriendo, no de lo que traiga el producto.
  const raw = byEan(PALTA);
  raw.link = 'https://www.otra-cadena.com.ar/palta-hass-elegida-x-un/p';
  assert.equal(normalizeCatalogProduct(raw, { baseUrl: 'https://www.vea.com.ar/', source: 'vea' }).link,
    'https://www.vea.com.ar/palta-hass-elegida-x-un/p');

  delete raw.linkText;
  assert.equal(normalizeCatalogProduct(raw, DISCO).link, 'https://www.otra-cadena.com.ar/palta-hass-elegida-x-un/p');

  delete raw.link;
  assert.equal(normalizeCatalogProduct(raw, DISCO).link, null, 'nunca inventa una URL');
});

test('normalizeCatalogProduct respeta IsAvailable y cae a AvailableQuantity si falta', () => {
  const raw = byEan(PALTA);
  const offer = raw.items[0].sellers[0].commertialOffer;

  offer.IsAvailable = false;
  assert.equal(normalizeCatalogProduct(raw, DISCO).is_available, false);
  assert.equal(normalizeCatalogProduct(raw, DISCO).unavailable, true);

  delete offer.IsAvailable;
  offer.AvailableQuantity = 0;
  assert.equal(normalizeCatalogProduct(raw, DISCO).is_available, false);
  offer.AvailableQuantity = 3;
  assert.equal(normalizeCatalogProduct(raw, DISCO).is_available, true);
});

test('normalizeCatalogProduct prefiere el seller por defecto', () => {
  const raw = byEan(PALTA);
  const [seller] = raw.items[0].sellers;
  raw.items[0].sellers = [
    { ...structuredClone(seller), sellerDefault: false, commertialOffer: { ...seller.commertialOffer, Price: 1 } },
    seller,
  ];

  assert.equal(normalizeCatalogProduct(raw, DISCO).price, 1199);
});

test('normalizeCatalogProduct descarta lo que no tiene EAN', () => {
  const raw = byEan(PALTA);
  raw.items[0].ean = '   ';
  assert.equal(normalizeCatalogProduct(raw, DISCO), null);
  delete raw.items[0].ean;
  assert.equal(normalizeCatalogProduct(raw, DISCO), null);
});

test('normalizeCatalogProduct descarta lo que no tiene precio positivo', () => {
  // Un $0 pondría al comercio como "el más barato" de todo el comparador.
  const raw = byEan(PALTA);
  raw.items[0].sellers[0].commertialOffer.Price = 0;
  assert.equal(normalizeCatalogProduct(raw, DISCO), null);
  raw.items[0].sellers = [];
  assert.equal(normalizeCatalogProduct(raw, DISCO), null);
});

test('normalizeCatalogProduct exige imagen sólo si se le pide (el maestro)', () => {
  const raw = byEan(PALTA);
  raw.items[0].images = [];

  assert.equal(normalizeCatalogProduct(raw, { ...DISCO, requireImage: true }), null);

  const follower = normalizeCatalogProduct(raw, { ...DISCO, source: 'jumbo' });
  assert.equal(follower.image, null);
  assert.deepEqual(follower.images, []);
});

test('normalizeCatalogProduct no explota con basura', () => {
  for (const raw of [null, undefined, {}, { items: [] }, { items: [null] }, 'x']) {
    assert.equal(normalizeCatalogProduct(raw, DISCO), null);
  }
});

/* ------------------------------ reintentos -------------------------------- */

test('retryDelayMs reintenta la red y los 5xx con espera corta', () => {
  assert.equal(retryDelayMs({ code: 'ECONNRESET' }, 1), 1500);
  assert.equal(retryDelayMs({ response: { status: 503 } }, 2), 3000);
});

test('retryDelayMs enfría antes de reintentar un 429 o un 403 (el WAF)', () => {
  assert.equal(retryDelayMs({ response: { status: 429 } }, 1), 15000);
  assert.equal(retryDelayMs({ response: { status: 403 } }, 2), 30000);
});

test('retryDelayMs no reintenta otros 4xx: son deterministas', () => {
  assert.equal(retryDelayMs({ response: { status: 400 } }, 1), null);
  assert.equal(retryDelayMs({ response: { status: 404 } }, 1), null);
});

test('retryDelayMs corta a los 3 intentos', () => {
  assert.equal(retryDelayMs({ response: { status: 500 } }, 3), null);
  assert.equal(retryDelayMs({ response: { status: 429 } }, 3), null);
});

test('withRetry reintenta un 5xx y devuelve la respuesta buena', async () => {
  const waits = [];
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls === 1) throw { response: { status: 500 } };
      return 'ok';
    },
    { sleep: async (ms) => waits.push(ms) }
  );

  assert.equal(out, 'ok');
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1500]);
});

test('withRetry no insiste con un 400 y propaga el error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw { response: { status: 400 } };
    }, { sleep: noSleep }),
    (err) => err.response.status === 400
  );
  assert.equal(calls, 1);
});

test('withRetry se rinde al tercer intento', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      throw { code: 'ETIMEDOUT' };
    }, { sleep: noSleep })
  );
  assert.equal(calls, 3);
});

/* --------------------------- resolveSalesChannel -------------------------- */

test('resolveSalesChannel lee el canal del segmento por defecto de la tienda', async () => {
  const urls = [];
  const out = await resolveSalesChannel('https://www.disco.com.ar/', {
    fallback: 1,
    httpGet: async (url) => {
      urls.push(url);
      return { status: 200, data: { channel: '33', currencyCode: 'ARS' }, headers: {} };
    },
    sleep: noSleep,
  });

  assert.deepEqual(out, { channel: 33, source: 'segments' });
  assert.deepEqual(urls, ['https://www.disco.com.ar/api/segments']);
});

test('resolveSalesChannel cae al canal configurado si la tienda no contesta', async () => {
  const out = await resolveSalesChannel('https://www.disco.com.ar', {
    fallback: 33,
    httpGet: async () => {
      throw { response: { status: 404 } };
    },
    sleep: noSleep,
  });

  assert.deepEqual(out, { channel: 33, source: 'fallback' });
});

test('resolveSalesChannel no acepta un canal ilegible', async () => {
  const out = await resolveSalesChannel('https://www.disco.com.ar', {
    fallback: 33,
    httpGet: async () => ({ status: 200, data: { channel: 'abc' }, headers: {} }),
    sleep: noSleep,
  });

  assert.deepEqual(out, { channel: 33, source: 'fallback' });
});

/* ------------------------- resolveCategoryTargets ------------------------- */

const countsFrom = (table) => {
  const asked = [];
  const countTotal = async (path) => {
    asked.push(path);
    if (!(path in table)) throw new Error(`path inesperado ${path}`);
    const value = table[path];
    if (value instanceof Error) throw value;
    return value;
  };
  return { asked, countTotal };
};

test('resolveCategoryTargets recorre un departamento que entra en la ventana sin bajar', async () => {
  const tree = [{ id: 3, name: 'Frutas', children: [{ id: 30, name: 'Sueltas', children: [] }] }];
  const { asked, countTotal } = countsFrom({ '/3/': 327 });

  const out = await resolveCategoryTargets(tree, { countTotal });

  assert.deepEqual(out.targets, [{ path: '/3/', name: 'Frutas', total: 327 }]);
  assert.deepEqual(asked, ['/3/']);
  assert.equal(out.complete, true);
});

/**
 * El bug latente de Josimar: `fq=C:/17/` (el hijo solo) devuelve 0 en VTEX; el hijo
 * se consulta con el path completo `/1/17/`. Con el id suelto, un departamento que
 * pasara la ventana se perdía entero y sin aviso.
 */
test('resolveCategoryTargets baja por path completo cuando el departamento no entra', async () => {
  const tree = [{
    id: 1,
    name: 'Almacén',
    children: [
      { id: 17, name: 'Aceites', children: [{ id: 134, name: 'Comunes', children: [] }] },
      { id: 18, name: 'Aderezos', children: [] },
    ],
  }];
  const { asked, countTotal } = countsFrom({ '/1/': 3524, '/1/17/': 167, '/1/18/': 97 });

  const out = await resolveCategoryTargets(tree, { countTotal });

  assert.deepEqual(asked, ['/1/', '/1/17/', '/1/18/']);
  assert.deepEqual(out.targets.map((t) => t.path), ['/1/17/', '/1/18/']);
});

test('resolveCategoryTargets saltea lo que no tiene productos disponibles', async () => {
  const tree = [
    { id: 20, name: 'Sin Categoría', children: [] },
    { id: 2, name: 'Bebidas', children: [] },
  ];
  const { countTotal } = countsFrom({ '/20/': 0, '/2/': 1349 });

  const out = await resolveCategoryTargets(tree, { countTotal });

  assert.deepEqual(out.targets.map((t) => t.path), ['/2/']);
});

test('resolveCategoryTargets recorre igual una hoja de total desconocido', async () => {
  // Sin header `resources` no se inventa un total: se pagina hasta la página vacía.
  const tree = [{ id: 2, name: 'Bebidas', children: [] }];
  const { countTotal } = countsFrom({ '/2/': null });

  const out = await resolveCategoryTargets(tree, { countTotal });

  assert.deepEqual(out.targets, [{ path: '/2/', name: 'Bebidas', total: null }]);
});

/**
 * Sin total no se sabe si el nodo entra en la ventana. Recorrerlo plano arriesga un
 * truncado que se repetiría en cada corrida; bajar a los hijos sólo cuesta un conteo
 * por hijo.
 */
test('resolveCategoryTargets baja a los hijos si no sabe el total de un nodo con hijos', async () => {
  const tree = [{ id: 2, name: 'Bebidas', children: [{ id: 21, name: 'Gaseosas', children: [] }] }];
  const { asked, countTotal } = countsFrom({ '/2/': null, '/2/21/': 90 });

  const out = await resolveCategoryTargets(tree, { countTotal });

  assert.deepEqual(asked, ['/2/', '/2/21/']);
  assert.deepEqual(out.targets, [{ path: '/2/21/', name: 'Gaseosas', total: 90 }]);
});

/**
 * Un producto colgado del departamento y no de ninguna subcategoría no lo alcanza
 * ninguna consulta de los hijos. No se lo puede recorrer, así que su precio no se
 * refresca y vencerlo es lo correcto: la corrida sigue siendo completa, pero lo dice.
 */
test('resolveCategoryTargets informa los productos que cuelgan del padre y no de un hijo', async () => {
  const tree = [{
    id: 1,
    name: 'Almacén',
    children: [
      { id: 17, name: 'Aceites', children: [] },
      { id: 18, name: 'Aderezos', children: [] },
    ],
  }];
  const { countTotal } = countsFrom({ '/1/': 3000, '/1/17/': 2000, '/1/18/': 900 });

  const out = await resolveCategoryTargets(tree, { countTotal });

  assert.deepEqual(out.hanging, [{ path: '/1/', name: 'Almacén', count: 100 }]);
  assert.equal(out.rootTotal, 3000);
  assert.equal(out.complete, true);
});

test('resolveCategoryTargets marca la hoja que no entra en la ventana como incompleta', async () => {
  const tree = [{ id: 9, name: 'Hogar', children: [] }];
  const { countTotal } = countsFrom({ '/9/': 7296 });

  const out = await resolveCategoryTargets(tree, { countTotal });

  assert.deepEqual(out.targets, [{ path: '/9/', name: 'Hogar', total: 7296 }]);
  assert.deepEqual(out.oversized, [{ path: '/9/', name: 'Hogar', total: 7296 }]);
  assert.equal(out.complete, false, 'desde acá el recorrido pierde 4.746 productos');
});

test('resolveCategoryTargets sigue con los hermanos si un conteo falla', async () => {
  const tree = [
    { id: 1, name: 'Almacén', children: [] },
    { id: 2, name: 'Bebidas', children: [] },
  ];
  const { countTotal } = countsFrom({ '/1/': new Error('HTTP 500'), '/2/': 1349 });

  const out = await resolveCategoryTargets(tree, { countTotal });

  assert.deepEqual(out.targets.map((t) => t.path), ['/2/']);
  assert.deepEqual(out.failed, [{ path: '/1/', name: 'Almacén', error: 'HTTP 500' }]);
  assert.equal(out.complete, false);
});

test('resolveCategoryTargets propaga el aborto en vez de tragárselo', async () => {
  const tree = [{ id: 1, name: 'Almacén', children: [] }];
  const abort = Object.assign(new Error('racha de fallos'), { catalogAbort: true });
  const { countTotal } = countsFrom({ '/1/': abort });

  await assert.rejects(resolveCategoryTargets(tree, { countTotal }), /racha de fallos/);
});

test('resolveCategoryTargets respeta el tope de nodos y lo declara', async () => {
  const tree = [1, 2, 3].map((id) => ({ id, name: `D${id}`, children: [] }));
  const { asked, countTotal } = countsFrom({ '/1/': 10, '/2/': 10, '/3/': 10 });

  const out = await resolveCategoryTargets(tree, { countTotal, maxNodes: 2 });

  assert.deepEqual(asked, ['/1/', '/2/']);
  assert.equal(out.truncatedByCap, true);
  assert.equal(out.complete, false);
});

/* -------------------------------- walkTarget ------------------------------ */

const pager = (total, { failAt = null } = {}) => {
  const froms = [];
  const fetchPage = async (path, from) => {
    froms.push(from);
    if (from === failAt) throw new Error(`HTTP 500 en ${from}`);
    const count = Math.max(0, Math.min(PAGE_SIZE, total - from));
    return {
      products: Array.from({ length: count }, (_, i) => ({ n: from + i })),
      total,
    };
  };
  return { froms, fetchPage };
};

test('walkTarget pagina hasta el total y no pide de más', async () => {
  const { froms, fetchPage } = pager(120);
  const seen = [];

  const out = await walkTarget({ path: '/3/', total: 120 }, {
    fetchPage,
    onBatch: async (batch) => seen.push(...batch),
    sleep: noSleep,
  });

  assert.deepEqual(froms, [0, 50, 100]);
  assert.equal(seen.length, 120);
  assert.deepEqual(out, { fetched: 120, truncated: false });
});

test('walkTarget corta en la página corta aunque no sepa el total', async () => {
  const { froms, fetchPage } = pager(70);

  const out = await walkTarget({ path: '/3/', total: null }, {
    fetchPage: async (path, from) => ({ ...(await fetchPage(path, from)), total: null }),
    onBatch: noSleep,
    sleep: noSleep,
  });

  assert.deepEqual(froms, [0, 50]);
  assert.equal(out.fetched, 70);
});

test('walkTarget llega hasta _from=2500 y declara el truncado', async () => {
  const { froms, fetchPage } = pager(3000);

  const out = await walkTarget({ path: '/9/', total: 3000 }, { fetchPage, onBatch: noSleep, sleep: noSleep });

  assert.equal(froms.at(-1), 2500, 'la última página pedida es la del tope');
  assert.ok(!froms.includes(2550), 'nunca pide un _from que VTEX rechaza con 400');
  assert.deepEqual(out, { fetched: 2550, truncated: true });
});

test('walkTarget propaga la falla de una página (ya guardó las anteriores)', async () => {
  const { fetchPage } = pager(200, { failAt: 100 });
  const seen = [];

  await assert.rejects(
    walkTarget({ path: '/3/', total: 200 }, { fetchPage, onBatch: async (b) => seen.push(...b), sleep: noSleep }),
    /HTTP 500 en 100/
  );
  assert.equal(seen.length, 100);
});

/* ---------------------------- scrapeVtexCatalog --------------------------- */

/**
 * Un VTEX falso en memoria. `catalog` mapea path de categoría → lista de EAN; un EAN
 * puede estar en varias categorías (como en VTEX). `fail` mapea path → cuántas veces
 * falla antes de responder (Infinity = siempre).
 */
function fakeVtex({ tree, catalog, channel = '33', fail = {}, failPages = {}, segmentsDown = false }) {
  const requests = [];
  const failures = { ...fail };
  const pageFailures = { ...failPages };
  const raw = (ean) => {
    const p = byEan(PALTA);
    p.productId = `id-${ean}`;
    p.items[0].ean = ean;
    return p;
  };
  const httpGet = async (url) => {
    requests.push(url);
    const u = new URL(url);
    if (u.pathname === '/api/segments') {
      if (segmentsDown) throw { response: { status: 500 } };
      return { status: 200, data: { channel }, headers: {} };
    }
    if (u.pathname.endsWith('/category/tree/3')) return { status: 200, data: tree, headers: {} };

    const fqs = u.searchParams.getAll('fq');
    const cat = fqs.find((f) => f.startsWith('C:'))?.slice(2) ?? null;
    const eanFilter = fqs.filter((f) => f.startsWith('alternateIds_Ean:')).map((f) => f.split(':')[1]);
    if (cat && failures[cat] > 0) {
      failures[cat]--;
      throw { response: { status: 500 } };
    }
    // `failPages` falla sólo las páginas, no los conteos (`_to=0`).
    if (cat && u.searchParams.get('_to') !== '0' && pageFailures[cat] > 0) {
      pageFailures[cat]--;
      throw { response: { status: 500 } };
    }
    let eans;
    if (eanFilter.length) eans = Object.values(catalog).flat().filter((e) => eanFilter.includes(e));
    else if (cat) eans = Object.entries(catalog).filter(([p]) => p.startsWith(cat)).flatMap(([, e]) => e);
    else eans = Object.values(catalog).flat();
    eans = [...new Set(eans)];

    const from = Number(u.searchParams.get('_from'));
    const to = Number(u.searchParams.get('_to'));
    const page = eans.slice(from, to + 1).map(raw);
    return {
      status: 206,
      data: page,
      headers: { resources: `${from}-${to}/${eans.length}` },
    };
  };
  return { httpGet, requests };
}

const TREE = [
  { id: 1, name: 'Almacén', children: [] },
  { id: 2, name: 'Bebidas', children: [] },
  { id: 5, name: 'Limpieza', children: [] },
];

const baseOptions = (vtex, extra = {}) => ({
  merchantName: 'Disco',
  baseUrl: 'https://www.disco.com.ar',
  source: 'disco',
  salesChannel: 33,
  onlyAvailable: true,
  httpGet: vtex.httpGet,
  sleep: noSleep,
  getMerchantId: async () => 7,
  ...extra,
});

const collector = () => {
  const saved = [];
  return {
    saved,
    onProductFound: async (product, merchantId) => {
      saved.push({ ean: product.ean, merchantId });
      return { saved: true };
    },
  };
};

test('scrapeVtexCatalog recorre el árbol entero y reporta una corrida completa', async () => {
  const vtex = fakeVtex({
    tree: TREE,
    catalog: { '/1/': ['a1', 'a2', 'a3'], '/2/': ['b1'], '/5/': ['c1', 'c2'] },
  });
  const { saved, onProductFound } = collector();

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound }));

  assert.equal(out.success, true);
  assert.equal(out.complete, true);
  assert.equal(out.strategy, 'catalog');
  assert.equal(out.salesChannel, 33);
  assert.equal(out.expectedTotal, 6);
  assert.equal(out.totalProducts, 6);
  assert.equal(out.savedProducts, 6);
  assert.deepEqual(out.failedCategories, []);
  assert.deepEqual(saved.map((s) => s.ean).sort(), ['a1', 'a2', 'a3', 'b1', 'c1', 'c2']);
  assert.ok(saved.every((s) => s.merchantId === 7));
});

test('scrapeVtexCatalog manda el canal y el filtro de disponibilidad en cada consulta de productos', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'], '/2/': ['b1'], '/5/': ['c1'] } });

  await scrapeVtexCatalog(baseOptions(vtex, { onProductFound: null }));

  const searches = vtex.requests.filter((u) => u.includes('/products/search'));
  assert.ok(searches.length > 0);
  for (const url of searches) {
    assert.match(url, /[?&]sc=33&/);
    assert.match(url, /fq=isAvailablePerSalesChannel_33:1/);
  }
});

test('scrapeVtexCatalog sigue al canal que publica la tienda aunque el configurado sea otro', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'] }, channel: '35' });

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound: null }));

  assert.equal(out.salesChannel, 35);
  assert.ok(vtex.requests.filter((u) => u.includes('/products/search')).every((u) => u.includes('sc=35')));
});

test('scrapeVtexCatalog usa el canal configurado si /api/segments no contesta', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'] }, segmentsDown: true });

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound: null }));

  assert.equal(out.success, true);
  assert.equal(out.salesChannel, 33);
});

test('scrapeVtexCatalog falla, no reporta éxito, si el canal no tiene nada disponible', async () => {
  // Es la firma de un canal mal resuelto: con éxito vacío, Laravel barrería todo.
  const vtex = fakeVtex({ tree: TREE, catalog: {} });
  const { saved, onProductFound } = collector();

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound }));

  assert.equal(out.success, false);
  assert.equal(out.complete, false);
  assert.match(out.error, /canal 33/);
  assert.equal(saved.length, 0);
});

test('scrapeVtexCatalog guarda cada EAN una sola vez aunque cuelgue de dos categorías', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['x', 'a1'], '/2/': ['x'], '/5/': ['c1'] } });
  const { saved, onProductFound } = collector();

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound }));

  assert.deepEqual(saved.map((s) => s.ean).sort(), ['a1', 'c1', 'x']);
  assert.equal(out.totalProducts, 3);
  assert.equal(out.rawProducts, 4);
});

test('scrapeVtexCatalog: una categoría caída no tira la corrida pero la deja incompleta', async () => {
  const vtex = fakeVtex({
    tree: TREE,
    catalog: { '/1/': ['a1'], '/2/': ['b1'], '/5/': ['c1'] },
    fail: { '/2/': Infinity },
  });
  const { saved, onProductFound } = collector();

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound }));

  assert.equal(out.success, true, 'los precios que llegaron se guardaron');
  assert.equal(out.complete, false, 'pero no se puede inferir ninguna ausencia');
  assert.deepEqual(out.failedCategories.map((c) => c.path), ['/2/']);
  assert.deepEqual(saved.map((s) => s.ean).sort(), ['a1', 'c1']);
});

test('scrapeVtexCatalog reintenta al final las categorías que fallaron sueltas', async () => {
  // Falla 3 veces: el conteo agota sus 3 intentos y la categoría queda caída; la pasada
  // final la encuentra recuperada. Un 500 pasajero no tiene por qué pausar el vencimiento.
  const vtex = fakeVtex({
    tree: TREE,
    catalog: { '/1/': ['a1'], '/2/': ['b1'], '/5/': ['c1'] },
    fail: { '/2/': 3 },
  });
  const { saved, onProductFound } = collector();

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound }));

  assert.equal(out.complete, true);
  assert.deepEqual(out.failedCategories, []);
  assert.deepEqual(saved.map((s) => s.ean).sort(), ['a1', 'b1', 'c1']);
});

test('scrapeVtexCatalog aborta ante una racha de categorías caídas (bloqueo del WAF)', async () => {
  const tree = [1, 2, 3, 4, 5].map((id) => ({ id, name: `D${id}`, children: [] }));
  const vtex = fakeVtex({
    tree,
    catalog: { '/1/': ['a'], '/2/': ['b'], '/3/': ['c'], '/4/': ['d'], '/5/': ['e'] },
    fail: { '/1/': Infinity, '/2/': Infinity, '/3/': Infinity, '/4/': Infinity, '/5/': Infinity },
  });

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound: null }));

  assert.equal(out.success, false);
  assert.equal(out.complete, false);
  assert.ok(out.aborted, 'el aborto queda diagnosticado');
  const counted = vtex.requests.filter((u) => /fq=C:\/[45]\//.test(u));
  assert.equal(counted.length, 0, 'no sigue golpeando después del aborto');
});

test('scrapeVtexCatalog en modo eans consulta sólo esos EANs y nunca se declara completa', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1', 'a2'], '/2/': ['b1'] } });
  const { saved, onProductFound } = collector();

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound, mode: 'eans', eans: ['a2', 'b1', 'zz'] }));

  assert.equal(out.success, true);
  assert.equal(out.complete, false, 'una lista de EANs no recorre el catálogo');
  assert.deepEqual(saved.map((s) => s.ean).sort(), ['a2', 'b1']);
  assert.ok(!vtex.requests.some((u) => u.includes('category/tree')));
});

test('scrapeVtexCatalog en modo eans sin EANs falla en vez de reportar un éxito vacío', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'] } });

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound: null, mode: 'eans', eans: [] }));

  assert.equal(out.success, false);
  assert.match(out.error, /PRODUCT_EANS/);
});

test('scrapeVtexCatalog sin handler es una corrida en seco: no busca el comercio', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'] } });
  let asked = false;

  const out = await scrapeVtexCatalog(baseOptions(vtex, {
    onProductFound: null,
    getMerchantId: async () => {
      asked = true;
      return 7;
    },
  }));

  assert.equal(asked, false);
  assert.equal(out.totalProducts, 1);
  assert.equal(out.savedProducts, 0);
});

test('scrapeVtexCatalog sin canal ni filtro (Josimar) deja que el host elija su canal', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'] } });

  const out = await scrapeVtexCatalog(baseOptions(vtex, {
    salesChannel: null,
    onlyAvailable: false,
    onProductFound: null,
  }));

  assert.equal(out.success, true);
  assert.equal(out.salesChannel, null);
  assert.ok(!vtex.requests.some((u) => u.includes('/api/segments')));
  assert.ok(vtex.requests.filter((u) => u.includes('/products/search')).every((u) => !u.includes('sc=') && !u.includes('isAvailable')));
});

test('scrapeVtexCatalog con categoryPaths recorre sólo esas (corrida acotada)', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'], '/2/': ['b1'] } });
  const { saved, onProductFound } = collector();

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound, categoryPaths: ['/2/'] }));

  assert.deepEqual(saved.map((s) => s.ean), ['b1']);
  assert.equal(out.complete, false, 'recorrer parte del árbol no es recorrer el catálogo');
  assert.ok(!vtex.requests.some((u) => u.includes('category/tree')));
});

test('scrapeVtexCatalog cuenta los productos que se descartan (sin EAN o sin precio)', async () => {
  const vtex = fakeVtex({ tree: TREE, catalog: { '/1/': ['a1', ''] } });

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound: null }));

  assert.equal(out.discardedProducts, 1);
  assert.equal(out.totalProducts, 1);
});

/**
 * La pasada final arranca de cero: una racha de fallos del final del recorrido no
 * puede sumarse con el primer reintento y abortar una corrida que ya guardó casi
 * todos sus precios. Laravel la vería como "error" en vez de "incompleta".
 */
test('scrapeVtexCatalog no arrastra la racha de fallos a la pasada final', async () => {
  const vtex = fakeVtex({
    tree: TREE,
    catalog: { '/1/': ['a1'], '/2/': ['b1'], '/5/': ['c1'] },
    failPages: { '/2/': Infinity, '/5/': Infinity },
  });

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound: null }));

  assert.equal(out.success, true);
  assert.equal(out.aborted, null);
  assert.deepEqual(out.failedCategories.map((c) => c.path).sort(), ['/2/', '/5/']);
});

test('scrapeVtexCatalog dice por qué una corrida no es completa', async () => {
  const caida = await scrapeVtexCatalog(baseOptions(
    fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'], '/2/': ['b1'], '/5/': ['c1'] }, fail: { '/2/': Infinity } }),
    { onProductFound: null }
  ));
  assert.deepEqual(caida.incompleteReasons, ['failed_categories']);

  const eans = await scrapeVtexCatalog(baseOptions(
    fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'] } }),
    { onProductFound: null, mode: 'eans', eans: ['a1'] }
  ));
  assert.deepEqual(eans.incompleteReasons, ['eans_mode']);

  const acotada = await scrapeVtexCatalog(baseOptions(
    fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'] } }),
    { onProductFound: null, categoryPaths: ['/1/'] }
  ));
  assert.deepEqual(acotada.incompleteReasons, ['partial']);

  const tope = await scrapeVtexCatalog(baseOptions(
    fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'], '/2/': ['b1'], '/5/': ['c1'] } }),
    { onProductFound: null, maxCategoryNodes: 2 }
  ));
  assert.equal(tope.truncatedByCap, true);
  assert.deepEqual(tope.incompleteReasons, ['node_cap']);

  const sana = await scrapeVtexCatalog(baseOptions(
    fakeVtex({ tree: TREE, catalog: { '/1/': ['a1'] } }),
    { onProductFound: null }
  ));
  assert.equal(sana.complete, true);
  assert.deepEqual(sana.incompleteReasons, []);
});

test('scrapeVtexCatalog informa lo que el árbol no alcanza, sin declarar la corrida incompleta', async () => {
  // El catálogo declara 3 productos pero los departamentos suman 2: uno no cuelga de
  // ninguna categoría del árbol (Josimar tiene ~28 así).
  const tree = [{ id: 1, name: 'Almacén', children: [] }];
  const vtex = fakeVtex({ tree, catalog: { '/1/': ['a1', 'a2'], '/9/': ['fuera'] } });

  const out = await scrapeVtexCatalog(baseOptions(vtex, { onProductFound: null }));

  assert.equal(out.expectedTotal, 3);
  assert.equal(out.unreachableProducts, 1);
  assert.equal(out.complete, true);
});

/* ------------------- el hash de GraphQL deja de ser obligatorio ------------------- */


const withoutHash = (code) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: join(__dirname, '..'),
    // Vacío y no ausente: dotenv no pisa una variable ya definida, así que esto le
    // gana al .env local.
    env: { ...process.env, VTEX_SHA256_HASH: '' },
    encoding: 'utf8',
  });

test('sin VTEX_SHA256_HASH el core de GraphQL se importa igual (el servicio levanta)', () => {
  // Antes el throw al importar tumbaba el proceso entero —productos, promos,
  // sucursales— por la falta de un dato que sólo usa el modo `search`.
  const out = withoutHash("await import('./cores/vtex.js'); await import('./cores/vtexCatalog.js'); console.log('ok');");

  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ok/);
});

test('sin VTEX_SHA256_HASH el modo search aborta con un diagnóstico claro, sin salir a la red', () => {
  const out = withoutHash(`
    const { fetchVtexProducts } = await import('./cores/vtex.js');
    try {
      await fetchVtexProducts('https://no-existe.invalid', 'leche', 'disco');
      console.log('no-abort');
    } catch (err) {
      console.log(JSON.stringify({ abort: err.vtexAbort === true, message: err.message }));
    }
  `);

  assert.equal(out.status, 0, out.stderr);
  const result = JSON.parse(out.stdout.trim().split('\n').at(-1));
  assert.equal(result.abort, true);
  assert.match(result.message, /VTEX_SHA256_HASH/);
});
