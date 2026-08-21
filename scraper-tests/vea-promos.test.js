// scrapper-script/scraper-tests/vea-promos.test.js
//
// Tests unitarios de la parte PURA del scraper de promociones bancarias de Vea
// (normalización). No pegan a la red: usan el fixture vea-bank-discounts.json,
// un recorte real del Master Data de Cencosud (entidad "JN", doc bankDiscount).
//
// El fixture son 10 de las 193 promociones del documento, elegidas para cubrir:
//   - 9 de `veaargentina` y 1 que NO es de Vea (sólo discoargentina)
//   - 3 ya vencidas (dateEnd de 2022/2023 y una de 2026-08-01)
//   - los 5 formatos de `discountText` que importan: "", "%",
//     "cuotas sin interés", "% y 3 cuotas sin interés" y ",6 y 12 Cuotas sin Interés"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  toDate,
  mapDays,
  mapBanks,
  appliesToVea,
  buildExternalId,
  buildDiscountLabel,
  splitDiscount,
  buildTitle,
  normalizeVeaPromotion,
  normalizeVeaPromotions,
  unwrapDocument,
} from '../scrapers/promos/vea.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/vea-bank-discounts.json'), 'utf8')
);

/**
 * Referencia temporal FIJA. El filtro de vencidas compara contra `now`, así que
 * sin inyectarlo el test se pondría rojo solo con el paso del tiempo (las
 * promos "vigentes" del fixture vencen el 2026-09-01).
 */
const NOW = new Date('2026-08-21T00:00:00Z');

const find = (predicate) => records.find(predicate);
const byText = (text) => find((r) => r.discountText === text);

/* -------------------------------- fixture --------------------------------- */

test('el fixture cubre los casos que importan', () => {
  assert.equal(records.length, 10);
  assert.equal(records.filter(appliesToVea).length, 9, '9 de Vea');
  assert.equal(records.filter((r) => !appliesToVea(r)).length, 1, '1 que no es de Vea');
});

/* ------------------------------ unwrapDocument ---------------------------- */

test('unwrapDocument hace el doble parse (value es un string con JSON adentro)', () => {
  const promos = [{ discount: '20.00' }, { discount: '15.00' }];

  // Forma real del endpoint: `value` es un STRING.
  const desdeString = unwrapDocument({ id: 'abc', value: JSON.stringify(promos) });
  assert.deepEqual(desdeString, promos);
  assert.equal(desdeString.length, 2);

  // Si algún día lo devolvieran ya parseado, también funciona.
  assert.deepEqual(unwrapDocument({ value: promos }), promos);
});

test('unwrapDocument devuelve [] ante basura en vez de tirar', () => {
  assert.deepEqual(unwrapDocument({ value: 'no-es-json{' }), []);
  assert.deepEqual(unwrapDocument({ value: '{"a":1}' }), [], 'JSON válido pero no array');
  assert.deepEqual(unwrapDocument({}), []);
  assert.deepEqual(unwrapDocument(null), []);
  assert.deepEqual(unwrapDocument({ value: 42 }), []);
});

test('unwrapDocument sobre el fixture reconstruye las 10 promociones', () => {
  const payload = { id: 'doc', value: JSON.stringify(records) };
  assert.equal(unwrapDocument(payload).length, 10);
});

/* -------------------------------- appliesToVea ---------------------------- */

test('appliesToVea es true sólo si websites incluye veaargentina', () => {
  assert.equal(appliesToVea({ websites: ['veaargentina'] }), true);
  assert.equal(
    appliesToVea({ websites: ['jumboargentina', 'veaargentina', 'discoargentina'] }),
    true,
    'el account viene repetido una vez por sucursal'
  );
  assert.equal(appliesToVea({ websites: ['discoargentina', 'jumboargentina'] }), false);
  assert.equal(appliesToVea({ websites: [] }), false);
  assert.equal(appliesToVea({}), false);
  assert.equal(appliesToVea(null), false);
  // "vea" a secas NO es "veaargentina".
  assert.equal(appliesToVea({ websites: ['vea'] }), false);
});

test('appliesToVea tolera mayúsculas y espacios', () => {
  assert.equal(appliesToVea({ websites: ['  VeaArgentina '] }), true);
});

test('appliesToVea sobre los registros reales', () => {
  const noVea = find((r) => !appliesToVea(r));
  assert.ok(noVea, 'el fixture debe traer una promo que no es de Vea');
  assert.ok(!noVea.websites.includes('veaargentina'));
  assert.ok(noVea.websites.includes('discoargentina'));
});

/* ------------------------- buildDiscountLabel (CRÍTICO) ------------------- */

/**
 * ⚠️ EL test del archivo. `discount` y `discountText` NO son dos datos
 * independientes: son el NÚMERO y su SUFIJO, y la tarjeta los muestra
 * CONCATENADOS. Leerlos por separado inventa promociones que no existen —
 * un discount=3 con texto "cuotas sin interés" son TRES CUOTAS, no un 3%.
 */
test('buildDiscountLabel concatena número + sufijo (los 5 casos reales)', () => {
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

test('buildDiscountLabel formatea el número como la tarjeta', () => {
  assert.equal(buildDiscountLabel({ discount: '12.50', discountText: '%' }), '12.5%');
  assert.equal(buildDiscountLabel({ discount: '3.00', discountText: '' }), '3%');
});

test('buildDiscountLabel sin número devuelve el sufijo tal cual', () => {
  assert.equal(buildDiscountLabel({ discount: '0', discountText: 'Cuotas sin interés' }), 'Cuotas sin interés');
  assert.equal(buildDiscountLabel({ discountText: 'algo' }), 'algo');
  assert.equal(buildDiscountLabel({}), null);
  assert.equal(buildDiscountLabel(null), null);
});

test('buildDiscountLabel sobre los registros REALES del fixture', () => {
  assert.equal(buildDiscountLabel(byText('cuotas sin interés')), '3 cuotas sin interés');
  assert.equal(buildDiscountLabel(byText('%')), '20%');
  assert.equal(buildDiscountLabel(byText('')), '25%');
  assert.equal(
    buildDiscountLabel(byText(',6 y 12 Cuotas sin Interés')),
    '3,6 y 12 Cuotas sin Interés'
  );
  assert.equal(
    buildDiscountLabel(byText('% y 3 cuotas sin interés')),
    '25% y 3 cuotas sin interés'
  );
});

/* -------------------------------- splitDiscount --------------------------- */

test('splitDiscount: sufijo vacío o que empieza con "%" ⇒ porcentaje', () => {
  assert.deepEqual(splitDiscount({ discount: '20.00', discountText: '' }), {
    porcentaje: 20,
    cuotas: null,
  });
  assert.deepEqual(splitDiscount({ discount: '20.00', discountText: '%' }), {
    porcentaje: 20,
    cuotas: null,
  });
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
  assert.deepEqual(splitDiscount({ discount: '3.00', discountText: ',6 y 12 Cuotas sin Interés' }), {
    porcentaje: null,
    cuotas: 3,
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

  // Y explícitamente sobre el caso mixto: "% y 3 cuotas..." arranca con "%",
  // así que el número es el PORCENTAJE, y las cuotas quedan en null.
  const mixto = splitDiscount({ discount: '25.00', discountText: '% y 3 cuotas sin interés' });
  assert.equal(mixto.porcentaje, 25);
  assert.equal(mixto.cuotas, null);
});

test('splitDiscount deja todo en null ante sufijo ambiguo o sin número', () => {
  assert.deepEqual(splitDiscount({ discount: '18.00', discountText: 'y 18' }), {
    porcentaje: null,
    cuotas: null,
  });
  assert.deepEqual(splitDiscount({ discount: '0', discountText: '%' }), {
    porcentaje: null,
    cuotas: null,
  });
  assert.deepEqual(splitDiscount({}), { porcentaje: null, cuotas: null });
  assert.deepEqual(splitDiscount(null), { porcentaje: null, cuotas: null });
});

/* ----------------------------------- mapDays ------------------------------ */

test('mapDays traduce 1..7 a nombres en español', () => {
  assert.deepEqual(mapDays(['1']), ['lunes']);
  assert.deepEqual(mapDays(['4']), ['jueves']);
  assert.deepEqual(mapDays(['1', '4']), ['lunes', 'jueves']);
  assert.deepEqual(mapDays([1, 2, 3, 4, 5, 6, 7]), [
    'lunes',
    'martes',
    'miercoles',
    'jueves',
    'viernes',
    'sabado',
    'domingo',
  ]);
});

test('mapDays descarta valores fuera de rango en vez de adivinar', () => {
  assert.deepEqual(mapDays(['0', '8', '99', '', null, 'lunes']), []);
  assert.deepEqual(mapDays(['1', '0', '4', '8']), ['lunes', 'jueves']);
  assert.deepEqual(mapDays([]), []);
  assert.deepEqual(mapDays(null), []);
  assert.deepEqual(mapDays('1,4'), [], 'un string no es un array de días');
});

test('mapDays deduplica', () => {
  assert.deepEqual(mapDays(['1', '1', 1]), ['lunes']);
});

test('mapDays sobre el registro real con days ["1","4"]', () => {
  const raw = find((r) => Array.isArray(r.days) && r.days.join(',') === '1,4');
  assert.ok(raw, 'el fixture debe traer una promo con days ["1","4"]');
  assert.deepEqual(mapDays(raw.days), ['lunes', 'jueves']);
});

/* ---------------------------------- mapBanks ------------------------------ */

test('mapBanks acepta objetos {name} y strings sueltos', () => {
  assert.deepEqual(mapBanks([{ name: 'ICBC' }, { name: 'Macro' }]), ['ICBC', 'Macro']);
  assert.deepEqual(mapBanks(['ICBC', 'Macro']), ['ICBC', 'Macro']);
  assert.deepEqual(mapBanks([{ name: '  Tarjeta Naranja X' }]), ['Tarjeta Naranja X'], 'trim');
  assert.deepEqual(mapBanks([{ name: 'ICBC' }, 'ICBC']), ['ICBC'], 'dedupe');
  assert.deepEqual(mapBanks([{}, null, { name: '' }]), []);
  assert.deepEqual(mapBanks(null), []);
});

/* ----------------------------------- toDate ------------------------------- */

test('toDate convierte el timestamp Unix (segundos) a YYYY-MM-DD', () => {
  // 1645412340 = 2022-02-20 23:59 ART (= 2022-02-21 02:59 UTC).
  // La fecha correcta es la argentina: el 20, no el 21.
  assert.equal(toDate(1645412340), '2022-02-20');
  assert.equal(toDate('1645412340'), '2022-02-20', 'también como string');
});

test('toDate nunca inventa una fecha', () => {
  assert.equal(toDate(0), null);
  assert.equal(toDate(-1), null);
  assert.equal(toDate(null), null);
  assert.equal(toDate(undefined), null);
  assert.equal(toDate('no-es-fecha'), null);
});

/**
 * 🐞 BUG CONOCIDO — `end_date` sale UN DÍA TARDE. Este test NO valida el
 * comportamiento correcto: fija el actual para que el día que se arregle salte
 * en rojo y el arreglo sea consciente.
 *
 * Cencosud graba los timestamps en hora de Argentina (UTC-3) y usa las 23:59
 * locales como centinela de "último día". `toDate` los lee con `toISOString()`,
 * o sea en UTC, y esas 23:59 ART son las 02:59 UTC del día SIGUIENTE:
 *
 *   dateEnd = 1788231540 = 2026-08-31 23:59 ART = 2026-09-01 02:59 UTC
 *   toDate(...) devuelve '2026-09-01', pero la promo termina el '2026-08-31'.
 *
 * `dateStart` no se ve afectado (00:00 ART = 03:00 UTC, mismo día).
 * Afecta a 150 de las 193 promos del documento real (78%).
 * El arreglo es convertir a UTC-3 antes de recortar la fecha.
 */
test('toDate interpreta el timestamp en hora argentina, no en UTC', () => {
  // Cencosud usa las 23:59 ART como centinela de "último día de vigencia".
  // Leído en UTC esto sería 2026-09-01 02:59 y correría end_date un día.
  const finDeAgostoEnArgentina = 1788231540; // 2026-08-31 23:59 ART

  assert.equal(toDate(finDeAgostoEnArgentina), '2026-08-31');
});

test('toDate no corre dateStart (00:00 ART = 03:00 UTC, mismo día)', () => {
  const inicioDeAgostoEnArgentina = 1785898800; // 2026-08-05 00:00 ART

  assert.equal(toDate(inicioDeAgostoEnArgentina), '2026-08-05');
});

/* -------------------------------- buildExternalId ------------------------- */

test('buildExternalId es ESTABLE: mismo input ⇒ mismo id', () => {
  for (const raw of records) {
    const a = buildExternalId(raw);
    const b = buildExternalId(JSON.parse(JSON.stringify(raw)));
    assert.equal(a, b, 'el id cambió entre dos llamadas con el mismo input');
    assert.match(a, /^vea-[0-9a-f]{12}$/);
  }
});

test('buildExternalId es DISTINTO para promociones distintas', () => {
  const ids = records.map(buildExternalId);
  assert.equal(new Set(ids).size, ids.length, `external_id colisionado: ${ids}`);

  // Dos promos que sólo difieren en el porcentaje deben tener ids distintos.
  const base = { banks: [{ name: 'ICBC' }], discount: '20.00', dateEnd: '1' };
  assert.notEqual(
    buildExternalId(base),
    buildExternalId({ ...base, discount: '15.00' })
  );
});

test('buildExternalId ignora priority y stores (varían sin cambiar la promo)', () => {
  const raw = records[0];

  assert.equal(
    buildExternalId(raw),
    buildExternalId({ ...raw, priority: 999, stores: ['x', 'y', 'z'] }),
    'la operación diaria no debe generar un external_id nuevo'
  );
});

/* --------------------------------- buildTitle ----------------------------- */

test('buildTitle pega la etiqueta y los bancos', () => {
  const raw = byText('%');
  assert.equal(buildTitle(raw), '20% — MODO');

  assert.equal(
    buildTitle({ discount: '3.00', discountText: 'cuotas sin interés', banks: [{ name: 'ICBC' }, { name: 'Macro' }] }),
    '3 cuotas sin interés — ICBC, Macro'
  );
});

test('buildTitle cae a installmentsText y después a un genérico', () => {
  assert.equal(buildTitle({ installmentsText: 'en Toda la Compra Online' }), 'en Toda la Compra Online');
  assert.equal(buildTitle({}), 'Promoción bancaria');
});

/* ---------------------------- normalizeVeaPromotion ----------------------- */

test('normalizeVeaPromotion emite el contrato completo', () => {
  const raw = byText('%');
  const p = normalizeVeaPromotion(raw);

  assert.equal(p.source, 'vea');
  assert.match(p.external_id, /^vea-[0-9a-f]{12}$/);
  assert.equal(p.etiqueta, '20%');
  assert.equal(p.descuento_porcentaje, 20);
  assert.equal(p.cuotas, null);
  assert.deepEqual(p.bancos, ['MODO']);
  assert.deepEqual(p.dias, ['viernes']);
  assert.equal(p.start_date, '2026-07-01');
  assert.equal(p.end_date, '2026-09-01');
  assert.deepEqual(p.medios_de_pago, Object.keys(raw.paymentMethod));
  assert.equal(p.exclusiva, raw.isExclusive === true);
  assert.equal(p.solo_checkout, raw.checkout === true);
  assert.equal(typeof p.sucursales, 'number');
});

test('normalizeVeaPromotion: una promo de cuotas NO se lee como porcentaje', () => {
  const p = normalizeVeaPromotion(byText('cuotas sin interés'));

  assert.equal(p.etiqueta, '3 cuotas sin interés');
  assert.equal(p.cuotas, 3, 'son 3 CUOTAS');
  assert.equal(p.descuento_porcentaje, null, 'y NO un 3% de descuento');
});

test('normalizeVeaPromotion recorta info y legales a 4000 chars', () => {
  const p = normalizeVeaPromotion({ info: 'x'.repeat(9000), legals: 'y'.repeat(9000) });
  assert.equal(p.info.length, 4000);
  assert.equal(p.legales.length, 4000);
});

/* ---------------------------- normalizeVeaPromotions ---------------------- */

test('normalizeVeaPromotions filtra las vencidas (con `now` fijo)', () => {
  const promos = normalizeVeaPromotions(records, NOW);

  // 10 crudas − 1 que no es de Vea − 3 vencidas al 2026-08-21 = 6
  assert.equal(promos.length, 6);

  const cutoff = Math.floor(NOW.getTime() / 1000);
  const vencidas = records.filter((r) => appliesToVea(r) && Number(r.dateEnd) < cutoff);
  assert.equal(vencidas.length, 3, 'control del fixture: 3 vencidas de Vea');

  // Ninguna promoción del resultado puede terminar antes de `now`.
  for (const p of promos) {
    assert.ok(p.end_date >= '2026-08-21', `promo vencida en el resultado: ${p.end_date}`);
  }
});

test('normalizeVeaPromotions respeta el `now` inyectado (no la hora real)', () => {
  // Con un `now` anterior al 2026-08-01, la promo de "banco Nacion" que vence
  // ese día todavía está vigente ⇒ 7 en vez de 6. Si la función ignorara el
  // parámetro, ambas corridas darían lo mismo.
  const antes = normalizeVeaPromotions(records, new Date('2026-07-15T00:00:00Z'));
  const despues = normalizeVeaPromotions(records, NOW);

  assert.equal(antes.length, 7);
  assert.equal(despues.length, 6);

  // Y muy en el futuro no queda ninguna vigente.
  assert.equal(normalizeVeaPromotions(records, new Date('2030-01-01T00:00:00Z')).length, 0);
});

test('normalizeVeaPromotions descarta las que no son de Vea', () => {
  const promos = normalizeVeaPromotions(records, NOW);
  const noVea = find((r) => !appliesToVea(r));

  assert.ok(!promos.some((p) => p.external_id === buildExternalId(noVea)));
});

test('normalizeVeaPromotions deduplica por external_id', () => {
  const conDuplicados = [...records, ...records];
  const promos = normalizeVeaPromotions(conDuplicados, NOW);

  assert.equal(promos.length, 6, 'duplicar la entrada no duplica la salida');

  const ids = promos.map((p) => p.external_id);
  assert.equal(new Set(ids).size, ids.length);
});

test('normalizeVeaPromotions no explota con entradas no-array', () => {
  assert.deepEqual(normalizeVeaPromotions(null, NOW), []);
  assert.deepEqual(normalizeVeaPromotions(undefined, NOW), []);
  assert.deepEqual(normalizeVeaPromotions({}, NOW), []);
  assert.deepEqual(normalizeVeaPromotions([], NOW), []);
});

test('las promos sin dateEnd no se descartan por vencimiento', () => {
  const sinFin = { ...records[0], dateEnd: null, discount: '77.00', discountText: '%' };
  const promos = normalizeVeaPromotions([sinFin], NOW);

  assert.equal(promos.length, 1);
  assert.equal(promos[0].end_date, null);
});
