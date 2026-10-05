import { analyzeGlobalOutputs, parseNumbers } from '../static/fingerprint-core.js';
import { generateChallenges } from '../static/challenge-browser.js';

const byId = id => document.getElementById(id);
const release = JSON.parse(byId('release-meta').textContent);
const seeds = JSON.parse(byId('private-config').textContent);
const originalBank = JSON.parse(byId('fingerprint-bank').textContent);
const UPSTREAM = 'https://raw.githubusercontent.com/xqy2006/ModelTrace/main/static/data/unified_bank.json';
let bankMeta = JSON.parse(byId('bank-meta').textContent);
const prefix = release.private ? 'modeltrace-private-v2:' : 'modeltrace-public-v2:';
// Capture the untouched page so sharing cannot include form values or test output.
const pristine = document.documentElement.cloneNode(true);
const storage = {
  getItem(key) { try { return localStorage.getItem(prefix + key); } catch { return null; } },
  setItem(key, value) { try { localStorage.setItem(prefix + key, value); } catch { throw new Error('浏览器禁止保存本地配置；请使用临时填写。'); } },
  removeItem(key) { try { localStorage.removeItem(prefix + key); } catch { /* No saved data. */ } },
};
let providers = seeds;
try { const saved = storage.getItem('providers'); if (saved) providers = JSON.parse(saved); } catch { /* Use initial configuration. */ }
let bank = validateBank(originalBank);
try { const saved = storage.getItem('bank'); if (saved) { bank = validateBank(JSON.parse(saved)); bankMeta = JSON.parse(storage.getItem('bank-meta') || JSON.stringify(bankMeta)); } } catch { /* Use built-in bank. */ }
let fileHandle = null;
const handleKey = location.href;
const handleDatabase = new Promise(resolve => {
  try {
    const request = indexedDB.open('modeltrace-files-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  } catch { resolve(null); }
});
const handleReady = handleDatabase.then(database => new Promise(resolve => {
  if (!database) return resolve();
  const request = database.transaction('handles').objectStore('handles').get(handleKey);
  request.onsuccess = () => { fileHandle = request.result || null; resolve(); };
  request.onerror = () => resolve();
}));

function vector(value, length) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) throw new Error('指纹库数字维度不正确。');
  return value.slice();
}

function validateBank(input) {
  if (!input || !Array.isArray(input.models) || input.models.length < 2 || input.models.length > 256) throw new Error('需要包含至少 2 个模型的完整统一指纹库。');
  if (input.robust?.model_order && JSON.stringify(input.robust.model_order) !== JSON.stringify(input.models.map(m => m.id))) throw new Error('指纹模型与中心顺序不一致。');
  const keep = input.models.map((m, i) => m.id?.toLowerCase().replace(/[^a-z0-9]/g, '') === 'gpt61sol' ? -1 : i).filter(i => i >= 0);
  if (keep.length !== input.models.length) {
    const size = input.models.length;
    const aligned = rows => {
      if (!Array.isArray(rows) || rows.length !== size) throw new Error('指纹中心与模型数量不一致。');
      return keep.map(i => rows[i]);
    };
    const robust = { ...input.robust, model_order: keep.map(i => input.models[i].id) };
    for (const name of ['hellinger', 'ordered_blocks']) if (robust[name]) {
      robust[name] = { ...robust[name], centroids: aligned(robust[name].centroids) };
      if (robust[name].environment_centroids) robust[name].environment_centroids = robust[name].environment_centroids.map(aligned);
    }
    input = { ...input, models: keep.map(i => input.models[i]), robust };
    if (input.models.length < 2) throw new Error('指纹库中的可用模型不足。');
  }
  const ids = new Set();
  const models = input.models.map(m => {
    if (typeof m.id !== 'string' || !m.id || m.id.length > 160 || ids.has(m.id)) throw new Error('模型标识无效或重复。');
    ids.add(m.id);
    const counts = vector(m.counts, 355);
    if (counts.some(n => n < 0)) throw new Error('指纹计数不能为负数。');
    return { id: m.id, display_name: String(m.display_name || m.id).slice(0, 160), family: String(m.family || 'models').slice(0, 80), family_name: String(m.family_name || m.family || 'models').slice(0, 80), response_count: Number(m.response_count) || 0, valid_number_count: Number(m.valid_number_count) || 0, counts };
  });
  const cleanArtifact = (a, dim) => {
    if (!a || !Array.isArray(a.centroids) || a.centroids.length !== models.length) throw new Error('指纹中心与模型数量不一致。');
    const scale = vector(a.feature_scale, dim);
    if (scale.some(n => n <= 0)) throw new Error('指纹缩放参数必须为正数。');
    if (!Array.isArray(a.nuisance_basis) || a.nuisance_basis.length > dim) throw new Error('环境投影参数无效。');
    return { feature_mean: vector(a.feature_mean, dim), feature_scale: scale, centroids: a.centroids.map(c => vector(c, dim)), nuisance_basis: a.nuisance_basis.map(c => vector(c, dim)) };
  };
  const robust = { hellinger: cleanArtifact(input.robust?.hellinger, 355) };
  const ordered = input.robust?.ordered_blocks;
  if (ordered) {
    robust.ordered_blocks = cleanArtifact(ordered, 74);
    if (!Number.isFinite(ordered.weight) || ordered.weight < 0 || ordered.weight > 1) throw new Error('有序特征权重无效。');
    robust.ordered_blocks.weight = ordered.weight;
    if (!Array.isArray(ordered.environment_centroids) || !ordered.environment_centroids.length || ordered.environment_centroids.length > 256) throw new Error('缺少环境指纹中心。');
    robust.ordered_blocks.environment_centroids = ordered.environment_centroids.map(env => {
      if (!Array.isArray(env) || env.length !== models.length) throw new Error('环境指纹中心与模型数量不一致。');
      return env.map(c => vector(c, 74));
    });
  }
  const calibration = {};
  for (const count of ['1', '2', '3']) {
    const c = input.calibration?.[count];
    if (!Number.isFinite(c?.beta) || c.beta <= 0) throw new Error('缺少有效概率校准参数。');
    calibration[count] = { beta: c.beta, cv_accuracy: Number.isFinite(c.cv_accuracy) ? c.cv_accuracy : null };
  }
  return { models, robust, calibration };
}

function summary() {
  return { model_count: bank.models.length, response_count: bank.models.reduce((n, m) => n + m.response_count, 0), models: bank.models.map(m => ({ id: m.id, display_name: m.display_name })) };
}

function persistProviders() {
  const remember = byId('remember-key').checked;
  storage.setItem('providers', JSON.stringify(providers.map(p => ({ ...p, api_key: remember ? p.api_key : '' }))));
  storage.setItem('remember-key', remember ? '1' : '0');
}

function endpoint(base, kind) {
  let url;
  try { url = new URL(base); } catch { throw new Error('Base URL 必须是完整的 http:// 或 https:// 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 仅支持不带账号、查询参数的 HTTP(S) 地址。');
  let path = url.pathname.replace(/\/$/, '').replace(/\/(chat\/completions|responses|messages|models)$/, '');
  if (!path.endsWith('/v1')) path += '/v1';
  url.pathname = `${path}/${kind}`;
  return url.href;
}

function transport(url, options) {
  return fetch(url, options);
}

async function requestJSON(url, options, key, timeout = 240000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await extensionConnector.transport(url, { ...options, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）；请检查 API 地址。`); }
    if (!response.ok) {
      let message = String(payload.error?.message || payload.error || payload.message || response.statusText);
      if (key) message = message.split(key).join('[已隐藏密钥]');
      const error = new Error(`HTTP ${response.status}: ${message.slice(0, 280)}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`请求超过 ${timeout / 1000} 秒，请稍后重试。`);
    if (error instanceof TypeError) { const unavailable = new Error('连接失败，请检查 API 地址、密钥和网络。'); unavailable.network = true; throw unavailable; }
    throw error;
  } finally { clearTimeout(timer); }
}

async function completion(conn, prompt) {
  const formats = conn.api_format === 'auto' || !conn.api_format ? ['openai', 'anthropic', 'responses'] : [conn.api_format];
  for (let i = 0; i < formats.length; i++) {
    const format = formats[i];
    const body = format === 'responses'
      ? { model: conn.api_model, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }], stream: false, store: false }
      : { model: conn.api_model, messages: [{ role: 'user', content: prompt }], stream: false };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.api_key}` };
    if (format === 'anthropic') { body.max_tokens = 4096; headers['x-api-key'] = conn.api_key; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true'; }
    if (conn.temperature != null) body.temperature = conn.temperature;
    if (conn.thinking) {
      if (format === 'responses') body.reasoning = { effort: conn.thinking };
      else body.reasoning_effort = conn.thinking;
    }
    let payload;
    try { payload = await requestJSON(endpoint(conn.base_url, format === 'anthropic' ? 'messages' : format === 'responses' ? 'responses' : 'chat/completions'), { method: 'POST', headers, body: JSON.stringify(body) }, conn.api_key, 240000); }
    catch (error) { if (i + 1 < formats.length && [404, 405, 415, 501].includes(error.status)) continue; throw error; }
    if (format === 'responses') {
      if (payload.status && payload.status !== 'completed') throw new Error('模型回答未完整生成，本轮不计入。');
      if (!Array.isArray(payload.output)) throw new Error('接口没有返回有效的 Responses 回答。');
      const content = payload.output.filter(item => item.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : []);
      if (content.some(item => item.type === 'refusal')) throw new Error('模型拒答，本轮不计入。');
      const text = content.filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('');
      if (!text.trim()) throw new Error('接口没有返回模型回答；请检查接口格式。');
      return text;
    }
    if (['max_tokens', 'refusal'].includes(payload.stop_reason)) throw new Error('模型拒答或输出被截断，本轮不计入。');
    if (payload.content) return payload.content.filter(x => x.type === 'text').map(x => x.text).join('');
    const choice = payload.choices?.[0];
    if (!choice) throw new Error('接口没有返回模型回答；请检查接口格式。');
    if (['length', 'content_filter'].includes(choice.finish_reason)) throw new Error('回答未完整生成，本轮不计入。');
    const content = choice.message?.content;
    return Array.isArray(content) ? content.map(x => x.text || '').join('') : String(content || '');
  }
}

async function directRequest(request, base) {
  const note = byId('connection-status'); note.hidden = true;
  const result = await request();
  note.hidden = false; note.textContent = extensionConnector.uses(endpoint(base, 'models')) ? '通过浏览器扩展已连接' : '浏览器直连已连接';
  return result;
}

async function api(path, body, method = 'POST') {
  if (path === '/api/providers') {
    if (method === 'GET') return { providers };
    const p = { id: body.id || crypto.randomUUID(), name: body.name, base_url: body.base_url, api_key: body.api_key };
    const index = providers.findIndex(x => x.id === p.id);
    if (index < 0) providers.push(p); else providers[index] = p;
    persistProviders();
    return { providers };
  }
  if (path.startsWith('/api/providers/') && method === 'DELETE') {
    providers = providers.filter(p => p.id !== decodeURIComponent(path.split('/').pop()));
    persistProviders();
    return { providers };
  }
  if (path === '/api/models/list') {
    return directRequest(async () => {
    const headers = { Authorization: `Bearer ${body.api_key}` };
    if (byId('conn-format').value === 'anthropic') { headers['x-api-key'] = body.api_key; headers['anthropic-version'] = '2023-06-01'; headers['anthropic-dangerous-direct-browser-access'] = 'true'; }
    const payload = await requestJSON(endpoint(body.base_url, 'models'), { headers }, body.api_key, 30000);
    if (!Array.isArray(payload.data)) throw new Error('接口未返回有效模型列表；可直接手动输入模型名。');
    return { models: [...new Set(payload.data.map(x => x.id).filter(x => typeof x === 'string'))].sort() };
    }, body.base_url);
  }
  if (path === '/api/challenges') return { challenges: generateChallenges(3) };
  if (path === '/api/analyze') return analyzeGlobalOutputs(body.outputs, bank);
  if (path === '/api/test/round') {
    return directRequest(async () => {
    const challenge = generateChallenges(1)[0];
    const text = await completion(body, challenge.prompt);
    const parsed_count = parseNumbers(text).length;
    const minimum = Math.max(80, Math.ceil(challenge.expected_count * 0.55));
    return { ...challenge, text, parsed_count, minimum, accepted: parsed_count >= minimum };
    }, body.base_url);
  }
  throw new Error('此功能需要本地完整版。');
}

function download(text, name, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function jsonForScript(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }

function serializeHTML(shared) {
  const clone = pristine.cloneNode(true);
  clone.querySelector('#modeltrace-host')?.remove();
  clone.querySelector('#modeltrace-host-ui')?.remove();
  clone.querySelector('#modeltrace-extension-consent')?.remove();
  if (shared) {
    clone.querySelector('#private-config').textContent = '[]';
    clone.querySelector('#release-meta').textContent = jsonForScript({ private: false, defaultProviderId: '', repositoryURL: release.repositoryURL });
    clone.querySelector('#private-warning').hidden = true;
    clone.querySelector('#private-warning').textContent = '';
    clone.querySelector('title').textContent = 'ModelTrace · 便携分享版';
  }
  clone.querySelector('#fingerprint-bank').textContent = jsonForScript(validateBank(bank));
  const meta = { ...bankMeta, upstream: shared ? UPSTREAM : bankMeta.upstream };
  clone.querySelector('#bank-meta').textContent = jsonForScript(meta);
  clone.querySelector('#upstream-url').setAttribute('value', meta.upstream || UPSTREAM);
  return '<!doctype html>\n' + clone.outerHTML;
}

function shareHTML() { return serializeHTML(true); }
function currentHTML() { return serializeHTML(false); }

function fileName() {
  return location.protocol === 'file:' ? decodeURIComponent(location.pathname.split('/').pop()) : (release.private ? 'ModelTrace-私人测试版.html' : 'ModelTrace-分享版.html');
}

function setStatus(id, text) { const element = byId(id); element.hidden = false; element.textContent = text; }

async function checkFileTarget(handle) {
  const file = await handle.getFile();
  if (file.name !== fileName()) throw new Error('请选择当前打开的 HTML 文件：' + fileName());
  if (file.size > 15000000) throw new Error('选定文件不是当前 HTML。');
  const text = await file.text();
  const match = text.match(/<script\b[^>]*id=["']release-meta["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match || !text.includes('id="fingerprint-bank"') || Boolean(JSON.parse(match[1]).private) !== Boolean(release.private)) throw new Error('选定文件与当前 HTML 版本不符。');
}

async function prepareFileTarget() {
  if (typeof window.showOpenFilePicker !== 'function') return null;
  await handleReady;
  let handle = fileHandle;
  if (!handle) {
    setStatus('save-status', '请选择当前打开的 HTML 文件：' + fileName() + '，允许写入更新');
    try { [handle] = await window.showOpenFilePicker({ id: 'modeltrace-html', multiple: false, types: [{ description: 'HTML', accept: { 'text/html': ['.html', '.htm'] } }] }); }
    catch (error) { if (error.name === 'SecurityError') return null; throw error; }
  }
  await checkFileTarget(handle);
  if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted' && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('未获得写入权限，尚未保存 HTML。');
  fileHandle = handle;
  const database = await handleDatabase;
  if (database) { try { database.transaction('handles', 'readwrite').objectStore('handles').put(handle, handleKey); } catch { /* The selected handle still works for this session. */ } }
  return handle;
}

async function existingFileTarget() {
  await handleReady;
  if (!fileHandle) return null;
  try {
    if (await fileHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') return null;
    await checkFileTarget(fileHandle);
    return fileHandle;
  } catch { fileHandle = null; return null; }
}

async function saveCurrentHTML(handle) {
  if (!handle) {
    download(currentHTML(), fileName(), 'text/html;charset=utf-8');
    setStatus('save-status', '已下载更新后的 HTML；原文件未改动');
    return;
  }
  await checkFileTarget(handle);
  const writable = await handle.createWritable();
  try { await writable.write(currentHTML()); await writable.close(); }
  catch (error) { try { await writable.abort(); } catch { /* Preserve the original file on write failure. */ } throw error; }
  setStatus('save-status', '已保存到 ' + handle.name);
}

function applyBank(next, meta) {
  bank = next; bankMeta = meta;
  try { storage.setItem('bank', JSON.stringify(next)); storage.setItem('bank-meta', JSON.stringify(meta)); } catch { /* File saving remains available without browser storage. */ }
  renderBank();
  window.dispatchEvent(new Event('modeltrace-bank-changed'));
}

async function updateBank() {
  const button = byId('update-bank'); const save = byId('save-html');
  button.disabled = true; save.disabled = true;
  try {
    const handle = await existingFileTarget();
    let url;
    try { url = new URL(byId('upstream-url').value); } catch { throw new Error('上游地址无效。'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('上游地址必须是 HTTP(S) JSON 地址。');
    setStatus('upstream-status', '正在拉取指纹库…');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
    let next;
    try {
      const response = await transport(url.href, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('上游返回 HTTP ' + response.status);
      const text = await response.text();
      if (text.length > 10000000) throw new Error('上游指纹库超过 10 MB。');
      next = validateBank(JSON.parse(text));
    } finally { clearTimeout(timer); }
    applyBank(next, { upstream: url.href, updatedAt: new Date().toISOString() });
    setStatus('upstream-status', '指纹库已更新 · ' + bank.models.length + ' 个模型');
    try { await saveCurrentHTML(handle); }
    catch (error) { setStatus('save-status', 'HTML 保存失败：' + error.message + '；当前页面已更新，可点击“保存到当前 HTML”重试。'); }
  } catch (error) {
    const message = error.name === 'AbortError' ? '操作已取消或请求超时' : error instanceof TypeError ? '上游连接失败，请检查网络或地址' : error.message;
    setStatus('upstream-status', '未更新：' + message);
  } finally { button.disabled = false; save.disabled = false; }
}

function renderBank() {
  const info = summary();
  window.UNIFIED_SUMMARY = info;
  byId('topbar-bank-count').textContent = `${info.model_count} 个候选模型`;
  byId('active-bank-badge').textContent = `${info.model_count} 个模型 · 本地归因`;
  byId('portable-bank-summary').textContent = `${info.model_count} 个候选模型 · ${info.response_count} 条参考回答`;
  const list = byId('portable-bank-models'); list.replaceChildren();
  for (const m of bank.models) { const item = document.createElement('div'); item.className = 'portable-model'; item.textContent = `${m.display_name} · ${m.response_count} 条`; list.appendChild(item); }
}

function initialize() {
  byId('remember-key').checked = storage.getItem('remember-key') === '1';
  extensionConnector.initialize();
  renderBank();
  byId('upstream-url').value = bankMeta.upstream || UPSTREAM;
  if (bankMeta.updatedAt) setStatus('upstream-status', '上次更新：' + new Date(bankMeta.updatedAt).toLocaleString());
  const guide = byId('quick-start');
  guide.hidden = Boolean(storage.getItem('guide-seen'));
  byId('open-guide').addEventListener('click', () => { document.querySelector('[data-workspace="test"]').click(); guide.hidden = false; guide.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  byId('close-guide').addEventListener('click', () => { guide.hidden = true; try { storage.setItem('guide-seen', '1'); } catch { /* Guidance can still be closed. */ } });
  byId('guide-api').addEventListener('click', () => { document.querySelector('[data-test-mode="progressive"]').click(); byId('conn-base').focus(); });
  byId('guide-manual').addEventListener('click', () => { document.querySelector('[data-workspace="test"]').click(); document.querySelector('[data-test-mode="manual"]').click(); byId('test-manual').scrollIntoView({ behavior: 'smooth' }); });
  byId('update-bank').addEventListener('click', updateBank);
  byId('save-html').addEventListener('click', async () => {
    const button = byId('save-html'); button.disabled = true;
    try { await saveCurrentHTML(await prepareFileTarget()); }
    catch (error) { setStatus('save-status', '未保存：' + (error.name === 'AbortError' ? '已取消' : error.message)); }
    finally { button.disabled = false; }
  });
  byId('private-warning').hidden = !release.private;
  byId('download-share').addEventListener('click', () => download(shareHTML(), 'ModelTrace-分享版.html', 'text/html;charset=utf-8'));
  byId('export-bank').addEventListener('click', () => download(JSON.stringify(validateBank(bank)), 'modeltrace-bank.json', 'application/json'));
  byId('import-bank').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 10000000) throw new Error('指纹库文件不能超过 10 MB。');
      const next = validateBank(JSON.parse(await file.text()));
      const handle = await existingFileTarget();
      applyBank(next, { ...bankMeta, updatedAt: new Date().toISOString() });
      await saveCurrentHTML(handle);
    } catch (error) { byId('bank-message').textContent = error.message; }
    finally { event.target.value = ''; }
  });
  byId('restore-bank').addEventListener('click', async () => {
    try { const handle = await existingFileTarget(); applyBank(validateBank(originalBank), { upstream: UPSTREAM, updatedAt: null }); await saveCurrentHTML(handle); }
    catch (error) { byId('bank-message').textContent = '恢复未完成：' + error.message; }
  });
  byId('remember-key').addEventListener('change', () => {
    try { persistProviders(); } catch (error) { byId('bank-message').textContent = error.message; }
  });
  byId('clear-private-data').addEventListener('click', () => {
    providers = []; storage.setItem('providers', '[]'); storage.removeItem('mt_provider_id'); storage.removeItem('mt_base_url'); location.reload();
  });
  byId('conn-key-toggle').addEventListener('click', () => {
    const field = byId('conn-key'); const visible = field.type === 'password'; field.type = visible ? 'text' : 'password'; byId('conn-key-toggle').textContent = visible ? '隐藏密钥' : '显示密钥';
  });
  byId('manual-generate').click();
  byId('manual-challenge-list').addEventListener('click', async event => {
    const button = event.target.closest('[data-copy-challenge]'); if (!button) return;
    const text = button.closest('.challenge-item').querySelector('pre').textContent;
    try { await navigator.clipboard.writeText(text); }
    catch { const area = document.createElement('textarea'); area.value = text; document.body.appendChild(area); area.select(); document.execCommand('copy'); area.remove(); }
    button.textContent = '已复制'; setTimeout(() => { button.textContent = '复制提示词'; }, 1000);
  });
  const observer = new MutationObserver(() => {
    for (const header of document.querySelectorAll('.challenge-header')) {
      if (header.querySelector('button')) continue;
      const button = document.createElement('button'); button.type = 'button'; button.dataset.copyChallenge = ''; button.textContent = '复制提示词'; header.appendChild(button);
    }
  });
  observer.observe(byId('manual-challenge-list'), { childList: true });
}

window.ModelTracePortable = { api, initialize, storage, defaultProviderId: release.defaultProviderId, shareHTML, currentHTML, validateBank };
window.UNIFIED_SUMMARY = summary();
