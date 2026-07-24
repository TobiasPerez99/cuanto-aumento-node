import { prisma } from "../config/prisma.js";

export async function saveMasterProduct(product, merchantId) {
  try {
    // Serialize images array to JSON string
    const imagesJson = product.images && Array.isArray(product.images)
      ? JSON.stringify(product.images)
      : null;

    // 1. Upsert product (master catalog)
    await prisma.product.upsert({
      where: { ean: product.ean },
      update: {
        name: product.name,
        description: product.description || product.name,
        brand: product.brand,
        imageUrl: product.image,
        images: imagesJson,
        category:
          product.categories && product.categories.length > 0
            ? product.categories[0]
            : null,
        productUrl: product.link,
      },
      create: {
        ean: product.ean,
        name: product.name,
        description: product.description || product.name,
        brand: product.brand,
        imageUrl: product.image,
        images: imagesJson,
        category:
          product.categories && product.categories.length > 0
            ? product.categories[0]
            : null,
        productUrl: product.link,
      },
    });

    // 2. Upsert merchant_product and get ID
    const merchantProduct = await prisma.merchantProduct.upsert({
      where: {
        productEan_merchantId: {
          productEan: product.ean,
          merchantId: merchantId,
        },
      },
      update: {
        externalId: product.external_id,
        productUrl: product.link,
        price: product.price,
        listPrice: product.list_price,
        referencePrice: product.reference_price,
        referenceUnit: product.reference_unit,
        isAvailable: product.is_available,
        lastCheckedAt: new Date(),
      },
      create: {
        productEan: product.ean,
        merchantId: merchantId,
        externalId: product.external_id,
        productUrl: product.link,
        price: product.price,
        listPrice: product.list_price,
        referencePrice: product.reference_price,
        referenceUnit: product.reference_unit,
        isAvailable: product.is_available,
        lastCheckedAt: new Date(),
      },
    });

    // 3. Insert price history
    await prisma.priceHistory.create({
      data: {
        merchantProductId: merchantProduct.id,
        price: product.price,
        listPrice: product.list_price,
        scrapedAt: new Date(),
      },
    });

    return { saved: true };
  } catch (error) {
    console.error(`❌ Error general guardando ${product.ean}:`, error.message);
    return { saved: false, reason: "exception" };
  }
}

export async function saveFollowerProduct(product, merchantId) {
  try {
    // 1. Check if product exists in master catalog
    const existingProduct = await prisma.product.findUnique({
      where: { ean: product.ean },
      select: { ean: true }, // Only fetch EAN for efficiency
    });

    if (!existingProduct) {
      return { saved: false, reason: "not_in_master" };
    }

    // 2. Upsert merchant_product (same as saveMasterProduct)
    const merchantProduct = await prisma.merchantProduct.upsert({
      where: {
        productEan_merchantId: {
          productEan: product.ean,
          merchantId: merchantId,
        },
      },
      update: {
        externalId: product.external_id,
        productUrl: product.link,
        price: product.price,
        listPrice: product.list_price,
        referencePrice: product.reference_price,
        referenceUnit: product.reference_unit,
        isAvailable: product.is_available,
        lastCheckedAt: new Date(),
      },
      create: {
        productEan: product.ean,
        merchantId: merchantId,
        externalId: product.external_id,
        productUrl: product.link,
        price: product.price,
        listPrice: product.list_price,
        referencePrice: product.reference_price,
        referenceUnit: product.reference_unit,
        isAvailable: product.is_available,
        lastCheckedAt: new Date(),
      },
    });

    // 3. Insert price history
    await prisma.priceHistory.create({
      data: {
        merchantProductId: merchantProduct.id,
        price: product.price,
        listPrice: product.list_price,
        scrapedAt: new Date(),
      },
    });

    return { saved: true };
  } catch (error) {
    console.error(`❌ Error general guardando ${product.ean}:`, error.message);
    return { saved: false, reason: "exception" };
  }
}

export async function saveBankModo(bank) {
  try {
    const savedBank = await prisma.bank.upsert({
      where: { bcraCode: bank.bcraCode },
      update: {
        sourceId: bank.sourceId,
        name: bank.name,
        image: bank.image,
        promotionUrl: bank.promotionUrl,
        hubBankId: bank.hubBankId,
        onHubList: bank.onHubList,
        isActive: bank.isActive,
        dataSource: bank.dataSource,
      },
      create: {
        sourceId: bank.sourceId,
        name: bank.name,
        image: bank.image,
        promotionUrl: bank.promotionUrl,
        bcraCode: bank.bcraCode,
        hubBankId: bank.hubBankId,
        onHubList: bank.onHubList,
        isActive: bank.isActive,
        dataSource: bank.dataSource,
      },
    });

    return { saved: true, bank: savedBank };
  } catch (error) {
    console.error(`❌ Error guardando banco ${bank.name}:`, error.message);
    return { saved: false, reason: 'exception', error: error.message };
  }
}

/**
 * Cache de sucursales por (merchantId, code) → merchantStoreId, a nivel módulo,
 * para no upsertear la misma tienda por cada producto durante un run.
 */
const storeCache = new Map();

async function ensureStore(merchantId, code) {
  const key = `${merchantId}:${code}`;
  if (storeCache.has(key)) return storeCache.get(key);

  const store = await prisma.merchantStore.upsert({
    where: { merchantId_externalReference: { merchantId, externalReference: code } },
    update: {}, // no pisar nombre/coords enriquecidos por el sync de sucursales
    create: {
      merchantId,
      externalReference: code,
      name: code, // placeholder hasta el enriquecimiento (stores:sync coto / backoffice)
      storeType: 'physical',
      isActive: true,
    },
  });
  storeCache.set(key, store.id);
  return store.id;
}

/**
 * Follower con precios por sucursal (Coto). Skip si el EAN no está en el master.
 * Escribe headline = MIN entre sucursales + price_history + merchant_store_prices.
 */
export async function saveCotoProduct(product, merchantId) {
  try {
    const existing = await prisma.product.findUnique({
      where: { ean: product.ean },
      select: { ean: true },
    });
    if (!existing) {
      return { saved: false, reason: 'not_in_master' };
    }

    const stores = Array.isArray(product.storePrices) ? product.storePrices : [];
    const available = stores.filter((s) => s.isAvailable && s.price != null);
    const source = available.length > 0 ? available : stores;

    if (source.length === 0) {
      return { saved: false, reason: 'no_prices' };
    }

    // Headline = MIN entre sucursales (disponibles si las hay).
    const minRow = source.reduce((min, s) => (s.price < min.price ? s : min), source[0]);
    const headlinePrice = minRow.price;
    const headlineList = minRow.listPrice;

    const merchantProduct = await prisma.merchantProduct.upsert({
      where: { productEan_merchantId: { productEan: product.ean, merchantId } },
      update: {
        productUrl: product.link,
        price: headlinePrice,
        listPrice: headlineList,
        isAvailable: available.length > 0,
        lastCheckedAt: new Date(),
      },
      create: {
        productEan: product.ean,
        merchantId,
        productUrl: product.link,
        price: headlinePrice,
        listPrice: headlineList,
        isAvailable: available.length > 0,
        lastCheckedAt: new Date(),
      },
    });

    await prisma.priceHistory.create({
      data: { merchantProductId: merchantProduct.id, price: headlinePrice, listPrice: headlineList, scrapedAt: new Date() },
    });

    // Precios por sucursal (bootstrapeando la fila de sucursal por código).
    for (const sp of stores) {
      const merchantStoreId = await ensureStore(merchantId, sp.code);
      await prisma.merchantStorePrice.upsert({
        where: { merchantProductId_merchantStoreId: { merchantProductId: merchantProduct.id, merchantStoreId } },
        update: { price: sp.price, listPrice: sp.listPrice, isAvailable: sp.isAvailable, lastCheckedAt: new Date() },
        create: { merchantProductId: merchantProduct.id, merchantStoreId, price: sp.price, listPrice: sp.listPrice, isAvailable: sp.isAvailable, lastCheckedAt: new Date() },
      });
    }

    return { saved: true };
  } catch (error) {
    console.error(`❌ Error guardando Coto ${product.ean}:`, error.message);
    return { saved: false, reason: 'exception' };
  }
}
