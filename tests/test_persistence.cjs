const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

(async () => {
  const project = path.resolve(__dirname, '..');
  const html = process.env.MODELTRACE_HTML || path.join(project, 'ModelTrace.html');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'modeltrace-persistence-'));
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'))).outputs[0].text;
  const requests = [], errors = [];
  const key = 'mock-private-key-for-persistence', name = 'private-provider-persistence-test';
  const marker = 'Saved-bank-regression-marker';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-api-key, anthropic-version, anthropic-dangerous-direct-browser-access');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    if (req.method === 'POST') requests.push({ path: req.url, body: JSON.parse(text) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/models') ? { data: [{ id: 'gpt-6-sol' }] }
      : req.url.endsWith('/messages') ? { content: [{ type: 'text', text: fixture }], stop_reason: 'end_turn' }
      : { choices: [{ message: { content: fixture }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  let context, page;
  async function open(profile = 'owner', file = html) {
    context = await chromium.launchPersistentContext(path.join(temporary, profile), {
      executablePath: process.env.MODELTRACE_BROWSER || chromium.executablePath(), headless: true, acceptDownloads: true,
    });
    page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(file).href);
    await page.waitForFunction(() => !!window.ModelTracePortable);
  }
  async function saveProvider() {
    await page.locator('#provider-save').click(); await page.locator('#provider-name').fill(name);
    await page.locator('#provider-save-confirm').click();
    await page.waitForFunction(() => document.querySelector('#test-message').textContent.includes('已保存'));
  }
  try {
    await open();
    assert.equal(await page.locator('#conn-thinking').inputValue(), '');
    assert.equal(await page.locator('#upstream-url').inputValue(), 'https://raw.githubusercontent.com/xqy2006/ModelTrace/main/static/data/unified_bank.json');
    await page.locator('#conn-base').fill(base); await page.locator('#conn-key').fill(key);
    await saveProvider();
    const bank = await page.evaluate(() => JSON.parse(document.querySelector('#fingerprint-bank').textContent));
    bank.models[0].display_name = marker;
    await page.locator('[data-workspace="library"]').click();
    let downloaded = page.waitForEvent('download');
    await page.locator('#import-bank').setInputFiles({ name: 'bank.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bank)) });
    await (await downloaded).path();
    await context.close();

    await open();
    assert.equal(await page.locator('#conn-base').inputValue(), base);
    assert.equal(await page.locator('#conn-key').inputValue(), '');
    assert.equal(await page.locator('#provider-select option').last().textContent(), name);
    assert.ok((await page.locator('#portable-bank-models').textContent()).includes(marker));
    assert.equal(await page.locator('.test-card').count(), 0);
    await page.locator('#conn-key').fill(key);
    for (const format of ['openai', 'anthropic']) {
      await page.locator('#conn-format').selectOption(format);
      await page.locator('#manual-model-name').fill('gpt-6-sol'); await page.locator('#manual-model-add').click();
      await page.locator('#start-tests').click(); await page.locator('.test-card input[data-round="0"]').check();
      await page.locator('.card-result').waitFor({ state: 'visible' });
      assert.ok(!Object.hasOwn(requests.at(-1).body, 'reasoning_effort'), 'Default must omit the reasoning parameter in both API formats');
    }
    await page.locator('.card-remove').click(); await page.locator('#conn-thinking').selectOption('low');
    await page.locator('#start-tests').click(); await page.locator('.test-card input[data-round="0"]').check();
    await page.locator('.card-result').waitFor({ state: 'visible' });
    assert.equal(requests.at(-1).body.reasoning_effort, 'low');
    await page.locator('#remember-key').check(); await saveProvider();
    await context.close();

    await open();
    assert.equal(await page.locator('#conn-key').inputValue(), key);
    assert.equal(await page.locator('#remember-key').isChecked(), true);
    assert.equal(await page.locator('#conn-thinking').inputValue(), '');
    await page.locator('[data-workspace="library"]').click();
    downloaded = page.waitForEvent('download'); await page.locator('#download-share').click();
    const sharedFile = path.join(temporary, 'Shared.html'); fs.copyFileSync(await (await downloaded).path(), sharedFile);
    const shared = fs.readFileSync(sharedFile, 'utf8');
    for (const secret of [key, name, base]) assert.ok(!shared.includes(secret));
    assert.ok(shared.includes(marker));
    await page.locator('[data-workspace="test"]').click(); await page.locator('#remember-key').uncheck();
    await context.close();

    await open();
    assert.equal(await page.locator('#conn-key').inputValue(), '');
    assert.equal(await page.locator('#remember-key').isChecked(), false);
    assert.ok((await page.locator('#portable-bank-models').textContent()).includes(marker));
    await context.close();
    await open('recipient', sharedFile);
    assert.equal(await page.locator('#provider-select option').count(), 1);
    assert.equal(await page.locator('#conn-base').inputValue(), ''); assert.equal(await page.locator('#conn-key').inputValue(), '');
    assert.ok((await page.locator('#portable-bank-models').textContent()).includes(marker));
    assert.deepEqual(errors, []);
    console.log('PASS: complete browser restart retains providers/bank, opt-in key and preference; opt-out removes key; shared HTML carries current bank without providers; local compatible API works; default omits reasoning, explicit low sends it.');
  } finally {
    await context?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
