// scrapper-script/scrapers/coto.js
import { scrapeConstructorMerchant } from '../cores/constructor.js';
import { saveCotoProduct } from '../cores/saveHandlers.js';

/**
 * Scraper de PRODUCTOS de Coto (follower). Coto NO es VTEX: usa la API pública
 * Constructor.io. El parámetro `mode` se ignora (Constructor.io siempre recorre
 * el árbol de categorías completo), pero se acepta por compat con el runner.
 */
export async function getCotoMainProducts() {
  return await scrapeConstructorMerchant({
    merchantName: 'Coto',
    onProductFound: saveCotoProduct,
  });
}
