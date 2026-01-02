import { scrapeVtexMerchant } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { getCategories, DETAILED_CATEGORIES, productEans } from '../cores/categories.js';

const BASE_URL = 'https://www.jumbo.com.ar';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Jumbo (FOLLOWER)
 */
export async function getJumboMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexMerchant({
    merchantName: 'Jumbo',
    baseUrl: BASE_URL,
    categories: useEans ? productEans : await getCategories(),
    onProductFound: saveFollowerProduct,
    count: useEans ? 1 : 50
  });
}
