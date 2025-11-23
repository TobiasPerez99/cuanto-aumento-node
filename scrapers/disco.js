import axios from 'axios';

// Hash VTEX desde variables de entorno
const VTEX_SHA256_HASH = process.env.VTEX_SHA256_HASH;

// Verificar que el hash esté configurado
if (!VTEX_SHA256_HASH) {
  throw new Error('❌ VTEX_SHA256_HASH no está configurado en las variables de entorno');
}

// 🚫 MARCAS PROPIAS A EXCLUIR (Para evitar productos que solo existen en este super)
const BRAND_BLACKLIST = [
  'cuisine & co',
  'cuisine&co',
  'family care',
  'máxima',
  'maxima',
  'disco',
  'jumbo',
  'vea',
  'home care',
  'check'
];

// 🎯 CATEGORÍAS PRINCIPALES
const MAIN_PRODUCT_CATEGORIES = [
  'almacen',
  'bebidas', 
  'limpieza',
  'lacteos',
  'productos frescos',
  'panaderia',
  'congelados',
  'frutas y verduras',
  'carnes',
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
 * Genera las variables para la query de VTEX
 */
function getVariablesWithQuery(query) {
  return {
    productOriginVtex: true,
    simulationBehavior: "default",
    hideUnavailableItems: true,
    fullText: query,
    count: 20,
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
 * Construye los parámetros de query
 */
function encodeQueryParams(params) {
  const queryParams = [];
  for (const [key, value] of Object.entries(params)) {
    queryParams.push(key + "=" + value);
  }
  return "?" + queryParams.join("&");
}

/**
 * Codifica la query completa para la URL
 */
function encodeQuery(query) {
  const extensions = JSON.stringify(getExtensionsWithQuery(query));
  const params = {
    workspace: "master",
    maxAge: "medium",
    appsEtag: "remove",
    domain: "store",
    locale: "es-AR",
    operationName: "productSuggestions",
    variables: encodeUrl("{}"),
    extensions: encodeUrl(extensions)
  };
  return encodeQueryParams(params);
}

/**
 * Normaliza un producto de la respuesta de VTEX al formato estándar
 * ⚠️ AQUÍ ES DONDE EXTRAEMOS EL EAN
 */
function normalizeProduct(rawProduct, source = 'disco') {
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

  // Verificar Marca Propia
  if (rawProduct.brand && BRAND_BLACKLIST.includes(rawProduct.brand.toLowerCase())) {
    return null;
  }

  const baseUrl = 'https://www.disco.com.ar';
  
  // Intentar extraer EAN
  let ean = rawProduct.items[0].ean;
  
  // A veces el EAN viene vacío o es inválido, filtramos esos casos si queremos ser estrictos
  // Pero por ahora lo guardamos tal cual para debug
  
  return {
    ean: ean, // 👈 LA CLAVE MAESTRA
    id: rawProduct.productId,
    source: source,
    name: rawProduct.productName,
    link: `${baseUrl}/${rawProduct.linkText}/p`,
    image: rawProduct.items[0].images[0].imageUrl,
    price: rawProduct.priceRange.sellingPrice.lowPrice,
    listPrice: rawProduct.priceRange.listPrice?.lowPrice || rawProduct.priceRange.sellingPrice.lowPrice,
    brand: rawProduct.brand,
    categories: rawProduct.categories,
    unavailable: false
  };
}

/**
 * Hace una búsqueda individual a Disco
 */
async function fetchDiscoProducts(query) {
  const baseUrl = 'https://www.disco.com.ar/_v/segment/graphql/v1/';
  const url = baseUrl + encodeQuery(query);

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept': 'application/json'
      },
      timeout: 15000
    });

    const data = response.data;
    
    if (data.errors && data.errors.length > 0) {
      throw new Error(`API Error: ${data.errors[0].message}`);
    }

    if (!data.data || !data.data.productSuggestions || !data.data.productSuggestions.products) {
      throw new Error('Estructura de respuesta inesperada de la API');
    }

    const rawProducts = data.data.productSuggestions.products;
    
    const normalizedProducts = rawProducts
      .map(product => normalizeProduct(product))
      .filter(product => product !== null); // Elimina nulos (errores o marcas propias)

    return normalizedProducts;

  } catch (error) {
    console.error(`❌ Error buscando "${query}" en Disco:`, error.message);
    return [];
  }
}

/**
 * 🎯 FUNCIÓN PRINCIPAL
 */
export async function getDiscoMainProducts() {
  console.log('🛒 Obteniendo productos principales de Disco (MAESTRO)...');
  console.log(`📋 Buscando en ${MAIN_PRODUCT_CATEGORIES.length} categorías`);
  
  const allProducts = new Map();
  let successfulQueries = 0;
  let failedQueries = 0;
  
  for (let i = 0; i < MAIN_PRODUCT_CATEGORIES.length; i++) {
    const category = MAIN_PRODUCT_CATEGORIES[i];
    console.log(`[${i+1}/${MAIN_PRODUCT_CATEGORIES.length}] 🔍 Categoría: "${category}"`);
    
    const products = await fetchDiscoProducts(category);
    
    if (products.length > 0) {
      products.forEach(product => {
        // Usamos EAN como clave si existe, sino ID
        const key = product.ean || product.id;
        if (!allProducts.has(key)) {
          allProducts.set(key, product);
        }
      });
      
      console.log(`   ✅ ${products.length} productos encontrados`);
      successfulQueries++;
    } else {
      console.log(`   ❌ Sin resultados`);
      failedQueries++;
    }
    
    if (i < MAIN_PRODUCT_CATEGORIES.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const uniqueProducts = Array.from(allProducts.values());

  return {
    success: true,
    source: 'disco',
    totalProducts: uniqueProducts.length,
    products: uniqueProducts,
    timestamp: new Date().toISOString()
  };
}
