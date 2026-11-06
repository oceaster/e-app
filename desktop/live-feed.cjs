'use strict';
// THE E-APP PUBLISHES ITS CAMERA AS A LIVE USER FEED.
//
// Owen, 2026-11-06: "Each client connected to an e-server instance MUST access it's web camera
// and create a stream on the e-server security dashboard ... while logged into e-app and
// connected to their e-server instance", and "I can then also login on a secondary client in
// parallel with another camera". Recording is unconditional while the app is connected ("Recording
// should continue always, as long as you are connected to the instance"): there is no indicator,
// no stop control and no on-demand grace — the camera's own LED is the physical awareness.
//
// THE PROTOCOL IS THE SERVER'S, NOT OURS. The contract is the module docstring of e-server's
// `api/live_feeds.py` and its reference publisher `tests/live_feed_client.py`; this file is the
// drop-in for that reference, and nothing here invents a second shape:
//
//   ENDPOINT  one WebSocket, `GET /api/live-feeds/publish` (upgrade). The socket presents the
//             page's own `sec_session` cookie, which is why this runs in the connected window's
//             renderer rather than in the main process: the e-server resolves the account from
//             that cookie on the upgrade itself and closes 4401 when there is no binding.
//   BINARY    exactly one raw JPEG frame per message. The socket carries exactly one epoch, so
//             the server stamps frames with it; a frame has no header to get wrong.
//   TEXT      one JSON object per message, and EVERY message after `hello` carries `epoch`:
//               {"type":"hello","device_id":<stable per-install id>,"device_name":<label>,
//                "epoch":null}                     -> the server names the epoch in `welcome`
//               {"type":"report","epoch":<epoch>,"camera"?:<state>,"microphone"?:<state>}
//               {"type":"bye","epoch":<epoch>}
//   STATES    camera/microphone are one of `pending`, `granted`, `granted-no-device`, `denied`.
//             `not-reported` is REFUSED by the server: it is the absence of a report, not a
//             report, so a client that never answers leaves the dashboard saying "status not
//             reported" — which is the honest thing for it to say.
//   REFUSALS  the server answers {"type":"error","epoch":...,"code":...,"detail":...} with
//             `stale_epoch`, `unknown_type`, `bad_report`, `frame_too_large`, `forbidden`, and a
//             refusal never changes stored state and never closes the socket. A `stale_epoch` is
//             surfaced (logged, and in the status this app can be asked for) and answered by
//             reconnecting — a new socket is a new epoch — rather than by replaying the message.
//
// WHAT THIS MODULE DOES NOT DO. It opens no device and draws nothing: the capture adapter (the
// renderer's getUserMedia/canvas half, in desktop/preload.cjs) hands it a JPEG per tick, and the
// main process owns the permission question. That keeps the protocol testable in Node against a
// fake e-server — tests/live-feed.test.cjs — with no window and no camera.

//: The server's route. `api/live_feeds.py`'s docstring: one WebSocket per connection.
const FEED_PATH = '/api/live-feeds/publish';

//: The server's frame cap (`e_server/streaming/client_feed.py:MAX_FRAME_BYTES`), restated as the
//: ceiling this client will ever send. The welcome message carries the same number; the lower of
//: the two is used, so a server that lowers its cap lowers ours without a client release.
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

//: 15 frames a second: the recorder feeds ffmpeg `-f mjpeg -framerate 15`, so this is the pacing
//: the segment muxer expects. Faster invents nothing; slower makes a segment play back late.
const FRAME_INTERVAL_MS = 66;

//: A frame is dropped rather than queued when the socket is already behind. 2 MB is about two
//: seconds of 640x480 JPEG, so a momentary stall costs frames (which the dashboard never sees once
//: they are gone) instead of unbounded memory.
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

//: An e-server with no live-feed route fails the upgrade. Three tries covers a service restarting
//: under us; after that the honest answer is "this e-server does not publish live feeds", not a
//: reconnect storm for the life of the window.
const OPEN_ATTEMPTS = 3;

//: A socket that closes under us (a server restart, a network blip) is retried on this ladder and
//: then given up on, because the page will reload when the instance is reachable again and a
//: reloaded page starts a fresh publisher with a fresh epoch.
const RECONNECT_DELAYS_MS = [1000, 2000, 5000];

//: The server's own close code for "this socket has no signed-in account" (api/live_feeds.py's
//: `_refuse(..., 4401, ...)`): the PIN gate is still up, so there is nobody to publish for yet.
//: Retried, because a reconnected window that has signed in since is a different situation.
const CLOSE_NOT_SIGNED_IN = 4401;

//: The states the server accepts in a report (REPORTABLE_PERMISSION_STATES).
const REPORTABLE = new Set(['pending', 'granted', 'granted-no-device', 'denied']);

/** The publish URL for an origin: `https://host` -> `wss://host/api/live-feeds/publish`. */
function feedUrl(origin) {
 const url = new URL(String(origin));
 url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
 url.pathname = FEED_PATH;
 url.search = '';
 url.hash = '';
 return url.href;
}

/** A permission state the server will accept, from whatever the capture adapter measured. */
function reportable(value) {
 const state = String(value || '');
 return REPORTABLE.has(state) ? state : 'granted-no-device';
}

class LiveFeed {
 /**
  * @param {object} options
  * @param {string} options.origin        the connected e-server's origin (https://host[:port])
  * @param {{id:string,name:string}} options.device  this install's identity: `id` is stable and
  *        unique to the install (never a hostname, never the account name — two clients of one
  *        person must be two devices), `name` is a label the dashboard prints and never a key.
  * @param {object} options.capture       the device half, injected so the protocol is testable:
  *        `begin()` -> Promise<{camera:string, microphone:string, grab?:()=>Promise<*>}>:
  *          asks for permission, opens what was granted, and answers the two channel states;
  *        `end()` -> void: releases the device and any transient object URL.
  * @param {Function} [options.WebSocketImpl]  the WebSocket constructor (global in Electron).
  * @param {Function} [options.log]       one line per event, named: `[live-feed] ...`.
  * @param {Function} [options.status]    called with the status object whenever it changes.
  */
 constructor({origin, device, capture, WebSocketImpl, log, status} = {}) {
  this.origin = String(origin || '');
  this.device = device || {id: '', name: ''};
  this.capture = capture || null;
  this.WebSocketImpl = WebSocketImpl || (typeof WebSocket === 'function' ? WebSocket : null);
  this.log = typeof log === 'function' ? log : () => {};
  this.onStatus = typeof status === 'function' ? status : () => {};
  this.state = 'idle';
  this.epoch = '';
  this.frames = 0;
  this.camera = '';
  this.microphone = '';
  this.lastError = null;
  this.maxFrameBytes = MAX_FRAME_BYTES;
  this.socket = null;
  this.generation = 0;
  this.timer = null;
  this.openAttempts = 0;
  this.reconnects = 0;
  this.reconnectTimer = null;
  this.stopped = false;
  this.sending = false;
 }

 /** What this app can be asked about its feed (main.cjs keeps the last one it was told). */
 status() {
  return {
   state: this.state,
   origin: this.origin,
   epoch: this.epoch,
   frames: this.frames,
   camera: this.camera,
   microphone: this.microphone,
   error: this.lastError,
  };
 }

 _set(state, detail) {
  if (this.state !== state || detail) {
   this.state = state;
   if (detail) this.lastError = detail;
   try { this.onStatus(this.status()); } catch {}
  }
 }

 start() {
  if (this.stopped) return this;
  if (!this.WebSocketImpl) { this._set('unavailable', 'no WebSocket in this client'); return this; }
  this._connect('connect');
  return this;
 }

 stop(reason) {
  this.stopped = true;
  this._clearTimers();
  this._releaseCapture();
  const socket = this.socket;
  this.socket = null;
  this.generation += 1;
  if (socket) {
   try {
    // A deliberate goodbye, so the server closes the segment now instead of waiting for a drop.
    if (socket.readyState === 1 && this.epoch) {
     socket.send(JSON.stringify({type: 'bye', epoch: this.epoch}));
    }
   } catch {}
   try { socket.close(1000, 'bye'); } catch {}
  }
  this._set('stopped', reason || '');
  return this;
 }

 // ── the socket ────────────────────────────────────────────────────────────

 _connect(why) {
  if (this.stopped) return;
  const generation = ++this.generation;
  this.epoch = '';
  this._set('connecting');
  let socket;
  try {
   socket = new this.WebSocketImpl(feedUrl(this.origin));
  } catch (error) {
   this._fail('unavailable', 'could not open a socket: ' + (error && error.message ? error.message : error));
   return;
  }
  this.socket = socket;
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
   if (generation !== this.generation) return;
   this.openAttempts = 0;
   this.reconnects = 0;
   // `epoch: null` is the protocol's "you name it": the server mints one per socket
   // ({device_id}:{session_seq}), so a reconnect is a new session by construction.
   this._send({type: 'hello', device_id: this.device.id, device_name: this.device.name, epoch: null});
  };

  socket.onmessage = event => {
   if (generation !== this.generation) return;   // a report from an old connection is never applied
   if (typeof event.data !== 'string') return;
   let message;
   try { message = JSON.parse(event.data); } catch { return; }
   if (message && typeof message === 'object') this._onMessage(message, generation);
  };

  socket.onerror = () => {
   if (generation !== this.generation) return;
   // No detail is available from a browser WebSocket error; the close event that follows carries
   // the code, and it is the one this app reports.
  };

  socket.onclose = event => {
   if (generation !== this.generation) return;
   this.socket = null;
   this._clearFrameTimer();
   this._releaseCapture();
   const code = event && event.code ? event.code : 0;
   if (this.stopped) return;
   if (code === CLOSE_NOT_SIGNED_IN) {
    // The feed is published at connect, before any permission decision — but only to a socket
    // that carries a signed-in account. The PIN gate is up, so there is nothing to publish yet.
    this._set('refused', 'the e-server closed the feed: no signed-in account on this socket (4401)');
    this.log('refused by ' + this.origin + ': not signed in on this e-server yet (4401); the feed starts when this page reloads after the PIN');
    return;
   }
   if (this.epoch) {
    this._set('dropped', 'the e-server closed the feed (' + (code || 'no code') + ')');
    this.log('dropped by ' + this.origin + ' (close code ' + (code || 'none') + '); reconnecting');
   } else if (++this.openAttempts >= OPEN_ATTEMPTS) {
    this._set('unavailable', 'this e-server does not publish live feeds (' + (code || 'no code') + ')');
    this.log('unavailable at ' + this.origin + ': the publish route did not answer after ' + this.openAttempts + ' attempts (close code ' + (code || 'none') + ')');
    return;
   }
   this._scheduleReconnect();
  };
 }

 _scheduleReconnect() {
  if (this.stopped) return;
  const index = Math.min(this.reconnects, RECONNECT_DELAYS_MS.length - 1);
  if (this.reconnects >= RECONNECT_DELAYS_MS.length) {
   this._set('stopped', 'gave up reconnecting to ' + this.origin);
   this.log('gave up reconnecting to ' + this.origin + ' after ' + this.reconnects + ' attempts; a reloaded page starts a new feed');
   return;
  }
  const delay = RECONNECT_DELAYS_MS[index];
  this.reconnects += 1;
  this._clearTimer('reconnectTimer');
  this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this._connect('reconnect'); }, delay);
  if (this.reconnectTimer && typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
 }

 _onMessage(message, generation) {
  const type = String(message.type || '');
  if (type === 'welcome') {
   this.epoch = String(message.epoch || '');
   const cap = Number(message.max_frame_bytes);
   this.maxFrameBytes = Number.isFinite(cap) && cap > 0 ? Math.min(cap, MAX_FRAME_BYTES) : MAX_FRAME_BYTES;
   this._set('connected');
   this.log('publishing ' + String(message.feed_id || '') + ' as ' + (this.device.name || this.device.id) + ' (epoch ' + this.epoch + ')');
   // ASKED, NEVER ASSUMED: pending is reported BEFORE the question is put to the person, so the
   // dashboard can never show "denied" (or silence) while the app is still waiting on an answer.
   this._report({camera: 'pending', microphone: 'pending'});
   void this._beginCapture(generation);
   return;
  }
  if (type === 'ack') {
   if (message.camera) this.camera = String(message.camera);
   if (message.microphone) this.microphone = String(message.microphone);
   this._set(this.state);
   return;
  }
  if (type === 'error') {
   const code = String(message.code || 'error');
   const detail = String(message.detail || '');
   this._set(this.state, code + (detail ? ': ' + detail : ''));
   this.log('the e-server refused a message: ' + code + (detail ? ' — ' + detail : ''));
   if (code === 'stale_epoch') {
    // Never replayed: this socket's epoch is not what the server holds, so the only correct
    // answer is a new socket, which the server gives a new epoch.
    this.log('reconnecting for a fresh epoch');
    this._clearFrameTimer();
    const socket = this.socket;
    this.generation += 1;
    this.reconnects = 0;
    this.socket = null;
    try { if (socket) socket.close(1000, 'stale epoch'); } catch {}
    this._connect('stale epoch');
   }
   return;
  }
 }

 _send(payload) {
  const socket = this.socket;
  if (!socket || socket.readyState !== 1) return false;
  try { socket.send(JSON.stringify(payload)); return true; } catch { return false; }
 }

 /** One report. Only reportable states are sent, and every message names this socket's epoch. */
 _report(channels) {
  if (!this.epoch) return false;
  const message = {type: 'report', epoch: this.epoch};
  let named = false;
  for (const channel of ['camera', 'microphone']) {
   if (channels[channel] === undefined) continue;
   message[channel] = reportable(channels[channel]);
   this[channel] = message[channel];
   named = true;
  }
  if (!named) return false;
  this._set(this.state);
  return this._send(message);
 }

 // ── the device ────────────────────────────────────────────────────────────

 async _beginCapture(generation) {
  if (!this.capture || typeof this.capture.begin !== 'function') return;
  let result;
  try {
   result = await this.capture.begin();
  } catch (error) {
   result = {camera: 'granted-no-device', microphone: 'granted-no-device',
             detail: (error && error.message) || String(error)};
  }
  if (generation !== this.generation || this.stopped) return;   // an answer for a socket we left
  // Each channel is reported independently: the server stores them separately, and a denied
  // camera with a granted microphone is a real state a person can be in. A channel the adapter
  // leaves undefined has NOT been answered, so it is left as it is (pending) rather than being
  // turned into a state nobody measured.
  const channels = {};
  if (result.camera !== undefined) channels.camera = result.camera;
  if (result.microphone !== undefined) channels.microphone = result.microphone;
  if (Object.keys(channels).length) this._report(channels);
  if (result.detail) this.log('capture: ' + result.detail);
  if (result.camera === 'granted') { this._startFrameTimer(); return; }
  // No frames, and no fallback: the socket stays open so the dashboard shows the honest state
  // ("camera permission denied" / "no camera found") while the client is connected.
  this.log('not capturing: camera is ' + result.camera);
 }

 _releaseCapture() {
  this._clearFrameTimer();
  if (!this.capture || typeof this.capture.end !== 'function') return;
  try { this.capture.end(); } catch {}
 }

 _startFrameTimer() {
  this._clearFrameTimer();
  this.timer = setInterval(() => void this._tick(), FRAME_INTERVAL_MS);
  if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
 }

 _clearFrameTimer() {
  if (this.timer) clearInterval(this.timer);
  this.timer = null;
 }

 async _tick() {
  const socket = this.socket;
  if (!socket || socket.readyState !== 1 || !this.epoch || this.sending) return;
  // Backpressure: skip the frame rather than queue it. A dashboard watching a stalled socket
  // wants the current picture, not a backlog of old ones.
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) return;
  this.sending = true;
  let frame = null;
  try { frame = await this.capture.grab(); } catch { frame = null; }
  this.sending = false;
  if (!frame) return;
  if (this.socket !== socket || this.stopped) return;
  const size = typeof frame.size === 'number' ? frame.size : (frame.byteLength || 0);
  if (!size || size > this.maxFrameBytes) {
   if (size > this.maxFrameBytes) this.log('dropped a frame of ' + size + ' bytes: over the server cap of ' + this.maxFrameBytes);
   return;
  }
  try { socket.send(frame); this.frames += 1; } catch { return; }
  if (this.frames === 1) {
   this._set(this.state);
   this.log('first frame sent to ' + this.origin + ' (epoch ' + this.epoch + ')');
   // The server marks a feed's recording ACTIVE when a REPORT arrives after it has accepted
   // frames (api/live_feeds.py, `_handle_state`), and it acknowledges on no other occasion. So the
   // first accepted frame re-states the state the server already holds: a duplicate report, never
   // a new claim, and it is what makes the dashboard's "Recording" true rather than "unconfirmed".
   this._report({camera: this.camera, microphone: this.microphone});
  }
 }

 _clearTimer(name) {
  if (this[name]) clearTimeout(this[name]);
  this[name] = null;
 }

 _clearTimers() {
  this._clearFrameTimer();
  this._clearTimer('reconnectTimer');
 }

 _fail(state, detail) {
  this._set(state, detail);
  this.log(state + ': ' + detail);
 }
}

module.exports = {LiveFeed, feedUrl, REPORTABLE, FEED_PATH, MAX_FRAME_BYTES, FRAME_INTERVAL_MS};
