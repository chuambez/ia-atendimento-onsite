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

// Caminho para persistir token atualizado
const TOKEN_FILE = path.join(__dirname, '../.shopify-tokens.json');

// Estado em memória do token atual
let tokenState = {
  accessToken: STATIC_ACCESS_TOKEN || null,
  refreshToken: REFRESH_TOKEN || null,
  expiresAt: STATIC_ACCESS_TOKEN ? Number.MAX_SAFE_INTEGER : 0,
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

function productSearchScore(product, query) {
  const q = normalizeText(query).trim();
  if (!q) return 0;

  const haystack = normalizeText(
    [product.title, product.vendor, product.tags, product.body_html].filter(Boolean).join(' ')
  );

  if (!haystack) return 0;

  let score = 0;
  if (haystack.includes(q)) score += 10;

  const terms = q.split(/\s+/).filter(Boolean);
  for (const term of terms) {
    if (haystack.includes(term)) score += 2;
  }

  return score;
}

// Busca produtos por título/query
async function searchProducts(query) {
  const data = await shopifyGet('/products.json?limit=100&status=active');
  const products = Array.isArray(data.products) ? data.products : [];

  const ranked = products
    .map((p) => ({ product: p, score: productSearchScore(p, query) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.product);

  return ranked;
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
  getProductById,
  getProductStock,
  getComplementaryProducts,
  getOrderByNumberAndCPF,
};
