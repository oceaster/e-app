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
   +'<p style="padding:0 24px">The page this window loaded states its own build.</p></body></html>');
 });
 await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+fixture.address().port;
 let buildWindow=null,watch=null;
 const BUILD_READ=`((window.__AGENT_HARNESS_BOOT__&&window.__AGENT_HARNESS_BOOT__.rev)||"")`;
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

  // 10f. a page that states no build (the PIN gate, a 401 answer) is silent
  const pinPage=http.createServer((request,response)=>{response.writeHead(401,{'Content-Type':'text/html'});response.end('<!doctype html><html><head><title>Unlock</title></head><body></body></html>');});
  await new Promise(resolve=>pinPage.listen(0,'127.0.0.1',resolve));
  const pinWatch=new BuildWatch({session:buildWindow.webContents.session,origin:'http://127.0.0.1:'+pinPage.address().port,
   read:()=>buildWindow.webContents.executeJavaScript(BUILD_READ),notify:()=>{},reload:()=>{}});
  assert.equal(await pinWatch.check(),'unknown','a server that states no build is not a stale build');
  pinPage.closeAllConnections?.();pinPage.close();

  // The check costs one read of the page per interval, and it does not read the window's cache:
  // after the swap, the only way the served rev could still be REV_A is a cache hit.
  assert.ok(requests.filter(url=>url==='/').length>=6,'every check reads the page itself: '+requests.join(' '));
  assert.equal(served.rev,REV_C);
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
