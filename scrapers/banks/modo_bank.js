import axios from 'axios';
import { saveBankModo } from '../../cores/saveHandlers.js';

const BASE_URL = 'https://promoshub.modo.com.ar/api/rewards/banks';

/**
 * Normaliza un banco del API de Modo al formato esperado
 */
function normalizeBank(rawBank) {
  return {
    sourceId: rawBank.id,
    name: rawBank.name,
    image: rawBank.image,
    promotionUrl: rawBank.promotion_url,
    bcraCode: rawBank.bcra_code,
    hubBankId: rawBank.hub_bank_id,
    onHubList: rawBank.on_hub_list === 'true' || rawBank.on_hub_list === true,
    isActive: true, // Default: banco activo
    dataSource: 'modo'
  };
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Modo Banks
 */
export async function getModoBanks() {
  console.log(`🏦 Iniciando scraper para Bancos de Modo...`);

  const allBanks = new Map();
  let savedCount = 0;
  let skippedCount = 0;

  try {
    // Fetch banks from API
    console.log(`📡 Consultando API: ${BASE_URL}`);
    const response = await axios.get(BASE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      },
      timeout: 15000
    });

    const rawBanks = response.data;

    if (!Array.isArray(rawBanks)) {
      throw new Error('La respuesta del API no es un array');
    }

    console.log(`📊 ${rawBanks.length} bancos encontrados en el API`);

    // Process each bank
    for (const rawBank of rawBanks) {
      const bank = normalizeBank(rawBank);

      // Evitar duplicados por bcraCode
      if (!allBanks.has(bank.bcraCode)) {
        allBanks.set(bank.bcraCode, bank);

        // Guardar en DB
        const result = await saveBankModo(bank);

        if (result.saved) {
          savedCount++;
          console.log(`   ✅ ${bank.name} (${bank.bcraCode})`);
        } else {
          skippedCount++;
          console.log(`   ⏭️  ${bank.name} - ${result.reason || 'skipped'}`);
        }
      }

      // Pequeña pausa para no saturar
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const uniqueBanks = Array.from(allBanks.values());

    console.log(`\n🎉 Scraping completado para Modo:`);
    console.log(`   📊 Total bancos únicos: ${uniqueBanks.length}`);
    console.log(`   💾 Guardados/Actualizados: ${savedCount}`);
    if (skippedCount > 0) {
      console.log(`   ⏭️  Ignorados: ${skippedCount}`);
    }

    return {
      success: true,
      source: 'modo',
      totalBanks: uniqueBanks.length,
      savedBanks: savedCount,
      skippedBanks: skippedCount,
      timestamp: new Date().toISOString(),
      banks: uniqueBanks
    };

  } catch (error) {
    console.error(`❌ Error en scraper de Modo:`, error.message);
    return {
      success: false,
      source: 'modo',
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}
