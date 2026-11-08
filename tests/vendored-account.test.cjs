'use strict';
// THE SIGN-IN SCREEN IS THE HOUSEHOLD'S PAGE, IN BOTH THEMES, OR THIS FAILS.
//
// desktop/shell.html renders site/account/index.html's markup; desktop/vendor/launcher/account/
// holds the page's own sheet and its Microsoft half; desktop/vendor/launcher/theme/ holds the
// site's light palette (Diana's), the light adapter (Delta's) and the sheet that paints the wait
// mark. Every one of them is copied verbatim from the site - the household rule, and the
// 2026-10-28 repair, is "copy the file, cmp it, and put every difference in an adapter of your
// own". Before this gate the copies were unguarded, so a hand edit to a vendored file was
// invisible until a person noticed the client had drifted from the site again - which is exactly
// how the client ended up with 27 rules for a sign-in card that shared nothing with the page's 51,
// and then shipped a light-mode screen that ignored the theme.
//
// It fails closed: no site checkout, no pass. The comparison is the check.
//
// The chain this gate holds is the short one, deliberately: the client's copy is held to the
// SITE's copy, and the site's copy is held to Diana's studio file by the launcher repository's own
// tests/test_launcher_light.py. Neither gate is a second author of the other's promise.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');

const ROOT=path.resolve(__dirname,'..');
//: The launcher site, the one checkout these files are vendored from. Overridable for a checkout
//: that lives elsewhere, never silently skippable.
const SITE=process.env.EASTER_SITE||'/root/easter-co-smp.github.io';
//: (source in the site, copy in this repository) - every file the client serves from the page.
const VENDORED=[
 ['site/account/account.css','desktop/vendor/launcher/account/account.css'],
 ['site/account/microsoft-signin.mjs','desktop/vendor/launcher/account/microsoft-signin.mjs'],
 ['site/signin-options.mjs','desktop/vendor/launcher/signin-options.mjs'],
 // The household theme and the launcher's bridge onto it, the palette, the adapter that makes the
 // account card and the wiki work, the sheet that owns .wait-feedback-mark, and the pre-paint
 // script that publishes the attribute all of them are scoped to.
 ['site/theme.css','desktop/vendor/launcher/theme/theme.css'],
 ['site/launcher-bindings.css','desktop/vendor/launcher/theme/launcher-bindings.css'],
 ['site/launcher-light.css','desktop/vendor/launcher/theme/launcher-light.css'],
 ['site/launcher-light-adapter.css','desktop/vendor/launcher/theme/launcher-light-adapter.css'],
 ['site/account-control.css','desktop/vendor/launcher/theme/account-control.css'],
 ['site/theme-early.js','desktop/vendor/launcher/theme/theme-early.js'],
];
//: The class names the client's own card used to spell, and the palette it used to bring. Not one
//: of them may return to desktop/shell.css: the page's sheet paints these, and a rule here would
//: be a second author of the same control.
const RETIRED=['.company-signin','.company-microsoft','.company-provider','.company-provider-note','.company-submit','.company-error','.company-no-reset','.company-forgot','.eyebrow'];
const RETIRED_PALETTE=['--bg','--card','--accent','--border','--text','--muted'];
//: The four host tokens the account control's sheet reads. On the site, site/web.js puts
//: `.web-mode` on <html> and site/launcher-bindings.css declares them for that class; this window
//: has no such class, so it declares the same four itself - as ALIASES onto the household theme's
//: --ec-* names, mapped exactly as the bridge maps them. A value here would be a second palette.
const HOST_TOKENS=['--app-panel','--app-border','--app-muted','--app-gold'];
//: The accent family, and the two moods one rule has to cover.
const ACCENT_TOKENS=['--ec-accent','--ec-accent-action','--ec-accent-hover','--ec-on-accent'];
//: The site's own markup for the panel, element for element (site/account/index.html).
// THE ONE CLASS THE CLIENT MOVES. The site paints the page's ground, tokens and flex column on
// `body.account`; this window's body is Diana's 56px/1fr shell frame (ticket e4ab1146), so the class
// sits on the wrapper that occupies her second grid row instead - the same element-level rules, one
// element in. Nothing in the site's sheet selects `body` itself (checked in account.css and
// launcher-light-adapter.css), which is what makes the move safe.
const MARKUP=[['div.shell-local.account',/class="shell-local account"[^>]*id="shell-local"/],['main.account-main',/class="account-main"/],['div#account-panel',/class="account-panel"[^>]*id="account-panel"/],['p.account-overline',/class="account-overline"/],['h1.account-heading',/class="account-heading"/],['p#account-wait',/class="account-wait"[^>]*id="account-wait"/],['div#account-error',/class="account-error"[^>]*id="account-error"/],['div#account-root',/class="account-body"[^>]*id="account-root"/]];

function read(file){return fs.readFileSync(file);}
//: The first byte the copy disagrees with, spoken the way a person can act on: offset, line, and
//: both bytes. e-server's check_vendored_account.py has said this since 2026-10-28; this is the
//: same sentence in node:test.
function difference(source,copy){
 const limit=Math.min(source.length,copy.length);
 for(let at=0;at<limit;at++)if(source[at]!==copy[at]){
  const line=source.subarray(0,at).toString('utf8').split('\n').length;
  return `first difference at byte ${at} (line ${line}): the site has 0x${source[at].toString(16).padStart(2,'0')}, the copy has 0x${copy[at].toString(16).padStart(2,'0')}`;
 }
 return `identical up to byte ${limit}, lengths ${source.length} (site) and ${copy.length} (copy)`;
}

// THE MANIFEST IS THE CHECK THAT RUNS EVERYWHERE. The comparison against the checkout above can
// only run on a machine that has the site beside this repository; CI does not, and a gate that
// fails there for want of a checkout is a red build on every release, not a guard. So the copies
// carry their own sha256s: the manifest is regenerated when a file is re-vendored, and it holds on
// every machine, the runner included. Where the checkout IS present the bytes are compared too,
// because a manifest records what somebody typed and the site records what is true.
function manifest(){
 const text=fs.readFileSync(path.join(ROOT,'desktop/vendor/launcher/VENDORED.sha256'),'utf8');
 const rows=new Map();
 for(const line of text.split('\n')){
  const match=/^([a-f0-9]{64})\s+(\S+)\s+\((\S+)\)/.exec(line.trim());
  if(match)rows.set(match[2],{sha:match[1],source:match[3]});
 }
 return rows;
}

test('every vendored file matches the manifest, on any machine',()=>{
 const rows=manifest();
 for(const [source,copy] of VENDORED){
  const row=rows.get(copy);
  assert.ok(row,`desktop/vendor/launcher/VENDORED.sha256 does not name ${copy} - every copy is recorded there, so CI can hold it too`);
  assert.equal(row.source,source,`the manifest says ${copy} comes from ${row.source}, the suite says ${source}`);
  const digest=require('node:crypto').createHash('sha256').update(read(path.join(ROOT,copy))).digest('hex');
  assert.equal(digest,row.sha,`${copy} no longer matches the manifest (expected ${row.sha}, found ${digest}) - re-vendor it and regenerate VENDORED.sha256, never edit the copy`);
 }
});

test('the copies are the site\'s own bytes wherever the site checkout is available',(t)=>{
 if(!fs.existsSync(SITE)){
  t.diagnostic(`no site checkout at ${SITE}: the manifest is the check on this machine (it holds on the runner too)`);
  return;
 }
 for(const [source,copy] of VENDORED){
  assert.ok(fs.existsSync(path.join(SITE,source)),`cannot scan: ${source} is missing from ${SITE}`);
  const site=read(path.join(SITE,source)),vendored=read(path.join(ROOT,copy));
  assert.equal(site.equals(vendored),true,`${copy} drifted from ${source}, ${difference(site,vendored)} - re-vendor it (cp ${path.join(SITE,source)} ${copy}), never edit the copy`);
 }
});

test('the client\'s own sheet restates none of the page\'s controls',()=>{
 const sheet=fs.readFileSync(path.join(ROOT,'desktop/shell.css'),'utf8');
 const found=RETIRED.filter(name=>sheet.includes(name));
 assert.deepEqual(found,[],`desktop/shell.css declares ${found.join(', ')} - the page's account.css owns those controls; delete the rule rather than restating it`);
});

test('the client\'s own sheet brings no second palette',()=>{
 const sheet=fs.readFileSync(path.join(ROOT,'desktop/shell.css'),'utf8');
 const declared=RETIRED_PALETTE.filter(token=>new RegExp('(^|[;{\\s])'+token.replace(/-/g,'\\-')+'\\s*:').test(sheet));
 assert.deepEqual(declared,[],`desktop/shell.css declares its own ${declared.join(', ')} token(s) - the account page's five --account-* tokens are the only palette this window has`);
 // Every colour this window shows comes from the household theme through the launcher's bridge,
 // so there is no literal of any kind left to allow here.
 const painted=[...sheet.matchAll(/:[^;{}]*?(#[0-9a-fA-F]{3,8})(?![\w-])/g)].map(match=>match[1]);
 assert.deepEqual(painted,[],`desktop/shell.css paints ${painted.join(', ')} - a colour literal here is a second palette; read the theme's --ec-* tokens instead`);
});

test('the four host tokens are the bridge\'s aliases, not values this window chose',()=>{
 const bridge=fs.readFileSync(path.join(ROOT,'desktop/vendor/launcher/theme/launcher-bindings.css'),'utf8');
 const sheet=fs.readFileSync(path.join(ROOT,'desktop/shell.css'),'utf8');
 const mapping=text=>Object.fromEntries([...text.matchAll(/(--app-(?:panel|border|muted|gold)):\s*var\((--ec-[a-z-]+)\)/g)].map(match=>[match[1],match[2]]));
 const published=mapping(bridge),supplied=mapping(sheet);
 for(const token of HOST_TOKENS){
  assert.ok(published[token],`the launcher's bridge no longer maps ${token} onto a theme token`);
  assert.ok(supplied[token],`desktop/shell.css does not alias ${token}, which the account control's own sheet reads`);
  assert.equal(supplied[token],published[token],`desktop/shell.css maps ${token} onto ${supplied[token]} where the launcher's bridge maps it onto ${published[token]}`);
 }
});

test('the household theme is the only author of the accent, in both moods',()=>{
 const theme=fs.readFileSync(path.join(ROOT,'desktop/vendor/launcher/theme/theme.css'),'utf8');
 const block=selector=>{const at=theme.indexOf(selector);assert.notEqual(at,-1,`the theme no longer declares ${selector}`);const open=theme.indexOf('{',at),close=theme.indexOf('}',open);return theme.slice(open,close);};
 const dark=block(':root{'),light=block('html[data-easter-theme="light"]{');
 for(const token of ACCENT_TOKENS){
  assert.match(dark,new RegExp(token.replace(/-/g,'\\-')+':#'),`the theme's dark mood no longer declares ${token}`);
  assert.match(light,new RegExp(token.replace(/-/g,'\\-')+':#'),`the theme's light mood no longer declares ${token}`);
 }
 const accent=text=>(/--ec-accent-action:(#[0-9a-fA-F]{3,8})/.exec(text)||[])[1];
 assert.notEqual(accent(dark),accent(light),'one rule, two moods: the dark accent and the light accent must not be the same colour');
 const sheet=fs.readFileSync(path.join(ROOT,'desktop/shell.css'),'utf8');
 assert.doesNotMatch(sheet,/--ec-accent[a-z-]*:\s*#/,'desktop/shell.css declares an accent value of its own; it reads the theme\'s');
});

test('the sign-in screen is the site\'s markup, so the site\'s classes do the painting',()=>{
 const page=fs.readFileSync(path.join(ROOT,'desktop/shell.html'),'utf8');
 for(const [name,pattern] of MARKUP)assert.match(page,pattern,`desktop/shell.html does not render ${name}`);
 assert.match(page,/href="vendor\/launcher\/account\/account\.css"/,'desktop/shell.html does not load the page\'s own sheet');
});

test('the theme is the site\'s: its palette, its adapter and its pre-paint script, in its order',()=>{
 const page=fs.readFileSync(path.join(ROOT,'desktop/shell.html'),'utf8');
 const head=page.split('</head>')[0];
 const at=fragment=>{const index=head.indexOf(fragment);assert.notEqual(index,-1,`desktop/shell.html's head is missing ${fragment}`);return index;};
 const theme=at('href="vendor/launcher/theme/theme.css"');
 const account=at('href="vendor/launcher/account/account.css"');
 const palette=at('href="vendor/launcher/theme/launcher-light.css"');
 const adapter=at('href="vendor/launcher/theme/launcher-light-adapter.css"');
 const bindings=at('href="vendor/launcher/theme/launcher-bindings.css"');
 const control=at('href="vendor/launcher/theme/account-control.css"');
 const own=at('href="shell.css"');
 at('src="vendor/launcher/theme/theme-early.js"');
 // The household theme comes first because it is the canonical token set; the launcher's bridge
 // comes after every sheet that still declares a legacy literal, so it wins; and this window's own
 // sheet comes last. The same order site/account/index.html uses, for the same reason.
 assert.ok(theme<account,`the household theme must load before the sheets that read it: theme.css@${theme}, account.css@${account}`);
 assert.ok(account<palette&&palette<adapter&&adapter<bindings&&bindings<own,`the sheets load out of order: account.css@${account}, launcher-light.css@${palette}, launcher-light-adapter.css@${adapter}, launcher-bindings.css@${bindings}, shell.css@${own}`);
 assert.ok(control<own,'account-control.css (the wait mark) must load before this window\'s own sheet');
 // The pre-paint script is the whole theme contract: without it nothing ever sets the attribute
 // every light rule is scoped to, and the window silently paints dark for a light desktop.
 assert.ok(head.indexOf('theme-early.js')>own,'theme-early.js belongs after the sheets, where every site page puts it');
});
