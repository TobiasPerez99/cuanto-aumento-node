// scrapper-script/scraper-tests/coto-promos.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeCotoPromotion } from '../scrapers/promos/coto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures/coto-promo.json'), 'utf8'));

/**
 * Helper de test (NO pega a la red): replica el flatten que hace
 * getCotoPromotions() sobre las dos listas de la respuesta real.
 */
function flattenFixturePromos(fixture) {
  return [
    ...(fixture?.result?.promocionesDigitales ?? []),
    ...(fixture?.result?.promocionesSucursalesFisicas ?? []),
  ];
}

test('flattening ambos arrays del fixture da 4 promos', () => {
  const flat = flattenFixturePromos(raw);
  assert.equal(flat.length, 4);
});

test('normaliza una promo digital al contrato PULL', () => {
  const digital = raw.result.promocionesDigitales[0];
  const p = normalizeCotoPromotion(digital);
  assert.ok(p.external_id, 'external_id presente');
  assert.equal(typeof p.title, 'string');
  assert.equal(p.title, digital.textoDescuento);
  assert.equal(p.external_id, `coto-d-${digital.id}`);
});

test('normaliza una promo física al contrato PULL', () => {
  const fisica = raw.result.promocionesSucursalesFisicas[0];
  const p = normalizeCotoPromotion(fisica);
  assert.ok(p.external_id, 'external_id presente');
  assert.equal(p.external_id, `coto-f-${fisica.id}`);
});

test('external_id namespacea digital (coto-d-) vs física (coto-f-) para evitar colisión de ids', () => {
  const flat = flattenFixturePromos(raw);
  const normalized = flat.map(normalizeCotoPromotion);

  assert.equal(normalized.length, 4);
  for (const p of normalized) {
    assert.ok(p.external_id, 'cada promo normalizada tiene external_id');
  }

  const digitalIds = normalized.filter((p) => p.external_id.startsWith('coto-d-'));
  const fisicaIds = normalized.filter((p) => p.external_id.startsWith('coto-f-'));
  assert.equal(digitalIds.length, 2);
  assert.equal(fisicaIds.length, 2);
});

test('title viene de textoDescuento y description de descripcion', () => {
  const digital = raw.result.promocionesDigitales[0];
  const p = normalizeCotoPromotion(digital);
  assert.equal(p.title, '30% DE DESCUENTO');
  assert.equal(p.description, digital.descripcion);
});

test('start_date/end_date son null cuando vigenciaDesde/vigenciaHasta son null', () => {
  const digital = raw.result.promocionesDigitales[0];
  const p = normalizeCotoPromotion(digital);
  assert.equal(p.start_date, null);
  assert.equal(p.end_date, null);
});

test('conserva los campos crudos que la IA necesita', () => {
  const digital = raw.result.promocionesDigitales[0];
  const p = normalizeCotoPromotion(digital);
  assert.equal(p.observacion, digital.observacion);
  assert.equal(p.diasVigencia, digital.diasVigencia);
  assert.deepEqual(p.dias, digital.dias);
  assert.equal(p.banco, digital.banco);
  assert.equal(p.formaPago, digital.formaPago);
  assert.equal(p.urlTerminos, digital.urlTerminos);
  assert.equal(p.aplicaCompra, digital.aplicaCompra);
  assert.equal(p.isDigital, true);
});

test('slug es kebab-case sin acentos e incluye el id', () => {
  const digital = raw.result.promocionesDigitales[0];
  const p = normalizeCotoPromotion(digital);
  assert.match(p.slug, /^[a-z0-9-]+$/);
  assert.ok(p.slug.endsWith(`-${digital.id}`));
});
