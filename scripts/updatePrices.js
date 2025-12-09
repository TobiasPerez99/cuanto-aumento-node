import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Configuración Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configuración de URLs base de los super (O podrías tener esto en tu tabla supermarkets)
const SUPERMARKET_URLS = {
  'Disco': 'https://www.disco.com.ar',
  'Jumbo': 'https://www.jumbo.com.ar',
  'Vea': 'https://www.vea.com.ar',
  // Agrega los que tengas
};

/**
 * 1. API RÁPIDA: Busca por ID directo (La "Opción 2" profesional)
 */
async function getVtexProductById(baseUrl, externalId) {
  try {
    const url = `${baseUrl}/api/catalog_system/pub/products/search?fq=productId:${externalId}`;
    const { data } = await axios.get(url, { timeout: 5000 });

    if (!data || data.length === 0) return null; // Producto no existe o inactivo

    const product = data[0];
    const item = product.items[0];
    const seller = item.sellers.find(s => s.sellerDefault) || item.sellers[0];
    
    return {
      price: seller.commertialOffer.Price,
      listPrice: seller.commertialOffer.ListPrice,
      stock: seller.commertialOffer.AvailableQuantity,
      available: seller.commertialOffer.AvailableQuantity > 0
    };
  } catch (error) {
    console.error(`Error fetching ID ${externalId}:`, error.message);
    return null;
  }
}

/**
 * 2. FUNCIÓN PRINCIPAL DEL CRON
 */
async function runPriceUpdater() {
  console.log('⏰ Iniciando actualización de precios...');

  // A. Obtener un lote de productos "viejos" (ej: los 50 que hace más tiempo no se revisan)
  // IMPORTANTE: Filtramos los que SÍ tienen external_id
  const { data: productsToUpdate, error } = await supabase
    .from('supermarket_products')
    .select(`
      id, 
      external_id, 
      price, 
      supermarket_id, 
      supermarkets ( name )
    `)
    .not('external_id', 'is', null) // Solo los que ya mapeamos
    .order('last_checked_at', { ascending: true }) // Los más viejos primero
    .limit(50); // Hacemos lotes pequeños para no saturar

  if (error) {
    console.error('Error obteniendo productos:', error);
    return;
  }

  if (productsToUpdate.length === 0) {
    console.log('✅ No hay productos para actualizar.');
    return;
  }

  console.log(`📋 Procesando lote de ${productsToUpdate.length} productos...`);

  let updatedCount = 0;

  // B. Iterar sobre cada producto
  for (const item of productsToUpdate) {
    const supermarketName = item.supermarkets.name;
    const baseUrl = SUPERMARKET_URLS[supermarketName];

    if (!baseUrl) {
      console.warn(`⚠️ URL no configurada para ${supermarketName}`);
      continue;
    }

    // Pequeña pausa para no ser bloqueado (Rate Limiting casero)
    await new Promise(r => setTimeout(r, 200)); 

    // C. Consultar API VTEX
    const newData = await getVtexProductById(baseUrl, item.external_id);

    if (newData) {
      // D. Lógica de comparación
      const hasPriceChanged = newData.price !== item.price;
      
      // Actualizamos siempre el 'last_checked_at' y el stock
      const updateData = {
        last_checked_at: new Date().toISOString(),
        is_available: newData.available,
        list_price: newData.listPrice,
        price: newData.price // Actualizamos el precio actual
      };

      // E. Guardar en DB
      const { error: updateError } = await supabase
        .from('supermarket_products')
        .update(updateData)
        .eq('id', item.id);

      if (!updateError) {
        // F. Si el precio cambió, guardamos en el HISTORIAL
        if (hasPriceChanged) {
          console.log(`💰 Cambio de precio en ${item.id}: $${item.price} -> $${newData.price}`);
          await supabase.from('price_history').insert({
            supermarket_product_id: item.id,
            price: newData.price,
            list_price: newData.listPrice,
            scraped_at: new Date().toISOString()
          });
          updatedCount++;
        }
      }
    } else {
        // Si newData es null, el producto quizás se borró del super.
        // Opcional: Marcar como no disponible
        await supabase
            .from('supermarket_products')
            .update({ is_available: false, last_checked_at: new Date() })
            .eq('id', item.id);
    }
  }

  console.log(`🏁 Fin del proceso. Precios actualizados: ${updatedCount}/${productsToUpdate.length}`);
}

// Ejecutar
runPriceUpdater();