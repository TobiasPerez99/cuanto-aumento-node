/**
 * Data Routes
 * Endpoints de PULL consumidos por Laravel para obtener el output de los
 * scrapers de promociones y sucursales (sin escribir en la base de datos).
 *
 * Todos requieren authMiddleware (Bearer API_TOKEN), igual que scraperRoutes.js.
 * Se aplica cacheMiddleware con TTL corto (~6h) para evitar scrapear en cada
 * request; si Redis falla, cacheMiddleware degrada a scrape on-demand.
 */

import { Router } from 'express';
import { authMiddleware } from '../middlewares/authMiddleware.js';
import { cacheMiddleware } from '../middlewares/cacheMiddleware.js';

import { getMercadoPagoPromotions } from '../scrapers/promos/mercadopago.js';
import { getPatagoniaPromotions } from '../scrapers/promos/patagonia.js';
import { getJumboPromotions } from '../scrapers/promos/jumbo_promos.js';
import { getCotoPromotions } from '../scrapers/promos/coto.js';
import { getJumboStores } from '../scrapers/stores/jumbo_stores.js';

const router = Router();

// TTL de cache para estos endpoints: 6 horas
const DATA_CACHE_TTL = 6 * 60 * 60;

// Whitelist de fuentes válidas -> función scraper correspondiente
const PROMOTION_SOURCES = {
  mercadopago: getMercadoPagoPromotions,
  patagonia: getPatagoniaPromotions,
  jumbo: getJumboPromotions,
  coto: getCotoPromotions,
};

const STORE_SOURCES = {
  jumbo: getJumboStores,
};

/**
 * GET /api/promotions/:source
 * Corre (o devuelve del cache) el scraper de promociones de la fuente indicada.
 */
router.get(
  '/promotions/:source',
  authMiddleware,
  cacheMiddleware(DATA_CACHE_TTL),
  async (req, res) => {
    const source = req.params.source.toLowerCase();
    const scraperFn = PROMOTION_SOURCES[source];

    if (!scraperFn) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Promotion source "${source}" not found`,
        availableSources: Object.keys(PROMOTION_SOURCES),
      });
    }

    try {
      const result = await scraperFn();
      res.json(result);
    } catch (error) {
      console.error(`Error scraping promotions for "${source}":`, error);
      res.status(500).json({
        success: false,
        error: 'Internal Error',
        message: error.message,
      });
    }
  }
);

/**
 * GET /api/stores/:source
 * Corre (o devuelve del cache) el scraper de sucursales de la fuente indicada.
 */
router.get(
  '/stores/:source',
  authMiddleware,
  cacheMiddleware(DATA_CACHE_TTL),
  async (req, res) => {
    const source = req.params.source.toLowerCase();
    const scraperFn = STORE_SOURCES[source];

    if (!scraperFn) {
      return res.status(404).json({
        success: false,
        error: 'Not Found',
        message: `Store source "${source}" not found`,
        availableSources: Object.keys(STORE_SOURCES),
      });
    }

    try {
      const result = await scraperFn();
      res.json(result);
    } catch (error) {
      console.error(`Error scraping stores for "${source}":`, error);
      res.status(500).json({
        success: false,
        error: 'Internal Error',
        message: error.message,
      });
    }
  }
);

export default router;
