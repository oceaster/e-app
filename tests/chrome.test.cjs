'use strict';
// THE e-app's OWN CHROME — the static half: her files are hers, the wire is the frozen contract,
// and this privileged document is boxed exactly as Delta's security requirement says.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file));
const CHROME = read('desktop/chrome.html').toString('utf8');
const HOST = read('desktop/chrome-host.js').toString('utf8');
const MAIN = read('desktop/main.cjs').toString('utf8');
const E_SERVER = process.env.E_SERVER_ROOT || '/root/e-server';

test('Diana’s bar markup and her sheet are the e-server copies, byte for byte', () => {
  for (const [mine, theirs] of [
    ['desktop/vendor/launcher/theme/shell-frame.html', 'api/profile_assets/shell-frame.html'],
    ['desktop/vendor/launcher/theme/shell-frame.css', 'api/profile_assets/shell-frame.css'],
  ]) {
    const source = path.join(E_SERVER, theirs);
    assert.ok(fs.existsSync(source), `the source is missing: ${source}`);
    assert.equal(read(mine).equals(fs.readFileSync(source)), true, `${mine} has drifted from ${theirs} — re-vendor it, never edit the copy`);
  }
});

test('the chrome document is boxed: its own CSP, and the connected window’s sandbox', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(CHROME);
  assert.ok(csp, 'the chrome carries a CSP meta of its own');
  for (const rule of ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:"]) {
    assert.ok(csp[1].includes(rule), `the chrome CSP must carry ${rule}`);
  }
  // THE ONE ADDITION, named: a document whose whole job is to frame the instance must allow the
  // frame. It is bounded to https plus loopback (the journey's fixture), never `*`.
  assert.match(csp[1], /frame-src https: http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*/);
  assert.equal(/"\*"|frame-src \*/.test(csp[1]), false, 'no wildcard in the chrome CSP');
  assert.match(MAIN, /nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false/,
    'the connected window keeps nodeIntegration:false, contextIsolation:true and sandbox:true');
  assert.match(MAIN, /current\.webContents\.on\('will-attach-webview',event=>event\.preventDefault\(\)\);/);
});

test('the frozen parent contract: one hint, and the three checks before a message is believed', () => {
  // §1 the chrome appends exactly one parameter, on every framed URL
  assert.match(HOST, /\+"&parent="\+encodeURIComponent\(PARENT_HINT\)/);
  assert.ok(HOST.includes('var PARENT_HINT='), 'the hint is computed once');
  assert.ok(HOST.includes('?location.origin:"null";'), 'a real origin is used when there is one, else the literal null');
  // §3 the three checks: source, the INSTANCE origin (never location.origin), token AND navigation id
  assert.match(HOST, /if\(event\.origin!==SERVER_ORIGIN\)return;/);
  assert.match(HOST, /if\(!frame\.contentWindow\|\|event\.source!==frame\.contentWindow\)return;/);
  assert.match(HOST, /if\(String\(data\.token\|\|""\)!==nav\.token\|\|String\(data\.navigationId\|\|""\)!==String\(nav\.id\)\)return;/);
  assert.equal(/event\.origin!==location\.origin/.test(HOST), false, 'the chrome must never compare against its own (opaque) origin');
  // §4 chrome → frame is strict: the instance origin, never '*'
  assert.match(HOST, /function dshOpen\(surface\)\{/);
  assert.match(HOST, /frame\.contentWindow\.postMessage\(intent,SERVER_ORIGIN\)/);
  assert.equal(/postMessage\([^)]*,'\*'\)/.test(HOST), false, 'the chrome never posts with a wildcard');
  // and the trusted verifier the ported controller keeps
  assert.match(HOST, /arrived\(\)|function arrived\(\)/);
  assert.match(HOST, /TIMEOUT_MS/);
});

test('the controller is the server’s, ported — not a second design', () => {
  const source = fs.readFileSync(path.join(E_SERVER, 'api/shell.py'), 'utf8');
  const block = /DESTINATIONS = \(([\s\S]*?)\n\)/.exec(source)[1];
  const rows = [...block.matchAll(/\("([^"]+)", "([^"]+)", "([^"]+)"\)/g)];
  assert.equal(rows.length, 10, 'ten destinations');
  for (const [, key, label, href] of rows) {
    assert.ok(HOST.includes(`["${key}","${label}","${href}"]`) || HOST.includes(`"${key}", "${label}", "${href}"`),
      `the ported controller still carries ${key} → ${href}`);
    assert.ok(CHROME.includes(`data-destination="${key}"`) && CHROME.includes(`href="${href}"`),
      `the chrome markup still carries ${key} → ${href}`);
  }
  const copy = (/COPY = (\{[\s\S]*?\n\})/.exec(source) || [null, ''])[1];
  for (const line of copy.split('\n')) {
    const m = /^\s*"([^"]+)": \(?"([^"]+)"/.exec(line);
    if (m) assert.ok(HOST.includes(m[2]), `her copy is carried verbatim: ${m[2]}`);
  }
  assert.match(HOST, /READY|TIMEOUT_MS=15000|var COPY=/);
});
