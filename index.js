import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getCarrefourMainProducts } from './scrapers/carrefour.js';
import { getDiscoMainProducts } from './scrapers/disco.js';

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
    description: 'API para obtener productos de supermercados',
    timestamp: new Date().toISOString(),
    endpoints: [
      'GET /products/carrefour - Obtener productos de Carrefour',
      'GET /products/disco - Obtener productos de Disco (MAESTRO)'
    ]
  });
});

// Ruta de health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Servidor funcionando correctamente'
  });
});

// 🎯 ENDPOINT CARREFOUR
app.get('/products/carrefour', async (req, res) => {
  try {
    console.log('🚀 Iniciando obtención de productos de Carrefour...');
    const result = await getCarrefourMainProducts();
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 🎯 ENDPOINT DISCO (MAESTRO)
app.get('/products/disco', async (req, res) => {
  try {
    console.log('🚀 Iniciando obtención de productos de Disco (MAESTRO)...');
    const result = await getDiscoMainProducts();
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Mantener compatibilidad con ruta anterior (redirecciona a Carrefour por defecto)
app.get('/products', async (req, res) => {
  res.redirect('/products/carrefour');
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