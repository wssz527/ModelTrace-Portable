const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');
(async () => {
  const methods=[];
  const server=http.createServer((req,res)=>{methods.push(req.method);res.writeHead(403);res.end();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser=await chromium.launch({headless:true,executablePath:process.env.MODELTRACE_BROWSER||undefined});
  try {
    const context=await browser.newContext();const page=await context.newPage();let popups=0;const errors=[];
    page.on('popup',()=>popups++);page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(process.env.MODELTRACE_HTML || path.resolve(__dirname,'../ModelTrace.html')).href);
    assert.equal(await page.locator('.topbar-github').getAttribute('href'),'https://github.com/wssz527/ModelTrace-Portable');
    await page.locator('#conn-base').fill(`http://127.0.0.1:${server.address().port}/v1`);
    await page.locator('#conn-key').fill('test-key-not-real');
    await page.locator('#conn-form button[type=submit]').click();
    await page.waitForFunction(()=>document.querySelector('#test-message').textContent.includes('拉取失败'));
    assert.match(await page.locator('#test-message').textContent(),/未检测到连接扩展/);
    assert.equal(await page.locator('#extension-help').isVisible(),true);
    assert.equal(await page.locator('#extension-disconnect').isVisible(),false);
    assert.equal(popups,0);assert.equal(await page.locator('#site-dialog,#site-bookmark,#site-disconnect').count(),0);
    assert.deepEqual(methods,['OPTIONS']);assert.deepEqual(errors,[]);
    assert.equal(await page.locator('#conn-form button[type=submit]').isEnabled(),true);
    assert.equal(await page.locator('#extension-help').evaluate(el=>el.open),true);
    const pkg=await page.evaluate(()=>JSON.parse(document.querySelector('#extension-package').textContent));
    const bytes=Buffer.from(pkg.data,'base64');
    assert.equal(pkg.url,undefined);
    let remote=0;
    await page.route(/^https?:/,route=>{remote++;return route.abort();});
    let downloaded=page.waitForEvent('download');await page.locator('#extension-download').click();
    assert.deepEqual(fs.readFileSync(await(await downloaded).path()),bytes,'A single offline HTML must provide its bundled extension');
    assert.equal(remote,0,'Downloading the embedded ZIP must not make any network request');
    await page.unroute(/^https?:/);
    await page.locator('#extension-browser').selectOption('edge');assert.equal(await page.locator('#extension-manager-url').inputValue(),'edge://extensions');
    await page.locator('#extension-copy').click();await page.waitForFunction(()=>document.querySelector('#extension-setup-status').textContent.includes('已复制'));
    await page.locator('#extension-check').click();await page.waitForFunction(()=>document.querySelector('#extension-setup-status').textContent.includes('未检测到扩展'));
    assert.deepEqual(methods,['OPTIONS'],'Checking installation must not replay an API request');
    const output=process.env.MODELTRACE_TEST_OUTPUT;
    if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'setup-desktop.png')});await page.setViewportSize({width:375,height:812});
      assert.ok(await page.locator('#extension-help').evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:path.join(output,'setup-mobile.png')});}
    await page.reload();assert.equal(await page.locator('#extension-help').evaluate(el=>el.open),true);
    await page.locator('#extension-close').click();assert.equal(await page.locator('#extension-help').isVisible(),false);
    assert.equal(popups,0);assert.deepEqual(errors,[]);
    console.log('PASS: repository link; failed direct request opens install dialog; embedded ZIP with zero network requests, manager address copy, no-extension detection, refresh/resume, mobile layout and no automatic API replay.');
  } finally {await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
