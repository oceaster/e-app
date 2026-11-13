'use strict';
// THE NARROW FILE BRIDGE THAT MAKES A REBOOT RESUMABLE.
//
// The e-server page runs in a cross-origin frame. After the machine restarts it cannot reopen
// the file a person chose (the File System Access API is not available there), so a resumable
// upload would always need the file picked again. This module gives the page exactly one
// capability it cannot have itself: read a file the person picked, or write a file the person
// chose to save, through an opaque token. It never accepts a path from the page.
//
// THE RULES, in order:
//   * every handler is reachable only from the configured e-server origin (`serverFrame`);
//   * a file enters only through a NATIVE dialog, never a string;
//   * the page receives a random token, never a path;
//   * a read token can read that one file, in chunks, and stops if size/mtime changed;
//   * a write token can write that one destination, at the recorded offset;
//   * tokens persist in userData (0600) so a restart can resume, and are bounded in age.
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const MAX_CHUNK = 32 * 1024 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

class MediaBridge {
  constructor({ app, dialog, getWindow, getOrigin, serverFrame, now }) {
    this.app = app;
    this.dialog = dialog;
    this.getWindow = getWindow;
    this.getOrigin = getOrigin;
    this.serverFrame = serverFrame;
    this.now = now || (() => Date.now());
    this.file = path.join(app.getPath('userData'), 'media-bridge.json');
    this.records = this._load();
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const records = data && data.records && typeof data.records === 'object' ? data.records : {};
      const live = {};
      for (const [token, record] of Object.entries(records)) {
        if (!record || typeof record.path !== 'string' || !['read', 'write'].includes(record.mode)) continue;
        if (!Number.isFinite(record.created) || this.now() - record.created > MAX_AGE_MS) continue;
        live[token] = record;
      }
      return live;
    } catch {
      return {};
    }
  }

  _save() {
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ records: this.records }), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  _record(token) {
    const record = this.records[String(token || '')];
    if (!record) throw Error('That file is no longer available. Choose it again.');
    return record;
  }

  _register(file, mode) {
    const token = crypto.randomBytes(24).toString('hex');
    const stat = fs.statSync(file);
    this.records[token] = {
      path: file, mode, size: stat.size, mtimeMs: stat.mtimeMs, created: this.now(),
    };
    this._save();
    return { token, name: path.basename(file), size: stat.size, modified: stat.mtimeMs };
  }

  async pick() {
    if (!this.getOrigin()) throw Error('Connect to your e-server first.');
    const answer = await this.dialog.showOpenDialog(this.getWindow() || undefined, {
      title: 'Choose files to upload to Media',
      properties: ['openFile', 'multiSelections'],
    });
    if (answer.canceled) return { files: [] };
    return { files: (answer.filePaths || []).map((file) => this._register(file, 'read')) };
  }

  async save(name, size) {
    if (!this.getOrigin()) throw Error('Connect to your e-server first.');
    const safe = String(name || 'media').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180) || 'media';
    const answer = await this.dialog.showSaveDialog(this.getWindow() || undefined, {
      title: 'Save from Media',
      defaultPath: path.join(this.app.getPath('downloads'), safe),
    });
    if (answer.canceled || !answer.filePath) return null;
    let existing = 0;
    try {
      const stat = fs.statSync(answer.filePath);
      if (stat.isFile()) existing = stat.size;
    } catch {}
    const token = crypto.randomBytes(24).toString('hex');
    this.records[token] = {
      path: answer.filePath, mode: 'write', size: Number(size) || 0,
      mtimeMs: 0, created: this.now(), existing,
    };
    this._save();
    return { token, name: path.basename(answer.filePath), existing };
  }

  async read(token, offset, length) {
    const record = this._record(token);
    if (record.mode !== 'read') throw Error('That file is not an upload source.');
    const start = Number(offset);
    const want = Number(length);
    if (!Number.isInteger(start) || !Number.isInteger(want) || start < 0 || want < 1 || want > MAX_CHUNK) {
      throw Error('That read is out of range.');
    }
    const stat = await fsp.stat(record.path);
    if (stat.size !== record.size || stat.mtimeMs !== record.mtimeMs) {
      throw Error('The file changed since it was chosen. Choose it again to resume.');
    }
    if (start + want > record.size) throw Error('That read runs past the end of the file.');
    const handle = await fsp.open(record.path, 'r');
    try {
      const data = Buffer.alloc(want);
      const { bytesRead } = await handle.read(data, 0, want, start);
      return new Uint8Array(data.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async write(token, offset, data) {
    const record = this._record(token);
    if (record.mode !== 'write') throw Error('That file is not a download destination.');
    const start = Number(offset);
    if (!Number.isInteger(start) || start < 0) throw Error('That write offset is out of range.');
    const buffer = Buffer.from(data || []);
    if (!buffer.length || buffer.length > MAX_CHUNK) throw Error('That write is out of range.');
    const flags = start === 0 ? 'w' : 'r+';
    const handle = await fsp.open(record.path, flags);
    try {
      await handle.write(buffer, 0, buffer.length, start);
    } finally {
      await handle.close();
    }
    record.existing = Math.max(Number(record.existing) || 0, start + buffer.length);
    this._save();
    return { written: buffer.length, size: record.existing };
  }

  pending() {
    return Object.entries(this.records).flatMap(([token, record]) => {
      let stat;
      try { stat = fs.statSync(record.path); } catch { return []; }
      return [{
        token, mode: record.mode, name: path.basename(record.path), size: record.size,
        existing: record.mode === 'write' ? stat.size : undefined,
        modified: record.mtimeMs,
      }];
    });
  }

  release(token) {
    delete this.records[String(token || '')];
    this._save();
    return { released: true };
  }

  install(ipcMain) {
    ipcMain.on('media:origin', (event) => {
      event.returnValue = this.getOrigin() || '';
    });
    const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => {
      this.serverFrame(event);
      return action(...args);
    });
    handle('media:pick', () => this.pick());
    handle('media:save', (name, size) => this.save(name, size));
    handle('media:read', (token, offset, length) => this.read(token, offset, length));
    handle('media:write', (token, offset, data) => this.write(token, offset, data));
    handle('media:pending', () => this.pending());
    handle('media:release', (token) => this.release(token));
  }
}

module.exports = { MediaBridge, MAX_CHUNK };
