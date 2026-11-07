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
 // ── THE PERMISSION SCREEN'S ADAPTER, WHICH LIVES HERE ON PURPOSE ────────────────────────────
 // desktop/permission/permission.html, its stylesheet and its module are Diana's files and ship
 // byte for byte (cmp clean, asserted by scripts/permission-screen-smoke.cjs). The behaviour they
 // need is attached from this preload rather than from a script tag she would have to carry, and
 // it is HER contract, not one invented here: the state is `body[data-permission-state]`, which is
 // the selector her CSS owns, and her `setPermissionState` also makes the stage inert, marks it
 // busy and disables both buttons while an answer is being carried out.
 //
 // WHY THE ADAPTER RESTATES THREE LINES OF HER MODULE. Her `permission.mjs` is a `<script
 // type="module">` inside a file:// document, and Chromium refuses a module script from an opaque
 // origin (and her own CSP says `script-src 'self'`): it never runs in the app. So the state is
 // painted here, in the preload, exactly as her module would have painted it — dataset, inert,
 // aria-busy, disabled — and her module stays the specification rather than a runtime dependency.
 const PERMISSION_STATES=['asking','os-pending','allowed','denied'];
 if(location.pathname.endsWith('permission.html')){
  // THE SCREEN WEARS THE APP'S THEME, NOT ITS OWN APPROXIMATION. Owen, 2026-11-06: "the camera &
  // microphone permission screen is not consistently styled and respecting the global light/dark
  // theme style guide". Diana's sheet consumes the host's --ec-* custom properties with standalone fallbacks
  // (`--permission-bg: var(--ec-bg, #111311)`), and her NOTES say the canonical palette was not in
  // the sources she was given — so without the host's own theme sheets every custom property falls back to
  // an approximation (#111311 against the real #0d2029 dark and #eef2f9 light). These are the same
  // sheets desktop/shell.html loads, in the same order, injected here rather than in her file.
  const HOST_SHEETS=['vendor/launcher/theme/theme.css','vendor/launcher/theme/launcher-light.css',
   'vendor/launcher/theme/launcher-light-adapter.css','vendor/launcher/theme/launcher-bindings.css',
   'connections.css','connections-adapter.css','shell.css'];
  // A PRELOAD RUNS BEFORE THE PARSER HAS A <head>: `document.head` is null here (measured
  // 2026-11-06 — appending then threw "Cannot read properties of null" and the whole preload,
  // including the two buttons, never loaded). The sheets are appended as soon as a head exists.
  const injectSheets=()=>{
   if(!document.head)return;
   for(const href of HOST_SHEETS){
    if(document.querySelector('link[data-host-sheet="'+href+'"]'))continue;
    const link=document.createElement('link');
    link.rel='stylesheet';link.href='../'+href;link.setAttribute('data-host-sheet',href);
    document.head.appendChild(link);
   }
  };
  const firstPaint=()=>{injectSheets();paintTheme(undefined);};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',firstPaint,{once:true});
  else firstPaint();
  // THE THEME ITSELF COMES FROM THE STATE, not from her `sources/theme-shell.js`: that classic
  // script is inside a document whose CSP says `script-src 'self'`, and whether it runs is a
  // decision this adapter must not depend on for something as visible as the palette.
  // THE CACHED PREFERENCE, READ THE SAME WAY THE SHELL READS IT: a synchronous answer from the
  // main process, available before the first paint, so a light-theme person never sees the dark
  // fallback flash and then repaint.
  let cachedTheme='';
  try{cachedTheme=String(ipcRenderer.sendSync('theme:cached')||'');}catch{cachedTheme='';}
  const resolveTheme=value=>{
   if(value==='light'||value==='dark')return value;
   try{return window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}catch{return 'dark';}
  };
  const paintTheme=next=>{
   // NOTHING HERE MAY COST THE PERSON THEIR BUTTONS. At preload time `document.documentElement`
   // can still be null (measured 2026-11-06: appending to a null head, then setting an attribute
   // on a null root, each threw and the whole preload failed — the screen painted but Allow did
   // nothing). So a theme that cannot be painted yet is retried, and any failure is contained.
   const root=document.documentElement;
   if(!root)return;
   try{
    const chosen=String((next&&next.theme)||cachedTheme||'');
    root.setAttribute('data-easter-theme',resolveTheme(chosen));
    root.style.colorScheme=resolveTheme(chosen);
   }catch{}
  };
  const paint=next=>{
   const raw=String((next&&next.permission&&next.permission.state)||'asking');
   const state=PERMISSION_STATES.includes(raw)?raw:'asking';
   const asking=state==='asking';
   // HER SELECTOR IS `:root[data-permission-state]`, and her module mirrors that attribute into
   // inert/disabled/aria-busy through a MutationObserver. The mirror below is the same three lines
   // done by hand, because a `<script type="module">` does not run from a file:// document (opaque
   // origin, and her own CSP keeps it to 'self'): with her module inert the mirror is what keeps an
   // answered screen from being clickable twice.
   document.documentElement.dataset.permissionState=state;
   const stage=document.getElementById('permission-stage');
   if(stage){stage.inert=!asking;stage.setAttribute('aria-busy',String(state==='os-pending'));}
   for(const button of document.querySelectorAll('[data-permission-answer]'))button.disabled=!asking;
  };
  const choose=value=>{
   const state=document.documentElement.dataset.permissionState||'asking';
   if(state!=='asking')return;                       // one answer per screen, enforced twice
   paint({permission:{state:'os-pending'}});         // lock the view until the main process answers
   ipcRenderer.send('client:permission-answer',String(value||'deny'));
  };
  document.addEventListener('click',event=>{
   const button=event.target&&event.target.closest?event.target.closest('#permission-allow, #permission-deny, [data-permission-answer]'):null;
   if(!button)return;
   event.preventDefault();
   if(button.disabled)return;
   const named=button.getAttribute('data-permission-answer');
   choose(named||(button.id==='permission-allow'?'allow':'deny'));
  });
  ipcRenderer.on('client:state',(_event,next)=>{paintTheme(next);paint(next);});
  ipcRenderer.invoke('client:permission-state').then(next=>{paintTheme(next);paint(next);}).catch(()=>{});
 }
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
}