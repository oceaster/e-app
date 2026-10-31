'use strict';
const {app,BrowserWindow,Menu,Tray,ipcMain,shell,dialog,session,safeStorage,desktopCapturer,nativeTheme}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),https=require('node:https');
const {pathToFileURL}=require('node:url');
const {HEADER,CLIENT,serverRequest,serverOrigin,externalURL,connectionLink,trusted,localFrame,updateLevel,relaunchOptions}=require('./security.cjs');
const updater=require('./updater.cjs');
const bridge=require('./bridge.cjs');
const {CompanyAccount}=require('./company.cjs'),{CompanyMicrosoft}=require('./company-microsoft.cjs');
const vault=require('./vendor/launcher/vault.cjs'),{providerSignIn}=require('./vendor/launcher/providers.cjs');
const VERSION=require('../package.json').version,RUNTIME=process.versions.electron;
const HOME=path.join(app.getPath('appData'),'Easter Company','e-server-client'),UPDATES=path.join(HOME,'updates');
app.setPath('userData',HOME);app.setAppUserModelId('ltd.easter.eserver');
const development=!app.isPackaged,fixture=development?process.env.E_SERVER_CLIENT_TEST_ORIGIN:null;
const icon=path.join(__dirname,'icon.png'),shellFile=path.join(__dirname,'shell.html');
// THE GROUND THE WINDOW WEARS BEFORE THE PAGE PAINTS. It is the account page's own colour in
// each theme - account.css's #0d2029 ground in dark, site/launcher-light.css's --bg #eef2f9 in
// light - because the window paints for the frames before the document does. The old literal
// was GitHub-dark #0d1117, which belongs to no surface of this product: it read as a colder,
// bluer near-black against the page's teal ground, and in light mode it flashed dark under a
// white card. The OS decides here for the same reason it decides in the page: the account has
// published no theme preference yet, and site/theme-early.js (vendored beside the page) reads
// exactly this signal.
const ground=()=>nativeTheme.shouldUseDarkColors?'#0d2029':'#eef2f9';
const installer='https://github.com/oceaster/e-app/releases/latest';
let config={},win=null,setup=null,tray=null,quitting=false,ready=false,pollTimer=null,auth=null,externalAuth=false;
let activity=Date.now(),downloads=0,requests=new Set(),failures=0,captureGranted=false,restartOnClosed=false,pendingServer=null,restartingHidden=false;
let state={phase:'auth',version:VERSION,server:'',accountBusy:true};
let activeSession=null;
let company=null,windowAccount=null,pendingLink=null;
const inspect=(file,manifest)=>{const pkg=require(file+'/package.json');if(!updater.identifies(pkg,manifest))throw Error('Invalid e-server client update.');};
if(!app.requestSingleInstanceLock()){app.quit();}else{
 app.on('second-instance',(_,argv)=>{const link=argv.find(v=>v.startsWith('e-server:'));if(link)void receiveLink(link);else show();});
 app.on('open-url',(event,url)=>{event.preventDefault();void receiveLink(url);});
 app.whenReady().then(start).catch(error=>{dialog.showErrorBox('e-server could not start',error.message);app.quit();});
}
function show(){if(!company?.authorized()){setupWindow();return;}const target=win||setup;if(target){target.show();target.focus();}}
function publish(next){state={...state,...next,...company?.view(),version:VERSION,server:company?.authorized()?config.server||'':''};if(setup&&!setup.isDestroyed())setup.webContents.send('client:state',state);}
function accountChanged(){if(!company?.authorized()){win?.hide();publish({phase:'auth',title:'Sign in to Easter Company.',error:''});setupWindow();}else publish({});}
function changeServer(){if(!company?.authorized()){setupWindow();return;}publish({phase:'setup',title:'Connect to an e-server',error:''});setupWindow();}
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
function bindCompanySession(next){
 let token='';
 try{token=company.credential();}catch{return Promise.resolve({ok:false,error:'company_sign_in_required',status:0,detail:''});}
 const connected=activeSession;
 return bridge.bindSession({origin:config.server,token,next,send:(url,init)=>connected?connected.fetch(url,init):Promise.reject(Error('Connect to your e-server first.'))});
}
async function initializeCompany(){
 const {AccountClient,companySession,publicAccount}=await import('./vendor/launcher/account-client.mjs');
 const testAPI=development?process.env.E_SERVER_ACCOUNTS_TEST_ORIGIN:null;
 if(testAPI){const address=new URL(testAPI);if(address.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(address.hostname))throw Error('The test account service must be loopback HTTP.');}
 const accounts=new AccountClient({client:'e-server/'+VERSION,...(testAPI?{baseUrl:testAPI}:{} )});
 const microsoftAccount=new CompanyMicrosoft({accounts,openExternal:url=>shell.openExternal(externalURL(url)),log:{append(){}}});
 const options={safeStorage};
 company=new CompanyAccount({client:accounts,toSession:companySession,publicAccount,file:path.join(HOME,'company.enc'),
  vault:{writeEncrypted:(file,value)=>vault.writeEncrypted(file,value,options),readEncrypted:file=>vault.readEncrypted(file,options),remove:vault.remove},
  microsoft:signal=>microsoftAccount.signIn(()=>{},signal),provider:(provider,signal)=>providerSignIn(accounts,provider,{signal,openExternal:url=>shell.openExternal(externalURL(url))}),changed:accountChanged});
 return accounts;
}
async function afterCompany(){if(!company.authorized())return;publish({phase:'setup',title:'Your e-server.',message:'Connect to your private network, then enter your server HTTPS address.',error:''});if(pendingLink){const target=pendingLink;pendingLink=null;await receiveLink(target,true);}else await connect();}
async function save(){await fs.mkdir(HOME,{recursive:true,mode:0o700});const tmp=path.join(HOME,'settings-'+crypto.randomUUID()+'.tmp');await fs.writeFile(tmp,JSON.stringify(config),{mode:0o600});await fs.rename(tmp,path.join(HOME,'settings.json'));}
function local(event){if(!localFrame(event)||event.senderFrame.url!==pathToFileURL(shellFile).href)throw Error('This action is only available in e-server setup.');}
function remote(event){company?.require();if(!config.server||!win||event.sender!==win.webContents||!trusted(event,config.server))throw Error('This request did not come from your e-server.');}
const preferences=(ses)=>({session:ses,preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,webviewTag:false,allowRunningInsecureContent:false});
function setupWindow(){
 if(setup&&!setup.isDestroyed()){setup.show();return setup;}
 setup=new BrowserWindow({width:680,height:860,minWidth:360,minHeight:500,autoHideMenuBar:true,backgroundColor:ground(),icon,webPreferences:preferences(session.fromPartition('setup'))});
 setup.setMenu(null);setup.setMenuBarVisibility(false);
 setup.loadFile(shellFile);setup.webContents.setWindowOpenHandler(()=>({action:'deny'}));
 setup.webContents.on('will-navigate',(event,url)=>{if(url!==pathToFileURL(shellFile).href)event.preventDefault();});
 setup.on('closed',()=>{setup=null;if(!win&&!quitting)app.quit();});return setup;
}
function persistent(){return safeStorage.isEncryptionAvailable()&&(!safeStorage.getSelectedStorageBackend||safeStorage.getSelectedStorageBackend()!=='basic_text');}
async function connect(){
 if(!company?.authorized()){accountChanged();return;}
 if(win){if(windowAccount===company.key()){if(setup)setup.close();win.show();return;}const previous=win;win=null;previous.destroy();}
 if(!config.server){publish({phase:'setup',title:'Your e-server.',error:''});setupWindow();return;}
 const remembered=persistent();
 const partition=(remembered?'persist:':'')+'server-'+crypto.createHash('sha256').update(config.server+'\0'+company.key()).digest('hex').slice(0,24);
 activeSession=session.fromPartition(partition);
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
 activeSession.setPermissionCheckHandler((contents,permission,origin)=>{
  if(origin!==config.server)return false;
  return permission==='fullscreen'||permission==='clipboard-sanitized-write';
 });
 activeSession.setPermissionRequestHandler(async(contents,permission,answer,details)=>{
  let origin;try{origin=new URL(details.requestingUrl||contents.getURL()).origin;}catch{return answer(false);}
  if(origin!==config.server||!['media','notifications','display-capture','clipboard-sanitized-write','fullscreen'].includes(permission))return answer(false);
  if(['fullscreen','clipboard-sanitized-write'].includes(permission))return answer(true);
  const choice=await dialog.showMessageBox(win,{type:'question',buttons:['Allow','Deny'],defaultId:1,cancelId:1,title:'e-server permission',message:`Allow your e-server to use ${permission==='media'?'your microphone or camera':permission==='display-capture'?'screen sharing':'notifications'}?`,detail:config.server});
  if(choice.response===0&&['media','display-capture'].includes(permission))captureGranted=true;
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
 current.webContents.setWindowOpenHandler(({url})=>{void openExternal(url);return {action:'deny'};});
 current.webContents.on('will-attach-webview',event=>event.preventDefault());
 current.webContents.on('will-navigate',(event,url)=>{try{if(new URL(url).origin===config.server)return;}catch{}event.preventDefault();void openExternal(url);});
 current.webContents.on('did-fail-load',(_,code,message,url,mainFrame)=>{if(mainFrame&&code!==-3){publish({phase:'offline',title:'Connection unavailable',message:'Connect to your private network or VPN, then try again.',error:message});setupWindow();current.hide();}});
 current.webContents.on('render-process-gone',()=>{publish({phase:'offline',title:'Your e-server view stopped',message:'Reconnect to restore the server view.',error:''});setupWindow();current.hide();});
 current.once('ready-to-show',()=>{if(!company.authorized()){current.hide();return;}if(setup)setup.close();if(!process.argv.includes('--hidden-to-tray'))current.show();});
 current.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&(input.control||input.meta)&&input.key===','){event.preventDefault();changeServer();}});
 current.on('close',event=>{if(!quitting&&tray){event.preventDefault();current.hide();}});
 current.on('closed',()=>{if(win===current)win=null;if(restartOnClosed){void (async()=>{if(pendingServer){config.server=pendingServer;await save();}restart();})().catch(error=>dialog.showErrorBox('Could not restart e-server',error.message));}});
 current.on('resize',()=>{if(!current.isMaximized()&&!current.isMinimized()){config.bounds=current.getBounds();void save();}});
 current.webContents.on('will-prevent-unload',async event=>{
  const result=await dialog.showMessageBox(current,{type:'warning',buttons:['Stay','Leave'],defaultId:0,cancelId:0,message:'This page has unsaved work or an active transfer. Leave anyway?'});
  if(result.response===1)event.preventDefault();else{quitting=false;restartOnClosed=false;pendingServer=null;}
 });
 if(!remembered&&!fixture)current.webContents.once('did-finish-load',()=>dialog.showMessageBox(current,{message:'A secure keyring is unavailable.',detail:'Your sign-in will last for this app session only. Enable your operating system keyring to remember it.',buttons:['OK']}));
 await current.loadURL(config.server+'/');
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
 }catch(error){failures=Math.min(3,failures+1);if(startup){setupWindow();publish({phase:'update-error',title:'Update unavailable',message:'The installed client will keep working. Use the app menu to check again.',error:error.message});}else if(manual){const choice=await dialog.showMessageBox(win||setup||undefined,{type:'warning',message:'The update could not be installed.',detail:error.message+'\nYour installed client will keep working. A new desktop runtime may require the full installer.',buttons:['Download installer','Close'],defaultId:1,cancelId:1});if(choice.response===0)await shell.openExternal(installer);}}
 return false;
}
function schedule(){clearTimeout(pollTimer);pollTimer=setTimeout(async()=>{await checkUpdate();await applyStaged(false);schedule();},Math.min(60,15*2**failures)*60000+Math.random()*90000);pollTimer.unref();}
async function receiveLink(value,originOnly=false){try{const origin=originOnly?serverOrigin(value,{development}):connectionLink(value);await app.whenReady();if(!company?.authorized()){pendingLink=origin;setupWindow();return;}if(origin===config.server){await connect();return;}if(config.server){const choice=await dialog.showMessageBox(win||undefined,{buttons:['Cancel','Connect'],defaultId:0,cancelId:0,message:'Connect e-server to this server?',detail:origin});if(choice.response!==1)return;}if(win){pendingServer=origin;quitting=true;restartOnClosed=true;win.close();}else{config.server=origin;await save();if(ready)await connect();}}catch(error){dialog.showErrorBox('Invalid e-server connection',error.message);}}
async function start(){
 await fs.mkdir(HOME,{recursive:true,mode:0o700});
 if(process.platform!=='win32')await fs.chmod(HOME,0o700);
 try{config=JSON.parse(await fs.readFile(path.join(HOME,'settings.json'),'utf8'));if(config.server)config.server=serverOrigin(config.server,{development});}catch{config={};}
 if(fixture)config.server=serverOrigin(fixture,{development:true});
 if(app.isPackaged)app.setAsDefaultProtocolClient('e-server');
 Menu.setApplicationMenu(null);
 try{tray=new Tray(icon);tray.setToolTip('e-server');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open e-server',click:show},{label:'Change server…',click:changeServer},{label:'Sign out of Easter Company',click:()=>void signOutCompany()},{type:'separator'},{label:'Cancel sign-in',click:()=>{company?.cancel();void cancelSignIn();}},{label:'Check for updates',click:()=>void checkUpdate(false,true)},{label:'Restart to apply update',click:()=>void applyStaged(true)},{type:'separator'},{label:'Quit',click:()=>{quitting=true;app.quit();}}]));tray.on('click',show);}catch{}
 ipcMain.handle('client:state',event=>{local(event);return state;});
 ipcMain.handle('client:connect',async(event,value)=>{local(event);company.require();const origin=serverOrigin(value,{development});if(win){const choice=await dialog.showMessageBox(win,{buttons:['Cancel','Switch server'],defaultId:0,cancelId:0,message:'Switch your e-server connection?',detail:'Finish transfers and save your work first.'});if(choice.response!==1)return;pendingServer=origin;quitting=true;restartOnClosed=true;win.close();}else{config.server=origin;await save();await connect();}});
 ipcMain.handle('client:retry',async event=>{local(event);company.require();if(state.phase==='update-error')await checkUpdate(true);else if(win){win.reload();setup.close();win.show();}else await connect();});
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
 ipcMain.on('client:activity',event=>{try{remote(event);activity=Date.now();}catch{}});
 ipcMain.on('client:signin-finished',event=>{try{remote(event);externalAuth=false;}catch{}});
 const accounts=await initializeCompany();
 ipcMain.handle('company:login',async(event,identifier,password)=>{local(event);await company.login(identifier,password);await afterCompany();return company.view();});
 ipcMain.handle('company:provider',async(event,provider)=>{local(event);if(!['microsoft','google','steam','discord'].includes(provider))throw Error('Choose a sign-in provider.');await company.signIn(provider);await afterCompany();return company.view();});
 ipcMain.handle('company:providers',event=>{local(event);return accounts.providers();});
 ipcMain.handle('company:finish',async(event,username,password)=>{local(event);await company.finish(username,password);await afterCompany();return company.view();});
 ipcMain.handle('company:cancel',event=>{local(event);company.cancel();});
 ipcMain.handle('company:signout',event=>{local(event);return signOutCompany();});
 await company.restore();
 ready=true;const link=process.argv.find(v=>v.startsWith('e-server:'));
 if(link){await receiveLink(link);if(!config.server)return;}
 if(await checkUpdate(true))return;
 await connect();schedule();
}
app.on('before-quit',()=>{quitting=true;clearTimeout(pollTimer);auth?.abort();company?.cancel();});
app.on('window-all-closed',()=>{if(!restartOnClosed&&(!tray||quitting))app.quit();});
