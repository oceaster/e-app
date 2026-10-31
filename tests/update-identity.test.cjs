'use strict';
// The rename bridge, held to one rule. Every published build up to 1.0.2 refuses a payload whose
// package name is not the old literal, so 1.0.3 has to accept BOTH names or the machines in the
// field can never be handed the renamed release. This is that rule, and the check that both
// shipped guards actually defer to it - a single guard left comparing a literal is exactly the
// defect the bridge exists to prevent.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {identifies,PAYLOAD_NAMES}=require('../desktop/updater.cjs');

test('a payload is this client\'s own while the name is on either side of the rename',()=>{
 const manifest={version:'1.0.4'};
 // Every name the package has carried stays accepted, oldest first: a machine in the field runs
 // whichever build it installed, and a build that refuses the next name cannot hand that name's
 // payload to anyone. `e-app` is the current one (Owen, 2026-10-31).
 assert.deepEqual(PAYLOAD_NAMES,['easter-eserver-client','easter-server-client','e-app']);
 assert.equal(identifies({name:'easter-eserver-client',version:'1.0.4'},manifest),true);
 assert.equal(identifies({name:'easter-server-client',version:'1.0.4'},manifest),true);
 assert.equal(identifies({name:'e-app',version:'1.0.4'},manifest),true);
});

test('the widening is the NAME only: version, foreign names and missing parts still refuse',()=>{
 const manifest={version:'1.0.4'};
 assert.equal(identifies({name:'easter-server-client',version:'1.0.3'},manifest),false);
 assert.equal(identifies({name:'easter-company-launcher',version:'1.0.4'},manifest),false);
 assert.equal(identifies({name:'easter-server-client'},manifest),false);
 assert.equal(identifies({},manifest),false);
 assert.equal(identifies(null,manifest),false);
 assert.equal(identifies({name:'easter-server-client',version:'1.0.4'},null),false);
});

test('both shipped guards ask the one rule, so the rename cannot land in one of them only',()=>{
 const read=file=>fs.readFileSync(path.join(__dirname,'..','desktop',file),'utf8');
 const main=read('main.cjs'),bootstrap=read('bootstrap.cjs'),updater=read('updater.cjs');
 // main.cjs refuses an activation, bootstrap.cjs refuses a staged payload on the next start.
 assert.match(main,/if\(!updater\.identifies\(pkg,manifest\)\)throw Error\('Invalid e-server client update\.'\)/);
 assert.match(bootstrap,/if\(!identifies\(pkg,manifest\)\)throw Error\('The e-server update identity is invalid\.'\)/);
 assert.match(bootstrap,/const \{selected,identifies\}=require\('\.\/updater\.cjs'\)/);
 assert.match(updater,/const PAYLOAD_NAMES=\['easter-eserver-client','easter-server-client','e-app'\]/);
 // No guard may name one package again: a literal comparison is what rejects a renamed payload.
 // Neither may it lose the list: the current name alone would strand every install before it.
 for (const name of ['easter-eserver-client', 'easter-server-client', 'e-app']) {
  assert.doesNotMatch(main,new RegExp(`pkg\\.name!=='${name}'`));
  assert.doesNotMatch(bootstrap,new RegExp(`pkg\\.name!=='${name}'`));
 }
});
