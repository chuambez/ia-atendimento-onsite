const state = {
  sessions: [],
  filtered: [],
  activeSessionId: null,
};

const el = {
  sessionList: document.getElementById('sessionList'),
  searchInput: document.getElementById('searchInput'),
  refreshBtn: document.getElementById('refreshBtn'),
  messages: document.getElementById('messages'),
  chatTitle: document.getElementById('chatTitle'),
  chatSubtitle: document.getElementById('chatSubtitle'),
  messageInput: document.getElementById('messageInput'),
  sendManualBtn: document.getElementById('sendManualBtn'),
  sendAiBtn: document.getElementById('sendAiBtn'),
  clearSessionBtn: document.getElementById('clearSessionBtn'),
};

function formatRelativeTime(ts) {
  if (!ts) return '--';
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d`;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function shortSessionId(sessionId) {
  if (!sessionId) return '';
  if (sessionId.length <= 24) return sessionId;
  return `${sessionId.slice(0, 12)}...${sessionId.slice(-8)}`;
}

function setComposerEnabled(enabled) {
  el.messageInput.disabled = !enabled;
  el.sendManualBtn.disabled = !enabled;
  el.sendAiBtn.disabled = !enabled;
  el.clearSessionBtn.disabled = !enabled;
}

function renderSessionList() {
  el.sessionList.innerHTML = '';

  if (!state.filtered.length) {
    el.sessionList.innerHTML = '<p class="empty-state">Nenhuma sessão encontrada.</p>';
    return;
  }

  const fragment = document.createDocumentFragment();

  state.filtered.forEach((session) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `session-item${session.sessionId === state.activeSessionId ? ' active' : ''}`;

    item.innerHTML = `
      <div class="session-top">
        <span class="session-id">${escapeHtml(shortSessionId(session.sessionId))}</span>
        <span class="session-time">${escapeHtml(formatRelativeTime(session.lastActivity))}</span>
      </div>
      <div class="session-preview">${escapeHtml(session.lastMessage || 'Sem mensagens ainda')}</div>
    `;

    item.addEventListener('click', () => {
      openSession(session.sessionId);
    });

    fragment.appendChild(item);
  });

  el.sessionList.appendChild(fragment);
}

function renderMessages(messages) {
  if (!messages.length) {
    el.messages.innerHTML = '<p class="empty-state">Sem mensagens nesta sessão.</p>';
    return;
  }

  const html = messages
    .map((m) => {
      const role = ['user', 'assistant', 'tool', 'system'].includes(m.role) ? m.role : 'assistant';
      return `<div class="message-row ${role}"><div class="bubble">${escapeHtml(m.content)}</div></div>`;
    })
    .join('');

  el.messages.innerHTML = html;
  el.messages.scrollTop = el.messages.scrollHeight;
}

function applyFilter() {
  const q = el.searchInput.value.trim().toLowerCase();

  if (!q) {
    state.filtered = [...state.sessions];
  } else {
    state.filtered = state.sessions.filter((s) => {
      return (
        s.sessionId.toLowerCase().includes(q) ||
        String(s.lastMessage || '').toLowerCase().includes(q)
      );
    });
  }

  renderSessionList();
}

async function fetchSessions() {
  const res = await fetch('/api/admin/sessions');
  const data = await res.json();
  state.sessions = data.sessions || [];
  applyFilter();
}

async function openSession(sessionId) {
  state.activeSessionId = sessionId;
  renderSessionList();
  setComposerEnabled(true);

  const res = await fetch(`/api/admin/sessions/${encodeURIComponent(sessionId)}`);

  if (!res.ok) {
    el.chatTitle.textContent = 'Sessão indisponível';
    el.chatSubtitle.textContent = 'Ela pode ter sido removida.';
    renderMessages([]);
    return;
  }

  const data = await res.json();

  el.chatTitle.textContent = `Sessão ${shortSessionId(data.sessionId)}`;
  el.chatSubtitle.textContent = `Última atividade: ${formatRelativeTime(data.lastActivity)}`;
  renderMessages(data.messages || []);
}

async function sendManualMessage() {
  const text = el.messageInput.value.trim();
  if (!text || !state.activeSessionId) return;

  el.sendManualBtn.disabled = true;

  try {
    await fetch(`/api/admin/sessions/${encodeURIComponent(state.activeSessionId)}/manual-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'assistant', message: text }),
    });

    el.messageInput.value = '';
    await fetchSessions();
    await openSession(state.activeSessionId);
  } finally {
    el.sendManualBtn.disabled = false;
  }
}

async function sendAiReply() {
  const text = el.messageInput.value.trim();
  if (!text || !state.activeSessionId) return;

  el.sendAiBtn.disabled = true;

  try {
    await fetch(`/api/admin/sessions/${encodeURIComponent(state.activeSessionId)}/reply-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });

    el.messageInput.value = '';
    await fetchSessions();
    await openSession(state.activeSessionId);
  } finally {
    el.sendAiBtn.disabled = false;
  }
}

async function clearSession() {
  if (!state.activeSessionId) return;
  const confirmed = window.confirm('Tem certeza que deseja limpar esta sessão?');
  if (!confirmed) return;

  await fetch(`/api/admin/sessions/${encodeURIComponent(state.activeSessionId)}/clear`, {
    method: 'POST',
  });

  state.activeSessionId = null;
  el.chatTitle.textContent = 'Selecione uma conversa';
  el.chatSubtitle.textContent = 'As sessões do widget aparecem aqui em tempo real.';
  renderMessages([]);
  setComposerEnabled(false);

  await fetchSessions();
}

function bindEvents() {
  el.searchInput.addEventListener('input', applyFilter);
  el.refreshBtn.addEventListener('click', async () => {
    await fetchSessions();
    if (state.activeSessionId) {
      await openSession(state.activeSessionId);
    }
  });

  el.sendManualBtn.addEventListener('click', sendManualMessage);
  el.sendAiBtn.addEventListener('click', sendAiReply);
  el.clearSessionBtn.addEventListener('click', clearSession);

  el.messageInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      sendAiReply();
    }
  });
}

async function boot() {
  setComposerEnabled(false);
  renderMessages([]);
  bindEvents();
  await fetchSessions();

  // Auto-refresh leve para parecer inbox em tempo real
  setInterval(async () => {
    await fetchSessions();
    if (state.activeSessionId) {
      await openSession(state.activeSessionId);
    }
  }, 5000);
}

boot();
