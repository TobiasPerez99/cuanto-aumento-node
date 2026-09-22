/**
 * Corrida EN SECO del recorrido del catálogo VTEX: recorre de verdad (pega a las
 * tiendas) pero no toca la base. Sirve para verificar la fuente antes de un deploy o
 * después de que un comercio cambie algo, sin escribir un solo precio.
 *
 * Uso:
 *   node scripts/vtexCatalogDryRun.js disco            # un comercio
 *   node scripts/vtexCatalogDryRun.js disco jumbo vea  # varios, en serie
 *   node scripts/vtexCatalogDryRun.js all              # los 7 VTEX + Josimar
 *   node scripts/vtexCatalogDryRun.js disco --eans-dir /tmp/eans
 *        └─ además deja /tmp/eans/disco.txt con los EAN vistos (uno por línea)
 *
 * Imprime, por comercio, cuánto dice tener el catálogo en su canal, cuánto recorrió,
 * cuántas requests hizo y si la corrida habría contado como completa.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VTEX_MERCHANTS, scrapeVtexProducts } from '../cores/vtexProducts.js';
import { getJosimarMainProducts } from '../scrapers/josimar.js';

const args = process.argv.slice(2);
const keys = [];
let eansDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--eans-dir') {
    eansDir = args[++i];
    continue;
  }
  keys.push(args[i]);
}
const targets = keys.includes('all') ? [...Object.keys(VTEX_MERCHANTS), 'josimar'] : keys;

if (targets.length === 0) {
  console.error(`Uso: node scripts/vtexCatalogDryRun.js <${[...Object.keys(VTEX_MERCHANTS), 'josimar'].join('|')}|all> [--eans-dir dir]`);
  process.exit(1);
}

// Sin handler no se buscaría el comercio en la base; con este handler tampoco:
// el id es de mentira y el "guardado" sólo anota el EAN.
const dryOptions = (seen) => ({
  getMerchantId: async () => -1,
  onProductFound: async (product) => {
    seen.push(product.ean);
    return { saved: false, reason: 'dry_run' };
  },
});

const summary = [];
for (const key of targets) {
  const seen = [];
  const result = key === 'josimar'
    ? await getJosimarMainProducts('categories', dryOptions(seen))
    : await scrapeVtexProducts(key, 'categories', dryOptions(seen));

  if (eansDir) {
    mkdirSync(eansDir, { recursive: true });
    writeFileSync(join(eansDir, `${key}.txt`), seen.join('\n') + '\n');
  }

  summary.push({
    comercio: key,
    ok: result.success,
    completa: result.complete,
    canal: result.salesChannel,
    catalogo: result.expectedTotal,
    unicos: result.totalProducts,
    descartados: result.discardedProducts,
    categorias: result.totalCategories,
    fallidas: result.failedCategories?.length ?? 0,
    truncadas: result.oversizedCategories?.length ?? 0,
    requests: result.requestCount,
    segundos: result.durationSeconds,
    error: result.error ?? '',
  });
}

console.log('\n' + '='.repeat(60));
console.table(summary);
process.exit(summary.every((s) => s.ok && s.completa) ? 0 : 1);
