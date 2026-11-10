'use strict';
// THE BAR ON THE CLIENT'S OWN SCREENS — the static half of the gate, and the byte-clean half.
//
// Owen, 2026-11-08: "the top nav bar should always be present while logged in via e-app, especially
// during the e-server instance selection screen and such things. Just only the user button is
// available when not connected to an e-server instance :)"
//
// The MEASURED half is tests/shell-bar-journey.cjs — the real document in a real Electron window,
// with the bar's height, the pill's box, the empty right-hand side and the same bar node asserted
// across every state. A browser cannot prove that and a regex cannot either, so this file does not
// pretend to: it holds the two things a screenshot cannot (Diana's sheet is BYTE FOR BYTE hers, and
// the markup is hers too) and points at the journey for the rest.
//
//   xvfb-run -a npx electron --no-sandbox tests/shell-bar-journey.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SHELL = path.join(ROOT, 'desktop', 'shell.html');
const ADAPTER = path.join(ROOT, 'desktop', 'shell-bar-adapter.css');
const BAR = path.join(ROOT, 'desktop', 'vendor', 'launcher', 'theme', 'shell-frame.css');
const MODULE = path.join(ROOT, 'desktop', 'shell.mjs');
const JOURNEY = path.join(ROOT, 'tests', 'shell-bar-journey.cjs');
//: Diana's handoff. The source this file is vendored from, and the check fails closed without it.
const STUDIO = process.env.DIANA_STUDIO || '/home/diana/Documents/handoff/surface-pass';

const read = (file) => fs.readFileSync(file, 'utf8');

test('Diana’s bar sheet is the vendored copy, byte for byte', () => {
  const source = path.join(STUDIO, 'shell-frame.css');
  assert.ok(fs.existsSync(source), `Diana's handoff is not at ${source}; set DIANA_STUDIO rather than skipping this check`);
  assert.ok(fs.existsSync(BAR), 'the client vendors her bar sheet at desktop/vendor/launcher/theme/shell-frame.css');
  const hers = fs.readFileSync(source);
  const ours = fs.readFileSync(BAR);
  assert.equal(ours.equals(hers), true, `the vendored bar sheet has drifted from Diana's (${ours.length} vs ${hers.length} bytes)`);
  // The measurements her NOTES fix, read out of the file rather than remembered: a hand edit here
  // would move the whole product's bar.
  const css = ours.toString('utf8');
  for (const token of ['--sf-bar:56px', '--sf-target:32px', '--sf-account:52px', '--sf-pad:12px', '--sf-gap:4px', '--sf-cluster-gap:12px']) {
    assert.ok(css.includes(token), `her sheet must still declare ${token}`);
  }
  assert.match(css, /body\.shell-frame\s*\{[^}]*grid-template-rows:var\(--sf-bar\) minmax\(var\(--sf-zero\),1fr\)/,
    'the document is her grid: the bar row, then the content row');
});

test('the host difference is ONE adapter, and it holds no geometry of its own', () => {
  assert.ok(fs.existsSync(ADAPTER), 'the adapter is named: desktop/shell-bar-adapter.css');
  const css = read(ADAPTER);
  // THE RULE THAT KEEPS HER ARITHMETIC HERS: no `--sf-*` token is declared outside her sheet, so a
  // future edit cannot quietly move the bar, the pill or the padding from here.
  assert.equal(/--sf-[a-z-]+\s*:/.test(css.replace(/var\(--sf-[a-z-]+\)/g, '')), false,
    'the adapter may READ her tokens and must never declare one');
  // THE BAR IS A ROW, NOT A RE-WRAP (ticket d470ba67): the body is the site's account page, and the
  // adapter adds the row above it. Her sheet's own `body.shell-frame` grid is NOT applied, because
  // that class would also repaint the page's ground.
  assert.match(css, /body\.account\s*\{[^}]*display:\s*grid;[^}]*grid-template-rows:\s*var\(--sf-bar\) minmax\(var\(--sf-zero\),\s*1fr\) auto/,
    'the bar is the document\'s first row and the page is the rows below it');
  assert.match(css, /body\.account > main\.account-main\s*\{[^}]*min-height:\s*var\(--sf-zero\);[^}]*overflow:\s*auto/,
    'the page owns the scrolling in its own row');
  assert.match(css, /\.sf-account \.web-account-face\s*\{/, 'the face inside her pill slot is painted here');
  // No colour is invented: the only literals are the launcher's own face tile values.
  const literals = (css.match(/#[0-9a-f]{3,8}\b/gi) || []).map((value) => value.toLowerCase());
  assert.deepEqual([...new Set(literals)].sort(), ['#536b66', '#eedbb2'],
    'the adapter adds no colour of its own — the teal tile and the cream letter are the launcher’s');
});

test('the document carries Diana’s pre-connection fragment and nothing on the right', () => {
  const html = read(SHELL);
  // THE BODY IS THE SITE'S ACCOUNT PAGE (Owen, 2026-11-09: "use the same thing since it already
  // exists and works and is approved"), and the bar is its first row.
  assert.match(html, /<body class="account" data-account-state="signed-out">/, 'the local document is the site’s account page, and it starts in the signed-out glass mood');
  assert.equal(/shell-local/.test(html), false, 'no wrapper between the body and the card: the page paints itself');
  const body = html.slice(html.indexOf('>', html.indexOf('<body')) + 1);
  const firstElement = body.match(/<(?!\/|!)([a-z0-9-]+)/i)[1].toLowerCase();
  assert.equal(firstElement, 'header', `the bar must be the first thing in the document, found <${firstElement}>`);
  // Her fragment: header.sf-bar > div.sf-left > button.sf-control.sf-account[data-action=account].
  assert.match(html, /<header class="sf-bar" aria-label="Application">/, 'her header, her accessible name');
  assert.match(html, /<div class="sf-left">/, 'her left cluster');
  assert.match(html, /<button class="sf-control sf-account web-account-face-mark" id="account-pill" type="button" data-action="account" aria-label="Account" title="Account">/,
    'the account pill is her control, with her slot filled');
  // THE INNER IDENTITY MARKUP, NOT A NESTED CONTROL: a face span holding the initial and a picture.
  assert.match(html, /<span class="web-account-face" aria-hidden="true"><span class="web-account-initial"><\/span><img class="web-account-picture" alt="" decoding="async" hidden><\/span>/,
    'the pill holds the identity markup, not a second button');
  assert.equal((html.match(/<button/g) || []).length >= 1, true);
  assert.equal(/<button[^>]*>\s*<button/.test(html), false, 'no control may be nested inside the pill');
  // NOTHING ON THE RIGHT: no orb, no marks, no menu, no destinations, no placeholder.
  for (const forbidden of ['sf-right', 'sf-orb', 'sf-menu', 'sf-menu-wrap', 'sf-agents', 'agent-pill', 'swarm-pill', 'processes-pill', 'sf-skip', 'shell-page', 'sf-status']) {
    assert.equal(html.includes(forbidden), false, `the pre-connection bar must not contain ${forbidden}`);
  }
  // The page's own elements follow the bar directly, exactly as the site's document has them.
  assert.match(html, /<a class="account-skip" href="#account-root">Skip to account<\/a>\s*<main class="account-main">/, 'the page’s own skip link and main follow the bar');
  assert.match(html, /<footer class="account-footer">[\s\S]*<\/body>/, 'and the page footer closes the document');
  const order = ['vendor/launcher/theme/account-control.css', 'shell.css', 'vendor/launcher/theme/shell-frame.css', 'shell-bar-adapter.css']
    .map((href) => html.indexOf(href));
  assert.deepEqual(order.every((at) => at > 0), true, 'all four sheets must be linked');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'her sheet loads AFTER the pill sheets, and the adapter after it');
});

test('the client’s hardening is untouched by a local bar', () => {
  const html = read(SHELL);
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(csp, 'the document keeps its CSP meta');
  assert.match(csp[1], /default-src 'none'/);
  assert.match(csp[1], /script-src 'self'/);
  assert.match(csp[1], /style-src 'self'/);
  assert.match(csp[1], /img-src 'self' data:/, 'a face is a data: URI or the app’s own icon — never a remote request');
  assert.match(csp[1], /connect-src 'none'/);
  // No script, no style and no remote asset is added by the bar.
  assert.equal(/<script src="https?:\/\//.test(html), false, 'the bar adds no remote script');
  assert.equal(/style=/.test(html), false, 'the bar adds no inline style, which the CSP would refuse anyway');
});

test('the pill is filled from the account the main process publishes, and never from a URL', () => {
  const source = read(MODULE);
  assert.match(source, /function drawAccountPill\(account\)/, 'one function owns the pill');
  assert.match(source, /drawAccountPill\(state\.account\);/, 'and the state publish is what calls it');
  assert.match(source, /pill\.setAttribute\('aria-label',label\);pill\.title=label;/, 'the accessible name and the tooltip are the account’s name');
  assert.match(source, /account\.picture\.startsWith\('data:image\/png;base64,'\)/,
    'the portrait must be the account document’s own data URI; anything else would be a request the CSP refuses');
  assert.match(source, /picture\.removeAttribute\('src'\)/, 'a signed-out window drops the source rather than leaving a stale face');
  assert.match(source, /id="account-pill"|'account-pill'/, 'the pill is the document’s own id');
  assert.match(source, /\$\('account-pill'\)\.addEventListener\('click',showAccount\)/, 'the pill is a working control');
});

test('the journey that measures all of this is committable and parses', () => {
  assert.ok(fs.existsSync(JOURNEY), 'tests/shell-bar-journey.cjs is the measured half');
  // A CLAIMED GATE IS NOT A RUN: the file that was never parsed is the file that ships broken.
  execFileSync(process.execPath, ['--check', JOURNEY], { stdio: 'pipe' });
  execFileSync(process.execPath, ['--check', path.join(__dirname, 'fixtures', 'shell-bridge.cjs')], { stdio: 'pipe' });
  const journey = read(JOURNEY);
  for (const claim of ['bar height must be Diana', 'the account pill must be 52x32 at x=12 y=12', 'nothing may sit on the right',
    'the bar is the SAME DOM node', 'the document loaded once and stayed', "the pill carries the account name"]) {
    assert.ok(journey.includes(claim), `the journey must still assert: ${claim}`);
  }
  // It runs Electron, so it must NOT be swept up by the app's plain node suite.
  assert.equal(fs.readdirSync(__dirname).includes('shell-bar-journey.test.cjs'), false, 'the journey is not a node --test file');
});
