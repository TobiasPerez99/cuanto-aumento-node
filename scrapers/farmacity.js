import { scrapeVtexSupermarket } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { DETAILED_CATEGORIES, productEans } from '../cores/categories.js';

const BASE_URL = 'https://www.farmacity.com';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Farmacity (FOLLOWER)
 */
export async function getFarmacityMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexSupermarket({
    supermarketName: 'Farmacity',
    baseUrl: BASE_URL,
    categories: useEans ? productEans : DETAILED_CATEGORIES,
    onProductFound: saveFollowerProduct,
    count: useEans ? 1 : 50
  });
}
