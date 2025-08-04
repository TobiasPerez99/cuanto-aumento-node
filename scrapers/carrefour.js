import axios from 'axios';

// Hash VTEX desde variables de entorno
const VTEX_SHA256_HASH = process.env.VTEX_SHA256_HASH;

// Verificar que el hash esté configurado
if (!VTEX_SHA256_HASH) {
  throw new Error('❌ VTEX_SHA256_HASH no está configurado en las variables de entorno');
}

// 🎯 CATEGORÍAS PRINCIPALES DEL SUPERMERCADO
// Cada categoría traerá ~18-20 productos para obtener ~200 productos totales
const MAIN_PRODUCT_CATEGORIES = [
  'almacen',
  'bebidas', 
  'limpieza',
  'lacteos',
  'productos frescos',
  'panaderia',
  'congelados',
  'frutas y verduras',
  'carnes y pescados',
  'desayuno y merienda',
  'perfumeria'
];

/**
 * Codifica una cadena a Base64
 */
function encodeBase64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * Codifica una cadena para URL
 */
function encodeUrl(str) {
  return encodeURIComponent(str);
}

/**
 * Genera las variables para la query de VTEX (IDÉNTICO AL PROYECTO GO)
 */
function getVariablesWithQuery(query) {
  return {
    productOriginVtex: true,
    simulationBehavior: "default",
    hideUnavailableItems: true,
    fullText: query,
    count: 20, // Aumentado para obtener ~20 productos por categoría
    shippingOptions: [],
    variant: null
  };
}

/**
 * Genera las extensiones con la query para VTEX
 */
function getExtensionsWithQuery(query) {
  const variables = getVariablesWithQuery(query);
  return {
    persistedQuery: {
      version: 1,
      sha256Hash: VTEX_SHA256_HASH,
      sender: "vtex.store-resources@0.x",
      provider: "vtex.search-graphql@0.x"
    },
    variables: encodeBase64(JSON.stringify(variables))
  };
}

/**
 * Construye los parámetros de query como en el proyecto Go
 */
function encodeQueryParams(params) {
  const queryParams = [];
  for (const [key, value] of Object.entries(params)) {
    queryParams.push(key + "=" + value);
  }
  return "?" + queryParams.join("&");
}

/**
 * Codifica la query completa para la URL (IDÉNTICO AL PROYECTO GO)
 */
function encodeQuery(query) {
  const extensions = JSON.stringify(getExtensionsWithQuery(query));
  const params = {
    workspace: "master",
    maxAge: "medium",
    appsEtag: "remove",
    domain: "store",
    locale: "es-AR",
    operationName: "productSuggestions", // IGUAL QUE EN GO
    variables: encodeUrl("{}"),
    extensions: encodeUrl(extensions)
  };
  return encodeQueryParams(params);
}

/**
 * Normaliza un producto de la respuesta de VTEX al formato estándar
 */
function normalizeProduct(rawProduct, source = 'carrefour') {
  // Verificaciones de seguridad
  if (!rawProduct.items || rawProduct.items.length === 0) {
    return null;
  }
  
  if (!rawProduct.items[0].images || rawProduct.items[0].images.length === 0) {
    return null;
  }

  if (!rawProduct.priceRange || !rawProduct.priceRange.sellingPrice) {
    return null;
  }

  const baseUrl = 'https://www.carrefour.com.ar';
  
  return {
    id: rawProduct.productId,
    source: source,
    name: rawProduct.productName,
    link: `${baseUrl}/${rawProduct.linkText}/p`,
    image: rawProduct.items[0].images[0].imageUrl,
    price: rawProduct.priceRange.sellingPrice.lowPrice,
    listPrice: rawProduct.priceRange.listPrice?.lowPrice || rawProduct.priceRange.sellingPrice.lowPrice,
    brand: rawProduct.brand,
    categories: rawProduct.categories,
    description: rawProduct.description,
    unavailable: false
  };
}

/**
 * Hace una búsqueda individual a Carrefour (función interna)
 */
async function fetchCarrefourProducts(query) {
  const baseUrl = 'https://www.carrefour.com.ar/_v/segment/graphql/v1/';
  // CORRECCIÓN CRÍTICA: encodeQuery ya incluye el "?", no agregarlo de nuevo
  const url = baseUrl + encodeQuery(query);

  try {
    const response = await axios.get(url, {
      headers: {
        // Headers simplificados como en el proyecto Go
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 15000
    });

    const data = response.data;
    
    // Verificar errores en la respuesta
    if (data.errors && data.errors.length > 0) {
      throw new Error(`API Error: ${data.errors[0].message}`);
    }

    // Verificar que tengamos los datos esperados (IDÉNTICO AL PROYECTO GO)
    if (!data.data || !data.data.productSuggestions || !data.data.productSuggestions.products) {
      throw new Error('Estructura de respuesta inesperada de la API');
    }

    const rawProducts = data.data.productSuggestions.products;
    
    // Normalizar productos
    const normalizedProducts = rawProducts
      .map(product => normalizeProduct(product))
      .filter(product => product !== null);

    return normalizedProducts;

  } catch (error) {
    console.error(`❌ Error buscando "${query}":`, error.message);
    return [];
  }
}

/**
 * 🎯 FUNCIÓN PRINCIPAL - Obtiene los ~200 productos principales de Carrefour por categorías
 * NUEVA ESTRATEGIA: Busca por categorías específicas del supermercado
 */
export async function getCarrefourMainProducts() {
  console.log('🛒 Obteniendo productos principales de Carrefour por categorías...');
  console.log(`📋 Buscando en ${MAIN_PRODUCT_CATEGORIES.length} categorías principales`);
  console.log(`⏱️  Tiempo estimado: ~${Math.ceil(MAIN_PRODUCT_CATEGORIES.length * 2 / 60)} minutos\n`);
  
  const allProducts = new Map(); // Para evitar duplicados
  let successfulQueries = 0;
  let failedQueries = 0;
  
  for (let i = 0; i < MAIN_PRODUCT_CATEGORIES.length; i++) {
    const category = MAIN_PRODUCT_CATEGORIES[i];
    
    console.log(`[${i+1}/${MAIN_PRODUCT_CATEGORIES.length}] 🔍 Categoría: "${category}"`);
    
    const products = await fetchCarrefourProducts(category);
    
    if (products.length > 0) {
      // Agregar productos únicos al mapa
      products.forEach(product => {
        if (!allProducts.has(product.id)) {
          allProducts.set(product.id, product);
        }
      });
      
      console.log(`   ✅ ${products.length} productos | Total únicos: ${allProducts.size}`);
      successfulQueries++;
    } else {
      console.log(`   ❌ Sin resultados`);
      failedQueries++;
    }
    
    // Pausa entre requests
    if (i < MAIN_PRODUCT_CATEGORIES.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const uniqueProducts = Array.from(allProducts.values());

  console.log(`\n🎉 Scraping completado:`);
  console.log(`   📊 Total productos únicos: ${uniqueProducts.length}`);
  console.log(`   ✅ Categorías exitosas: ${successfulQueries}`);
  console.log(`   ❌ Categorías fallidas: ${failedQueries}`);

  return {
    success: true,
    source: 'carrefour',
    totalProducts: uniqueProducts.length,
    products: uniqueProducts,
    timestamp: new Date().toISOString()
  };
} 