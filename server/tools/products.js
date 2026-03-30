const shopify = require('../shopify');

async function handleSearchProducts({ query }) {
  try {
    const products = await shopify.searchProducts(query);

    if (!products || products.length === 0) {
      return { found: false, message: 'Nenhum produto encontrado para essa busca.' };
    }

    const results = await Promise.all(
      products.map(async (p) => {
        const stock = await shopify.getProductStock(p);
        const minPrice = Math.min(...p.variants.map((v) => parseFloat(v.price)));
        const hasOpenStock = stock === Number.MAX_SAFE_INTEGER;

        return {
          id: p.id,
          title: p.title,
          handle: p.handle,
          url: `https://${process.env.SHOPIFY_STORE}/products/${p.handle}`,
          price: `R$ ${minPrice.toFixed(2).replace('.', ',')}`,
          in_stock: hasOpenStock || stock > 0,
          stock_qty: hasOpenStock ? null : stock,
          image: p.images && p.images[0] ? p.images[0].src : null,
        };
      })
    );

    return { found: true, products: results };
  } catch (err) {
    return {
      found: false,
      message: 'Não consegui consultar o catálogo agora. Tente novamente em instantes.',
      error: err.message,
    };
  }
}

async function handleGetComplementaryProducts({ product_id }) {
  try {
    const complementary = await shopify.getComplementaryProducts(product_id);

    if (!complementary || complementary.length === 0) {
      return { found: false, message: 'Nenhum produto complementar configurado para este produto.' };
    }

    const results = await Promise.all(
      complementary.map(async (p) => {
        const stock = await shopify.getProductStock(p);
        const minPrice = Math.min(...p.variants.map((v) => parseFloat(v.price)));
        const hasOpenStock = stock === Number.MAX_SAFE_INTEGER;

        return {
          id: p.id,
          title: p.title,
          handle: p.handle,
          url: `https://${process.env.SHOPIFY_STORE}/products/${p.handle}`,
          price: `R$ ${minPrice.toFixed(2).replace('.', ',')}`,
          in_stock: hasOpenStock || stock > 0,
          stock_qty: hasOpenStock ? null : stock,
          image: p.images && p.images[0] ? p.images[0].src : null,
        };
      })
    );

    return { found: true, products: results };
  } catch (err) {
    return {
      found: false,
      message: 'Não consegui consultar os produtos complementares agora. Tente novamente em instantes.',
      error: err.message,
    };
  }
}

async function handleFindCompatibleProducts({ query }) {
  try {
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return { found: false, message: 'Informe o produto base para buscar compatibilidade.' };
    }

    const baseProducts = await shopify.searchProducts(query.trim());
    if (!baseProducts || baseProducts.length === 0) {
      return { found: false, message: 'Não encontrei o produto base para consultar compatibilidade.' };
    }

    const baseProduct = baseProducts[0];
    const compatibleProducts = await shopify.getComplementaryProducts(baseProduct.id);

    if (!compatibleProducts || compatibleProducts.length === 0) {
      return {
        found: false,
        base_product: {
          id: baseProduct.id,
          title: baseProduct.title,
          handle: baseProduct.handle,
          url: `https://${process.env.SHOPIFY_STORE}/products/${baseProduct.handle}`,
        },
        message: 'Este produto não possui complementares/compatíveis configurados no Search & Discovery.',
      };
    }

    const results = await Promise.all(
      compatibleProducts.map(async (p) => {
        const stock = await shopify.getProductStock(p);
        const minPrice = Math.min(...p.variants.map((v) => parseFloat(v.price)));
        const hasOpenStock = stock === Number.MAX_SAFE_INTEGER;

        return {
          id: p.id,
          title: p.title,
          handle: p.handle,
          url: `https://${process.env.SHOPIFY_STORE}/products/${p.handle}`,
          price: `R$ ${minPrice.toFixed(2).replace('.', ',')}`,
          in_stock: hasOpenStock || stock > 0,
          stock_qty: hasOpenStock ? null : stock,
          image: p.images && p.images[0] ? p.images[0].src : null,
        };
      })
    );

    return {
      found: true,
      base_product: {
        id: baseProduct.id,
        title: baseProduct.title,
        handle: baseProduct.handle,
        url: `https://${process.env.SHOPIFY_STORE}/products/${baseProduct.handle}`,
      },
      products: results,
      source: 'search_discovery_complementary_products',
    };
  } catch (err) {
    return {
      found: false,
      message: 'Não consegui consultar produtos compatíveis agora. Tente novamente em instantes.',
      error: err.message,
    };
  }
}

module.exports = {
  handleSearchProducts,
  handleGetComplementaryProducts,
  handleFindCompatibleProducts,
};
