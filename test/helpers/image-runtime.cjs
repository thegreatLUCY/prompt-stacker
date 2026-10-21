const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = name => fs.readFileSync(path.join(__dirname, '../..', name), 'utf8');
function storage(data) {
  return {
    get(keys, cb) {
      const result = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (key in data) result[key] = structuredClone(data[key]);
      }
      if (cb) queueMicrotask(() => cb(result));
      else return Promise.resolve(result);
    },
    set(values, cb) { Object.assign(data, structuredClone(values)); if (cb) queueMicrotask(cb); else return Promise.resolve(); },
    remove(keys, cb) { for (const key of keys) delete data[key]; if (cb) queueMicrotask(cb); else return Promise.resolve(); },
  };
}
function runtime(data = {}) {
  const panel = { style: {}, querySelector: () => null };
  const document = {
    documentElement: { dataset: { ctigTest: '1' } },
    addEventListener() {}, removeEventListener() {}, querySelector: () => null,
    getElementById: () => panel,
  };
  const sandbox = {
    document, window: { addEventListener() {} },
    location: { hostname: 'chatgpt.com', pathname: '/c/qa', href: 'https://chatgpt.com/c/qa' },
    chrome: { storage: { local: storage(data) } },
    setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
    Intl, URL, console, IntersectionObserver: class {}, ResizeObserver: class {},
  };
  vm.createContext(sandbox);
  vm.runInContext(read('busy-lock.js'), sandbox);
  vm.runInContext(read('library.js').replace(/\}\)\(\);\s*$/, 'window.testLibrary = { loadHistory, imageJobGate, download, loadPage, loadAll, refreshHead, failures: () => lastFailures };})();'), sandbox);
  const mountTab = () => {
    const node = () => ({ disabled: false, textContent: '', addEventListener(type, cb) { this[type] = cb; } });
    const controls = Object.fromEntries(['library', 'thread', 'status', 'last'].map(id => ['#cps-img-' + id, node()]));
    const pane = { dataset: {}, querySelector: selector => controls[selector] };
    document.querySelector = () => pane;
    vm.runInContext(read('images-tab.js'), sandbox);
    return controls;
  };
  const mountQueue = () => {
    vm.runInContext(read('content.js').replace(/\}\)\(\);\s*$/, `
      window.testQueue = {
        start, pauseOrResume, stop,
        setState(value) { runState = value; },
        state: () => runState,
        configure(prompts, ask, send) {
          queue = prompts; askForVars = ask; sendAndWaitForReply = send;
          isGenerating = () => false; hideRecovery = () => {};
          renderControls = renderQueue = updateProgress = setStatus = () => {};
        },
      };
    })();`), sandbox);
    return sandbox.window.testQueue;
  };
  return { data, sandbox, window: sandbox.window, engine: sandbox.window.__ctig, api: sandbox.window.testLibrary, mountTab, mountQueue };
}
module.exports = { runtime, read };
