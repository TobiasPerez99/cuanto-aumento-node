import { scrapeVtexSupermarket } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { GENERAL_CATEGORIES, productEans } from '../cores/categories.js';

const BASE_URL = 'https://www.vea.com.ar';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Vea (FOLLOWER)
 */
export async function getVeaMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexSupermarket({
    supermarketName: 'Vea',
    baseUrl: BASE_URL,
    categories: useEans ? productEans : GENERAL_CATEGORIES,
    onProductFound: saveFollowerProduct,
    count: useEans ? 1 : 50
  });
}
