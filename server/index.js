require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { processMessage } = require('./agent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve arquivos estáticos do widget
app.use('/widget', express.static(path.join(__dirname, '../widget')));
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));

// Armazena sessões de conversa em memória (por sessionId)
const sessions = new Map();

const SESSION_TTL = 30 * 60 * 1000; // 30 minutos
let cleanupInterval = null;

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastActivity = Date.now();
    return session.messages;
  }
  const messages = [];
  sessions.set(sessionId, { messages, lastActivity: Date.now() });
  return messages;
}

function startSessionCleanup() {
  if (cleanupInterval) return;

  // Limpa sessões antigas a cada 10 minutos
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      if (now - session.lastActivity > SESSION_TTL) {
        sessions.delete(id);
      }
    }
  }, 10 * 60 * 1000);
}

// POST /api/chat — endpoint principal
app.post('/api/chat', async (req, res) => {
  const { message, sessionId } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Mensagem inválida.' });
  }

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'sessionId obrigatório.' });
  }

  const messages = getSession(sessionId);
  messages.push({ role: 'user', content: message.trim() });

  try {
    const reply = await processMessage(messages);
    messages.push({ role: 'assistant', content: reply });

    // Limita histórico a 20 mensagens para não explodir tokens
    if (messages.length > 20) {
      messages.splice(0, messages.length - 20);
    }

    return res.json({ reply });
  } catch (err) {
    console.error('[CHAT ERROR]', err.message);
    return res.status(500).json({
      error: 'Erro interno. Tente novamente em instantes.',
    });
  }
});

// GET /api/admin/sessions — lista sessões para painel de atendimento
app.get('/api/admin/sessions', (req, res) => {
  const list = Array.from(sessions.entries())
    .map(([sessionId, session]) => {
      const lastMessage = session.messages[session.messages.length - 1] || null;
      return {
        sessionId,
        lastActivity: session.lastActivity,
        messageCount: session.messages.length,
        lastRole: lastMessage ? lastMessage.role : null,
        lastMessage: lastMessage ? lastMessage.content : '',
      };
    })
    .sort((a, b) => b.lastActivity - a.lastActivity);

  return res.json({ sessions: list });
});

// GET /api/admin/sessions/:sessionId — detalhe da sessão
app.get('/api/admin/sessions/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = sessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada.' });
  }

  return res.json({
    sessionId,
    lastActivity: session.lastActivity,
    messages: session.messages,
  });
});

// POST /api/admin/sessions/:sessionId/reply-ai — envia mensagem como usuário e recebe resposta da IA
app.post('/api/admin/sessions/:sessionId/reply-ai', async (req, res) => {
  const { sessionId } = req.params;
  const { message } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Mensagem inválida.' });
  }

  const messages = getSession(sessionId);
  messages.push({ role: 'user', content: message.trim() });

  try {
    const reply = await processMessage(messages);
    messages.push({ role: 'assistant', content: reply });

    if (messages.length > 20) {
      messages.splice(0, messages.length - 20);
    }

    return res.json({ reply });
  } catch (err) {
    console.error('[ADMIN REPLY ERROR]', err.message);
    return res.status(500).json({ error: 'Erro interno ao gerar resposta.' });
  }
});

// POST /api/admin/sessions/:sessionId/manual-message — adiciona resposta manual do atendente
app.post('/api/admin/sessions/:sessionId/manual-message', (req, res) => {
  const { sessionId } = req.params;
  const { role, message } = req.body;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'Mensagem inválida.' });
  }

  const safeRole = role === 'user' ? 'user' : 'assistant';
  const messages = getSession(sessionId);
  messages.push({ role: safeRole, content: message.trim() });

  if (messages.length > 20) {
    messages.splice(0, messages.length - 20);
  }

  return res.json({ ok: true });
});

// POST /api/admin/sessions/:sessionId/clear — limpa histórico de uma sessão
app.post('/api/admin/sessions/:sessionId/clear', (req, res) => {
  const { sessionId } = req.params;
  sessions.delete(sessionId);
  return res.json({ ok: true });
});

// GET /health — verificação de status
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size });
});

if (require.main === module) {
  startSessionCleanup();

  app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`   Loja: ${process.env.SHOPIFY_STORE}`);
  });
}

module.exports = app;
