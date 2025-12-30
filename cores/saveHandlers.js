import { prisma } from "../config/prisma.js";

export async function saveMasterProduct(product, supermarketId) {
  try {
    // 1. Upsert product (master catalog)
    await prisma.product.upsert({
      where: { ean: product.ean },
      update: {
        name: product.name,
        description: product.description || product.name,
        brand: product.brand,
        imageUrl: product.image,
        images: product.images,
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
        images: product.images,
        category:
          product.categories && product.categories.length > 0
            ? product.categories[0]
            : null,
        productUrl: product.link,
      },
    });

    // 2. Upsert supermarket_product and get ID
    const supermarketProduct = await prisma.supermarketProduct.upsert({
      where: {
        productEan_supermarketId: {
          productEan: product.ean,
          supermarketId: supermarketId,
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
        supermarketId: supermarketId,
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
        supermarketProductId: supermarketProduct.id,
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

export async function saveFollowerProduct(product, supermarketId) {
  try {
    // 1. Check if product exists in master catalog
    const existingProduct = await prisma.product.findUnique({
      where: { ean: product.ean },
      select: { ean: true }, // Only fetch EAN for efficiency
    });

    if (!existingProduct) {
      return { saved: false, reason: "not_in_master" };
    }

    // 2. Upsert supermarket_product (same as saveMasterProduct)
    const supermarketProduct = await prisma.supermarketProduct.upsert({
      where: {
        productEan_supermarketId: {
          productEan: product.ean,
          supermarketId: supermarketId,
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
        supermarketId: supermarketId,
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
        supermarketProductId: supermarketProduct.id,
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
