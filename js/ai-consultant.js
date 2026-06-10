// ai-consultant.js — общий контроллер слайд-овер панели «Спросить ИИ».
// Используется на двух страницах (analytics.html и index.html), каждая из
// которых содержит одинаковую разметку с id: ai-panel, ai-overlay,
// ai-prompt-text, ai-prompt-stats, ai-copy-btn, ai-toast и (опционально) ai-fab.
//
// getPrompt() вызывается при КАЖДОМ открытии панели — на главной странице
// данные формы могут меняться между открытиями, поэтому промпт не кэшируем.
// Возврат null/пустой строки из getPrompt → панель не открывается, вызывается
// opts.onUnavailable (например, «Сначала загрузите историю убытков»).

function createAIConsultant(getPrompt, opts = {}) {
  let isOpen = false;
  let prompt = null;

  const el = (id) => document.getElementById(id);

  function buildPrompt() {
    try {
      return getPrompt() || null;
    } catch (e) {
      console.error('AI prompt build error:', e);
      return null;
    }
  }

  function open() {
    prompt = buildPrompt();
    if (!prompt) {
      if (opts.onUnavailable) opts.onUnavailable();
      return;
    }
    const ta = el('ai-prompt-text');
    ta.value = prompt;
    const stats = el('ai-prompt-stats');
    const words = prompt.split(/\s+/).filter(Boolean).length;
    stats.textContent = `${prompt.length.toLocaleString('ru-RU')} символов · ${words.toLocaleString('ru-RU')} слов · ≈ ${Math.ceil(prompt.length / 4).toLocaleString('ru-RU')} токенов`;
    el('ai-panel').classList.add('is-open');
    el('ai-overlay').classList.add('is-open');
    el('ai-fab')?.classList.add('is-hidden');
    isOpen = true;
  }

  function close() {
    el('ai-panel').classList.remove('is-open');
    el('ai-overlay').classList.remove('is-open');
    el('ai-fab')?.classList.remove('is-hidden');
    isOpen = false;
  }

  function toggle() { isOpen ? close() : open(); }

  function copy() {
    const ta = el('ai-prompt-text');
    const btn = el('ai-copy-btn');
    const txt = ta.value;
    const onSuccess = () => {
      btn.classList.add('is-copied');
      const orig = btn.innerHTML;
      btn.innerHTML = '<span class="ai-btn-icon">✓</span> Скопировано';
      setTimeout(() => { btn.classList.remove('is-copied'); btn.innerHTML = orig; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(onSuccess).catch(() => {
        ta.select(); document.execCommand('copy'); onSuccess();
      });
    } else {
      ta.select(); document.execCommand('copy'); onSuccess();
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const ta = el('ai-prompt-text');
    ta.select();
    document.execCommand('copy');
    return Promise.resolve();
  }

  function showToast(html, durationMs = 4500) {
    const toast = el('ai-toast');
    toast.innerHTML = html;
    toast.classList.add('is-visible');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('is-visible'), durationMs);
  }

  function isMac() {
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  }

  function sendTo(service) {
    if (!prompt) prompt = buildPrompt();
    if (!prompt) {
      if (opts.onUnavailable) opts.onUnavailable();
      return;
    }
    const enc = encodeURIComponent(prompt);

    const URL_LIMIT = 1900; // safe length for query param

    let url, prefillSupported = false;
    switch (service) {
      case 'chatgpt':
        // ChatGPT supports ?q= and ?hints=search (enables web search mode).
        if (enc.length <= URL_LIMIT) {
          url = 'https://chatgpt.com/?hints=search&q=' + enc;
          prefillSupported = true;
        } else {
          url = 'https://chatgpt.com/?hints=search';
        }
        break;
      case 'claude':
        // claude.ai has no public URL-param for pre-fill
        url = 'https://claude.ai/new';
        break;
      case 'gemini':
        url = 'https://gemini.google.com/app';
        break;
      case 'perplexity':
        if (enc.length <= URL_LIMIT) {
          url = 'https://www.perplexity.ai/?q=' + enc;
          prefillSupported = true;
        } else {
          url = 'https://www.perplexity.ai/';
        }
        break;
      default:
        url = '/';
    }

    copyToClipboard(prompt).then(() => {
      // Open in new tab
      window.open(url, '_blank', 'noopener,noreferrer');
      // Show contextual toast
      const cmdKey = isMac() ? '⌘' : 'Ctrl';
      if (prefillSupported) {
        showToast(`<strong>Промпт подставлен в URL и скопирован в буфер</strong>
          <span>Если поле инпута пустое — нажмите <kbd>${cmdKey}</kbd>+<kbd>V</kbd>. Затем <kbd>Enter</kbd>.</span>`);
      } else {
        showToast(`<strong>Промпт скопирован в буфер</strong>
          <span>В открывшейся вкладке нажмите <kbd>${cmdKey}</kbd>+<kbd>V</kbd> и затем <kbd>Enter</kbd></span>`);
      }
    }).catch(() => {
      window.open(url, '_blank', 'noopener,noreferrer');
      showToast(`<strong>Открыто в новой вкладке</strong>
        <span>Промпт нужно скопировать вручную — выделите текст и нажмите ${isMac() ? '⌘' : 'Ctrl'}+C</span>`);
    });
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) close(); });

  return { toggle, open, close, copy, sendTo };
}
