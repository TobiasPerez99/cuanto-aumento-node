// scrapper-script/scraper-tests/promo-text.test.js
//
// Tests del núcleo compartido de texto y fechas de los scrapers de promos
// (`cores/promoText.js`). Las frases de vigencia son literales de los legales reales
// de Cuenta DNI y de la planilla de medios de pago de Farmacity (2026-10-10).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clean,
  stripHtml,
  ddmmyyyyToIso,
  utcDateOnly,
  exclusiveEndToInclusive,
  parseValidityText,
  shortHash,
} from '../cores/promoText.js';

const REF = new Date('2026-10-10T12:00:00Z');

test('clean colapsa espacios y devuelve null si queda vacío', () => {
  assert.equal(clean('  hola \n  mundo  '), 'hola mundo');
  assert.equal(clean('   '), null);
  assert.equal(clean(null), null);
  assert.equal(clean('abcdef', 3), 'abc');
});

test('stripHtml saca etiquetas, entidades y el escape CSV de comillas dobladas', () => {
  const raw = '<span style=""font-size: 30px;""> CFTEA: 0.00% </span></br> DISPONIBLE &amp; VÁLIDO';
  assert.equal(stripHtml(raw), 'CFTEA: 0.00% DISPONIBLE & VÁLIDO');
});

test('ddmmyyyyToIso exige una fecha real (round-trip)', () => {
  assert.equal(ddmmyyyyToIso('05/03/2026'), '2026-03-05');
  assert.equal(ddmmyyyyToIso('5/3/2026'), '2026-03-05');
  assert.equal(ddmmyyyyToIso('31/02/2026'), null);
  assert.equal(ddmmyyyyToIso('2026-03-05'), null);
  assert.equal(ddmmyyyyToIso(null), null);
});

test('utcDateOnly lee la fecha en UTC, no en hora argentina', () => {
  // 00:00 UTC del 1/10 son las 21:00 del 30/09 en Argentina: leerlo en ART corre el inicio un día.
  assert.equal(utcDateOnly('2026-10-01T00:00:00+00:00'), '2026-10-01');
  assert.equal(utcDateOnly('basura'), null);
  assert.equal(utcDateOnly(null), null);
});

test('exclusiveEndToInclusive: el 1° del mes a medianoche es el fin exclusivo del mes anterior', () => {
  assert.equal(exclusiveEndToInclusive('2026-11-01T00:00:00+00:00'), '2026-10-31');
  assert.equal(exclusiveEndToInclusive('2027-01-01T00:00:00+00:00'), '2026-12-31');
  // Masonline también carga fines inclusivos ("HASTA EL 31/12/2026" con active_to 2026-12-31).
  assert.equal(exclusiveEndToInclusive('2026-12-31T00:00:00+00:00'), '2026-12-31');
  assert.equal(exclusiveEndToInclusive('2026-09-30T00:00:00+00:00'), '2026-09-30');
  assert.equal(exclusiveEndToInclusive(null), null);
});

const CASES = [
  ['PROMOCIÓN VÁLIDA TODOS LOS JUEVES Y VIERNES COMPRENDIDOS ENTRE EL 13 DE AGOSTO Y EL 11 DE DICIEMBRE DE 2026, AMBAS FECHAS INCLUSIVE', '2026-08-13', '2026-12-11'],
  ['PROMOCIÓN VÁLIDA TODOS LOS MIÉRCOLES Y JUEVES DESDE EL 1 DE SEPTIEMBRE HASTA EL 31 DE DICIEMBRE, DE 2026, PARA LAS COMPRAS', '2026-09-01', '2026-12-31'],
  ['Promoción válida todos los miércoles de los meses de septiembre y octubre, del 2026, para compras realizadas', '2026-09-01', '2026-10-31'],
  ['PROMOCIÓN VÁLIDA TODOS LOS MARTES Y MIÉRCOLES DE OCTUBRE DEL 2026, PARA COMPRAS REALIZADAS', '2026-10-01', '2026-10-31'],
  ['Promoción válida todos los viernes y sábados desde el 18 de septiembre al 31 de octubre del 2026, para compras', '2026-09-18', '2026-10-31'],
  ['PROMOCIÓN VÁLIDA LOS SÁBADOS Y DOMINGOS DEL MES DE OCTUBRE DE 2026, PARA LAS COMPRAS', '2026-10-01', '2026-10-31'],
  ['Promoción válida todos los MIÉRCOLES del 1 al 31 de octubre del 2026, para compras', '2026-10-01', '2026-10-31'],
  ['PROMOCIÓN VÁLIDA TODOS LOS DÍAS DESDE EL 1 DE JUNIO, HASTA EL 31 DE OCTUBRE DE 2026, EN EL ÁMBITO DE CABA', '2026-06-01', '2026-10-31'],
  ['BENEFICIO VÁLIDO EXCLUSIVAMENTE EN LA REPÚBLICA ARGENTINA PARA PAGOS REALIZADOS LOS DÍAS LUNES Y MARTES DEL 01 DE SEPTIEMBRE AL 29 DE DICIEMBRE 2026', '2026-09-01', '2026-12-29'],
  ['Promoción válida todos los martes 1, 8, 15 y 29 de septiembre del 2026, para compras', '2026-09-01', '2026-09-29'],
  ['Promoción válida desde 01/10/2025 hasta el 30/09/2026 inclusive.', '2025-10-01', '2026-09-30'],
  ['Tope de reintegro: $30.000 por mes, por cuenta. Vigencia: del 01/07/2026 al 31/12/2026. TIENDA ON LINE', '2026-07-01', '2026-12-31'],
  ['TODOS LOS DIAS SÁBADOS DEL MES DE OCTUBRE, DE 2026, PARA LAS COMPRAS', '2026-10-01', '2026-10-31'],
];

for (const [text, start, end] of CASES) {
  test(`parseValidityText: ${text.slice(0, 60)}…`, () => {
    assert.deepEqual(parseValidityText(text, REF), { start_date: start, end_date: end });
  });
}

test('parseValidityText: un rango sin año (dd.mm) toma el año más cercano a la referencia', () => {
  const text = 'DDM - Jue a Sab 10% de descuento y SOLO 3 cuotas sin interés. Vigencia 08.10 al 10.10 TIENDA ON LINE';
  assert.deepEqual(parseValidityText(text, REF), { start_date: '2026-10-08', end_date: '2026-10-10' });
  // Un rango que cruza el año nuevo, visto en diciembre.
  assert.deepEqual(parseValidityText('Vigencia 20.12 al 05.01', new Date('2026-12-15T12:00:00Z')), {
    start_date: '2026-12-20',
    end_date: '2027-01-05',
  });
});

test('parseValidityText: el rango sin año de los teasers de Farmacity ("01/09 - 21/09")', () => {
  assert.deepEqual(parseValidityText('2x1 Combinable#01/09 - 21/09 // ID: 250079 (Bot carga: 28-08)', REF), {
    start_date: '2026-09-01',
    end_date: '2026-09-21',
  });
  // Con el año completo gana el patrón de fechas enteras.
  assert.deepEqual(parseValidityText('desde 01/10/2025 - 30/09/2026', REF), {
    start_date: '2025-10-01',
    end_date: '2026-09-30',
  });
});

test('parseValidityText: sin una vigencia legible devuelve nulls, nunca una fecha adivinada', () => {
  assert.deepEqual(parseValidityText('PROMOCIÓN VÁLIDA DEL', REF), { start_date: null, end_date: null });
  assert.deepEqual(parseValidityText('Todos los días, 3 cuotas sin interés', REF), { start_date: null, end_date: null });
  assert.deepEqual(parseValidityText('ENTRE EL 31 DE FEBRERO Y EL 3 DE MARZO DE 2026', REF), { start_date: null, end_date: null });
  assert.deepEqual(parseValidityText(null, REF), { start_date: null, end_date: null });
});

test('parseValidityText: un rango que arranca en un mes posterior al del fin cruza el año', () => {
  assert.deepEqual(parseValidityText('VÁLIDA DESDE EL 1 DE DICIEMBRE HASTA EL 31 DE ENERO DE 2027', REF), {
    start_date: '2026-12-01',
    end_date: '2027-01-31',
  });
});

test('shortHash es estable y de 12 caracteres', () => {
  assert.equal(shortHash('a|b'), shortHash('a|b'));
  assert.notEqual(shortHash('a|b'), shortHash('a|c'));
  assert.equal(shortHash('x').length, 12);
});
