import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createJob,
  updateJobStatus,
  getJob,
  cleanupOldJobs,
} from '../services/jobManager.js';
import { tallyProductCategory } from '../cores/vtex.js';
import { isRetryableError } from '../scrapers/josimar.js';

/*
 * Regresiones del OOM del 2026-09-04 y del abort de Josimar.
 *
 * El scraper murió con "Ineffective mark-compacts near heap limit" tras 6 días
 * arriba. La causa no fue un pico puntual sino dos fugas que se multiplican:
 *   1. `scrapeVtexMerchant` acumulaba el OBJETO COMPLETO de cada producto en un
 *      Map para deduplicar y contar; lo único que se necesita es el EAN.
 *   2. Ese resultado entero se guardaba en el Map en memoria del jobManager
 *      (`updateJobStatus(..., { result })`) y `cleanupOldJobs()` sólo corría al
 *      importar el módulo, así que 6 corridas diarias × 8 comercios se
 *      acumulaban sin techo hasta reiniciar el contenedor.
 */

/* ─────────────────────────── jobManager: retención ─────────────────────────── */

test('cleanupOldJobs borra los jobs terminados más viejos que el corte', () => {
  const jobId = createJob('disco', 'Disco');
  updateJobStatus(jobId, 'completed', { result: { totalProducts: 8899 } });

  // maxAgeHours=0 ⇒ todo lo terminado queda del lado viejo del corte.
  cleanupOldJobs(0);

  assert.equal(getJob(jobId), null, 'el job terminado debería haberse borrado');
});

test('cleanupOldJobs NUNCA borra un job en curso, por viejo que sea', () => {
  const running = createJob('coto', 'Coto');
  updateJobStatus(running, 'running');

  const pending = createJob('vea', 'Vea');

  cleanupOldJobs(0);

  assert.ok(getJob(running), 'un job running no se borra: seguiría escribiendo');
  assert.ok(getJob(pending), 'un job pending no se borra: todavía no arrancó');

  // Limpieza del propio test para no ensuciar a los que siguen.
  updateJobStatus(running, 'completed');
  updateJobStatus(pending, 'completed');
  cleanupOldJobs(0);
});

test('cleanupOldJobs respeta la ventana: no toca lo terminado recién', () => {
  const jobId = createJob('jumbo', 'Jumbo');
  updateJobStatus(jobId, 'completed', { result: { totalProducts: 7492 } });

  const deleted = cleanupOldJobs(24);

  assert.equal(deleted, 0);
  assert.ok(getJob(jobId), 'un job de hace segundos entra en la ventana de 24h');

  cleanupOldJobs(0);
});

/* ──────────────────── vtex: conteo sin retener los productos ───────────────── */

test('tallyProductCategory cuenta por categoría primaria sin guardar el producto', () => {
  const counts = new Map();

  tallyProductCategory(counts, { ean: '1', categories: ['Almacén', 'Aceites'] });
  tallyProductCategory(counts, { ean: '2', categories: ['Almacén'] });
  tallyProductCategory(counts, { ean: '3', categories: ['Bebidas'] });

  assert.equal(counts.get('Almacén'), 2);
  assert.equal(counts.get('Bebidas'), 1);
  assert.equal(counts.size, 2, 'sólo la categoría primaria, no todas');
});

test('tallyProductCategory ignora productos sin categoría en vez de romper', () => {
  const counts = new Map();

  tallyProductCategory(counts, { ean: '1' });
  tallyProductCategory(counts, { ean: '2', categories: [] });
  tallyProductCategory(counts, null);

  assert.equal(counts.size, 0);
});

/* ─────────────────── josimar: qué errores merecen un reintento ─────────────── */

test('isRetryableError reintenta los errores de red (sin respuesta HTTP)', () => {
  assert.equal(isRetryableError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableError({ code: 'ETIMEDOUT' }), true);
});

test('isRetryableError reintenta los 5xx: son transitorios del lado de VTEX', () => {
  // El 2026-09-05 una corrida entera de Josimar murió por UN 500 en la primera
  // categoría; la misma URL respondía 206 un minuto después.
  for (const status of [500, 502, 503, 504]) {
    assert.equal(isRetryableError({ response: { status } }), true, `status ${status}`);
  }
});

test('isRetryableError NO reintenta los 4xx: repetir no los arregla', () => {
  // Un 400 por `_from` fuera de rango o un 404 son deterministas; reintentarlos
  // sólo esconde el problema y multiplica el tiempo de corrida.
  for (const status of [400, 401, 403, 404, 429]) {
    assert.equal(isRetryableError({ response: { status } }), false, `status ${status}`);
  }
});
