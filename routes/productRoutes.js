import { Router } from 'express';
import { cacheMiddleware, CACHE_TTL } from '../middlewares/cacheMiddleware.js';
import { runAll } from '../scripts/populate-db.js';
const router = Router();

// Correr procesos desde url 

router.get('/run-all-scrapers', async (req, res) => {
  try {
    await runAll();
    res.json({ message: 'Procesos iniciados correctamente' });
  } catch (error) {
    console.error('Error en GET /run-all-scrapers:', error);
    res.status(500).json({ error: 'Error al iniciar procesos', message: error.message });
  }
});

export default router;
