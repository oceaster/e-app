'use strict';
// THE DECISION, THE READ AND THE WATCH, WITHOUT ELECTRON.
//
// desktop/build-rev.cjs is the part of "this window is showing an older build" that can be
// reasoned about: which rev a served document states, whether two revs are the same build, and
// what the watch does with a server that does not answer. The suite below is written against the
// REAL injection shape the harness produces (packages/client/modules/src/index.ts:252-286:
// `window.__AGENT_HARNESS_BOOT__ = {...}` with `<` escaped inside the JSON), not against a shape
// this test invented, so a change to that wire fails here rather than in Owen's window.
const test=require('node:test'),assert=require('node:assert/strict');
const {BUILD_CHECK_MS,BUILD_FETCH_MS,revOf,decide,fetchRev,BuildWatch}=require('../desktop/build-rev.cjs');
const {HEADER,CLIENT}=require('../desktop/security.cjs');

/** A served page in the harness's own shape: the boot manifest inline in the head, its entries
 *  carrying the content-hashed bundle URLs, and `<` escaped exactly as injectBootManifest does. */
function page(rev,entries=['@deepseek-ai/dsh-client-ui-inbox']){
 const graph={rev,entries:entries.map(id=>({id,url:`/plugins/${id}/client.js?rev=${rev}`,rev}))};
 return '<!doctype html><html><head><meta charset="utf-8">'
  +`<script>window.__AGENT_HARNESS_BOOT__ = ${JSON.stringify(graph).replaceAll('<','\\u003c')}</script>`
  +'</head><body><div id="root"></div></body></html>';
}

test('a served page states the build it was composed from',()=>{
 assert.equal(revOf(page('a1b2c3d4e5f6')),'a1b2c3d4e5f6');
 // One rev, whatever the number of entries: the graph rev is the page's, not a row's.
 assert.equal(revOf(page('0123456789ab',['one/client','two/client','three/client'])),'0123456789ab');
});

test('a document that states no build is not guessed at',()=>{
 // The PIN gate and any unauthenticated answer: real HTML, no boot manifest (measured
 // 2026-11-04 on the live instance: 401 and 4583 bytes without __AGENT_HARNESS_BOOT__).
 assert.equal(revOf('<!doctype html><html><head><title>Unlock</title></head><body></body></html>'),'');
 assert.equal(revOf(''),'');
 assert.equal(revOf(null),'');
 assert.equal(revOf(undefined),'');
 // A manifest that is present but unreadable is an absent answer, never an exception.
 assert.equal(revOf('<script>window.__AGENT_HARNESS_BOOT__ = {"rev": "a1b2c3d4e5f6"</script>'),'');
 assert.equal(revOf('<script>window.__AGENT_HARNESS_BOOT__ = {"rev": ""}</script>'),'');
 assert.equal(revOf('<script>window.__AGENT_HARNESS_BOOT__ = {"entries":[]}</script>'),'');
 assert.equal(revOf('<script>window.__AGENT_HARNESS_BOOT__ = {"rev":"not a rev"}</script>'),'');
 assert.equal(revOf('<script>window.__AGENT_HARNESS_BOOT__ = {"rev":12345678}</script>'),'');
});

test('equal revs are silence, different revs are stale, and a missing one is unknown',()=>{
 assert.equal(decide('a1b2c3d4e5f6','a1b2c3d4e5f6'),'current');
 assert.equal(decide('a1b2c3d4e5f6','ffffffffffff'),'stale');
 assert.equal(decide('','a1b2c3d4e5f6'),'unknown');
 assert.equal(decide('a1b2c3d4e5f6',''),'unknown');
 assert.equal(decide('',''),'unknown');
 assert.equal(decide('  a1b2c3d4e5f6 ',"a1b2c3d4e5f6\n"),'current','whitespace is not a different build');
 assert.equal(decide(undefined,null),'unknown');
});

test('the server is asked through the person session, with the cache bypassed',async()=>{
 const seen=[];
 const session={fetch:async(url,init)=>{seen.push([url,init]);return {ok:true,text:async()=>page('a1b2c3d4e5f6')};}};
 assert.equal(await fetchRev(session,'https://home.example.test'),'a1b2c3d4e5f6');
 assert.equal(seen.length,1);
 const [url,init]=seen[0];
 assert.equal(url,'https://home.example.test/','the page the window loads, and nothing else');
 assert.equal(init.credentials,'include','the PIN session is what makes this page readable at all');
 assert.equal(init.cache,'no-store','a cached read answers the build the window already has');
 assert.equal(init.headers[HEADER],CLIENT,'the desktop client hint the server gates on');
 assert.ok(init.signal,'bounded: an unanswered check is unknown, not a hang');
});

test('an unreachable or refusing server is unknown, not a claim',async()=>{
 const boom={fetch:async()=>{throw Error('ECONNREFUSED');}};
 assert.equal(await fetchRev(boom,'https://home.example.test'),'');
 const refused={fetch:async()=>({ok:false,status:403,text:async()=>'{"detail":"no"}'})};
 assert.equal(await fetchRev(refused,'https://home.example.test'),'');
 const pinGate={fetch:async()=>({ok:true,text:async()=>'<!doctype html><title>Unlock</title>'})};
 assert.equal(await fetchRev(pinGate,'https://home.example.test'),'');
 const hang={fetch:async(url,init)=>{await new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(Error('aborted')));});}};
 assert.equal(await fetchRev(hang,'https://home.example.test',{timeout:5}),'');
 assert.equal(await fetchRev(null,'https://home.example.test'),'');
 assert.equal(await fetchRev(boom,''),'');
});

/** A watch with every moving part supplied, so a test owns time, the document and the server. */
function watch({loaded='aaaaaaaabbbb',current='aaaaaaaabbbb',read,rev}={}){
 const notes=[],reloads=[];
 const built=new BuildWatch({
  session:{},origin:'https://home.example.test',
  read:read||(async()=>loaded),
  notify:value=>notes.push(value),
  reload:()=>reloads.push(Date.now()),
  rev:rev||(async()=>current),
  interval:BUILD_CHECK_MS,
  tick:()=>{const timer={unref(){timer.unrefd=true;return timer;},unrefd:false};return timer;},
  stopTick:()=>{}
 });
 built.notes=notes;built.reloads=reloads;
 return built;
}

test('a plain service restart - the same bundles, a new process - is not a stale build',async()=>{
 // The rev is the content hash of the composed bundles: a restart that changes no bundle
 // serves the same graph, so the two sides are equal and nothing is shown.
 const built=watch({loaded:'a1b2c3d4e5f6',current:'a1b2c3d4e5f6'});
 assert.equal(await built.check(),'current');
 assert.equal(built.notes.at(-1).state,'current','silence');
 assert.equal(built.notes.at(-1).loaded,built.notes.at(-1).current);
});

test('a deploy under an open window is stated, with the server it is about',async()=>{
 const built=watch({loaded:'a1b2c3d4e5f6',current:'fffffffffffe'});
 assert.equal(await built.check(),'stale');
 assert.deepEqual(built.notes.at(-1),{state:'stale',loaded:'a1b2c3d4e5f6',current:'fffffffffffe'});
});

test('an unreadable document or an unreachable server shows nothing',async()=>{
 const noDocument=watch({read:async()=>{throw Error('the window is gone');}});
 assert.equal(await noDocument.check(),'unknown');
 assert.equal(noDocument.notes.at(-1).state,'unknown');
 const noServer=watch({rev:async()=>''});
 assert.equal(await noServer.check(),'unknown');
 assert.equal(noServer.notes.at(-1).state,'unknown');
 const wired=watch({loaded:'a1b2c3d4e5f6',current:'fffffffffffe'});
 assert.equal(await wired.check(),'stale');
 // The server going away withdraws a claim it can no longer support: silence, not a stale line.
 const gone=watch({loaded:'a1b2c3d4e5f6',current:'',rev:async()=>''});
 assert.equal(await gone.check(),'unknown');
});

test('a dismissal holds for the build it was about and nothing else',async()=>{
 let current='fffffffffffe';
 const built=watch({loaded:'a1b2c3d4e5f6',current:()=>current,rev:async()=>current});
 assert.equal(await built.check(),'stale');
 built.dismiss();
 assert.equal(built.notes.at(-1).state,'current','the line goes away when a person dismisses it');
 // The same pair, checked again: it must not come back on its own.
 assert.equal(await built.check(),'current');
 assert.equal(built.notes.at(-1).state,'current');
 // A newer build on the server is a new question, and it is asked again.
 current='00000000000a';
 assert.equal(await built.check(),'stale');
});

test('the reload action withdraws the line and asks the window for the current build',async()=>{
 const built=watch({loaded:'a1b2c3d4e5f6',current:'fffffffffffe'});
 await built.check();
 await built.refresh();
 assert.equal(built.reloads.length,1,'reload happens once, on the window, in place');
 assert.equal(built.notes.at(-1).state,'current','the line is withdrawn before the page changes');
});

test('one interval, unref\u0027d, and one check in flight at a time',async()=>{
 let ticks=0,cleared=0;
 const built=new BuildWatch({
  session:{},origin:'https://home.example.test',read:async()=>'a1b2c3d4e5f6',notify:()=>{},reload:()=>{},
  rev:async()=>'a1b2c3d4e5f6',interval:BUILD_CHECK_MS,
  tick:(fn,ms)=>{ticks++;assert.equal(ms,BUILD_CHECK_MS);const timer={unref(){return timer;}};timer.fn=fn;return timer;},
  stopTick:()=>{cleared++;}
 });
 built.start();built.start();
 assert.equal(ticks,1,'starting twice does not buy a second interval');
 built.stop();
 assert.equal(cleared,1);
 // A slow check does not stack: the next tick returns the verdict already in hand.
 let release;const slow=new BuildWatch({
  session:{},origin:'https://home.example.test',read:async()=>'a1b2c3d4e5f6',notify:()=>{},reload:()=>{},
  rev:()=>new Promise(resolve=>{release=resolve;}),
  interval:BUILD_CHECK_MS,tick:()=>({unref(){}}),stopTick:()=>{}
 });
 const first=slow.check();
 assert.equal(await slow.check(),'unknown','a check already in flight is not joined by a second');
 release('a1b2c3d4e5f6');
 assert.equal(await first,'current');
});

test('the fetch is bounded by its own name, not a bare number at the call site',()=>{
 assert.equal(BUILD_FETCH_MS,8000);
 assert.equal(BUILD_CHECK_MS,120000);
 assert.ok(BUILD_CHECK_MS>BUILD_FETCH_MS,'a check may not outlive its own interval');
});

test('the two files that only run in Electron actually wire the watch',()=>{
 // The gate that matters for a feature whose parts are provable but whose composition is not:
 // a module nobody instantiates would pass every test above and change nothing in the window.
 const fs=require('node:fs'),path=require('node:path');
 const main=fs.readFileSync(path.join(__dirname,'..','desktop','main.cjs'),'utf8');
 const preload=fs.readFileSync(path.join(__dirname,'..','desktop','preload.cjs'),'utf8');
 assert.match(main,/startBuildWatch\(current,activeSession,config\.server\);/,'the connected window starts a watch');
 assert.match(main,/new BuildWatch\(\{\n  session:ses,origin,window:current,/,'the watch reloads THAT window, not some other one');
 assert.match(main,/ipcMain\.on\('client:build-action',\(event,action\)=>\{try\{remote\(event\);\}/,'the two actions answer only the connected server\'s main frame');
 assert.match(preload,/ipcRenderer\.send\('client:build-action','reload'\)/);
 assert.match(preload,/ipcRenderer\.send\('client:build-action','dismiss'\)/);
 assert.match(preload,/ipcRenderer\.on\('client:build'/);
 assert.match(preload,/older build of/,'the sentence a person reads');
});
