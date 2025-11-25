// test-masonline.js
import 'dotenv/config';
import { getMasonlineMainProducts } from '../scrapers/masonline.js';

async function test() {
  try {
    console.log('🚀 Iniciando test del scraper de Masonline...\n');
    
    const result = await getMasonlineMainProducts();
    
    console.log('\n📊 RESUMEN FINAL:');
    console.log(`✅ Éxito: ${result.totalProducts} productos obtenidos`);
    console.log(`📅 Timestamp: ${result.timestamp}`);
    console.log(`🏪 Fuente: ${result.source}`);
    
    // Mostrar algunos ejemplos de productos
    if (result.products && result.products.length > 0) {
      console.log('\n🎯 EJEMPLOS DE PRODUCTOS CON EAN:');
      console.log('='.repeat(50));
      
      // Mostrar los primeros 3 productos como ejemplo
      const exampleCount = Math.min(3, result.products.length);
      
      for (let i = 0; i < exampleCount; i++) {
        const p = result.products[i];
        console.log(`\n📦 PRODUCTO ${i + 1}:`);
        console.log(`   🆔 EAN: ${p.ean || '❌ NO ENCONTRADO'}`); // Destacar el EAN
        console.log(`   📝 Nombre: ${p.name}`);
        console.log(`   🔗 URL: ${p.link}`);
        console.log(`   💰 Precio: $${p.price}`);
        console.log(`   🏷️  Marca: ${p.brand}`);
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
      
      console.log('🏷️  Top 5 marcas encontradas:');
      topBrands.forEach(([brand, count]) => {
        console.log(`   • ${brand}: ${count} productos`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error durante el test:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

test();
