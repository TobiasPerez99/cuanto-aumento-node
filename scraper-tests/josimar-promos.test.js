// scrapper-script/scraper-tests/josimar-promos.test.js
//
// Tests unitarios de la parte PURA del scraper de promociones de Josimar
// (decodificación de etiquetas, parseo de vigencia, descarte de ruido y armado
// del contrato). No pegan a la red: usan dos fixtures reales.
//
// fixtures/josimar-flags.json
//   Recorte real de https://www.josimar.com.ar/files/flagsConfig-master.json
//   (12 de las 173 entradas), elegido para cubrir:
//     - el ruido interno ("INTERNA 345")
//     - las dos variantes del formato codificado ("porcentaje--" y "precio--")
//     - una entrada con la imagen truncada ("...:llevando2.")
//     - vigencias con guiones ("06-08 a 05-09"), con barras ("22/05 AL 28/05")
//       y con la "A" en mayúscula ("07-08 A 16-08")
//     - un título sin vigencia ("MACRITAS NACHOS REST STYLE 250GR 25%off")
//     - el flag DESACTUALIZADO de la colección 557 (dice "14-07 a 10-08"
//       cuando la etiqueta viva dice "14-07 a 08-09")
//     - el flagId 551 DUPLICADO con dos títulos distintos
//     - la entrada sin `flagId`
//
// fixtures/josimar-cluster-products.json
//   Respuestas reales de
//   /api/catalog_system/pub/products/search?fq=productClusterIds:{id}&_from=0&_to=4
//   para tres colecciones, recortadas a los campos que el scraper lee:
//     - 557: etiqueta viva en `clusterHighlights`, distinta de la del flag
//     - 565: etiqueta viva SÓLO en `productClusters` (no está en highlights)
//     - 385: etiqueta viva en formato codificado
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  slugify,
  parseFlags,
  decodeFlagLabel,
  isInternalNoise,
  parseValidity,
  toSampleProduct,
  productClusterIds,
  resolveClusterLabel,
  buildPromotion,
  parseResourcesTotal,
} from '../scrapers/promos/josimar.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8'));

const flagsPayload = read('josimar-flags.json');
const clusters = read('josimar-cluster-products.json');
const flagLabels = parseFlags(flagsPayload);

/**
 * Referencia temporal FIJA. `parseValidity` elige el año comparando contra
 * "hoy", así que sin inyectarla estos tests se pondrían rojos solos con el paso
 * del tiempo. Es la fecha en que se tomaron los fixtures.
 */
const NOW = new Date('2026-08-29T12:00:00Z');

/* ════════════════════════════════ parseFlags ══════════════════════════════════ */

test('parseFlags arma el diccionario clusterId → etiqueta', () => {
  assert.ok(flagLabels instanceof Map);
  assert.equal(flagLabels.get('345'), 'INTERNA 345');
  assert.equal(flagLabels.get('317'), 'FEMSA 15% DE DESCUENTO 06-08 a 05-09');
  assert.equal(flagLabels.get('534'), 'MACRITAS NACHOS REST STYLE 250GR 25%off');
});

test('parseFlags descarta la entrada sin flagId (hay 1 en el archivo real)', () => {
  const sinId = flagsPayload.master.flags.filter(
    (f) => f.flagId === null || f.flagId === undefined || String(f.flagId).trim() === ''
  );
  assert.equal(sinId.length, 1, 'control del fixture');

  // 12 entradas − 1 sin id − 1 duplicada de 551 = 10 ids únicos.
  assert.equal(flagLabels.size, 10);
  assert.ok(!flagLabels.has('undefined'));
  assert.ok(!flagLabels.has(''));
});

/**
 * El archivo real tiene 7 flagIds repetidos con títulos distintos (232, 270,
 * 322, 332, 440, 544, 551). No hay forma de saber cuál es el vigente, así que
 * gana la primera aparición — y da igual, porque el flag es sólo el ÚLTIMO
 * fallback: la etiqueta viva del catálogo tiene prioridad.
 */
test('parseFlags: ante flagId duplicado gana la PRIMERA aparición', () => {
  const duplicados = flagsPayload.master.flags.filter((f) => String(f.flagId) === '551');
  assert.equal(duplicados.length, 2, 'control del fixture');
  assert.equal(duplicados[0].__editorItemTitle, '35% DE DESCUENTO EN PRODUCTOS DE CCU');
  assert.equal(duplicados[1].__editorItemTitle, '35% DE DESCUENTO EN UNILEVER');

  assert.equal(flagLabels.get('551'), '35% DE DESCUENTO EN PRODUCTOS DE CCU');
});

test('parseFlags no explota con payloads rotos', () => {
  assert.equal(parseFlags(null).size, 0);
  assert.equal(parseFlags({}).size, 0);
  assert.equal(parseFlags({ master: {} }).size, 0);
  assert.equal(parseFlags({ master: { flags: 'no-es-array' } }).size, 0);
});

/* ═══════════════════════════════ decodeFlagLabel ══════════════════════════════ */

/**
 * ⚠️ Uno de los dos tests centrales del archivo. 54 de las 173 etiquetas vienen
 * con el formato interno `<tipo>--<valor>--<cantidad>--<alcance>---<TÍTULO>:<imagen>`.
 * Sin decodificarlo, el título de la promoción sería el string completo con el
 * prefijo numérico, ilegible para cualquiera que lo revise en el backoffice.
 */
test('decodeFlagLabel decodifica el formato "porcentaje--100--2--1---TITULO:img.png"', () => {
  const d = decodeFlagLabel('porcentaje--100--2--1---POWERADE COOL CITRUS 2X1:2X1.png');

  assert.equal(d.title, 'POWERADE COOL CITRUS 2X1', 'después del último "---" y antes del ":"');
  assert.equal(d.image, '2X1.png', 'lo que va después del ":"');
  assert.equal(d.encoded, true);
});

test('decodeFlagLabel decodifica también el prefijo "precio--"', () => {
  const d = decodeFlagLabel('precio--166667--6--todos---FEMSA LLEVANDO 6 ABONAS 4:llevando6.png');

  assert.equal(d.title, 'FEMSA LLEVANDO 6 ABONAS 4');
  assert.equal(d.image, 'llevando6.png');
  assert.equal(d.encoded, true);
});

test('decodeFlagLabel sobre las entradas REALES del fixture', () => {
  assert.equal(
    decodeFlagLabel(flagLabels.get('219')).title,
    'POWERADE COOL CITRUS 2X1'
  );
  assert.equal(
    decodeFlagLabel(flagLabels.get('375')).title,
    'FEMSA LLEVANDO 6 ABONAS 4'
  );

  // Entrada real con la imagen truncada ("...:llevando2." sin el "png").
  const truncada = decodeFlagLabel(flagLabels.get('414'));
  assert.equal(truncada.title, 'VASCO VIEJO BCO-TTO 750CC COMBINA LLEVANDO 2');
  assert.equal(truncada.image, 'llevando2.', 'se emite tal cual, no se completa');
});

test('decodeFlagLabel recorta el espacio que queda pegado al "---"', () => {
  // Caso real: "porcentaje--100--3--1--- BON O BON BLANCO/LECHE*1U COMBINA 3X2:3X2.png"
  const d = decodeFlagLabel('porcentaje--100--3--1--- BON O BON BLANCO/LECHE*1U COMBINA 3X2:3X2.png');
  assert.equal(d.title, 'BON O BON BLANCO/LECHE*1U COMBINA 3X2');
});

/**
 * Si no matchea el patrón se usa la etiqueta cruda. Recortar por el último
 * guión "por las dudas" rompería un título legítimo que casualmente lo tuviera.
 */
test('decodeFlagLabel devuelve la etiqueta cruda cuando NO matchea el patrón', () => {
  const limpio = decodeFlagLabel('FEMSA 15% DE DESCUENTO 06-08 a 05-09');
  assert.equal(limpio.title, 'FEMSA 15% DE DESCUENTO 06-08 a 05-09');
  assert.equal(limpio.image, null);
  assert.equal(limpio.encoded, false);

  // Prefijo desconocido ⇒ no se toca, aunque tenga "---".
  const raro = decodeFlagLabel('otracosa--1--2--3---TITULO:x.png');
  assert.equal(raro.title, 'otracosa--1--2--3---TITULO:x.png');
  assert.equal(raro.encoded, false);

  // Un título con guiones sueltos tampoco se recorta.
  const conGuiones = decodeFlagLabel('VASCO VIEJO BCO-TTO 750CC');
  assert.equal(conGuiones.title, 'VASCO VIEJO BCO-TTO 750CC');
  assert.equal(conGuiones.encoded, false);
});

test('decodeFlagLabel no explota con vacíos', () => {
  assert.deepEqual(decodeFlagLabel(null), { title: null, image: null, encoded: false });
  assert.deepEqual(decodeFlagLabel(''), { title: null, image: null, encoded: false });
  assert.deepEqual(decodeFlagLabel('   '), { title: null, image: null, encoded: false });
});

/* ═══════════════════════════════ isInternalNoise ══════════════════════════════ */

/**
 * El criterio es a propósito ANGOSTO: sólo la etiqueta que se autodenomina
 * interna. Ampliarlo a nombres de rubro sería adivinar cuál colección es promo
 * y cuál es catalogación — la heurística frágil que este scraper vino a evitar.
 */
test('isInternalNoise descarta las colecciones internas del operador', () => {
  assert.equal(isInternalNoise('INTERNA 345'), true, 'el título del flag');
  assert.equal(isInternalNoise('OFERTAS INTERNA'), true, 'la etiqueta viva de la MISMA colección 345');
  assert.equal(isInternalNoise('interna 999'), true, 'sin importar mayúsculas');
  assert.equal(isInternalNoise('OFERTAS INTERNAS'), true, 'también en plural');
});

test('isInternalNoise trata la etiqueta ausente como ruido (no hay qué normalizar)', () => {
  assert.equal(isInternalNoise(null), true);
  assert.equal(isInternalNoise(undefined), true);
  assert.equal(isInternalNoise(''), true);
  assert.equal(isInternalNoise('   '), true);
});

test('isInternalNoise NO descarta promociones ni colecciones de catalogación', () => {
  const conservar = [
    'CERVEZAS 20% OFF 14-07 a 08-09',
    'SEMANA DEL DESCUENTAZO',
    '15off visa master amex',
    '🥤 Bebidas + sorpresas para tu hogar',
    'Frescos, Yogures y Lacteos',
    'Selección de Lácteos y Frescos',
    'MERCADERIA INTERNACIONAL',
  ];

  for (const label of conservar) {
    assert.equal(isInternalNoise(label), false, `descartó de más: ${label}`);
  }
});

/* ═══════════════════════════════ parseValidity ════════════════════════════════ */

/**
 * ⚠️ El otro test central. Las promos de Dia caen TODAS en `needs_review` con
 * motivo `dates_defaulted` porque su catálogo no expone vigencia. Acá muchos
 * títulos la traen embebida, y parsearla es lo que permite que esas promos se
 * publiquen solas.
 */
test('parseValidity extrae "DD-MM a DD-MM" del título', () => {
  assert.deepEqual(parseValidity('CERVEZAS 20% OFF 14-07 a 08-09', NOW), {
    start_date: '2026-07-14',
    end_date: '2026-09-08',
  });
});

test('parseValidity acepta las variantes reales de separador y conector', () => {
  // Guiones + "a" minúscula.
  assert.deepEqual(parseValidity('FEMSA 15% DE DESCUENTO 06-08 a 05-09', NOW), {
    start_date: '2026-08-06',
    end_date: '2026-09-05',
  });

  // Guiones + "A" mayúscula.
  assert.deepEqual(parseValidity('GILLETTE 30% OFF 07-08 A 16-08', NOW), {
    start_date: '2026-08-07',
    end_date: '2026-08-16',
  });

  // Barras + "AL".
  assert.deepEqual(parseValidity('ALWAYS 30%OFF 22/05 AL 28/05', NOW), {
    start_date: '2026-05-22',
    end_date: '2026-05-28',
  });

  // Barras + "al" con la palabra "DEL" adelante.
  assert.deepEqual(parseValidity('40% DE DESCUENTO JOSIMAR SALE DEL 11/05 AL 17/05', NOW), {
    start_date: '2026-05-11',
    end_date: '2026-05-17',
  });
});

test('parseValidity tolera el doble espacio interno de los títulos reales', () => {
  // Caso real de la colección 210: "FEMSA 20% DE DESCUENTO  06-08 a 05-09".
  assert.deepEqual(parseValidity('FEMSA 20% DE DESCUENTO  06-08 a 05-09', NOW), {
    start_date: '2026-08-06',
    end_date: '2026-09-05',
  });
});

/**
 * ⚠️ EL caso difícil de la regla del año: el rango que cruza diciembre-enero.
 *
 * "Asumir el año en curso" daría 2026-12-20 → 2027-01-10 leyéndolo el 5 de
 * enero de 2026, o sea una promo a once meses vista. La regla de cercanía elige
 * la ubicación que CONTIENE a la fecha de referencia.
 *
 * (Hoy ningún título del archivo real cruza el año; el test fija la regla para
 * cuando aparezca, que es exactamente cuando nadie va a estar mirando.)
 */
test('parseValidity resuelve el rango que CRUZA fin de año', () => {
  // Leído el 5 de enero: la promo arrancó en DICIEMBRE DEL AÑO ANTERIOR.
  assert.deepEqual(
    parseValidity('FIESTAS 30% OFF 20-12 a 10-01', new Date('2026-01-05T12:00:00Z')),
    { start_date: '2025-12-20', end_date: '2026-01-10' }
  );

  // Leído el 28 de diciembre: la MISMA promo arrancó este año y termina el que viene.
  assert.deepEqual(
    parseValidity('FIESTAS 30% OFF 20-12 a 10-01', new Date('2026-12-28T12:00:00Z')),
    { start_date: '2026-12-20', end_date: '2027-01-10' }
  );
});

test('parseValidity elige el año más cercano a la referencia inyectada', () => {
  const titulo = 'PROMO 22/05 AL 28/05';

  // En agosto de 2026 el rango más cercano es el de mayo de 2026 (ya vencido).
  assert.deepEqual(parseValidity(titulo, NOW), {
    start_date: '2026-05-22',
    end_date: '2026-05-28',
  });

  // En febrero de 2026 sigue siendo mayo de 2026, pero ahora por venir.
  assert.deepEqual(parseValidity(titulo, new Date('2026-02-01T00:00:00Z')), {
    start_date: '2026-05-22',
    end_date: '2026-05-28',
  });

  // En enero de 2027 gana mayo DE 2027: está a 132 días en el futuro, contra los
  // 227 días que hace que terminó el de mayo de 2026. La regla mira la distancia
  // real a la referencia, no si el rango es pasado o futuro.
  assert.deepEqual(parseValidity(titulo, new Date('2027-01-10T00:00:00Z')), {
    start_date: '2027-05-22',
    end_date: '2027-05-28',
  });
});

test('parseValidity respeta la referencia inyectada (no la hora real)', () => {
  const titulo = 'PROMO 14-07 a 08-09';

  const a = parseValidity(titulo, new Date('2026-08-29T00:00:00Z'));
  const b = parseValidity(titulo, new Date('2031-08-29T00:00:00Z'));

  assert.equal(a.start_date, '2026-07-14');
  assert.equal(b.start_date, '2031-07-14');
  assert.notDeepEqual(a, b, 'si ignorara el parámetro las dos corridas darían lo mismo');
});

/**
 * ⚠️ Sin vigencia declarada se emite null en AMBAS fechas. NUNCA se inventa una:
 * el normalizador las completa por defecto y marca `dates_defaulted`, que es
 * información honesta; una fecha inventada publicaría una promo inexistente.
 */
test('parseValidity devuelve null cuando el título NO trae vigencia', () => {
  const vacio = { start_date: null, end_date: null };

  // Títulos reales sin fechas.
  assert.deepEqual(parseValidity('MACRITAS NACHOS REST STYLE 250GR 25%off', NOW), vacio);
  assert.deepEqual(parseValidity('SEMANA DEL DESCUENTAZO', NOW), vacio);
  assert.deepEqual(parseValidity('15off visa master amex', NOW), vacio);
  assert.deepEqual(parseValidity('🥤 Bebidas + sorpresas para tu hogar', NOW), vacio);
  assert.deepEqual(parseValidity('25% DE DESCUENTO QUILMES', NOW), vacio);

  // Una sola fecha NO es un rango.
  assert.deepEqual(parseValidity('NIVEA ROLL 30% OFF 02-07', NOW), vacio);

  assert.deepEqual(parseValidity(null, NOW), vacio);
  assert.deepEqual(parseValidity('', NOW), vacio);
});

test('parseValidity no confunde números sueltos con fechas', () => {
  const vacio = { start_date: null, end_date: null };

  // Título real: los números son días de la semana, no un rango de fechas.
  assert.deepEqual(
    parseValidity('☕🍵🧉 SÁBADO 21 - DOMINGO 22 - LUNES 23 YERBA 25% DE DTO☕🍵🧉', NOW),
    vacio
  );
  assert.deepEqual(parseValidity('🍷SABADO 11 - DOMINGO 12 VINOS 35% DESCUENTO 🍷', NOW), vacio);

  // El prefijo numérico del formato codificado tampoco es una fecha.
  assert.deepEqual(parseValidity('precio--166667--6--todos---FEMSA LLEVANDO 6 ABONAS 4', NOW), vacio);
});

test('parseValidity rechaza fechas inexistentes en vez de correrlas', () => {
  const vacio = { start_date: null, end_date: null };

  // 31 de febrero: `Date.UTC` rodaría al 3 de marzo sin avisar.
  assert.deepEqual(parseValidity('PROMO 31-02 a 05-03', NOW), vacio);
  // Mes 13.
  assert.deepEqual(parseValidity('PROMO 15-13 a 20-13', NOW), vacio);
  // Día 0.
  assert.deepEqual(parseValidity('PROMO 00-05 a 10-05', NOW), vacio);
});

test('parseValidity acepta un 29-02 sólo en el año bisiesto correcto', () => {
  // 2028 es bisiesto, 2026 y 2027 no ⇒ la única ubicación válida es 2028.
  assert.deepEqual(parseValidity('PROMO 29-02 a 05-03', new Date('2027-06-01T00:00:00Z')), {
    start_date: '2028-02-29',
    end_date: '2028-03-05',
  });
});

/* ═════════════════════════════ parseResourcesTotal ════════════════════════════ */

test('parseResourcesTotal lee el total del header "resources"', () => {
  assert.equal(parseResourcesTotal('0-4/609'), 609);
  assert.equal(parseResourcesTotal('0-0/0'), 0, 'colección vacía: no es un error');
  assert.equal(parseResourcesTotal('0-4/3092'), 3092);
});

test('parseResourcesTotal cae al largo de la página si el header falta', () => {
  assert.equal(parseResourcesTotal(undefined, 5), 5);
  assert.equal(parseResourcesTotal('', 5), 5);
  assert.equal(parseResourcesTotal('basura', 5), 5);
  assert.equal(parseResourcesTotal(null, 0), 0);
});

test('parseResourcesTotal sobre los headers REALES del fixture', () => {
  assert.equal(parseResourcesTotal(clusters['557'].resources), 28);
  assert.equal(parseResourcesTotal(clusters['565'].resources), 2);
  assert.equal(parseResourcesTotal(clusters['385'].resources), 6);
});

/* ══════════════════════════════ productClusterIds ═════════════════════════════ */

/**
 * ⚠️ `productClusters` es superconjunto de `clusterHighlights`. Descubrir sólo
 * con los highlights deja afuera la colección 244 ("15off visa master amex",
 * 3092 productos), la promo más grande del sitio.
 */
test('productClusterIds une los DOS mapas del producto', () => {
  const producto = clusters['565'].products[0];

  const soloHighlights = Object.keys(producto.clusterHighlights);
  const ids = productClusterIds(producto);

  assert.ok(!soloHighlights.includes('565'), 'control: 565 NO está en clusterHighlights');
  assert.ok(Object.keys(producto.productClusters).includes('565'), 'control: sí está en productClusters');
  assert.ok(ids.has('565'), 'y productClusterIds lo encuentra igual');

  for (const id of soloHighlights) assert.ok(ids.has(id));
});

test('productClusterIds no explota con productos incompletos', () => {
  assert.equal(productClusterIds(null).size, 0);
  assert.equal(productClusterIds({}).size, 0);
  assert.equal(productClusterIds({ clusterHighlights: null, productClusters: 'x' }).size, 0);
});

/* ═════════════════════════════ resolveClusterLabel ════════════════════════════ */

/**
 * ⚠️ flagsConfig está DESACTUALIZADO. El flag de la colección 557 dice que la
 * promo termina el 10-08; la etiqueta viva del catálogo dice 08-09. Quedarse
 * con el flag habría publicado la promo como vencida casi un mes antes.
 */
test('resolveClusterLabel prefiere la etiqueta VIVA por sobre el flag desactualizado', () => {
  assert.equal(
    flagLabels.get('557'),
    'AGUAS/CERVEZAS/GASEOSAS 33% OFF 14-07 a 10-08',
    'control del fixture: el flag dice 10-08'
  );

  const { label, kind } = resolveClusterLabel('557', clusters['557'].products, flagLabels);

  assert.equal(label, 'AGUAS/CERVEZAS/GASEOSAS 33% OFF 14-07 a 08-09', 'lo vivo dice 08-09');
  assert.equal(kind, 'highlight');
});

test('resolveClusterLabel cae a productClusters cuando no hay highlight', () => {
  const { label, kind } = resolveClusterLabel('565', clusters['565'].products, flagLabels);

  assert.equal(kind, 'cluster');
  assert.equal(
    label,
    'Leche La Serenísima UAT (entera 3% - descremada 1%) Edge 1 lt. IMBATIBLES',
    'con el doble espacio interno del original ya colapsado'
  );
});

test('resolveClusterLabel usa el flag sólo como ÚLTIMO recurso', () => {
  const { label, kind } = resolveClusterLabel('317', [], flagLabels);

  assert.equal(label, 'FEMSA 15% DE DESCUENTO 06-08 a 05-09');
  assert.equal(kind, 'flag');
});

test('resolveClusterLabel devuelve null si nadie conoce la colección', () => {
  assert.deepEqual(resolveClusterLabel('999999', [], flagLabels), { label: null, kind: null });
  assert.deepEqual(resolveClusterLabel('999999', null, undefined), { label: null, kind: null });
});

/* ═══════════════════════════════ toSampleProduct ══════════════════════════════ */

test('toSampleProduct incluye el EAN (es la PK del catálogo)', () => {
  const sample = toSampleProduct(clusters['557'].products[0]);

  assert.equal(sample.ean, '7792799000011');
  // ⚠️ `productId` de Josimar viene como STRING ("6574"), no como número.
  // Se pasa tal cual, sin castear: el contrato lo consume una IA, no una FK.
  assert.equal(sample.id, '6574');
  assert.equal(typeof sample.name, 'string');
  assert.equal(sample.price, 1382.88);
  assert.equal(sample.list_price, 2064, 'el "tachado" sale de PriceWithoutDiscount');
});

/**
 * ⚠️ `ListPrice` de VTEX viene con un multiplicador erróneo (ver el CLAUDE.md
 * del scraper). Acá los dos valores coinciden, así que el test fija la fuente
 * del dato explícitamente para que un cambio a `ListPrice` se note.
 */
test('toSampleProduct NUNCA lee ListPrice', () => {
  const producto = clusters['557'].products[0];
  const offer = producto.items[0].sellers[0].commertialOffer;

  const conListPriceRoto = {
    ...producto,
    items: [
      {
        ...producto.items[0],
        sellers: [
          {
            ...producto.items[0].sellers[0],
            commertialOffer: { ...offer, ListPrice: 999999 },
          },
        ],
      },
    ],
  };

  assert.equal(toSampleProduct(conListPriceRoto).list_price, 2064);
});

test('toSampleProduct no explota con productos incompletos', () => {
  assert.deepEqual(toSampleProduct(null), {
    ean: null,
    id: null,
    name: null,
    brand: null,
    price: null,
    list_price: null,
  });
  assert.deepEqual(toSampleProduct({ items: [] }).ean, null);
});

/* ═════════════════════════════════ buildPromotion ═════════════════════════════ */

const collection = (id, extra = {}) => {
  const { label, kind } = resolveClusterLabel(id, clusters[id].products, flagLabels);
  return {
    clusterId: id,
    label,
    kind,
    productCount: parseResourcesTotal(clusters[id].resources),
    products: clusters[id].products,
    ...extra,
  };
};

test('buildPromotion emite el contrato completo (colección 557, datos reales)', () => {
  const promo = buildPromotion(collection('557'), NOW);

  assert.equal(promo.external_id, 'josimar-c-557');
  assert.equal(promo.slug, 'aguas-cervezas-gaseosas-33-off-14-07-a-08-09-557');
  assert.equal(promo.title, 'AGUAS/CERVEZAS/GASEOSAS 33% OFF 14-07 a 08-09');
  assert.equal(promo.source, 'josimar');
  assert.equal(promo.promotion_kind, 'highlight');
  assert.equal(promo.cluster_id, '557');
  assert.equal(promo.product_count, 28, 'sale del header resources, no del largo de la página');
  assert.equal(promo.badge_image, null, 'la etiqueta no venía codificada');

  // La vigencia parseada del título: esto es lo que evita el `dates_defaulted`.
  assert.equal(promo.start_date, '2026-07-14');
  assert.equal(promo.end_date, '2026-09-08');

  assert.equal(promo.sample_products.length, 5);
  for (const sample of promo.sample_products) {
    assert.equal(typeof sample.ean, 'string');
    assert.ok(sample.ean.length > 0, 'cada sample debe traer su EAN');
  }
});

test('buildPromotion decodifica la etiqueta codificada y guarda la cruda', () => {
  const promo = buildPromotion(collection('385'), NOW);

  assert.equal(promo.title, 'FEMSA LLEVANDO 6 ABONAS 5', 'título legible');
  assert.equal(
    promo.raw_label,
    'precio--216667--6--todos---FEMSA LLEVANDO 6 ABONAS 5:llevando6.png',
    'la etiqueta cruda se preserva entera para que la lea el normalizador de IA'
  );
  assert.equal(promo.badge_image, 'llevando6.png');
  assert.equal(promo.product_count, 6);

  // Este título no declara vigencia ⇒ null, no una fecha inventada.
  assert.equal(promo.start_date, null);
  assert.equal(promo.end_date, null);
});

test('buildPromotion corta la muestra en 5 productos', () => {
  const muchos = collection('557', {
    products: [...clusters['557'].products, ...clusters['557'].products],
  });

  assert.equal(buildPromotion(muchos, NOW).sample_products.length, 5);
});

test('buildPromotion emite menos de 5 samples si la colección es chica', () => {
  const promo = buildPromotion(collection('565'), NOW);

  assert.equal(promo.product_count, 2);
  assert.equal(promo.sample_products.length, 2);
  assert.equal(promo.promotion_kind, 'cluster');
});

/**
 * El descarte del ruido pasa por `buildPromotion`, que devuelve null: la
 * colección 345 tiene 289 productos reales, así que sin el filtro entraría a la
 * cola de normalización por IA como si fuera una promoción.
 */
test('buildPromotion descarta el ruido interno (devuelve null)', () => {
  const ruidoFlag = {
    clusterId: '345',
    label: 'INTERNA 345',
    kind: 'flag',
    productCount: 289,
    products: clusters['557'].products,
  };
  assert.equal(buildPromotion(ruidoFlag, NOW), null);

  // Y también con la etiqueta VIVA de esa misma colección.
  const ruidoVivo = { ...ruidoFlag, label: 'OFERTAS INTERNA', kind: 'highlight' };
  assert.equal(buildPromotion(ruidoVivo, NOW), null);
});

test('buildPromotion descarta la colección sin etiqueta', () => {
  const sinEtiqueta = {
    clusterId: '999',
    label: null,
    kind: null,
    productCount: 10,
    products: [],
  };

  assert.equal(buildPromotion(sinEtiqueta, NOW), null);
});

test('buildPromotion detecta el ruido escondido DENTRO de una etiqueta codificada', () => {
  const promo = buildPromotion(
    {
      clusterId: '800',
      label: 'porcentaje--100--2--1---INTERNA PRUEBA:2X1.png',
      kind: 'flag',
      productCount: 3,
      products: [],
    },
    NOW
  );

  assert.equal(promo, null, 'el chequeo de ruido corre también sobre el título decodificado');
});

/* ═════════════════════════════════════ slug ═══════════════════════════════════ */

test('slugify colapsa emojis y acentos (los títulos reales los traen)', () => {
  assert.equal(slugify('🥤 Bebidas + sorpresas para tu hogar'), 'bebidas-sorpresas-para-tu-hogar');
  assert.equal(slugify('¡Todo perfumería con 15% OFF abonando con Visa Credito!'), 'todo-perfumeria-con-15-off-abonando-con-visa-credito');
  assert.equal(slugify('Selección de Lácteos y Frescos'), 'seleccion-de-lacteos-y-frescos');
});

test('el slug de una promoción es único por colección', () => {
  // Dos colecciones distintas comparten título ("SEMANA DEL DESCUENTAZO" en la
  // 388 y en la 517): el clusterId en el slug es lo que las mantiene separadas.
  const a = buildPromotion(
    { clusterId: '388', label: 'SEMANA DEL DESCUENTAZO', kind: 'highlight', productCount: 609, products: [] },
    NOW
  );
  const b = buildPromotion(
    { clusterId: '517', label: 'SEMANA DEL DESCUENTAZO', kind: 'highlight', productCount: 492, products: [] },
    NOW
  );

  assert.equal(a.title, b.title);
  assert.notEqual(a.slug, b.slug);
  assert.notEqual(a.external_id, b.external_id);
  assert.equal(a.external_id, 'josimar-c-388');
  assert.equal(b.external_id, 'josimar-c-517');
});
