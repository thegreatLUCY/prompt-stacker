/* Large-payload check of the shipping engine. Creates about 750 MB of
 * temporary ZIPs. Run separately: node test/verify-archives.cjs
 * Uses the actual production split threshold and validates extracted bytes.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const output = process.env.QA_OUTPUT || '/tmp/prompt-stacker-verification';
fs.mkdirSync(output, { recursive: true });

function engine(sources) {
  const blobs = [], urls = new Map();
  let id = 0;
  class TestURL extends URL {
    static createObjectURL(blob) { const url = 'blob:qa-' + ++id; urls.set(url, blob); return url; }
    static revokeObjectURL() {}
  }
  const sandbox = {
    Blob, TextEncoder, Uint8Array, Uint32Array, URL: TestURL,
    setTimeout: () => 0,
    location: { href: 'https://chatgpt.com/' },
    document: {
      body: { append() {} },
      createElement: () => ({
        style: {},
        click() { blobs.push({ filename: this.download, blob: urls.get(this.href) }); },
        remove() {},
      }),
    },
    fetch: async url => {
      const source = sources[url];
      if (!source) return {
        ok: false, status: 403, headers: { get: () => 'application/json' },
        json: async () => ({ detail: 'fixture denied' }),
      };
      return {
        ok: true, headers: { get: () => source.type || 'image/png' },
        arrayBuffer: async () => source.bytes.buffer,
      };
    },
  };
  vm.createContext(sandbox);
  for (const name of ['zip-lib.js', 'grabber.js']) {
    vm.runInContext(fs.readFileSync(path.join(repo, name), 'utf8'), sandbox);
  }
  return { blobs, grab: sandbox.ctigGrab };
}
const save = async (blob, filename) => fs.writeFileSync(path.join(output, filename), Buffer.from(await blob.arrayBuffer()));
(async () => {
  const original = new Uint8Array(fs.readFileSync(path.join(repo, 'icon128.png')));
  const small = engine({ a: { bytes: original }, b: { bytes: original } });
  const result = await small.grab({
    baseName: 'unicode-测试',
    images: [
      { id: 'a', name: 'α', url: 'a', prompt: 'line\tbreak\nnext' },
      { id: 'b', name: 'β', url: 'b' },
      { id: 'bad', name: 'bad', url: 'bad' },
    ],
  });
  assert.equal(result.saved, 2);
  assert.equal(result.failed, 1);
  await save(small.blobs[0].blob, 'engine-small.zip');
  assert.equal(small.blobs.length, 1);
  const denied = engine({});
  await assert.rejects(denied.grab({
    baseName: 'all-failed', images: [{ id: 'bad', name: 'bad', url: 'bad' }],
  }), /All 1 downloads failed/);
  assert.equal(denied.blobs.length, 0, 'all-failed jobs must not create an empty ZIP');

  // Actual production threshold: no source substitutions or scaled constants.
  const payload = new Uint8Array(125 * 1024 * 1024).fill(73);
  const large = engine({ x: { bytes: payload }, y: { bytes: payload }, z: { bytes: original } });
  const images = ['x', 'y', 'z'].map(id => ({ id, name: id, url: id }));
  const split = await large.grab({ baseName: 'split', images });
  assert.equal(JSON.stringify(split.parts.map(part => part.files)), '[2,1]');
  for (let i = 0; i < large.blobs.length; i++) await save(large.blobs[i].blob, `engine-part${i + 1}.zip`);

  const edge = engine({ x: { bytes: payload }, y: { bytes: payload } });
  const edgeResult = await edge.grab({ baseName: 'edge', images: [...images.slice(0, 2), { id: 'bad', name: 'bad', url: 'bad' }] });
  assert.equal(edgeResult.saved, 2);
  assert.equal(edgeResult.failed, 1);
  assert.equal(JSON.stringify(edgeResult.parts.map(part => part.files)), '[2,0]',
    'the final failure report must add zero saved images');
  assert.equal(edge.blobs.length, 2);
  const last = Buffer.from(await edge.blobs.at(-1).blob.arrayBuffer());
  await save(edge.blobs[0].blob, 'engine-edge-images.zip');
  await save(edge.blobs.at(-1).blob, 'engine-edge.zip');
  const integrity = spawnSync('python3', ['-c', `
import sys,zipfile,pathlib,json
out,repo=map(pathlib.Path,sys.argv[1:])
original=(repo/'icon128.png').read_bytes()
results=[]
for name in ['engine-small.zip','engine-part1.zip','engine-part2.zip','engine-edge-images.zip','engine-edge.zip']:
 with zipfile.ZipFile(out/name) as z:
  assert z.testzip() is None
  if name=='engine-edge.zip':
   assert z.namelist()==['index.tsv'], 'final part must contain only the failure index'
   index=z.read('index.tsv').decode('utf-8')
   assert index.splitlines()[0]=='file\\tid\\tcreated\\tsize\\tdimensions\\tprompt'
   assert 'Failed:' in index
   assert 'bad\\tbad\\tHTTP 403: {"detail":"fixture denied"}' in index
  for entry in z.namelist():
   if entry.endswith('.png'):
    data=z.read(entry)
    assert data==original or (len(data)==125*1024*1024 and set(data)=={73})
  results.append({'zip':name,'CRC':'pass','imageBytes':'identical','entries':z.namelist()})
print(json.dumps(results))
`, output, repo], { encoding: 'utf8' });
  assert.equal(integrity.status, 0, integrity.stderr);
  const summary = {
    integrity: JSON.parse(integrity.stdout), split: JSON.parse(JSON.stringify(split.parts)),
    edge: { parts: edgeResult.parts.length, failures: edgeResult.failures, failureIndexPresent: last.includes(Buffer.from('fixture denied')) },
  };
  fs.writeFileSync(path.join(output, 'archive-results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  assert.ok(summary.edge.failureIndexPresent, 'index.tsv must preserve errors after a part flush');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
