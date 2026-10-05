const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

async function consent(page, allow = true) {
  await page.locator('#modeltrace-extension-consent').waitFor({ timeout: 10000 });
  const client = await page.context().newCDPSession(page);
  const { root } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  function find(node) {
    const attributes = node.attributes || [];
    if (node.nodeName === 'BUTTON' && attributes[attributes.indexOf('class') + 1] === (allow ? 'allow' : 'cancel')) return node;
    for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) { const match = find(child); if (match) return match; }
  }
  const button = find(root); assert.ok(button, 'Consent button must exist');
  const { model } = await client.send('DOM.getBoxModel', { nodeId: button.nodeId });
  const q = model.content;
  await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
  await page.locator('#modeltrace-extension-consent').waitFor({ state: 'detached' });
  await client.detach();
}

async function main() {
  const project = path.resolve(__dirname, '..');
  const artifacts = process.env.MODELTRACE_ARTIFACT_DIR || path.dirname(project);
  const fixtures = JSON.parse(fs.readFileSync(process.env.MODELTRACE_FIXTURES || path.join(__dirname, 'fixtures.json'), 'utf8'));
  const records = [];
  let failGeneration = false;
  const server = http.createServer(async (req, res) => {
    const isCors = req.url.startsWith('/cors/') || (req.url.startsWith('/mixed/') && req.url.endsWith('/models'));
    if (isCors) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    records.push({ path: req.url, method: req.method, origin: req.headers.origin || null, authorization: req.headers.authorization, body: raw });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (req.method === 'OPTIONS') { res.writeHead(isCors ? 204 : 403); res.end(); return; }
    if (!isCors && req.headers.origin) { res.writeHead(400); res.end('{"error":"Invalid Origin"}'); return; }
    if (req.url.startsWith('/reject/')) { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Rejected sk-mock-extension' } })); return; }
    if (req.url.endsWith('/models')) { res.end('{"data":[{"id":"gpt-6-sol"}]}'); return; }
    if (failGeneration && req.method === 'POST') { res.writeHead(503); res.end('{"error":{"message":"Test failure"}}'); return; }
    if (req.url.startsWith('/slow/')) await new Promise(resolve => setTimeout(resolve, 35000));
    const text = fixtures.outputs[0].text;
    res.end(JSON.stringify(req.url.endsWith('/messages') ? { content: [{ type: 'text', text }], stop_reason: 'end_turn' } : { choices: [{ message: { content: text }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const extension = path.join(project, 'browser-extension');
  const context = await chromium.launchPersistentContext('', { executablePath: process.env.MODELTRACE_BROWSER || chromium.executablePath(), headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const errors = []; let page;
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    page = await context.newPage(); let popups = 0;
    page.on('pageerror', error => errors.push(error.message)); page.on('popup', () => popups++);
    await page.goto(pathToFileURL(process.env.MODELTRACE_HTML || path.join(project, 'ModelTrace.html')).href);
    await page.locator('#conn-key').fill('sk-mock-extension');
    assert.equal(await page.locator('#extension-help').isVisible(), false);
    assert.equal(await page.locator('#extension-disconnect').isVisible(), false);

    // A forged page message cannot authorize or request another API without a user click.
    const beforeUnauthorized = records.length;
    const denied = await page.evaluate(url => new Promise(resolve => {
      const handler = e => { if (e.data?.id === 'unapproved' && e.data.to === 'page') { window.removeEventListener('message', handler); resolve(e.data.result); } };
      window.addEventListener('message', handler);
      window.postMessage({ bridge: 'modeltrace-extension-v1', to: 'extension', type: 'request', id: 'unapproved', nonce: 'test', url, headers: { authorization: 'Bearer sk-mock-extension' } }, '*');
    }), base + '/blocked/v1/models');
    assert.match(denied.error, /尚未获得/); assert.equal(records.length, beforeUnauthorized);
    console.log('Checked unauthorized request rejection.');

    await page.locator('#conn-base').fill(base + '/blocked');
    await page.locator('#conn-form button[type=submit]').click();
    console.log('Checking consent cancellation.');
    await page.locator('#modeltrace-extension-consent').waitFor();
    assert.equal(records.filter(x => x.method === 'GET').length, 0, 'No key-bearing GET before consent');
    await consent(page, false);
    await page.waitForFunction(() => document.querySelector('#test-message').textContent.includes('拉取失败'));
    assert.equal(records.filter(x => x.method === 'GET').length, 0);
    await page.locator('#conn-form button[type=submit]').click(); await consent(page);
    console.log('Checking blocked API model list and OpenAI generation.');
    await page.waitForFunction(() => document.querySelector('#test-message').textContent.includes('拉取成功'));
    assert.match(await page.locator('#connection-status').textContent(), /扩展/);
    const models = records.find(x => x.method === 'GET'); assert.equal(models.origin, null); assert.equal(models.authorization, 'Bearer sk-mock-extension');
    await page.locator('.model-check-item').click(); await page.locator('#start-tests').click(); await page.locator('.auto-run').click();
    await page.locator('.test-card .card-result').waitFor({ state: 'visible' });
    const generated = records.filter(x => x.method === 'POST'); assert.equal(generated.length, 1);
    assert.equal(generated[0].origin, null); assert.equal(JSON.parse(generated[0].body).stream, false);
    assert.equal(JSON.parse(generated[0].body).messages.length, 1);
    assert.equal(await page.locator('#modeltrace-extension-consent').count(), 0);
    const session = await worker.evaluate(() => chrome.storage.session.get(null));
    assert.ok(!JSON.stringify(session).includes('sk-mock-extension'), 'Extension must not store keys');

    await page.locator('#extension-disconnect').click();
    console.log('Checking disconnect and direct-first requests.');
    await page.waitForFunction(() => document.querySelector('#connection-status').textContent.includes('已断开'));
    assert.equal(await page.locator('.test-card').count(), 0);
    await page.locator('#conn-base').fill(base + '/cors'); await page.locator('#conn-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#test-message').textContent.includes('拉取成功'));
    assert.match(await page.locator('#connection-status').textContent(), /直连/);
    assert.equal(records.find(x => x.method === 'GET' && x.path.startsWith('/cors/')).origin, 'null');

    console.log('Checking masked authentication errors.');
    await page.locator('#conn-base').fill(base + '/reject'); await page.locator('#conn-form button[type=submit]').click(); await consent(page);
    await page.waitForFunction(() => document.querySelector('#test-message').textContent.includes('HTTP 401'));
    assert.ok(!(await page.locator('#test-message').textContent()).includes('sk-mock-extension'));

    // A failed generation is never automatically replayed through the extension.
    console.log('Checking generation replay protection.');
    await page.locator('#conn-base').fill(base + '/mixed'); await page.locator('#conn-form button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('#test-message').textContent.includes('拉取成功'));
    await page.locator('.model-check-item').click(); await page.locator('#start-tests').click();
    await page.locator('.auto-run').click(); await consent(page);
    await page.waitForFunction(() => document.querySelector('.round-state').textContent.includes('重新开始本轮测试'));
    assert.equal(records.filter(x => x.method === 'POST' && x.path.startsWith('/mixed/')).length, 0);
    await page.locator('.auto-run').click(); await page.locator('.test-card .card-result').waitFor({ state: 'visible' });
    assert.equal(records.filter(x => x.method === 'POST' && x.path.startsWith('/mixed/')).length, 1);

    console.log('Checking slow Messages response.');
    await page.locator('#conn-base').fill(base + '/slow');
    await page.locator('#conn-key').focus();
    await page.locator('#conn-form button[type=submit]').click(); await consent(page);
    await page.waitForFunction(() => document.querySelector('#test-message').textContent.includes('拉取成功'));
    await page.locator('#conn-format').selectOption('anthropic');
    await page.locator('#manual-model-name').fill('gpt-6-sol'); await page.locator('#manual-model-add').click(); await page.locator('#start-tests').click();
    await page.locator('.auto-run').click(); await page.locator('.test-card .card-result').waitFor({ state: 'visible', timeout: 50000 });
    assert.ok(records.some(x => x.path === '/slow/v1/messages' && x.method === 'POST' && x.origin === null));
    await page.locator('[data-workspace="library"]').click();
    const downloaded = page.waitForEvent('download');
    await page.locator('#download-share').click();
    const shared = fs.readFileSync(await (await downloaded).path(), 'utf8');
    assert.ok(!shared.includes(base) && !shared.includes('sk-mock-extension'));
    assert.ok(!shared.includes('id="modeltrace-extension-consent"'));
    assert.equal(popups, 0); assert.deepEqual(errors, []);
    await page.evaluate(() => window.ModelTracePortable.storage.setItem('extension-setup', '1'));
    await page.reload();
    await page.locator('#extension-help').waitFor();
    await page.locator('#extension-check').click();
    await page.waitForFunction(() => document.querySelector('#connection-status').textContent.startsWith('扩展可用'));
    assert.equal(await page.locator('#extension-help').isVisible(), false);
    await page.locator('#conn-base').fill(base + '/blocked'); await page.locator('#conn-key').fill('sk-mock-extension');
    await page.locator('#extension-setup-open').click();
    await page.locator('#extension-check').click(); await consent(page);
    await page.waitForFunction(() => document.querySelector('#test-message').textContent.includes('拉取成功'));
    assert.match(await page.locator('#connection-status').textContent(), /扩展/);
    await page.locator('.model-check-item').click();
    await page.locator('[data-test-mode="stability"]').click();
    await page.locator('#stability-rounds').fill('2');
    await page.locator('#start-stability').click();
    await page.locator('.stability-summary').waitFor({ state: 'visible' });
    await page.locator('#picker-none').click();
    await page.locator('#manual-model-name').fill('other-model'); await page.locator('#manual-model-add').click();
    await page.locator('[data-test-mode="progressive"]').click();
    await page.locator('#start-tests').click();
    assert.equal(await page.locator('.stability-card').count(), 0, 'Deselecting a stability-only model must not throw');
    failGeneration = true;
    const beforeFailure = records.filter(x => x.method === 'POST').length;
    await page.locator('[data-test-mode="stability"]').click();
    await page.locator('#start-stability').click();
    await page.locator('.stability-summary').waitFor({ state: 'visible' });
    assert.equal(records.filter(x => x.method === 'POST').length - beforeFailure, 2, 'Each requested trial must stop after its first API error');
    assert.deepEqual(errors, []);
    console.log('PASS: local HTML + real MV3 extension: explicit consent, no key before consent, CORS/Origin/CSP blocked API, GET/OpenAI/Messages, 35-second response, direct-first route, no paid replay, disconnect, secret-free extension session and clean HTML export.');

    if (process.env.MODELTRACE_LIVE_CONFIG) {
      const providers = JSON.parse(fs.readFileSync(process.env.MODELTRACE_LIVE_CONFIG, 'utf8'));
      const privatePage = await context.newPage();
      await privatePage.goto(pathToFileURL(path.join(artifacts, 'ModelTrace-私人测试版.html')).href);
      for (const index of [1,2,3,4]) {
        console.log(`Checking private provider ${index + 1}.`);
        await privatePage.locator('#provider-select').selectOption(providers[index].id);
        await privatePage.locator('#conn-form button[type=submit]').click();
        if (index !== 3 && (index === 1 || providers[index].base_url !== providers[index - 1].base_url)) await consent(privatePage);
        await privatePage.waitForFunction(() => document.querySelector('#test-message').textContent.includes('拉取成功'), null, { timeout: 35000 });
        const count = await privatePage.locator('.model-check-item').count();
        console.log(`Private provider ${index + 1}: ${count} models; ${index === 3 ? 'direct' : 'extension'}`);
      }
    }
  } catch (error) {
    console.log('Mock UI diagnostic:', await page?.evaluate(() => ({ message: document.querySelector('#test-message')?.textContent, round: document.querySelector('.round-state')?.textContent })));
    console.log('Mock request diagnostic:', records.slice(-8).map(x => ({ method: x.method, path: x.path, origin: x.origin })));
    throw error;
  } finally { await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
