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
 // The theme: the palette, the adapter that makes the account card and the wiki work in it, the
 // sheet that owns .wait-feedback-mark, and the pre-paint script that publishes the attribute all
 // three of them are scoped to.
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
//: The four host tokens site/web.css publishes under `.web-mode` and site/web.js puts on <html>.
//: The account control's sheet reads them, so the client supplies the same four values - copied,
//: never chosen here - in its own base block.
const HOST_TOKENS=['--app-panel','--app-border','--app-muted','--app-gold'];
//: The site's own markup for the panel, element for element (site/account/index.html).
const MARKUP=[['<body class="account">',/body\b[^>]*class="account"/],['main.account-main',/class="account-main"/],['div#account-panel',/class="account-panel"[^>]*id="account-panel"/],['p.account-overline',/class="account-overline"/],['h1.account-heading',/class="account-heading"/],['p#account-wait',/class="account-wait"[^>]*id="account-wait"/],['div#account-error',/class="account-error"[^>]*id="account-error"/],['div#account-root',/class="account-body"[^>]*id="account-root"/]];

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

test('the site checkout the copies come from is readable, so the comparison is a comparison',()=>{
 assert.ok(fs.existsSync(SITE),`cannot scan: the launcher site is not at ${SITE} - this gate compares copies against it and never passes without it`);
 for(const [source] of VENDORED)assert.ok(fs.existsSync(path.join(SITE,source)),`cannot scan: ${source} is missing from ${SITE}`);
});

test('every vendored file is the site\'s, byte for byte',()=>{
 for(const [source,copy] of VENDORED){
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
 // The four host tokens are allowed to carry values, because they are the site's: they are
 // compared against site/web.css below. Everything else in this file must be a var().
 const withoutHostTokens=sheet.replace(/--app-(?:panel|border|muted|gold):#[0-9a-fA-F]{3,8}/g,'');
 const painted=[...withoutHostTokens.matchAll(/:[^;{}]*?(#[0-9a-fA-F]{3,8})(?![\w-])/g)].map(match=>match[1]);
 assert.deepEqual(painted,[],`desktop/shell.css paints ${painted.join(', ')} - a colour literal here is a second palette; use the page's --account-* tokens`);
});

test('the four host tokens are the site\'s values, not this window\'s choices',()=>{
 const site=fs.readFileSync(path.join(SITE,'site/web.css'),'utf8');
 const block=/\.web-mode\{([^}]*)\}/.exec(site);
 assert.ok(block,'site/web.css no longer publishes a .web-mode token block - this gate reads its four --app-* values from there');
 const sheet=fs.readFileSync(path.join(ROOT,'desktop/shell.css'),'utf8');
 for(const token of HOST_TOKENS){
  const published=new RegExp(token.replace(/-/g,'\\-')+':([^;}]+)').exec(block[1]);
  assert.ok(published,`site/web.css no longer publishes ${token}`);
  const supplied=new RegExp(token.replace(/-/g,'\\-')+':([^;}]+)').exec(sheet);
  assert.ok(supplied,`desktop/shell.css does not supply ${token}, which the account control's own sheet reads`);
  assert.equal(supplied[1].trim(),published[1].trim(),`desktop/shell.css supplies ${token}:${supplied[1].trim()} where the site publishes ${published[1].trim()}`);
 }
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
 const account=at('href="vendor/launcher/account/account.css"');
 const palette=at('href="vendor/launcher/theme/launcher-light.css"');
 const adapter=at('href="vendor/launcher/theme/launcher-light-adapter.css"');
 const control=at('href="vendor/launcher/theme/account-control.css"');
 const own=at('href="shell.css"');
 at('src="vendor/launcher/theme/theme-early.js"');
 // The palette must load after every product sheet it paints, and this window's own sheet after
 // the palette - the same order site/account/index.html uses, for the same reason.
 assert.ok(account<palette&&palette<adapter&&adapter<own,`the sheets load out of order: account.css@${account}, launcher-light.css@${palette}, launcher-light-adapter.css@${adapter}, shell.css@${own}`);
 assert.ok(control<own,'account-control.css (the wait mark) must load before this window\'s own sheet');
 // The pre-paint script is the whole theme contract: without it nothing ever sets the attribute
 // every light rule is scoped to, and the window silently paints dark for a light desktop.
 assert.ok(head.indexOf('theme-early.js')>own,'theme-early.js belongs after the sheets, where every site page puts it');
});
