'use strict';
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildServerArgs, buildEnv } = require('./planner.cjs');
const proc = require('./proc.cjs');

const PRIORITY = { normal: os.constants.priority.PRIORITY_NORMAL, below_normal: os.constants.priority.PRIORITY_BELOW_NORMAL, low: os.constants.priority.PRIORITY_LOW };

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function httpGet(url, { key, timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    const r = http.get(url, { timeout, headers: key ? { Authorization: `Bearer ${key}` } : {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', () => resolve({ status: 0, body: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: '' }); });
  });
}

const err = (kind, msg) => Object.assign(new Error(msg), { kind });

/** Owns one llama-server process (spawned by us, or adopted after a crash). */
class Runtime extends EventEmitter {
  /** @param {{pidFile?:string, logFile?:string, imageNames?:string[], vram?:()=>Promise<any[]>}} o */
  constructor(o = {}) {
    super();
    this.o = o;
    this.state = 'stopped'; // stopped | installing | starting | ready | error
    this.pid = null; this.child = null; this.plan = null; this.baseUrl = null; this.apiKey = null; this.error = null;
    this.head = []; this.tail = []; this.diag = {};
    this._cancelled = false; this._secret = null; this._watch = null;
    this._kvSummary = 0; this._kvBuffers = 0;
  }

  status() {
    return { state: this.state, tier: this.plan ? this.plan.tier : null, label: this.plan ? this.plan.label : null,
      baseUrl: this.state === 'ready' ? this.baseUrl : null, plan: this.plan, error: this.error };
  }

  setState(state, extra = {}) { this.state = state; Object.assign(this, extra); this.emit('status', this.status()); }

  _redact(s) {
    let out = String(s).replace(/(--api-key\s+)\S+/gi, '$1***');
    if (this._secret) out = out.split(this._secret).join('***');
    return out;
  }

  _log(line) {
    if (!this.o.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.o.logFile), { recursive: true });
      try { if (fs.statSync(this.o.logFile).size > 1 << 20) fs.renameSync(this.o.logFile, `${this.o.logFile}.1`); } catch { /* new file */ }
      fs.appendFileSync(this.o.logFile, `${new Date().toISOString()} ${line}\n`);
    } catch { /* logging must never break the engine */ }
  }

  _onLine(raw) {
    const line = this._redact(raw);
    if (this.head.length < 40) this.head.push(line);
    this.tail.push(line);
    if (this.tail.length > 40) this.tail.shift();
    this._log(line);
    // Measure the real KV size. Newer builds print a "kv_cache: size = X MiB" summary, older ones per-device buffers.
    let m = /kv_cache:\s*size\s*=\s*([\d.]+)\s*MiB/i.exec(line);
    if (m) this._kvSummary += Number(m[1]);
    m = /KV buffer size\s*=\s*([\d.]+)\s*MiB/i.exec(line);
    if (m) this._kvBuffers += Number(m[1]);
  }

  async _vram() { try { return this.o.vram ? await this.o.vram() : []; } catch { return []; } }

  /**
   * launch = { binaryPath, modelArgs, cfg, env? }. A crash/OOM at launch retries ONCE at half the context;
   * a port bind race retries on a fresh port; a timeout does not retry (it would just burn another timeout).
   */
  async start(plan, launch) {
    if (this.state === 'starting') throw new Error('Local AI is already starting');
    await this.stop();
    this._cancelled = false;
    this.setState('starting', { plan, error: null });
    this.diag = { vramBefore: await this._vram(), attempts: [] };

    const ctxs = [plan.ctx];
    const half = Math.floor(plan.ctx / 2 / 1024) * 1024;
    if (half >= 4096) ctxs.push(half);
    let last;
    outer: for (const ctx of ctxs) {
      const p = { ...plan, ctx };
      for (let bind = 0; bind < 3; bind++) {
        try {
          await this._launch(p, launch);
          this.diag.vramAfter = await this._vram();
          this._finishKv(p);
          this.setState('ready', { plan: this.plan });
          this._watchAdopted();
          return this.status();
        } catch (e) {
          last = e;
          this.diag.attempts.push({ ctx, kind: e.kind, message: e.message });
          await this._kill();
          if (this._cancelled || e.kind === 'timeout') break outer;
          if (e.kind === 'bind') continue; // TOCTOU on the port: try a new one
          break; // process died (OOM?): next ctx
        }
      }
    }
    this.setState(this._cancelled ? 'stopped' : 'error', { error: this._cancelled ? null : last.message });
    if (!this._cancelled) throw last;
    return this.status();
  }

  async _launch(plan, { binaryPath, modelArgs, cfg, env = {} }) {
    const port = await freePort();
    const apiKey = crypto.randomBytes(16).toString('hex');
    this._secret = apiKey;
    this.head = []; this.tail = []; this._kvSummary = 0; this._kvBuffers = 0;
    const args = [...modelArgs, ...buildServerArgs(plan, { port, apiKey, cfg })];
    this.diag.argv = this._redact([binaryPath, ...args].join(' '));

    const child = spawn(binaryPath, args, {
      cwd: path.dirname(binaryPath), env: { ...process.env, ...buildEnv(plan), ...env },
      windowsHide: true, detached: process.platform !== 'win32', // own process group on POSIX -> killable as a tree
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child; this.pid = child.pid;
    let exit = null;
    child.once('error', (e) => { exit = { code: e.message }; });
    child.once('exit', (code, sig) => {
      exit = { code: code === null ? sig : code };
      if (this.state === 'ready' && this.child === child) { this.child = null; this.pid = null; proc.removePid(this.o.pidFile); this.setState('error', { error: `llama-server exited unexpectedly (${exit.code})` }); }
    });
    const onData = (buf) => String(buf).split(/\r?\n/).filter(Boolean).forEach((l) => this._onLine(l));
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    try { os.setPriority(child.pid, PRIORITY[plan.priority] ?? PRIORITY.normal); } catch { /* best effort */ }
    if (this.o.pidFile) proc.writePid(this.o.pidFile, { pid: child.pid, port, apiKey, baseUrl: `http://127.0.0.1:${port}/v1`, plan, exe: path.basename(binaryPath), startedAt: Date.now() });

    const deadline = Date.now() + cfg.server.startTimeoutMs;
    while (Date.now() < deadline) {
      if (this._cancelled) throw err('cancelled', 'cancelled');
      if (exit) {
        const tail = this.tail.slice(-6).join(' | ');
        throw err(/bind|address already in use|EADDRINUSE/i.test(tail) ? 'bind' : 'exit', `llama-server exited (${exit.code}). ${tail}`);
      }
      if ((await httpGet(`http://127.0.0.1:${port}/health`)).status === 200) {
        this.baseUrl = `http://127.0.0.1:${port}/v1`; this.apiKey = apiKey;
        // Report the ctx the server ACTUALLY accepted (per slot), not what we asked for.
        const props = await httpGet(`http://127.0.0.1:${port}/props`, { key: apiKey });
        let nCtx = null;
        try { nCtx = JSON.parse(props.body).default_generation_settings.n_ctx; } catch { /* older builds */ }
        this.plan = { ...plan, effectiveCtx: nCtx || plan.ctx, effectiveCtxSource: nCtx ? 'server /props' : 'requested (server did not report)' };
        return;
      }
      await proc.sleep(cfg.server.healthIntervalMs);
    }
    throw err('timeout', 'timed out waiting for llama-server to become ready');
  }

  _finishKv(plan) {
    const measuredMiB = Math.round((this._kvSummary || this._kvBuffers) * 100) / 100;
    const estimatedMiB = plan.estimate ? Math.round(plan.estimate.kvGiB * 1024) : null;
    this.diag.kvCalibration = { measuredMiB, estimatedMiB, ratio: measuredMiB && estimatedMiB ? +(measuredMiB / estimatedMiB).toFixed(2) : null,
      note: 'measured = llama-server\'s own KV size line; if ratio is far from 1, fix config.arch' };
  }

  /** After a crash of the app, a server may still hold VRAM. Adopt a healthy one, kill anything else of ours. */
  async recover(cfg) {
    const rec = proc.readPid(this.o.pidFile);
    if (!rec) return { action: 'none' };
    if (!proc.isAlive(rec.pid)) { proc.removePid(this.o.pidFile); return { action: 'stale' }; }
    const img = (await proc.imageName(rec.pid) || '').toLowerCase();
    const names = this.o.imageNames || cfg.engine.imageNames;
    if (!names.some((n) => img.includes(n.toLowerCase()))) { proc.removePid(this.o.pidFile); return { action: 'pid-reused', image: img }; } // never kill a stranger
    const h = await httpGet(`http://127.0.0.1:${rec.port}/health`);
    if (h.status === 200) {
      this._secret = rec.apiKey;
      this.pid = rec.pid; this.child = null;
      this.setState('ready', { plan: rec.plan, baseUrl: rec.baseUrl, apiKey: rec.apiKey, error: null });
      this._watchAdopted();
      return { action: 'adopted', pid: rec.pid };
    }
    await proc.killTree(rec.pid);
    proc.removePid(this.o.pidFile);
    return { action: 'killed', pid: rec.pid };
  }

  _watchAdopted() {
    clearInterval(this._watch);
    if (this.child) return; // spawned by us: the 'exit' event covers it
    this._watch = setInterval(() => {
      if (this.state === 'ready' && !proc.isAlive(this.pid)) { clearInterval(this._watch); this.pid = null; proc.removePid(this.o.pidFile); this.setState('error', { error: 'adopted llama-server exited' }); }
    }, 2000);
    this._watch.unref();
  }

  async _kill() {
    clearInterval(this._watch);
    const pid = this.pid;
    this.child = null; this.pid = null;
    if (pid) await proc.killTree(pid);
    proc.removePid(this.o.pidFile);
  }

  async stop() {
    if (this.state === 'starting' || this.state === 'installing') this._cancelled = true;
    await this._kill();
    if (this.state !== 'stopped') this.setState('stopped', { baseUrl: null, apiKey: null, error: null });
  }

  /** Synchronous best-effort kill for process 'exit'. */
  killSync() { if (this.pid) proc.killTreeSync(this.pid); }

  diagnostics() {
    return { state: this.state, plan: this.plan, argv: this.diag.argv, vramBefore: this.diag.vramBefore, vramAfter: this.diag.vramAfter,
      kvCalibration: this.diag.kvCalibration, attempts: this.diag.attempts, first40: this.head, last40: this.tail, error: this.error };
  }
}

module.exports = { Runtime };
