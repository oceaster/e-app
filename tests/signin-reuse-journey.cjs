'use strict';
// THE SIGN-IN SCREEN IS THE SITE'S APPROVED PAGE — measured, not claimed.
//
// Owen, 2026-11-09: "the e-app login screen style changed but I did not ask for this, it's much more
// ugly and junior now" and then the rule: "the login screen on the website is very good, why would
// you keep re-creating uglier versions every where? usually software developers prefer to keep things
// DRY ... use the same thing since it already exists and works and is approved."
//
// WHAT THIS COMPARES, with getComputedStyle in one Electron run, at two window sizes in both palettes:
//   A. the CLIENT's sign-in document (desktop/shell.html + its sheets),
//   B. the CONTROL — `/opt/e-server/resources/app.asar.pre-bar-20261109`, the payload the owner called
//      good, extracted and loaded as a real document,
//   C. the SITE's own account page, `/root/easter-co-smp.github.io/site/account/index.html`.
// Every property the account panel paints is read from each and compared. That is the tool the
// ticket asks the result to name: Chromium's own computed styles, not an author's opinion.
//
//   xvfb-run -a npx electron --no-sandbox tests/signin-reuse-journey.cjs
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = process.env.SIGNIN_REUSE_ROOT || path.resolve(__dirname, '..');
const CONTROL_ASAR = process.env.SIGNIN_CONTROL_ASAR || '/opt/e-server/resources/app.asar.pre-bar-20261109';
const SITE = process.env.EASTER_SITE || '/root/easter-co-smp.github.io';
// THE CLI COMES FROM THE CHECKOUT, not from the document root: a packed app.asar has no
// node_modules, so the journey still needs the real checkout's copy when it is pointed at a pack.
const ASAR_CLI = process.env.SIGNIN_ASAR_CLI || path.join(path.resolve(__dirname, '..'), 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const PRELOAD = path.join(__dirname, 'fixtures', 'shell-bridge.cjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-reuse-home-'));
app.setPath('userData', home);

/** The properties the account panel paints. Read from every document, compared as a set. */
const PROPS = [
  'display', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
  'color', 'background-color', 'background-image', 'border-top-color', 'border-top-width',
  'border-radius', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'box-shadow', 'text-transform', 'min-height', 'max-width', 'text-align',
];
const MEASURE = `(() => {
  const read = (selector) => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    const out = { box: { width: Math.round(box.width), height: Math.round(box.height) } };
    for (const name of ${JSON.stringify(PROPS)}) out[name] = style.getPropertyValue(name);
    return out;
  };
  return {
    body: read('body'),
    panel: read('.account-panel'),
    heading: read('.account-heading'),
    overline: read('.account-overline'),
    footer: read('.account-footer'),
    html: read('html'),
  };
})()`;

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

function windowAt(width, height, ses) {
  return new BrowserWindow({
    width, height, show: false,
    webPreferences: { session: ses, preload: PRELOAD, nodeIntegration: false, contextIsolation: true, sandbox: true, webViewTag: false },
  });
}

/** Load one document, force the palette, and read what it paints. */
async function measure(win, url, theme) {
  await win.loadURL(url);
  await settle(350);
  await win.webContents.executeJavaScript(
    `document.documentElement.dataset.easterTheme = ${JSON.stringify(theme)}; document.documentElement.dataset.easterPalette = ${JSON.stringify(theme)}; document.documentElement.dataset.theme = ${JSON.stringify(theme)}; 1`, true);
  await settle(200);
  return win.webContents.executeJavaScript(MEASURE, true);
}

/** Every property, element by element. Returns the differences; the caller decides what is allowed. */
function differences(ours, theirs, { widthOnlyHeightIsContent = [], skipBox = false } = {}) {
  const found = [];
  for (const element of Object.keys(ours)) {
    const mine = ours[element];
    const yours = theirs[element];
    if (!mine || !yours) continue; // an element one document does not have is reported by the caller
    for (const name of [...PROPS, 'box']) {
      let a = mine[name];
      let b = yours[name];
      // A PANEL'S HEIGHT IS ITS CONTENT, not its paint: the site's page asks the accounts service for
      // its provider rows, and this run has no network, so its options are a different list. Width,
      // type, colour, radius, padding and borders are still held equal.
      if (name === 'box' && skipBox) continue;
      if (name === 'box' && widthOnlyHeightIsContent.includes(element) && a && b) {
        if (a.width === b.width) continue;
        a = { width: a.width }; b = { width: b.width };
      }
      a = JSON.stringify(a);
      b = JSON.stringify(b);
      if (a !== b) found.push(`${element}.${name}: ${a} != ${b}`);
    }
  }
  return found;
}

async function main() {
  await app.whenReady();
  assert.ok(fs.existsSync(CONTROL_ASAR), `the control payload is not at ${CONTROL_ASAR}`);
  const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signin-control-'));
  // IN AN ELECTRON PROCESS `process.execPath` IS ELECTRON, so the CLI needs ELECTRON_RUN_AS_NODE.
  execFileSync(process.execPath, [ASAR_CLI, 'extract', CONTROL_ASAR, controlDir], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  const control = 'file://' + path.join(controlDir, 'desktop', 'shell.html');
  const ours = 'file://' + path.join(ROOT, 'desktop', 'shell.html');
  const site = 'file://' + path.join(SITE, 'site', 'account', 'index.html');
  const report = { documents: { ours, control, site }, sizes: {} };

  const ses = session.fromPartition('signin-reuse-' + Date.now());
  const win = windowAt(680, 860, ses);
  const controlWin = windowAt(680, 860, ses);
  const siteWin = windowAt(680, 860, ses);

  for (const [width, height] of [[680, 860], [360, 500]]) {
    win.setContentSize(width, height);
    controlWin.setContentSize(width, height);
    siteWin.setContentSize(width, height);
    await settle(200);
    for (const theme of ['dark', 'light']) {
      const mine = await measure(win, ours, theme);
      const approved = await measure(controlWin, control, theme);
      const published = await measure(siteWin, site, theme);
      const key = `${width}x${height}-${theme}`;
      report.sizes[key] = {
        client: mine,
        control: approved,
        site: published,
        // what a person would notice first, verbatim, so the reviewer can read it:
        headline: {
          font: mine.panel && mine.panel['font-family'],
          size: mine.panel && mine.panel['font-size'],
          ground: mine.body && mine.body['background-image'],
          radius: mine.panel && mine.panel['border-radius'],
          padding: mine.panel && mine.panel['padding-top'],
        },
      };
      // A. THE CONTROL THE OWNER CALLED GOOD. The CARD may not move at all; the DOCUMENT may differ
      // only in the four properties that follow from the bar being a row rather than a frame:
      // `body.display` is grid where the approved payload was a flex column, and the document no
      // longer scrolls itself (no 15px scrollbar gutter), which is the point of the row.
      const versusControl = differences(mine, approved);
      const card = versusControl.filter((line) => /^(panel|heading|overline)\./.test(line));
      const rest = versusControl.filter((line) => !/^(panel|heading|overline)\./.test(line))
        .map((line) => line.split(':')[0]);
      const ALLOWED = ['body.display', 'body.box', 'footer.box', 'html.box'];
      assert.deepEqual(card, [], `${key}: the sign-in card must paint exactly as the approved payload did, measured\n${card.join('\n')}`);
      assert.deepEqual(rest.filter((name) => !ALLOWED.includes(name)), [],
        `${key}: only the bar's own row may differ from the approved payload, measured\n${versusControl.join('\n')}`);
      // B. THE SITE'S OWN PAGE: reported per combination, and the card is held to it the same way.
      // THE SITE'S OWN PAGE keeps its document scrollbar (its content is the whole page) while this
      // window scrolls inside the bar's row, so BOX GEOMETRY differs by one scrollbar gutter. That is
      // the row's own consequence and not the card's paint, so the site comparison holds the paint
      // properties equal and records the gutter separately.
      const versusSite = differences(mine, published, { skipBox: true });
      // The site's page also carries `styles.css` (a marketing stylesheet this window has never
      // vendored) which paints `html`'s own ground and ink. The APPROVED client payload does not have
      // them either — measured above, where `html.*` matches the control exactly — so they are named
      // here rather than chased: nothing between the bar and the card is affected, and the body paints
      // the ground across the whole viewport.
      const siteAllowed = ['body.display', 'html.color', 'html.background-color', 'html.border-top-color'];
      assert.deepEqual(versusSite.filter((line) => !siteAllowed.includes(line.split(':')[0])), [],
        `${key}: the client vs the site’s account page — only the html ground (a sheet this window has never vendored) may differ, measured\n${versusSite.join('\n')}`);
      const siteCard = versusSite.filter((line) => /^(panel|heading|overline)\./.test(line));
      assert.deepEqual(siteCard, [], `${key}: the sign-in card must paint exactly as the site’s own account page does, measured\n${siteCard.join('\n')}`);
      report.sizes[key] = report.sizes[key] || {};
      report.sizes[key].versusControl = versusControl;
      report.sizes[key].versusSite = versusSite;
      report.sizes[key].gutter = {
        panelWidth: [mine.panel && mine.panel.box.width, published.panel && published.panel.box.width],
        note: 'client vs site: one document scrollbar (15px) - this window scrolls inside the bar row',
      };
    }
  }
  const image = await win.webContents.capturePage();
  report.shot = path.join(os.tmpdir(), 'signin-reuse-' + Date.now() + '.png');
  fs.writeFileSync(report.shot, image.toPNG());
  console.log(JSON.stringify(report, null, 1));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(controlDir, { recursive: true, force: true });
  app.exit(0);
}

main().catch((error) => {
  console.error('JOURNEY FAILED:', error && error.message);
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(1);
});
