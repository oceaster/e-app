'use strict';
// EVERY MEMBER THE APP REACHES FOR ON THE UPDATER EXISTS — the gate that would have caught a modal
// instead of a window (ticket 06becd1e rework, measured 2026-11-05).
//
// desktop/main.cjs added `updater.setFailureLog(updateLog)` as the first thing start() does, and
// desktop/updater.cjs defined `setFailureLog` and never exported it. Nothing noticed: the node
// suites drive the module directly, so they never take the path main.cjs takes, and the product
// answered a launch with "e-server could not start / updater.setFailureLog is not a function" —
// which also stopped an e-server deploy, because that deploy's gate launches this tree and waits
// for its window.
//
// This file reads the callers as text and holds them to the real module: every `updater.<member>`
// in main.cjs and bootstrap.cjs, and every name destructured out of `require('./updater.cjs')`, must
// exist on the exported object. It is deliberately reflective (it requires the module) so a rename
// on either side fails here rather than in front of a person.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const updater=require('../desktop/updater.cjs');

const ROOT=path.resolve(__dirname,'..');
const CALLERS=['desktop/main.cjs','desktop/bootstrap.cjs'];

function membersReached(source){
 const names=new Set();
 // `updater.update(...)` — the bare module reference. `require('./updater.cjs')` also matches the
 // `updater.` prefix, so the module's own file extension is dropped by name below.
 for(const match of source.matchAll(/\bupdater\.([A-Za-z_$][\w$]*)/g))names.add(match[1]);
 // `const {selected,identifies}=require('./updater.cjs')` — a destructuring takes the same names.
 for(const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\('\.\/updater\.cjs'\)/g)){
  for(const part of match[1].split(',')){
   const name=part.split(':')[0].trim();
   if(/^[A-Za-z_$][\w$]*$/.test(name))names.add(name);
  }
 }
 names.delete('cjs');
 return [...names].sort();
}

test('every member main.cjs and bootstrap.cjs reach for on the updater is exported',()=>{
 const problems=[];
 for(const file of CALLERS){
  const source=fs.readFileSync(path.join(ROOT,file),'utf8');
  for(const name of membersReached(source)){
   if(updater[name]===undefined)problems.push(`${file}: updater.${name} is used but not exported`);
  }
 }
 assert.deepEqual(problems,[],'the app would answer a launch with an error modal instead of its window:\n'+problems.join('\n'));
});

test('the surface this gate reads is non-empty, so it cannot pass by finding nothing',()=>{
 for(const file of CALLERS){
  const names=membersReached(fs.readFileSync(path.join(ROOT,file),'utf8'));
  assert.ok(names.length>0,`${file} reaches no updater member — the reader broke`);
 }
 // The two names that have already caused a dead launch are pinned by name.
 assert.ok(membersReached(fs.readFileSync(path.join(ROOT,'desktop/main.cjs'),'utf8')).includes('setFailureLog'));
 assert.ok(membersReached(fs.readFileSync(path.join(ROOT,'desktop/bootstrap.cjs'),'utf8')).includes('identifies'));
});

test('the update log the app hands the updater is the shape the updater documents',()=>{
 // `updater.setFailureLog(log)` keeps the log only when it has an `append`; anything else is quietly
 // dropped, so the app's update log would silently receive nothing. That shape is what main.cjs's
 // UpdateLog provides, and this asserts the two agree.
 const {UpdateLog}=require('../desktop/registry.cjs');
 const log=new UpdateLog(path.join(require('node:os').tmpdir(),'e-app-update-log-shape.log'));
 assert.equal(typeof log.append,'function');
 updater.setFailureLog(log);
 updater.setFailureLog(null);
});
