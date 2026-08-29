// scrapper-script/scraper-tests/cencosud-promos.test.js
//
// Tests unitarios del core compartido de promociones bancarias de Cencosud
// (`cores/cencosudBankDiscounts.js`) y de los tres wrappers que lo usan:
// Disco, Jumbo y Vea. No pegan a la red: usan el fixture
// cencosud-bank-discounts.json, un recorte REAL del Master Data (entidad "JN",
// documento bankDiscount) tomado el 2026-08-29.
//
// El fixture son 15 de las 193 promociones del documento, elegidas para cubrir:
//   - 2 exclusivas de `veaargentina` (para probar que NO entran en Disco)
//   - 12 de `discoargentina`: 8 vigentes y 4 vencidas
//   - filas que declaran `jumboargentina` + `jumboargentinaio` a la vez, y una
//     que declara sólo `jumboargentina`
//   - una que además trae los valores `disco`/`vea` a secas (que NO son
//     `discoargentina`/`veaargentina`)
//   - los sufijos de `discountText` que importan: "", "%", "cuotas sin interés",
//     "Cuotas sin interés", ",6 y 12 Cuotas sin Interés", "% y 3 cuotas sin
//     interés", "CSI o 15% y 12CSI" y "mil $"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  appliesToWebsites,
  buildDiscountLabel,
  buildExternalId,
  buildTitle,
  formatAmount,
  mapBanks,
  mapDays,
  normalizePromotion,
  normalizePromotions,
  splitDiscount,
  toDate,
  toStartDate,
  toEndDate,
  unwrapDocument,
} from '../cores/cencosudBankDiscounts.js';

import {
  appliesToDisco,
  normalizeDiscoPromotion,
  normalizeDiscoPromotions,
} from '../scrapers/promos/disco.js';

import {
  appliesToJumbo,
  normalizeJumboPromotions,
} from '../scrapers/promos/jumbo_promos.js';

import { normalizeVeaPromotions } from '../scrapers/promos/vea.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/cencosud-bank-discounts.json'), 'utf8')
);

/**
 * Referencia temporal FIJA. El filtro de vencidas compara contra `now`, así que
 * sin inyectarlo el test se pondría rojo solo con el paso del tiempo (varias
 * promos "vigentes" del fixture vencen el 2026-08-31 / 2026-09-01).
 */
const NOW = new Date('2026-08-29T00:00:00Z');

const sitesOf = (r) =>
  [...new Set((r.websites || []).map((w) => String(w).trim().toLowerCase()))].sort();
const byText = (text) => records.find((r) => r.discountText === text);

/* --------------------------------- fixture -------------------------------- */

test('el fixture cubre los casos que importan', () => {
  assert.equal(records.length, 15);
  assert.equal(records.filter(appliesToDisco).length, 12, '12 de Disco (vigentes + vencidas)');
  assert.equal(
    records.filter((r) => !appliesToDisco(r)).length,
    3,
    '3 que no son de Disco'
  );
  assert.ok(
    records.some((r) => sitesOf(r).join() === 'veaargentina'),
    'debe haber al menos una exclusiva de Vea'
  );
  assert.ok(
    records.some((r) => sitesOf(r).includes('jumboargentina') && sitesOf(r).includes('jumboargentinaio')),
    'debe haber al menos una declarada en los dos sitios de Jumbo'
  );
});

/* ------------------------------ unwrapDocument ---------------------------- */

test('unwrapDocument hace el doble parse (value es un string con JSON adentro)', () => {
  const promos = [{ discount: '20.00' }, { discount: '15.00' }];

  // Forma real del endpoint: `value` es un STRING con JSON adentro.
  assert.deepEqual(unwrapDocument({ id: 'abc', value: JSON.stringify(promos) }), promos);
  // Si algún día lo devolvieran ya parseado, también funciona.
  assert.deepEqual(unwrapDocument({ value: promos }), promos);
});

test('unwrapDocument devuelve [] ante basura en vez de tirar', () => {
  assert.deepEqual(unwrapDocument({ value: 'no-es-json{' }), []);
  assert.deepEqual(unwrapDocument({ value: '{"a":1}' }), [], 'JSON válido pero no array');
  assert.deepEqual(unwrapDocument({}), []);
  assert.deepEqual(unwrapDocument(null), []);
});

test('unwrapDocument sobre el fixture reconstruye las 15 promociones', () => {
  assert.equal(unwrapDocument({ id: 'doc', value: JSON.stringify(records) }).length, 15);
});

/* -------------------- concatenación número + sufijo (CRÍTICO) ------------- */

/**
 * ⚠️ EL test del archivo. `discount` y `discountText` NO son dos datos
 * independientes: son el NÚMERO y su SUFIJO, y la tarjeta los muestra
 * CONCATENADOS. Leerlos por separado inventa promociones que no existen —
 * un discount=3 con texto "cuotas sin interés" son TRES CUOTAS, no un 3%.
 */
test('buildDiscountLabel concatena número + sufijo', () => {
  assert.equal(
    buildDiscountLabel({ discount: '3.00', discountText: 'cuotas sin interés' }),
    '3 cuotas sin interés',
    'sufijo que empieza con letra ⇒ va con espacio'
  );
  assert.equal(
    buildDiscountLabel({ discount: '20.00', discountText: '%' }),
    '20%',
    'sufijo "%" ⇒ va pegado'
  );
  assert.equal(
    buildDiscountLabel({ discount: '20.00', discountText: '' }),
    '20%',
    'sufijo vacío ⇒ el % es implícito'
  );
  assert.equal(
    buildDiscountLabel({ discount: '3.00', discountText: ',6 y 12 Cuotas sin Interés' }),
    '3,6 y 12 Cuotas sin Interés',
    'sufijo que empieza con coma ⇒ va pegado (son 3, 6 y 12 cuotas)'
  );
  assert.equal(
    buildDiscountLabel({ discount: '25.00', discountText: '% y 3 cuotas sin interés' }),
    '25% y 3 cuotas sin interés',
    'sufijo mixto ⇒ va pegado y conserva las dos partes'
  );
});

test('buildDiscountLabel sobre los registros REALES del fixture', () => {
  assert.equal(buildDiscountLabel(byText('%')), '20%');
  assert.equal(buildDiscountLabel(byText('% y 3 cuotas sin interés')), '25% y 3 cuotas sin interés');
  assert.equal(buildDiscountLabel(byText('cuotas sin interés')), '3 cuotas sin interés');
  assert.equal(
    buildDiscountLabel(byText(',6 y 12 Cuotas sin Interés')),
    '3,6 y 12 Cuotas sin Interés'
  );
  assert.equal(buildDiscountLabel(byText('CSI o 15% y 12CSI')), '18 CSI o 15% y 12CSI');
  // Caso real que no es ni % ni cuotas: $100 mil de reintegro.
  assert.equal(buildDiscountLabel(byText('mil $')), '100 mil $');
});

test('formatAmount imita el formato de la tarjeta', () => {
  assert.equal(formatAmount('3.00'), '3');
  assert.equal(formatAmount('12.50'), '12.5');
  assert.equal(formatAmount('0'), null);
  assert.equal(formatAmount('no'), null);
});

test('buildDiscountLabel sin número devuelve el sufijo tal cual', () => {
  assert.equal(buildDiscountLabel({ discount: '0', discountText: 'Cuotas sin interés' }), 'Cuotas sin interés');
  assert.equal(buildDiscountLabel({}), null);
  assert.equal(buildDiscountLabel(null), null);
});

/* -------------------------------- splitDiscount --------------------------- */

test('splitDiscount: sufijo vacío o que empieza con "%" ⇒ porcentaje', () => {
  assert.deepEqual(splitDiscount({ discount: '20.00', discountText: '' }), { porcentaje: 20, cuotas: null });
  assert.deepEqual(splitDiscount({ discount: '20.00', discountText: '%' }), { porcentaje: 20, cuotas: null });
  assert.deepEqual(splitDiscount({ discount: '25.00', discountText: '% de reintegro' }), {
    porcentaje: 25,
    cuotas: null,
  });
});

test('splitDiscount: sufijo con "cuota"/"CSI" (sin % adelante) ⇒ cuotas', () => {
  assert.deepEqual(splitDiscount({ discount: '3.00', discountText: 'cuotas sin interés' }), {
    porcentaje: null,
    cuotas: 3,
  });
  assert.deepEqual(splitDiscount({ discount: '12.00', discountText: 'Cuotas Sin Interés' }), {
    porcentaje: null,
    cuotas: 12,
  });
  assert.deepEqual(splitDiscount({ discount: '18.00', discountText: 'CSI o 15% y 12CSI' }), {
    porcentaje: null,
    cuotas: 18,
  });
});

/**
 * La regla de oro: el mismo número no puede ser a la vez un % y una cantidad
 * de cuotas. Ante la duda se deja null y la IA resuelve leyendo `etiqueta`.
 */
test('splitDiscount NUNCA devuelve porcentaje y cuotas a la vez', () => {
  for (const raw of records) {
    const { porcentaje, cuotas } = splitDiscount(raw);
    assert.ok(
      porcentaje === null || cuotas === null,
      `ambos completos en ${JSON.stringify(raw.discountText)}: ${porcentaje}/${cuotas}`
    );
  }

  // El caso mixto real: "% y 3 cuotas..." arranca con "%", así que el número es
  // el PORCENTAJE (25) y las cuotas quedan en null.
  const mixto = splitDiscount(byText('% y 3 cuotas sin interés'));
  assert.equal(mixto.porcentaje, 25);
  assert.equal(mixto.cuotas, null);
});

/**
 * "100" + "mil $" es un reintegro de $100.000, ni un 100% ni 100 cuotas.
 * Es exactamente el caso que justifica preferir el null explícito.
 */
test('splitDiscount deja todo en null ante un sufijo que no desambigua', () => {
  assert.deepEqual(splitDiscount(byText('mil $')), { porcentaje: null, cuotas: null });
  assert.deepEqual(splitDiscount({ discount: '18.00', discountText: 'y 18' }), {
    porcentaje: null,
    cuotas: null,
  });
  assert.deepEqual(splitDiscount({ discount: '0', discountText: '%' }), { porcentaje: null, cuotas: null });
  assert.deepEqual(splitDiscount(null), { porcentaje: null, cuotas: null });
});

/* ------------------------- filtro por website (CRÍTICO) ------------------- */

test('appliesToWebsites acepta un string o una lista', () => {
  const raw = { websites: ['jumboargentinaio'] };
  assert.equal(appliesToWebsites(raw, 'jumboargentinaio'), true);
  assert.equal(appliesToWebsites(raw, ['jumboargentina', 'jumboargentinaio']), true);
  assert.equal(appliesToWebsites(raw, ['jumboargentina']), false);
  assert.equal(appliesToWebsites(raw, []), false, 'sin sitios pedidos no aplica nada');
  assert.equal(appliesToWebsites(null, ['jumboargentinaio']), false);
});

test('appliesToWebsites tolera mayúsculas y espacios', () => {
  assert.equal(appliesToWebsites({ websites: ['  DiscoArgentina '] }, ['discoargentina']), true);
});

/**
 * ⚠️ La comparación es EXACTA, no un `includes()`. El dataset trae los valores
 * `disco` y `vea` a secas además de `discoargentina`/`veaargentina`, y no son el
 * mismo sitio: un match por substring haría que `disco` arrastre promos ajenas.
 */
test('appliesToDisco exige "discoargentina", no un "disco" cualquiera', () => {
  assert.equal(appliesToDisco({ websites: ['discoargentina'] }), true);
  assert.equal(appliesToDisco({ websites: ['disco'] }), false, '"disco" a secas NO es el sitio');
  assert.equal(appliesToDisco({ websites: ['veaargentina'] }), false);
  assert.equal(appliesToDisco({ websites: [] }), false);
});

/**
 * El requisito explícito: una promo exclusiva de Vea no puede filtrarse a Disco.
 */
test('una promo de SÓLO veaargentina no entra en Disco ni en Jumbo', () => {
  const soloVea = records.filter((r) => sitesOf(r).join() === 'veaargentina');
  assert.ok(soloVea.length >= 2, 'el fixture debe traer exclusivas de Vea');

  for (const raw of soloVea) {
    assert.equal(appliesToDisco(raw), false, `se coló en Disco: ${raw.discountText}`);
    assert.equal(appliesToJumbo(raw), false, `se coló en Jumbo: ${raw.discountText}`);
  }

  // Y tampoco aparecen en el resultado normalizado de Disco.
  const idsDisco = new Set(normalizeDiscoPromotions(records, NOW).map((p) => p.external_id));
  for (const raw of soloVea) {
    assert.ok(
      !idsDisco.has(buildExternalId(raw, 'disco')),
      'una exclusiva de Vea llegó al lote de Disco'
    );
  }

  // Control en el sentido inverso: en Vea sí están.
  const idsVea = new Set(normalizeVeaPromotions(records, NOW).map((p) => p.external_id));
  for (const raw of soloVea) {
    assert.ok(idsVea.has(buildExternalId(raw, 'vea')), 'una exclusiva de Vea NO llegó a Vea');
  }
});

test('cada cadena recorta el fixture a lo suyo', () => {
  assert.equal(normalizeDiscoPromotions(records, NOW).length, 8);
  assert.equal(normalizeJumboPromotions(records, NOW).length, 8);
  assert.equal(normalizeVeaPromotions(records, NOW).length, 8);
});

/* ------------------- Jumbo: unión de sus dos sitios + dedupe -------------- */

/**
 * Jumbo se publica bajo DOS ids de sitio. Filtrar por uno solo pierde promos de
 * la otra vitrina, así que el wrapper consulta los dos.
 */
test('Jumbo acepta jumboargentina Y jumboargentinaio', () => {
  assert.equal(appliesToJumbo({ websites: ['jumboargentina'] }), true);
  assert.equal(appliesToJumbo({ websites: ['jumboargentinaio'] }), true);
  assert.equal(appliesToJumbo({ websites: ['discoargentina'] }), false);

  // En el fixture hay una promo declarada SÓLO en jumboargentina: si el filtro
  // usara únicamente la tienda online, esta se perdería.
  const soloJa = records.find(
    (r) => sitesOf(r).includes('jumboargentina') && !sitesOf(r).includes('jumboargentinaio')
  );
  assert.ok(soloJa, 'el fixture debe traer una promo sólo de jumboargentina');
  assert.ok(
    normalizeJumboPromotions(records, NOW).some(
      (p) => p.external_id === buildExternalId(soloJa, 'jumbo')
    )
  );
});

/**
 * ⚠️ Contra la intuición, una fila que declara los dos sitios NO se duplica:
 * es UNA fila que enumera sus sitios, y el filtro la deja pasar una sola vez.
 * Este test fija ese comportamiento para que nadie "arregle" un problema
 * inexistente duplicando el recorrido por sitio.
 */
test('una fila declarada en los DOS sitios de Jumbo produce UNA sola promo', () => {
  const ambos = records.find(
    (r) => sitesOf(r).includes('jumboargentina') && sitesOf(r).includes('jumboargentinaio')
  );
  assert.ok(ambos, 'el fixture debe traer una promo en los dos sitios de Jumbo');

  const promos = normalizeJumboPromotions([ambos], NOW);
  assert.equal(promos.length, 1);
});

/**
 * El dedupe real: dos FILAS distintas con el mismo contenido, una por sitio.
 * Construcción sintética a partir de un registro real — el documento completo
 * trae 193 filas y sólo 191 fingerprints distintos, o sea que el caso existe.
 */
test('dos filas equivalentes, una por sitio de Jumbo, colapsan en una', () => {
  const ambos = records.find(
    (r) => sitesOf(r).includes('jumboargentina') && sitesOf(r).includes('jumboargentinaio')
  );

  const enTienda = { ...ambos, websites: ['jumboargentina'] };
  const enOnline = { ...ambos, websites: ['jumboargentinaio'] };

  // Control: por separado, cada una entra.
  assert.equal(normalizeJumboPromotions([enTienda], NOW).length, 1);
  assert.equal(normalizeJumboPromotions([enOnline], NOW).length, 1);

  // Juntas, son la misma promoción.
  const promos = normalizeJumboPromotions([enTienda, enOnline], NOW);
  assert.equal(promos.length, 1, 'la misma promo entró dos veces a la cola');
  assert.equal(promos[0].external_id, buildExternalId(ambos, 'jumbo'));
});

test('duplicar el lote entero no duplica la salida', () => {
  assert.equal(normalizeJumboPromotions([...records, ...records], NOW).length, 8);
  assert.equal(normalizeDiscoPromotions([...records, ...records], NOW).length, 8);
});

/* ------------------------- estabilidad de buildExternalId ----------------- */

test('buildExternalId es ESTABLE: mismo input ⇒ mismo id', () => {
  for (const raw of records) {
    const a = buildExternalId(raw, 'disco');
    const b = buildExternalId(JSON.parse(JSON.stringify(raw)), 'disco');
    assert.equal(a, b, 'el id cambió entre dos llamadas con el mismo input');
    assert.match(a, /^disco-[0-9a-f]{12}$/);
  }
});

/**
 * Sin esto, cada corrida crearía filas nuevas en `promotion_for_processes` y se
 * volvería a pagar la normalización por IA de promociones ya procesadas.
 */
test('buildExternalId ignora priority y stores (varían sin cambiar la promo)', () => {
  const raw = records[0];
  assert.equal(
    buildExternalId(raw, 'disco'),
    buildExternalId({ ...raw, priority: 999, stores: ['x', 'y', 'z'] }, 'disco'),
    'la operación diaria no debe generar un external_id nuevo'
  );
});

test('buildExternalId ignora los websites (es lo que permite el dedupe de Jumbo)', () => {
  const raw = records[0];
  assert.equal(
    buildExternalId(raw, 'jumbo'),
    buildExternalId({ ...raw, websites: ['jumboargentinaio'] }, 'jumbo')
  );
});

test('buildExternalId es DISTINTO para promociones distintas', () => {
  const ids = records.map((r) => buildExternalId(r, 'disco'));
  assert.equal(new Set(ids).size, ids.length, `external_id colisionado: ${ids}`);

  const base = { banks: [{ name: 'ICBC' }], discount: '20.00', dateEnd: '1' };
  assert.notEqual(buildExternalId(base, 'disco'), buildExternalId({ ...base, discount: '15.00' }, 'disco'));
});

/**
 * El prefijo separa el namespace por cadena: la MISMA promo compartida entre
 * Disco, Jumbo y Vea entra como tres filas, una por merchant.
 */
test('el prefijo separa el namespace de cada cadena', () => {
  const raw = records.find(appliesToDisco);

  const disco = buildExternalId(raw, 'disco');
  const jumbo = buildExternalId(raw, 'jumbo');
  const vea = buildExternalId(raw, 'vea');

  assert.ok(disco.startsWith('disco-'));
  assert.ok(jumbo.startsWith('jumbo-'));
  assert.ok(vea.startsWith('vea-'));
  assert.equal(new Set([disco, jumbo, vea]).size, 3);

  // Pero el hash de fondo es el mismo: sólo cambia el prefijo.
  assert.equal(disco.slice('disco-'.length), jumbo.slice('jumbo-'.length));
});

/* ------------------------------ filtro de vencidas ------------------------ */

test('normalizePromotions filtra las vencidas (con `now` fijo)', () => {
  const promos = normalizeDiscoPromotions(records, NOW);
  const cutoff = Math.floor(NOW.getTime() / 1000);

  const vencidas = records.filter((r) => appliesToDisco(r) && Number(r.dateEnd) < cutoff);
  assert.equal(vencidas.length, 4, 'control del fixture: 4 vencidas de Disco');
  assert.equal(promos.length, 8, '12 de Disco − 4 vencidas');

  for (const p of promos) {
    assert.ok(p.end_date >= '2026-08-29', `promo vencida en el resultado: ${p.end_date}`);
  }

  const idsVencidas = vencidas.map((r) => buildExternalId(r, 'disco'));
  for (const id of idsVencidas) {
    assert.ok(!promos.some((p) => p.external_id === id), 'una vencida llegó al resultado');
  }
});

/**
 * Si la función ignorara el parámetro `now`, las tres corridas darían lo mismo
 * y el test pasaría por casualidad hasta que el reloj lo rompiera.
 */
test('normalizePromotions respeta el `now` inyectado (no la hora real)', () => {
  const enero2023 = normalizeDiscoPromotions(records, new Date('2023-01-01T00:00:00Z'));
  const hoy = normalizeDiscoPromotions(records, NOW);
  const futuro = normalizeDiscoPromotions(records, new Date('2030-01-01T00:00:00Z'));

  assert.equal(enero2023.length, 12, 'al 2023 todavía no había vencido ninguna');
  assert.equal(hoy.length, 8);
  assert.equal(futuro.length, 0, 'en 2030 no queda ninguna vigente');
});

test('las promos sin dateEnd no se descartan por vencimiento', () => {
  const sinFin = { ...records.find(appliesToDisco), dateEnd: null, discount: '77.00', discountText: '%' };
  const promos = normalizeDiscoPromotions([sinFin], NOW);

  assert.equal(promos.length, 1);
  assert.equal(promos[0].end_date, null, 'no se inventa una fecha de fin');
});

test('normalizePromotions no explota con entradas no-array', () => {
  const opts = { websites: ['discoargentina'], source: 'disco', externalIdPrefix: 'disco', now: NOW };
  assert.deepEqual(normalizePromotions(null, opts), []);
  assert.deepEqual(normalizePromotions(undefined, opts), []);
  assert.deepEqual(normalizePromotions({}, opts), []);
  assert.deepEqual(normalizePromotions([], opts), []);
});

/* --------------------------- días, bancos, fechas ------------------------- */

test('mapDays traduce 1..7 a nombres en español y descarta lo que no entiende', () => {
  assert.deepEqual(mapDays(['1', '4']), ['lunes', 'jueves']);
  assert.deepEqual(mapDays([1, 2, 3, 4, 5, 6, 7]), [
    'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo',
  ]);
  assert.deepEqual(mapDays(['0', '8', '99', '', null, 'lunes']), []);
  assert.deepEqual(mapDays(['1', '1', 1]), ['lunes'], 'dedupe');
  assert.deepEqual(mapDays(null), []);
  assert.deepEqual(mapDays('1,4'), [], 'un string no es un array de días');
});

test('mapBanks acepta objetos {name} y strings sueltos', () => {
  assert.deepEqual(mapBanks([{ name: 'ICBC' }, { name: 'Macro' }]), ['ICBC', 'Macro']);
  assert.deepEqual(mapBanks(['ICBC', 'Macro']), ['ICBC', 'Macro']);
  assert.deepEqual(mapBanks([{ name: '  Tarjeta Naranja X' }]), ['Tarjeta Naranja X'], 'trim');
  assert.deepEqual(mapBanks([{ name: 'ICBC' }, 'ICBC']), ['ICBC'], 'dedupe');
  assert.deepEqual(mapBanks([{}, null, { name: '' }]), []);
  assert.deepEqual(mapBanks(null), []);
});

/**
 * ⚠️ Cencosud usa las 23:59 ART como centinela de "último día de vigencia".
 * Leído en UTC eso cae al día siguiente y corre `end_date`, que es lo que
 * alimenta el filtro de overlap mensual del lado de Laravel.
 */
test('toDate interpreta el timestamp en hora argentina, no en UTC', () => {
  assert.equal(toDate(1788231540), '2026-08-31', '23:59 ART del 31/08, no el 01/09');
  assert.equal(toDate(1785898800), '2026-08-05', '00:00 ART no se corre');
  assert.equal(toDate('1645412340'), '2022-02-20', 'también como string');
});

test('toDate nunca inventa una fecha', () => {
  assert.equal(toDate(0), null);
  assert.equal(toDate(-1), null);
  assert.equal(toDate(null), null);
  assert.equal(toDate('no-es-fecha'), null);
});

test('buildTitle pega la etiqueta y los bancos, con fallbacks', () => {
  assert.equal(
    buildTitle({ discount: '3.00', discountText: 'cuotas sin interés', banks: [{ name: 'ICBC' }, { name: 'Macro' }] }),
    '3 cuotas sin interés — ICBC, Macro'
  );
  assert.equal(buildTitle({ installmentsText: 'en Toda la Compra Online' }), 'en Toda la Compra Online');
  assert.equal(buildTitle({}), 'Promoción bancaria');
});

/* ------------------------------ contrato emitido -------------------------- */

test('normalizePromotion emite el contrato completo', () => {
  const raw = byText('%');
  const p = normalizeDiscoPromotion(raw);

  assert.equal(p.source, 'disco');
  assert.match(p.external_id, /^disco-[0-9a-f]{12}$/);
  assert.equal(p.etiqueta, '20%');
  assert.equal(p.descuento_porcentaje, 20);
  assert.equal(p.cuotas, null);
  assert.deepEqual(p.bancos, mapBanks(raw.banks));
  assert.deepEqual(p.dias, mapDays(raw.days));
  assert.deepEqual(p.medios_de_pago, Object.keys(raw.paymentMethod));
  assert.equal(p.start_date, toDate(raw.dateStart));
  assert.equal(p.end_date, toDate(raw.dateEnd));
  assert.equal(p.exclusiva, raw.isExclusive === true);
  assert.equal(p.solo_checkout, raw.checkout === true);
  assert.equal(typeof p.sucursales, 'number');
});

test('el mismo registro cambia sólo source y external_id según la cadena', () => {
  const raw = records.find(appliesToDisco);

  const disco = normalizePromotion(raw, { source: 'disco', externalIdPrefix: 'disco' });
  const jumbo = normalizePromotion(raw, { source: 'jumbo', externalIdPrefix: 'jumbo' });

  assert.equal(disco.source, 'disco');
  assert.equal(jumbo.source, 'jumbo');
  assert.notEqual(disco.external_id, jumbo.external_id);

  const { source: _s1, external_id: _e1, ...restoDisco } = disco;
  const { source: _s2, external_id: _e2, ...restoJumbo } = jumbo;
  assert.deepEqual(restoDisco, restoJumbo, 'el resto del contrato no depende de la cadena');
});

/**
 * Una promo de cuotas leída como porcentaje sería un dato falso publicado.
 */
test('una promo de cuotas NO se lee como porcentaje', () => {
  const p = normalizeDiscoPromotion(byText('cuotas sin interés'));

  assert.equal(p.etiqueta, '3 cuotas sin interés');
  assert.equal(p.cuotas, 3, 'son 3 CUOTAS');
  assert.equal(p.descuento_porcentaje, null, 'y NO un 3% de descuento');
});

test('normalizePromotion recorta info y legales a 4000 chars', () => {
  const p = normalizeDiscoPromotion({ info: 'x'.repeat(9000), legals: 'y'.repeat(9000) });
  assert.equal(p.info.length, 4000);
  assert.equal(p.legales.length, 4000);
});


/* --------------------------- toStartDate / toEndDate ---------------------- */

test('toEndDate nombra el dia que CIERRA: 23:59 ART es ese mismo dia', () => {
  // 1788231540 = 2026-08-31 23:59 ART (= 2026-09-01 02:59 UTC)
  assert.equal(toEndDate(1788231540), '2026-08-31');
});

test('toStartDate nombra el dia que ABRE: 23:59 ART es el dia siguiente', () => {
  // Misma frontera de medianoche, leida al reves. Sin esta regla, 25 de las 193
  // filas del dataset arrancaban un dia antes de lo real y 2 de ellas cruzaban
  // el borde de mes, ensanchando el filtro de overlap mensual hacia atras.
  assert.equal(toStartDate(1788231540), '2026-09-01');
});

test('toStartDate no toca los inicios grabados a las 00:00 ART', () => {
  // 1785898800 = 2026-08-05 00:00 ART. Es el caso de 152 de las 193 filas.
  assert.equal(toStartDate(1785898800), '2026-08-05');
  assert.equal(toEndDate(1785898800), '2026-08-05');
});

test('toStartDate nunca inventa una fecha', () => {
  for (const v of [0, -1, null, undefined, '', 'x']) {
    assert.equal(toStartDate(v), null);
  }
});
