import { scrapeVtexSupermarket } from '../cores/vtex.js';
import { saveMasterProduct } from '../cores/saveHandlers.js';
import { DETAILED_CATEGORIES, productEans } from '../cores/categories.js';

const BASE_URL = 'https://www.disco.com.ar';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Disco (MAESTRO)
 */
export async function getDiscoMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexSupermarket({
    supermarketName: 'Disco',
    baseUrl: BASE_URL,
    categories: useEans ? productEans : DETAILED_CATEGORIES,
    onProductFound: saveMasterProduct,
    count: useEans ? 1 : 50
  });
}
