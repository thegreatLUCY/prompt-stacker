/* Optional integration checks against an isolated Chrome already started with
 * this unpacked extension. Never connect this script to a personal profile.
 * PLAYWRIGHT_MODULE=/path/to/playwright node test/browser-images.cjs
 * CDP_URL defaults to http://127.0.0.1:9333; QA_OUTPUT defaults to /tmp/prompt-stacker-verification.
 * Site/API fixtures prove the shipped browser code; they do not prove ChatGPT's live API contract.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.QA_OUTPUT || '/tmp/prompt-stacker-verification';
fs.mkdirSync(output, { recursive: true });
const png = fs.readFileSync(path.join(__dirname, '../icon128.png'));
const feed = () => [
  ...['a', 'b', 'c', 'd'].map(id => ({ id, created_at: 1000, url: '/qa-image/' + id, width: 128, height: 128, prompt: 'QA image ' + id })),
  { id: 'old', created_at: 900, url: '/qa-image/old', width: 128, height: 128 },
];
(async () => {
  const browser = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9333');
  const ctx = browser.contexts()[0], results = [], pages = [];
  let failed = 0;
  async function check(name, fn) {
    try { await fn(); results.push({ name, pass: true }); console.log('PASS', name); }
    catch (error) { failed++; results.push({ name, pass: false, error: error.message }); console.log('FAIL', name, error.message); }
  }
  async function fixture(host = 'chatgpt.com') {
    const page = await ctx.newPage(); pages.push(page);
    const cdp = await ctx.newCDPSession(page), errors = []; let world;
    cdp.on('Runtime.executionContextCreated', e => { if (e.context.origin.startsWith('chrome-extension://')) world = e.context.id; });
    page.on('pageerror', error => errors.push(error.message));
    page.on('requestfailed', request => { if (request.url().startsWith('chrome-extension:')) errors.push(request.failure()?.errorText); });
    await cdp.send('Runtime.enable');
    const control = { items: feed(), imageFailure: false, slow: 0, feedCalls: 0, downloads: [] };
    page.on('download', d => control.downloads.push(d));
    await page.route('https://' + host + '/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/auth/session') return route.fulfill({ json: control.authFailure ? {} : { accessToken: 'fixture-token' } });
      if (url.pathname.includes('/backend-api/my/recent/image_gen')) { control.feedCalls++; return route.fulfill({ json: { items: control.items, cursor: null } }); }
      if (url.pathname.startsWith('/qa-image/')) {
        if (control.slow) await new Promise(resolve => setTimeout(resolve, control.slow));
        return control.imageFailure
          ? route.fulfill({ status: 403, json: { detail: 'fixture failure' } })
          : route.fulfill({ contentType: 'image/png', body: png });
      }
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html data-ctig-test="1"><title>Controlled QA fixture</title><body><h1>Controlled QA fixture</h1></body></html>' });
    });
    await page.goto('https://' + host + '/qa', { waitUntil: 'domcontentloaded' });
    await page.locator('#cps-panel').waitFor();
    const ev = async expression => {
      const r = await cdp.send('Runtime.evaluate', { expression, contextId: world, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    await page.locator('.cps-header').click();
    await page.locator('[data-tab="images"]').click();
    return { page, ev, errors, control };
  }
  const a = await fixture(), b = await fixture();
  await a.ev('chrome.storage.local.clear()');
  for (const host of ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'chat.deepseek.com']) {
    await check('manifest injection and Images gating on ' + host, async () => {
      const f = await fixture(host);
      assert.deepEqual(await f.page.locator('.cps-tab').allTextContents(), ['Queue', 'Library', 'Images']);
      const chatgpt = ['chatgpt.com', 'chat.openai.com'].includes(host);
      assert.deepEqual(await f.page.locator('[data-pane="images"] button').evaluateAll(es => es.map(e => e.disabled)), [!chatgpt, !chatgpt]);
      assert.equal(await f.page.locator('#cps-img-status').innerText(), chatgpt ? '' : 'Images works on ChatGPT only — open chatgpt.com to use it.');
      assert.equal(await f.page.locator('#cps-img-last').innerText(), '');
      await f.page.screenshot({ path: path.join(output, 'fixture-' + host + '.png') });
      assert.deepEqual(f.errors, []);
      await f.page.close();
    });
  }
  await check('same-tab refused thread action preserves the queue lock', async () => {
    await a.ev('window.cpsIsRunning=()=>true;window.cpsBusy.acquire("queue")');
    await a.page.locator('#cps-img-thread').click();
    await a.page.waitForTimeout(100);
    assert.match(await a.page.locator('#cps-img-status').innerText(), /Pause the prompt queue/);
    assert.equal((await b.ev('window.cpsBusy.read()')).owner, 'queue');
    await a.ev('window.cpsBusy.release();window.cpsIsRunning=()=>false');
  });
  await check('picker hides panel and loads five fixture images', async () => {
    await a.page.locator('#cps-img-library').click();
    await a.page.locator('.cell').last().waitFor();
    assert.equal(await a.page.locator('.cell').count(), 5);
    assert.equal(await a.page.locator('#cps-panel').isVisible(), false);
    assert.equal(await a.page.locator('[data-act="new"]').isDisabled(), true);
    assert.match(await a.page.locator('[data-act="new"]').getAttribute('title'), /download something first/);
    await a.page.screenshot({ path: path.join(output, 'picker-desktop.png') });
  });
  await check('half-batch, double-click guard, real ZIP download and same-second Select new', async () => {
    await a.page.locator('.cell').nth(0).click();
    await a.page.locator('.cell').nth(1).click();
    await a.page.locator('[data-act="go"]').dblclick();
    await a.page.waitForFunction(() => document.querySelector('#chatgpt-thread-image-grabber').shadowRoot.querySelector('.status').textContent.startsWith('Saved 2'));
    assert.equal(a.control.downloads.length, 1);
    await a.control.downloads[0].saveAs(path.join(output, 'half-batch.zip'));
    assert.equal(await a.page.locator('.cell.had').count(), 2);
    await a.page.locator('[data-act="new"]').click();
    await a.page.waitForFunction(() => document.querySelector('#chatgpt-thread-image-grabber').shadowRoot.querySelector('.status').textContent.startsWith('2 new since'));
    assert.equal(await a.page.locator('.cell.on').count(), 2);
    assert.match(await a.page.locator('.status').innerText(), /2 new since/);
    await a.page.screenshot({ path: path.join(output, 'picker-half-batch.png') });
  });
  await check('keyboard preview, selection and queue shortcuts stand down inside picker', async () => {
    await a.page.locator('.cell').nth(2).click();
    await a.page.keyboard.press('ArrowRight');
    await a.page.keyboard.press('f');
    assert.equal(await a.page.locator('.lightbox').count(), 1);
    await a.page.keyboard.press('Escape');
    assert.equal(await a.page.locator('.lightbox').count(), 0);
    await a.page.keyboard.press('Meta+a');
    assert.equal(await a.page.locator('.cell.on').count(), 5);
    const before = await a.page.locator('#cps-panel').getAttribute('class');
    await a.page.keyboard.press('Meta+Shift+h');
    assert.equal(await a.page.locator('#cps-panel').getAttribute('class'), before);
    await a.page.keyboard.press('Escape');
    assert.equal(await a.page.locator('#cps-panel').isVisible(), true);
  });
  await check('sequential downloads in already-open tabs preserve saved history', async () => {
    await a.ev('window.__ctig.recordDownload([{id:"newer",created:2000}],{saved:1,bytes:10,failures:[]})');
    await b.ev('window.__ctig.recordDownload([{id:"older",created:100}],{saved:1,bytes:10,failures:[]})');
    const h = (await b.ev('chrome.storage.local.get("ctig.history")'))['ctig.history'];
    assert.equal(h.at, 2000); assert.ok(h.ids.includes('newer') && h.ids.includes('older') && h.ids.includes('a'));
  });
  await check('total network failure shows error, persists retry and releases lock', async () => {
    a.control.imageFailure = true;
    await a.page.locator('#cps-img-library').click();
    await a.page.locator('[data-act="all"]').click();
    await a.page.locator('[data-act="go"]').click();
    await a.page.waitForFunction(() => document.querySelector('#chatgpt-thread-image-grabber').shadowRoot.querySelector('.status').textContent.startsWith('All 5 downloads failed'));
    await a.page.locator('[data-act="retry"]').waitFor({ state: 'visible' });
    assert.equal(await a.page.locator('[data-act="retry"]').isVisible(), true);
    assert.equal(await a.page.locator('[data-act="retry"]').innerText(), 'Select 5 failed');
    assert.equal(await b.ev('window.cpsBusy.read()'), null);
    a.control.imageFailure = false;
    await a.page.keyboard.press('Escape');
  });
  await check('a download keeps both panel actions disabled after closing the picker', async () => {
    a.control.slow = 1200;
    await a.page.locator('#cps-img-library').click();
    await a.page.locator('[data-act="all"]').click();
    await a.page.locator('[data-act="go"]').click();
    await a.page.keyboard.press('Escape');
    assert.equal(await a.page.locator('#cps-img-library').isDisabled(), true);
    assert.equal(await a.page.locator('#cps-img-thread').isDisabled(), true);
    await a.page.waitForTimeout(1600);
    assert.equal(await a.page.locator('#cps-img-library').isDisabled(), false);
    a.control.slow = 0;
  });
  await check('new images added while the tab stays open appear after reopening the picker', async () => {
    a.control.items = [{ id: 'fresh', created_at: 3000, url: '/qa-image/fresh', width: 128, height: 128 }, ...feed()];
    await a.page.locator('#cps-img-library').click();
    await a.page.waitForTimeout(250);
    assert.equal(await a.page.locator('.cell').count(), 6);
    await a.page.keyboard.press('Escape');
  });
  await check('compact queue controls and dragging still work', async () => {
    // Close any picker left open by a failing assertion.
    await a.page.keyboard.press('Escape');
    await a.page.locator('[data-tab="queue"]').click();
    assert.equal(await a.page.locator('#cps-start').isVisible(), true);
    assert.equal(await a.page.locator('#cps-stop').isVisible(), true);
    const header = await a.page.locator('.cps-header').boundingBox();
    await a.page.mouse.move(header.x + 45, header.y + 15); await a.page.mouse.down();
    const targetX = header.x > 400 ? header.x - 150 : header.x + 150;
    await a.page.mouse.move(targetX + 45, header.y + 15, { steps: 10 }); await a.page.mouse.up();
    const after = await a.page.locator('.cps-header').boundingBox();
    assert.ok(Math.abs(after.x - header.x) > 50);
    assert.deepEqual(a.errors, []); assert.deepEqual(b.errors, []);
  });
  await check('signed-out Select new and Load all show a readable error without hanging', async () => {
    const f = await fixture();
    f.control.authFailure = true;
    await f.page.locator('#cps-img-library').click();
    const status = () => f.page.waitForFunction(() => document.querySelector('#chatgpt-thread-image-grabber').shadowRoot.querySelector('.status').textContent === 'Not signed in.');
    await status();
    await f.page.locator('[data-act="new"]').click();
    await status();
    await f.page.locator('[data-act="more"]').click();
    await status();
    assert.deepEqual(f.errors, []);
    await f.page.close();
  });
  fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
  for (const p of pages) if (!p.isClosed()) await p.close();
  await browser.close();
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
