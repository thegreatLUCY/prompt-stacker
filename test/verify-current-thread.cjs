/* Regression reproducer for the live ChatGPT DOM observed on 19 October 2026.
 * Run separately: node test/verify-current-thread.cjs
 * Expected contract: legacy image URLs AND current generated-image-preview/blob
 * outputs are recognized, while user attachments remain excluded.
 * Original files are resolved through the conversation API; blob previews are
 * never downloaded as substitutes. Live byte comparison is a separate check.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../thread.js'), 'utf8');
async function scan(modern) {
  const scroller = { scrollHeight: 1000, clientHeight: 600, scrollTop: 0 };
  const generated = { getAttribute: name => name === 'data-testid' ? 'generated-image-preview' : null };
  const assistant = { getAttribute: () => 'assistant' };
  const user = { getAttribute: () => 'user' };
  const image = (url, uploaded = false) => ({
    src: url, currentSrc: url, naturalWidth: 1024, naturalHeight: 1024,
    getAttribute: () => null,
    closest(selector) {
      if (!modern && selector === '[data-message-author-role]') return uploaded ? user : assistant;
      if (modern && !uploaded && selector === '[data-testid="generated-image-preview"]') return generated;
      return null;
    },
  });
  const images = modern
    ? [image('blob:https://chatgpt.com/output-a'), image('blob:https://chatgpt.com/output-b'), image('blob:https://chatgpt.com/upload', true)]
    : [image('https://chatgpt.com/backend-api/files/file-abcdef/content'), image('https://chatgpt.com/backend-api/files/file-upload/content', true)];
  const sandbox = {
    window: {}, URL, console, setTimeout,
    location: { hostname: 'chatgpt.com', href: 'https://chatgpt.com/c/qa', pathname: '/c/qa' },
    document: { images, title: 'QA', querySelector: () => null, scrollingElement: scroller },
    fetch: async url => {
      if (!modern) return { ok: false, status: 401 };
      if (url === '/api/auth/session') return { ok: true, json: async () => ({ accessToken: 'fixture' }) };
      if (url === '/backend-api/conversation/qa') return { ok: true, json: async () => ({
        current_node: 'output', mapping: {
          upload: { parent: null, message: { author: { role: 'user' }, content: { parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-upload' }] } } },
          output: { parent: 'upload', message: { author: { role: 'assistant' }, content: { parts: ['a', 'b'].map(id => ({ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-output' + id })) } } },
        },
      }) };
      assert.match(url, /^\/backend-api\/files\/download\/file-output[ab]\?/);
      assert.ok(url.includes('inline=false'));
      return { ok: true, json: async () => ({ download_url: '/backend-api/files/file-output/content' }) };
    },
    ctigGrab: async ({ images }) => {
      for (const image of images) assert.ok(!image.url.startsWith('blob:'), 'only resolved originals enter the ZIP engine');
      return { saved: images.length, bytes: 0, failed: 0, parts: [] };
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.ctigGrabThread(() => {});
}
(async () => {
  const legacy = await scan(false);
  assert.equal(legacy.saved, 1, 'legacy output is found and user uploads excluded');
  const current = await scan(true);
  console.log(JSON.stringify({ legacyGeneratedImages: legacy.saved, currentGeneratedImages: current.saved, expectedCurrent: 2 }, null, 2));
  assert.equal(current.saved, 2, 'LIVE BLOCKER: current generated-image-preview/blob outputs are missed');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
