'use strict';
// ONE NAME, ONE THING — a static gate for the two files nothing else can execute.
//
// desktop/main.cjs and desktop/shell.mjs only run inside Electron, so no unit test can load them,
// and a duplicated top-level declaration is silent: the later one wins, everywhere, with no
// warning and no error. That is not hypothetical. `addServer` validated an e-server's address with
// `probe(origin)`, but the updater already declared `probe()` (it asks GitHub for the latest
// client version), so the app compared a server's `/healthz` body against "1.0.10" and every add
// answered "No e-server answered at that address." — found by driving the real app against the
// real service, not by any test. The E2E caught it because it looked at the outcome; this gate
// catches the cause, in a second, on every push.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');

const ROOT=path.resolve(__dirname,'..');
const FILES=['desktop/main.cjs','desktop/preload.cjs','desktop/shell.mjs','desktop/connections.cjs','desktop/bridge.cjs','desktop/security.cjs','desktop/updater.cjs','desktop/navigation.cjs','desktop/build-rev.cjs','desktop/registry.cjs'];

/** Every name this file declares at its top level (module or function scope root). */
function declaredNames(source){
 const names=new Map();
 const lines=source.split('\n');
 let depth=0;
 for(const line of lines){
  const atRoot=depth===0;
  const text=line.trim();
  if(atRoot){
   const fn=text.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
   const cls=text.match(/^class\s+([A-Za-z_$][\w$]*)/);
   const vars=text.match(/^(?:const|let|var)\s+(.*)$/);
   if(fn)names.set(fn[1],(names.get(fn[1])||0)+1);
   if(cls)names.set(cls[1],(names.get(cls[1])||0)+1);
   if(vars){
    for(const name of splitDeclarators(vars[1]))names.set(name,(names.get(name)||0)+1);
   }
  }
  depth+=bracketDelta(line);
  if(depth<0)depth=0;
 }
 return names;
}

/** The declared names in `a=1,b=2,{c}=d` — commas at depth zero, identifier before `=`. */
function splitDeclarators(text){
 const parts=[];
 let current='',depth=0;
 for(const character of text){
  if('([{'.includes(character))depth++;
  else if(')]}'.includes(character))depth--;
  if(character===','&&depth===0){parts.push(current);current='';continue;}
  current+=character;
 }
 parts.push(current);
 const names=[];
 for(const part of parts){
  const match=part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?:=|$)/);
  if(match)names.push(match[1]);
 }
 return names;
}

/** Net bracket depth change for one line, ignoring brackets inside strings and comments. */
function bracketDelta(line){
 let depth=0,quote=null;
 for(let index=0;index<line.length;index++){
  const character=line[index];
  if(quote){
   if(character==='\\'){index++;continue;}
   if(character===quote)quote=null;
   continue;
  }
  if(character==='\''||character==='"'||character==='`'){quote=character;continue;}
  if(character==='/'&&line[index+1]==='/')break;
  if(character==='/'&&line[index+1]==='*')break;
  if('([{'.includes(character))depth++;
  else if(')]}'.includes(character))depth--;
 }
 // A quote left open on this line (a multi-line template) is not tracked across lines: no
 // top-level declaration in these files lives inside one, and the gate is about depth at the
 // start of a line, which a template literal used in a declaration does not change.
 return depth;
}

test('no file declares the same top-level name twice',()=>{
 const problems=[];
 for(const file of FILES){
  const source=fs.readFileSync(path.join(ROOT,file),'utf8');
  for(const [name,count] of declaredNames(source)){
   if(count>1)problems.push(`${file}: ${name} declared ${count} times`);
  }
 }
 assert.deepEqual(problems,[],'a duplicate declaration silently replaces the earlier one:\n'+problems.join('\n'));
});

test('the servers flow asks a server, not the updater, whether an e-server answers',()=>{
 // The two names this defect involved, pinned by name so a future rename cannot quietly
 // reintroduce the collision: the updater owns `probe`, the add flow owns `probeServer`.
 const main=fs.readFileSync(path.join(ROOT,'desktop','main.cjs'),'utf8');
 assert.match(main,/function probeServer\(origin\)/);
 assert.match(main,/const answer=await probeServer\(normalized\)/);
 assert.equal((main.match(/^function probe\(/gm)||[]).length,1,'exactly one probe(): the updater\'s');
});
