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
  // THE ACCOUNT'S THEME, FOR THE FIRST PAINT (ticket c28be1de). `theme` is read SYNCHRONOUSLY,
  // here, because a blocking classic script in the document head (desktop/theme-shell.js) is the
  // only shape that finishes before the first frame: it needs the answer at parse time, not a
  // promise. It is the preference the account gave on a PREVIOUS launch, cached under the app's
  // own config directory by desktop/theme.cjs - one small file the main process has already read,
  // handed over as a string. It is public, read-only and bounded, which is why it may cross this
  // bridge at all: a theme preference is not a secret and it names no server.
  // `themeRefresh` asks the main process to re-read the account document (a save in e-server's
  // settings panel is the case): the answer arrives on the usual `client:state` channel.
  theme:(()=>{try{const value=String(ipcRenderer.sendSync('theme:cached')||'');return ['light','dark','system'].includes(value)?value:'';}catch{return '';}})(),
  themeRefresh:()=>ipcRenderer.invoke('client:theme-refresh'),
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
 // THE LOOK IS DIANA'S, BYTE FOR BYTE. BUILD_CSS below is desktop/stale-build-line.css - her
 // file, copied whole (`cmp` clean, pinned by tests/build-rev.test.cjs) with no edit of any kind,
 // because a design that is edited while being followed is a design that has become a guess. Her
 // notes: /home/diana/Desktop/stale-build-line-NOTES.md. It carries no backtick and no `${`, so
 // the file's bytes sit inside this template literal unchanged.
 //
 // IT IS PAINTED FROM THE ISOLATED WORLD, INTO A SHADOW ROOT, AND THE STYLESHEET IS CONSTRUCTED:
 // the server page's CSP allows no inline style, and a shadow root cannot be reached by the
 // page's own sheet, so nothing here can be blocked, restyled or read back by the page. The
 // page's document is the host, and the person sees the same window they were reading.
 //
 // THE PAGE CANNOT DRIVE IT. No bridge is exposed: the buttons send their two actions straight
 // down this preload's own channel, and desktop/main.cjs answers only its connected server's
 // main frame (remote(event)), so a frame of the page - or any other renderer - gets a refusal.
 //
 // ── THE PLACEMENT CONTRACT: A MEASUREMENT, NOT A HOPE ─────────────────────────────────────
 // Diana, 2026-11-04: "CSS inside this shadow root cannot know the underlying composer's bounds.
 // To guarantee 'never cover the composer', please give me a guaranteed reserved bottom-left safe
 // area or a host CSS variable carrying composer clearance (e.g. --e-build-line-bottom)." Her
 // sheet reads that variable and falls back to its own 16px inset, which she is explicit is NOT
 // a composer clearance. So, before the line is drawn, this file measures the composer and sets
 // --e-build-line-bottom on the host to (viewport height - composer top + 12px) - her formula,
 // her gap - and re-measures whenever any of the things that move a composer move: the seat
 // resizes, the document changes, the window resizes, the page or the line scrolls.
 //
 // THE COMPOSER IS [data-composer-seat]: the seat the shell renders around its composer card
 // (packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:117-120, whose
 // stylesheet pins it to the bottom of the conversation). It is a data attribute rather than a
 // hashed CSS-module class for exactly this reason. A read-only transcript renders no seat, an
 // inbox list has none, and the PIN page has none: those fall back to her 16px inset, which is
 // the right answer because there is no composer there to cover.
 //
 // THE FULL EDITOR TAKES THE VIEWPORT ([data-prompt-expanded="true"], InputBar.tsx:655), and her
 // notes are blunt about it: "Suppress the notice when no safe area exists, including full editor
 // takeover or insufficient vertical space." So the line is not drawn during the takeover, and
 // the observer that withdrew it brings it back when the editor collapses - without a reload and
 // without another message from the main process.
 const BUILD_CSS=`/* Replace BUILD_CSS wholesale. Placement contract is in stale-build-line-NOTES.md. */
:host {
  all: initial;
  color-scheme: dark;
  --build-ground: #0d2029;
  --build-ink: #edf1e9;
  --build-muted: #abb8b8;
  --build-line: #ffffff24;
  --build-hover: #ffffff0d;
  --build-shadow: #00000024;
}
:host([data-theme="light"]) {
  color-scheme: light;
  --build-ground: #eef2f9;
  --build-ink: #2b2b36;
  --build-muted: #515b70;
  --build-line: #c7d1e0;
  --build-hover: #14262f0a;
  --build-shadow: #14262f14;
}
.bar {
  box-sizing: border-box;
  position: fixed;
  left: max(16px, env(safe-area-inset-left, 0px));
  bottom: max(var(--e-build-line-bottom, 16px), env(safe-area-inset-bottom, 0px));
  z-index: 2147483000;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 8px;
  width: max-content;
  max-width: min(520px, calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  margin: 0;
  padding: 5px 5px 5px 12px;
  border: 1px solid var(--build-line);
  border-radius: 8px;
  background: var(--build-ground);
  color: var(--build-muted);
  box-shadow: 0 2px 8px var(--build-shadow);
  font: 400 12px/18px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  text-align: left;
  direction: ltr;
}
.sentence { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.server { font-weight: 500; }
button {
  box-sizing: border-box;
  appearance: none;
  display: inline-grid;
  place-items: center;
  min-height: 32px;
  margin: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--build-ink);
  font: 500 12px/18px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  cursor: pointer;
  touch-action: manipulation;
}
.reload {
  padding: 0 6px;
  white-space: nowrap;
  text-decoration: underline;
  text-decoration-color: var(--build-line);
  text-underline-offset: 3px;
}
.dismiss {
  width: 32px;
  padding: 0;
  color: var(--build-muted);
  font-size: 18px;
  font-weight: 400;
}
@media (hover: hover) {
  button:hover { background: var(--build-hover); color: var(--build-ink); }
  .reload:hover { text-decoration-color: currentColor; }
}
button:active { background: var(--build-hover); }
button:focus-visible { outline: 2px solid var(--build-ink); outline-offset: 1px; }
@media (max-width: 480px) {
  .bar { gap: 4px; padding-left: 10px; }
  button { min-height: 44px; }
  .dismiss { width: 44px; }
}
@media (forced-colors: active) {
  .bar { border-color: CanvasText; background: Canvas; color: CanvasText; box-shadow: none; }
  button { color: ButtonText; }
  .reload { text-decoration-color: currentColor; }
  button:focus-visible { outline-color: Highlight; }
}
`;
 const BUILD_HOST='e-server-build-line';
 //: The seat the shell puts its composer in; see the contract above.
 const COMPOSER='[data-composer-seat]';
 //: The page's own full-editor takeover.
 const EXPANDED='[data-prompt-expanded="true"]';
 //: Diana's clearance, from her notes: composer top to the viewport bottom, plus at least 12px.
 const CLEARANCE_GAP=12;
 let buildNode=null,buildWanted=false,buildServer='your e-server';
 let watching=null,watchedSeat=null,framed=0;
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
  const existing=shadow.querySelector('.bar');
  if(existing)return existing;
  const bar=document.createElement('div');bar.className='bar';bar.setAttribute('role','status');bar.setAttribute('aria-live','polite');
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
 function viewportHeight(){return window.innerHeight||(document.documentElement&&document.documentElement.clientHeight)||0;}
 /** Where the composer starts, in viewport coordinates, or null when there is no composer to
  *  clear (a read-only transcript, the inbox list, the PIN page, a seat scrolled out of view). */
 function composerTop(){
  let seat=null;try{seat=document.querySelector(COMPOSER);}catch{return null;}
  if(!seat)return null;
  const box=seat.getBoundingClientRect();
  const height=viewportHeight();
  if(!(box.height>0)||!height)return null;
  if(box.top>=height||box.bottom<=0)return null;
  return box.top;
 }
 function expanded(){try{return !!document.querySelector(EXPANDED);}catch{return true;}}
 function clearLine(){
  if(buildNode&&buildNode.isConnected)buildNode.remove();
  buildNode=null;
 }
 function unwatch(){
  if(!watching)return;
  try{watching.observer.disconnect();}catch{}
  if(watching.resize&&watchedSeat){try{watching.resize.unobserve(watchedSeat);}catch{}}
  try{watching.resize.disconnect();}catch{}
  window.removeEventListener('resize',watching.schedule);
  window.removeEventListener('scroll',watching.schedule,true);
  watching=null;watchedSeat=null;
  if(framed){cancelAnimationFrame(framed);framed=0;}
 }
 function schedule(){
  if(framed)return;
  const run=()=>{framed=0;try{settle();}catch{}};
  framed=typeof requestAnimationFrame==='function'?requestAnimationFrame(run):setTimeout(run,16);
 }
 /** Watch everything that can move a composer or give the editor the viewport. Attached only
  *  while a stale build is waiting, so a current window pays nothing at all. */
 function watch(){
  if(watching)return;
  const schedule2=()=>schedule();
  watching={schedule:schedule2,observer:null,resize:null};
  try{
   const observer=new MutationObserver(schedule2);
   // Two attributes, and both are someone else's statement: the editor taking the viewport, and
   // the household's theme (which this line wears on the host). childList, because a route change
   // replaces the seat rather than moving it.
   observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['data-prompt-expanded','data-easter-theme']});
   watching.observer=observer;
  }catch{}
  try{
   const resize=new ResizeObserver(schedule2);
   const seat=document.querySelector(COMPOSER);
   if(seat){resize.observe(seat);watchedSeat=seat;}
   watching.resize=resize;
  }catch{}
  window.addEventListener('resize',schedule2,{passive:true});
  window.addEventListener('scroll',schedule2,{capture:true,passive:true});
 }
 /** The one place that decides whether the line is drawn, above what, or not at all. */
 function settle(){
  if(!buildWanted){clearLine();unwatch();return;}
  if(expanded()){clearLine();watch();return;}
  const host=buildHost();
  if(!host){clearLine();return;}
  host.dataset.theme=document.documentElement.getAttribute('data-easter-theme')==='light'?'light':'dark';
  const top=composerTop();
  const height=viewportHeight();
  if(top===null||!height)host.style.removeProperty('--e-build-line-bottom');
  else host.style.setProperty('--e-build-line-bottom',(Math.max(0,Math.round(height-top))+CLEARANCE_GAP)+'px');
  const bar=buildLine();
  if(!bar){clearLine();return;}
  const server=bar.querySelector('.server');
  if(server.textContent!==buildServer)server.textContent=buildServer;
  // The fit test, measured on the drawn box rather than estimated: a line that reaches above the
  // viewport is in the composer's way no matter which edge it overlaps, so that is no safe area.
  const box=bar.getBoundingClientRect();
  if(!(box.height>0)||box.top<0||box.bottom>height){clearLine();watch();return;}
  watch();
 }
 ipcRenderer.on('client:build',(_event,value)=>{
  try{
   const next=value||{};
   buildWanted=String(next.state||'')==='stale';
   const server=String(next.server||'').trim();
   if(server)buildServer=server;
   if(!buildWanted){clearLine();unwatch();return;}
   settle();
  }catch{}
 });
 let last=0;
 for(const kind of ['keydown','pointerdown','input'])window.addEventListener(kind,()=>{if(Date.now()-last>300){last=Date.now();ipcRenderer.send('client:activity');}},{capture:true,passive:true});
 // ── THIS CLIENT'S CAMERA, AS A LIVE USER FEED ───────────────────────────────────────────────
 // Owen, 2026-11-06: "Each client connected to an e-server instance MUST access it's web camera and
 // create a stream on the e-server security dashboard ... while logged into e-app and connected to
 // their e-server instance". The device is opened HERE because this window IS the connection: its
 // document is the e-server's own origin, so the publish WebSocket carries the page's own PIN
 // session cookie and the server resolves the account on the upgrade. Closing the window (or
 // losing the server) closes the socket, and the server's recording ends with it.
 //
 // THE PROTOCOL LIVES IN desktop/live-feed.cjs, tested in Node against a fake e-server
 // (tests/live-feed.test.cjs) with no window and no camera. This half is only the device: ask, open,
 // draw one frame per tick into a JPEG, and hand it to the socket. Nothing here draws chrome and
 // nothing gates capture on a viewer: recording is unconditional while connected, and the camera's
 // own LED is the physical awareness (Owen cut the indicator on 2026-11-06).
 const FRAME_WIDTH=640,FRAME_HEIGHT=480,FRAME_QUALITY=0.72;
 function cameraAndMicrophone(){
  let video=null,canvas=null,context=null,streams=[];
  const release=()=>{
   for(const stream of streams){try{stream.getTracks().forEach(track=>track.stop());}catch{}}
   streams=[];
   if(video){try{video.srcObject=null;}catch{}video=null;}
   canvas=null;context=null;
  };
  return {
   async begin(){
    // THE QUESTION FIRST (main.cjs owns it): a denial is reported as `denied`, never as an error
    // and never as silence, and nothing is inferred on the server side.
    let answer={camera:false,microphone:false};
    try{answer=await ipcRenderer.invoke('client:media-ask')||answer;}catch{answer={camera:false,microphone:false};}
    const result={camera:'denied',microphone:'denied',detail:''};
    if(answer.camera){
     try{
      const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:FRAME_WIDTH},height:{ideal:FRAME_HEIGHT}},audio:false});
      streams.push(stream);
      video=document.createElement('video');
      video.muted=true;video.playsInline=true;video.autoplay=true;video.srcObject=stream;
      await video.play();
      canvas=document.createElement('canvas');
      canvas.width=video.videoWidth||FRAME_WIDTH;
      canvas.height=video.videoHeight||FRAME_HEIGHT;
      context=canvas.getContext('2d',{alpha:false});
      if(!context)throw Error('no 2d context');
      result.camera='granted';
     }catch(error){
      // A granted permission with nothing behind it is GRANTED-NO-DEVICE, which the server's state
      // model keeps as its own state: it is not a denial and must never be shown as one.
      result.camera=error&&error.name==='NotAllowedError'?'denied':'granted-no-device';
      result.detail='camera: '+((error&&error.name)||'error')+(error&&error.message?': '+error.message:'');
     }
    }
    if(answer.microphone){
     // The server records video only today (`-an` in e_server/streaming/client_feed.py, a named
     // follow-up), so the microphone is PROVEN and then released rather than held open by an app
     // that is not sending it: the report says what the person allowed, and no device stays busy.
     try{
      const mic=await navigator.mediaDevices.getUserMedia({audio:true});
      try{mic.getTracks().forEach(track=>track.stop());}catch{}
      result.microphone='granted';
     }catch(error){
      result.microphone=error&&error.name==='NotAllowedError'?'denied':'granted-no-device';
      result.detail=(result.detail?result.detail+'; ':'')+'microphone: '+((error&&error.name)||'error');
     }
    }
    return result;
   },
   /** One JPEG for one tick, or null when there is nothing to draw (no device, or not ready). */
   grab(){
    if(!video||!canvas||!context)return Promise.resolve(null);
    const width=video.videoWidth,height=video.videoHeight;
    if(!width||!height)return Promise.resolve(null);
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    return new Promise(resolve=>{
     try{
      context.drawImage(video,0,0,canvas.width,canvas.height);
      canvas.toBlob(blob=>resolve(blob||null),'image/jpeg',FRAME_QUALITY);
     }catch{resolve(null);}
    });
   },
   end(){release();}
  };
 }
 if(/^https?:$/.test(location.protocol)){
  const {LiveFeed}=require('./live-feed.cjs');
  const origin=location.origin;
  let feed=null;
  ipcRenderer.invoke('client:device').then(device=>{
   // No identity, no feed: the server groups by device_id, and an empty one is refused.
   if(!device||!String(device.id||'').trim())return;
   feed=new LiveFeed({
    origin,
    device:{id:String(device.id),name:String(device.name||'')},
    capture:cameraAndMicrophone(),
    log:line=>{try{ipcRenderer.send('client:feed-log',line);}catch{}},
    status:value=>{try{ipcRenderer.send('client:feed-status',value);}catch{}},
   });
   feed.start();
  }).catch(()=>{});
  // Closing the window (or navigating away, which is a new document and therefore a new epoch) says
  // goodbye deliberately, so the server flushes and closes the segment instead of waiting for a drop.
  window.addEventListener('pagehide',()=>{try{feed?.stop('this window is closing');}catch{}},{once:true});
 }
}
