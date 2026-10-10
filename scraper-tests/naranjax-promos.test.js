// scrapper-script/scraper-tests/naranjax-promos.test.js
//
// Tests del scraper de Naranja X (sólo nuestras cadenas). Sin red: binders y detalles
// son snapshots reales del BFF del 2026-10-10 (naranjax-binders.json) servidos por un
// `httpPost` inyectado.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  planKey,
  isGenericPlanZeta,
  normalizeNaranjaXPlan,
  getNaranjaXPromotions,
} from '../scrapers/promos/naranjax.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/naranjax-binders.json'), 'utf8'));
const NOW = new Date('2026-10-10T12:00:00Z');

const BINDERS = {
  disco: 'Disco',
  disco_com_ar: 'Disco',
  farmacity: 'Farmacity',
  changomas: 'Masonline',
  coto: 'Coto',
  josimar: 'Josimar',
};

/** BFF falso: los binders del fixture; el resto 404 como el real. */
function fakeHttpPost({ status = {}, calls = [] } = {}) {
  return async (url) => {
    calls.push(url);
    const path = url.split('/api/')[1];
    if (status[path]) return { status: status[path], data: status[path] === 403 ? '<html>Just a moment...</html>' : { message: 'x' } };
    const [, slug, , planUrl] = path.split('/');
    const entry = fixture.binders[slug];
    if (!entry) return { status: 404, data: { message: 'Binder details not found in Binders Elastic.' } };
    if (!planUrl) return { status: 200, data: entry.binder };
    const detail = entry.details[planUrl];
    return detail ? { status: 200, data: detail } : { status: 404, data: { message: 'not found' } };
  };
}

const FAST = { sleep: async () => {}, delayMs: 0, now: NOW, binders: BINDERS };

test('planKey quita el sufijo de estado (-C vigente, -A próximo)', () => {
  assert.equal(planKey('exclusiva_turbo-25_off-25_de_descuento-C'), 'exclusiva_turbo-25_off-25_de_descuento');
  assert.equal(planKey('4_cuotas_cero_interes-A'), '4_cuotas_cero_interes');
});

test('el Plan Zeta genérico se descarta, el que trae descuento propio no', () => {
  assert.equal(isGenericPlanZeta({ title: 'Plan Zeta cero interés', benefit: { discountPercentage: null } }), true);
  assert.equal(isGenericPlanZeta({ title: '10% off y Plan Zeta cero interés', benefit: { discountPercentage: '10' } }), false);
  assert.equal(isGenericPlanZeta({ title: '12 cuotas cero interés', benefit: {} }), false);
});

test('normaliza el 25% off Turbo de Disco con tope, período y elegibilidad', () => {
  const plan = fixture.binders.disco.binder.current.find((p) => p.url.startsWith('exclusiva_turbo'));
  const detail = fixture.binders.disco.details[plan.url];
  const promo = normalizeNaranjaXPlan(detail, { merchant: 'Disco', binderNames: ['Disco'], plan });

  assert.equal(promo.external_id, 'nx-disco-exclusiva_turbo-25_off-25_de_descuento');
  assert.equal(promo.comercio, 'Disco');
  assert.equal(promo.descuento_porcentaje, 25);
  assert.equal(promo.cuotas, null);
  assert.equal(promo.elegibilidad, 'Exclusiva Turbo');
  assert.equal(promo.tope, 9500);
  assert.equal(promo.tope_periodo, 'semanal');
  assert.deepEqual(promo.dias, ['martes']);
  assert.equal(promo.start_date, '2026-10-01');
  assert.equal(promo.end_date, '2026-10-31');
  assert.deepEqual(promo.medios_de_pago, ['Tarjeta de débito Naranja X Visa', 'Tarjeta de crédito Naranja X']);
  assert.equal(promo.descripcion, null, 'promotionDetails.description viene como el string "true"');
  assert.ok(promo.legal.startsWith('25% de reintegro'));
  for (const volatil of ['commerces', 'tags', 'logo', 'backgroundImage']) {
    assert.equal(volatil in promo, false, `${volatil} cambia entre corridas y no debe viajar`);
  }
});

test('las cuotas salen del título y los días de toda la semana se ordenan', () => {
  const plan = fixture.binders.disco.binder.current.find((p) => p.url.startsWith('12_cuotas'));
  const promo = normalizeNaranjaXPlan(fixture.binders.disco.details[plan.url], { merchant: 'Disco', binderNames: ['Disco'], plan });
  assert.equal(promo.cuotas, 12);
  assert.equal(promo.descuento_porcentaje, null);
  assert.deepEqual(promo.dias, ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']);
});

test('corrida completa: agrupa los binders de una cadena, descarta Plan Zeta y tolera binders inexistentes', async () => {
  const calls = [];
  const result = await getNaranjaXPromotions({ httpPost: fakeHttpPost({ calls }), ...FAST });

  assert.equal(result.success, true);
  assert.deepEqual(result.missing_binders, ['josimar']);
  const ids = result.promotions.map((p) => p.external_id).sort();
  assert.ok(ids.includes('nx-disco-12_cuotas_cero_interes'));
  assert.ok(ids.includes('nx-farmacity-plan_zeta_cero_interes-10_de_descuento'));
  assert.equal(ids.some((id) => /plan_zeta_cero_interes$/.test(id)), false, 'el Plan Zeta genérico no entra');

  // disco y disco_com_ar tienen el mismo "12 cuotas": una sola promo, con los dos binders.
  const cuotas = result.promotions.filter((p) => p.external_id === 'nx-disco-12_cuotas_cero_interes');
  assert.equal(cuotas.length, 1);
  assert.deepEqual(cuotas[0].comercios_nx, ['Disco', 'Disco. Com. Ar']);
  // y el detalle del binder online no se volvió a pedir.
  assert.equal(calls.filter((u) => u.includes('disco_com_ar/detail')).length, 0);
});

test('Changomas entra como Masonline', async () => {
  const result = await getNaranjaXPromotions({ httpPost: fakeHttpPost(), ...FAST });
  const chango = result.promotions.filter((p) => p.comercio === 'Masonline');
  assert.ok(chango.length >= 2);
  assert.ok(chango.every((p) => p.external_id.startsWith('nx-masonline-')));
  const qr = chango.find((p) => p.descuento_porcentaje === 15);
  assert.deepEqual(qr.captura, ['qr']);
  assert.equal(qr.tercero, true);
});

test('un plan vencido no se emite aunque el BFF lo liste', async () => {
  const later = new Date('2026-11-15T12:00:00Z');
  const result = await getNaranjaXPromotions({ httpPost: fakeHttpPost(), ...FAST, now: later });
  assert.equal(result.promotions.some((p) => p.end_date === '2026-10-31'), false);
});

test('un 403 de Cloudflare falla la corrida entera con blocked=true', async () => {
  const result = await getNaranjaXPromotions({ httpPost: fakeHttpPost({ status: { 'binder/disco': 403 } }), ...FAST });
  assert.equal(result.success, false);
  assert.equal(result.blocked, true);
  assert.equal(result.promotions.length, 0);
});

test('HTML con status 200 también es un bloqueo', async () => {
  const httpPost = async () => ({ status: 200, data: '<!DOCTYPE html><title>Just a moment...</title>' });
  const result = await getNaranjaXPromotions({ httpPost, ...FAST });
  assert.equal(result.blocked, true);
});

test('un detalle que falla se informa y no tira la corrida', async () => {
  const plan = fixture.binders.coto.binder.current.find((p) => !/plan_zeta/.test(p.url));
  const result = await getNaranjaXPromotions({
    httpPost: fakeHttpPost({ status: { [`binder/coto/detail/${plan.url}`]: 500 } }),
    ...FAST,
  });
  assert.equal(result.success, true);
  assert.equal(result.failed.length, 1);
  assert.equal(result.promotions.some((p) => p.comercio === 'Coto'), false);
});

test('si no responde ningún binder, la corrida falla', async () => {
  const httpPost = async () => ({ status: 404, data: { message: 'not found' } });
  const result = await getNaranjaXPromotions({ httpPost, ...FAST });
  assert.equal(result.success, false);
  assert.match(result.error, /ningún binder/);
});
