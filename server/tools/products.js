const shopify = require('../shopify');
const storeConfig = require('../../store-config.json');

const defaultBrandKnowledge = {
  brand_lines: {
    pacco: ['hydra', 'vyta'],
    owala: ['freesip', 'freesip twist'],
  },
  avoid_model_question_for: ['owala'],
};

const brandKnowledge = storeConfig.brand_knowledge || defaultBrandKnowledge;

function tokenizeQuery(query) {
  return String(query || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function looksSpecificQuery(query) {
  const q = String(query || '').toLowerCase();
  return /\d+\s?(ml|l)\b|\b(vyta|hydra|freestyle|flip|tumbler|modelo)\b|\b(500|650|750|950|1180)\b/.test(q);
}

function detectBrand(query, products) {
  const q = String(query || '').toLowerCase();

  if (q.includes('owala')) return 'owala';
  if (q.includes('pacco')) return 'pacco';

  const text = (products || [])
    .slice(0, 3)
    .map((p) => String((p && p.title) || '').toLowerCase())
    .join(' ');

  if (text.includes('owala')) return 'owala';
  if (text.includes('pacco')) return 'pacco';

  return null;
}

function queryHasCapacity(query) {
  return /\b\d{2,4}\s?(ml|l|oz)\b/i.test(String(query || ''));
}

function queryAsksColor(query) {
  return /\b(cor|cores|color|colorida|rosa|azul|preta|preto|verde|branca|branco|vermelha|vermelho)\b/i.test(
    String(query || '')
  );
}

function hasBrandLineMention(query, brand) {
  const lines = (brandKnowledge.brand_lines && brandKnowledge.brand_lines[brand]) || [];
  const q = String(query || '').toLowerCase();
  return lines.some((line) => q.includes(String(line).toLowerCase()));
}

function buildClarificationQuestion(query, products) {
  const brand = detectBrand(query, products);
  const hasCapacity = queryHasCapacity(query);
  const asksColor = queryAsksColor(query);
  const avoidModelBrands = Array.isArray(brandKnowledge.avoid_model_question_for)
    ? brandKnowledge.avoid_model_question_for.map((b) => String(b).toLowerCase())
    : [];

  if (asksColor) {
    return null;
  }

  if (brand === 'owala') {
    if (hasCapacity) {
      return null;
    }
    return 'Tem sim. Você prefere qual capacidade (ex: 710ml ou 946ml)?';
  }

  if (brand === 'pacco') {
    if (!hasBrandLineMention(query, 'pacco')) {
      return 'Tem sim. Você procura a linha Hydra ou Vyta?';
    }
    if (!hasCapacity) {
      return 'Perfeito. Qual capacidade você prefere (ex: 500ml, 650ml ou 950ml)?';
    }
    return null;
  }

  if (brand && avoidModelBrands.includes(brand)) {
    return hasCapacity ? null : 'Perfeito. Qual capacidade você prefere?';
  }

  return hasCapacity ? null : 'Tem sim. Qual capacidade você prefere?';
}

async function handleSearchProducts({ query }) {
  try {
    const search = await shopify.searchProductsSmart(query);
    const products = search.products || [];
    const matchedCount = products.length;
    const tokens = tokenizeQuery(query);
    const broadIntent = matchedCount >= 3 && !looksSpecificQuery(query) && tokens.length <= 4;

    // Quando a busca está ampla (ex: "garrafa pacco"), orientamos o agente a
    // perguntar preferências antes de listar vários itens para o cliente.
    const shouldClarify = Boolean(search.needs_clarification) || broadIntent;
    const clarificationQuestion = buildClarificationQuestion(query, products);
    const colorIntent = queryAsksColor(query);

    if (!products || products.length === 0) {
      return {
        found: false,
        confidence: search.confidence || 'low',
        needs_clarification: true,
        clarification_hint:
          search.clarification_hint || 'Nao encontrei com seguranca. Pergunte marca, tamanho ou cor.',
        message: 'Nenhum produto encontrado para essa busca.',
        strategies: search.strategies || ['admin_catalog'],
        catalog_size: search.catalog_size || 0,
        admin_catalog_error: search.admin_catalog_error || null,
      };
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

    return {
      found: true,
      products: shouldClarify ? [] : results,
      preview_products: shouldClarify ? results.slice(0, 2) : [],
      matched_count: matchedCount,
      confidence: search.confidence || 'medium',
      needs_clarification: shouldClarify,
      clarification_hint:
        shouldClarify
          ? 'Busca ampla. Faça apenas 1 pergunta objetiva alinhada a marca e capacidade.'
          : search.clarification_hint || null,
      suggested_question:
        shouldClarify && clarificationQuestion
          ? clarificationQuestion
          : null,
      color_request_detected: colorIntent,
      color_response_guidance: colorIntent
        ? 'Se o cliente perguntar por cor, envie o link do produto (se ainda nao tiver sido enviado) e informe que as cores disponiveis aparecem ao abrir o link.'
        : null,
      strategies: search.strategies || ['admin_catalog'],
      catalog_size: search.catalog_size || 0,
      admin_catalog_error: search.admin_catalog_error || null,
    };
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
