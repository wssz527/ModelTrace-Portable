(() => {
  if (window.top !== window || !document.querySelector('#release-meta') || !document.querySelector('#fingerprint-bank') || !document.querySelector('#conn-form')) return;
  const bridge = 'modeltrace-extension-v1';
  let approval = null;
  const inFlight = new Set();
  const reply = (message, result) => window.postMessage({ bridge, to: 'page', id: message.id, nonce: message.nonce, result }, '*');
  const send = message => chrome.runtime.sendMessage({ ...message, bridge });

  function authorize(message) {
    if (approval) throw new Error('请先处理当前扩展授权。');
    const url = new URL(message.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/models')) throw new Error('授权接口不正确。');
    return new Promise((resolve, reject) => {
      const host = document.createElement('div');
      host.id = 'modeltrace-extension-consent';
      const shadow = host.attachShadow({ mode: 'closed' });
      shadow.innerHTML = `<style>:host{position:fixed!important;inset:0!important;z-index:2147483647!important;background:#14213c88!important;display:grid!important;place-items:center!important}.panel{box-sizing:border-box;max-width:480px;width:calc(100vw - 32px);padding:24px;background:white;color:#182130;border-radius:12px;font:14px/1.7 sans-serif;box-shadow:0 16px 60px #0005}h2{font-size:18px;margin:0 0 12px}.target{overflow-wrap:anywhere;padding:10px;background:#f3f6fa}button{margin:12px 8px 0 0;padding:9px 14px;border:1px solid #b8c8df;border-radius:6px;cursor:pointer}.allow{background:#2563eb;color:white;border-color:#2563eb}</style><section class="panel" role="dialog" aria-modal="true" aria-label="ModelTrace 扩展授权"><h2>连接接口</h2><div class="target"></div><p>请确认接口地址。</p><button class="allow" type="button">允许连接</button><button class="cancel" type="button">取消</button></section>`;
      shadow.querySelector('.target').textContent = url.origin + url.pathname.replace(/models$/, '');
      function finish(error, result) { host.remove(); approval = null; error ? reject(error) : resolve(result); }
      approval = { id: message.id, cancel: () => finish(new Error('已取消扩展授权。')) };
      shadow.querySelector('.cancel').onclick = event => { if (event.isTrusted) approval.cancel(); };
      shadow.querySelector('.allow').onclick = async event => {
        if (!event.isTrusted) return;
        shadow.querySelector('.allow').disabled = true;
        try {
          const result = await send({ type: 'authorize', url: url.href });
          if (result?.error) throw new Error(result.error);
          finish(null, result);
        } catch (error) { finish(error); }
      };
      document.documentElement.append(host);
      shadow.querySelector('.allow').focus();
    });
  }

  window.addEventListener('message', async event => {
    const message = event.data;
    if (event.source !== window || message?.bridge !== bridge || message.to !== 'extension' || typeof message.id !== 'string' || message.id.length > 100 || typeof message.nonce !== 'string') return;
    if (message.type === 'cancel') { if (approval?.id === message.id) approval.cancel(); else await send(message).catch(() => {}); return; }
    if (!['ping', 'authorize', 'request', 'disconnect'].includes(message.type) || inFlight.has(message.id)) return;
    inFlight.add(message.id);
    try {
      const result = message.type === 'authorize' ? await authorize(message) : await send(message);
      reply(message, result);
    } catch (error) { reply(message, { error: error.message }); }
    finally { inFlight.delete(message.id); }
  });
  window.addEventListener('pagehide', () => { approval?.cancel(); send({ type: 'disconnect' }).catch(() => {}); });
})();
