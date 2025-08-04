import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getCarrefourMainProducts } from './scrapers/carrefour.js';

// Configurar variables de entorno
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta básica de información
app.get('/', (req, res) => {
  res.json({
    message: '🛒 Cuanto Aumento - Scraper de Productos Principales',
    description: 'Obtiene los ~200 productos principales de Carrefour',
    timestamp: new Date().toISOString(),
    endpoint: 'GET /products - Obtener productos principales de Carrefour'
  });
});

// Ruta de health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Servidor funcionando correctamente'
  });
});

// 🎯 ENDPOINT PRINCIPAL - Productos principales del supermercado
app.get('/products', async (req, res) => {
  try {
    console.log('🚀 Iniciando obtención de productos principales de Carrefour...');
    console.log('⏳ Esto tomará aproximadamente 2 minutos...\n');
    
    const result = await getCarrefourMainProducts();
    
    if (result.success) {
      console.log(`✅ Completado: ${result.totalProducts} productos obtenidos\n`);
      res.json(result);
    } else {
      console.log('❌ Error obteniendo productos\n');
      res.status(500).json(result);
    }
    
  } catch (error) {
    console.error('❌ Error en endpoint principal:', error);
    res.status(500).json({
      success: false,
      error: 'Error interno del servidor',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Manejo de rutas no encontradas
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Ruta no encontrada',
    message: `La ruta ${req.originalUrl} no existe`,
    availableEndpoints: [
      'GET / - Información del servicio',
      'GET /health - Estado del servidor',
      'GET /products - Obtener productos principales'
    ]
  });
});

// Manejo de errores
app.use((error, req, res, next) => {
  console.error('Error:', error);
  res.status(500).json({
    error: 'Error interno del servidor',
    message: error.message
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
  console.log(`🛒 Endpoint principal: GET /products`);
  console.log(`📊 Obtiene ~200 productos principales de Carrefour\n`);
}); 