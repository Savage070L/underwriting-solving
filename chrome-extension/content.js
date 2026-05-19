// content.js — injected into our app's pages (GitHub Pages + localhost).
// Bridges window.postMessage (page world) ↔ chrome.runtime (extension world).
//
// Page side (наше приложение) делает:
//   window.postMessage({ source: 'sl-app', type: 'STATGOV_LOOKUP', requestId, bin }, '*');
// Затем слушает window.message с тем же requestId и source='sl-bridge'.

const SOURCE_APP = 'sl-app';
const SOURCE_BRIDGE = 'sl-bridge';

// === 1. Announce presence to the page ===
// Чтобы наш App мог проверить, установлено ли расширение, посылаем «handshake»
// сразу после загрузки и в ответ на каждый PING.
function announce() {
  window.postMessage(
    { source: SOURCE_BRIDGE, type: 'BRIDGE_READY', version: chrome.runtime.getManifest().version },
    '*',
  );
}
announce();
document.addEventListener('DOMContentLoaded', announce);

// === 2. Listen for requests from the page and forward to background ===
window.addEventListener('message', (event) => {
  // только сообщения из этого же окна и от нашего приложения
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== SOURCE_APP) return;
  if (!data.type || !data.requestId) return;

  if (data.type === 'PING') {
    window.postMessage({ source: SOURCE_BRIDGE, type: 'PONG', requestId: data.requestId, version: chrome.runtime.getManifest().version }, '*');
    return;
  }

  if (data.type === 'STATGOV_LOOKUP') {
    chrome.runtime.sendMessage({ type: 'STATGOV_LOOKUP', bin: data.bin }, (response) => {
      window.postMessage(
        {
          source: SOURCE_BRIDGE,
          type: 'STATGOV_LOOKUP_RESULT',
          requestId: data.requestId,
          ok: !!(response && response.ok),
          data: response && response.data,
          error: response && response.error,
        },
        '*',
      );
    });
  }
});
