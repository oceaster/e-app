'use strict';
const {contextBridge,ipcRenderer}=require('electron');
if(location.protocol==='file:'){
 contextBridge.exposeInMainWorld('eServerSetup',{
  connect:origin=>ipcRenderer.invoke('client:connect',origin),state:()=>ipcRenderer.invoke('client:state'),
  // The account-scoped list of e-servers. The renderer never sees the Company session or the
  // accounts origin: it names an address, a row or a view, and the main process owns the rest.
  view:value=>ipcRenderer.invoke('client:view',value),refresh:()=>ipcRenderer.invoke('client:servers-refresh'),
  addServer:payload=>ipcRenderer.invoke('client:servers-add',payload),removeServer:(id,label)=>ipcRenderer.invoke('client:servers-remove',id,label),
  retry:()=>ipcRenderer.invoke('client:retry'),download:()=>ipcRenderer.invoke('client:installer'),
  login:(identifier,password)=>ipcRenderer.invoke('company:login',identifier,password),
  provider:provider=>ipcRenderer.invoke('company:provider',provider),providers:()=>ipcRenderer.invoke('company:providers'),
  finish:(username,password)=>ipcRenderer.invoke('company:finish',username,password),
  cancelAccount:()=>ipcRenderer.invoke('company:cancel'),signOut:()=>ipcRenderer.invoke('company:signout'),
  onState:callback=>{const listener=(_,state)=>callback(state);ipcRenderer.on('client:state',listener);return()=>ipcRenderer.removeListener('client:state',listener);}
 });
}else{
 contextBridge.exposeInMainWorld('eServerClient',{
  openExternal:value=>ipcRenderer.invoke('client:external',value),microsoft:()=>ipcRenderer.invoke('client:microsoft'),
  provider:value=>ipcRenderer.invoke('client:provider',value),
  signInFinished:()=>ipcRenderer.send('client:signin-finished'),cancelSignIn:()=>ipcRenderer.invoke('client:cancel-signin'),
  // The e-server page's own two calls (api/profile_assets/handoff.mjs and signout.mjs). They
  // take a destination and nothing else: no Company session, no account document and no server
  // origin crosses this bridge in either direction, because the main process already holds all
  // three. Each answers a promise the page awaits, and main.cjs answers only the connected
  // server's main frame (remote(event)), so a frame that is not this page gets a refusal rather
  // than an answer.
  bindSession:next=>ipcRenderer.invoke('client:handoff',next),signOut:()=>ipcRenderer.invoke('client:signout')
 });
 let last=0;
 for(const kind of ['keydown','pointerdown','input'])window.addEventListener(kind,()=>{if(Date.now()-last>300){last=Date.now();ipcRenderer.send('client:activity');}},{capture:true,passive:true});
}
