import { scrapeVtexSupermarket } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { GENERAL_CATEGORIES, productEans } from '../cores/categories.js';

const BASE_URL = 'https://www.masonline.com.ar';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Masonline (FOLLOWER)
 */
export async function getMasonlineMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexSupermarket({
    supermarketName: 'Masonline',
    baseUrl: BASE_URL,
    categories: useEans ? productEans : GENERAL_CATEGORIES,
    onProductFound: saveFollowerProduct,
    count: useEans ? 1 : 50
  });
}
