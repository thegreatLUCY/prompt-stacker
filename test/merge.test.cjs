/* v1.6.0 merge tests — the parts of the Image Grabber merge that can be checked
   without a browser. Run: node test/merge.test.cjs

   Three kinds of test live here, and the kind matters when reading a failure:

   1. PACKAGING  — reads manifest.json and asserted against hard-coded truths.
      These are the store-safety invariants (permissions, host access, files).
   2. BEHAVIOURAL — loads the REAL shipped files (library.js, busy-lock.js) in a
      vm sandbox and exercises them. These are the only tests here that would
      notice a logic regression.
   3. SOURCE GUARDRAILS — string assertions that a fix is still present in a
      file whose behaviour needs a DOM to execute. Crude on purpose: they fail
      loudly if someone reverts a fix. They are NOT proof the behaviour works —
      only a real browser is (see QA-CHECKLIST-v1.6.md).

   Deliberately no fake DOM beyond what library.js touches at load: the previous
   merge attempt's harness stubbed a DOM so thoroughly that it agreed with the
   code instead of testing it, and its "ChatGPT-only" test passed for a branch
   that could never run. Prefer a real assertion on real code, or an honest
   guardrail. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  \u2713 " + name);
  } catch (error) {
    failed++;
    console.log("  \u2717 " + name + "\n      " + (error && error.message));
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  \u2713 " + name);
  } catch (error) {
    failed++;
    console.log("  \u2717 " + name + "\n      " + (error && error.message));
  }
}

/** Body of a function, found by matching braces from its signature. */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.notStrictEqual(start, -1, `could not find ${signature}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

// ===========================================================================
console.log("packaging invariants (the store-safety surface)");
// ===========================================================================
const manifest = JSON.parse(read("manifest.json"));
// deduped: busy-lock.js is deliberately listed in both blocks
const shipped = [...new Set(manifest.content_scripts.flatMap((block) => block.js))];
const cssFiles = manifest.content_scripts.flatMap((block) => block.css || []);

test("permissions stay exactly ['storage']", () => {
  assert.deepStrictEqual(manifest.permissions, ["storage"]);
});
test("no host_permissions / background / action / options_page", () => {
  for (const key of ["host_permissions", "background", "action", "options_page", "commands"]) {
    assert.strictEqual(manifest[key], undefined, `${key} must not be added`);
  }
});
test("host access is still exactly the five 1.5.1 sites", () => {
  const EXPECTED = [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*",
    "https://chat.deepseek.com/*",
  ].sort();
  const actual = [...new Set(manifest.content_scripts.flatMap((b) => b.matches))].sort();
  assert.deepStrictEqual(actual, EXPECTED, "the merge must not widen host access");
});
test("the image engine is scoped to ChatGPT only", () => {
  const engine = manifest.content_scripts.find((b) => b.js.includes("library.js"));
  assert.ok(engine, "one block must load the engine");
  assert.deepStrictEqual(engine.matches.sort(), ["https://chat.openai.com/*", "https://chatgpt.com/*"]);
});
test("the lock loads in BOTH blocks (one implementation, two consumers)", () => {
  const blocks = manifest.content_scripts.filter((b) => b.js.includes("busy-lock.js"));
  assert.strictEqual(blocks.length, 2, "busy-lock.js must be loaded by both blocks");
});
test("every file the manifest names exists", () => {
  for (const file of [...shipped, ...cssFiles, "manifest.json"]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);
  }
});
test("name and icons are unchanged from 1.5.1", () => {
  assert.strictEqual(manifest.name, "Prompt Stacker — ChatGPT, Claude, Gemini & more");
  assert.deepStrictEqual(manifest.icons, {
    "16": "icon16.png",
    "48": "icon48.png",
    "128": "icon128.png",
  });
});
test("web_accessible_resources exposes only the three icons", () => {
  const resources = manifest.web_accessible_resources.flatMap((w) => w.resources).sort();
  assert.deepStrictEqual(resources, ["icon128.png", "icon16.png", "icon48.png"]);
});
test("description fits the Chrome Web Store limit", () => {
  assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} chars`);
});
test("version and package.json agree", () => {
  assert.strictEqual(manifest.version, JSON.parse(read("package.json")).version);
});

// ===========================================================================
console.log("\nsource guardrails (fail the build if a rule is reintroduced)");
// ===========================================================================
test("no tabs / scripting / downloads / cookies / action API anywhere", () => {
  const BANNED = /chrome\.(tabs|scripting|downloads|cookies|action|alarms)\b/;
  for (const file of [...shipped, "thread.js"]) {
    assert.ok(!BANNED.test(read(file)), `${file} uses a banned chrome API`);
  }
});
test("no absolute URL besides the GitHub link in a comment", () => {
  const ALLOWED = new Set(["https://github.com/thegreatLUCY/prompt-stacker"]);
  const FOUND = /https?:\/\/[A-Za-z0-9._/-]+/g;
  for (const file of [...shipped, "thread.js"]) {
    const found = read(file).match(FOUND) || [];
    for (const url of found) {
      assert.ok(ALLOWED.has(url), `${file} references ${url} — a new network destination`);
    }
  }
});
test("no remote code, eval, or main-world injection", () => {
  for (const file of [...shipped, "thread.js"]) {
    const source = read(file);
    assert.ok(!/\beval\s*\(/.test(source), `${file} uses eval`);
    assert.ok(!/new Function\s*\(/.test(source), `${file} uses new Function`);
    assert.ok(!/world\s*:\s*["']MAIN["']/.test(source), `${file} injects into the main world`);
  }
});
test("the lock is defined in exactly one file", () => {
  const defining = [...shipped, "thread.js"].filter((file) => /const\s+BUSY_KEY|"cps_busy_lock"/.test(read(file)));
  assert.deepStrictEqual(defining, ["busy-lock.js"], `lock constants must live only in busy-lock.js, found: ${defining}`);
});
test("the queue's pause path releases the lock (the deadlock fix)", () => {
  const content = read("content.js");
  assert.ok(
    /pauseOrResume[\s\S]{0,900}?cpsBusy\.release\(\)/.test(content),
    "pauseOrResume must release the lock, or 'pause the queue first' is impossible to obey"
  );
  assert.ok(
    /autoPauseOnLimit && detectLimit\(\)[\s\S]{0,400}?cpsBusy\.release\(\)/.test(content),
    "the usage-limit pause can last hours and must release the lock"
  );
});
test("cpsIsRunning means 'actively sending', not 'not idle'", () => {
  assert.ok(
    /window\.cpsIsRunning\s*=\s*\(\)\s*=>\s*runState\s*===\s*"running"/.test(read("content.js")),
    "a paused queue must not report itself as running"
  );
});
test("download() takes its re-entrancy guard before its first await", () => {
  const body = functionBody(read("library.js"), "async function download()");
  const guard = body.indexOf("state.busy = true");
  const firstAwait = body.indexOf("await ");
  assert.notStrictEqual(guard, -1, "download() must set state.busy");
  assert.ok(guard < firstAwait, "state.busy must be set before the first await (double-click guard)");
});
test("both image jobs go through the one gate", () => {
  assert.ok(/async function imageJobGate\(\)/.test(read("library.js")), "the gate must exist");
  assert.ok(
    /if \(window\.ctigBusy\) return/.test(read("library.js")),
    "the gate must refuse when the other image job is running"
  );
  assert.ok(
    /window\.ctigImageJobGate\(\)/.test(read("images-tab.js")),
    "the thread grab must ask the same gate"
  );
});
test("no leftover popup-era runtime messaging", () => {
  for (const file of ["library.js", "thread.js"]) {
    const source = read(file);
    assert.ok(!/chrome\.runtime\.onMessage/.test(source), `${file} still listens for runtime messages`);
    assert.ok(!/chrome\.runtime\.sendMessage/.test(source), `${file} still sends runtime messages`);
  }
});

// ===========================================================================
console.log("\nwatermark rule — the real shipped code, in a vm");
// ===========================================================================
/** library.js touches just this much DOM at load time; anything more would be a
 *  fake DOM that could agree with the code instead of testing it. */
function loadLibrary() {
  const sandbox = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: {
      documentElement: { dataset: { ctigTest: "1" } },
      addEventListener() {},
      removeEventListener() {},
      body: { append() {} },
      createElement: () => ({ style: {}, dataset: {}, append() {}, addEventListener() {}, remove() {} }),
      querySelector: () => null,
      images: [],
    },
    // Not /images, so the module-load path does not try to build the picker's
    // shadow host. Keeping the stub surface this small is deliberate — see the
    // file header.
    location: { pathname: "/c/abc123", href: "https://chatgpt.com/c/abc123" },
    // A real (fake) storage area: saveHistory() is where the id cap is actually
    // enforced, so without it the trim never runs and the cap test would prove
    // nothing.
    chrome: { storage: { local: fakeStorage() } },
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    console,
    Intl,
    URL,
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("library.js"), sandbox);
  const hook = sandbox.window.__ctig;
  assert.ok(hook, "library.js must expose its test hook when ctigTest=1");
  return hook;
}

const engine = loadLibrary();

test("an image is NEW when it is at-or-after the watermark and not yet saved", () => {
  const { history, isNewItem } = engine;
  history.at = 1000;
  history.ids = new Set(["saved_old", "saved_same_second", "saved_new"]);
  assert.strictEqual(isNewItem({ id: "brand_new", created: 1001 }), true, "newer second, not saved");
  assert.strictEqual(isNewItem({ id: "same_second_new", created: 1000 }), true, "same second, not saved");
  assert.strictEqual(isNewItem({ id: "saved_same_second", created: 1000 }), false, "same second, saved");
  assert.strictEqual(isNewItem({ id: "saved_old", created: 999 }), false, "older than the watermark");
  assert.strictEqual(isNewItem({ id: "saved_new", created: 1001 }), false, "newer but already saved");
});
test("the same-second case that broke the old rule is the one this fixes", () => {
  // A batch emitted inside one second, half of it downloaded. The old rule was
  // created > at, which hid every sibling of a saved image from "Select new".
  const { history, isNewItem } = engine;
  history.at = 5000;
  history.ids = new Set(["batch_a", "batch_b"]);
  const batch = [
    { id: "batch_a", created: 5000 },
    { id: "batch_b", created: 5000 },
    { id: "batch_c", created: 5000 },
    { id: "batch_d", created: 5000 },
  ];
  const stillNew = batch.filter(isNewItem).map((item) => item.id);
  assert.deepStrictEqual(stillNew, ["batch_c", "batch_d"]);
});
test("items with no timestamp are never offered as new", () => {
  const { history, isNewItem } = engine;
  history.at = 1000;
  history.ids = new Set();
  assert.strictEqual(isNewItem({ id: "undated", created: 0 }), false);
  assert.strictEqual(isNewItem({ id: "undated2" }), false);
});
test("nothing is 'new' before the first download", () => {
  const { history, newSinceWatermark, state } = engine;
  history.at = 0;
  state.items = [{ id: "a", created: 10 }];
  // JSON, not deepStrictEqual: values built inside the vm have the vm's own
  // Array prototype, and deepStrictEqual compares prototypes. That exact trap
  // is documented in the previous merge attempt's handoff, so it is worth
  // avoiding by construction.
  assert.strictEqual(JSON.stringify(newSinceWatermark()), "[]");
});
test("newSinceWatermark filters the loaded feed in order", () => {
  const { history, newSinceWatermark, state } = engine;
  history.at = 100;
  history.ids = new Set(["b"]);
  state.items = [
    { id: "a", created: 102 },
    { id: "b", created: 101 },
    { id: "c", created: 99 },
  ];
  assert.strictEqual(
    JSON.stringify(newSinceWatermark().map((item) => item.id)),
    JSON.stringify(["a"])
  );
});

// ===========================================================================
console.log("\ncross-tab lock — two simulated tabs sharing one storage");
// ===========================================================================
function fakeStorage() {
  const data = {};
  return {
    data,
    get(keys, cb) {
      const out = {};
      for (const key of [].concat(keys)) if (key in data) out[key] = data[key];
      cb(out);
    },
    set(obj, cb) {
      Object.assign(data, obj);
      if (cb) cb();
    },
    remove(keys, cb) {
      for (const key of [].concat(keys)) delete data[key];
      if (cb) cb();
    },
  };
}

/** A separate realm = a separate tab. Only primitives cross the boundary. */
function openTab(shared) {
  const sandbox = {
    window: {},
    document: { addEventListener() {}, visibilityState: "visible" },
    chrome: { storage: { local: shared } },
    setInterval: () => 0, // timers stay manual so the tests are deterministic
    clearInterval: () => {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(read("busy-lock.js"), sandbox);
  assert.ok(sandbox.window.cpsBusy, "busy-lock.js must expose window.cpsBusy");
  return sandbox.window.cpsBusy;
}

(async () => {
  const shared = fakeStorage();
  const tabA = openTab(shared);
  const tabB = openTab(shared);
  const tabC = openTab(shared);

  await testAsync("a free lock is acquired", async () => {
    assert.strictEqual(await tabA.acquire("queue"), null);
    assert.strictEqual(shared.data.cps_busy_lock.owner, "queue");
    assert.strictEqual(typeof shared.data.cps_busy_lock.token, "string");
  });

  await testAsync("another tab is blocked, and told who is in the way", async () => {
    const held = await tabB.acquire("images");
    assert.ok(held, "tab B must be refused");
    assert.strictEqual(held.owner, "queue", "tab B must be told the queue holds it");
  });

  await testAsync("the same owner in another tab is blocked too (two downloads at once)", async () => {
    const held = await tabB.acquire("queue");
    assert.ok(held, "a second tab must not start a parallel queue either");
    assert.strictEqual(held.owner, "queue");
  });

  await testAsync("release frees the lock for the next tab", async () => {
    await tabA.release();
    assert.strictEqual(shared.data.cps_busy_lock, undefined);
    assert.strictEqual(await tabB.acquire("images"), null);
    assert.strictEqual(shared.data.cps_busy_lock.owner, "images");
  });

  await testAsync("images block images (the lost-watermark-record bug)", async () => {
    const held = await tabC.acquire("images");
    assert.ok(held, "a second tab must not start a parallel download");
    assert.strictEqual(held.owner, "images");
  });

  await testAsync("a stale lock is ignored", async () => {
    await tabB.release();
    shared.data.cps_busy_lock = { owner: "queue", token: "ghost", ts: Date.now() - tabA.TTL - 5000 };
    assert.strictEqual(await tabC.acquire("images"), null, "an expired lock must not block anyone");
  });

  await testAsync("a tab that lost the lock cannot delete the new holder's lock", async () => {
    await tabC.release();
    await tabA.acquire("queue");
    // Simulate the freeze/throttle case: A's lock expires and B takes over.
    shared.data.cps_busy_lock.ts = Date.now() - tabA.TTL - 5000;
    assert.strictEqual(await tabB.acquire("images"), null, "B takes over the expired lock");
    const tokenB = shared.data.cps_busy_lock.token;
    await tabA.release();
    assert.ok(shared.data.cps_busy_lock, "A's release must NOT remove B's lock");
    assert.strictEqual(shared.data.cps_busy_lock.token, tokenB);
  });

  await testAsync("the TTL outlives Chrome's hidden-tab timer throttle", async () => {
    // Chrome throttles timers in a hidden tab to ~1/minute. A hidden tab is the
    // normal case (start the queue, switch tabs), so the TTL has to survive at
    // least two missed beats or the guard silently lapses mid-run.
    assert.ok(tabA.TTL > 60000, `TTL ${tabA.TTL}ms must exceed the ~60s hidden-tab interval`);
    assert.ok(tabA.BEAT < tabA.TTL, "the heartbeat must be faster than the TTL");
    assert.ok(tabA.TTL >= 2 * tabA.BEAT, "the TTL must survive several missed beats");
  });

  await testAsync("read() reports a live foreign lock, blocker() ignores our own", async () => {
    await tabB.release(); // nothing is held at this point
    const tabD = openTab(shared);
    assert.strictEqual(await tabD.acquire("queue"), null, "the lock must be free here");
    const other = openTab(shared);
    const seen = await other.read();
    assert.ok(seen && seen.owner === "queue", "read() must see another tab's lock");
    const mine = await tabD.blocker();
    assert.strictEqual(mine, null, "blocker() must not report the tab's own lock");
    await tabD.release();
  });

  // ===========================================================================
  console.log("\nrecordDownload / id cap (the 20k eviction bug)");
  // ===========================================================================
  // The cap is read from the source rather than hard-coded, so this stays true if
  // the number is ever tuned — the invariant under test is "the newest survive",
  // not the specific value.
  const MAX_REMEMBERED_IDS = Number(
    /const\s+MAX_REMEMBERED_IDS\s*=\s*(\d+)/.exec(read("library.js"))[1]
  );

  await testAsync("ids are stored oldest-first so the tail is the newest download", async () => {
    const { history, recordDownload } = engine;
    history.ids = new Set();
    history.at = 0;
    const items = [
      { id: "newest", created: 300 },
      { id: "middle", created: 200 },
      { id: "oldest", created: 100 },
    ];
    await recordDownload(items, { failures: [], bytes: 0, saved: 3 });
    assert.strictEqual(JSON.stringify([...history.ids]), JSON.stringify(["oldest", "middle", "newest"]));
    assert.strictEqual(history.at, 300, "the watermark moves to the newest saved image");
  });
  await testAsync("the watermark never moves backwards", async () => {
    const { history, recordDownload } = engine;
    history.at = 900;
    history.ids = new Set();
    await recordDownload([{ id: "old", created: 100 }], { failures: [], bytes: 0, saved: 1 });
    assert.strictEqual(history.at, 900, "re-downloading old images must not make everything look new");
  });
  await testAsync("failed downloads are not marked as saved", async () => {
    const { history, recordDownload } = engine;
    history.at = 0;
    history.ids = new Set();
    await recordDownload(
      [
        { id: "ok", created: 100 },
        { id: "broken", created: 100 },
      ],
      { failures: [{ id: "broken", error: "HTTP 403" }], bytes: 10, saved: 1 }
    );
    assert.ok(history.ids.has("ok"));
    assert.ok(!history.ids.has("broken"), "a failed item must stay selectable");
    assert.strictEqual(
      JSON.stringify(history.failed),
      JSON.stringify([{ id: "broken", error: "HTTP 403" }])
    );
  });
  await testAsync("past the cap the NEWEST ids survive and the oldest are dropped", async () => {
    const { history, recordDownload } = engine;
    history.ids = new Set();
    history.at = 0;
    const total = MAX_REMEMBERED_IDS + 25;
    const items = [];
    for (let i = 0; i < total; i++) items.push({ id: `id_${i}`, created: total - i }); // feed order: newest first
    await recordDownload(items, { failures: [], bytes: 0, saved: total });
    assert.strictEqual(history.ids.size, MAX_REMEMBERED_IDS, "the set is trimmed to the cap");
    assert.ok(history.ids.has("id_0"), "the newest id must survive the trim");
    assert.ok(!history.ids.has(`id_${total - 1}`), "the oldest id must be the one dropped");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
