'use strict';
/**
 * Engine packs + models live in userData, never in the app bundle (the updater refuses >200 MB).
 * Everything is described by a manifest
 *   {engine:{version,build,family,overrides:{loops,cache},platforms},models}
 * — and `family`/`overrides` are how the engine's own metadata reaches a launch WITHOUT this bundle
 * ever containing it: they are downloaded with the manifest and passed through as data.
 * Files are individually sha256-pinned, so no archive extraction is needed.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const { downloadVerified, hashFile } = require('./downloader.cjs');

const DEFAULT_IDS = require('./config.cjs').ids;
const SAFE_NAME = /^[A-Za-z0-9][\w.\-]*$/;
/** The build family the pinned engine must declare and carry (internal: never printed to a person). */
// Tokens the manifest must supply for the engine's own metadata. Nothing here names a family.
const SAFE_TOKEN = /^[A-Za-z0-9_][\w.\-]{0,63}$/;
const isWin = process.platform === 'win32';
// The installed engine binary's own name is an ID (see config.ids.binary): a person browsing their
// own application-data folder reads `en`, not the engine's name.
const IDS = DEFAULT_IDS;
const EXE = isWin ? IDS.binary.win32 : IDS.binary.unix;

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
  if (!/^[0-9a-f]{7,40}$/i.test(e.build || '')) bad('engine.build id');
  // THE TWO FIELDS THAT CARRY THE ENGINE'S METADATA, refused BY NAME when absent: a launch must never
  // fall back to a hard-coded family or an empty override.
  //   engine.family               — the build family this pack belongs to
  //   engine.overrides.loops      — the metadata key for the model's loop count
  //   engine.overrides.cache      — the metadata key for its per-loop KV layout
  if (!SAFE_TOKEN.test(e.family || '')) bad('engine.family');
  const overrides = e.overrides || {};
  for (const field of ['loops', 'cache']) {
    if (!SAFE_TOKEN.test(overrides[field] || '')) bad(`engine.overrides.${field}`);
    if (overrides[field].slice(0, e.family.length + 1) !== `${e.family}.`) bad(`engine.overrides.${field} must belong to engine.family`);
  }
  for (const [k, pack] of Object.entries(e.platforms || {})) {
    if (!Array.isArray(pack.files) || !pack.files.some((f) => f.name === EXE)) bad(`platform ${k}: no engine binary`);
    pack.files.forEach((f) => file(f, `platform ${k}`));
  }
  for (const [q, f] of Object.entries(m.models || {})) file(f, `model ${q}`);
  return m;
}

class Store extends EventEmitter {
  /** @param {{dir:string, manifest:object, allowInsecureHttp?:boolean}} o */
  constructor({ dir, manifest, allowInsecureHttp = false, ids = IDS }) {
    super();
    this.dir = dir;
    this.allowInsecure = allowInsecureHttp;
    this.ids = ids;
    this.manifest = validateManifest(manifest, { allowInsecure: allowInsecureHttp });
  }

  /** The manifest key for one weight build: `model-<id>-<buildid>`, opaque by construction. */
  modelKey(quant) {
    return `${this.ids.model}-${quant}`;
  }

  /**
   * The engine pack a backend needs: `<platform>-<arch>-<backend>` for cuda/vulkan/metal/rocm, or
   * `-cpu` for the floor. A CPU plan may run any GPU pack with the devices hidden (it is the same
   * binary), so the CPU variant falls back to whichever pack this platform publishes.
   */
  variant(backend) {
    const prefix = `${process.platform}-${process.arch}`;
    const platforms = this.manifest.engine.platforms || {};
    const code = (this.ids.backend || {})[backend] || backend;
    const want = `${prefix}-${code}`;
    if (platforms[want]) return want;
    if (backend === 'cpu') {
      const any = Object.values(this.ids.backend || {}).find((code) => platforms[`${prefix}-${code}`]);
      if (any) return `${prefix}-${any}`;
    }
    throw new Error(`E_PACK: no engine files for ${want}`);
  }

  engineInfo(backend) {
    const variant = this.variant(backend);
    const pack = this.manifest.engine.platforms[variant];
    const dir = path.join(this.dir, 'e', this.manifest.engine.version, variant);
    const exeFile = pack.files.find((f) => f.name === EXE) || pack.files.find((f) => f.name.startsWith(this.ids.binary.unix));
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
      if (!isWin && (f.exec || f.name === EXE)) fs.chmodSync(path.join(tmp, f.name), 0o755);
    }
    fs.writeFileSync(path.join(tmp, '.installed.json'), JSON.stringify({ version: this.manifest.engine.version, files: info.pack.files.map(({ name, size, sha256 }) => ({ name, size, sha256 })) }));
    fs.rmSync(info.dir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(info.dir), { recursive: true });
    fs.renameSync(tmp, info.dir); // atomic install
    return this.engineInfo(backend);
  }

  /** Refuse a binary whose hash does not match the manifest, and one that is not the pinned build. */
  async verifyEngine(backend) {
    const info = this.engineInfo(backend);
    if (!info.installed) throw new Error('E_NOT_INSTALLED: the local engine is not installed');
    const got = await hashFile(info.exe);
    if (got !== info.exeFile.sha256.toLowerCase()) throw new Error('E_ENGINE_HASH: the installed engine does not match its manifest entry');
    await this.probeVersion(info.exe);
    return info;
  }

  /** The engine prints "version: N (<build id>)". It must contain the manifest's pinned build id. */
  probeVersion(exe) {
    const want = this.manifest.engine.build.slice(0, 7).toLowerCase();
    return new Promise((resolve, reject) => {
      execFile(exe, ['--version'], { cwd: path.dirname(exe), timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.toLowerCase();
        if (out.includes(want)) return resolve(out.trim());
        return reject(new Error(`E_ENGINE_BUILD: the installed engine is not the pinned build (expected ${want})`));
      });
    });
  }

  /**
   * What a launch needs from the manifest, already validated: the build family and the two metadata
   * keys. This is the ONLY way they reach the engine, so the bundle never carries them itself.
   */
  launchData() {
    const engine = this.manifest.engine;
    return { family: engine.family, overrides: { loops: engine.overrides.loops, cache: engine.overrides.cache } };
  }

  modelPath(quant) {
    const model = this.manifest.models[this.modelKey(quant)];
    if (!model) throw new Error('E_MODEL: this build has no model for that setting');
    return path.join(this.dir, 'm', model.name);
  }

  modelInstalled(quant) {
    const f = this.manifest.models[this.modelKey(quant)];
    if (!f) return false;
    const p = this.modelPath(quant);
    try {
      const st = fs.statSync(p);
      const mark = JSON.parse(fs.readFileSync(`${p}.ok`, 'utf8'));
      return st.size === f.size && mark.size === f.size && mark.mtimeMs === st.mtimeMs && mark.sha256 === f.sha256.toLowerCase();
    } catch { return false; }
  }

  async ensureModel(quant, { signal } = {}) {
    const f = this.manifest.models[this.modelKey(quant)];
    if (!f) throw new Error('E_MODEL: this build has no model for that setting');
    const p = this.modelPath(quant);
    if (this.modelInstalled(quant)) return p;
    await downloadVerified({ url: f.url, dest: p, sha256: f.sha256, size: f.size, allowInsecure: this.allowInsecure, signal,
      onProgress: (x) => this.emit('progress', { kind: 'model', name: f.name, received: x.received, total: x.total }) });
    const st = fs.statSync(p);
    fs.writeFileSync(`${p}.ok`, JSON.stringify({ size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256.toLowerCase() }));
    return p;
  }

  /** quant -> { bytes, name, installed, path }  (sizes come from the manifest even before download) */
  /**
   * quant -> { bytes, name, installed, path }. The MANIFEST is keyed by opaque ids; the planner and
   * the config speak quant names. This is the one place the mapping happens, inside the bundle.
   */
  inventory() {
    const inv = {};
    for (const [key, f] of Object.entries(this.manifest.models || {})) {
      // `model-m1-q2` -> the build id `q2`; anything that is not ours is left alone.
      const quant = key.startsWith(`${this.ids.model}-`) ? key.slice(this.ids.model.length + 1) : key;
      inv[quant] = { bytes: f.size, name: f.name, installed: this.modelInstalled(quant), path: path.join(this.dir, 'm', f.name) };
    }
    return inv;
  }
}

module.exports = { Store, validateManifest };
