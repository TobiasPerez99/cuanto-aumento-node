import { getValtechBankPromotions } from '../../cores/valtechBankPromotions.js';

/**
 * 🏷️ Scraper de PROMOCIONES BANCARIAS de Carrefour
 *
 * Wrapper fino sobre `cores/valtechBankPromotions.js`: la fuente (Master Data
 * BP + FB + FC), las fechas en UTC con fin exclusivo y el `REST-Range`
 * obligatorio viven en el core, que comparte con Masonline.
 *
 * Fuente: la pestaña "Descuentos Bancarios" de /promociones
 * (`valtech.carrefourar-bank-promotions`). La pestaña "Promociones" (entidad PR)
 * son ofertas de producto por provincia con el texto dentro de imágenes: queda
 * afuera a propósito. Relevamiento:
 * docs/superpowers/research/2026-09-23-fuentes-de-promos/carrefour-masonline-farmacity.md
 *
 * Medido el 2026-10-10: 144 documentos activos, 33 vigentes.
 */
export async function getCarrefourPromotions(options = {}) {
  return getValtechBankPromotions({
    baseUrl: 'https://www.carrefour.com.ar',
    source: 'carrefour',
    merchant: 'Carrefour',
    // Hiper / Market / Online / Express / Maxi: el legal confirma la semántica.
    withFormats: true,
    ...options,
  });
}
