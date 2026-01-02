import { scrapeVtexMerchant } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { DETAILED_CATEGORIES, productEans } from '../cores/categories.js';

const BASE_URL = 'https://www.masonline.com.ar';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Masonline (FOLLOWER)
 */
export async function getMasonlineMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexMerchant({
    merchantName: 'Masonline',
    baseUrl: BASE_URL,
    categories: useEans ? productEans : DETAILED_CATEGORIES,
    onProductFound: saveFollowerProduct,
    count: useEans ? 1 : 50
  });
}
