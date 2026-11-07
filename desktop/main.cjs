'use strict';
const {app,BrowserWindow,Menu,Tray,ipcMain,shell,dialog,session,safeStorage,desktopCapturer,nativeTheme}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),https=require('node:https'),os=require('node:os');
const {pathToFileURL}=require('node:url');
const {HEADER,CLIENT,serverRequest,serverOrigin,externalURL,connectionLink,trusted,localFrame,updateLevel,relaunchOptions}=require('./security.cjs');
const updater=require('./updater.cjs');
const bridge=require('./bridge.cjs');
const {Connections}=require('./connections.cjs');
const {loadServerPage,showingFile}=require('./navigation.cjs');
const {IdleLock}=require('./idle-lock.cjs');
const {LiveFeed}=require('./live-feed.cjs');
const {BuildWatch}=require('./build-rev.cjs');
const mediaPermission=require('./media-permission.cjs');
const {CompanyAccount}=require('./company.cjs'),{CompanyMicrosoft}=require('./company-microsoft.cjs');
const {AccountTheme,resolve:resolveTheme,readCache:readThemeCache,writeCache:writeThemeCache,THEME_CACHE_FILE}=require('./theme.cjs');
const vault=require('./vendor/launcher/vault.cjs'),{providerSignIn}=require('./vendor/launcher/providers.cjs');
// ── DEBUG IS ITS OWN SWITCH ─────────────────────────────────────────────────────────────────────
// Owen, 2026-11-07: "both e-server and e-app have 'debug mode' flags ... in production mode these
// things should never have exposing error messages". Resolved ONCE here, by `--debug` / `-no-debug`
// or E_APP_DEBUG, defaulting to production when packaged — and defaulting to DEBUG in a debug pack,
// whose `resources/debug-pack` marker is written only by `npm run pack:debug`. `development` above is
// a different fact (a fixture origin, a dev tree) and is NOT debug: a packaged build started with
// --debug is debug.
// What it changes is DETAIL only — which engine entry loads, whether diagnostics() answers, whether
// a failure carries its stack — never a permission, a secret or the shape of what a page receives.
const {resolveDebug,engineEntry}=require('./debug.cjs');
const DEBUG=resolveDebug({argv:process.argv,env:process.env,isPackaged:app.isPackaged,resourcesPath:process.resourcesPath});
const DEBUG_MODE=DEBUG.debug;
const ENGINE_ENTRY=engineEntry({debug:DEBUG_MODE,base:__dirname});
console.log(`[e-app] mode=${DEBUG_MODE?'debug':'production'} (${DEBUG.source}) engine=${ENGINE_ENTRY.where}`);
const {createLocalAI,userFailure,detailFor,redact}=require(ENGINE_ENTRY.require);
// THE LOCAL MODEL ENGINE (Dexter's foundation): measured, planned and run on THIS person's computer.
// It is created in start() because it needs `app` ready for its userData path; nothing it does is
// visible in the window yet — the tier control is a design ticket of its own.
// THE SHIPPED ARTIFACT, NOT THE READABLE SOURCES: desktop/local-ai/dist/local-ai.cjs is ONE minified
// file built from desktop/local-ai/src/ by scripts/build-local-ai.cjs, and package.json excludes the
// sources from the packaged app. `npm run build:local-ai -- --check` fails if the dist file is stale.
// In DEBUG the readable sources are loaded instead (see desktop/debug.cjs's `engineEntry`), which is
// the "non-obfuscated files for debugging" half of the owner's rule. Same API either way.
const VERSION=require('../package.json').version,RUNTIME=process.versions.electron;
const HOME=path.join(app.getPath('appData'),'Easter Company','e-server-client'),UPDATES=path.join(HOME,'updates');
app.setPath('userData',HOME);app.setAppUserModelId('ltd.easter.eserver');
const development=!app.isPackaged,fixture=development?process.env.E_SERVER_CLIENT_TEST_ORIGIN:null;
const icon=path.join(__dirname,'icon.png'),shellFile=path.join(__dirname,'shell.html'),permissionFile=path.join(__dirname,'permission','permission.html');
// THE GROUND THE WINDOW WEARS BEFORE THE PAGE PAINTS. It is the account page's own colour in
// each theme - account.css's #0d2029 ground in dark, site/launcher-light.css's --bg #eef2f9 in
// light - because the window paints for the frames before the document does. The old literal
// was GitHub-dark #0d1117, which belongs to no surface of this product: it read as a colder,
// bluer near-black against the page's teal ground, and in light mode it flashed dark under a
// white card.
//
// IT IS THE ACCOUNT'S ANSWER NOW (ticket c28be1de), falled back to the OS: `themePreference` is
// the last theme the account document gave (read on this launch or cached from the last one), and
// `system` resolves through the platform exactly as the page resolves it. The OS alone was the
// whole of this window's theme logic, and it painted a light window at an account saved on `dark`.
// chrome paints this ground BEFORE any document exists, so it is the one layer the page cannot
// correct - a wrong palette here is the flash the person reports.
const ground=()=>resolveTheme(themePreference,nativeTheme.shouldUseDarkColors)==='dark'?'#0d2029':'#eef2f9';
const installer='https://github.com/oceaster/e-app/releases/latest';
let config={},win=null,setup=null,tray=null,quitting=false,ready=false,pollTimer=null,auth=null,externalAuth=false;
let activity=Date.now(),downloads=0,requests=new Set(),failures=0,captureGranted=false,restartOnClosed=false,pendingServer=null,restartingHidden=false;
let state={phase:'auth',version:VERSION,server:'',accountBusy:true,view:'servers',servers:{state:'idle',rows:[],error:'',limit:0,fallback:''}};
// The account-scoped list of e-servers (desktop/connections.cjs). `accountsOrigin` is the one
// author of the API address - the vendored account client - and is read at initializeCompany.
let accountsOrigin='';
let activeSession=null;
let idleLock=null,idleTimer=null,idleCookieListener=null,buildWatch=null;
//: The account's theme preference ('light'|'dark'|'system'|null), read from the account document
//: and cached under the app's own config directory - see the theme block below and desktop/theme.cjs.
let themePreference=null,themeRefreshAt=0,themeReading=null;
const THEME_CACHE=path.join(HOME,THEME_CACHE_FILE);
//: How often a window that regains focus may re-read the account document. A save in e-server's
//: settings panel is made on another surface, so the shell asks again when it is looked at - but a
//: focus is not a reason to ask a service a question it answered a moment ago.
const THEME_REFRESH_MIN_MS=30000;
let company=null,windowAccount=null,pendingLink=null,localAI=null;
// ── THIS INSTALL'S OWN IDENTITY, AND ITS CAMERA'S PERMISSION ──────────────────────────────────
// Owen, 2026-11-06: "Each client connected to an e-server instance MUST access it's web camera and
// create a stream on the e-server security dashboard ... I can then also login on a secondary
// client in parallel with another camera". So the e-server's publish socket needs a device id that
// is STABLE for this installation and UNIQUE between one person's machines: generated once, kept
// under the app's own config directory, and never anything the account or the operating system
// hands out - a hostname is not an identity (two machines can share one) and an account name is
// not a device (one person has several). `device_name` is a LABEL the dashboard prints and the
// server never keys on, so the hostname is fine there.
const DEVICE_FILE=path.join(HOME,'device.json');
let deviceIdentity=null,deviceReading=null;
//: The answer the person gave to this app's own camera/microphone question, per channel, for the
//: CURRENT connection. `null` means "not asked yet" — never "denied" — because a permission nobody
//: requested must not be reported or remembered as a refusal.
let mediaGrant={camera:null,microphone:null},mediaAsking=null;
//: The app's own screen for this question (desktop/permission.html — Diana's file, byte for byte)
//: and the state the adapter paints on it.
let permissionState={state:'',blurred:false};
//: The one live publisher for this connection (desktop/live-feed.cjs). Its life is a SOCKET's life:
//: one per connected document, ended when that document goes away, so every reconnect is a new
//: epoch by construction. `feedGrabs` holds the frame requests waiting on the renderer, and
//: `feedAnswer` the one waiting on the permission answer.
let feed=null,feedWindow=null,feedAnswer=null,feedCookie='';
const feedGrabs=new Map();
//: What the publisher in the connected window last told this process (desktop/live-feed.cjs), kept
//: so the app's own log and a diagnostic can answer "is the feed up, and did the server refuse it".
let feedStatus={state:'idle',origin:'',epoch:'',frames:0,camera:'',microphone:'',error:null};
const inspect=(file,manifest)=>{const pkg=require(file+'/package.json');if(!updater.identifies(pkg,manifest))throw Error('Invalid e-server client update.');};
if(!app.requestSingleInstanceLock()){app.quit();}else{
 app.on('second-instance',(_,argv)=>{const link=argv.find(v=>v.startsWith('e-server:'));if(link)void receiveLink(link);else show();});
 app.on('open-url',(event,url)=>{event.preventDefault();void receiveLink(url);});
 app.whenReady().then(start).catch(error=>{explain('e-server could not start',error);app.quit();});
}
function show(){if(!company?.authorized()){setupWindow();return;}const target=win||setup;if(target){target.show();target.focus();}}
/** THE DEVICE-INSTANCE PERMISSION RELATIONSHIP IS PERSISTENT. Owen, 2026-11-06: "the
 *  device-instance permission relationship should be persistent and the user should not be
 *  prompted again". It is keyed by the e-server ORIGIN and stored with the rest of this install's
 *  settings (0600): this device's answer for THAT instance, for ever, across restarts and
 *  sign-ins. A second e-server is a different relationship and is asked once on its own. */
function mediaDecision(origin){return mediaPermission.decisionFor(config,origin);}
async function rememberMediaDecision(origin,decision){config=mediaPermission.remember(config,origin,decision);await save().catch(()=>{});}
function showingPermission(){return showingFile(win,permissionFile);}
function publish(next){state={...state,...next,...company?.view(),version:VERSION,theme:themePreference,server:company?.authorized()?config.server||'':''};if(setup&&!setup.isDestroyed())setup.webContents.send('client:state',state);if(showingPermission())win.webContents.send('client:state',state);}
function accountChanged(){if(!company?.authorized()){win?.hide();publish({phase:'auth',title:'Sign in to Easter Company.',error:''});setupWindow();}else publish({});}
function changeServer(){if(!company?.authorized()){setupWindow();return;}void openServers();}
// ONE SIGN-OUT, BOTH SCOPES (docs/COMPANY_LOGIN.md). The client's OWN half ends FIRST - the
// memory token cleared, the keyring entry removed and the app back at its own sign-in screen,
// exactly as this flow always did - and only then does the main process report it to the
// connected server, which ends the PIN session and revokes the binding behind it. The order
// is the contract: the server's answer may only say 'ended' about a global session that is
// already gone here (desktop/bridge.cjs). The tray menu and the server page's own sign-out
// both come through here, so a menu and a top-nav sign-out cannot drift apart. The page's
// bridge call adds no dialog: that question belongs to the tray, where a menu item is a
// destructive action.
function endCompanySession(){
 const origin=config.server,connected=activeSession;
 return bridge.endSession({origin,endOwn:()=>company.signOut(),send:(url,init)=>connected?connected.fetch(url,init):Promise.reject(Error('Connect to your e-server first.'))});
}
async function signOutCompany(){
 const choice=await dialog.showMessageBox(win||setup||undefined,{type:'question',buttons:['Cancel','Sign out'],defaultId:0,cancelId:0,message:'Sign out of Easter Company?',detail:'Save your work first. The client will lock until you sign in again.'});
 if(choice.response===1)return endCompanySession();
 return null;
}
// window.eServerClient.bindSession(next): the MAIN process proves the Easter Company session it
// already holds, so the server can bind this PIN session to that account instead of asking the
// person to sign in a second time. The token is read here and leaves the main process only as
// the Authorization header of that one POST - never into a renderer, a URL, a redirect, a log
// line or an update payload. Answers {ok:true,next} or {ok:false,error}; it never rejects into
// the page, because the page's fallback is its catch and a named code is the honest refusal.
// THE ONE DOOR to the Company session in this process (the rule desktop/company.cjs states):
// the handoff to a server and the account-scoped e-server list both prove the session, and both
// ask this function rather than reaching into the session themselves - so "what can read the
// session" is one name to audit instead of a grep across call sites.
function companyToken(){return company.credential();}
function bindCompanySession(next){
 let token='';
 try{token=companyToken();}catch{return Promise.resolve({ok:false,error:'company_sign_in_required',status:0,detail:''});}
 const connected=activeSession;
 return bridge.bindSession({origin:config.server,token,next,send:(url,init)=>connected?connected.fetch(url,init):Promise.reject(Error('Connect to your e-server first.'))});
}
// ── the build this window is showing (desktop/build-rev.cjs) ─────────────────────────────
// A deploy replaces the server's client bundles. A window that is already open keeps the
// JavaScript it loaded, so a shipped fix keeps looking unshipped until the page is reloaded -
// Owen watched exactly that happen twice on 2026-11-03. The watch compares the rev the document
// in this window was composed from against the rev the server serves now, and offers a reload:
// never a restart, never a modal, and nothing at all when either side cannot be read.
function stopBuildWatch(){
 if(buildWatch)buildWatch.stop();
 buildWatch=null;
}
function startBuildWatch(current,ses,origin){
 stopBuildWatch();
 let host=origin;try{host=new URL(origin).host;}catch{}
 buildWatch=new BuildWatch({
  session:ses,origin,window:current,
  // What this window holds, read out of the document itself: the field the harness injects
  // before the shell boots. A document that states no build (the PIN gate, a 401, a blank
  // window) answers '' and the check stays silent.
  read:()=>current.webContents.executeJavaScript('((window.__AGENT_HARNESS_BOOT__&&window.__AGENT_HARNESS_BOOT__.rev)||"")'),
  // The current bundle, in place: the same window and the same PIN session, so there is nothing
  // to sign in to. BuildWatch's own reload bypasses the cache (desktop/build-rev.cjs).
  notify:value=>{if(win===current&&!current.isDestroyed())current.webContents.send('client:build',{...value,server:host});}
 });
 buildWatch.window=current;buildWatch.start();
 const watch=buildWatch;current.once('closed',()=>{if(buildWatch===watch)stopBuildWatch();});
 return buildWatch;
}
async function initializeCompany(){
 const {AccountClient,companySession,publicAccount,API_ORIGIN}=await import('./vendor/launcher/account-client.mjs');
 const testAPI=development?process.env.E_SERVER_ACCOUNTS_TEST_ORIGIN:null;
 // The e-server list lives on the same accounts service, so it speaks to the same origin the
 // sign-in does - including a development fixture's loopback origin.
 accountsOrigin=testAPI||API_ORIGIN;
 if(testAPI){const address=new URL(testAPI);if(address.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(address.hostname))throw Error('The test account service must be loopback HTTP.');}
 const accounts=new AccountClient({client:'e-server/'+VERSION,...(testAPI?{baseUrl:testAPI}:{} )});
 const microsoftAccount=new CompanyMicrosoft({accounts,openExternal:url=>shell.openExternal(externalURL(url)),log:{append(){}}});
 const options={safeStorage};
 company=new CompanyAccount({client:accounts,toSession:companySession,publicAccount,file:path.join(HOME,'company.enc'),
  vault:{writeEncrypted:(file,value)=>vault.writeEncrypted(file,value,options),readEncrypted:file=>vault.readEncrypted(file,options),remove:vault.remove},
  microsoft:signal=>microsoftAccount.signIn(()=>{},signal),provider:(provider,signal)=>providerSignIn(accounts,provider,{signal,openExternal:url=>shell.openExternal(externalURL(url))}),changed:accountChanged});
 return accounts;
}
// ── the account-scoped list of e-servers (Owen, 2026-11-03) ──────────────────────────────
// "when you login, before you connect to any e-server, there should be an intermediary view
// where users can select which e-server instance they want to connect to." So afterCompany no
// longer connects to the last server: it opens the list. `config.server` survives as THIS
// machine's memory of the last server, and that is all it is now - the list is the account's.
// It is still offered, quietly, in the list's error state: the client's job is to reach your
// server, and a read of the accounts service failing must not be a locked door.
function connectionsClient(){
 if(!accountsOrigin)throw Error('The Easter Company account service is not ready yet.');
 return new Connections({origin:accountsOrigin,development,credential:companyToken});
}
function serve(next){state={...state,servers:{...state.servers,...next}};publish({});}
// ── the account's theme, and this window's first paint (ticket c28be1de) ─────────────────────
// Owen, 2026-11-05: "user settings should be global and the same rules apply across all
// interfaces". The account's own settings document is the store, every interface reads it, and the
// client's own window is an interface: `GET /v2/accounts/settings` on the accounts service the
// sign-in already uses, read HERE because the Company session lives here and `companyToken()` is
// the one door to it (desktop/company.cjs states the rule) - so the token never reaches a
// renderer and the renderer never names an address. It is never read from a connected e-server: that service translates the same
// document for its own pages, and a second store is the defect, not the fix.
//
// THE ANSWER IS PUBLISHED, so the open window repaints in the frame that learns it, and CACHED, so
// the NEXT launch's first painted frame already carries it (desktop/theme.cjs, and the synchronous
// read in desktop/preload.cjs that desktop/theme-shell.js takes at parse time).
//
// A READ THAT FAILS CHANGES NOTHING ON SCREEN. The last known answer stands - the cache, or the OS
// before the account has ever answered - because a theme is not worth an error sentence over a
// person's account card, and a wrong palette is the one outcome this whole block exists to avoid.
function themeClient(){
 if(!accountsOrigin)throw Error('The Easter Company account service is not ready yet.');
 return new AccountTheme({origin:accountsOrigin,credential:companyToken});
}
function readAccountTheme({force=false}={}){
 if(!company?.authorized()||!accountsOrigin)return Promise.resolve(themePreference);
 if(themeReading)return themeReading;
 // The bound is the FOCUS path's, not the account's: a sign-in always asks (there is nothing
 // more certainly new than the document of the person who just signed in), and a window that
 // comes back into the light asks at most once per THEME_REFRESH_MIN_MS.
 if(!force&&Date.now()-themeRefreshAt<THEME_REFRESH_MIN_MS)return Promise.resolve(themePreference);
 if(!force)themeRefreshAt=Date.now();
 themeReading=(async()=>{
  try{
   const answer=await bounded(themeClient().read(),SERVER_LIST_WATCHDOG_MS,'The account theme');
   if(answer.preference!==themePreference){
    themePreference=answer.preference;
    await writeThemeCache(THEME_CACHE,themePreference);
    publish({});
   }
  }catch{/* the last known answer stands; see above */}
  finally{themeReading=null;}
  return themePreference;
 })();
 return themeReading;
}
// A READ THAT NEVER ANSWERS MUST NOT HOLD THE SCREEN IN `loading`.
// Owen, 2026-11-04: the e-server list is bare 60-70% of the time after signing out and back in —
// no rows, no Add control, no sentence. The client's request carries its own timeout, but this
// function awaits more than a fetch: a session read, one retry and whatever the transport does all
// end here, and any of them failing to settle leaves the published state at `loading` for ever.
// So the wait is bounded once more and answered in the service's own vocabulary — a timeout the
// view draws as an error with Retry, never silence and never a success.
const SERVER_LIST_WATCHDOG_MS=15000;
function bounded(promise,ms,what){
 let timer=null;
 return Promise.race([
  promise.then(value=>({value})),
  new Promise(resolve=>{timer=setTimeout(()=>resolve({timedOut:true}),ms);}),
 ]).then(result=>{
  if(timer!==null)clearTimeout(timer);
  if(result.timedOut)throw Object.assign(Error(what+' did not answer in time.'),{code:'timeout'});
  return result.value;
 });
}
async function refreshServers(){
 const fallback=config.server||'';
 serve({state:'loading',error:'',fallback});
 try{
  let answer=await bounded(connectionsClient().list(),SERVER_LIST_WATCHDOG_MS,'The e-servers list');
  // ONE migration, once, for a client that already knew a server: without it an upgrade would
  // land an existing person on an empty list and lose the only address they had.
  if(!answer.connections.length&&fallback&&!config.connectionMigrated){
   config.connectionMigrated=true;
   try{await connectionsClient().add({origin:fallback});answer=await connectionsClient().list();}catch{}
   await save();
  }
  serve({state:answer.connections.length?'ready':'empty',rows:answer.connections,limit:answer.limit||0,error:'',fallback});
  return {ok:true};
 }catch(error){
  serve({state:'error',rows:[],error:error.message||'Your e-servers could not be loaded.',fallback});
  return {ok:false,error:error.message||'unreachable'};
 }
}
async function openServers(){
 if(!company?.authorized()){accountChanged();return;}
 // The account's theme is read on the way in, so the list and the card are never painted in the
 // wrong palette while the person looks at them.
 void readAccountTheme();
 publish({phase:'setup',view:'servers',title:'Your e-servers.',message:'Choose an e-server to connect to. It will ask for its own PIN.',error:''});
 setupWindow();await refreshServers();
}
function stopIdleLock(){
 if(idleTimer)clearInterval(idleTimer);idleTimer=null;
 if(idleCookieListener&&activeSession)activeSession.cookies.removeListener('changed',idleCookieListener);
 idleCookieListener=null;idleLock=null;
}
function startIdleLock(current,ses,origin){
 stopIdleLock();
 const controller=new IdleLock({
  lock:async()=>{
   if(win!==current||current.isDestroyed())return;
   // Destroy the old document and its connections before dropping its PIN cookie.
   current.webContents.stop();
   await current.loadURL('about:blank');
   await ses.cookies.remove(origin,'sec_session');
   if(win!==current||current.isDestroyed()||idleLock!==controller)return;
   idleCookieListener=(_event,cookie,_cause,removed)=>{
    if(!removed&&cookie.name==='sec_session'&&cookie.value&&idleLock===controller){
     ses.cookies.removeListener('changed',idleCookieListener);idleCookieListener=null;controller.authenticated();
    }
   };
   ses.cookies.on('changed',idleCookieListener);
   await loadServerPage(current,origin+'/');
  },
  disconnect:async()=>{
   if(win!==current)return;
   stopIdleLock();win=null;windowAccount=null;activeSession=null;
   current.destroy();
   if(company?.authorized())await openServers();
  }
 });
 idleLock=controller;idleTimer=setInterval(()=>void controller.tick(),1000);
 current.once('closed',()=>{if(idleLock===controller)stopIdleLock();});
}
/**
 * Is there an e-server at this address? The service's own liveness answer (`/healthz`, the path
 * scripts/deploy.sh polls) is the check, bounded, and it names nothing about the person: a wrong
 * address gets one sentence rather than a spinner. `/healthz` answers `ok`.
 *
 * NOT `probe`: that name is already the UPDATER's (it asks GitHub for the latest client version),
 * and a second declaration of one name in this module silently replaced the first - which is how
 * `addServer` came to compare a server's health against "1.0.10". tests/main-shape.test.cjs now
 * fails on any duplicated top-level name.
 */
function probeServer(origin){
 return new Promise(resolve=>{
  let url;try{url=new URL('/healthz',origin);}catch{return resolve(null);}
  const lib=url.protocol==='http:'?http:https;
  const request=lib.get(url,{timeout:8000,headers:{[HEADER]:CLIENT}},response=>{
   let body='';response.setEncoding('utf8');
   response.on('data',chunk=>{if(body.length<64)body+=chunk;});
   response.on('end',()=>resolve({status:response.statusCode,body:body.trim()}));
  });
  request.on('error',()=>resolve(null));
  request.on('timeout',()=>{request.destroy();resolve(null);});
 });
}
async function addServer({origin,label}={}){
 const normalized=serverOrigin(origin,{development});
 const answer=await probeServer(normalized);
 if(!answer||answer.status!==200||!/^ok/i.test(answer.body))throw Error('No e-server answered at that address.');
 const row=await connectionsClient().add({origin:normalized,label});
 await refreshServers();
 return {ok:true,row};
}
async function removeServer(id,label){
 const name=label||'this e-server';
 const choice=await dialog.showMessageBox(setup||win||undefined,{type:'warning',buttons:['Cancel','Remove'],defaultId:0,cancelId:0,message:'Remove '+name+' from your list?',detail:'The server itself is not changed. You can add it again with its address.'});
 if(choice.response!==1)return {ok:false,cancelled:true};
 try{await connectionsClient().remove(id);}catch(error){serve({state:'ready',error:error.message});return {ok:false,error:error.message};}
 await refreshServers();
 return {ok:true};
}
/**
 * Connect to one e-server origin. The list's rows, a connection link and the tray all arrive
 * here, so the confirmation, the restart-on-switch and the record of "this was the server you
 * used" live in one place. The PIN is the SERVER's question, asked by the server's own gate the
 * moment this window loads it - the app never holds, asks for or forwards a PIN.
 */
async function connectTo(value){
 const origin=serverOrigin(value,{development});
 const row=(state.servers.rows||[]).find(item=>item.origin===origin);
 if(win&&origin===config.server){if(setup&&!setup.isDestroyed())setup.close();win.show();win.focus();return {ok:true,same:true};}
 if(win){
  const choice=await dialog.showMessageBox(win,{buttons:['Cancel','Switch server'],defaultId:0,cancelId:0,message:'Switch your e-server connection?',detail:'Finish transfers and save your work first.'});
  if(choice.response!==1)return {ok:false,cancelled:true};
  pendingServer=origin;quitting=true;restartOnClosed=true;win.close();
 }else{
  config.server=origin;await save();
  if(row)void connectionsClient().touch(row.id).catch(()=>{});
  await connect();
 }
 return {ok:true};
}
async function afterCompany(){
 if(!company.authorized())return;
 // A sign-in is the one moment the account's document is certainly this person's and certainly
 // new: read it before the window is built, so the cached answer is in place for the next launch
 // and the published one arrives with the first state this window receives.
 void readAccountTheme({force:true});
 if(pendingLink){const target=pendingLink;pendingLink=null;publish({phase:'setup',view:'servers',title:'Your e-servers.',error:''});setupWindow();await receiveLink(target,true);return;}
 await openServers();
}
async function save(){await fs.mkdir(HOME,{recursive:true,mode:0o700});const tmp=path.join(HOME,'settings-'+crypto.randomUUID()+'.tmp');await fs.writeFile(tmp,JSON.stringify(config),{mode:0o600});await fs.rename(tmp,path.join(HOME,'settings.json'));}
// ── this install's device identity (see DEVICE_FILE above) ─────────────────────────────────────
// GENERATED ONCE, KEPT FOREVER, and handed to the publisher in the connected window: a reconnect, a
// restart and a release all keep the same id, so the dashboard groups this machine under its
// person and never mistakes it for a different client. A file that cannot be written still yields
// an identity for this run (an unwritable HOME must not mean "no feed"), it is just not stable.
// ── THE LIVE USER FEED: one socket per connected document ────────────────────────────────────
// Owen, 2026-11-06. The socket lives HERE because this process owns the connection and holds the
// session: the server resolves the account from the `sec_session` cookie on the upgrade itself, and
// this is the one place that cookie is already in hand (the app's own cookie jar, for the server
// this window is on). The DEVICE stays in the renderer — it is the only process with a camera —
// and the two halves talk through four messages: state, grab, frame, gone.
//
// A DOCUMENT IS AN EPOCH. The feed starts when the connected window finishes loading a document and
// stops when that document navigates away or the window closes, so a reload (the PIN gate handing
// over to the real page) is a new socket and therefore a new epoch, and no report from the old one
// can be applied to the new one.
const MEDIA_ANSWER_TIMEOUT_MS=120000;   // a person may look at the question for a while
const FRAME_TIMEOUT_MS=5000;            // one tick's answer: a slow renderer drops a frame

/** EVERY `[live-feed]` LINE, ON DISK. Started from the desktop launcher the app's console is
 * invisible, so a socket that dropped every seven seconds on 2026-11-06 left nothing to read and
 * the only account of it was the server's. One file per install, trimmed once per run when it has
 * grown past a megabyte, and never a throw: logging must not be able to stop a feed. */
const FEED_LOG_MAX_BYTES = 1024 * 1024;
let feedLogTrimmed = false;
function feedLogPath(){ try { return path.join(app.getPath('userData'), 'live-feed.log'); } catch { return ''; } }
function feedLog(line){
 const file = feedLogPath();
 if(!file) return;
 const text = new Date().toISOString() + ' ' + String(line) + '\n';
 const append = () => { fs.appendFile(file, text).catch(() => {}); };
 if(feedLogTrimmed){ append(); return; }
 feedLogTrimmed = true;
 fs.stat(file).then(info => (info.size > FEED_LOG_MAX_BYTES ? fs.writeFile(file, '') : null)).catch(() => {}).finally(append);
}

/** THE CAMERA'S OWN WINDOW. A media stream belongs to a document, and the e-server UI is
 * server-rendered — so a camera opened by the page a person is reading dies every time they click
 * a link (Owen, 2026-11-06: "every time I switch page my web cam turns off and comes back on").
 * The device therefore lives in this hidden window, which loads desktop/capture.html once and is
 * never navigated, and the visible window is free to reload as often as it likes.
 *
 * Measured before it was built: a hidden BrowserWindow with `show:false` and
 * `backgroundThrottling:false` held getUserMedia and produced a real 640x480 JPEG on every grab
 * for nine seconds (2026-11-06, /tmp/captest: `hidden=true visible=false`, frames 6554-9142 bytes).
 * It is created on the first feed, never shown, and destroyed with the app.
 */
const captureFile=path.join(__dirname,'capture.html');
let captureWindow=null,captureReady=null;
async function feedCaptureWindow(){
 if(!activeSession)return null;                 // no connection, so no feed to publish
 if(captureWindow&&!captureWindow.isDestroyed()&&captureReady){await captureReady;return captureWindow;}
 if(captureWindow&&!captureWindow.isDestroyed()){await captureReady;return captureWindow;}
 captureWindow=new BrowserWindow({show:false,width:320,height:240,focusable:false,skipTaskbar:true,
  title:'e-server camera',
  webPreferences:{session:activeSession,preload:path.join(__dirname,'capture-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,backgroundThrottling:false}});
 captureWindow.setMenu(null);captureWindow.setMenuBarVisibility(false);
 captureWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 captureWindow.on('closed',()=>{captureWindow=null;captureReady=null;});
 captureReady=new Promise(resolve=>{
  const done=()=>resolve();
  captureWindow.webContents.once('did-finish-load',done);
  setTimeout(done,5000);                            // a load that fails must not hang the feed
  captureWindow.loadFile(captureFile).catch(()=>{});
 });
 await captureReady;
 return captureWindow;
}
/** The capture document's own door, the same shape as `remote()`: this window, this file. */
function captureRequest(event){
 if(!captureWindow||captureWindow.isDestroyed()||event.sender!==captureWindow.webContents)throw Error('This request did not come from the camera window.');
 if(event.senderFrame&&event.senderFrame.url!==pathToFileURL(captureFile).href)throw Error('This request did not come from the camera document.');
}
/** The feed's channels answer the camera window, and still answer the server page if it ever asks. */
function feedSender(event){
 if(captureWindow&&!captureWindow.isDestroyed()&&event.sender===captureWindow.webContents){captureRequest(event);return;}
 remote(event);
}

/** A WebSocket factory that presents the connection's own PIN session cookie on the upgrade. */
function feedSocket(cookie){
 return function(url){
  // Electron 44's WebSocket (undici) takes the handshake's headers as its second argument, which is
  // what lets the socket present a cookie that belongs to the app's jar rather than the page's.
  return new WebSocket(url,{headers:cookie?{Cookie:'sec_session='+cookie}:{}});
 };
}
async function sessionCookie(){
 try{
  if(!activeSession||!config.server)return '';
  const rows=await activeSession.cookies.get({name:'sec_session',url:config.server});
  return rows&&rows[0]?String(rows[0].value||''):'';
 }catch{return '';}
}
function tellFeed(window,channel,...args){try{if(window&&!window.isDestroyed())window.send(channel,...args);}catch{}}
/** Resolve the one pending camera question with an answer (or with nothing, when it is dropped). */
function answerStates(states){
 const pending=feedAnswer;
 feedAnswer=null;
 if(!pending)return;
 clearTimeout(pending.timer);
 pending.resolve(states&&typeof states==='object'?states:{});
}
/** The renderer's answer to the camera question; no answer leaves both channels where they are. */
function rendererStates(window){
 return new Promise(resolve=>{
  if(!window||window.isDestroyed())return resolve({});
  const pending={resolve,timer:null};
  pending.timer=setTimeout(()=>{
   if(feedAnswer===pending)feedAnswer=null;
   resolve({});
  },MEDIA_ANSWER_TIMEOUT_MS);
  if(pending.timer.unref)pending.timer.unref();
  feedAnswer=pending;
  tellFeed(window,'client:feed-begin');
 });
}
/** One frame from the renderer, or null: the request answers once and every wait is bounded. */
function rendererFrame(window){
 return new Promise(resolve=>{
  if(!window||window.isDestroyed())return resolve(null);
  const id=crypto.randomUUID();
  const timer=setTimeout(()=>{feedGrabs.delete(id);resolve(null);},FRAME_TIMEOUT_MS);
  if(timer.unref)timer.unref();
  feedGrabs.set(id,frame=>{clearTimeout(timer);resolve(frame);});
  tellFeed(window,'client:feed-grab',id);
 });
}
/** The device is opened from the permission screen, BEFORE the person is let in, so an operating
 *  system dialog that appears while it opens has the screen behind it — blurred, per Owen,
 *  2026-11-06: "if there is an os pop-up active waiting for the allow/deny permissions
 *  confirmation then the screen should blur out until the dialogue is interacted with and
 *  complete". */
async function openDeviceFromScreen(){
 const host=await feedCaptureWindow();
 if(!host)return {};
 try{return await rendererStates(host);}catch{return {};}
}
/** Answering the screen: remember it, open the device while the screen stays up, then let them in. */
async function finishPermission(value){
 const current=win;
 if(!current||current.isDestroyed()||!config.server)return;
 const allow=value==='allow';
 mediaGrant={camera:allow,microphone:allow};
 let states={};
 if(allow){
  permissionState={state:'os-pending',blurred:true};
  publish({permission:permissionState});
  states=await openDeviceFromScreen();
 }
 // WHAT THE DEVICE ACTUALLY SAID, not what was clicked: an Allow answered by an operating system
 // refusal is a refusal, and it is that answer the relationship remembers.
 const answered=allow&&states&&states.camera==='granted';
 await rememberMediaDecision(config.server,answered?'granted':'denied');
 if(!answered)mediaGrant={camera:false,microphone:false};
 permissionState={state:answered?'allowed':'denied',blurred:false};
 publish({permission:permissionState});
 if(!current.isDestroyed())await loadServerPage(current,config.server+'/').catch(()=>{});
}
/** True when this document must give way to the permission screen (and it has been shown). */
async function permissionScreenNeeded(current){
 if(!config.server||mediaDecision(config.server))return false;
 // ALREADY ASKING IS THE ANSWER, NOT ANOTHER LOAD. `loadFile` below finishes with
 // `did-finish-load`, whose handler calls this function again; without this line the screen
 // reloaded itself as fast as it could load (measured 2026-11-06 20:54: ~125 loads a second,
 // resetting the page before a person could click Allow).
 if(showingFile(current,permissionFile))return true;
 if(!(await sessionCookie()))return false;           // the PIN gate is still up: nothing to ask yet
 const present=await fs.stat(permissionFile).then(()=>true).catch(()=>false);
 if(!present)return false;                           // no screen shipped: today's dialog stands
 permissionState={state:'asking',blurred:false};
 publish({permission:permissionState});
 await current.loadFile(permissionFile).catch(()=>{});
 return true;
}
/** True while this window is still showing the connected server's page, not the PIN gate, the
 *  permission screen or about:blank. `startFeed` awaits the device and the capture window; the
 *  document can move in that time, and a feed created afterwards would belong to no page at all. */
function connectedDocument(window){
 try{return !!(window&&!window.isDestroyed()&&new URL(window.webContents.getURL()).origin===config.server);}catch{return false;}
}
async function startFeed(window){
 if(!window||window.isDestroyed()||win!==window)return;
 if(!config.server)return;
 if(!connectedDocument(window))return;              // about:blank, the PIN gate, the permission screen
 const cookie=await sessionCookie();
 // A PAGE LOAD IS NOT A NEW CONNECTION. The socket belongs to this server and this window; only the
 // capture belongs to a document. Replacing the feed on every load minted a new epoch each time and
 // left the dashboard a row per reload (measured 2026-11-06 19:19-19:21: thirteen of them in two
 // minutes, epochs :6 to :13, the webcam released and reopened with each). So a reload of the same
 // origin re-binds the capture and keeps the socket, the epoch and the recording.
 //
 // THE SOCKET'S COOKIE IS PART OF THAT IDENTITY. The first document can finish loading before the
 // PIN gate has set `sec_session`; keeping that socket through the next load leaves the publisher
 // unauthenticated for the whole connection, and the server closes its upgrade with 1006 (measured
 // 2026-11-06 in scripts/live-feeds-e2e.cjs). Re-bind only while the session is the same; when it
 // has arrived or changed, the socket is replaced rather than inherited.
 if(feed&&!feed.stopped&&feed.origin===config.server&&cookie===feedCookie){
  const host=await feedCaptureWindow();
  if(!host||!connectedDocument(window))return;    // the document keeps publishing; nothing to re-bind to
  feedWindow=host;
  const line='the document reloaded; re-binding the feed (epoch '+(feed.epoch||'pending')+')';
  console.log('[live-feed] '+line);feedLog('[live-feed] '+line);
  try{feed.retarget();}catch{}
  return;
 }
 stopFeed(feed&&!feed.stopped&&feed.origin===config.server
  ?'the session changed after the socket was opened'
  :'a new document is publishing');
 const identity=await device();
 if(!String(identity.id||'').trim()){console.log('[live-feed] no device identity for this install; not publishing');return;}
 if(!cookie)console.log('[live-feed] this window has no signed-in session on '+config.server+' yet; the server will refuse the socket until it does');
 // The camera's window, never the page's: the page reloads, the device does not.
 const host=await feedCaptureWindow();
 if(!host){console.log('[live-feed] no camera window for this connection; not publishing');return;}
 // The permission screen can replace the page while the device is being opened. That load's
 // handler already stopped the feed; do not resurrect it for a document that is no longer there.
 if(!connectedDocument(window))return;
 feedWindow=host;
 feed=new LiveFeed({
  origin:config.server,
  device:{id:String(identity.id||''),name:String(identity.name||'')},
  capture:{
   // `feedWindow`, not the constructor's `window`: a retarget after a reload moves this to the
   // document that is now live, without touching the socket.
   begin:()=>rendererStates(feedWindow),
   grab:()=>rendererFrame(feedWindow),
   end:()=>{answerStates({});tellFeed(feedWindow,'client:feed-stop');},
  },
  WebSocketImpl:feedSocket(cookie),
  // The app's own log, one prefix for every line the publisher writes: a refusal, a reconnect and
  // a dropped frame are all findable beside the app's other lines, and none of them is chrome.
  log:line=>{const text=String(line).startsWith('[live-feed]')?String(line):'[live-feed] '+String(line);console.log(text);feedLog(text);},
  status:value=>{feedStatus={...feedStatus,...value};},
 });
 feedCookie=cookie;
 feed.start();
}
function stopFeed(reason){
 console.log('[live-feed] stopping: '+(reason||'unnamed'));feedLog('[live-feed] stopping: '+(reason||'unnamed'));
 const current=feed;
 feed=null;feedWindow=null;feedCookie='';
 answerStates({});
 for(const [,answer] of feedGrabs){try{answer(null);}catch{}}
 feedGrabs.clear();
 if(!current)return;
 try{current.stop(reason||'the connection ended');}catch{}
}
async function device(){
 if(deviceIdentity)return deviceIdentity;
 if(!deviceReading){
  deviceReading=(async()=>{
   try{
    const stored=JSON.parse(await fs.readFile(DEVICE_FILE,'utf8'));
    if(stored&&typeof stored.id==='string'&&stored.id.trim()){
     return {id:stored.id.trim().slice(0,120),name:String(stored.name||'').slice(0,120)||label()};
    }
   }catch{/* no identity yet: this is the first launch, or the file was removed */}
   const name=label();
   const record={id:crypto.randomUUID(),name};
   try{
    await fs.mkdir(HOME,{recursive:true,mode:0o700});
    const tmp=path.join(HOME,'device-'+crypto.randomUUID()+'.tmp');
    await fs.writeFile(tmp,JSON.stringify(record),{mode:0o600});
    await fs.rename(tmp,DEVICE_FILE);
   }catch(error){console.log('[live-feed] this install\'s device id could not be stored: '+sentence(error));}
   return record;
  })().then(record=>{deviceIdentity=record;return record;},()=>({id:crypto.randomUUID(),name:label()}));
  deviceReading.finally(()=>{deviceReading=null;});
 }
 return deviceReading;
}
/** The label the dashboard prints for this machine. A label is never a key (server side: device_id is). */
function label(){const name=String(os.hostname()||'').trim().slice(0,120);return name||'Desktop client';}
// ── THE QUESTION THIS APP ASKS ITS OWN PERSON ─────────────────────────────────────────────────
// PERMISSION IS ASKED, NEVER ASSUMED, and it is asked by the APPLICATION rather than by the page:
// the publisher in the connected window (desktop/preload.cjs) asks through this door, and the answer
// is what the session's media permission checks are then answered from — so one question stands for
// one connection instead of one question per getUserMedia call. `null` means "not asked", which is
// not "denied": a channel nobody answered is reported to the e-server as `pending`, never denied.
function askMedia(){
 if(mediaGrant.camera!==null&&mediaGrant.microphone!==null)return Promise.resolve({...mediaGrant});
 if(!mediaAsking){
  mediaAsking=(async()=>{
   const choice=await dialog.showMessageBox(win||setup||undefined,{type:'question',buttons:['Allow','Deny'],defaultId:1,cancelId:1,title:'e-server camera and microphone',
    message:'Allow e-server to use your camera and microphone?',
    detail:'Your camera becomes a live user feed on '+config.server+', recorded by that server for as long as this window is connected to it.'});
   const granted=choice.response===0;
   mediaGrant={camera:granted,microphone:granted};
   console.log('[live-feed] camera and microphone: '+(granted?'allowed':'denied')+' by the person');
   return {...mediaGrant};
  })().catch(()=>({camera:false,microphone:false})).finally(()=>{mediaAsking=null;});
 }
 return mediaAsking;
}
/** The meaning of a thrown thing, without Electron's "Error invoking remote method" wrapper. */
const sentence=value=>String(value&&value.message!==undefined?value.message:value??'').replace(/^Error invoking remote method '[^']+':\s*(?:Error|TypeError|RangeError|SyntaxError|URIError|ReferenceError|EvalError)?:?\s*/,'');
/**
 * ONE SENTENCE AND A NEXT STEP, WITH THE DETAIL IN THE LOG.
 * The owner's rule: production must not print a stack, an argv, a path or an upstream body at a
 * person. `userFailure` maps the failure's code to a sentence and a next step; `detailFor` writes the
 * whole thing to this process's own log, and only in debug does it reach the dialog.
 */
function explain(title,error,next){
 const plain=userFailure(error,next?{next}:undefined);
 const detail=redact(detailFor(error,DEBUG_MODE));
 console.log(`[e-app] ${title}: ${plain.code} ${detail}`);
 try{dialog.showErrorBox(title,DEBUG_MODE?`${plain.message}\n\n${detail}`:`${plain.message}\n\n${plain.next}`);}catch{}
 return plain;
}
/** The permission screen's own door: this window, this file, nothing else. */
function permissionFrame(event){
 if(!win||event.sender!==win.webContents)throw Error('This request did not come from this window.');
 if(!event.senderFrame||event.senderFrame.url!==pathToFileURL(permissionFile).href)throw Error('This request did not come from the permission screen.');
}
function local(event){if(!localFrame(event)||event.senderFrame.url!==pathToFileURL(shellFile).href)throw Error('This action is only available in e-server setup.');}
function remote(event){company?.require();if(!config.server||!win||event.sender!==win.webContents||!trusted(event,config.server))throw Error('This request did not come from your e-server.');}
const preferences=(ses)=>({session:ses,preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false});
function setupWindow(){
 if(setup&&!setup.isDestroyed()){setup.show();return setup;}
 setup=new BrowserWindow({width:680,height:860,minWidth:360,minHeight:500,autoHideMenuBar:true,backgroundColor:ground(),icon,webPreferences:preferences(session.fromPartition('setup'))});
 setup.setMenu(null);setup.setMenuBarVisibility(false);
 setup.loadFile(shellFile);setup.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 // EVERY DOCUMENT GETS THE CURRENT STATE ONCE IT HAS LOADED.
 // `publish()` is a broadcast into a window that may not be listening yet, and this window is
 // created AFTER the first publish: `openServers()` publishes the setup phase, then builds the
 // window, then awaits `refreshServers()`. When the accounts service answers quickly - a warm
 // Lambda, which is the usual case right after signing in - the one send that carried the rows
 // reaches a document that has not subscribed, and the renderer's own `client:state` was
 // answered while the state still said `loading`. Both the rows and the Add control are hidden
 // in `loading`, so the person sees an EMPTY list with no options and no error, and nothing ever
 // repairs it. That is the reported 60-70% "the e-server selector is empty after signing out and
 // back in": not a service answer, a last event lost between two processes. Re-publishing on
 // every finished load makes the state object authoritative for each document, including a
 // reload, so the order of the window and the read no longer decides the screen.
 setup.webContents.on('did-finish-load',()=>publish({}));
 setup.webContents.on('will-navigate',(event,url)=>{if(url!==pathToFileURL(shellFile).href)event.preventDefault();});
 setup.on('closed',()=>{setup=null;if(!win&&!quitting)app.quit();});return setup;
}
function persistent(){return safeStorage.isEncryptionAvailable()&&(!safeStorage.getSelectedStorageBackend||safeStorage.getSelectedStorageBackend()!=='basic_text');}
async function connect(){
 // A server switch ends the old connection's engine before anything else happens: a llama-server
 // started under the previous origin is no longer this window's, and its VRAM is not ours to hold.
 localAI?.syncTrust();
 if(!company?.authorized()){accountChanged();return;}
 if(win){if(windowAccount===company.key()){if(setup)setup.close();win.show();return;}const previous=win;win=null;previous.destroy();}
 if(!config.server){publish({phase:'setup',title:'Your e-server.',error:''});setupWindow();return;}
 const remembered=persistent();
 const partition=(remembered?'persist:':'')+'server-'+crypto.createHash('sha256').update(config.server+'\0'+company.key()).digest('hex').slice(0,24);
 activeSession=session.fromPartition(partition);
 // A REMEMBERED ANSWER IS NOT A QUESTION. If this device has already answered for this instance
 // the person is never asked again; the camera simply stays as they chose. Only an instance this
 // device has no relationship with yet starts from "not asked".
 const decided=mediaDecision(config.server);
 mediaGrant=decided?{camera:decided==='granted',microphone:decided==='granted'}:{camera:null,microphone:null};
 permissionState={state:'',blurred:false};
 const oldVersion=config.serverVersions?.[config.server];
 if(oldVersion&&updateLevel(oldVersion,VERSION)!=='patch')await activeSession.clearCache();
 if(oldVersion&&updateLevel(oldVersion,VERSION)==='major')await activeSession.clearStorageData();
 config.serverVersions={...config.serverVersions,[config.server]:VERSION};await save();
 activeSession.webRequest.onBeforeSendHeaders((details,callback)=>{
  const headers={...details.requestHeaders};delete headers[HEADER];delete headers[HEADER.toLowerCase()];
  // The harness uses another TLS port on the same server. This UI hint carries no credentials.
  if(serverRequest(details.url,config.server))headers[HEADER]=CLIENT;
  if(!['GET','HEAD','OPTIONS'].includes(details.method)&&serverRequest(details.url,config.server))requests.add(details.id);
  callback({requestHeaders:headers});
 });
 const complete=details=>requests.delete(details.id);
 activeSession.webRequest.onCompleted(complete);activeSession.webRequest.onErrorOccurred(complete);
 activeSession.setPermissionCheckHandler((contents,permission,origin,details)=>{
  // `origin` arrives as a URL (Electron states it as the requesting origin, with a trailing
  // slash), so it is normalised before it is compared with the server this window is on: a raw
  // string comparison refused every check on the connected server, which is why a page's own
  // getUserMedia could only ever fail.
  let from='';try{from=new URL(String(origin)).origin;}catch{from='';}
  // THE CAMERA DOCUMENT IS THIS APP'S OWN FILE, not the server's origin: the device lives in
  // desktop/capture.html so that a page load cannot take it away (see `feedCaptureWindow`). It is
  // named here by its exact path, so no other local page can borrow the permission.
  const captureDocument=pathToFileURL(captureFile).href;
  const requesting=String(contents&&typeof contents.getURL==='function'?contents.getURL():'');
  if(from!==config.server&&requesting!==captureDocument)return false;
  if(permission==='media'){
   // ONLY AN ANSWER THE PERSON GAVE. `null` is "not asked", so a check that arrives before the
   // question is refused - the publisher's own flow asks first, then calls getUserMedia.
   const kind=details&&details.mediaType;
   if(kind==='video')return mediaGrant.camera===true;
   if(kind==='audio')return mediaGrant.microphone===true;
   return mediaGrant.camera===true&&mediaGrant.microphone===true;
  }
  return permission==='fullscreen'||permission==='clipboard-sanitized-write';
 });
 activeSession.setPermissionRequestHandler(async(contents,permission,answer,details)=>{
  const requested=String(details.requestingUrl||contents.getURL()||'');
  let origin;try{origin=new URL(requested).origin;}catch{return answer(false);}
  const fromCapture=requested===pathToFileURL(captureFile).href;
  if((origin!==config.server&&!fromCapture)||!['media','notifications','display-capture','clipboard-sanitized-write','fullscreen'].includes(permission))return answer(false);
  if(['fullscreen','clipboard-sanitized-write'].includes(permission))return answer(true);
  if(permission==='media'){
   // The publisher's question has already been asked (and answered) in this app's own words, so a
   // media request from the same origin is answered from that answer rather than asking twice.
   if(mediaGrant.camera!==null||mediaGrant.microphone!==null){
    const kinds=Array.isArray(details.mediaTypes)?details.mediaTypes:[];
    const allowed=kinds.length?kinds.every(kind=>kind==='video'?mediaGrant.camera===true:kind==='audio'?mediaGrant.microphone===true:false):mediaGrant.camera===true;
    return answer(allowed);
   }
   return answer((await askMedia()).camera===true);
  }
  const choice=await dialog.showMessageBox(win,{type:'question',buttons:['Allow','Deny'],defaultId:1,cancelId:1,title:'e-server permission',message:`Allow your e-server to use ${permission==='display-capture'?'screen sharing':'notifications'}?`,detail:config.server});
  if(choice.response===0&&['display-capture'].includes(permission))captureGranted=true;
  answer(choice.response===0);
 });
 activeSession.setDisplayMediaRequestHandler(async(request,answer)=>{
  try{
   if(new URL(request.securityOrigin).origin!==config.server)return answer({});
   const sources=await desktopCapturer.getSources({types:['window','screen'],thumbnailSize:{width:0,height:0}});
   if(!sources.length)return answer({});
   const result=await dialog.showMessageBox(win,{type:'question',title:'Share a screen or window',message:'Choose what your e-server can capture.',buttons:[...sources.map(s=>s.name),'Cancel'],cancelId:sources.length,defaultId:sources.length});
   answer(result.response<sources.length?{video:sources[result.response]}:{});
  }catch{answer({});}
 },{useSystemPicker:true});
 activeSession.on('will-download',(event,item)=>{
  downloads++;item.once('done',()=>{downloads=Math.max(0,downloads-1);});
  item.setSaveDialogOptions({title:'Save from e-server',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))});
 });
 const bounds=config.bounds&&[config.bounds.width,config.bounds.height].every(n=>Number.isFinite(n)&&n>=360)?config.bounds:{width:1280,height:900};
 win=new BrowserWindow({...bounds,minWidth:360,minHeight:500,autoHideMenuBar:true,backgroundColor:ground(),icon,title:'e-server',show:false,webPreferences:preferences(activeSession)});
 win.setMenu(null);win.setMenuBarVisibility(false);windowAccount=company.key();
 const current=win;
 startIdleLock(current,activeSession,config.server);startBuildWatch(current,activeSession,config.server);
 current.webContents.setWindowOpenHandler(({url})=>{void openExternal(url);return {action:'deny'};});
 current.webContents.on('will-attach-webview',event=>event.preventDefault());
 current.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).origin===config.server)return;}catch{}event.preventDefault();void openExternal(url);});
 current.webContents.on('did-fail-load',(_,code,message,url,mainFrame)=>{if(mainFrame&&code!==-3){publish({phase:'offline',title:'Connection unavailable',message:'Connect to your private network or VPN, then try again.',error:message});setupWindow();current.hide();}});
 current.webContents.on('render-process-gone',()=>{stopFeed('the renderer went away');publish({phase:'offline',title:'Your e-server view stopped',message:'Reconnect to restore the server view.',error:''});setupWindow();current.hide();});
 current.once('ready-to-show',()=>{if(!company.authorized()){current.hide();return;}if(setup)setup.close();if(!process.argv.includes('--hidden-to-tray'))current.show();});
 current.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&(input.control||input.meta)&&input.key===','){event.preventDefault();changeServer();}});
 current.on('close',event=>{if(!quitting&&tray){event.preventDefault();current.hide();}});
 // EVERY DOCUMENT OF THE CONNECTED WINDOW IS ONE PUBLISHING SESSION: started when it finishes
 // loading, ended before the next one starts, so a reload is a new socket and a new epoch.
 current.webContents.on('did-finish-load',async()=>{
  if(win!==current)return;
  // THE PERMISSION SCREEN COMES BEFORE THE INSTANCE (Owen, 2026-11-06), and only the first time
  // this device meets this e-server.
  if(await permissionScreenNeeded(current))return;
  await startFeed(current);
 });
 current.webContents.on('did-start-navigation',(event,navigationURL,isInPlace,isMainFrame)=>{
  if(win!==current)return;
  const line='navigation: '+String(navigationURL||'')+' (main='+isMainFrame+' inPlace='+isInPlace+')';
  console.log('[live-feed] '+line);feedLog('[live-feed] '+line);
  if(!isMainFrame||isInPlace)return;
  let navigationOrigin='';try{navigationOrigin=new URL(String(navigationURL||'')).origin;}catch{navigationOrigin='';}
  if(navigationOrigin&&navigationOrigin===config.server)return;   // our own page reloading: the feed survives
  stopFeed('the window navigated to '+(String(navigationURL||'something else')));
 });
 current.on('closed',()=>{if(win===current)stopFeed('the window closed');if(win===current)win=null;if(restartOnClosed){void (async()=>{if(pendingServer){
  config.server=pendingServer;
  // The person chose a server, so the relaunch opens THAT server rather than the list again.
  config.openOnStart=pendingServer;}await save();restart();})().catch(error=>explain('Could not restart e-server',error));}});
 current.on('resize',()=>{if(!current.isMaximized()&&!current.isMinimized()){config.bounds=current.getBounds();void save();}});
 current.webContents.on('will-prevent-unload',async event=>{
  const result=await dialog.showMessageBox(current,{type:'warning',buttons:['Stay','Leave'],defaultId:0,cancelId:0,message:'This page has unsaved work or an active transfer. Leave anyway?'});
  if(result.response===1)event.preventDefault();else{quitting=false;restartOnClosed=false;pendingServer=null;}
 });
 if(!remembered&&!fixture)current.webContents.once('did-finish-load',()=>dialog.showMessageBox(current,{message:'A secure keyring is unavailable.',detail:'Your sign-in will last for this app session only. Enable your operating system keyring to remember it.',buttons:['OK']}));
 await loadServerPage(current,config.server+'/');
}
async function openExternal(value){try{const url=externalURL(value);await shell.openExternal(url);return true;}catch{return false;}}
async function ask(route,{method='GET',body}={}){
 if(!activeSession)throw Error('Connect to your e-server first.');
 const response=await activeSession.fetch(config.server+route,{method,credentials:'include',headers:{[HEADER]:CLIENT,'Content-Type':'application/json','X-Easter-Desktop-Request':'1'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
 let data;try{data=await response.json();}catch{throw Error('Your server did not return a valid response.');}
 if(!response.ok)throw Error(typeof data.detail==='string'?data.detail:'Your server refused this request.');return data;
}
async function microsoft(){
 if(auth)return {ok:false,error:'A sign-in is already in progress.'};
 const controller=new AbortController();auth=controller;
 try{
  const started=await ask('/desktop/auth/microsoft',{method:'POST',body:{}});
  if(new URL(started.url).origin!==config.server)throw Error('The server returned an invalid sign-in address.');
  await shell.openExternal(started.url);
  const deadline=Date.now()+Math.min(600,started.expires_in||600)*1000;
  while(Date.now()<deadline&&!controller.signal.aborted){
   await new Promise(resolve=>setTimeout(resolve,1500));
   const result=await ask('/desktop/auth/'+started.id+'/status');
   if(result.state==='complete')return {ok:true};
   if(result.state==='failed')throw Error(result.error||'Microsoft did not complete sign-in.');
  }
  throw Error(controller.signal.aborted?'Sign-in cancelled.':'This sign-in expired. Try again.');
 }catch(error){return {ok:false,error:error.message};}finally{auth=null;}
}
async function cancelSignIn(){auth?.abort();externalAuth=false;await ask('/desktop/auth/cancel',{method:'POST',body:{}}).catch(()=>{});await ask('/profiles/providers/cancel',{method:'POST',body:{}}).catch(()=>{});if(win)win.loadURL(config.server+'/account');}
function probe(){return new Promise((resolve,reject)=>{const request=https.get(installer,{timeout:15000},response=>{response.resume();const prefix='https://github.com/oceaster/e-app/releases/tag/client-v';if(response.statusCode!==302||!response.headers.location?.startsWith(prefix))return reject(Error('Update service did not return a release.'));const version=response.headers.location.slice(prefix.length);try{updater.version(version);resolve(version);}catch(error){reject(error);}});request.on('error',reject);request.on('timeout',()=>request.destroy(Error('Update check timed out.')));});}
async function mayRestart(){
 if(!win||setup?.isVisible()||win.isFocused()||win.webContents.isCurrentlyAudible()||captureGranted||Date.now()-activity<60000||auth||externalAuth||company?.busy||downloads||requests.size)return false;
 try{return await win.webContents.executeJavaScript("(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return !e.defaultPrevented;})()");}catch{return false;}
}
async function applyStaged(manual=false){
 if(!updater.staged(UPDATES,{current:VERSION,runtime:RUNTIME}))return false;
 if(!manual&&!await mayRestart())return false;
 if(manual&&win){const result=await dialog.showMessageBox(win,{buttons:['Restart','Cancel'],defaultId:1,cancelId:1,message:'Restart e-server to install the verified update?',detail:'Finish active transfers and save your work first.'});if(result.response!==0)return false;}
 const record=await updater.activateStaged({root:UPDATES,current:VERSION,runtime:RUNTIME,inspect});if(!record)return false;
 quitting=true;restartOnClosed=true;restartingHidden=!!win&&!win.isVisible();
 if(win)win.close();else restart();return true;
}
function restart(){
 app.relaunch(relaunchOptions({packaged:app.isPackaged,appPath:app.getAppPath(),hidden:restartingHidden}));app.quit();
}
async function checkUpdate(startup=false,manual=false){
 if(fixture||!app.isPackaged)return;
 try{
  const latest=await probe();
  if(updater.compare(latest,VERSION)>0){
   if(startup){setupWindow();publish({phase:'checking',title:'Updating e-server',message:'Checking the latest desktop client.',error:''});}
   await updater.update({current:VERSION,root:UPDATES,runtime:RUNTIME,inspect,apply:false,notify:startup?value=>publish({...value,title:'Updating e-server'}):()=>{}});
   failures=0;
   if(startup){await updater.activateStaged({root:UPDATES,current:VERSION,runtime:RUNTIME,inspect});quitting=true;restart();return true;}
   await applyStaged(manual);
  }else if(manual){
   await dialog.showMessageBox(win||setup||undefined,{type:'info',message:'e-server is up to date.',detail:'Installed client: '+VERSION,buttons:['OK']});
  }
  failures=0;
 }catch(error){failures=Math.min(3,failures+1);if(startup){setupWindow();publish({phase:'update-error',title:'Update unavailable',message:'The installed client will keep working. Use the app menu to check again.',error:DEBUG_MODE?redact(detailFor(error,true)):''});}else if(manual){const choice=await dialog.showMessageBox(win||setup||undefined,{type:'warning',message:'The update could not be installed.',detail:(DEBUG_MODE?redact(detailFor(error,true)):'The update could not be installed.')+'\nYour installed client will keep working. A new desktop runtime may require the full installer.',buttons:['Download installer','Close'],defaultId:1,cancelId:1});if(choice.response===0)await shell.openExternal(installer);}}
 return false;
}
function schedule(){clearTimeout(pollTimer);pollTimer=setTimeout(async()=>{await checkUpdate();await applyStaged(false);schedule();},Math.min(60,15*2**failures)*60000+Math.random()*90000);pollTimer.unref();}
async function receiveLink(value,originOnly=false){try{const origin=originOnly?serverOrigin(value,{development}):connectionLink(value);await app.whenReady();if(!company?.authorized()){pendingLink=origin;setupWindow();return;}
 // A link is a server someone chose, so it becomes a row: the account's list stays the one place
 // this app knows e-servers from, and a link-only server would otherwise be invisible in it.
 // Best effort and bounded - the link's own job is to connect, not to write a list.
 if(!(state.servers.rows||[]).some(row=>row.origin===origin)){await connectionsClient().add({origin}).catch(()=>{});}
 if(origin===config.server){await connect();return;}if(config.server){const choice=await dialog.showMessageBox(win||undefined,{buttons:['Cancel','Connect'],defaultId:0,cancelId:0,message:'Connect e-server to this server?',detail:origin});if(choice.response!==1)return;}if(win){pendingServer=origin;quitting=true;restartOnClosed=true;win.close();}else{config.server=origin;await save();if(ready)await connect();}}catch(error){dialog.showErrorBox('Invalid e-server connection',error.message);}}
// THE TRAY MENU IS FOUR ITEMS, BY THE OWNER'S OWN LIST. Owen, 2026-11-07:
//   "e-app system tray icon right click drop down menu options should only be: Open / Change
//    server / --- / Sign out / Quit"
// Everything that used to live here is gone: "Cancel sign-in" (the sign-in window has its own
// cancel), "Check for updates" and "Restart to apply update" (a staged update still applies on
// the next launch, which is what `activateVersion` was built for). A later edit that wants a
// fifth item has to change this function AND tests/tray-menu.test.cjs, which is the point: the
// menu is a product decision, not a place to put a button.
function trayTemplate(){
	return [
		{label:'Open',click:show},
		{label:'Change server',click:changeServer},
		{type:'separator'},
		{label:'Sign out',click:()=>void signOutCompany()},
		{label:'Quit',click:()=>{quitting=true;app.quit();}},
	];
}

async function start(){
 await fs.mkdir(HOME,{recursive:true,mode:0o700});
 if(process.platform!=='win32')await fs.chmod(HOME,0o700);
 try{config=JSON.parse(await fs.readFile(path.join(HOME,'settings.json'),'utf8'));if(config.server)config.server=serverOrigin(config.server,{development});}catch{config={};}
 if(fixture)config.server=serverOrigin(fixture,{development:true});
 // THE LAST ANSWER THE ACCOUNT GAVE, before any window exists: `ground()` reads it for the frame
 // colour Electron paints ahead of the document, and the shell's own blocking script reads it
 // through the preload seam below. A machine with no cache and no session has none of this and
 // keeps the OS answer, which is all anybody can know then.
 themePreference=readThemeCache(THEME_CACHE);
 if(app.isPackaged)app.setAsDefaultProtocolClient('e-server');
 Menu.setApplicationMenu(null);
 try{tray=new Tray(icon);tray.setToolTip('e-server');tray.setContextMenu(Menu.buildFromTemplate(trayTemplate()));tray.on('click',show);}catch{}
 ipcMain.handle('client:state',event=>{local(event);return state;});
 // Choosing an e-server, from the list or from anywhere else. One path, so the switch
 // confirmation, the PIN session partition and the restart-on-switch cannot drift apart.
 ipcMain.handle('client:connect',(event,value)=>{local(event);company.require();return connectTo(value);});
 ipcMain.handle('client:view',(event,value)=>{
  local(event);if(!['servers','add'].includes(value))throw Error('Unknown view.');
  // The heading is the view's, and it is published from here so a second renderer (or a resume)
  // cannot show one view's title over another view's content.
  // Both sentences are here, so returning to the list never leaves the add view's instruction
  // standing over the rows (measured: it did, in the same window).
  publish({view:value,
   title:value==='add'?'Add an e-server.':'Your e-servers.',
   message:value==='add'?'Type the HTTPS address of an e-server you can reach.':'Choose an e-server to connect to. It will ask for its own PIN.'});
  return state;
 });
 // The list's four calls answer, they never reject into the page. `local(event)` still throws for
 // any other renderer - that is the door, not a sentence - but everything AFTER the door is a
 // refusal the view can print: "sign in again" is a sentence, and an IPC rejection arrives wrapped
 // in Electron's plumbing ("Error invoking remote method ..."), which is not.
 const answered=work=>async(event,...args)=>{local(event);try{company.require();return await work(...args);}catch(error){return {ok:false,error:sentence(error)};}};
 ipcMain.handle('client:servers-refresh',answered(()=>refreshServers()));
 ipcMain.handle('client:servers-add',answered(payload=>addServer(payload||{})));
 ipcMain.handle('client:servers-remove',answered((id,label)=>removeServer(String(id||''),String(label||''))));
 ipcMain.handle('client:servers-use',answered(async id=>{await connectionsClient().touch(String(id||'')).catch(()=>{});return {ok:true};}));
 // THE PERMISSION SCREEN'S TWO CALLS (desktop/preload.cjs wires them, so Diana's document carries
 // no script of ours): its answer, and the state to paint. Both are guarded to that one file.
 ipcMain.handle('client:permission-state',event=>{permissionFrame(event);return {...state,permission:permissionState};});
 ipcMain.on('client:permission-answer',(event,value)=>{try{permissionFrame(event);}catch{return;}void finishPermission(String(value||'deny'));});
 ipcMain.handle('client:retry',async event=>{local(event);company.require();if(state.phase==='update-error')await checkUpdate(true);else if(win){win.reload();setup.close();win.show();}else await connect();});
 // The two things a person may do about a stale build. `remote(event)` is the existing
 // main-frame-only guard, so the page itself cannot press these: only this preload's buttons
 // send them, and a frame that is not the connected server's main frame gets a refusal.
 ipcMain.on('client:build-action',(event,action)=>{try{remote(event);}catch{return;}if(!buildWatch)return;if(action==='reload')void buildWatch.refresh();else if(action==='dismiss')buildWatch.dismiss();});
 // THE THEME SEAM, in the two directions it is needed (ticket c28be1de).
 // `theme:cached` is SYNCHRONOUS on purpose: desktop/preload.cjs reads it while the shell document
 // is still parsing, because a blocking classic script is the only shape that finishes before the
 // first frame (desktop/theme-shell.js). It answers a preference already in memory - no file read,
 // no service call, no token - and only to THIS window's own preload: any other sender gets ''.
 ipcMain.on('theme:cached',event=>{
  event.returnValue='';
  // THE PERMISSION SCREEN ASKS THIS BEFORE ITS FIRST PAINT (desktop/preload.cjs): it is the app's
  // own document, and a palette is not a secret. Anything else still gets ''.
  const permissionDocument=win&&!win.isDestroyed()&&event.sender===win.webContents
   &&showingFile(win,permissionFile);
  if(!permissionDocument&&(!setup||setup.isDestroyed()||event.sender!==setup.webContents))return;
  event.returnValue=themePreference||'';
 });
 // A window that has the person's attention again asks whether the account document changed (a
 // save in e-server's settings panel). Read-only and bounded by THEME_REFRESH_MIN_MS; it answers
 // the preference the window is already wearing and repaints through `client:state`.
 //
 // IT REPUBLISHES AS IT ANSWERS, which is not redundant: a publish is a broadcast, and a window
 // that is still loading can miss the one that carried the theme (the trap setupWindow's own
 // did-finish-load handler documents). A window that has just asked is listening by definition,
 // so this closes the window where a theme read landing during load painted the OS answer for
 // ever. The read's own publish still covers an answer that arrives later.
 ipcMain.handle('client:theme-refresh',event=>{local(event);void readAccountTheme();publish({});return {ok:true,theme:themePreference||''};});
 ipcMain.handle('client:installer',event=>{local(event);return shell.openExternal(installer);});
 ipcMain.handle('client:external',(event,value)=>{remote(event);return openExternal(value);});
 ipcMain.handle('client:provider',(event,value)=>{remote(event);externalAuth=true;return openExternal(value);});
 ipcMain.handle('client:microsoft',event=>{remote(event);return microsoft();});
 ipcMain.handle('client:cancel-signin',event=>{remote(event);return cancelSignIn();});
 // The server page's two bridge actions. `remote(event)` is the existing main-frame-only guard
 // (this exact window, this exact origin): any other renderer gets a refusal, not an answer, and
 // nothing here can be reached from the setup window or from a frame the app did not load.
 ipcMain.handle('client:handoff',(event,next)=>{remote(event);return bindCompanySession(next);});
 ipcMain.handle('client:signout',event=>{remote(event);return endCompanySession();});
 ipcMain.on('client:activity',event=>{try{remote(event);activity=Date.now();idleLock?.activity();}catch{}});
 // ── the live user feed's three doors (desktop/live-feed.cjs, desktop/preload.cjs) ────────────
 // All three are `remote(event)`: only the connected server's own main frame, in this window, may
 // ask for this install's identity, put the permission question, or report what the feed is doing.
 // None of them takes an argument from the page that names a server, a device or a permission —
 // the main process already holds all three.
 ipcMain.handle('client:device',event=>{remote(event);return device();});
 ipcMain.handle('client:media-ask',event=>{feedSender(event);return askMedia();});
 // The renderer's answers to the feed's own two questions, and the last thing a dying document says.
 // All of them are `remote(event)`: only the connected server's main frame, in this window, may
 // answer for the camera that window opened.
 ipcMain.on('client:feed-state',(event,states)=>{try{feedSender(event);}catch{return;}answerStates(states);});
 ipcMain.on('client:feed-frame',(event,id,frame)=>{
  try{feedSender(event);}catch{return;}
  const answer=feedGrabs.get(String(id||''));
  if(!answer)return;
  feedGrabs.delete(String(id||''));
  answer(frame?Buffer.from(frame):null);
 });
 ipcMain.on('client:feed-gone',event=>{try{feedSender(event);}catch{return;}stopFeed('the camera document went away');});
 // The feed's own status, so a refusal (a `stale_epoch`, a server without the route) is visible in
 // this app rather than only in a closed socket. `[live-feed]` lines on this process's own console
 // are the other half; both are the app's log, and neither is chrome in the window.
 ipcMain.handle('client:feed-status',event=>{remote(event);return feedStatus;});
 ipcMain.on('client:signin-finished',event=>{try{remote(event);externalAuth=false;}catch{}});
 const accounts=await initializeCompany();
 ipcMain.handle('company:login',async(event,identifier,password)=>{local(event);await company.login(identifier,password);await afterCompany();return company.view();});
 ipcMain.handle('company:provider',async(event,provider)=>{local(event);if(!['microsoft','google','steam','discord'].includes(provider))throw Error('Choose a sign-in provider.');await company.signIn(provider);await afterCompany();return company.view();});
 ipcMain.handle('company:providers',event=>{local(event);return accounts.providers();});
 ipcMain.handle('company:finish',async(event,username,password)=>{local(event);await company.finish(username,password);await afterCompany();return company.view();});
 ipcMain.handle('company:cancel',event=>{local(event);company.cancel();});
 ipcMain.handle('company:signout',event=>{local(event);return signOutCompany();});
 await company.restore();
 // THE ENGINE'S TRUST LIST IS A FUNCTION, NOT A SNAPSHOT: `config.server` is the server this person
 // connected to, and it changes when they switch servers. Every bridge call re-reads it, and the
 // engine stops on navigation away from that origin, on window destroy and on quit.
 localAI=createLocalAI({app,ipcMain,BrowserWindow,debug:DEBUG_MODE,trustedOrigins:()=>[config.server].filter(Boolean)});
 // A previous run may have died holding VRAM: adopt its engine if it is still healthy, kill it if not.
 await localAI.recover().catch(()=>{});
 ready=true;const link=process.argv.find(v=>v.startsWith('e-server:'));
 if(link){await receiveLink(link);if(!config.server)return;}
 if(await checkUpdate(true))return;
 // A relaunch that a server choice caused opens that server; every other start opens the list.
 const open=config.openOnStart;
 if(open&&open===config.server){delete config.openOnStart;await save();await connect();}
 else if(company?.authorized())await afterCompany();else await connect();
 schedule();
}
app.on('before-quit',()=>{quitting=true;clearTimeout(pollTimer);auth?.abort();company?.cancel();
 // the camera window is `show:false` and would otherwise keep the app's window count above zero
 try{if(captureWindow&&!captureWindow.isDestroyed())captureWindow.destroy();}catch{}
 captureWindow=null;captureReady=null;stopFeed('the app is quitting');});
app.on('window-all-closed',()=>{if(!restartOnClosed&&(!tray||quitting))app.quit();});
