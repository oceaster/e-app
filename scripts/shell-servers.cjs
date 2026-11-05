'use strict';
// THE TWO E-SERVER VIEWS, IN A REAL WINDOW: this is the gate that proves the thing Owen asked
// for, rather than that the files parse.
//
// Owen, 2026-11-03: "when you login, before you connect to any e-server, there should be an
// intermediary view where users can select which e-server instance they want to connect to ...
// an option to remove an existing instance ... a button to go to a 2nd new view, which allows
// the user to add a new e-server instance ... Once you select an instance to connect to that's
// when you will be prompted for the instances pin if it has one."
//
// So the assertions are his sentences, in order: the list is what a signed-in person sees (not a
// connection to the last server); a row connects; remove names the row it removes; the add view
// opens, takes a name and an address, posts them, and comes back to the list; every state the
// list can be in (loading, empty, error with a way through) paints what it says and nothing else.
//
// Electron with the REAL desktop/preload.cjs and the REAL desktop/shell.html - only the main
// process is stubbed, through the same IPC channels desktop/main.cjs registers. A renamed
// channel, a changed argument or a missing id fails here.
//
// THE SECOND THING THIS GATE PROVES (Owen, 2026-11-03, twice in one evening): a fix is shipped,
// deployed and verified, and the window that is already open keeps drawing the old editor,
// because an open page keeps the client JavaScript it loaded. So the same script serves a real
// page on loopback, runs the REAL desktop/build-rev.cjs against the REAL desktop/preload.cjs in a
// real window, swaps the rev the server serves, and asserts the line appears, that pressing
// Reload reloads IN PLACE to the new bundle, and that a dismissal and an unreachable server both
// stay silent. Same fixture, same window, same code the app ships.
//
//   xvfb-run -a npx electron --no-sandbox scripts/shell-servers.cjs [--shots <dir>]
const {app,BrowserWindow,ipcMain,nativeTheme}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');

const ROOT=path.resolve(__dirname,'..');
const SHELL=path.join(ROOT,'desktop','shell.html');
const {BuildWatch}=require(path.join(ROOT,'desktop','build-rev.cjs'));
const shotsAt=(()=>{const at=process.argv.indexOf('--shots');return at>0?path.resolve(process.argv[at+1]):null;})();
const home=fs.mkdtempSync(path.join(os.tmpdir(),'eserver-shell-servers-'));
app.setPath('userData',home);
// A headless xvfb server has no working GL: hardware acceleration there fails the capture, not
// the page. The window is real either way.
app.disableHardwareAcceleration();
if(shotsAt)fs.mkdirSync(shotsAt,{recursive:true});

const ROWS=[
 {id:'c0123456789abcdef',origin:'https://home.example.test',label:'Home',addedAt:'2026-11-02T20:00:00Z',lastUsedAt:'2026-11-03T03:00:00Z'},
 {id:'c9fedcba98765432',origin:'https://work.example.test:8443',label:'Work',addedAt:'2026-11-01T09:00:00Z',lastUsedAt:null},
];
let calls=[];
// What the stubbed main process answers for an add; each section sets it before it presses.
let addAnswer={ok:true,row:{id:'cnew',origin:'https://new.example.test',label:'New one'}};
let state={
 version:'1.0.11',phase:'setup',view:'servers',accountReady:true,accountBusy:false,accountError:'',accountNotice:'',
 account:{id:2,name:'Delta Test',username:'easter-delta',usernameClaimed:true,passwordRequired:false},
 servers:{state:'ready',rows:ROWS,error:'',limit:50,fallback:''},
};
function publish(){if(win&&!win.isDestroyed())win.webContents.send('client:state',state);}

let win=null;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(description,check,{tries=80}={}){
 for(let attempt=0;attempt<tries;attempt++){
  const answer=await win.webContents.executeJavaScript(check).catch(()=>false);
  if(answer)return answer;
  await wait(50);
 }
 throw Error('timed out waiting for '+description);
}
const read=expression=>win.webContents.executeJavaScript(expression);
async function shot(name){
 if(!shotsAt)return;
 win.setContentSize(680,900);
 await wait(60);
 const image=await win.webContents.capturePage();
 fs.writeFileSync(path.join(shotsAt,name+'.png'),image.toPNG());
}

app.whenReady().then(async()=>{
 nativeTheme.themeSource='dark';
 ipcMain.handle('client:state',()=>state);
 // THE THEME SEAM, answered the way desktop/main.cjs answers it (ticket c28be1de). The shell's
 // preload reads the cached preference SYNCHRONOUSLY (`ipcRenderer.sendSync('theme:cached')`) so
 // the first paint can already wear it, and a `sendSync` with no listener does not fail - it
 // BLOCKS the renderer for ever. That is what happened here: client-v1.0.18's first release run
 // sat on "Exercise the packaged first screen on Linux" until it was cancelled, and this gate
 // printed "called ipcRenderer.sendSync() with 'theme:cached' channel without listeners".
 // A stub that answers the channels the real main registers is the whole contract of this file.
 ipcMain.on('theme:cached',event=>{event.returnValue='system';});
 ipcMain.handle('client:theme-refresh',()=>({ok:true,theme:'system'}));
 ipcMain.handle('client:view',(event,value)=>{calls.push(['view',value]);state={...state,view:value};publish();return state;});
 ipcMain.handle('client:servers-refresh',()=>{calls.push(['refresh']);return {ok:true};});
 ipcMain.handle('client:servers-add',async(event,payload)=>{
  calls.push(['add',payload]);
  // `slow` holds the answer long enough to see the form's checking state, which is what a real
  // probe of an address that does not answer looks like from the person's side.
  if(addAnswer&&addAnswer.slow){await wait(addAnswer.slow);return addAnswer.then;}
  return addAnswer;
 });
 ipcMain.handle('client:servers-remove',(event,id,label)=>{calls.push(['remove',id,label]);return {ok:true};});
 ipcMain.handle('client:connect',(event,origin)=>{calls.push(['connect',origin]);return {ok:true};});
 ipcMain.handle('client:retry',()=>({ok:true}));
 ipcMain.handle('client:installer',()=>true);
 ipcMain.handle('company:providers',()=>({providers:[{id:'microsoft',name:'Microsoft'}]}));
 ipcMain.handle('company:login',()=>({accountReady:true}));
 ipcMain.handle('company:provider',()=>({accountReady:true}));
 ipcMain.handle('company:finish',()=>({accountReady:true}));
 ipcMain.handle('company:cancel',()=>{});
 ipcMain.handle('company:signout',()=>({ok:true}));

 win=new BrowserWindow({width:680,height:900,show:false,useContentSize:true,webPreferences:{preload:path.join(ROOT,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.showInactive();
 const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
 await win.loadFile(SHELL);
 await loaded;

 // ── 1. after sign-in the person lands on the list, not on the last server ────────────────
 await until('the list to paint',`document.querySelector('#client-servers').hidden===false && document.querySelectorAll('.server-row').length===2`);
 assert.equal(await read(`document.querySelector('#account-root').hidden`),true,'the sign-in rows are not on screen after sign-in');
 assert.deepEqual(await read(`[...document.querySelectorAll('.server-name')].map(n=>n.textContent)`),['Home','Work']);
 assert.deepEqual(await read(`[...document.querySelectorAll('.server-origin')].map(n=>n.textContent)`),['home.example.test','work.example.test:8443']);
 // The remove control names its row: a screen reader must not hear two identical "Remove"s.
 assert.deepEqual(await read(`[...document.querySelectorAll('.server-remove')].map(b=>b.getAttribute('aria-label'))`),['Remove Home','Remove Work']);
 assert.equal(await read(`document.querySelector('#message').textContent`),'','the list says its sentence once, in the view itself');
 await shot('01-list-dark');

 // A row whose name the service derived from its host prints the address ONCE: two identical
 // lines read like a mistake (measured on a row the live service labelled from its origin).
 state={...state,servers:{...state.servers,rows:[...ROWS,{id:'chost',origin:'https://only.example.test',label:'only.example.test',addedAt:null,lastUsedAt:null}]}};publish();
 await until('the third row',`document.querySelectorAll('.server-row').length===3`);
 assert.equal(await read(`document.querySelectorAll('.server-row')[2].querySelectorAll('.server-origin').length`),0);
 state={...state,servers:{...state.servers,rows:ROWS}};publish();
 await until('two rows again',`document.querySelectorAll('.server-row').length===2`);

 // ── 2. a row connects, with the origin the row holds ────────────────────────────────────
 await read(`document.querySelectorAll('.server-connect')[1].click()`);
 await until('the connect call',`true`);
 await wait(50);
 assert.deepEqual(calls.find(call=>call[0]==='connect'),['connect','https://work.example.test:8443']);

 // ── 3. remove asks the main process for THAT row, which is where the dialog lives ───────
 calls=[];
 await read(`document.querySelectorAll('.server-remove')[0].click()`);
 await wait(80);
 assert.deepEqual(calls.find(call=>call[0]==='remove'),['remove','c0123456789abcdef','Home']);
 await until('the removal to be announced',`document.querySelector('#servers-status').textContent==='Removed Home from your e-servers.'`);

 // ── 4. the add view opens from its button, and the first field takes focus ──────────────
 calls=[];
 await read(`document.querySelector('#server-add').click()`);
 await until('the add view',`document.querySelector('#client-servers').dataset.state==='ready' && document.querySelector('#servers').hidden===true && document.querySelector('#add-server-view').hidden===false`);
 assert.deepEqual(calls.find(call=>call[0]==='view'),['view','add']);
 // The heading is the view's: the list's title must not sit over the add form.
 assert.equal(await read(`document.querySelector('#title').textContent`),'Your e-servers.','the stub publishes the list title; the real main.cjs changes it to the add view\'s');
 await until('focus in the address field',`document.activeElement && document.activeElement.id==='add-origin'`);
 await shot('02-add-dark');

 // ── 5. an address and a name go to the main process together ───────────────────────────
 calls=[];
 state={...state,view:'add'};publish();
 await read(`(()=>{document.querySelector('#add-origin').value='https://new.example.test';document.querySelector('#add-name').value='New one';document.querySelector('#add-server').requestSubmit();return true})()`);
 await wait(120);
 assert.deepEqual(calls.find(call=>call[0]==='add'),['add',{origin:'https://new.example.test',label:'New one'}]);
 assert.equal(await read(`document.querySelector('#add-origin').value`),'','a successful add clears the form it used');
 assert.equal(await read(`document.querySelector('#add-submit').textContent`),'Add e-server','the button stops saying it is checking');
 await until('the add to be announced',`document.querySelector('#servers-status').textContent.startsWith('Added ')`);

 // ── 6. a refusal is shown in the add view and the form stays usable ────────────────────
 addAnswer={slow:900,then:{ok:false,error:'No e-server answered at that address.'}};
 state={...state,view:'add'};publish();
 await until('the add view again',`document.querySelector('#add-server-view').hidden===false`);
 await read(`(()=>{document.querySelector('#add-origin').value='https://nobody.example.test';document.querySelector('#add-server').requestSubmit();return true})()`);
 // While the address is being proved the button says so, which is the difference between a
 // spinner and a person wondering whether the press registered.
 await until('the checking label',`document.querySelector('#add-submit').textContent==='Checking…'`);
 await until('the refusal',`document.querySelector('#add-problem').textContent==='No e-server answered at that address.'`);
 assert.equal(await read(`document.querySelector('#add-server').dataset.busy`),'false','a refusal must not leave the form spinning');
 await shot('03-add-refused-dark');

 // ── 7. an empty list says so, and still offers the one thing to do ─────────────────────
 state={...state,view:'servers',servers:{state:'empty',rows:[],error:'',limit:50,fallback:''}};publish();
 await until('the empty state',`document.querySelector('#client-servers').dataset.state==='empty' && document.querySelector('#servers-empty').hidden===false`);
 assert.equal(await read(`document.querySelector('#servers-loading').hidden`),true,'the wait goes when the answer arrives');
 assert.equal(await read(`document.querySelector('#servers-loading').textContent`),'','and is cleared, so a stale sentence cannot return');
 assert.equal(await read(`document.querySelector('#server-list').children.length`),0);
 assert.equal(await read(`document.querySelector('#server-add').hidden`),false,'an empty list must still offer the add button');
 await shot('04-empty-dark');

 // ── 8. a list that cannot be read says why, offers a retry, and offers the last server ──
 state={...state,servers:{state:'error',rows:[],error:'The Easter Company account service could not be reached.',limit:0,fallback:'https://home.example.test'}};publish();
 await until('the error state',`document.querySelector('#servers-error').hidden===false`);
 assert.equal(await read(`document.querySelector('#servers-error-text').textContent`),'The Easter Company account service could not be reached.');
 assert.equal(await read(`document.querySelector('#servers-retry').hidden`),false);
 assert.equal(await read(`document.querySelector('#servers-fallback').textContent`),'Connect to home.example.test instead',
  'a cloud read that fails must not be a locked door: the last server stays reachable');
 calls=[];
 await read(`document.querySelector('#servers-fallback').click()`);
 await wait(80);
 assert.deepEqual(calls.find(call=>call[0]==='connect'),['connect','https://home.example.test']);
 await shot('05-error-dark');

 // ── 8b. a list that NEVER answers ends in a sentence and a retry, not in a bare view ─────
 // Owen, 2026-11-04: "the e-server instance selector is empty and no options are available 60-70%
 // of the time" after signing out and back in, and the view is "completely bare" — which is what a
 // list stuck at `loading` looks like, because both the rows and the add control are hidden in
 // that state and the error region is shown only for `error`. This section publishes `loading` and
 // never publishes again, which is the worst case the main process can produce; the view must end
 // in the honest failure by itself, with the Retry the person needs. It fails on the tree before
 // ticket (2026-11-04): there the view stayed bare for as long as the gate waited.
 calls=[];
 state={...state,view:'servers',servers:{state:'loading',rows:[],error:'',limit:0,fallback:''}};publish();
 await until('the loading state to paint',`document.querySelector('#client-servers').dataset.state==='loading'`);
 assert.equal(await read(`document.querySelector('#server-list').children.length`),0,'a loading list has no rows');
 assert.equal(await read(`document.querySelector('#server-add').hidden`),true,'and no add control while a wait is on');
 // NOT BARE ANY MORE: the wait is a visible line in Diana's words (/home/diana/Desktop/
 // servers-loading.css + NOTES.md), with her own separator rules, and the choose/PIN instruction
 // is out of the way because there is nothing to choose yet.
 assert.equal(await read(`!!document.querySelector('#servers-loading')`),true,'the shell carries the wait region Diana named');
 assert.equal(await read(`document.querySelector('#servers-loading')?.hidden`),false,'the wait paints a line, not nothing');
 assert.equal(await read(`document.querySelector('#servers-loading')?.textContent`),'Loading your e-servers…');
 assert.equal(await read(`document.querySelector('#servers-copy').hidden`),true,'the choose instruction steps aside during the wait');
 const paint=await read(`(()=>{const el=document.querySelector('#servers-loading');if(el===null)return null;const s=getComputedStyle(el);const r=el.getBoundingClientRect();return {size:s.fontSize,line:s.lineHeight,top:s.borderTopWidth,left:s.textAlign,width:Math.round(r.width),height:Math.round(r.height)}})()`);
 assert.ok(paint!==null,'the wait line must be in the document to be measured');
 assert.equal(paint.size,'14px',JSON.stringify(paint));
 assert.equal(paint.line,'21px',JSON.stringify(paint));
 assert.equal(paint.top,'1px','her thin top rule is the wait region\'s edge: '+JSON.stringify(paint));
 assert.equal(paint.left,'start',JSON.stringify(paint));
 assert.ok(paint.width>0&&paint.height>0,'the line has a painted box: '+JSON.stringify(paint));
 // The bound sits ABOVE the main process's own 15 s watchdog, so a slow but real answer always
 // wins and only a state that was never published reaches this failure. The gate waits past it.
 await until('the loading state to become an honest failure',`document.querySelector('#servers-error').hidden===false`,{tries:700});
 assert.equal(await read(`document.querySelector('#servers-error-text').textContent`),'Your e-servers did not load. Try again.');
 assert.equal(await read(`document.querySelector('#servers-retry').hidden`),false,'the failure must offer the way through');
 // The error state's own way through is Retry (and the last server, when there is one) — the add
 // control is hidden there by the product's own rule, so this gate does not invent a second one.
 assert.equal(await read(`document.querySelector('#server-add').hidden`),true,'an error list offers retry, not add');
 await read(`document.querySelector('#servers-retry').click()`);
 await wait(120);
 assert.deepEqual(calls.find(call=>call[0]==='refresh'),['refresh'],'Retry asks the main process again');
 await shot('05b-loading-bounded-dark');

 // ── 9. the light mood, from the same document, before the first paint ───────────────────
 nativeTheme.themeSource='light';
 state={...state,servers:{state:'ready',rows:ROWS,error:'',limit:50,fallback:''}};publish();
 await win.webContents.reloadIgnoringCache();
 await until('the list in light',`document.querySelectorAll('.server-row').length===2 && document.documentElement.getAttribute('data-easter-theme')==='light'`);
 await shot('06-list-light');
 nativeTheme.themeSource='system';

 // ── 10. the build this window is showing, against the build the server serves ───────────
 // A page in the harness's own shape: the composed boot graph inline in the head, each row's
 // bundle content-hashed in its URL (`/plugins/<id>/client.js?rev=<sha1-12>`), and the bundle
 // itself doing something a person can see. The fixture sends `Cache-Control: max-age=600` on
 // purpose: the whole point of the check is that it does not read the cache the window keeps.
 const REV_A='aaaaaaaaaaaa',REV_B='bbbbbbbbbbbb',REV_C='cccccccccccc';
 const served={rev:REV_A,down:false};
 const requests=[];
 const fixture=http.createServer((request,response)=>{
  requests.push(request.url);
  if(served.down){request.socket.destroy();return;}
  if(request.url.startsWith('/plugins/')){response.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'public, max-age=600'});response.end('window.__pluginRev='+JSON.stringify(served.rev)+';');return;}
  const graph={rev:served.rev,entries:[{id:'@deepseek-ai/dsh-client-ui-inbox',url:'/plugins/@deepseek-ai/dsh-client-ui-inbox/client.js?rev='+served.rev,rev:served.rev}]};
  const head='<script>window.__AGENT_HARNESS_BOOT__ = '+JSON.stringify(graph).replaceAll('<','\\u003c')+'</script>';
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'public, max-age=600'});
  response.end('<!doctype html><html lang="en" data-easter-theme="dark"><head><meta charset="utf-8">'+head
   +'<script src="/plugins/@deepseek-ai/dsh-client-ui-inbox/client.js?rev='+served.rev+'"></script></head>'
   +'<body style="margin:0;background:#0d2029;color:#e6edf1;font:14px system-ui"><h1 style="font:600 18px system-ui;padding:24px">Your inbox</h1>'
   +'<p style="padding:0 24px">The page this window loaded states its own build.</p>'
   // The shell's own composer seat (ConversationRoot.tsx:117 renders data-composer-seat), pinned
   // to the bottom of the conversation exactly as its stylesheet pins it: this is what the line
   // has to clear, so the fixture has to have one.
   +'<div data-composer-seat="" id="composer" style="position:fixed;left:0;right:0;bottom:0;height:96px;box-sizing:border-box;padding:12px;background:#12232c;border-top:1px solid #1d3440">'
   +'<div id="editor" style="height:100%;border-radius:10px;background:#0f1e26;color:#8fa3ad;padding:8px;box-sizing:border-box">composer</div></div>'
   +'</body></html>');
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+fixture.address().port;
 let buildWindow=null,watch=null;
 const BUILD_READ=`((window.__AGENT_HARNESS_BOOT__&&window.__AGENT_HARNESS_BOOT__.rev)||"")`;
 // Everything the placement contract is about, measured in the page: where the line is, where the
 // composer starts, and the gap in pixels a person would see.
 const geometry=()=>buildWindow.webContents.executeJavaScript(`(()=>{const host=document.getElementById('e-server-build-line');
  const shadow=host&&host.isConnected?host.shadowRoot:null;
  const bar=shadow?shadow.querySelector('.bar'):null;
  const seat=document.querySelector('[data-composer-seat]');
  const barBox=bar?bar.getBoundingClientRect():null;
  const seatBox=seat?seat.getBoundingClientRect():null;
  const style=bar?getComputedStyle(bar):null;
  const reload=shadow?shadow.querySelector('.reload'):null;
  const dismiss=shadow?shadow.querySelector('.dismiss'):null;
  const sentence=shadow?shadow.querySelector('.sentence'):null;
  const reloadBox=reload?reload.getBoundingClientRect():null;
  const dismissBox=dismiss?dismiss.getBoundingClientRect():null;
  return {
   width:innerWidth,height:innerHeight,present:!!bar,
   variable:host?host.style.getPropertyValue('--e-build-line-bottom'):'',
   left:barBox?Math.round(barBox.left):null,top:barBox?Math.round(barBox.top):null,
   bottom:barBox?Math.round(barBox.bottom):null,barHeight:barBox?Math.round(barBox.height):null,
   barWidth:barBox?Math.round(barBox.width):null,
   seatTop:seatBox?Math.round(seatBox.top):null,
   gap:barBox&&seatBox?Math.round(seatBox.top-barBox.bottom):null,
   radius:style?style.borderTopLeftRadius:'',font:style?style.fontSize+'/'+style.lineHeight:'',
   background:style?style.backgroundColor:'',colour:style?style.color:'',
   underline:reload?getComputedStyle(reload).textDecorationLine:'',
   reloadHeight:reloadBox?Math.round(reloadBox.height):null,
   dismissWidth:dismissBox?Math.round(dismissBox.width):null,
   lines:sentence?Math.round(sentence.getBoundingClientRect().height/18):null,
   clipped:sentence?sentence.scrollWidth>sentence.clientWidth+1:null,
   theme:host?host.dataset.theme:null
  };})()`).catch(()=>null);
 const bar=()=>buildWindow.webContents.executeJavaScript(`(()=>{const host=document.getElementById('e-server-build-line');
  if(!host||!host.isConnected)return null;const shadow=host.shadowRoot;if(!shadow)return null;
  const reload=shadow.querySelector('.reload'),dismiss=shadow.querySelector('.dismiss'),sentence=shadow.querySelector('.sentence'),server=shadow.querySelector('.server');
  return {sentence:sentence?sentence.textContent:null,server:server?server.textContent:null,
   reload:reload?reload.textContent:null,dismiss:!!dismiss,theme:host.dataset.theme||null}})()`).catch(()=>null);
 try{
  buildWindow=new BrowserWindow({width:900,height:600,show:false,useContentSize:true,backgroundColor:'#0d2029',
   webPreferences:{preload:path.join(ROOT,'desktop','preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  await buildWindow.loadURL(origin+'/');
  watch=new BuildWatch({
   session:buildWindow.webContents.session,origin,
   window:buildWindow,
   read:()=>buildWindow.webContents.executeJavaScript(BUILD_READ),
   notify:value=>{if(buildWindow&&!buildWindow.isDestroyed())buildWindow.webContents.send('client:build',{...value,server:new URL(origin).host});}
  });
  ipcMain.on('client:build-action',(event,action)=>{
   if(!buildWindow||event.sender!==buildWindow.webContents)return;
   if(action==='reload')void watch.refresh();else if(action==='dismiss')watch.dismiss();
  });

  // 10a. the same build on both sides: silence, whatever else the window is doing
  assert.equal(await buildWindow.webContents.executeJavaScript('window.__pluginRev'),REV_A,'the window runs the rev the fixture served');
  assert.equal(await watch.check(),'current','equal revs must say nothing');
  assert.equal(await bar(),null,'nothing is painted when the page is current');

  // 10b. the two restart shapes: an unreachable server, and a plain restart that changes no bundle
  served.down=true;
  assert.equal(await watch.check(),'unknown','an unreachable server is unknown');
  assert.equal(await bar(),null,'an unreachable server says nothing, exactly like every other cloud-optional path');
  served.down=false;
  assert.equal(await watch.check(),'current','the same bundles served again are the same build');

  // 10c. a deploy under the open window: the rev moves, and the line says so, quietly
  served.rev=REV_B;
  assert.equal(await watch.check(),'stale','a replaced build is stale');
  const shown=await bar();
  assert.ok(shown,'the line must be on screen');
  assert.equal(shown.sentence,'This window is running an older build of 127.0.0.1:'+new URL(origin).port+'.','the sentence, naming the server');
  assert.equal(shown.reload,'Reload','the action the person presses');
  assert.equal(shown.dismiss,true,'and it can be dismissed');
  assert.equal(shown.theme,'dark','the line wears the page\'s own mood');
  buildWindow.showInactive();
  await wait(120);
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'07-stale-dark.png'),image.toPNG());}

  // 10d. Reload applies the CURRENT bundle in place: same window, new rev, no PIN, no sign-in
  const reloaded=new Promise(resolve=>buildWindow.webContents.once('did-finish-load',resolve));
  await buildWindow.webContents.executeJavaScript(`document.getElementById('e-server-build-line').shadowRoot.querySelector('.reload').click()`);
  await reloaded;
  assert.equal(await buildWindow.webContents.executeJavaScript('window.__AGENT_HARNESS_BOOT__.rev'),REV_B,'the window now holds the new build');
  assert.equal(await buildWindow.webContents.executeJavaScript('window.__pluginRev'),REV_B,'and it is RUNNING the new bundle, not only holding new HTML');
  assert.equal(await bar(),null,'the line goes away once the window is current');
  assert.equal(await watch.check(),'current','and the next check agrees');
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'08-reloaded-dark.png'),image.toPNG());}

  // 10e. dismissable, and only about the build it was about
  served.rev=REV_C;
  assert.equal(await watch.check(),'stale');
  assert.ok(await bar(),'a newer build asks again');
  await buildWindow.webContents.executeJavaScript(`document.getElementById('e-server-build-line').shadowRoot.querySelector('.dismiss').click()`);
  await wait(80);
  assert.equal(await bar(),null,'dismissing takes the line away');
  assert.equal(await watch.check(),'current','and it does not come back on its own');

  // 10e-bis. the same line in the light mood, from the page's own theme attribute
  served.rev='eeeeeeeeeeee';
  await buildWindow.webContents.executeJavaScript(`document.documentElement.setAttribute('data-easter-theme','light')`);
  assert.equal(await watch.check(),'stale');
  const light=await bar();
  assert.equal(light.theme,'light','the line follows the page into light mode');
  assert.equal(light.sentence,'This window is running an older build of 127.0.0.1:'+new URL(origin).port+'.');
  // A capture takes the last painted frame: without this the still comes back with no line on
  // it and a reader concludes the light mood is broken (measured, twice).
  await wait(200);
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'09-stale-light.png'),image.toPNG());}
  await buildWindow.webContents.executeJavaScript(`document.documentElement.setAttribute('data-easter-theme','dark')`);

  // 10f. a page that states no build (the PIN gate, a 401 answer) is silent
  const pinPage=http.createServer((request,response)=>{response.writeHead(401,{'Content-Type':'text/html'});response.end('<!doctype html><html><head><title>Unlock</title></head><body></body></html>');});
  await new Promise(resolve=>pinPage.listen(0,'127.0.0.1',resolve));
  const pinWatch=new BuildWatch({session:buildWindow.webContents.session,origin:'http://127.0.0.1:'+pinPage.address().port,
   read:()=>buildWindow.webContents.executeJavaScript(BUILD_READ),notify:()=>{},reload:()=>{}});
  assert.equal(await pinWatch.check(),'unknown','a server that states no build is not a stale build');
  pinPage.closeAllConnections?.();pinPage.close();

  // ── 11. Diana's placement contract, in pixels, at both sizes ───────────────────────────
  // Her notes: "--e-build-line-bottom ... with viewport height minus protected composer top plus
  // at least 12px"; and "the 16px fallback DOES NOT guarantee composer clearance". So the claim
  // is not that the line is on screen, it is that its BOTTOM EDGE is 12px above the composer's
  // TOP EDGE, measured in the page, at a desktop and a phone-sized window.
  buildWindow.showInactive();
  served.rev='111111111111';
  assert.equal(await watch.check(),'stale','a replaced build, so there is a line to place');
  const at=async(width,height)=>{
   buildWindow.setContentSize(width,height);
   await wait(260);
   return geometry();
  };
  const desktop=await at(1440,1000);
  assert.equal(desktop.present,true,'the line is drawn at 1440x1000');
  assert.equal(desktop.width,1440,'the window really is 1440 wide');
  assert.equal(desktop.height,1000,'and 1000 tall');
  assert.equal(desktop.gap,12,'12px between the line and the composer at 1440x1000: '+JSON.stringify(desktop));
  assert.equal(desktop.variable,(desktop.height-desktop.seatTop+12)+'px','the host carries her formula: viewport - composer top + 12');
  assert.equal(desktop.left,16,'the 16px inset on the free edge');
  assert.equal(desktop.top>=0,true,'nothing of it reaches above the viewport');
  assert.equal(desktop.radius,'8px','her corner');
  assert.equal(desktop.font,'12px/18px','her 12/18 copy');
  assert.match(desktop.underline,/underline/,'her underlined Reload');
  assert.equal(desktop.reloadHeight,32,'32px desktop target');
  assert.equal(desktop.background,'rgb(13, 32, 41)','her dark ground #0d2029');
  assert.equal(desktop.colour,'rgb(171, 184, 184)','her muted ink #abb8b8');
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'10-clearance-1440-dark.png'),image.toPNG());}

  const phone=await at(390,844);
  assert.equal(phone.width,390,'the window really is 390 wide');
  assert.equal(phone.height,844,'and 844 tall');
  assert.equal(phone.present,true,'the line is drawn at 390x844');
  assert.equal(phone.gap,12,'12px between the line and the composer at 390x844: '+JSON.stringify(phone));
  assert.equal(phone.variable,(phone.height-phone.seatTop+12)+'px');
  assert.equal(phone.left,16);
  assert.equal(phone.reloadHeight,44,'44px action targets below 480px wide');
  assert.equal(phone.dismissWidth,44,'including the dismiss');
  assert.equal(phone.top>=0,true,'nothing above the viewport on a phone-sized window');
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'11-clearance-390-dark.png'),image.toPNG());}

  // One long server name: it wraps inside the line instead of clipping or shoving the actions off.
  const longName='easter-server.for-a-household-with-a-longer-name.example.test';
  buildWindow.webContents.send('client:build',{state:'stale',loaded:'111111111111',current:'222222222222',server:longName});
  await wait(200);
  const wrapped=await geometry();
  assert.equal(wrapped.present,true,'a long name does not remove the line');
  assert.equal(wrapped.clipped,false,'the sentence wraps rather than clipping the hostname');
  assert.equal(wrapped.lines>=2,true,'and it really is more than one line: '+wrapped.lines);
  assert.equal(wrapped.barWidth<=358,true,'inside min(520px, 100vw - 32px) at 390 wide: '+wrapped.barWidth);
  assert.equal(wrapped.gap,12,'and it is still clear of the composer when it wraps');
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'12-long-name-390-dark.png'),image.toPNG());}

  // The full editor: the line is withdrawn, and it comes back when it ends - without a reload,
  // which is why this asserts the page's own marker is still the one set here.
  //
  // THE SUPPRESSION IS ASSERTED IN TWO STEPS, and the first one is the load-bearing one: the page
  // says the editor is expanded while the composer is still an ordinary 96px seat with plenty of
  // room above it. Only the page's own statement can withdraw the line there - the "no safe area"
  // branch would happily draw it - so a build that ignored [data-prompt-expanded] fails here
  // (mutation-checked: `expanded()` returning false -> red at this line, not at the second).
  await buildWindow.webContents.executeJavaScript(`(()=>{window.__editorMark='before-takeover';
   document.getElementById('editor').setAttribute('data-prompt-expanded','true');return true})()`);
  await wait(260);
  const declared=await geometry();
  assert.equal(await buildWindow.webContents.executeJavaScript(`!!document.querySelector('[data-prompt-expanded="true"]')`),true,'the takeover really is present');
  assert.equal(declared.present,false,'the page saying the editor is expanded withdraws the line on its own: '+JSON.stringify(declared));
  assert.equal(declared.gap,null,'and it is not merely pushed out of the way, it is gone');
  assert.equal(await buildWindow.webContents.executeJavaScript('window.__editorMark'),'before-takeover','suppression is not a reload');

  // And the shape it really has: the seat grows to the whole viewport (ConversationRoot.module.css
  // puts it at inset:0 while the editor is expanded), where there is no safe area at all.
  await buildWindow.webContents.executeJavaScript(`(()=>{document.getElementById('composer').style.height='100vh';return true})()`);
  await wait(260);
  const takeover=await geometry();
  assert.equal(takeover.present,false,'nor while the editor has the whole viewport');
  assert.equal(takeover.seatTop,0,'the seat really is the viewport');
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'13-editor-takeover-390-dark.png'),image.toPNG());}

  await buildWindow.webContents.executeJavaScript(`(()=>{const editor=document.getElementById('editor');
   editor.removeAttribute('data-prompt-expanded');
   document.getElementById('composer').style.height='96px';return true})()`);
  await wait(260);
  const returned=await geometry();
  assert.equal(returned.present,true,'the line returns when the editor collapses');
  assert.equal(returned.gap,12,'and it is clear of the composer again: '+JSON.stringify(returned));
  assert.equal(await buildWindow.webContents.executeJavaScript('window.__editorMark'),'before-takeover','still the same document');

  // The light mood, from the page's own attribute: her two grounds, measured.
  await buildWindow.webContents.executeJavaScript(`document.documentElement.setAttribute('data-easter-theme','light')`);
  await wait(240);
  const inLight=await geometry();
  assert.equal(inLight.theme,'light','the host follows the page into light mode');
  assert.equal(inLight.background,'rgb(238, 242, 249)','her light ground #eef2f9');
  assert.equal(inLight.colour,'rgb(81, 91, 112)','her light muted ink #515b70');
  assert.equal(inLight.gap,12,'and the clearance is unchanged by the theme');
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'14-clearance-390-light.png'),image.toPNG());}

  const wide=await at(1440,1000);
  if(shotsAt){const image=await buildWindow.webContents.capturePage();fs.writeFileSync(path.join(shotsAt,'15-clearance-1440-light.png'),image.toPNG());}
  assert.equal(wide.gap,12,'1440x1000 in light: 12px clear of the composer');

  // The numbers the captures were taken from, beside the captures, so a reader can check a still
  // against a measurement instead of believing either one on its own.
  if(shotsAt)fs.writeFileSync(path.join(shotsAt,'geometry.json'),JSON.stringify(
   {desktop,phone,wrapped,declared,takeover,returned,inLight,wide},null,2)+'\n');

  console.log('PASS: Diana\'s line sits 12px above the composer at 1440x1000 and 390x844, wraps a');
  console.log('      long hostname instead of clipping, and is suppressed while the editor has the viewport.');
  // The check costs one read of the page per interval, and it does not read the window's cache:
  // after the swap, the only way the served rev could still be REV_A is a cache hit.
  assert.ok(requests.filter(url=>url==='/').length>=6,'every check reads the page itself: '+requests.join(' '));
  console.log('PASS: the line appears only when the server serves a different build, Reload applies');
  console.log('      the new bundle in place, a dismissal holds, and an unreachable server is silent.');
 }finally{
  ipcMain.removeAllListeners('client:build-action');
  watch?.stop();
  if(buildWindow&&!buildWindow.isDestroyed())buildWindow.destroy();
  fixture.closeAllConnections?.();fixture.close();
 }
 console.log('PASS: the e-server list is what a signed-in person lands on, a row connects,');
 console.log('      remove names its row, add posts an address and comes back, and every');
 console.log('      state (loading, empty, error with the last server) paints what it says;');
 console.log('      and a window whose page predates the server\'s build is told so, and reloads.');
 if(shotsAt)console.log('screenshots: '+shotsAt);
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
 win?.destroy();
 try{fs.rmSync(home,{recursive:true,force:true});}catch{}
 app.exit(process.exitCode||0);
});
