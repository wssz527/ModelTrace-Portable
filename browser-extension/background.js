const active = new Map();
const ruleReady = chrome.declarativeNetRequest.updateSessionRules({
  removeRuleIds: [1],
  addRules: [{
    id: 1, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Origin', operation: 'remove' }] },
    condition: { initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest'] },
  }],
});

function target(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('接口地址不受支持。');
  const match = url.pathname.match(/^(.*\/)(models|chat\/completions|responses|messages)$/);
  if (!match) throw new Error('扩展仅支持模型列表和模型测试接口。');
  return { url, root: url.origin + match[1], kind: match[2] };
}

function owner(sender) {
  if (!sender.tab || sender.frameId !== 0 || !sender.documentId || !sender.url?.startsWith('file://')) throw new Error('扩展只接受当前本地 HTML 的请求。');
  return `connection:${sender.tab.id}:${sender.documentId}`;
}

async function readBody(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 10485760) { await reader.cancel(); throw new Error('接口响应超过 10 MB。'); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function handle(message, sender) {
  const binding = owner(sender);
  if (message.type === 'ping') { await ruleReady; return { version: chrome.runtime.getManifest().version, responses: true }; }
  if (message.type === 'disconnect') {
    await chrome.storage.session.remove(binding);
    for (const [id, item] of active) if (id.startsWith(binding + ':')) item.abort();
    return {};
  }
  if (message.type === 'cancel') { active.get(binding + ':' + message.id)?.abort(); return {}; }
  const { url, root, kind } = target(message.url);
  if (message.type === 'authorize') {
    if (kind !== 'models') throw new Error('授权接口不正确。');
    const stored = await chrome.storage.session.get(binding);
    await chrome.storage.session.set({ [binding]: [...new Set([...(stored[binding] || []), root])] });
    return {};
  }
  if (message.type !== 'request') throw new Error('不支持的扩展操作。');
  const stored = await chrome.storage.session.get(binding);
  if (!stored[binding]?.includes(root)) throw new Error('此 HTML 尚未获得当前接口的授权。');
  const method = message.method || 'GET';
  if ((kind === 'models' && method !== 'GET') || (kind !== 'models' && method !== 'POST')) throw new Error('请求方法不受支持。');
  const headers = {};
  const allowed = ['authorization', 'content-type', 'x-api-key', 'anthropic-version', 'anthropic-dangerous-direct-browser-access'];
  for (const [name, value] of Object.entries(message.headers || {})) {
    if (!allowed.includes(name.toLowerCase()) || typeof value !== 'string' || value.length > 16384 || /[\r\n]/.test(value)) throw new Error('请求头不受支持。');
    headers[name] = value;
  }
  if (method === 'GET' && message.body != null) throw new Error('模型列表请求不能带正文。');
  if (method === 'POST') {
    if (typeof message.body !== 'string' || message.body.length > 1048576) throw new Error('测试正文不正确或超过 1 MB。');
    const body = JSON.parse(message.body);
    const input = kind === 'responses' ? (Array.isArray(body.input) && body.input.length > 0 && body.store === false) : Array.isArray(body.messages);
    if (typeof body.model !== 'string' || !body.model || !input || body.stream !== false) throw new Error('扩展只接受非流式模型测试。');
  }
  if (typeof message.id !== 'string' || message.id.length > 100) throw new Error('请求标识不正确。');
  await ruleReady;
  const id = binding + ':' + message.id;
  if (active.has(id)) throw new Error('请求已在进行中。');
  const controller = new AbortController(); active.set(id, controller);
  const timeout = setTimeout(() => controller.abort(), 240000);
  // Keep the MV3 worker alive only while a model request is running.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 15000);
  try {
    const response = await fetch(url.href, { method, headers, body: message.body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
    return { status: response.status, body: await readBody(response) };
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? '扩展请求已取消或超时；未自动重发。' : '扩展未能连接接口，请检查网络、地址或厂商限制。');
  } finally { clearTimeout(timeout); clearInterval(keepAlive); active.delete(id); }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || message.bridge !== 'modeltrace-extension-v1') return;
  handle(message, sender).then(reply, error => reply({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const stored = await chrome.storage.session.get(null);
  const prefix = `connection:${tabId}:`;
  await chrome.storage.session.remove(Object.keys(stored).filter(key => key.startsWith(prefix)));
  for (const [id, controller] of active) if (id.startsWith(prefix)) controller.abort();
});
