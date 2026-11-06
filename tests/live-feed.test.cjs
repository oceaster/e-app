'use strict';
// THE PUBLISHER AGAINST A FAKE E-SERVER THAT SPEAKS THE DOCUMENTED PROTOCOL.
//
// The contract is e-server's `api/live_feeds.py` module docstring and its reference publisher
// `tests/live_feed_client.py`. This suite is the other side of that wire: a real WebSocket server
// on loopback, the real `desktop/live-feed.cjs`, and assertions about the BYTES on the socket — not
// about this module's own opinion of itself. `node --test tests/*.test.cjs` runs it; no Electron
// window and no camera are involved, because the device half is injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const {LiveFeed, feedUrl, MAX_FRAME_BYTES} = require('../desktop/live-feed.cjs');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('frame'), Buffer.from([0xff, 0xd9])]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, description, {tries = 120} = {}) {
 for (let attempt = 0; attempt < tries; attempt++) {
  const value = predicate();
  if (value) return value;
  await wait(25);
 }
 throw new Error('timed out waiting for ' + description);
}

/** One client socket, as the server sees it: the messages it sent, in order. */
class Connection {
 constructor(socket, seq) {
  this.socket = socket;
  this.seq = seq;
  this.messages = [];
  this.frames = [];
  this.closed = null;
  this.buffer = Buffer.alloc(0);
  socket.on('data', chunk => this._read(chunk));
  socket.on('close', () => { this.closed = this.closed || 1006; });
  socket.on('error', () => {});
 }

 get text() { return this.messages.filter(message => message.type); }
 get epoch() { return this.epochAssigned || ''; }
 get hello() { return this.messages.find(message => message.type === 'hello'); }
 get reports() { return this.messages.filter(message => message.type === 'report'); }

 send(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const header = body.length < 126 ? Buffer.from([0x81, body.length])
   : Buffer.from([0x81, 126, body.length >> 8 & 0xff, body.length & 0xff]);
  this.socket.write(Buffer.concat([header, body]));
 }

 closeWith(code, reason = '') {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  this.socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
  this.socket.end();
  this.closed = code;
 }

 _read(chunk) {
  this.buffer = Buffer.concat([this.buffer, chunk]);
  for (;;) {
   if (this.buffer.length < 2) return;
   const first = this.buffer[0], second = this.buffer[1];
   const opcode = first & 0x0f;
   const masked = (second & 0x80) !== 0;
   let length = second & 0x7f, offset = 2;
   if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
   else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
   const maskBytes = masked ? 4 : 0;
   if (this.buffer.length < offset + maskBytes + length) return;
   const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
   const payload = Buffer.from(this.buffer.subarray(offset + maskBytes, offset + maskBytes + length));
   this.buffer = this.buffer.subarray(offset + maskBytes + length);
   if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index & 3];
   if (opcode === 0x1) {
    try { this.messages.push(JSON.parse(payload.toString('utf8'))); } catch { this.messages.push({type: 'unparseable'}); }
   } else if (opcode === 0x2) {
    this.frames.push(payload);
   } else if (opcode === 0x8) {
    this.closed = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
   }
  }
 }
}

/**
 * A stand-in for e-server's publish socket. It answers what `api/live_feeds.py` answers — a
 * `welcome` whose epoch it mints per socket, an `ack` after a report — and it records every byte
 * this client sent, so an assertion can be about the wire rather than about the client's mood.
 */
async function fakeServer({onHello = null, onReport = null, frameCap = MAX_FRAME_BYTES, deviceName = 'Test device'} = {}) {
 const connections = [];
 let seq = 0;
 const server = http.createServer((request, response) => { response.writeHead(404); response.end('no such route'); });
 server.on('upgrade', (request, socket) => {
  if (String(request.url) !== '/api/live-feeds/publish') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(String(request.headers['sec-websocket-key']) + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const connection = new Connection(socket, ++seq);
  connections.push(connection);
  const original = connection._read.bind(connection);
  connection._read = chunk => {
   const before = connection.messages.length;
   original(chunk);
   for (const message of connection.messages.slice(before)) {
    if (message.type === 'hello') {
     const epoch = String(message.device_id || deviceName) + ':' + connection.seq;
     connection.epochAssigned = epoch;
     connection.send({type: 'welcome', epoch, feed_id: 'u3-' + String(message.device_id || 'x') + '-' + connection.seq,
                      account_id: '3', device_id: String(message.device_id || ''), max_frame_bytes: frameCap});
     if (onHello) onHello(message, connection);
    }
    if (message.type === 'report' && onReport) onReport(message, connection);
   }
  };
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const origin = 'http://127.0.0.1:' + server.address().port;
 return {
  origin,
  connections,
  get connection() { return connections[connections.length - 1]; },
  async close() { for (const connection of connections) { try { connection.socket.destroy(); } catch {} } server.closeAllConnections?.(); server.close(); },
 };
}

/** A publisher wired to a fake camera: `states` decides what the permission answer is. */
function publisher(server, {states = {camera: 'granted', microphone: 'granted'}, frames = true, log = [], status = [], grabDelayMs = 0} = {}) {
 return new LiveFeed({
  origin: server.origin,
  device: {id: 'device-7f3a', name: 'Desk machine'},
  capture: {
   begin: async () => ({...states}),
   grab: async () => { if (grabDelayMs) await wait(grabDelayMs); return frames ? JPEG : null; },
   end: () => {},
  },
  log: line => log.push(line),
  status: value => status.push(value),
 });
}

test('the publish URL is the server docstring\'s endpoint, and wss for an https origin', () => {
 assert.equal(feedUrl('https://home.example.test'), 'wss://home.example.test/api/live-feeds/publish');
 assert.equal(feedUrl('https://home.example.test:8443'), 'wss://home.example.test:8443/api/live-feeds/publish');
 assert.equal(feedUrl('http://127.0.0.1:8090'), 'ws://127.0.0.1:8090/api/live-feeds/publish');
});

test('hello is first, names a stable device id, and asks the server for an epoch', async () => {
 const server = await fakeServer();
 const log = [];
 const feed = publisher(server, {log});
 try {
  feed.start();
  const connection = await until(() => server.connection, 'the socket');
  await until(() => connection.hello, 'hello');
  assert.equal(connection.messages[0].type, 'hello', 'hello is the FIRST message on the socket');
  assert.equal(connection.hello.epoch, null, 'hello asks the server to name the epoch');
  assert.equal(connection.hello.device_id, 'device-7f3a');
  assert.equal(connection.hello.device_name, 'Desk machine');
  await until(() => connection.epoch, 'the welcome');
  assert.equal(connection.epoch, 'device-7f3a:1', 'the epoch is the server\'s, minted per socket');
  assert.match(log.join('\n'), /publishing u3-device-7f3a-1 as Desk machine \(epoch device-7f3a:1\)/);
 } finally { feed.stop(); await server.close(); }
});

test('pending is reported BEFORE the permission question is answered, then granted, every message epoch-bound', async () => {
 const server = await fakeServer();
 let release;
 const asked = new Promise(resolve => { release = resolve; });
 const feed = new LiveFeed({
  origin: server.origin,
  device: {id: 'device-1', name: 'Desk'},
  capture: {
   begin: async () => { await asked; return {camera: 'granted', microphone: 'granted'}; },
   grab: async () => JPEG,
   end: () => {},
  },
 });
 try {
  feed.start();
  const connection = await until(() => server.connection, 'the socket');
  await until(() => connection.reports.length >= 1, 'the pending report');
  assert.deepEqual(connection.reports[0], {type: 'report', epoch: connection.epochAssigned, camera: 'pending', microphone: 'pending'},
   'pending is the state the dashboard sees while the app is still waiting on the person');
  assert.equal(connection.reports.length, 1, 'nothing but pending has been reported before the answer');
  release();
  await until(() => connection.reports.length >= 2, 'the answered report');
  assert.deepEqual(connection.reports[1], {type: 'report', epoch: connection.epochAssigned, camera: 'granted', microphone: 'granted'});
  for (const message of connection.messages.slice(1)) {
   assert.equal(message.epoch, connection.epochAssigned, 'every message after hello carries this socket\'s epoch: ' + message.type);
  }
 } finally { feed.stop(); await server.close(); }
});

test('a denied camera is reported as denied — not as an error, and without a single frame', async () => {
 const server = await fakeServer();
 const log = [];
 const feed = publisher(server, {states: {camera: 'denied', microphone: 'denied'}, log});
 try {
  feed.start();
  const connection = await until(() => server.connection, 'the socket');
  await until(() => connection.reports.length >= 2, 'the denied report');
  assert.deepEqual(connection.reports[1], {type: 'report', epoch: connection.epochAssigned, camera: 'denied', microphone: 'denied'});
  await wait(200);
  assert.equal(connection.frames.length, 0, 'a denied camera publishes no frames');
  assert.equal(feed.status().state, 'connected', 'the connection stays up: recording is unconditional while connected');
  assert.equal(feed.status().camera, 'denied');
  assert.match(log.join('\n'), /not capturing: camera is denied/);
 } finally { feed.stop(); await server.close(); }
});

test('permission granted with no device is its own state, never a denial', async () => {
 const server = await fakeServer();
 const feed = publisher(server, {states: {camera: 'granted-no-device', microphone: 'granted'}});
 try {
  feed.start();
  const connection = await until(() => server.connection, 'the socket');
  await until(() => connection.reports.length >= 2, 'the no-device report');
  assert.equal(connection.reports[1].camera, 'granted-no-device');
  assert.equal(connection.reports[1].microphone, 'granted', 'the two channels are independent');
  await wait(150);
  assert.equal(connection.frames.length, 0);
  assert.equal(feed.status().camera, 'granted-no-device');
 } finally { feed.stop(); await server.close(); }
});

test('a granted camera publishes whole JPEG frames as BINARY messages', async () => {
 const server = await fakeServer();
 const feed = publisher(server);
 try {
  feed.start();
  const connection = await until(() => server.connection, 'the socket');
  await until(() => connection.frames.length >= 3, 'three frames');
  for (const frame of connection.frames) {
   assert.equal(frame[0], 0xff, 'SOI starts the frame');
   assert.equal(frame[1], 0xd8, 'a JPEG, not a container');
   assert.equal(frame[frame.length - 1], 0xd9, 'and it ends at EOI: one raw frame, no wrapper');
  }
  assert.ok(feed.status().frames >= 3);
 } finally { feed.stop(); await server.close(); }
});

test('a frame over the server\'s cap is dropped and named, never sent', async () => {
 const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048), Buffer.from([0xff, 0xd9])]);
 const server = await fakeServer({frameCap: 1024});
 const log = [];
 const feed = new LiveFeed({
  origin: server.origin,
  device: {id: 'device-cap', name: 'Desk'},
  capture: {begin: async () => ({camera: 'granted', microphone: 'granted'}), grab: async () => big, end: () => {}},
  log: line => log.push(line),
 });
 try {
  feed.start();
  const connection = await until(() => server.connection, 'the socket');
  await until(() => /over the server cap/.test(log.join('\n')), 'the cap to be named in the log');
  assert.equal(connection.frames.length, 0, 'an over-cap frame is not written to the recording');
 } finally { feed.stop(); await server.close(); }
});

test('a stale_epoch refusal is surfaced and answered with a NEW socket and a NEW epoch — never replayed', async () => {
 const server = await fakeServer();
 const log = [];
 const status = [];
 const feed = publisher(server, {log, status});
 try {
  feed.start();
  const first = await until(() => server.connection, 'the first socket');
  await until(() => first.reports.length >= 2, 'the first report');
  // The server answers a report it will not accept: a report that named a socket it no longer holds.
  first.send({type: 'error', epoch: first.epochAssigned, code: 'stale_epoch', detail: "This socket's epoch is 'device-7f3a:9'."});
  const second = await until(() => server.connections.length >= 2 && server.connections[1], 'a fresh socket');
  await until(() => second.reports.length >= 1, 'the second socket\'s own pending report');
  assert.equal(second.hello.epoch, null);
  assert.equal(second.epochAssigned, 'device-7f3a:2', 'a reconnect is a new session, so a new epoch');
  assert.notEqual(second.epochAssigned, first.epochAssigned);
  assert.match(log.join('\n'), /the e-server refused a message: stale_epoch/);
  assert.match(log.join('\n'), /reconnecting for a fresh epoch/);
  assert.ok(status.some(value => String(value.error || '').includes('stale_epoch')), 'the refusal is in the status this app can be asked for');
  // Nothing was replayed onto the new socket: its first report is its own pending one.
  assert.equal(second.reports[0].camera, 'pending');
 } finally { feed.stop(); await server.close(); }
});

test('a socket closed under us is retried on a bounded ladder, and each attempt is a fresh epoch', async () => {
 const server = await fakeServer();
 const feed = publisher(server);
 try {
  feed.start();
  const first = await until(() => server.connection, 'the first socket');
  await until(() => first.frames.length >= 1, 'a frame before the drop');
  first.closeWith(1006, 'gone');
  const second = await until(() => server.connections.length >= 2 && server.connections[1], 'the retry socket', {tries: 240});
  await until(() => second.reports.length >= 1, 'the retried feed to publish');
  assert.equal(second.epochAssigned, 'device-7f3a:2');
  assert.equal(feed.status().state, 'connected', 'the retry re-answered the permission question and is publishing again');
 } finally { feed.stop(); await server.close(); }
});

test('close 4401 — no signed-in account on the socket — is named and NOT retried in a storm', async () => {
 const server = await fakeServer();
 const log = [];
 const status = [];
 const feed = publisher(server, {log, status});
 try {
  feed.start();
  const first = await until(() => server.connection, 'the socket');
  first.closeWith(4401, 'Sign in with an Easter Company account to publish a feed.');
  await until(() => feed.status().state === 'refused', 'the refusal');
  await wait(300);
  assert.equal(server.connections.length, 1, 'the PIN gate is not a reason to hammer the server');
  assert.equal(first.reports.filter(report => report.type === 'report').length >= 0, true);
  assert.match(String(feed.status().error || ''), /4401/);
  assert.match(log.join('\n'), /not signed in on this e-server yet \(4401\)/);
 } finally { feed.stop(); await server.close(); }
});

test('an e-server that does not answer the publish route is given up on, by name', async () => {
 const server = await fakeServer();
 server.connections.length = 0;
 const plain = http.createServer((request, response) => { response.writeHead(404); response.end('no'); });
 await new Promise(resolve => plain.listen(0, '127.0.0.1', resolve));
 const log = [];
 const feed = new LiveFeed({
  origin: 'http://127.0.0.1:' + plain.address().port,
  device: {id: 'device-404', name: 'Desk'},
  capture: {begin: async () => ({camera: 'granted', microphone: 'granted'}), grab: async () => JPEG, end: () => {}},
  log: line => log.push(line),
 });
 try {
  feed.start();
  await until(() => feed.status().state === 'unavailable', 'the unavailable state', {tries: 400});
  assert.match(String(feed.status().error || ''), /does not publish live feeds/);
  assert.match(log.join('\n'), /the publish route did not answer after 3 attempts/);
 } finally { feed.stop(); await server.close(); plain.closeAllConnections?.(); plain.close(); }
});

test('stop says goodbye on the socket, so the server closes the segment deliberately', async () => {
 const server = await fakeServer();
 const feed = publisher(server);
 feed.start();
 const connection = await until(() => server.connection, 'the socket');
 await until(() => connection.frames.length >= 1, 'a frame');
 feed.stop('the window is closing');
 await until(() => connection.text.some(message => message.type === 'bye'), 'the bye');
 const bye = connection.text.find(message => message.type === 'bye');
 assert.equal(bye.epoch, connection.epochAssigned, 'bye names the epoch it is ending');
 assert.equal(feed.status().state, 'stopped');
 await server.close();
});

test('a permission answer that arrives after its socket closed is never sent on the next one', async () => {
 const server = await fakeServer();
 let releaseFirst, asked = 0;
 const firstAnswer = new Promise(resolve => { releaseFirst = resolve; });
 const feed = new LiveFeed({
  origin: server.origin,
  device: {id: 'device-late', name: 'Desk'},
  capture: {
   // The first question is answered LATE (after its socket is gone); the second socket's question
   // is never answered at all, so any `granted` on it could only have come from the stale answer.
   begin: () => { asked += 1; return asked === 1 ? firstAnswer : new Promise(() => {}); },
   grab: async () => JPEG,
   end: () => {},
  },
 });
 try {
  feed.start();
  const first = await until(() => server.connection, 'the first socket');
  await until(() => first.reports.length >= 1, 'the first pending report');
  first.closeWith(1006, 'gone');                       // the socket the question was asked for
  const second = await until(() => server.connections.length >= 2 && server.connections[1], 'the retry socket', {tries: 240});
  await until(() => second.reports.length >= 1, 'the retry to start its own question');
  releaseFirst();                                      // the answer lands now, for a dead epoch
  await wait(300);
  assert.deepEqual(second.reports.map(report => report.camera), ['pending'],
   'the retry socket reports its own pending state and never inherits a late answer from the old one');
  assert.equal(asked, 2, 'the retry asked its own question rather than reusing the old answer');
 } finally { feed.stop(); await server.close(); }
});

test('a channel the device has not answered yet stays pending and is never invented', async () => {
 const server = await fakeServer();
 const feed = new LiveFeed({
  origin: server.origin,
  device: {id: 'device-pending', name: 'Desk'},
  // The person has not answered the camera question: the adapter returns no camera state at all,
  // and an unanswered channel must stay `pending` rather than becoming granted-no-device.
  capture: {begin: async () => ({microphone: 'granted'}), grab: async () => JPEG, end: () => {}},
 });
 try {
  feed.start();
  const connection = await until(() => server.connection, 'the socket');
  await until(() => connection.reports.length >= 2, 'the microphone report');
  assert.deepEqual(connection.reports[1], {type: 'report', epoch: connection.epochAssigned, microphone: 'granted'});
  await wait(200);
  assert.equal(connection.frames.length, 0, 'no camera answer means no frames');
  assert.equal(feed.status().camera, 'pending', 'the camera is still what the server was told: pending');
 } finally { feed.stop(); await server.close(); }
});
