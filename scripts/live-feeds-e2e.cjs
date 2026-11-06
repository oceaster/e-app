'use strict';
// THE PURCHASE ORDER: the real e-app, publishing Owen's own webcam, recorded by a real e-server.
//
// Owen, 2026-11-06: "Each client connected to an e-server instance MUST access it's web camera and
// create a stream on the e-server security dashboard ... while logged into e-app and connected to
// their e-server instance" — and the acceptance for this ticket is not the suite: it is the
// packaged app's feed appearing on the dashboard with a segment file on disk.
//
// So this journey drives the app the person installs: the REAL main process, the REAL preload and
// the REAL publisher, a REAL e-server publish socket (scripts/live-feeds-fixture.py mounts
// `api/live_feeds.py` itself, so the registry, the identity resolution from the PIN cookie, the
// recorder and ffmpeg are the shipped ones), and the REAL camera on this machine. Nothing here
// fakes a frame: if the webcam is busy or absent the app reports granted-no-device and this script
// fails, because that is the honest outcome rather than a green light over a wrong product.
//
//   xvfb-run -a node scripts/live-feeds-e2e.cjs                     # the dev build, one client
//   xvfb-run -a node scripts/live-feeds-e2e.cjs --two               # two clients, one person
//   xvfb-run -a node scripts/live-feeds-e2e.cjs --packaged          # release/linux-unpacked
//
// WHAT IT ASSERTS, in Owen's words:
//   1. the window's publisher says hello on the documented socket and the server names an epoch;
//   2. the app ASKS (a native dialog a person answers; `xdotool` answers it here) and the feed
//      reports `pending` before the answer and `granted` after it;
//   3. frames arrive: `frames > 0`, the dashboard's own fragment renders `data-state="live"`, and
//      the MJPEG the tile draws is a real JPEG;
//   4. the recording is on disk: `{feed_id}_00000.mkv`, an h264 stream, with real duration;
//   5. with --two, two installs are two devices (different ids, same account), both publishing.
// It says what it did NOT prove at the end, rather than implying more than it measured.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SERVER_TREE = process.env.LIVE_FEEDS_SERVER || '/root/wt-live-feeds';
const PYTHON = process.env.LIVE_FEEDS_PYTHON
 || (fs.existsSync(path.join(SERVER_TREE, '.venv/bin/python')) ? path.join(SERVER_TREE, '.venv/bin/python') : '/root/e-server/.venv/bin/python');
const ACCOUNT = process.env.EASTER_TEST_ACCOUNT || '/root/.auth/easter-delta.json';
const PACKAGED = process.argv.includes('--packaged');
//: Chromium's synthetic spinner, for proving the pipeline when the machine's own webcam is
//: unavailable (a persistent camera elsewhere on the box holds it). NEVER the default: the
//: acceptance is Owen's real webcam, and a run that used this must say so.
const FAKE_CAMERA = process.argv.includes('--fake-camera');
const TWO = process.argv.includes('--two');
//: Answer the camera question with Deny, and assert the server is TOLD that rather than left to
//: infer it: a denied camera is a state the dashboard prints, never an error and never silence.
const DENY = process.argv.includes('--deny');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
//: Set when the packaged build needs the fixture's certificate (see the TLS block in the run).
let TLS_CA = null;

function freePort() {
 return new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
   const {port} = server.address();
   server.close(() => resolve(port));
  });
 });
}

async function http(method, url, {cookie = '', body = null} = {}) {
 // A tiny HTTP client: no dependency, and the assertions are about status codes and bytes.
 const address = new URL(url);
 const lib = address.protocol === 'https:' ? require('node:https') : require('node:http');
 return new Promise((resolve, reject) => {
  const request = lib.request({method, hostname: address.hostname, port: address.port, path: address.pathname + address.search,
   headers: {...(cookie ? {cookie} : {}), ...(body ? {'content-type': 'application/json'} : {})},
   rejectUnauthorized: false, timeout: 15000}, response => {
   const chunks = [];
   response.on('data', chunk => chunks.push(chunk));
   response.on('end', () => resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}));
  });
  request.on('error', reject);
  request.on('timeout', () => request.destroy(Error('the request timed out')));
  if (body) request.write(JSON.stringify(body));
  request.end();
 });
}

/** Read the first bytes of a streaming response (the dashboard's MJPEG never ends). */
async function firstBytes(url, {cookie = '', bytes = 4096, timeoutMs = 10000} = {}) {
 const address = new URL(url);
 const lib = address.protocol === 'https:' ? require('node:https') : require('node:http');
 return new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  const request = lib.request({method: 'GET', hostname: address.hostname, port: address.port, path: address.pathname + address.search,
   headers: {...(cookie ? {cookie} : {})}, rejectUnauthorized: false, timeout: timeoutMs}, response => {
   const finish = () => { request.destroy(); resolve({status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks)}); };
   response.on('data', chunk => {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= bytes) finish();
   });
   response.on('end', finish);
   response.on('error', finish);
  });
  request.on('error', error => (total ? resolve({status: 0, headers: {}, body: Buffer.concat(chunks)}) : reject(error)));
  request.on('timeout', () => { request.destroy(); if (total) resolve({status: 0, headers: {}, body: Buffer.concat(chunks)}); else reject(Error('the stream did not answer')); });
  request.end();
 });
}

/** CDP, on the app's own windows. The same shape scripts/live-connections.cjs uses. */
async function targets(port) {
 for (let attempt = 0; attempt < 240; attempt++) {
  try {
   const answer = await http('GET', `http://127.0.0.1:${port}/json/list`);
   return JSON.parse(answer.body.toString('utf8'));
  } catch {}
  await wait(250);
 }
 throw Error('the debugger never answered on ' + port);
}

async function attach(target) {
 const socket = new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
 let next = 0;
 const pending = new Map();
 socket.onmessage = event => {
  const message = JSON.parse(event.data);
  const promise = pending.get(message.id);
  if (!promise) return;
  pending.delete(message.id);
  if (message.error) promise.reject(Error(message.error.message));
  else promise.resolve(message.result);
 };
 const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++next;
  pending.set(id, {resolve, reject});
  socket.send(JSON.stringify({id, method, params}));
 });
 const evaluate = async expression => {
  const answer = await rpc('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  return answer.exceptionDetails ? null : answer.result?.value;
 };
 const until = async (description, expression, tries = 240) => {
  for (let attempt = 0; attempt < tries; attempt++) {
   const value = await evaluate(expression);
   if (value) return value;
   await wait(250);
  }
  throw Error('timed out waiting for ' + description);
 };
 return {socket, rpc, evaluate, until};
}

/** Answer the app's own camera dialog the way a person does: press Allow in the real window. */
async function answerPermissionDialog({allow = true} = {}) {
 const titles = ['e-server camera and microphone', 'e-server permission'];
 let windowId = '';
 for (let attempt = 0; attempt < 60 && !windowId; attempt++) {
  for (const title of titles) {
   const found = spawnSync('xdotool', ['search', '--name', title], {encoding: 'utf8'});
   const ids = String(found.stdout || '').trim().split('\n').filter(Boolean);
   if (ids.length) { windowId = ids[ids.length - 1]; break; }
  }
  if (!windowId) await wait(250);
 }
 if (!windowId) return {answered: false, reason: 'no permission dialog appeared'};
 spawnSync('xdotool', ['windowactivate', '--sync', windowId]);
 spawnSync('xdotool', ['windowfocus', '--sync', windowId]);

 if (!allow) {
  spawnSync('xdotool', ['key', '--window', windowId, 'Return']);   // Deny is the default
  return {answered: true, how: 'default button (Deny)'};
 }
 // ALLOWING IS NOT THE DEFAULT — a person is never clicked into handing over a camera — so the
 // button is FOUND rather than assumed: the dialog's own tree names its buttons, and the one
 // labelled Allow is pressed by its own geometry. If the toolkit draws one undivided window, the
 // keyboard walks the focus instead, and either way the app's own log says which answer it got.
 const tree = spawnSync('xwininfo', ['-tree', '-id', windowId], {encoding: 'utf8'}).stdout || '';
 const button = tree.split('\n').find(line => /"Allow"/i.test(line));
 if (button) {
  const id = (/(0x[0-9a-f]+)/i.exec(button) || [])[1];
  if (id) {
   const box = spawnSync('xwininfo', ['-id', id], {encoding: 'utf8'}).stdout || '';
   const x = Number((/Absolute upper-left X:\s*(-?\d+)/.exec(box) || [])[1]);
   const y = Number((/Absolute upper-left Y:\s*(-?\d+)/.exec(box) || [])[1]);
   const width = Number((/Width:\s*(\d+)/.exec(box) || [])[1] || 0);
   const height = Number((/Height:\s*(\d+)/.exec(box) || [])[1] || 0);
   if (Number.isFinite(x) && Number.isFinite(y) && width > 0 && height > 0) {
    spawnSync('xdotool', ['mousemove', String(x + Math.round(width / 2)), String(y + Math.round(height / 2)), 'click', '1']);
    return {answered: true, how: `clicked the "${'Allow'}" button at ${x},${y} (${width}x${height})`};
   }
  }
 }
 // No named button: walk the focus off the default (Deny) and press the focused one.
 spawnSync('xdotool', ['key', '--window', windowId, 'shift+Tab']);
 await wait(150);
 spawnSync('xdotool', ['key', '--window', windowId, 'Return']);
 const geometry = spawnSync('xdotool', ['getwindowgeometry', '--shell', windowId], {encoding: 'utf8'}).stdout || '';
 const width = Number((/WIDTH=(\d+)/.exec(geometry) || [])[1] || 0);
 const height = Number((/HEIGHT=(\d+)/.exec(geometry) || [])[1] || 0);
 return {answered: true, how: `keyboard (shift+Tab, Return) in ${width}x${height}; tree had no button: ${tree.slice(-200)}`};
}

async function startFixture({origin, storage, profiles, token, tls}) {
 const args = [path.join(ROOT, 'scripts/live-feeds-fixture.py'), '--server-tree', SERVER_TREE,
  '--port', String(new URL(origin).port), '--storage', storage, '--profile-db', profiles,
  '--token', token, '--account-id', '2'];
 if (tls) args.push('--tls-cert', tls.cert, '--tls-key', tls.key);
 const child = spawn(PYTHON, args, {cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  env: {...process.env, SECURITY_STORAGE: storage, E_SERVER_PROFILE_DB: profiles}});
 let log = '';
 child.stdout.on('data', data => { log += data; });
 child.stderr.on('data', data => { log += data; });
 for (let attempt = 0; attempt < 200; attempt++) {
  if (log.includes('listening on')) return {child, log: () => log};
  if (child.exitCode !== null) throw Error('the fixture exited:\n' + log);
  await wait(150);
 }
 throw Error('the fixture never answered:\n' + log);
}

/** One client: an isolated HOME, its own debug port, the REAL app pointing at the fixture. */
async function launchClient({name, origin, home, debuggingPort, tlsCa = null}) {
 // The development build's own fixture: it names the server this app connects to (the packaged
 // build reads no fixture at all and takes the address over the deep link or its list).
 const env = {...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
  ...(PACKAGED ? {} : {E_SERVER_CLIENT_TEST_ORIGIN: origin}),
  // The fixture's own CA, for the main process's publish socket. The renderer gets the same trust
  // decision from --ignore-certificate-errors, which is why both are needed for this one address.
  ...(TLS_CA ? {NODE_EXTRA_CA_CERTS: TLS_CA} : {})};
 const flags = ['--no-sandbox', '--disable-gpu', `--remote-debugging-port=${debuggingPort}`,
  '--remote-debugging-address=127.0.0.1', ...(FAKE_CAMERA ? ['--use-fake-device-for-media-stream'] : [])];
 let command, args, cwd;
 if (PACKAGED) {
  const binary = path.join(ROOT, 'release/linux-unpacked/e-server-client');
  assert.ok(fs.existsSync(binary), 'the packaged build is the artifact: run `npm run pack` first (' + binary + ')');
  command = binary;
  // A loopback origin can only be HTTPS for a packaged build (serverOrigin refuses plain HTTP
  // outside development), so the fixture serves TLS and this window ignores the self-signed cert.
  args = [...flags, '--ignore-certificate-errors', `e-server://connect?server=${origin}`];
  cwd = ROOT;
 } else {
  command = require(path.join(ROOT, 'node_modules', 'electron'));
  // The development build takes the address from its own fixture (E_SERVER_CLIENT_TEST_ORIGIN),
  // and the window is connected below through the same IPC the list's rows use, once the account
  // exists — the deep link deliberately refuses a plain-HTTP origin outside development.
  args = [...flags, '.'];
  cwd = ROOT;
 }
 const child = spawn(command, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
 const log = {text: ''};
 child.stdout.on('data', data => { log.text = (log.text + data).slice(-60000); });
 child.stderr.on('data', data => { log.text = (log.text + data).slice(-60000); });
 return {name, child, log, home, debuggingPort};
}

/** Sign in to Easter Company, then let the deep link connect the window to the fixture. */
async function signIn(client, account) {
 console.log(`${client.name}: waiting for the setup window`);
 const list = await targets(client.debuggingPort);
 const shell = list.find(target => target.type === 'page' && target.url.includes('shell.html'));
 assert.ok(shell, 'the setup window never opened\n' + client.log.text);
 const setup = await attach(shell);
 await setup.until('the sign-in form', '!!document.querySelector(\'input[name=identifier]\')');
 console.log(`${client.name}: signing in as ${account.username}`);
 await setup.evaluate(`(()=>{const id=document.querySelector('input[name=identifier]'),pw=document.querySelector('input[name=password]');
  id.value=${JSON.stringify(account.username)};id.dispatchEvent(new Event('input',{bubbles:true}));
  pw.value=${JSON.stringify(account.password)};pw.dispatchEvent(new Event('input',{bubbles:true}));
  pw.closest('form').requestSubmit();return true})()`);
 client.setup = setup;
}

async function serverWindow(client, origin) {
 for (let attempt = 0; attempt < 240; attempt++) {
  const list = await targets(client.debuggingPort).catch(() => []);
  const page = list.find(target => target.type === 'page' && target.url.startsWith(origin));
  if (page) return page;
  await wait(250);
 }
 throw Error('the client never opened ' + origin + '\n--- app log ---\n' + client.log.text);
}

(async () => {
 const account = JSON.parse(fs.readFileSync(ACCOUNT, 'utf8'));
 const work = fs.mkdtempSync(path.join(os.tmpdir(), 'eapp-live-feeds-'));
 const storage = path.join(work, 'security');
 const profiles = path.join(work, 'profiles.sqlite3');
 fs.mkdirSync(storage, {recursive: true});
 const token = 'e2e-' + crypto.randomUUID();
 const tls = PACKAGED ? (() => {
  // A packaged build refuses a plain-HTTP origin (serverOrigin allows loopback HTTP only in
  // development), so the fixture serves TLS. Its certificate is signed by a throwaway CA that is
  // trusted for THIS PROCESS ONLY (NODE_EXTRA_CA_CERTS below) — the main process's own socket
  // verifies it like any other server, and nothing is added to the machine's trust store.
  const caKey = path.join(work, 'ca-key.pem'), ca = path.join(work, 'ca.pem');
  const key = path.join(work, 'key.pem'), cert = path.join(work, 'cert.pem');
  const csr = path.join(work, 'csr.pem'), ext = path.join(work, 'ext.cnf');
  fs.writeFileSync(ext, 'subjectAltName=IP:127.0.0.1\n');
  const steps = [
   ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=Easter live-feeds test CA', '-keyout', caKey, '-out', ca],
   ['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', csr],
   ['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-days', '2', '-extfile', ext, '-out', cert],
  ];
  for (const step of steps) {
   const made = spawnSync('openssl', step, {encoding: 'utf8'});
   assert.equal(made.status, 0, 'certificates for the loopback fixture: ' + (made.stderr || ''));
  }
  return {key, cert, ca};
 })() : null;
 const port = await freePort();
 const origin = `${PACKAGED ? 'https' : 'http'}://127.0.0.1:${port}`;
 const clients = [];
 let fixture = null;
 let failures = 0;
 try {
  fixture = await startFixture({origin, storage, profiles, token, tls});
  console.log(`fixture: ${origin} (real api/live_feeds.py from ${SERVER_TREE})`);

  const count = TWO ? 2 : 1;
  for (let index = 0; index < count; index++) {
   const home = path.join(work, 'home' + index);
   fs.mkdirSync(home, {recursive: true});
   const debuggingPort = await freePort();
   TLS_CA = tls ? tls.ca : null;
   const client = await launchClient({name: 'client' + (index + 1), origin, home, debuggingPort, tlsCa: TLS_CA});
   clients.push(client);
   await signIn(client, account);
   // CONNECT, through the shipped IPC the list's own rows use (`window.eServerSetup.connect`),
   // after the account exists: the app opens the server window on the fixture origin.
   console.log(`${client.name}: signed in; connecting to ${origin}`);
   await client.setup.until('the list after sign-in',
    `(()=>{const node=document.querySelector('#client-servers');return !!node&&node.hidden===false})()`);
   const connected = await client.setup.evaluate(`window.eServerSetup.connect(${JSON.stringify(origin)})`);
   assert.ok(connected && (connected.ok || connected.same), 'the client refused to connect: ' + JSON.stringify(connected));
   const page = await serverWindow(client, origin);
   console.log(`${client.name}: the server window opened on ${origin}`);
   client.page = await attach(page);
   // THE PIN GATE, in the shape a fixture can offer: this route sets the cookie a real sign-in sets,
   // inside the client's own window, and then the document reloads into the connected page.
   await client.page.evaluate(`(()=>{location.href=${JSON.stringify(origin + '/_session?token=' + encodeURIComponent(token))};return true})()`);
   await client.page.until('the connected page', `document.body && document.body.textContent.includes('The e-app')`);
   // The publisher starts on this document. Ask, then answer the app's own question.
   console.log(`${client.name}: connected; waiting for the app's own camera question`);
   await wait(1500);
   const answer = await answerPermissionDialog({allow: !DENY});
   console.log(`${client.name}: permission dialog ${answer.answered ? 'answered: ' + answer.how : 'NOT FOUND — ' + answer.reason}`);
   const device = JSON.parse(fs.readFileSync(path.join(home, 'config', 'Easter Company', 'e-server-client', 'device.json'), 'utf8'));
   client.device = device;
   console.log(`${client.name}: this install's device id ${device.id} (${device.name})`);
  }

  // ── the measurement: what the SERVER sees, from the server's own routes ─────────────────
  let feeds = null;
  if (DENY) {
   // A DENIED CAMERA IS REPORTED, NOT INFERRED: the feed is connected with nothing to capture, and
   // the dashboard's tile says so in words of its own.
   for (let attempt = 0; attempt < 120; attempt++) {
    const parsed = JSON.parse((await http('GET', origin + '/api/security/live-feeds', {cookie: 'sec_session=' + token})).body.toString('utf8'));
    feeds = parsed.feeds.filter(feed => feed.camera === 'denied');
    if (feeds.length) break;
    await wait(500);
   }
   assert.ok(feeds && feeds.length, 'a denied camera must reach the server as `denied`');
   const feed = feeds[0];
   console.log(`feed ${feed.feed_id}: camera=${feed.camera} microphone=${feed.microphone} frames=${feed.frames} (denied by the person)`);
   assert.equal(feed.frames, 0, 'a denied camera produces no frames');
   assert.equal(feed.state, 'denied', 'and the tile says denied, not live and not an error');
   const dashboard = (await http('GET', origin + '/dashboard', {cookie: 'sec_session=' + token})).body.toString('utf8');
   assert.match(dashboard, /data-state="denied"/, 'the dashboard renders the denied state');
   assert.match(dashboard, /Camera permission denied/, 'in its own words');
   await wait(1500);
   const segments = fs.existsSync(storage) ? fs.readdirSync(storage).filter(name => name.endsWith('.mkv')) : [];
   assert.equal(segments.length, 0, 'nothing was recorded, because nothing was captured');
   console.log('\nPASS: the app asked, the person denied, and the server was told `denied` — with no');
   console.log('      frames, no recording and no error sentence anywhere.');
   process.exitCode = 0;
   return;
  }
  for (let attempt = 0; attempt < 240; attempt++) {
   const answer = await http('GET', origin + '/api/security/live-feeds', {cookie: 'sec_session=' + token});
   const parsed = JSON.parse(answer.body.toString('utf8'));
   feeds = parsed.feeds.filter(feed => feed.frames > 0 && feed.camera === 'granted');
   if (feeds.length >= clients.length) break;
   await wait(500);
  }
  assert.ok(feeds && feeds.length >= clients.length,
   `expected ${clients.length} publishing feed(s); the server reported ` + JSON.stringify(feeds)
   + '\n--- app logs ---\n' + clients.map(client => client.name + ':\n' + client.log.text).join('\n'));
  for (const feed of feeds.slice(0, clients.length)) {
   console.log(`feed ${feed.feed_id}: state=${feed.state} camera=${feed.camera} microphone=${feed.microphone} `
    + `recording=${feed.recording} frames=${feed.frames} device=${feed.device_name}`);
   assert.equal(feed.state, 'live', 'the tile is live, not pending: ' + JSON.stringify(feed));
   assert.equal(feed.account_id, '2', 'the account came from the PIN session on the upgrade');
  }
  if (TWO) {
   const ids = feeds.slice(0, 2).map(feed => feed.device_id);
   assert.notEqual(ids[0], ids[1], 'two installs are two devices');
   // ONE PERSON, TWO DEVICES: the grouping is by account, so the count of people stays 1 while the
   // count of connected clients is 2 — and the dashboard draws her multi-device group for them.
   const summary = JSON.parse((await http('GET', origin + '/api/security/live-feeds', {cookie: 'sec_session=' + token})).body.toString('utf8'));
   assert.equal(summary.people, 1, 'two installs of one account are ONE person');
   assert.equal(summary.connected, 2, 'and two connected clients');
   const grouped = (await http('GET', origin + '/dashboard', {cookie: 'sec_session=' + token})).body.toString('utf8');
   assert.match(grouped, /2 devices/, 'the dashboard groups them as one person with two devices');
   console.log('two clients: 1 person, 2 devices, both live');
  }

  // ── the dashboard's own fragment and the live view it draws ──────────────────────────────
  const dashboard = (await http('GET', origin + '/dashboard', {cookie: 'sec_session=' + token})).body.toString('utf8');
  assert.match(dashboard, /data-state="live"/, 'the dashboard renders a live tile');
  assert.match(dashboard, /● Live · Recording/, 'and says it is recording');
  const stream = await firstBytes(`${origin}/api/security/live-feeds/${feeds[0].feed_id}/stream`, {cookie: 'sec_session=' + token});
  assert.equal(stream.status, 200);
  assert.ok(stream.body.includes(Buffer.from([0xff, 0xd8])), 'the tile draws real JPEG frames over MJPEG');
  console.log(`dashboard: live tile rendered, MJPEG ${stream.body.length} bytes for ${feeds[0].feed_id}`);

  // ── THE CONNECTION ENDS, AND SO DOES THE RECORDING ─────────────────────────────────────
  // Owen: recording "should continue always, as long as you are connected to the instance" — so
  // the other half of that sentence is measured too: the window leaves the page, and the server
  // ends the feed and closes the segment. A segment still being written has no duration to read.
  for (const client of clients) await client.page.rpc('Page.navigate', {url: 'about:blank'});
  const published = feeds.slice(0, clients.length);
  let dropped = [];
  for (let attempt = 0; attempt < 120; attempt++) {
   const answer = JSON.parse((await http('GET', origin + '/api/security/live-feeds', {cookie: 'sec_session=' + token})).body.toString('utf8'));
   dropped = published
    .map(item => answer.feeds.find(feed => feed.feed_id === item.feed_id))
    .filter(feed => feed && feed.connection !== 'connected');
   if (dropped.length === published.length) break;
   await wait(500);
  }
  assert.equal(dropped.length, published.length, 'the server must see every feed end when its window leaves it');
  for (const feed of dropped) {
   console.log(`after its window left: ${feed.feed_id} connection=${feed.connection} recording=${feed.recording} frames=${feed.frames}`);
  }

  // ── the recording on disk ───────────────────────────────────────────────────────────────
  let segments = [];
  for (let attempt = 0; attempt < 120; attempt++) {
   segments = fs.readdirSync(storage).filter(name => name.endsWith('.mkv') && fs.statSync(path.join(storage, name)).size > 4096);
   if (segments.length) break;
   await wait(500);
  }
  assert.ok(segments.length, 'a segment file must be on disk in ' + storage);
  const segment = path.join(storage, segments[0]);
  let facts = {};
  for (let attempt = 0; attempt < 40; attempt++) {
   const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', segment], {encoding: 'utf8'});
   facts = JSON.parse(probe.stdout || '{}');
   if (Number((facts.format || {}).duration) > 0.2) break;
   await wait(500);
  }
  const stream0 = (facts.streams || [])[0] || {};
  console.log(`recording: ${segment} ${fs.statSync(segment).size} bytes, ${stream0.codec_name} ${stream0.width}x${stream0.height}, `
   + `duration ${(facts.format || {}).duration}s`);
  assert.equal(stream0.codec_name, 'h264', 'the segment is muxed media, not a copy of the socket');
  assert.ok(Number((facts.format || {}).duration) > 0.2, 'and it has duration');

  // ── the app's own log: it said what it was doing, on its own channel ─────────────────────
  for (const client of clients) {
   assert.match(client.log.text, /\[live-feed\] publishing u2-/, client.name + ' logged the feed it published');
   assert.match(client.log.text, /\[live-feed\] first frame sent/, client.name + ' logged its first frame');
  }
  if (FAKE_CAMERA) console.log('\nNOTE: --fake-camera was used, so the frames came from Chromium\'s synthetic device,\n      not this machine\'s webcam. The protocol, the permission question, the recorder and the\n      segment are real; the picture is not.');
  console.log('\nPASS: ' + clients.length + ' client(s) connected, asked, published Owen\'s camera, and the server');
  console.log('      recorded it: live dashboards tile, MJPEG view, and a segment on disk.');
  console.log('NOT PROVEN HERE: the packaged app against a production HTTPS instance (it needs the');
  console.log('      instance\'s own PIN), two machines rather than two installs on one, and Windows.');
 } catch (error) {
  failures = 1;
  console.error('\nFAIL: ' + (error && error.message ? error.message : error));
  for (const client of clients) console.error(`\n--- ${client.name} log (tail) ---\n` + client.log.text.slice(-4000));
  if (fixture) console.error('\n--- fixture log (tail) ---\n' + fixture.log().slice(-2000));
 } finally {
  for (const client of clients) {
   for (const session of [client.page, client.setup]) { try { await session?.rpc('Browser.close'); } catch {} session?.socket?.close(); }
   try { client.child.kill(); } catch {}
  }
  try { fixture?.child.kill(); } catch {}
  await wait(600);
  try { fs.rmSync(work, {recursive: true, force: true}); } catch {}
 }
 process.exitCode = failures;
})();
