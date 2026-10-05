const extensionConnector = (() => {
  const bridge = 'modeltrace-extension-v1';
  const nonce = crypto.randomUUID();
  const pending = new Map();
  const connected = new Set();
  let detected = false;
  let supportsResponses = false;
  const root = raw => { const url = new URL(raw); return url.origin + url.pathname.replace(/(models|chat\/completions|responses|messages)$/, ''); };
  function call(type, data = {}, signal, timeout = 240000) {
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const abort = () => {
        window.postMessage({ bridge, to: 'extension', type: 'cancel', id, nonce }, '*');
        finish(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => finish(new Error('未检测到连接扩展。')), timeout);
      function finish(error, result) {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id);
        error ? reject(error) : resolve(result);
      }
      pending.set(id, finish); signal?.addEventListener('abort', abort, { once: true });
      window.postMessage({ bridge, to: 'extension', type, id, nonce, ...data }, '*');
    });
  }
  window.addEventListener('message', event => {
    const m = event.data;
    if (event.source !== window || m?.bridge !== bridge || m.to !== 'page' || m.nonce !== nonce) return;
    const finish = pending.get(m.id);
    if (!finish) return;
    if (!m.result || typeof m.result !== 'object') return finish(new Error('扩展返回了无效结果。'));
    finish(m.result.error ? new Error(m.result.error) : null, m.result);
  });
  const element = id => document.getElementById(id);
  function markSetup(value) {
    try { value ? window.ModelTracePortable.storage.setItem('extension-setup', '1') : window.ModelTracePortable.storage.removeItem('extension-setup'); }
    catch { /* Installation remains usable without browser storage. */ }
  }
  function help() {
    const dialog = element('extension-help');
    dialog.hidden = false;
    if (!dialog.open) dialog.showModal();
    element('extension-setup-open').hidden = false;
    markSetup(true);
  }
  function closeHelp() { element('extension-help').close(); }
  function checkSupport(url) {
    if (supportsResponses || !(/\/responses$/.test(new URL(url).pathname) || element('conn-format').value === 'responses')) return;
    help();
    element('extension-setup-status').textContent = '请更新扩展：下载并覆盖原扩展文件夹 → 在扩展管理页点击重新加载 → 刷新本 HTML。';
    throw new Error('请更新连接扩展后重新开始测试。');
  }
  async function connect(url, signal) {
    try { if (!detected) { const reply = await call('ping', {}, signal, 2500); supportsResponses = reply.responses === true; detected = true; } }
    catch (error) { help(); throw error; }
    checkSupport(url);
    const target = root(url) + 'models';
    await call('authorize', { url: target }, signal);
    connected.add(root(url));
    closeHelp(); element('extension-setup-open').hidden = true;
    element('extension-disconnect').hidden = false;
    markSetup(false);
  }
  async function request(url, options) {
    checkSupport(url);
    const headers = Object.fromEntries(new Headers(options.headers));
    const result = await call('request', { url, method: options.method || 'GET', headers, ...(options.body != null ? { body: options.body } : {}) }, options.signal);
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599 || typeof result.body !== 'string' || result.body.length > 10485760) throw new Error('扩展返回了无效接口响应。');
    return { status: result.status, ok: result.status < 300, statusText: '', text: async () => result.body };
  }
  async function transport(url, options) {
    if (connected.has(root(url))) return request(url, options);
    try { return await fetch(url, options); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      await connect(url, options.signal);
      if ((options.method || 'GET') !== 'GET') throw new Error('扩展已连接。请重新开始本轮测试。');
      return request(url, options);
    }
  }
  function initialize() {
    const dialog = element('extension-help');
    dialog.addEventListener('close', () => { dialog.hidden = true; });
    element('extension-close').onclick = closeHelp;
    element('extension-setup-open').onclick = help;
    const browser = element('extension-browser');
    browser.value = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
    const updateManager = () => { element('extension-manager-url').value = browser.value + '://extensions'; };
    browser.onchange = updateManager; updateManager();
    element('extension-copy').onclick = async () => {
      const input = element('extension-manager-url');
      try { await navigator.clipboard.writeText(input.value); }
      catch { input.select(); if (!document.execCommand('copy')) { element('extension-setup-status').textContent = '选中地址后复制。'; return; } }
      element('extension-setup-status').textContent = '地址已复制';
    };
    element('extension-download').onclick = async () => {
      const button = element('extension-download'); button.disabled = true;
      element('extension-setup-status').textContent = '正在下载扩展…';
      try {
        const package = JSON.parse(element('extension-package').textContent);
        const bytes = Uint8Array.from(atob(package.data), ch => ch.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        const link = document.createElement('a'); link.href = url; link.download = package.fileName; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
        element('extension-setup-status').textContent = '下载完成，请解压后继续第 2 步。';
      } catch { element('extension-setup-status').textContent = '下载失败，请重试。'; }
      finally { button.disabled = false; }
    };
    element('extension-check').onclick = async () => {
      const button = element('extension-check'); button.disabled = true;
      element('extension-setup-status').textContent = '正在检测扩展…';
      try { const reply = await call('ping', {}, undefined, 2500); supportsResponses = reply.responses === true; detected = true; }
      catch { element('extension-setup-status').textContent = '未检测到扩展，请完成第 2～4 步并刷新本 HTML。'; button.disabled = false; return; }
      try { checkSupport('http://localhost/v1/models'); }
      catch { button.disabled = false; return; }
      closeHelp(); markSetup(false);
      const note = element('connection-status'); note.hidden = false; note.textContent = '扩展可用';
      const base = element('conn-base').value.trim(); const key = element('conn-key').value;
      try {
        if (base && key) {
          await connect(endpoint(base, 'models'));
          element('conn-form').requestSubmit();
        } else {
          note.textContent = base ? '扩展可用，请填写 API Key。' : '扩展可用，请填写接口地址和 API Key。';
          element(base ? 'conn-key' : 'conn-base').focus();
        }
      } catch (error) { note.textContent = error.message; }
      finally { button.disabled = false; }
    };
    if (window.ModelTracePortable.storage.getItem('extension-setup')) help();
    document.getElementById('extension-disconnect').onclick = async () => {
      try { await call('disconnect', {}, undefined, 2500); }
      catch { /* The extension may already have been disabled or removed. */ }
      finally {
        connected.clear(); document.getElementById('extension-disconnect').hidden = true;
        const note = document.getElementById('connection-status'); note.hidden = false; note.textContent = '扩展连接已断开';
        window.dispatchEvent(new Event('modeltrace-connection-changed'));
      }
    };
  }
  return { transport, initialize, uses: url => connected.has(root(url)) };
})();
