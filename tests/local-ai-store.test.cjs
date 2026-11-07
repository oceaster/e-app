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

const { downloadVerified } = require('../desktop/local-ai/downloader.cjs');
const { Store, validateManifest } = require('../desktop/local-ai/store.cjs');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lai-store-'));
const EXE = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
const PREFIX = `${process.platform}-${process.arch}`;

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
const manifestFor = (files, extra = {}, prefix = PREFIX) => ({
  engine: { version: '1.0.0', llamaCommit: '43e865ec059a', features: ['dory'], platforms: { [`${prefix}-cuda`]: { files } } },
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
    await assert.rejects(downloadVerified({ url: `${base}/m`, dest, sha256: sha(Buffer.from('other')), size: data.length, allowInsecure: true }), /verification failed/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
  } finally { srv.close(); }
});

test('https only, unless the caller explicitly allows a local http source', async () => {
  await assert.rejects(downloadVerified({ url: 'http://example.com/x', dest: path.join(tmp(), 'x'), sha256: 'a'.repeat(64), size: 1 }), /non-https/);
});

test('manifest validation: path traversal, a missing dory feature and a bad hash are all refused', () => {
  const good = file(EXE, Buffer.from('x'), 'https://h');
  assert.ok(validateManifest(manifestFor([good])));
  assert.throws(() => validateManifest(manifestFor([good, { ...good, name: '../evil' }])), /unsafe/);
  assert.throws(() => validateManifest({ ...manifestFor([good]), engine: { ...manifestFor([good]).engine, features: [] } }), /dory/);
  assert.throws(() => validateManifest(manifestFor([{ ...good, sha256: 'zz' }])), /sha256/);
});

test('the engine pack a BACKEND needs is named per backend, and a CPU plan may reuse a GPU pack', () => {
  const exe = file(EXE, Buffer.from('x'), 'https://h');
  const store = new Store({
    dir: tmp(),
    manifest: {
      engine: {
        version: '1.0.0', llamaCommit: '43e865ec059a', features: ['dory'],
        platforms: { [`${PREFIX}-vulkan`]: { files: [exe] } },
      },
      models: {},
    },
  });
  assert.strictEqual(store.variant('vulkan'), `${PREFIX}-vulkan`);
  assert.strictEqual(store.variant('cpu'), `${PREFIX}-vulkan`, 'the CPU floor runs the same binary with the devices hidden');
  assert.throws(() => store.variant('cuda'), /no engine pack for .*-cuda/);
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
      const wrong = new Store({ dir, manifest: { ...manifest, engine: { ...manifest.engine, llamaCommit: 'deadbeefcafe' } }, allowInsecureHttp: true });
      await assert.rejects(wrong.ensureEngine('cuda').then(() => wrong.verifyEngine('cuda')), /pinned Dory build|not installed/);
      fs.writeFileSync(info.exe, Buffer.alloc(exe.length, 65)); // same size, different bytes
      await assert.rejects(store.verifyEngine('cuda'), /hash mismatch/);
    }
  } finally { srv.close(); }
});

test('a model install writes its marker, and inventory reports installed + manifest sizes', async () => {
  const model = crypto.randomBytes(40000);
  const exe = Buffer.from('x');
  const { srv, base } = await serve({ 'm.gguf': model, [EXE]: exe });
  try {
    const store = new Store({ dir: tmp(), manifest: manifestFor([file(EXE, exe, base)], { models: { Q8_0: file('m.gguf', model, base) } }), allowInsecureHttp: true });
    assert.strictEqual(store.inventory().Q8_0.installed, false);
    assert.strictEqual(store.inventory().Q8_0.bytes, model.length);
    const installed = await store.ensureModel('Q8_0');
    assert.ok(store.inventory().Q8_0.installed && fs.existsSync(installed));
    assert.ok(fs.existsSync(`${installed}.ok`), 'the marker is what makes an install trusted');
  } finally { srv.close(); }
});
