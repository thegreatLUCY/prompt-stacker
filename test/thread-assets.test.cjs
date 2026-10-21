const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../thread.js'), 'utf8');
const sandbox = { window: {}, setTimeout, URL, location: { href: 'https://chatgpt.com/c/qa' } };
vm.createContext(sandbox);
vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'window.parseAssets = conversationAssets; window.validOriginal = isChatGptImage;})();'), sandbox);
const parse = sandbox.window.parseAssets;
const pointer = id => ({ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-' + id });
const message = (role, parts) => ({ author: { role }, content: { content_type: 'multimodal_text', parts } });
const ids = data => Array.from(parse(data), asset => asset.fileId);

test('only generated assets on the current branch are selected', () => {
  const data = { current_node: 'latest', mapping: {
    user: { parent: null, message: message('user', [pointer('upload')]) },
    old: { parent: 'user', message: message('assistant', [pointer('obsolete')]) },
    tool: { parent: 'user', message: message('tool', [pointer('first1')]) },
    latest: { parent: 'tool', message: message('assistant', [pointer('second'), pointer('first1')]) },
  } };
  assert.deepEqual(ids(data), ['file-first1', 'file-second']);
});

test('nested image parts and sediment pointers retain the original file identity', () => {
  const data = { current_node: 'one', mapping: {
    one: { parent: null, message: message('assistant', [{ parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://file_abcdef123', width: 2048, height: 1024 }] }]) },
  } };
  const assets = parse(data);
  assert.equal(assets[0].fileId, 'file_abcdef123');
  assert.equal(assets[0].width, 2048);
});

test('a branch with only uploaded references contains no generated assets', () => {
  assert.deepEqual(ids({ current_node: 'one', mapping: { one: { parent: null, message: message('user', [pointer('upload')]) } } }), []);
});

test('unrecognized conversation formats cannot silently claim no images', () => {
  assert.throws(() => parse({ messages: [] }), /unrecognized conversation format/);
});

test('cyclic or incomplete branches produce a clear error', () => {
  assert.throws(() => parse({ current_node: 'one', mapping: { one: { parent: 'one' } } }), /incomplete conversation branch/);
  assert.throws(() => parse({ current_node: 'one', mapping: { one: { parent: 'missing' } } }), /incomplete conversation branch/);
});

test('an unresolved image pointer cannot silently drop a generated image', () => {
  assert.throws(() => parse({ current_node: 'one', mapping: { one: { parent: null, message: message('assistant', [{ content_type: 'image_asset_pointer', asset_pointer: 'unknown' }]) } } }), /no recognizable original-file reference/);
});

test('original URLs stay within the existing HTTPS image destinations', () => {
  const valid = sandbox.window.validOriginal;
  assert.equal(valid('https://files.oaiusercontent.com/original.png'), true);
  assert.equal(valid('https://chatgpt.com/backend-api/estuary/content?id=file-abcdef'), true);
  for (const url of ['http://files.oaiusercontent.com/image.png', 'https://chatgpt.com:8443/backend-api/files/a', 'https://files.oaiusercontent.com.evil.example/image.png', 'blob:https://chatgpt.com/preview']) {
    assert.equal(valid(url), false);
  }
});
