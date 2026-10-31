'use strict';
// THE SIGN-IN SCREEN IS THE HOUSEHOLD'S PAGE, OR THIS FAILS.
//
// desktop/shell.html renders site/account/index.html's markup and desktop/vendor/launcher/
// account/ holds the page's own sheet and its Microsoft half, copied verbatim. Nothing in this
// repository may reimplement them: the household rule (and the 2026-10-28 repair) is "copy the
// file, cmp it, and put every difference in an adapter of your own". Before this gate the copies
// were unguarded, so a hand edit to a vendored file was invisible until a person noticed the
// client had drifted from the site again - which is exactly how the client ended up with 27 rules
// for a sign-in card that shared nothing with the page's 51.
//
// It fails closed: no site checkout, no pass. The comparison is the check.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');

const ROOT=path.resolve(__dirname,'..');
//: The launcher site, the one checkout these files are vendored from. Overridable for a checkout
//: that lives elsewhere, never silently skippable.
const SITE=process.env.EASTER_SITE||'/root/easter-co-smp.github.io';
const VENDOR='desktop/vendor/launcher/account';
//: (source in the site, copy in this repository) - every file the client serves from the page.
const VENDORED=[['site/account/account.css','account.css'],['site/account/microsoft-signin.mjs','microsoft-signin.mjs']];
//: The class names the client's own card used to spell, and the palette it used to bring. Not one
//: of them may return to desktop/shell.css: the page's sheet paints these, and a rule here would
//: be a second author of the same control.
const RETIRED=['.company-signin','.company-microsoft','.company-provider','.company-provider-note','.company-submit','.company-error','.company-no-reset','.company-forgot','.eyebrow'];
const RETIRED_PALETTE=['--bg','--card','--accent','--border','--text','--muted'];
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

test('the vendored account page is the site\'s, byte for byte',()=>{
 for(const [source,copy] of VENDORED){
  const site=read(path.join(SITE,source)),vendored=read(path.join(ROOT,VENDOR,copy));
  assert.equal(site.equals(vendored),true,`${VENDOR}/${copy} drifted from ${source}, ${difference(site,vendored)} - re-vendor it (cp ${path.join(SITE,source)} ${VENDOR}/${copy}), never edit the copy`);
 }
});

test('the vendored sign-in options are the site\'s, byte for byte',()=>{
 const site=read(path.join(SITE,'site/signin-options.mjs')),vendored=read(path.join(ROOT,'desktop/vendor/launcher/signin-options.mjs'));
 assert.equal(site.equals(vendored),true,`desktop/vendor/launcher/signin-options.mjs drifted from site/signin-options.mjs, ${difference(site,vendored)}`);
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
 const painted=[...sheet.matchAll(/:[^;{}]*?(#[0-9a-fA-F]{3,8})(?![\w-])/g)].map(match=>match[1]);
 assert.deepEqual(painted,[],`desktop/shell.css paints ${painted.join(', ')} - a colour literal here is a second palette; use the page's --account-* tokens`);
});

test('the sign-in screen is the site\'s markup, so the site\'s classes do the painting',()=>{
 const page=fs.readFileSync(path.join(ROOT,'desktop/shell.html'),'utf8');
 for(const [name,pattern] of MARKUP)assert.match(page,pattern,`desktop/shell.html does not render ${name}`);
 assert.match(page,/href="vendor\/launcher\/account\/account\.css"/,'desktop/shell.html does not load the page\'s own sheet');
});
