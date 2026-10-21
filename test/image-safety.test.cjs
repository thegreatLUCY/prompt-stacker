const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runtime } = require('./helpers/image-runtime.cjs');

test('a refused thread grab leaves the same-tab queue lock intact', async () => {
  const r = runtime();
  await r.window.cpsBusy.acquire('queue');
  r.window.cpsIsRunning = () => true;
  r.window.ctigGrabThread = async () => { throw Error('must not run'); };
  const controls = r.mountTab();
  await controls['#cps-img-thread'].click();
  assert.match(controls['#cps-img-status'].textContent, /Pause the prompt queue/);
  assert.equal(r.data.cps_busy_lock?.owner, 'queue');
  assert.equal(r.window.cpsBusy.owner(), 'queue');
});

test('a refused thread grab leaves another image job busy and locked', async () => {
  const r = runtime();
  await r.window.cpsBusy.acquire('images');
  r.window.ctigBusy = true;
  r.window.ctigGrabThread = async () => { throw Error('must not run'); };
  const controls = r.mountTab();
  await controls['#cps-img-thread'].click();
  assert.equal(r.window.ctigBusy, true);
  assert.equal(r.data.cps_busy_lock?.owner, 'images');
});

test('the shared image gate reserves the same-tab job before awaiting storage', async () => {
  const r = runtime();
  const first = r.api.imageJobGate();
  const second = r.api.imageJobGate();
  assert.equal(await first, null);
  assert.match(await second, /Another image job/);
  assert.equal(r.window.ctigBusy, true);
});

test('sequential downloads in already-open tabs preserve both saved ids and the newest watermark', async () => {
  const data = {};
  const a = runtime(data), b = runtime(data);
  await a.api.loadHistory();
  await b.api.loadHistory();
  await a.engine.recordDownload([{ id: 'newer', created: 200 }], { saved: 1, bytes: 10, failures: [] });
  await b.engine.recordDownload([{ id: 'older', created: 100 }], { saved: 1, bytes: 10, failures: [] });
  assert.equal(data['ctig.history'].at, 200);
  assert.deepEqual([...data['ctig.history'].ids].sort(), ['newer', 'older']);
});

test('a failed-only result from a stale tab preserves the other tab saved history', async () => {
  const data = {};
  const a = runtime(data), b = runtime(data);
  await a.engine.recordDownload([{ id: 'saved', created: 200 }], { saved: 1, bytes: 10, failures: [] });
  await b.engine.recordDownload([{ id: 'failed', created: 300 }], { saved: 0, failures: [{ id: 'failed', error: 'offline' }] });
  assert.equal(data['ctig.history'].at, 200);
  assert.deepEqual(data['ctig.history'].ids, ['saved']);
  assert.equal(data['ctig.history'].failed[0].id, 'failed');
});

test('an entirely failed download persists a retry offer without marking images saved', async () => {
  const r = runtime();
  r.engine.state.items = [{ id: 'one', created: 100, url: '/one' }, { id: 'two', created: 100, url: '/two' }];
  r.engine.state.selected = new Set(['one', 'two']);
  r.sandbox.ctigGrab = async () => { throw Error('All 2 downloads failed: HTTP 403'); };
  await r.api.download();
  assert.equal(r.engine.history.ids.size, 0);
  assert.equal(r.engine.history.failed.length, 2);
  assert.equal(r.api.failures().length, 2, 'the current picker must offer the retry without reopening');
  assert.equal(r.engine.history.failed[0].id, 'one');
  assert.match(r.engine.history.failed[0].error, /HTTP 403/);
  assert.equal(r.window.ctigBusy, false);
  assert.equal(r.data.cps_busy_lock, undefined);
  const reopened = runtime(r.data);
  await reopened.api.loadHistory();
  assert.equal(reopened.engine.history.failed.length, 2);
});

test('resuming a same-tab queue cannot take over a running image download', async () => {
  const r = runtime(), q = r.mountQueue();
  q.configure([], async () => ({}), async () => ({ ok: true }));
  q.setState('paused');
  await r.api.imageJobGate();
  await q.pauseOrResume();
  assert.equal(q.state(), 'paused');
  assert.equal(r.window.cpsBusy.owner(), 'images');
});

test('a queue finishing after being paused cannot release a same-tab image job', async () => {
  const r = runtime(), q = r.mountQueue();
  let finish, sending;
  const started = new Promise(resolve => { sending = resolve; });
  q.configure(['one'], async () => ({}), () => { sending(); return new Promise(resolve => { finish = resolve; }); });
  const run = q.start();
  await started;
  await q.pauseOrResume();
  // Let the asynchronous queue release finish before taking the image lock.
  await new Promise(resolve => setImmediate(resolve));
  await r.api.imageJobGate();
  finish({ ok: true, reply: 'done' });
  await run;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(r.data.cps_busy_lock?.owner, 'images');
});

test('queue start rechecks same-tab images after the variables dialog', async () => {
  const r = runtime(), q = r.mountQueue();
  let answer, entered, sends = 0;
  const dialog = new Promise(resolve => { entered = resolve; });
  q.configure(['{{topic}}'], () => { entered(); return new Promise(resolve => { answer = resolve; }); }, async () => { sends++; return { ok: true }; });
  const run = q.start();
  await dialog;
  await r.api.imageJobGate();
  answer({ topic: 'test' });
  await run;
  assert.equal(sends, 0);
  assert.equal(r.window.cpsBusy.owner(), 'images');
});

test('double-clicking queue start cannot enter two sending loops', async () => {
  const r = runtime(), q = r.mountQueue();
  let sends = 0, finish;
  const pending = new Promise(resolve => { finish = resolve; });
  q.configure(['one'], async () => ({}), async () => { sends++; await pending; return { ok: true }; });
  const first = q.start(), second = q.start();
  await new Promise(resolve => setImmediate(resolve));
  finish();
  await Promise.all([first, second]);
  assert.equal(sends, 1);
});

test('refreshing an exhausted cached feed finds every new page and preserves selection', async () => {
  const r = runtime();
  r.engine.state.token = 'fixture';
  r.engine.state.items = [{ id: 'old', created: 100, url: '/old' }];
  r.engine.state.exhausted = true;
  r.engine.state.selected = new Set(['old']);
  const calls = [];
  r.sandbox.fetch = async url => {
    calls.push(url);
    const page = url.includes('after=next')
      ? { items: [{ id: 'new1', created_at: 110, url: '/1' }, { id: 'old', created_at: 100, url: '/old-refreshed' }], cursor: null }
      : { items: [{ id: 'new2', created_at: 120, url: '/2' }], cursor: 'next' };
    return { ok: true, json: async () => page };
  };
  await r.api.refreshHead();
  assert.deepEqual(Array.from(r.engine.state.items, item => item.id), ['new2', 'new1', 'old']);
  assert.equal(calls.length, 2);
  assert.equal(r.engine.state.items[2].url, '/old-refreshed');
  assert.equal(r.engine.state.selected.has('old'), true);
});

test('refreshing the head preserves the cursor for already loaded older pages', async () => {
  const r = runtime();
  r.engine.state.token = 'fixture';
  r.engine.state.items = [{ id: 'known', created: 100, url: '/known' }];
  r.engine.state.cursor = 'older-pages';
  r.sandbox.fetch = async () => ({ ok: true, json: async () => ({ items: [{ id: 'new', created_at: 200, url: '/new' }, { id: 'known', created_at: 100, url: '/known' }], cursor: 'first-page-cursor' }) });
  await r.api.refreshHead();
  assert.equal(r.engine.state.cursor, 'older-pages');
  assert.equal(r.engine.state.exhausted, false);
});

test('Load all waits for an in-flight page instead of starving its network response', async () => {
  const r = runtime();
  r.engine.state.token = 'fixture';
  let answer, entered;
  const request = new Promise(resolve => { entered = resolve; });
  r.sandbox.fetch = () => { entered(); return new Promise(resolve => { answer = resolve; }); };
  const first = r.api.loadPage();
  await request;
  const all = r.api.loadAll();
  answer({ ok: true, json: async () => ({ items: [{ id: 'one', created_at: 100, url: '/one' }], cursor: null }) });
  await Promise.all([first, all]);
  assert.equal(r.engine.state.items.length, 1);
  assert.equal(r.engine.state.loading, false);
  assert.equal(r.engine.state.exhausted, true);
});
