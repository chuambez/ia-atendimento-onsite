const fs = require('fs');
const path = require('path');

const IS_VERCEL = Boolean(process.env.VERCEL);
const LOG_DIR = IS_VERCEL ? '/tmp/ia-atendimento-logs' : path.join(__dirname, '../logs');
const LOG_FILE = path.join(LOG_DIR, 'conversations.ndjson');

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function sanitize(value, parentKey = '') {
  const key = String(parentKey || '').toLowerCase();

  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (key.includes('token') || key.includes('api_key') || key.includes('authorization')) {
      return '[REDACTED]';
    }

    if (key.includes('cpf') || key.includes('document')) {
      return value.replace(/\d/g, '*');
    }

    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, parentKey));
  }

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitize(v, k);
    }
    return out;
  }

  return value;
}

function writeConversationLog(event, payload = {}) {
  try {
    ensureLogDir();

    const line = {
      ts: new Date().toISOString(),
      event,
      ...sanitize(payload),
    };

    const serialized = JSON.stringify(line);
    fs.appendFileSync(LOG_FILE, `${serialized}\n`, 'utf-8');

    // No ambiente serverless, logs em stdout ajudam no diagnóstico centralizado.
    console.log(`[CONV_LOG] ${serialized}`);
  } catch {
    // Não interrompe o fluxo do chat por falha de logging.
  }
}

module.exports = {
  writeConversationLog,
  LOG_FILE,
};
