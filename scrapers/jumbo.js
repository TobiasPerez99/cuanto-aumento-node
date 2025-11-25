import { supabase } from '../src/supabase.js';
import { scrapeVtexSupermarket } from './vtex.js';

// 🎯 CATEGORÍAS PRINCIPALES DEL SUPERMERCADO
const MAIN_PRODUCT_CATEGORIES = [
  // ALMACÉN
  'Aceites y Vinagres', 'Aderezos', 'Arroz y Legumbres', 'Conservas', 
  'Desayuno y Merienda', 'Golosinas y Chocolates', 'Harinas', 'Panificados', 
  'Para Preparar', 'Pastas Secas y Salsas', 'Sal, Pimienta y Especias', 
  'Snacks', 'Sopas, Caldos y Puré',

  // BEBIDAS
  'A Base de Hierbas', 'Aguas', 'Aperitivos', 'Cervezas', 'Champagnes', 
  'Energizantes', 'Bebidas Blancas', 'Gaseosas', 'Hielo', 'Isotónicas', 
  'Jugos', 'Licores', 'Sidras', 'Vinos', 'Whiskys',

  // FRESCOS (Lácteos, Quesos, Fiambres, Pastas)
  'Cremas', 'Dulce de Leche', 'Leches', 'Mantecas y Margarinas', 
  'Pastas y Tapas', 'Quesos', 'Yogures',
  'Dulces', 'Encurtidos, Aceitunas y Pickles', 'Fiambres', 'Salchichas',
  'Pastas Frescas Simples', 'Pastas Frescas Rellenas', 'Salsa y Quesos',

  // LIMPIEZA
  'Accesorios de Limpieza', 'Calzado', 'Cuidado Para La Ropa', 
  'Desodorantes de Ambiente', 'Insecticidas', 'Lavandina', 'Limpieza de Baño', 
  'Limpieza de Cocina', 'Limpieza de Pisos y Muebles', 'Papeles',

  // PERFUMERÍA
  'Cuidado Capilar', 'Cuidado de la Piel', 'Cuidado Oral', 'Cuidado Personal', 'Farmacia'
];

const BASE_URL = 'https://www.jumbo.com.ar';

/**
 * Lógica específica de guardado para Jumbo (FOLLOWER)
 * Solo guarda precio si el producto ya existe en DB
 */
async function saveJumboProduct(product, supermarketId) {
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

    // 2. Insertar Precio
    const { error: priceError } = await supabase
      .from('prices')
      .insert({
        product_ean: product.ean,
        supermarket_id: supermarketId,
        price: product.price,
        product_url: product.link,
        scraped_at: new Date().toISOString()
      });

    if (priceError) {
      console.error(`❌ Error guardando precio para ${product.ean}:`, priceError.message);
      return { saved: false, reason: 'db_error' };
    }

    return { saved: true };
  } catch (error) {
    console.error(`❌ Error general guardando ${product.ean}:`, error.message);
    return { saved: false, reason: 'exception' };
  }
}

/**
 * 🎯 FUNCIÓN PRINCIPAL
 */
export async function getJumboMainProducts() {
  return await scrapeVtexSupermarket({
    supermarketName: 'Jumbo',
    baseUrl: BASE_URL,
    categories: MAIN_PRODUCT_CATEGORIES,
    onProductFound: saveJumboProduct
  });
}
