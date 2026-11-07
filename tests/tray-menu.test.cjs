'use strict';
// THE TRAY MENU IS A PRODUCT DECISION, NOT A PLACE TO PUT A BUTTON.
//
// Owen, 2026-11-07: "e-app system tray icon right click drop down menu options should only be:
// Open / Change server / --- / Sign out / Quit". The menu sits under the pointer of every person
// who leaves the app running, so an item added here is an item offered to everyone forever; and
// because desktop/main.cjs only runs inside Electron, no unit test can open the tray and look at
// it. This gate reads the template the app builds and states its contents exactly, in order.
//
// It fails when an item is added, removed, renamed, reordered or when the separator moves — the
// four ways this menu has already drifted once (it had seven items and two separators: "Open
// e-server", "Change server…", "Sign out of Easter Company", "Cancel sign-in", "Check for
// updates", "Restart to apply update", "Quit").
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'desktop/main.cjs'), 'utf8');

/** The body of `function trayTemplate()`, which is the one place the menu is written. */
function templateBody(source) {
  const start = source.indexOf('function trayTemplate(');
  assert.notEqual(start, -1, 'desktop/main.cjs no longer declares trayTemplate()');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error('trayTemplate() has no closing brace');
}

/** Every entry in order: a label, or the separator sentinel. */
function entries(body) {
  const out = [];
  const pattern = /label:\s*'((?:[^'\\]|\\.)*)'|type:\s*'separator'/g;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    out.push(match[1] === undefined ? '---' : match[1].replace(/\\(.)/g, '$1'));
  }
  return out;
}

test('the tray menu is exactly the owner\'s four items, in his order', () => {
  assert.deepEqual(entries(templateBody(MAIN)), ['Open', 'Change server', '---', 'Sign out', 'Quit']);
});

test('the tray is built from that template and from nothing else', () => {
  // A literal menu beside the template would be the menu the app actually shows while this gate
  // read the other one — the shape of gate that cannot fail.
  assert.match(MAIN, /setContextMenu\(Menu\.buildFromTemplate\(trayTemplate\(\)\)\)/,
    'the tray must build its menu from trayTemplate()');
  const literals = MAIN.match(/Menu\.buildFromTemplate\(\s*\[/g) || [];
  assert.equal(literals.length, 0,
    'a menu template written inline is a menu this gate cannot see');
});

test('the items the owner removed are gone, not hidden', () => {
  const body = templateBody(MAIN);
  for (const gone of ['Cancel sign-in', 'Check for updates', 'Restart to apply update',
    'Open e-server', 'Change server…', 'Sign out of Easter Company']) {
    assert.equal(body.includes(gone), false, `the tray still offers ${JSON.stringify(gone)}`);
  }
});
