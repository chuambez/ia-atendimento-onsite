(function () {
  'use strict';

  function resolveScriptSrc() {
    if (document.currentScript && document.currentScript.src) {
      return document.currentScript.src;
    }

    const scripts = document.getElementsByTagName('script');
    for (let i = scripts.length - 1; i >= 0; i--) {
      const src = scripts[i].src || '';
      if (src.indexOf('/widget/chat-widget.js') !== -1) {
        return src;
      }
    }

    return '';
  }

  function resolveBaseUrl() {
    const scriptSrc = resolveScriptSrc();
    if (!scriptSrc) {
      return window.location.origin;
    }

    try {
      return new URL(scriptSrc, window.location.href).origin;
    } catch {
      return window.location.origin;
    }
  }

  const AGENT_BASE_URL = resolveBaseUrl();
  const AGENT_API = `${AGENT_BASE_URL}/api/chat`;
  const AGENT_NAME = 'Assistente';
  const AGENT_GREETING = 'Olá! 👋 Posso te ajudar a encontrar produtos, tirar dúvidas ou rastrear seu pedido. Como posso ajudar?';

  // Gera sessionId único por visita
  function getSessionId() {
    let sid = sessionStorage.getItem('agent_session');
    if (!sid) {
      sid = 'sess_' + Math.random().toString(36).slice(2) + Date.now();
      sessionStorage.setItem('agent_session', sid);
    }
    return sid;
  }

  const SESSION_ID = getSessionId();
  let isOpen = false;
  let isTyping = false;

  // Injeta estilos
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = `${AGENT_BASE_URL}/widget/chat-widget.css`;
  document.head.appendChild(style);

  // Cria estrutura do widget
  const widget = document.createElement('div');
  widget.id = 'ai-chat-widget';
  widget.innerHTML = `
    <button id="ai-chat-toggle" aria-label="Abrir chat">
      <svg id="ai-icon-chat" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
        <path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm0 14H6l-2 2V4h16v12z"/>
      </svg>
      <svg id="ai-icon-close" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="display:none">
        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
      </svg>
      <span id="ai-chat-badge" style="display:none">1</span>
    </button>

    <div id="ai-chat-box" role="dialog" aria-label="Chat de atendimento" style="display:none">
      <div id="ai-chat-header">
        <div id="ai-chat-avatar">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm0 6c2.67 0 8 1.34 8 4v2H4v-2c0-2.66 5.33-4 8-4z"/>
          </svg>
        </div>
        <div id="ai-chat-header-info">
          <span id="ai-chat-name">${AGENT_NAME}</span>
          <span id="ai-chat-status">Online</span>
        </div>
        <button id="ai-chat-minimize" aria-label="Minimizar">−</button>
      </div>

      <div id="ai-chat-messages" role="log" aria-live="polite"></div>

      <div id="ai-chat-input-area">
        <input
          id="ai-chat-input"
          type="text"
          placeholder="Digite sua mensagem..."
          maxlength="500"
          autocomplete="off"
          aria-label="Mensagem"
        />
        <button id="ai-chat-send" aria-label="Enviar">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(widget);

  const toggle = document.getElementById('ai-chat-toggle');
  const chatBox = document.getElementById('ai-chat-box');
  const messages = document.getElementById('ai-chat-messages');
  const input = document.getElementById('ai-chat-input');
  const sendBtn = document.getElementById('ai-chat-send');
  const minimize = document.getElementById('ai-chat-minimize');
  const iconChat = document.getElementById('ai-icon-chat');
  const iconClose = document.getElementById('ai-icon-close');
  const badge = document.getElementById('ai-chat-badge');

  let hasGreeted = false;

  function openChat() {
    isOpen = true;
    chatBox.style.display = 'flex';
    iconChat.style.display = 'none';
    iconClose.style.display = 'block';
    badge.style.display = 'none';
    toggle.classList.add('active');

    if (!hasGreeted) {
      hasGreeted = true;
      setTimeout(() => addMessage('assistant', AGENT_GREETING), 300);
    }

    setTimeout(() => input.focus(), 400);
  }

  function closeChat() {
    isOpen = false;
    chatBox.style.display = 'none';
    iconChat.style.display = 'block';
    iconClose.style.display = 'none';
    toggle.classList.remove('active');
  }

  toggle.addEventListener('click', () => (isOpen ? closeChat() : openChat()));
  minimize.addEventListener('click', closeChat);

  // Formata texto com markdown básico
  function formatText(text) {
    return text
      .replace(/!\[([^\]]*)\]\((https?:\/\/[^\)]+)\)/g, '<img src="$2" alt="$1" loading="lazy" class="ai-inline-image" />')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\n/g, '<br>');
  }

  function addMessage(role, text) {
    const wrapper = document.createElement('div');
    wrapper.className = `ai-msg ai-msg-${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble';
    bubble.innerHTML = formatText(text);

    wrapper.appendChild(bubble);
    messages.appendChild(wrapper);
    messages.scrollTop = messages.scrollHeight;
  }

  function showTyping() {
    const wrapper = document.createElement('div');
    wrapper.className = 'ai-msg ai-msg-assistant';
    wrapper.id = 'ai-typing';

    const bubble = document.createElement('div');
    bubble.className = 'ai-bubble ai-typing-indicator';
    bubble.innerHTML = '<span></span><span></span><span></span>';

    wrapper.appendChild(bubble);
    messages.appendChild(wrapper);
    messages.scrollTop = messages.scrollHeight;
  }

  function removeTyping() {
    const typing = document.getElementById('ai-typing');
    if (typing) typing.remove();
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text || isTyping) return;

    input.value = '';
    addMessage('user', text);
    isTyping = true;
    sendBtn.disabled = true;
    showTyping();

    try {
      const res = await fetch(AGENT_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: SESSION_ID }),
      });

      const raw = await res.text();
      let data = {};
      try {
        data = JSON.parse(raw);
      } catch {
        data = { error: null };
      }

      removeTyping();

      if (res.ok && data.reply) {
        addMessage('assistant', data.reply);
      } else {
        const msg = data.error || `Não consegui processar sua mensagem agora (HTTP ${res.status}).`;
        addMessage('assistant', msg);
      }
    } catch {
      removeTyping();
      addMessage('assistant', 'Erro de conexão. Verifique sua internet e tente novamente.');
    } finally {
      isTyping = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Mostra badge se chat fechado após 5s
  setTimeout(() => {
    if (!isOpen && !hasGreeted) {
      badge.style.display = 'flex';
    }
  }, 5000);
})();
