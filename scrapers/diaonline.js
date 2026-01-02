import { scrapeVtexMerchant } from '../cores/vtex.js';
import { saveFollowerProduct } from '../cores/saveHandlers.js';
import { DETAILED_CATEGORIES, productEans } from '../cores/categories.js';

const BASE_URL = 'https://diaonline.supermercadosdia.com.ar';

/**
 * 🎯 FUNCIÓN PRINCIPAL - Dia (FOLLOWER)
 */
export async function getDiaMainProducts(mode = 'categories') {
  const useEans = mode === 'eans';
  return await scrapeVtexMerchant({
    merchantName: 'Dia',
    baseUrl: BASE_URL,
    categories: useEans ? productEans : DETAILED_CATEGORIES,
    onProductFound: saveFollowerProduct,
    count: useEans ? 1 : 50
  });
}
