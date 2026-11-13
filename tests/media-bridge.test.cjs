'use strict';
// The file bridge: opaque tokens, native-choice-only paths, origin-locked handlers, and a
// journal that a second MediaBridge (a restart) can read.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { MediaBridge } = require('../desktop/media-bridge.cjs');

function machine(files, destination) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-bridge-'));
  const app = { getPath: (name) => name === 'userData' ? root : root };
  const dialog = {
    showOpenDialog: async () => ({ canceled: false, filePaths: files }),
    showSaveDialog: async () => ({ canceled: false, filePath: destination }),
  };
  const handlers = {};
  const ipcMain = {
    handle: (channel, fn) => { handlers[channel] = fn; },
    on: (channel, fn) => { handlers[channel] = fn; },
  };
  const allowed = 'https://easter-server.instance.easter.company';
  const serverFrame = (event) => {
    if (!event || !event.senderFrame || event.senderFrame.url !== allowed + '/x') {
      throw Error('This request did not come from your e-server.');
    }
  };
  const bridge = new MediaBridge({ app, dialog, getWindow: () => null,
    getOrigin: () => allowed, serverFrame });
  bridge.install(ipcMain);
  const frame = { senderFrame: { url: allowed + '/x' } };
  return { bridge, handlers, frame, allowed, root };
}

test('picking returns opaque tokens and never a filesystem path', async () => {
  const source = path.join(os.tmpdir(), 'media-source-' + process.pid + '.txt');
  fs.writeFileSync(source, 'hello media');
  const { handlers, frame } = machine([source], '/tmp/out');
  const answer = await handlers['media:pick'](frame);
  assert.equal(answer.files.length, 1);
  assert.equal(answer.files[0].name, path.basename(source));
  assert.equal(answer.files[0].size, 11);
  assert.match(answer.files[0].token, /^[0-9a-f]{48}$/);
  assert.equal(JSON.stringify(answer).includes(source), false);
});

test('a read token reads only its own file, in bounded chunks', async () => {
  const source = path.join(os.tmpdir(), 'media-read-' + process.pid + '.txt');
  fs.writeFileSync(source, '0123456789');
  const { handlers, frame } = machine([source], '/tmp/out');
  const token = (await handlers['media:pick'](frame)).files[0].token;
  const bytes = await handlers['media:read'](frame, token, 5, 3);
  assert.deepEqual(Array.from(bytes), [53, 54, 55]);
  await assert.rejects(() => handlers['media:read'](frame, token, 8, 5), /past the end/);
  assert.throws(() => handlers['media:read']({ senderFrame: { url: 'https://elsewhere/x' } },
    token, 0, 1), /did not come from/);
});

test('a file that changed after choosing is refused rather than mixed', async () => {
  const source = path.join(os.tmpdir(), 'media-changed-' + process.pid + '.txt');
  fs.writeFileSync(source, 'one');
  const { handlers, frame } = machine([source], '/tmp/out');
  const token = (await handlers['media:pick'](frame)).files[0].token;
  fs.writeFileSync(source, 'one and a half');
  await assert.rejects(() => handlers['media:read'](frame, token, 0, 3), /file changed/);
});

test('a save token writes at the requested offset, and a restart still lists it', async () => {
  const destination = path.join(os.tmpdir(), 'media-out-' + process.pid + '.bin');
  try { fs.unlinkSync(destination); } catch {}
  const { bridge, handlers, frame, root, allowed } = machine([], destination);
  const saved = await handlers['media:save'](frame, 'film.mp4', 10);
  assert.match(saved.token, /^[0-9a-f]{48}$/);
  await handlers['media:write'](frame, saved.token, 0, new Uint8Array([1, 2, 3, 4, 5]));
  await handlers['media:write'](frame, saved.token, 5, new Uint8Array([6, 7, 8, 9, 10]));
  assert.deepEqual(Array.from(fs.readFileSync(destination)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // The second object is the restart: the token and its destination are still there.
  const again = new MediaBridge({ app: { getPath: () => root }, dialog: {},
    getWindow: () => null, getOrigin: () => allowed,
    serverFrame: () => {} });
  const pending = again.pending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].mode, 'write');
  assert.equal(pending[0].existing, 10);
  assert.equal(JSON.stringify(pending).includes(destination), false);
});

test('a token cannot be used for the other direction', async () => {
  const source = path.join(os.tmpdir(), 'media-dir-' + process.pid + '.txt');
  fs.writeFileSync(source, 'abc');
  const { handlers, frame } = machine([source], '/tmp/out');
  const token = (await handlers['media:pick'](frame)).files[0].token;
  await assert.rejects(() => handlers['media:write'](frame, token, 0, new Uint8Array([1])),
    /not a download destination/);
});
