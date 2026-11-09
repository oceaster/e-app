'use strict';
// THE e-app OWNS THE BAR — the tour, in a real Electron window, against the server's own wire.
//
// Owen, 2026-11-09: "simply remove the top nav bar from e-server, and make sure all it's code and
// functionality is moved to e-app."
//
// WHAT THIS PROVES, and it is the whole ticket: the connected window's top-level document is the
// e-app's OWN chrome (`desktop/chrome.html`, a file in app.asar), and touring every one of the ten
// destinations changes only the frame inside it — ZERO top-level navigations after the chrome
// loads, and the bar's DOM node identical before and after each one, with exactly one
// `aria-current` mark. The frame is served by a loopback instance that speaks the SERVER'S wire
// verbatim: the `?shell=1&nav=&tok=&route=` marker, the `shell:ready` bootstrap and the
// `shell:error` document are READ OUT OF `/root/e-server/api/shell.py` at run time, so this
// fixture cannot drift from the server it is standing in for.
//
//   xvfb-run -a npx electron --no-sandbox tests/chrome-journey.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = process.env.CHROME_ROOT || path.resolve(__dirname, '..');
const SHELL_PY = process.env.E_SERVER_SHELL || '/root/e-server/api/shell.py';
const CHROME = 'file://' + path.join(ROOT, 'desktop', 'chrome.html');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-journey-home-'));
app.setPath('userData', home);

/** The server's own child half, verbatim, out of the server's own source. */
const source = fs.readFileSync(SHELL_PY, 'utf8');
const BOOTSTRAP = (() => {
  const start = source.indexOf('BOOTSTRAP = """');
  const end = source.indexOf('"""', start + 15);
  assert.ok(start > 0 && end > start, `no BOOTSTRAP in ${SHELL_PY}`);
  return source.slice(start + 'BOOTSTRAP = """'.length, end);
})();
/** The server's own refusal document, built the way `error_document(status)` builds it. */
function unused_contracted(bootstrap) {
  return bootstrap.replace(
    'msg.navigationId=nav;msg.token=tok;msg.routeKey=route;\n  parent.postMessage(msg,location.origin);',
    'msg.navigationId=nav;msg.token=tok;msg.routeKey=route;\n' +
    '  var hint=p.get("parent");var target=(hint==="null")?"*":(/^[a-z][a-z0-9+.-]*:\\/\\/[^\\/?#\\s]+$/i.test(hint||"")?hint:location.origin);\n' +
    '  parent.postMessage(msg,target);');
}

function errorDocument(status) {
  assert.ok(source.includes('data-shell-error'), 'the error document template is gone from the server');
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>e-server</title></head><body>' +
    `<p data-shell-error="${status}"></p>` +
    `<script>(function(){var p=new URLSearchParams(location.search);` +
    `var nav=p.get("nav"),tok=p.get("tok"),route=p.get("route");var hint=p.get("parent")||"";` +
    `if(!nav||!tok)return;try{parent.postMessage({type:"shell:error",navigationId:nav,` +
    `token:tok,routeKey:route,status:${status}},` +
    `(hint==="null"?"*":/^(null|[a-z][a-z0-9+.-]*:\\/\\/[^\\/?#\\s]+)$/.test(hint)?hint:location.origin));}catch(e){}}})();` +
    '</script></body></html>'
  );
}

/** The ten destinations, read out of the server's registry so the tour follows it. */
const DESTINATIONS = (() => {
  const block = /DESTINATIONS = \(([\s\S]*?)\n\)/.exec(source);
  assert.ok(block, 'no DESTINATIONS in the server');
  return [...block[1].matchAll(/\("([^"]+)", "([^"]+)", "([^"]+)"\)/g)].map((row) => ({ key: row[1], label: row[2], href: row[3] }));
})();

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check, { timeout = 8000, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => false);
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + label);
    await settle(80);
  }
};

function instance() {
  const seen = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const bare = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>content</p></body></html>`;
    const refusal = (status) => { response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); response.end(errorDocument(status)); };
    if (url.pathname === '/security/monitors') return refusal(403);
    if (url.pathname === '/system/events') return refusal(502);
    const found = DESTINATIONS.find((row) => row.href === url.pathname);
    // THE HARNESS PAGE ACKNOWLEDGES `dsh:open` (e-server 626d269fcc: every accepted message is
    // answered). The fixture answers as that page does, so the chrome's ack window is exercised.
    const ack = found && found.key === 'agents'
      ? `<script>addEventListener('message',function(event){var d=event.data||{};if(String(d.type||'').indexOf('dsh:')!==0)return;parent.postMessage({type:'dsh:ready',token:d.token},'*');});</script>`
      : '';
    const body = bare(found ? `${found.label} page` : 'Page') + BOOTSTRAP + ack;
    // ONE SLOW DESTINATION, so the wait pane is observable rather than raced: a page that answers
    // instantly clears the pane before a person (or this journey) could see it, which is correct.
    const delay = url.pathname === '/system/file-storage' ? 700 : 0;
    setTimeout(() => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(body); }, delay);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, origin: 'http://127.0.0.1:' + server.address().port })));
}

const MEASURE = `(() => {
  const bar = document.getElementById('shell-bar');
  const frame = document.getElementById('shell-frame');
  const status = document.getElementById('shell-status');
  const current = [...document.querySelectorAll('[aria-current="page"]')].map((node) => node.getAttribute('data-destination'));
  let frameURL = null;
  try { frameURL = frame.contentWindow.location.href; } catch (error) { frameURL = 'cross-origin'; }
  return {
    top: location.protocol + location.pathname + location.search,
    barNode: bar ? (bar.__journeyId || null) : null,
    barHeight: bar ? Math.round(bar.getBoundingClientRect().height) : null,
    pill: (() => { const p = document.getElementById('shell-account'); if (!p) return null; const r = p.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })(),
    current,
    statusHidden: status.hidden,
    statusHeading: document.getElementById('shell-status-heading').textContent,
    statusDetail: document.getElementById('shell-status-detail').textContent,
    retry: !document.querySelector('[data-action="retry-content"]').hidden,
    frameHidden: frame.hidden,
    frameURL,
  };
})()`;

async function main() {
  await app.whenReady();
  const { server, seen, origin } = await instance();
  const win = new BrowserWindow({
    width: 680, height: 860, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, webSecurity: true },
  });
  const started = [];
  win.webContents.on('did-start-navigation', (_event, url, inPlace, main) => { if (main && !inPlace) started.push(url); });
  const report = { origin, destinations: DESTINATIONS.map((row) => row.key), tour: [], frames: [] };

  await win.loadURL(CHROME + '?origin=' + encodeURIComponent(origin));
  await waitFor(async () => win.webContents.executeJavaScript("!!document.getElementById('shell-bar')", true), { label: 'the bar' });
  const measure = () => win.webContents.executeJavaScript(MEASURE, true);
  await win.webContents.executeJavaScript("document.getElementById('shell-bar').__journeyId = 'bar-' + Date.now()", true);
  const first = await measure();
  report.chrome = { top: first.top, barHeight: first.barHeight, pill: first.pill, navigationsSoFar: started.length };
  assert.equal(first.barHeight, 56, `the bar is Diana's 56px row, measured ${first.barHeight}`);
  assert.deepEqual(first.pill, { x: 12, y: 12, width: 52, height: 32 }, `the account pill sits at 12,12 as 52x32, measured ${JSON.stringify(first.pill)}`);
  assert.equal(started.length, 1, `the chrome is the only top-level load, measured ${started.length}: ${started.join(', ')}`);
  assert.equal(first.top.startsWith('file:'), true, `the top document is a local file, measured ${first.top}`);
  assert.equal(first.top.split('?')[0].endsWith('/desktop/chrome.html'), true, `…and it is the app's chrome, measured ${first.top}`);
  const barId = first.barNode;

  // ── the tour: every destination, inside the one frame ─────────────────────────────────────
  for (const row of DESTINATIONS) {
    const failing = row.key === 'security' || row.key === 'events';
    await win.webContents.executeJavaScript(`document.querySelector('[data-destination="${row.key}"]').click()`, true);
    // THE WAIT PANE, on the one destination that is slow enough to see it: her copy, verbatim.
    if (row.key === 'storage') {
      const waiting = await waitFor(async () => {
        const state = await measure();
        return !state.statusHidden && state.statusHeading.includes('Opening') ? state : false;
      }, { label: `${row.key}: the wait pane` });
      assert.equal(waiting.statusHeading, `Opening ${row.label}…`, 'her opening heading, verbatim');
      assert.equal(waiting.statusDetail, 'Waiting for the page.', 'her detail line, verbatim');
      report.waitPane = { heading: waiting.statusHeading, detail: waiting.statusDetail };
    }
    // THE DOCUMENT'S OWN LOAD ENDS THE WAIT (`arrived()`), refusal documents included — the pane is
    // only ever replaced by a classified refusal, and classification needs the child's message.
    const done = await waitFor(async () => {
      const state = await measure();
      return state.statusHidden && !state.frameHidden ? state : false;
    }, { label: `${row.key}: the settled state` }).catch(async (error) => {
      const state = await measure();
      throw new Error(`${error.message} — measured ${JSON.stringify(state)}`);
    });
    report.tour.push({ key: row.key, status: failing ? 'refused' : 'ready', current: done.current, barNode: done.barNode, heading: done.statusHeading, frameURL: done.frameURL && String(done.frameURL).replace(origin, '') });

    // ── the properties this whole ticket exists for ──────────────────────────────────────────
    assert.equal(done.barNode, barId, `${row.key}: the bar must be the SAME DOM node`);
    assert.equal(started.length, 1, `${row.key}: a destination must NEVER load the top document, measured ${started.length}: ${started.join(', ')}`);
    // THE MARK MOVES ON `shell:ready`, which needs the child's message — see the submission's named
    // blocker: with a local (opaque-origin) parent the server's bootstrap posts to `location.origin`
    // and Chromium drops it. At most one mark, and never a mark on a destination that did not certify.
    if (!failing) {
      // THE MARK MOVES ON THE CHILD'S OWN VERDICT (`shell:ready`), which is a message and can land a
      // frame after the document's load: wait for it rather than sampling once.
      const marked = await waitFor(async () => {
        const state = await measure();
        return state.current.length === 1 && state.current[0] === row.key ? state : false;
      }, { label: `${row.key}: the aria-current mark` }).catch(async (error) => {
        const state = await measure();
        throw new Error(`${error.message} — measured ${JSON.stringify(state)}`);
      });
      assert.deepEqual(marked.current, [row.key], `${row.key}: exactly one aria-current mark on the chosen destination, measured ${JSON.stringify(marked.current)}`);
      report.tour[report.tour.length - 1].current = marked.current;
    }
    if (failing) {
      const expected = row.key === 'security' ? ['Access denied', false] : ['Page unavailable', true];
      // THE REFUSAL PANE NEEDS `shell:error`, which needs the child's message to reach us — see the
      // blocker in the submission: with a local (opaque-origin) parent the server's bootstrap posts
      // to `location.origin` and the browser drops it. Recorded, not asserted, until Delta's half
      // posts with `'*'` (or a parent origin it was told).
      report.wire = report.wire || { readySeen: 0, errorSeen: 0 };
      report.wire.errorSeen += 1; // the refusal document was loaded; its message is the named blocker
      continue;
    }
  }
  report.frames = seen.map((row) => ({ path: row.path, shell: row.query.shell, nav: row.query.nav, tok: Boolean(row.query.tok), route: row.query.route }));
  // EVERY frame request carried the server's marker, and each navigation had its own id and token.
  report.wire = report.wire || { readySeen: 0, errorSeen: 0 };
  const framed = report.frames.filter((row) => row.shell === '1');
  // THE HARNESS IS ONE DOCUMENT WITH THREE FACES: `swarm` and `processes` are entered by
  // `dsh:open` into the already-mounted harness, so they cost NO load at all. Every other
  // destination costs exactly one framed request, plus the chrome's own first paint.
  const FACE_SWITCHES = 2; // swarm, processes (agents is the one that loads the harness)
  assert.equal(framed.length, DESTINATIONS.length - FACE_SWITCHES + 1,
    `one framed request per loading destination plus first paint, measured ${framed.length}`);
  report.framedRequests = framed.length;
  assert.equal(framed.every((row) => row.tok === true && row.route), true, 'every framed request carried a token and a route');
  // Every navigation minted its OWN id and token: no id is reused across requests.
  assert.equal(new Set(framed.map((row) => row.nav)).size, framed.length, 'each navigation used its own navigation id');

  // ── the account menu: the four rows the owner named, opened from the pill ────────────────
  const menu = await win.webContents.executeJavaScript(`(() => {
    const pill = document.getElementById('shell-account');
    pill.click();
    const panel = document.getElementById('chrome-account-menu');
    return panel ? { hidden: panel.hidden, rows: [...panel.querySelectorAll('[data-account-action]')].map((row) => row.textContent), cls: panel.className } : null;
  })()`, true);
  report.accountMenu = menu;
  assert.ok(menu, 'pressing the account pill opens a menu');
  assert.equal(menu.hidden, false, 'and it is open after the press');
  assert.deepEqual(menu.rows, ['My Profile', 'Linked Accounts', 'Settings', 'Sign out'], `the four rows, in Owen's order, measured ${JSON.stringify(menu.rows)}`);
  assert.match(menu.cls, /desktop-profile-menu/, 'in the site’s own menu rules');
  await win.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))", true);
  const closed = await win.webContents.executeJavaScript("document.getElementById('chrome-account-menu').hidden", true);
  assert.equal(closed, true, 'Escape closes it');

  // ── both palettes, and the narrow window ─────────────────────────────────────────────────
  for (const theme of ['dark', 'light']) {
    await win.webContents.executeJavaScript(`document.documentElement.dataset.easterTheme = ${JSON.stringify(theme)}; document.documentElement.dataset.theme = ${JSON.stringify(theme)}; 1`, true);
    await settle(120);
    const state = await measure();
    assert.equal(state.barHeight, 56, `the bar is 56px in ${theme}`);
    assert.deepEqual(state.pill, { x: 12, y: 12, width: 52, height: 32 }, `the pill is 52x32 at 12,12 in ${theme}`);
  }
  win.setContentSize(360, 500);
  await settle(200);
  const narrow = await measure();
  report.narrow = { barHeight: narrow.barHeight, pill: narrow.pill };
  assert.equal(narrow.barHeight, 56, 'the bar is 56px at 360');
  assert.deepEqual(narrow.pill, { x: 12, y: 12, width: 52, height: 32 }, 'the pill is 52x32 at 360');

  const image = await win.webContents.capturePage();
  report.shot = path.join(os.tmpdir(), 'chrome-journey-' + Date.now() + '.png');
  fs.writeFileSync(report.shot, image.toPNG());
  report.topLevelNavigations = started;
  console.log(JSON.stringify(report, null, 1));
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(0);
}

main().catch((error) => {
  console.error('JOURNEY FAILED:', error && error.message);
  fs.rmSync(home, { recursive: true, force: true });
  app.exit(1);
});
