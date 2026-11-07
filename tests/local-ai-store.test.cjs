'use strict';
// DOWNLOADS THAT TELL THE TRUTH: resume, atomic install, a hash mismatch as a NAMED STATE, and an
// engine binary that must carry the pinned Dory build. Adapted from the first cut, which had these
// right; the backend names are the product's now (cuda / vulkan / metal / rocm / cpu).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { downloadVerified } = require('../desktop/local-ai/src/downloader.cjs');
const { Store, validateManifest } = require('../desktop/local-ai/src/store.cjs');
const IDS = require('../desktop/local-ai/src/config.cjs').ids;
const { ENGINE_META } = require('../desktop/local-ai/dev/fixtures.cjs');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lai-store-'));
// The installed engine binary and the manifest keys are OPAQUE IDS (config.ids): a person who opens
// their own application-data folder reads `en`, and our manifest is keyed `model-m1-q2`.
const EXE = process.platform === 'win32' ? IDS.binary.win32 : IDS.binary.unix;
const PREFIX = `${process.platform}-${process.arch}`;
const packKey = (backend) => `${PREFIX}-${IDS.backend[backend]}`;
const modelKey = (quant) => `${IDS.model}-${quant}`;

/** Range-capable file server. `cutFirst`: the first full response is cut off after N bytes. */
function serve(files, { cutFirst } = {}) {
  const seen = [];
  let cut = !!cutFirst;
  const srv = http.createServer((req, res) => {
    const buf = files[req.url.slice(1)];
    if (!buf) { res.writeHead(404); return res.end(); }
    seen.push(req.headers.range || null);
    const match = /bytes=(\d+)-/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    res.writeHead(match ? 206 : 200, { 'Content-Length': buf.length - start });
    if (cut && !match) { cut = false; res.write(buf.subarray(0, cutFirst)); return setTimeout(() => res.destroy(), 30); }
    return res.end(buf.subarray(start));
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, base: `http://127.0.0.1:${srv.address().port}` })));
}

const file = (name, buf, base) => ({ name, url: `${base}/${name}`, sha256: sha(buf), size: buf.length });
const manifestFor = (files, extra = {}, backend = 'cuda') => ({
  engine: { version: '1.0.0', build: '43e865ec059a', family: ENGINE_META.family, overrides: { ...ENGINE_META.overrides }, platforms: { [packKey(backend)]: { files } } },
  models: {},
  ...extra,
});

test('resume: an interrupted download continues with a Range request and verifies', async () => {
  const data = crypto.randomBytes(300000);
  const { srv, seen, base } = await serve({ m: data }, { cutFirst: 100000 });
  const dest = path.join(tmp(), 'm.gguf');
  try {
    await assert.rejects(downloadVerified({ url: `${base}/m`, dest, sha256: sha(data), size: data.length, allowInsecure: true }));
    assert.ok(fs.statSync(`${dest}.part`).size > 0 && !fs.existsSync(dest), 'a partial must stay a .part file, never at dest');
    await downloadVerified({ url: `${base}/m`, dest, sha256: sha(data), size: data.length, allowInsecure: true });
    assert.ok(seen.some((r) => r && /^bytes=\d+-$/.test(r)), `no Range request: ${seen}`);
    assert.strictEqual(sha(fs.readFileSync(dest)), sha(data));
    assert.ok(!fs.existsSync(`${dest}.part`));
  } finally { srv.close(); }
});

test('a hash mismatch is a NAMED STATE: nothing at dest, partial removed, nothing ran', async () => {
  const data = crypto.randomBytes(5000);
  const { srv, base } = await serve({ m: data });
  const dest = path.join(tmp(), 'm.gguf');
  try {
    await assert.rejects(downloadVerified({ url: `${base}/m`, dest, sha256: sha(Buffer.from('other')), size: data.length, allowInsecure: true }), /E_VERIFY/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
  } finally { srv.close(); }
});

test('https only, unless the caller explicitly allows a local http source', async () => {
  await assert.rejects(downloadVerified({ url: 'http://example.com/x', dest: path.join(tmp(), 'x'), sha256: 'a'.repeat(64), size: 1 }), /E_INSECURE/);
});

/**
 * THE TWO FIELDS THAT CARRY THE ENGINE'S METADATA, and the refusals that make them mandatory. A launch
 * with an empty --override-kv would silently run a different model configuration, so a manifest that
 * omits them is refused BY NAME — never defaulted.
 */
test('the manifest must carry engine.family and engine.overrides, refused by name when absent', () => {
  const good = file(EXE, Buffer.from('x'), 'https://h');
  const withEngine = (patch) => ({ ...manifestFor([good]), engine: { ...manifestFor([good]).engine, ...patch } });
  assert.ok(validateManifest(manifestFor([good])));
  assert.throws(() => validateManifest(withEngine({ family: '' })), /E_MANIFEST: engine\.family/);
  assert.throws(() => validateManifest(withEngine({ family: undefined })), /E_MANIFEST: engine\.family/);
  assert.throws(() => validateManifest(withEngine({ overrides: {} })), /E_MANIFEST: engine\.overrides\.loops/);
  assert.throws(() => validateManifest(withEngine({ overrides: { loops: ENGINE_META.overrides.loops } })), /E_MANIFEST: engine\.overrides\.cache/);
  // An override key that belongs to another family is a mismatch, not a launch.
  assert.throws(() => validateManifest(withEngine({ overrides: { loops: 'other.loops', cache: 'other.cache' } })),
    /E_MANIFEST: engine\.overrides\.loops must belong to engine\.family/);
  // And the validated pair is what a launch gets.
  const store = new Store({ dir: tmp(), manifest: manifestFor([good]) });
  assert.deepStrictEqual(store.launchData(), { family: ENGINE_META.family, overrides: ENGINE_META.overrides });
});

test('manifest validation: path traversal, a missing build family and a bad hash are all refused', () => {
  const good = file(EXE, Buffer.from('x'), 'https://h');
  assert.ok(validateManifest(manifestFor([good])));
  assert.throws(() => validateManifest(manifestFor([good, { ...good, name: '../evil' }])), /unsafe/);
  assert.throws(() => validateManifest({ ...manifestFor([good]), engine: { ...manifestFor([good]).engine, family: '' } }), /E_MANIFEST/);
  assert.throws(() => validateManifest(manifestFor([{ ...good, sha256: 'zz' }])), /sha256|E_MANIFEST/);
});

test('the engine pack a BACKEND needs is named per backend, and a CPU plan may reuse a GPU pack', () => {
  const exe = file(EXE, Buffer.from('x'), 'https://h');
  const store = new Store({
    dir: tmp(),
    manifest: {
      engine: {
        version: '1.0.0', build: '43e865ec059a', family: ENGINE_META.family, overrides: { ...ENGINE_META.overrides },
        platforms: { [packKey('vulkan')]: { files: [exe] } },
      },
      models: {},
    },
  });
  assert.strictEqual(store.variant('vulkan'), packKey('vulkan'));
  assert.strictEqual(store.variant('cpu'), packKey('vulkan'), 'the CPU floor runs the same binary with the devices hidden');
  assert.throws(() => store.variant('cuda'), /E_PACK: no engine files for/);
  // Nothing in a pack key names a backend: it is an id.
  assert.match(store.variant('vulkan'), new RegExp(`-${IDS.backend.vulkan}$`));
  assert.ok(!/cuda|vulkan|metal|rocm/.test(store.variant('vulkan')), 'a backend name reached a folder name');
});

test('engine pack installs atomically; a tampered binary is refused; the wrong commit is refused', async () => {
  const exe = Buffer.from('#!/usr/bin/env node\nprocess.stderr.write("version: 1 (43e865e)\\n")\n');
  const lib = crypto.randomBytes(2000);
  const { srv, base } = await serve({ [EXE]: exe, 'libggml.so': lib });
  const dir = tmp();
  try {
    const manifest = manifestFor([file(EXE, exe, base), file('libggml.so', lib, base)]);
    const store = new Store({ dir, manifest, allowInsecureHttp: true });
    const info = await store.ensureEngine('cuda');
    assert.ok(info.installed && !fs.existsSync(`${info.dir}.tmp`), 'installation is atomic: .tmp then rename');
    if (process.platform !== 'win32') {
      await store.verifyEngine('cuda'); // hash ok + --version reports the pinned commit
      const wrong = new Store({ dir, manifest: { ...manifest, engine: { ...manifest.engine, build: 'deadbeefcafe' } }, allowInsecureHttp: true });
      await assert.rejects(wrong.ensureEngine('cuda').then(() => wrong.verifyEngine('cuda')), /E_ENGINE_BUILD|E_NOT_INSTALLED/);
      fs.writeFileSync(info.exe, Buffer.alloc(exe.length, 65)); // same size, different bytes
      await assert.rejects(store.verifyEngine('cuda'), /E_ENGINE_HASH/);
    }
  } finally { srv.close(); }
});

test('a model install writes its marker; inventory maps opaque manifest ids back to settings', async () => {
  const model = crypto.randomBytes(40000);
  const exe = Buffer.from('x');
  const { srv, base } = await serve({ 'm1-q2.bin': model, [EXE]: exe });
  try {
    const store = new Store({
      dir: tmp(),
      manifest: manifestFor([file(EXE, exe, base)], { models: { [modelKey('q2')]: file('m1-q2.bin', model, base) } }),
      allowInsecureHttp: true,
    });
    assert.strictEqual(store.inventory().q2.installed, false);
    assert.strictEqual(store.inventory().q2.bytes, model.length);
    assert.ok(!/\.gguf$/.test(store.inventory().q2.name), 'a model file must not carry a format-name extension');
    const installed = await store.ensureModel('q2');
    assert.ok(store.inventory().q2.installed && fs.existsSync(installed));
    assert.ok(fs.existsSync(`${installed}.ok`), 'the marker is what makes an install trusted');
  } finally { srv.close(); }
});
