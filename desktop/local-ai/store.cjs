'use strict';
/**
 * Engine packs + models live in userData, never in the app bundle (the updater refuses >200 MB).
 * Everything is described by a manifest {engine:{version,llamaCommit,features,platforms},models}.
 * Files are individually sha256-pinned, so no archive extraction is needed.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { downloadVerified, hashFile } = require('./downloader.cjs');

const SAFE_NAME = /^[A-Za-z0-9][\w.\-]*$/;
/** The build family the pinned engine must declare and carry (internal: never printed to a person). */
const ENGINE_FEATURE = 'dory';
const isWin = process.platform === 'win32';
const EXE = isWin ? 'llama-server.exe' : 'llama-server';

function validateManifest(m, { allowInsecure = false } = {}) {
  const bad = (x) => { throw new Error(`E_MANIFEST: ${x}`); };
  const file = (f, where) => {
    if (!f || !SAFE_NAME.test(f.name || '')) bad(`${where}: unsafe file name`);
    if (!/^[0-9a-f]{64}$/i.test(f.sha256 || '')) bad(`${where}: sha256`);
    if (!Number.isInteger(f.size) || f.size <= 0) bad(`${where}: size`);
    let u; try { u = new URL(f.url); } catch { bad(`${where}: url`); }
    if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) bad(`${where}: url must be https`);
  };
  if (!m || !m.engine) bad('engine');
  const e = m.engine;
  if (!/^[\w.\-]+$/.test(e.version || '')) bad('engine.version');
  if (!/^[0-9a-f]{7,40}$/i.test(e.llamaCommit || '')) bad('engine.llamaCommit');
  // The one engine-protocol word we cannot rename: the manifest must declare which build family it
  // carries, and the binary's own `--version` is checked against it. Nothing a person sees prints it.
  if (!Array.isArray(e.features) || !e.features.includes(ENGINE_FEATURE)) bad('engine build family');
  for (const [k, pack] of Object.entries(e.platforms || {})) {
    if (!Array.isArray(pack.files) || !pack.files.some((f) => f.name === EXE || f.name === 'llama-server' || f.name === 'llama-server.exe')) bad(`platform ${k}: no engine binary`);
    pack.files.forEach((f) => file(f, `platform ${k}`));
  }
  for (const [q, f] of Object.entries(m.models || {})) file(f, `model ${q}`);
  return m;
}

class Store extends EventEmitter {
  /** @param {{dir:string, manifest:object, allowInsecureHttp?:boolean}} o */
  constructor({ dir, manifest, allowInsecureHttp = false }) {
    super();
    this.dir = dir;
    this.allowInsecure = allowInsecureHttp;
    this.manifest = validateManifest(manifest, { allowInsecure: allowInsecureHttp });
  }

  /**
   * The engine pack a backend needs: `<platform>-<arch>-<backend>` for cuda/vulkan/metal/rocm, or
   * `-cpu` for the floor. A CPU plan may run any GPU pack with the devices hidden (it is the same
   * binary), so the CPU variant falls back to whichever pack this platform publishes.
   */
  variant(backend) {
    const prefix = `${process.platform}-${process.arch}`;
    const platforms = this.manifest.engine.platforms || {};
    const want = `${prefix}-${backend}`;
    if (platforms[want]) return want;
    if (backend === 'cpu') {
      const any = ['cpu', 'cuda', 'vulkan', 'metal', 'rocm'].find((name) => platforms[`${prefix}-${name}`]);
      if (any) return `${prefix}-${any}`;
    }
    throw new Error(`E_PACK: no engine files for ${want}`);
  }

  engineInfo(backend) {
    const variant = this.variant(backend);
    const pack = this.manifest.engine.platforms[variant];
    const dir = path.join(this.dir, 'engine', this.manifest.engine.version, variant);
    const exeFile = pack.files.find((f) => f.name.startsWith('llama-server'));
    const installed = pack.files.every((f) => { try { return fs.statSync(path.join(dir, f.name)).size === f.size; } catch { return false; } })
      && fs.existsSync(path.join(dir, '.installed.json'));
    return { variant, dir, pack, exe: path.join(dir, exeFile.name), exeFile, installed, bytes: pack.files.reduce((a, f) => a + f.size, 0) };
  }

  async ensureEngine(backend, { signal } = {}) {
    const info = this.engineInfo(backend);
    if (info.installed) return info;
    const tmp = `${info.dir}.tmp`;
    fs.mkdirSync(tmp, { recursive: true });
    let base = 0;
    for (const f of info.pack.files) {
      await downloadVerified({ url: f.url, dest: path.join(tmp, f.name), sha256: f.sha256, size: f.size, allowInsecure: this.allowInsecure, signal,
        onProgress: (p) => this.emit('progress', { kind: 'engine', name: f.name, received: base + p.received, total: info.bytes }) });
      base += f.size;
      if (!isWin && (f.exec || f.name.startsWith('llama-server'))) fs.chmodSync(path.join(tmp, f.name), 0o755);
    }
    fs.writeFileSync(path.join(tmp, '.installed.json'), JSON.stringify({ version: this.manifest.engine.version, files: info.pack.files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }));
    fs.rmSync(info.dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(info.dir), { recursive: true });
    fs.renameSync(tmp, info.dir); // atomic install
    return this.engineInfo(backend);
  }

  /** Refuse a binary whose hash doesn't match the manifest, and one that doesn't carry Dory. */
  async verifyEngine(backend) {
    const info = this.engineInfo(backend);
    if (!info.installed) throw new Error('E_NOT_INSTALLED: the local engine is not installed');
    const got = await hashFile(info.exe);
    if (got !== info.exeFile.sha256.toLowerCase()) throw new Error('E_ENGINE_HASH: the installed engine does not match its manifest entry');
    await this.probeVersion(info.exe);
    return info;
  }

  /** llama.cpp prints "version: N (<commit>)". It must contain the pinned Dory commit. */
  probeVersion(exe) {
    const want = this.manifest.engine.llamaCommit.slice(0, 7).toLowerCase();
    return new Promise((resolve, reject) => {
      execFile(exe, ['--version'], { cwd: path.dirname(exe), timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.toLowerCase();
        if (out.includes(want)) return resolve(out.trim());
        return reject(new Error(`E_ENGINE_BUILD: the installed engine is not the pinned build (expected ${want})`));
      });
    });
  }

  modelPath(quant) { return path.join(this.dir, 'models', this.manifest.models[quant].name); }

  modelInstalled(quant) {
    const f = this.manifest.models[quant];
    if (!f) return false;
    const p = this.modelPath(quant);
    try {
      const st = fs.statSync(p);
      const mark = JSON.parse(fs.readFileSync(`${p}.ok`, 'utf8'));
      return st.size === f.size && mark.size === f.size && mark.mtimeMs === st.mtimeMs && mark.sha256 === f.sha256.toLowerCase();
    } catch { return false; }
  }

  async ensureModel(quant, { signal } = {}) {
    const f = this.manifest.models[quant];
    if (!f) throw new Error(`E_MODEL: nothing in the manifest for ${quant}`);
    const p = this.modelPath(quant);
    if (this.modelInstalled(quant)) return p;
    await downloadVerified({ url: f.url, dest: p, sha256: f.sha256, size: f.size, allowInsecure: this.allowInsecure, signal,
      onProgress: (x) => this.emit('progress', { kind: 'model', name: f.name, received: x.received, total: x.total }) });
    const st = fs.statSync(p);
    fs.writeFileSync(`${p}.ok`, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256.toLowerCase() }));
    return p;
  }

  /** quant -> { bytes, name, installed, path }  (sizes come from the manifest even before download) */
  inventory() {
    const inv = {};
    for (const [q, f] of Object.entries(this.manifest.models || {})) inv[q] = { bytes: f.size, name: f.name, installed: this.modelInstalled(q), path: this.modelPath(q) };
    return inv;
  }
}

module.exports = { Store, validateManifest };
