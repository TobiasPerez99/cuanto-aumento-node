/**
 * Script para poblar la base de datos con productos de todos los supermercados
 *
 * Uso:
 *   npm run scrape:all      - Ejecutar todos los scrapers
 *   npm run scrape:disco    - Solo Disco (MAESTRO)
 *   npm run scrape:carrefour - Solo Carrefour
 *   etc.
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

// Importar todos los scrapers
import { getDiscoMainProducts } from '../scrapers/disco.js';
import { getCarrefourMainProducts } from '../scrapers/carrefour.js';
import { getJumboMainProducts } from '../scrapers/jumbo.js';
import { getVeaMainProducts } from '../scrapers/vea.js';
import { getDiaMainProducts } from '../scrapers/diaonline.js';
import { getMasonlineMainProducts } from '../scrapers/masonline.js';
import { getFarmacityMainProducts } from '../scrapers/farmacity.js';
import { getModoBanks } from '../scrapers/banks/modo_bank.js';
import { getMercadoPagoPromotions } from '../scrapers/promos/mercadopago.js';
import { getPatagoniaPromotions } from '../scrapers/promos/patagonia.js';
import { getJumboPromotions } from '../scrapers/promos/jumbo_promos.js';
import { getJumboStores } from '../scrapers/stores/jumbo_stores.js';

// Importar notificador de Slack
import { sendScrapingNotification } from '../services/slackNotifier.js';

// Configuración de scrapers
export const SCRAPERS = {
  disco: { fn: getDiscoMainProducts, name: 'Disco', isMaster: true },
  carrefour: { fn: getCarrefourMainProducts, name: 'Carrefour' },
  jumbo: { fn: getJumboMainProducts, name: 'Jumbo' },
  vea: { fn: getVeaMainProducts, name: 'Vea' },
  dia: { fn: getDiaMainProducts, name: 'Dia Online' },
  masonline: { fn: getMasonlineMainProducts, name: 'Masonline' },
  farmacity: { fn: getFarmacityMainProducts, name: 'Farmacity' },
  modo: { fn: getModoBanks, name: 'Modo Banks', type: 'bank' },
  mercadopago: { fn: getMercadoPagoPromotions, name: 'MercadoPago Promos', type: 'promo' },
  patagonia: { fn: getPatagoniaPromotions, name: 'Banco Patagonia Promos', type: 'promo' },
  jumbopromos: { fn: getJumboPromotions, name: 'Jumbo Promos', type: 'promo' },
  jumbostores: { fn: getJumboStores, name: 'Jumbo Stores', type: 'stores' },
};

// Tipos de scraper que NO usan modo y devuelven shapes propios (no {totalProducts})
const MODELESS_TYPES = ['bank', 'promo', 'stores'];

// Obtener qué scraper ejecutar desde argumentos
const args = process.argv.slice(2);
const targetScraper = args[0]; // ej: "disco", "carrefour", "all"
const DEFAULT_MODE = 'categories';
const cliMode = args[1] || DEFAULT_MODE; // "categories" (default) o "eans"

export async function runScraper(key, scraper, mode = DEFAULT_MODE) {
  const label = scraper.isMaster ? `${scraper.name} (MAESTRO)` : scraper.name;
  console.log(`\n${'='.repeat(50)}`);

  // Los scrapers de tipo 'bank'/'promo'/'stores' no usan modo
  const isModeless = MODELESS_TYPES.includes(scraper.type);
  if (isModeless) {
    console.log(`📦 Ejecutando: ${label}`);
  } else {
    console.log(`📦 Ejecutando: ${label} [MODO: ${mode.toUpperCase()}]`);
  }

  console.log('='.repeat(50));

  const scraperStartTime = Date.now();

  try {
    // Bancos/promos/stores no usan mode, solo supermercados
    const result = isModeless
      ? await scraper.fn()
      : await scraper.fn(mode);

    // Calcular tiempo de ejecución y enviar notificación a Slack
    const executionTime = Date.now() - scraperStartTime;
    await sendScrapingNotification(result, {
      scraperName: scraper.name,
      isMaster: scraper.isMaster || false,
      mode: mode,
      executionTime: executionTime
    });

    if (result.success) {
      // Manejar diferencias entre scrapers de bancos, promos, stores y supermercados
      if (scraper.type === 'bank') {
        console.log(`✅ ${scraper.name}: ${result.totalBanks} bancos, ${result.savedBanks} guardados`);
      } else if (scraper.type === 'promo') {
        console.log(`✅ ${scraper.name}: ${result.total} promociones`);
      } else if (scraper.type === 'stores') {
        console.log(`✅ ${scraper.name}: ${result.total} sucursales`);
      } else {
        console.log(`✅ ${scraper.name}: ${result.totalProducts} productos, ${result.savedProducts} guardados`);
      }
      return { success: true, ...result };
    } else {
      console.error(`❌ Error en ${scraper.name}:`, result.error);
      return { success: false, error: result.error };
    }
  } catch (error) {
    console.error(`❌ Excepción en ${scraper.name}:`, error.message);

    // Enviar notificación de error a Slack
    const executionTime = Date.now() - scraperStartTime;
    await sendScrapingNotification(
      { success: false, error: error.message, source: key },
      {
        scraperName: scraper.name,
        isMaster: scraper.isMaster || false,
        mode: mode,
        executionTime: executionTime
      }
    );

    return { success: false, error: error.message };
  }
}

export async function runAll(mode = DEFAULT_MODE) {
  console.log('🚀 EJECUTANDO TODOS LOS SCRAPERS');
  console.log(`📅 Fecha: ${new Date().toLocaleString('es-AR')}`);
  console.log(`🔧 Modo: ${mode.toUpperCase()}`);

  const startTime = Date.now();
  const results = {};

  // Primero ejecutar el MAESTRO (Disco) para crear productos base.
  // Es crítico que el MAESTRO termine antes de lanzar los FOLLOWERS:
  // los followers descartan productos que no existan todavía en el catálogo.
  const masterEntries = Object.entries(SCRAPERS).filter(([, s]) => s.isMaster);
  const followerEntries = Object.entries(SCRAPERS).filter(([, s]) => !s.isMaster);

  console.log('\n⭐ PASO 1: Ejecutando scraper(s) MAESTRO...');
  for (const [key, scraper] of masterEntries) {
    results[key] = await runScraper(key, scraper, mode);
  }

  console.log('\n⭐ PASO 2: Ejecutando scrapers FOLLOWERS...');
  for (const [key, scraper] of followerEntries) {
    results[key] = await runScraper(key, scraper, mode);
  }

  // Resumen final
  const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(2);
  console.log('\n' + '='.repeat(50));
  console.log('📊 RESUMEN FINAL');
  console.log('='.repeat(50));
  
  for (const [key, result] of Object.entries(results)) {
    const status = result.success ? '✅' : '❌';
    let info;
    if (result.success) {
      // Manejar diferencias entre scrapers de bancos, promos, stores y supermercados
      if (SCRAPERS[key].type === 'bank') {
        info = `${result.totalBanks} bancos, ${result.savedBanks} guardados`;
      } else if (SCRAPERS[key].type === 'promo') {
        info = `${result.total} promociones`;
      } else if (SCRAPERS[key].type === 'stores') {
        info = `${result.total} sucursales`;
      } else {
        info = `${result.totalProducts} productos, ${result.savedProducts} guardados`;
      }
    } else {
      info = result.error;
    }
    console.log(`${status} ${SCRAPERS[key].name}: ${info}`);
  }
  
  console.log(`\n⏱️  Tiempo total: ${duration} minutos`);
}

export async function runSingle(scraperKey, mode = DEFAULT_MODE) {
  if (!SCRAPERS[scraperKey]) {
    console.error(`❌ Scraper "${scraperKey}" no existe.`);
    console.log('Scrapers disponibles:', Object.keys(SCRAPERS).join(', '));
    process.exit(1);
  }

  console.log(`🚀 EJECUTANDO SCRAPER: ${SCRAPERS[scraperKey].name}`);
  console.log(`📅 Fecha: ${new Date().toLocaleString('es-AR')}`);

  const startTime = Date.now();
  await runScraper(scraperKey, SCRAPERS[scraperKey], mode);

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n⏱️  Tiempo: ${duration} segundos`);
}

// Ejecutar solo si el archivo se ejecuta directamente (no cuando se importa)
async function main() {
  if (!targetScraper || targetScraper === 'all') {
    await runAll(cliMode);
  } else {
    await runSingle(targetScraper, cliMode);
  }
  process.exit(0);
}

// Solo ejecutar si este archivo es el módulo principal
// En ES modules, verificamos si import.meta.url coincide con el archivo ejecutado
const __filename = fileURLToPath(import.meta.url);
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
  main().catch(err => {
    console.error('❌ Error fatal:', err);
    process.exit(1);
  });
}
