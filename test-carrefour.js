// test-carrefour.js
import { getCarrefourMainProducts } from './scrapers/carrefour.js';

async function test() {
  try {
    console.log('🚀 Iniciando test del scraper de Carrefour...\n');
    
    const result = await getCarrefourMainProducts();
    
    console.log('\n📊 RESUMEN FINAL:');
    console.log(`✅ Éxito: ${result.totalProducts} productos obtenidos`);
    console.log(`📅 Timestamp: ${result.timestamp}`);
    console.log(`🏪 Fuente: ${result.source}`);
    
    // Mostrar algunos ejemplos de productos
    if (result.products && result.products.length > 0) {
      console.log('\n🎯 EJEMPLOS DE PRODUCTOS:');
      console.log('='.repeat(50));
      
      // Mostrar los primeros 3 productos como ejemplo
      const exampleCount = Math.min(3, result.products.length);
      
      for (let i = 0; i < exampleCount; i++) {
        console.log(`\n📦 PRODUCTO ${i + 1}:`);
        console.log(JSON.stringify(result.products[i], null, 2));
        console.log('-'.repeat(40));
      }
      
      // Mostrar estadísticas adicionales
      console.log('\n📈 ESTADÍSTICAS ADICIONALES:');
      
      // Contar productos por marca (top 5)
      const brandCount = {};
      result.products.forEach(product => {
        if (product.brand) {
          brandCount[product.brand] = (brandCount[product.brand] || 0) + 1;
        }
      });
      
      const topBrands = Object.entries(brandCount)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5);
      
      console.log('🏷️  Top 5 marcas:');
      topBrands.forEach(([brand, count]) => {
        console.log(`   • ${brand}: ${count} productos`);
      });
      
      // Mostrar rango de precios
      const prices = result.products
        .map(p => p.price)
        .filter(p => p && p > 0)
        .sort((a, b) => a - b);
      
      if (prices.length > 0) {
        console.log(`\n💰 Rango de precios:`);
        console.log(`   • Mínimo: $${prices[0]}`);
        console.log(`   • Máximo: $${prices[prices.length - 1]}`);
        console.log(`   • Promedio: $${Math.round(prices.reduce((a, b) => a + b, 0) / prices.length)}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Error durante el test:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

test();
