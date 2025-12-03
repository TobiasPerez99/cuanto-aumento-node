import { scrapeVtexSupermarket } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { DETAILED_CATEGORIES, productEans } from '../cores/categories.js';

const BASE_URL = 'https://www.jumbo.com.ar';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Jumbo (FOLLOWER)
 */
export async function getJumboMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexSupermarket({
    supermarketName: 'Jumbo',
    baseUrl: BASE_URL,
    categories: useEans ? productEans : DETAILED_CATEGORIES,
    onProductFound: saveFollowerProduct,
    count: useEans ? 1 : 50
  });
}
