import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Configurar variables de entorno (antes de cualquier import que los use)
dotenv.config();

// Importar config (esto inicializa Redis con logs)
import './config/redis.js';

// Importar rutas de la API
import productRoutes from './routes/productRoutes.js';
import scraperRoutes from './routes/scraperRoutes.js';
import dataRoutes from './routes/dataRoutes.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// 🚀 API ROUTES
// ============================================
app.use('/api', productRoutes);
app.use('/api', scraperRoutes);
app.use('/api', dataRoutes);

// ============================================
// 📊 INFO ROUTES
// ============================================

// Ruta básica de información
app.get('/', (req, res) => {
  res.json({
    message: '🛒 Cuanto Aumento - API de Precios de Supermercados',
    description: 'API para consultar productos y precios históricos',
    timestamp: new Date().toISOString(),
    endpoints: {
      products: [
        'GET /api/products - Lista paginada de productos con precios',
        'GET /api/products/search?q=... - Buscar productos',
        'GET /api/products/category/:category - Productos por categoría',
        'GET /api/products/:ean - Detalle con historial de precios',
        'GET /api/products/:ean/cheapest - Supermercado más barato',
        'GET /api/categories - Lista de categorías',
        'GET /api/stats/categories - Estadísticas por categoría',
      ],
      scrapers: [
        'POST /api/scrape/:scraperName - Ejecutar scraper específico (autenticado)',
        'POST /api/scrape/all - Ejecutar todos los scrapers (autenticado)',
        'GET /api/scrape/status/:jobId - Consultar estado de job (autenticado)',
        'GET /api/scrape/jobs - Listar todos los jobs (autenticado)',
        'GET /api/scrape/running - Listar scrapers en ejecución (autenticado)',
        'GET /api/scrape/stats - Estadísticas de jobs (autenticado)',
        'POST /api/scrape/cleanup - Limpiar jobs antiguos (autenticado)'
      ],
      data: [
        'GET /api/promotions/:source - Promociones de mercadopago|patagonia|jumbo (autenticado)',
        'GET /api/stores/:source - Sucursales de jumbo (autenticado)'
      ]
    },
    scrapers_available: ['disco', 'carrefour', 'jumbo', 'vea', 'dia', 'masonline', 'farmacity', 'modo', 'mercadopago', 'patagonia', 'jumbopromos', 'jumbostores']
  });
});

// Ruta de health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Servidor funcionando correctamente',
    timestamp: new Date().toISOString(),
  });
});

// ============================================
// ❌ ERROR HANDLING
// ============================================

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    message: `La ruta ${req.originalUrl} no existe`,
    hint: 'Visita GET / para ver los endpoints disponibles',
  });
});

// Manejo de errores globales
app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({
    error: 'Error interno del servidor',
    message: error.message,
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`\n🚀 Servidor ejecutándose en http://localhost:${PORT}`);
});

