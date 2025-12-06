import { supabase } from '../config/supabase.js';

/**
 * Guarda producto como MAESTRO (upsert producto + insert precio)
 * Usado por el supermercado principal que define el catálogo
 */
export async function saveMasterProduct(product, supermarketId) {
  try {
    // 1. Upsert Producto (Maestro)
    const { error: productError } = await supabase
      .from('products')
      .upsert({
        ean: product.ean,
        name: product.name,
        description: product.description || product.name,
        brand: product.brand,
        image_url: product.image,
        images: product.images,
        category: product.categories && product.categories.length > 0 ? product.categories[0] : null,
        product_url: product.link
      }, { onConflict: 'ean' });

    if (productError) {
      console.error(`❌ Error guardando producto ${product.ean}:`, productError.message);
      return { saved: false, reason: 'db_error' };
    }

    // 2. Upsert en Supermarket Products (Estado Actual)
    const { data: spData, error: spError } = await supabase
      .from('supermarket_products')
      .upsert({
        product_ean: product.ean,
        supermarket_id: supermarketId,
        external_id: product.external_id,
        product_url: product.link,
        price: product.price,
        list_price: product.list_price,
        reference_price: product.reference_price,
        reference_unit: product.reference_unit,
        is_available: product.is_available,
        last_checked_at: new Date().toISOString()
      }, { onConflict: 'product_ean, supermarket_id' })
      .select('id')
      .single();

    if (spError) {
      console.error(`❌ Error guardando supermarket_product para ${product.ean}:`, spError.message);
      return { saved: false, reason: 'db_error' };
    }

    // 3. Insertar Historial de Precio (Log)
    const { error: historyError } = await supabase
      .from('price_history')
      .insert({
        supermarket_product_id: spData.id,
        price: product.price,
        list_price: product.list_price,
        scraped_at: new Date().toISOString()
      });

    if (historyError) {
      // No fallamos todo el proceso si falla el historial, pero lo logueamos
      console.error(`Error guardando historial para ${product.ean}:`, historyError.message);
    }

    return { saved: true };
  } catch (error) {
    console.error(`❌ Error general guardando ${product.ean}:`, error.message);
    return { saved: false, reason: 'exception' };
  }
}

/**
 * Guarda solo el precio si el producto existe en el maestro
 * Usado por supermercados secundarios
 */
export async function saveFollowerProduct(product, supermarketId) {
  try {
    // 1. Verificar si el producto existe en nuestra DB (Maestro)
    const { data: existingProduct, error: findError } = await supabase
      .from('products')
      .select('ean')
      .eq('ean', product.ean)
      .single();

    if (findError || !existingProduct) {
      return { saved: false, reason: 'not_in_master' };
    }

    // 2. Upsert en Supermarket Products (Estado Actual)
    const { data: spData, error: spError } = await supabase
      .from('supermarket_products')
      .upsert({
        product_ean: product.ean,
        supermarket_id: supermarketId,
        external_id: product.external_id,
        product_url: product.link,
        price: product.price,
        list_price: product.list_price,
        reference_price: product.reference_price,
        reference_unit: product.reference_unit,
        is_available: product.is_available,
        last_checked_at: new Date().toISOString()
      }, { onConflict: 'product_ean, supermarket_id' })
      .select('id')
      .single();

    if (spError) {
      console.error(`❌ Error guardando supermarket_product para ${product.ean}:`, spError.message);
      return { saved: false, reason: 'db_error' };
    }

    // 3. Insertar Historial de Precio (Log)
    const { error: historyError } = await supabase
      .from('price_history')
      .insert({
        supermarket_product_id: spData.id,
        price: product.price,
        list_price: product.list_price,
        scraped_at: new Date().toISOString()
      });

    if (historyError) {
      console.error(`⚠️ Error guardando historial para ${product.ean}:`, historyError.message);
    }

    return { saved: true };
  } catch (error) {
    console.error(`❌ Error general guardando ${product.ean}:`, error.message);
    return { saved: false, reason: 'exception' };
  }
}

