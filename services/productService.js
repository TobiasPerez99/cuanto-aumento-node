import { prisma } from '../config/prisma.js';

/**
 * Obtiene lista paginada de productos que tienen precios en supermercados
 * Query desde supermarket_products para mostrar solo productos disponibles
 */
export async function getProducts({ page = 1, limit = 20, sort = 'name' }) {
  const offset = (page - 1) * limit;

  // Fetch supermarket_products with nested relations
  const supermarketProducts = await prisma.supermarketProduct.findMany({
    where: {
      isAvailable: true,
      price: { not: null },
    },
    select: {
      productEan: true,
      price: true,
      listPrice: true,
      isAvailable: true,
      supermarket: {
        select: { name: true },
      },
      product: {
        select: {
          ean: true,
          name: true,
          brand: true,
          category: true,
          imageUrl: true,
        },
      },
    },
    orderBy: { productEan: 'asc' },
    skip: offset,
    take: limit,
  });

  // Group by product (application logic - same as original)
  const productsMap = new Map();

  supermarketProducts.forEach(sp => {
    const ean = sp.productEan;

    if (!productsMap.has(ean)) {
      productsMap.set(ean, {
        ean: sp.product?.ean,
        name: sp.product?.name,
        brand: sp.product?.brand,
        category: sp.product?.category,
        image_url: sp.product?.imageUrl,
        prices: [],
        min_price: Infinity,
      });
    }

    const product = productsMap.get(ean);
    product.prices.push({
      supermarket: sp.supermarket?.name,
      price: Number(sp.price),
      list_price: sp.listPrice ? Number(sp.listPrice) : null,
    });

    const priceNum = Number(sp.price);
    if (priceNum < product.min_price) {
      product.min_price = priceNum;
    }
  });

  // Convert to array and sort (same as original)
  let products = Array.from(productsMap.values());

  if (sort === 'name') {
    products.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (sort === 'price') {
    products.sort((a, b) => a.min_price - b.min_price);
  }

  products = products.map(p => ({
    ...p,
    min_price: p.min_price === Infinity ? null : p.min_price,
  }));

  // Get total count of unique products
  const totalCount = await prisma.supermarketProduct.groupBy({
    by: ['productEan'],
    where: {
      isAvailable: true,
      price: { not: null },
    },
  });

  return {
    products,
    pagination: {
      page,
      limit,
      total: totalCount.length,
      totalPages: Math.ceil(totalCount.length / limit),
    },
  };
}

/**
 * Obtiene productos por categoría
 */
export async function getProductsByCategory({ category, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;

  const [products, totalCount] = await prisma.$transaction([
    // Fetch products
    prisma.product.findMany({
      where: {
        category: { contains: category, mode: 'insensitive' },
      },
      select: {
        ean: true,
        name: true,
        brand: true,
        category: true,
        imageUrl: true,
        supermarketProducts: {
          select: {
            price: true,
            listPrice: true,
            isAvailable: true,
            supermarket: {
              select: { name: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
      skip: offset,
      take: limit,
    }),
    // Get count
    prisma.product.count({
      where: {
        category: { contains: category, mode: 'insensitive' },
      },
    }),
  ]);

  // Process products (same logic as original)
  const processedProducts = products.map(product => {
    const availablePrices = product.supermarketProducts
      .filter(sp => sp.isAvailable && sp.price)
      .map(sp => Number(sp.price));

    return {
      ean: product.ean,
      name: product.name,
      brand: product.brand,
      category: product.category,
      image_url: product.imageUrl,
      prices: product.supermarketProducts
        .filter(sp => sp.isAvailable)
        .map(sp => ({
          supermarket: sp.supermarket?.name,
          price: sp.price ? Number(sp.price) : null,
          list_price: sp.listPrice ? Number(sp.listPrice) : null,
        })),
      min_price: availablePrices.length > 0 ? Math.min(...availablePrices) : null,
    };
  });

  return {
    products: processedProducts,
    pagination: {
      page,
      limit,
      total: totalCount,
      totalPages: Math.ceil(totalCount / limit),
    },
  };
}

/**
 * Obtiene detalle de un producto con historial de precios completo
 */
export async function getProductByEan(ean) {
  // Single query with nested includes
  const product = await prisma.product.findUnique({
    where: { ean },
    include: {
      supermarketProducts: {
        include: {
          supermarket: {
            select: { id: true, name: true },
          },
          priceHistory: {
            select: {
              price: true,
              listPrice: true,
              scrapedAt: true,
            },
            orderBy: { scrapedAt: 'desc' },
          },
        },
      },
    },
  });

  if (!product) {
    return null;
  }

  // Format response (same logic as original)
  const supermarkets = product.supermarketProducts.map(sp => ({
    name: sp.supermarket?.name,
    price: sp.price ? Number(sp.price) : null,
    list_price: sp.listPrice ? Number(sp.listPrice) : null,
    reference_price: sp.referencePrice ? Number(sp.referencePrice) : null,
    reference_unit: sp.referenceUnit,
    is_available: sp.isAvailable,
    product_url: sp.productUrl,
    last_checked_at: sp.lastCheckedAt,
    price_history: sp.priceHistory.map(ph => ({
      price: Number(ph.price),
      list_price: ph.listPrice ? Number(ph.listPrice) : null,
      date: ph.scrapedAt,
    })),
  }));

  // Calculate min price
  const availablePrices = supermarkets
    .filter(s => s.is_available && s.price)
    .map(s => s.price);

  const minPrice = availablePrices.length > 0
    ? Math.min(...availablePrices)
    : null;

  const cheapestSupermarket = supermarkets.find(
    s => s.is_available && s.price === minPrice
  );

  return {
    ean: product.ean,
    name: product.name,
    description: product.description,
    brand: product.brand,
    image_url: product.imageUrl,
    images: product.images,
    category: product.category,
    product_url: product.productUrl,
    supermarkets,
    min_price: minPrice,
    cheapest_at: cheapestSupermarket?.name || null,
  };
}

/**
 * Busca productos por nombre
 */
export async function searchProducts({ query, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;

  const searchFilter = {
    OR: [
      { name: { contains: query, mode: 'insensitive' } },
      { brand: { contains: query, mode: 'insensitive' } },
    ],
  };

  const [products, totalCount] = await prisma.$transaction([
    prisma.product.findMany({
      where: searchFilter,
      select: {
        ean: true,
        name: true,
        brand: true,
        category: true,
        imageUrl: true,
        supermarketProducts: {
          select: {
            price: true,
            listPrice: true,
            isAvailable: true,
            supermarket: {
              select: { name: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
      skip: offset,
      take: limit,
    }),
    prisma.product.count({ where: searchFilter }),
  ]);

  // Process products (same logic as getProductsByCategory)
  const processedProducts = products.map(product => {
    const availablePrices = product.supermarketProducts
      .filter(sp => sp.isAvailable && sp.price)
      .map(sp => Number(sp.price));

    return {
      ean: product.ean,
      name: product.name,
      brand: product.brand,
      category: product.category,
      image_url: product.imageUrl,
      prices: product.supermarketProducts
        .filter(sp => sp.isAvailable)
        .map(sp => ({
          supermarket: sp.supermarket?.name,
          price: sp.price ? Number(sp.price) : null,
          list_price: sp.listPrice ? Number(sp.listPrice) : null,
        })),
      min_price: availablePrices.length > 0 ? Math.min(...availablePrices) : null,
    };
  });

  return {
    products: processedProducts,
    pagination: {
      page,
      limit,
      total: totalCount,
      totalPages: Math.ceil(totalCount / limit),
    },
  };
}

/**
 * Obtiene lista de categorías únicas
 */
export async function getCategories() {
  const products = await prisma.product.findMany({
    where: {
      category: { not: null },
    },
    select: { category: true },
  });

  // Count categories (same logic as original)
  const categoryCount = {};
  products.forEach(row => {
    const cat = row.category;
    if (cat) {
      categoryCount[cat] = (categoryCount[cat] || 0) + 1;
    }
  });

  const categories = Object.entries(categoryCount)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { categories };
}

/**
 * Obtiene el supermercado más barato para un producto
 */
export async function getCheapestForProduct(ean) {
  const [cheapest, allPrices] = await prisma.$transaction([
    // Get cheapest
    prisma.supermarketProduct.findFirst({
      where: {
        productEan: ean,
        isAvailable: true,
        price: { not: null },
      },
      select: {
        price: true,
        listPrice: true,
        isAvailable: true,
        productUrl: true,
        supermarket: {
          select: { name: true },
        },
      },
      orderBy: { price: 'asc' },
    }),
    // Get all prices
    prisma.supermarketProduct.findMany({
      where: {
        productEan: ean,
        isAvailable: true,
        price: { not: null },
      },
      select: {
        price: true,
        supermarket: {
          select: { name: true },
        },
      },
    }),
  ]);

  if (!cheapest) {
    return null;
  }

  const prices = allPrices.map(sp => Number(sp.price));
  const maxPrice = Math.max(...prices);
  const cheapestPrice = Number(cheapest.price);
  const savings = maxPrice - cheapestPrice;
  const savingsPercent = ((savings / maxPrice) * 100).toFixed(1);

  return {
    supermarket: cheapest.supermarket?.name,
    price: cheapestPrice,
    list_price: cheapest.listPrice ? Number(cheapest.listPrice) : null,
    product_url: cheapest.productUrl,
    savings: savings > 0 ? savings : 0,
    savings_percent: savings > 0 ? parseFloat(savingsPercent) : 0,
    compared_to: allPrices.length,
  };
}

/**
 * Obtiene estadísticas de variación de precios por categoría
 */
export async function getCategoryStats() {
  const products = await prisma.product.findMany({
    where: {
      category: { not: null },
    },
    select: {
      category: true,
      supermarketProducts: {
        select: {
          price: true,
          isAvailable: true,
        },
      },
    },
  });

  // Aggregate by category (same logic as original)
  const categoryStats = {};

  products.forEach(product => {
    const cat = product.category;
    if (!cat) return;

    if (!categoryStats[cat]) {
      categoryStats[cat] = {
        name: cat,
        product_count: 0,
        prices: [],
      };
    }

    categoryStats[cat].product_count++;

    product.supermarketProducts
      .filter(sp => sp.isAvailable && sp.price)
      .forEach(sp => {
        categoryStats[cat].prices.push(Number(sp.price));
      });
  });

  // Calculate statistics (same logic)
  const stats = Object.values(categoryStats).map(cat => {
    const prices = cat.prices;
    const avg = prices.length > 0
      ? prices.reduce((a, b) => a + b, 0) / prices.length
      : 0;
    const min = prices.length > 0 ? Math.min(...prices) : 0;
    const max = prices.length > 0 ? Math.max(...prices) : 0;

    return {
      category: cat.name,
      product_count: cat.product_count,
      avg_price: Math.round(avg * 100) / 100,
      min_price: min,
      max_price: max,
      price_range: max - min,
    };
  }).sort((a, b) => b.product_count - a.product_count);

  return { stats };
}
