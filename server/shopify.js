const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const STORE = process.env.SHOPIFY_STORE;
const STATIC_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SHOPIFY_REFRESH_TOKEN;
const API_VERSION = '2024-04';
const BASE_URL = STORE ? `https://${STORE}/admin/api/${API_VERSION}` : null;
const STOREFRONT_BASE_URL = STORE ? `https://${STORE}` : null;
const CATALOG_TTL_MS = 10 * 60 * 1000;

// Caminho para persistir token atualizado
const TOKEN_FILE = path.join(__dirname, '../.shopify-tokens.json');

// Estado em memória do token atual
let tokenState = {
  accessToken: STATIC_ACCESS_TOKEN || null,
  refreshToken: REFRESH_TOKEN || null,
  expiresAt: STATIC_ACCESS_TOKEN ? Number.MAX_SAFE_INTEGER : 0,
};

let catalogCache = {
  products: [],
  loadedAt: 0,
  loadingPromise: null,
};

// Carrega tokens persistidos (caso o servidor tenha reiniciado)
function loadPersistedTokens() {
  try {
    if (STATIC_ACCESS_TOKEN) return;

    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      tokenState.accessToken = data.accessToken || null;
      tokenState.refreshToken = data.refreshToken || tokenState.refreshToken;
      tokenState.expiresAt = data.expiresAt || 0;
    }
  } catch {
    // ignora erros de leitura
  }
}

function persistTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenState, null, 2));
  } catch {
    // ignora erros de escrita
  }
}

function ensureTokenConfig() {
  if (!STORE) {
    throw new Error('SHOPIFY_STORE não configurado no .env');
  }

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET são obrigatórios para autenticar na Shopify');
  }
}

// Fluxo atual recomendado: client credentials grant
async function getClientCredentialsToken() {
  ensureTokenConfig();

  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Falha ao obter token Shopify por client_credentials (${res.status}): ${err}`);
  }

  const data = await res.json();

  tokenState.accessToken = data.access_token;
  const expiresIn = Number(data.expires_in || 86399);
  tokenState.expiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;

  persistTokens();
  return tokenState.accessToken;
}

// Fallback legado: refresh token
async function refreshAccessToken() {
  ensureTokenConfig();

  if (!tokenState.refreshToken) {
    throw new Error('Nenhum refresh token disponível. Configure SHOPIFY_REFRESH_TOKEN no .env');
  }

  const res = await fetch(`https://${STORE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: tokenState.refreshToken,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Falha ao renovar token Shopify (${res.status}): ${err}`);
  }

  const data = await res.json();

  tokenState.accessToken = data.access_token;
  if (data.refresh_token) {
    tokenState.refreshToken = data.refresh_token;
  }
  const expiresIn = Number(data.expires_in || 3600);
  tokenState.expiresAt = Date.now() + Math.max(expiresIn - 60, 60) * 1000;

  persistTokens();
  console.log('[Shopify] Access token renovado via refresh_token.');

  return tokenState.accessToken;
}

// Retorna um access token válido (renova se necessário)
async function getAccessToken() {
  if (STATIC_ACCESS_TOKEN) {
    return STATIC_ACCESS_TOKEN;
  }

  if (tokenState.accessToken && Date.now() < tokenState.expiresAt) {
    return tokenState.accessToken;
  }

  // Primeiro tenta client_credentials (fluxo recomendado pela Shopify)
  try {
    return await getClientCredentialsToken();
  } catch (clientCredentialsError) {
    // Se houver refresh token configurado, tenta o fluxo legado como fallback.
    if (tokenState.refreshToken) {
      try {
        return await refreshAccessToken();
      } catch {
        throw clientCredentialsError;
      }
    }
    throw clientCredentialsError;
  }
}

async function shopifyGet(apiPath) {
  if (!BASE_URL) {
    throw new Error('SHOPIFY_STORE não configurado no .env');
  }

  const token = await getAccessToken();

  if (!token) {
    throw new Error('Token Shopify ausente. Configure SHOPIFY_CLIENT_ID e SHOPIFY_CLIENT_SECRET.');
  }

  const res = await fetch(`${BASE_URL}${apiPath}`, {
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${err}`);
  }
  return res.json();
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ');
}

function queryTokens(query) {
  return normalizeText(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t && t.length >= 2);
}

function productMetadataText(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const options = Array.isArray(product.options) ? product.options : [];

  const variantText = variants
    .map((v) => [v.title, v.sku, v.barcode, v.option1, v.option2, v.option3].filter(Boolean).join(' '))
    .join(' ');

  const optionsText = options
    .map((o) => [o.name, ...(Array.isArray(o.values) ? o.values : [])].filter(Boolean).join(' '))
    .join(' ');

  return normalizeText(
    [
      product.title,
      product.handle,
      product.vendor,
      product.product_type,
      product.tags,
      stripHtml(product.body_html),
      optionsText,
      variantText,
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function productSearchScore(product, query) {
  const q = normalizeText(query).trim();
  if (!q) return 0;

  const haystack = productMetadataText(product);

  if (!haystack) return 0;

  let score = 0;
  if (haystack.includes(q)) score += 14;

  const title = normalizeText(product.title || '');
  const handle = normalizeText(product.handle || '');
  if (title === q) score += 20;
  if (title.startsWith(q)) score += 10;
  if (handle.includes(q)) score += 8;

  const terms = queryTokens(q);
  const titleTerms = queryTokens(title);
  const titleSet = new Set(titleTerms);

  for (const term of terms) {
    if (haystack.includes(term)) score += 3;
    if (titleSet.has(term)) score += 4;
    if (term.length >= 4 && handle.includes(term)) score += 2;
  }

  return score;
}

async function fetchAllActiveProducts() {
  const all = [];
  let sinceId = 0;
  const maxPages = 40;

  for (let page = 0; page < maxPages; page++) {
    const suffix = sinceId > 0 ? `&since_id=${sinceId}` : '';
    const data = await shopifyGet(`/products.json?limit=250&status=active${suffix}`);
    const batch = Array.isArray(data.products) ? data.products : [];

    if (batch.length === 0) break;

    all.push(...batch);
    sinceId = batch[batch.length - 1].id;

    if (batch.length < 250) break;
  }

  return all;
}

async function ensureCatalog() {
  const now = Date.now();
  const isFresh = now - catalogCache.loadedAt < CATALOG_TTL_MS;

  if (isFresh && catalogCache.products.length > 0) {
    return catalogCache.products;
  }

  if (catalogCache.loadingPromise) {
    await catalogCache.loadingPromise;
    return catalogCache.products;
  }

  catalogCache.loadingPromise = (async () => {
    const products = await fetchAllActiveProducts();
    catalogCache.products = products;
    catalogCache.loadedAt = Date.now();
  })();

  try {
    await catalogCache.loadingPromise;
  } finally {
    catalogCache.loadingPromise = null;
  }

  return catalogCache.products;
}

function extractHandlesFromSearchHtml(html) {
  const handles = new Set();
  const text = String(html || '');
  const regex = /href=["']\/products\/([^"'#?\/]+)["']/gi;

  let match = regex.exec(text);
  while (match) {
    if (match[1]) {
      handles.add(match[1]);
    }
    match = regex.exec(text);
  }

  return Array.from(handles);
}

function mapStorefrontProductToInternal(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const images = Array.isArray(product.images)
    ? product.images.map((img) => ({ src: img }))
    : product.featured_image
      ? [{ src: product.featured_image }]
      : [];

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    body_html: product.description,
    vendor: product.vendor,
    tags: Array.isArray(product.tags) ? product.tags.join(',') : String(product.tags || ''),
    images,
    variants: variants.map((v) => ({
      price: typeof v.price === 'number' ? String(v.price / 100) : String(v.price || '0'),
      inventory_quantity:
        typeof v.inventory_quantity === 'number' ? v.inventory_quantity : 0,
      inventory_management: v.inventory_management || null,
      inventory_policy: v.inventory_policy || null,
    })),
  };
}

async function getStorefrontProductByHandle(handle) {
  if (!STOREFRONT_BASE_URL) return null;

  const url = `${STOREFRONT_BASE_URL}/products/${encodeURIComponent(handle)}.js`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const product = await res.json();
  if (!product || !product.id) return null;

  return mapStorefrontProductToInternal(product);
}

async function searchProductsViaStorefront(query) {
  if (!STOREFRONT_BASE_URL || !query || !query.trim()) return [];

  const url = `${STOREFRONT_BASE_URL}/search?options%5Bprefix%5D=last&q=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url);
  if (!res.ok) return [];

  const html = await res.text();
  const handles = extractHandlesFromSearchHtml(html).slice(0, 8);
  if (handles.length === 0) return [];

  const products = await Promise.all(handles.map((h) => getStorefrontProductByHandle(h)));

  return products
    .filter(Boolean)
    .map((p) => ({ product: p, score: productSearchScore(p, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.product);
}

function detectSearchConfidence(query, ranked) {
  if (!ranked || ranked.length === 0) {
    return {
      confidence: 'low',
      needs_clarification: true,
      clarification_hint: 'Nao encontrei correspondencia clara. Pergunte marca, tamanho ou linha do produto.',
    };
  }

  const topScore = ranked[0].score;
  const secondScore = ranked[1] ? ranked[1].score : 0;
  const tokens = queryTokens(query);
  const topText = productMetadataText(ranked[0].product);
  const coveredTokens = tokens.filter((t) => topText.includes(t)).length;
  const coverage = tokens.length > 0 ? coveredTokens / tokens.length : 1;

  if (topScore >= 24 && coverage >= 0.75 && topScore >= secondScore + 6) {
    return {
      confidence: 'high',
      needs_clarification: false,
      clarification_hint: null,
    };
  }

  if (topScore >= 14 && coverage >= 0.5) {
    return {
      confidence: 'medium',
      needs_clarification: false,
      clarification_hint: 'Se o cliente demonstrar duvida, confirme marca, capacidade ou cor antes de concluir.',
    };
  }

  return {
    confidence: 'low',
    needs_clarification: true,
    clarification_hint: 'Correspondencia ambigua. Pergunte mais um detalhe objetivo antes de recomendar.',
  };
}

async function searchProductsSmart(query) {
  const products = await ensureCatalog();

  const rankedAdmin = products
    .map((p) => ({ product: p, score: productSearchScore(p, query), source: 'admin_catalog' }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  let ranked = rankedAdmin;
  const lowCoverage = rankedAdmin.length < 2;

  if (rankedAdmin.length === 0 || lowCoverage) {
    const storefront = await searchProductsViaStorefront(query);
    const rankedStorefront = storefront
      .map((p) => ({ product: p, score: productSearchScore(p, query), source: 'storefront_search' }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (rankedStorefront.length > 0) {
      const merged = [...rankedAdmin, ...rankedStorefront];
      const byId = new Map();
      for (const item of merged) {
        if (!item.product || !item.product.id) continue;
        const prev = byId.get(item.product.id);
        if (!prev || item.score > prev.score) {
          byId.set(item.product.id, item);
        }
      }
      ranked = Array.from(byId.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    }
  }

  const confidenceData = detectSearchConfidence(query, ranked);

  return {
    products: ranked.slice(0, 5).map((r) => r.product),
    confidence: confidenceData.confidence,
    needs_clarification: confidenceData.needs_clarification,
    clarification_hint: confidenceData.clarification_hint,
    strategies: ranked.some((r) => r.source === 'storefront_search')
      ? ['admin_catalog', 'storefront_search']
      : ['admin_catalog'],
    catalog_size: products.length,
  };
}

// Busca produtos por título/query
async function searchProducts(query) {
  const result = await searchProductsSmart(query);
  return result.products;
}

// Busca produto por ID com variantes e estoque
async function getProductById(productId) {
  const data = await shopifyGet(`/products/${productId}.json`);
  return data.product;
}

// Retorna inventory_item_ids das variantes e verifica estoque
async function getInventoryLevels(inventoryItemIds) {
  if (!Array.isArray(inventoryItemIds) || inventoryItemIds.length === 0) {
    return [];
  }

  const ids = inventoryItemIds.join(',');
  const data = await shopifyGet(`/inventory_levels.json?inventory_item_ids=${ids}&limit=50`);
  return data.inventory_levels;
}

// Retorna total em estoque para um produto
async function getProductStock(product) {
  const variants = Array.isArray(product.variants) ? product.variants : [];

  const trackedInventoryIds = variants
    .filter((v) => v && v.inventory_management === 'shopify' && v.inventory_item_id)
    .map((v) => v.inventory_item_id);

  const hasUntrackedAvailable = variants.some(
    (v) =>
      v &&
      v.inventory_management !== 'shopify' &&
      ((typeof v.inventory_quantity === 'number' && v.inventory_quantity > 0) ||
        v.inventory_policy === 'continue')
  );

  if (hasUntrackedAvailable) {
    // Sem controle de estoque (ou venda contínua), tratamos como disponível.
    return Number.MAX_SAFE_INTEGER;
  }

  if (trackedInventoryIds.length === 0) {
    return variants.reduce((sum, v) => {
      if (!v || typeof v.inventory_quantity !== 'number') return sum;
      return sum + Math.max(0, v.inventory_quantity);
    }, 0);
  }

  try {
    const levels = await getInventoryLevels(trackedInventoryIds);
    return levels.reduce((sum, l) => sum + (l.available || 0), 0);
  } catch {
    // Fallback quando a loja não expõe inventory_levels para este token.
    return variants.reduce((sum, v) => {
      if (!v || typeof v.inventory_quantity !== 'number') return sum;
      return sum + Math.max(0, v.inventory_quantity);
    }, 0);
  }
}

// Busca produtos complementares via metafield do Search & Discovery
async function getComplementaryProducts(productId) {
  try {
    const data = await shopifyGet(
      `/products/${productId}/metafields.json?namespace=shopify--discovery--product_recommendation&key=complementary_products`
    );
    if (!data.metafields || data.metafields.length === 0) return [];

    const metafield = data.metafields[0];
    let ids = [];

    try {
      const parsed = JSON.parse(metafield.value);
      ids = parsed.map((gid) => gid.replace('gid://shopify/Product/', ''));
    } catch {
      return [];
    }

    const products = await Promise.all(
      ids.slice(0, 5).map((id) => getProductById(id).catch(() => null))
    );
    return products.filter(Boolean);
  } catch {
    return [];
  }
}

// Consulta pedido por número + validação CPF
async function getOrderByNumberAndCPF(orderNumber, cpf) {
  const cpfClean = cpf.replace(/\D/g, '');

  let orders = [];

  try {
    const byName = await shopifyGet(
      `/orders.json?name=${encodeURIComponent('#' + orderNumber)}&status=any&limit=5`
    );
    orders = Array.isArray(byName.orders) ? byName.orders : [];
  } catch {
    orders = [];
  }

  if (orders.length === 0) {
    const fallback = await shopifyGet('/orders.json?status=any&limit=50');
    const all = Array.isArray(fallback.orders) ? fallback.orders : [];
    const targetNumber = String(orderNumber).replace(/^#/, '');
    orders = all.filter((o) => {
      const orderNum = String(o.order_number || '').replace(/^#/, '');
      const nameNum = String(o.name || '').replace(/^#/, '');
      return orderNum === targetNumber || nameNum === targetNumber;
    });
  }

  if (orders.length === 0) {
    return { found: false, reason: 'Pedido não encontrado.' };
  }

  const order = orders[0];
  const customer = order.customer;

  if (!customer) {
    return { found: false, reason: 'Pedido sem cliente associado.' };
  }

  let customerMetafields = [];
  try {
    const customerData = await shopifyGet(`/customers/${customer.id}/metafields.json`);
    customerMetafields = Array.isArray(customerData.metafields) ? customerData.metafields : [];
  } catch {
    customerMetafields = [];
  }

  const cpfMetafield = customerMetafields.find((m) => {
    const key = String(m.key || '').toLowerCase();
    return key === 'cpf' || key === 'cpf_cnpj' || key === 'document' || key === 'taxvat';
  });

  const cpfCandidates = [];

  if (cpfMetafield && cpfMetafield.value) {
    cpfCandidates.push(String(cpfMetafield.value));
  }

  if (customer.note) cpfCandidates.push(String(customer.note));
  if (order.note) cpfCandidates.push(String(order.note));

  if (Array.isArray(order.note_attributes)) {
    for (const attr of order.note_attributes) {
      if (attr && attr.value) cpfCandidates.push(String(attr.value));
    }
  }

  const extracted = cpfCandidates
    .map((value) => value.replace(/\D/g, ''))
    .filter((digits) => digits.length >= 11)
    .map((digits) => digits.slice(0, 11));

  const storedCPF = extracted.find((digits) => digits.length === 11) || null;

  if (!storedCPF || storedCPF !== cpfClean) {
    return { found: false, reason: 'CPF não confere com o pedido.' };
  }

  const fulfillment = order.fulfillments && order.fulfillments[0];
  const trackingInfo = fulfillment
    ? {
        company: fulfillment.tracking_company,
        number: fulfillment.tracking_number,
        url: fulfillment.tracking_url,
        status: fulfillment.status,
      }
    : null;

  return {
    found: true,
    order: {
      number: order.order_number,
      status: order.financial_status,
      fulfillment_status: order.fulfillment_status,
      created_at: order.created_at,
      total: order.total_price,
      currency: order.currency,
      tracking: trackingInfo,
      items: order.line_items.map((i) => ({
        name: i.name,
        quantity: i.quantity,
      })),
    },
  };
}

// Inicializa carregando tokens persistidos
loadPersistedTokens();

module.exports = {
  searchProducts,
  searchProductsSmart,
  getProductById,
  getProductStock,
  getComplementaryProducts,
  getOrderByNumberAndCPF,
};
