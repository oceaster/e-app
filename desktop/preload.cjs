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
 // ── the one line this window draws itself ───────────────────────────────────────────────
 // Owen, 2026-11-03: a fix shipped, deployed and verified, and his window kept drawing the OLD
 // editor because an open page keeps the client JavaScript it loaded. desktop/build-rev.cjs
 // decides (the document's own boot rev against the server's, see its header); this draws the
 // decision and offers the reload, because the window that shows the server's page has no
 // application document of its own to put it in.
 //
 // IT IS PAINTED FROM THE ISOLATED WORLD, INTO A SHADOW ROOT, AND THE STYLESHEET IS CONSTRUCTED:
 // the server page's CSP allows no inline style, and a shadow root cannot be reached by the
 // page's own sheet, so nothing here can be blocked, restyled or read back by the page. The
 // page's document is the host, and the person sees the same window they were reading.
 //
 // THE PAGE CANNOT DRIVE IT. No bridge is exposed: the buttons send their two actions straight
 // down this preload's own channel, and desktop/main.cjs answers only its connected server's
 // main frame (remote(event)), so a frame of the page - or any other renderer - gets a refusal.
 const BUILD_CSS=`
 .bar{position:fixed;left:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 32px));padding:8px 10px 8px 12px;border-radius:10px;font:500 12.5px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e6edf1;background:#0d2029;border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 26px rgba(0,0,0,.3)}
 :host([data-theme="light"]) .bar{color:#14262f;background:#eef2f9;border-color:rgba(13,32,41,.16);box-shadow:0 10px 26px rgba(13,32,41,.16)}
 .sentence{margin:0;color:inherit}
 .server{font-weight:600}
 button{font:inherit;color:inherit;cursor:pointer}
 .reload{padding:3px 10px;border-radius:7px;border:1px solid rgba(255,255,255,.24);background:transparent}
 :host([data-theme="light"]) .reload{border-color:rgba(13,32,41,.24)}
 .reload:hover{background:rgba(255,255,255,.09)}
 :host([data-theme="light"]) .reload:hover{background:rgba(13,32,41,.07)}
 .dismiss{padding:0 2px;border:0;background:transparent;opacity:.55;font-size:15px;line-height:1}
 .dismiss:hover{opacity:1}
 button:focus-visible{outline:2px solid #6fd0e6;outline-offset:2px}`;
 const BUILD_HOST='e-server-build-line';
 let buildNode=null;
 function buildHost(){
  if(buildNode&&buildNode.isConnected)return buildNode;
  const root=document.documentElement;
  if(!root)return null;
  const host=document.createElement('e-server-build-line');host.id=BUILD_HOST;
  // `open` so the gate that proves this line (scripts/shell-servers.cjs) and any later
  // screenshot tooling can read it from the main process; nothing in the page's own scripts is
  // given a capability by that, because the actions travel down this preload's channel.
  const shadow=host.attachShadow({mode:'open'});
  try{const sheet=new CSSStyleSheet();sheet.replaceSync(BUILD_CSS);shadow.adoptedStyleSheets=[sheet];}catch{}
  document.body?document.body.append(host):root.append(host);
  buildNode=host;buildNode.shadow=shadow;
  return host;
 }
 function buildLine(){
  const host=buildHost();
  if(!host)return null;
  const shadow=host.shadow;
  let bar=shadow.querySelector('.bar');
  if(bar)return bar;
  bar=document.createElement('div');bar.className='bar';bar.setAttribute('role','status');bar.setAttribute('aria-live','polite');
  const sentence=document.createElement('p');sentence.className='sentence';sentence.append(document.createTextNode('This window is running an older build of '));
  const server=document.createElement('span');server.className='server';sentence.append(server,document.createTextNode('.'));
  const reload=document.createElement('button');reload.type='button';reload.className='reload';reload.textContent='Reload';
  reload.addEventListener('click',()=>ipcRenderer.send('client:build-action','reload'));
  const dismiss=document.createElement('button');dismiss.type='button';dismiss.className='dismiss';dismiss.setAttribute('aria-label','Dismiss');
  dismiss.textContent='\u00d7';
  dismiss.addEventListener('click',()=>ipcRenderer.send('client:build-action','dismiss'));
  bar.append(sentence,reload,dismiss);
  shadow.append(bar);
  return bar;
 }
 function drawBuild(value){
  const state=String(value.state||'');
  if(state!=='stale'){
   if(buildNode&&buildNode.isConnected)buildNode.remove();
   buildNode=null;
   return;
  }
  const host=buildHost();
  if(!host)return;
  host.dataset.theme=document.documentElement.getAttribute('data-easter-theme')==='light'?'light':'dark';
  const bar=buildLine();
  if(!bar)return;
  bar.querySelector('.server').textContent=String(value.server||'your e-server');
 }
 ipcRenderer.on('client:build',(_event,value)=>{try{drawBuild(value||{});}catch{}});
 let last=0;
 for(const kind of ['keydown','pointerdown','input'])window.addEventListener(kind,()=>{if(Date.now()-last>300){last=Date.now();ipcRenderer.send('client:activity');}},{capture:true,passive:true});
}
