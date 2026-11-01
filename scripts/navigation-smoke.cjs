// Reproduce the real startup failure with Electron and a disposable local page.
// No account, saved session, PIN, real server or external network is used.
'use strict';
const {app,BrowserWindow}=require('electron');
const http=require('node:http'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const home=fs.mkdtempSync(path.join(os.tmpdir(),'eserver-navigation-'));
app.setPath('userData',home);
let server,window;
const waitLoaded=contents=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{cleanup();reject(Error('The replacement document did not finish loading'));},15000);
 const loaded=()=>{cleanup();resolve();};
 const failed=(_,code,message,url,mainFrame)=>{if(mainFrame&&code!==-3){cleanup();reject(Error('Replacement failed: '+code));}};
 function cleanup(){clearTimeout(timer);contents.removeListener('did-finish-load',loaded);contents.removeListener('did-fail-load',failed);}
 contents.on('did-finish-load',loaded);contents.on('did-fail-load',failed);
});
app.whenReady().then(async()=>{
 const archive=process.argv.find(value=>value.endsWith('.asar'));
 const {loadServerPage}=require(archive?path.resolve(archive)+'/desktop/navigation.cjs':'../desktop/navigation.cjs');
 console.log('Redirect fixture uses '+(archive?'the packaged ASAR':'the source')+' navigation helper.');
 server=http.createServer((request,response)=>{
  response.setHeader('Content-Type','text/html');
  if(request.url==='/system/billing'){response.end('<!doctype html><title>Billing</title><h1 id="billing">Your plan</h1>');return;}
  if(request.url==='/slow.png')return; // Keep the original document's load pending.
  response.end('<!doctype html><img src="/slow.png"><script>location.replace("/system/billing")</script>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 window=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
 let loaded=waitLoaded(window.webContents);
 await assert.rejects(window.loadURL(origin+'/'),error=>error.errno===-3||error.code==='ERR_ABORTED');
 await loaded;
 assert.equal(window.webContents.getURL(),origin+'/system/billing');
 console.log('Reproduced: unhandled loadURL rejects ERR_ABORTED on the billing redirect.');
 loaded=waitLoaded(window.webContents);
 await loadServerPage(window,origin+'/');
 await loaded;
 assert.equal(window.webContents.getURL(),origin+'/system/billing');
 assert.equal(await window.webContents.executeJavaScript('document.querySelector("#billing").textContent'),'Your plan');
 assert.equal(window.isDestroyed(),false);
 console.log('PASS: the fixed startup survives the same redirect and renders billing.');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{
 window?.destroy();server?.closeAllConnections();server?.close();
 // Chromium can retain a profile file handle until process exit on Windows.
 try{fs.rmSync(home,{recursive:true,force:true});}catch{}
 app.exit(process.exitCode||0);
});
