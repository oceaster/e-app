// THE BAR'S CONTROLLER, PORTED FROM e-server AND OWNED BY THE e-app FROM HERE ON.
//
// Owen, 2026-11-09: "simply remove the top nav bar from e-server, and make sure all it's code and
// functionality is moved to e-app." This is that move: it is `/root/e-server/api/shell.py`'s
// `HOST_SCRIPT` (port 2026-11-09), with the substitutions that only make sense in the client —
// every one of them named at the line it happens, and nothing else reworded.
//
// WHAT IS UNCHANGED, and must stay unchanged because the server's framed pages speak it: the
// marker `?shell=1&nav=<id>&tok=<token>&route=<key>`, the child's `shell:ready` / `shell:error`
// messages, the wait panes and her copy, one `aria-current` mark, the 15s timeout, and the
// origin+source+token+navigationId validation before any message is believed.
(function(){
"use strict";
/* ── her copy, verbatim; the tests read it out of api/shell.py's COPY ───────────────────── */
var COPY={"opening_heading": "Opening {destination}…", "opening_detail": "Waiting for the page.", "502": ["Page unavailable", "The e-server could not load this page. Try again in a moment."], "403": ["Access denied", "This account does not have permission to open this page."], "404": ["Page not found", "This page is not available at this address."], "timeout": ["Page did not open", "The page has not reported that it is ready. Try again or choose another destination."], "network": ["Page unavailable", "The page could not be loaded. Check your connection and try again."], "signin": ["Sign-in required", "Open Account to sign in again."]};
var RETRY_LABEL="Try again",SIGNIN_LABEL="Open Account",TIMEOUT_MS=15000,REVEAL_MS=1200;
var DESTINATIONS=[["agents", "Agents", "/agent/harness"], ["swarm", "Swarm", "/agent/harness/epsilons"], ["processes", "Processes", "/agent/harness/processes"], ["messages", "Messages", "/messages"], ["storage", "File Storage", "/system/file-storage"], ["system", "System", "/system"], ["security", "Security", "/security/monitors"], ["billing", "Billing", "/system/billing"], ["events", "Events", "/system/events"], ["permissions", "Permissions", "/system/permissions"]],MENU_KEYS=["system", "security", "billing", "events", "permissions"],DEFAULT_DESTINATION="system";
var ASKED=String(new URLSearchParams(location.search).get("route")||"");
var FIRST_DESTINATION=byKey(ASKED)?ASKED:DEFAULT_DESTINATION;

var bar=document.getElementById("shell-bar");
var frame=document.getElementById("shell-frame");
var status=document.getElementById("shell-status");
var statusHeading=document.getElementById("shell-status-heading");
var statusDetail=document.getElementById("shell-status-detail");
var retry=status.querySelector('[data-action="retry-content"]');
var content=document.getElementById("shell-content");
var menuButton=document.getElementById("shell-menu-button");
var menu=document.getElementById("shell-menu");
var live=document.createElement("p");
live.className="sf-live";live.setAttribute("role","status");live.setAttribute("aria-live","polite");
document.body.append(live);

function byKey(key){
 for(var i=0;i<DESTINATIONS.length;i++)if(DESTINATIONS[i][0]===key)return DESTINATIONS[i];
 return null;
}
function destinations(){return document.querySelectorAll("[data-destination]")}

/* ── the navigation state machine. One token per navigation, never reused ─────────────── */
var nav={id:0,token:"",route:null,started:0,timer:null,reveal:null,source:"chrome",pending:null};

/* ── THE PARENT HINT, frozen with e-server on 2026-11-09 ────────────────────────────────────
   A framed page posts its verdict to its parent. When the parent is this document its origin is
   OPAQUE (`file://`), so an exact targetOrigin matches nothing: the child is told which origin to
   aim at, and `null` is the literal spelling of "opaque parent" (§1 of the agreed contract). The
   child validates this against `^(null|[a-z][a-z0-9+.-]*://[^/?#\s]+)$`; anything else is no
   hint, which is the old same-origin behaviour — never `'*'` by accident.
   The hint travels on EVERY frame URL, appended where the marker is appended. */
var PARENT_HINT=/^[a-z][a-z0-9+.-]*:\/\/[^\/?#\s]+$/i.test(location.origin)?location.origin:"null";

function setStatus(heading,detail,verb){
 statusHeading.textContent=heading;
 statusDetail.textContent=detail;
 status.hidden=false;
 frame.hidden=true;
 content.setAttribute("aria-busy","true");
 if(!verb){retry.hidden=true;retry.textContent=RETRY_LABEL;retry.onclick=null;return;}
 retry.hidden=false;retry.textContent=verb.label;
 retry.onclick=verb.onClick;
}
function clearStatus(){
 status.hidden=true;
 content.removeAttribute("aria-busy");
}
function say(text){live.textContent="";freeze(()=>{live.textContent=text});}
function freeze(fn){setTimeout(fn,30)}

function currentMark(routeKey){
 var links=destinations();
 for(var i=0;i<links.length;i++){
  if(links[i].getAttribute("data-destination")===routeKey)links[i].setAttribute("aria-current","page");
  else links[i].removeAttribute("aria-current");
 }
 /* The Menu button is never a page: it never takes aria-current, and when a dropdown route is
    the current destination its accessible name says which one (her NOTES, "Current
    destination / dropdown"). */
 var menuKey=MENU_KEYS.indexOf(routeKey)!==-1;
 var label=menuKey?"Menu — "+byKey(routeKey)[1]:"Menu";
 menuButton.setAttribute("aria-label",label);
 menuButton.setAttribute("title",label);
}

/* ── scroll memory: per destination, per account/instance, session only ───────────────── */
var scoped=false;
function scope(){
 var pill=document.querySelector('.topbar-account,.sf-account [data-account-name]');
 var who=(pill&&(pill.getAttribute("data-account-name")||""))||"account";
 return "shell-scroll:"+INSTANCE_KEY+"|"+who+"|";
}
function saveScroll(){
 if(!nav.route)return;
 try{
  var value=0;
  if(frame.contentWindow&&frame.contentWindow.scrollY!==undefined)value=frame.contentWindow.scrollY;
  sessionStorage.setItem(scope()+nav.route,String(value||0));
 }catch(error){/* a frame that cannot be read keeps no scroll: never a broken navigation */}
}
function restoreScroll(){
 if(!nav.route)return;
 var wanted=0;
 try{wanted=parseFloat(sessionStorage.getItem(scope()+nav.route)||"0")||0;}catch(error){wanted=0;}
 if(!wanted)return;
 try{
  var win=frame.contentWindow;
  var doc=win.document;
  var max=Math.max(0,(doc.documentElement?doc.documentElement.scrollHeight:0)-win.innerHeight);
  win.scrollTo(0,Math.min(wanted,max));
 }catch(error){/* same-origin by contract; a frame that refuses keeps the top */}
}

/* ── one navigation ──────────────────────────────────────────────────────────────────── */
function navigate(routeKey,options){
 options=options||{};
 var destination=byKey(routeKey);
 if(!destination){/* not in the registry: nothing to frame, and the bar is the escape */
  setStatus(COPY.network[0],COPY.network[1],{label:RETRY_LABEL,onClick:function(){navigate(routeKey,options)}});
  return;
 }
 if(nav.route&&frame.contentWindow)saveScroll();
 nav.id=nav.id+1;
 nav.token=randomToken();
 nav.route=routeKey;
 nav.started=Date.now();
 nav.source=options.source||"chrome";
 nav.pending=routeKey;
 clearTimeout(nav.timer);
 clearTimeout(nav.reveal);
 /* The OLD document must not masquerade as the new destination: hide it immediately, and show
    the same neutral pane every time. The bar does not change while loading. */
 setStatus(COPY.opening_heading.replace("{destination}",destination[1]),COPY.opening_detail,null);
 currentMark(null);
 document.title="";
 /* THE THREE AGENT DESTINATIONS ARE ONE DOCUMENT with three faces. Once it is mounted, choosing
    another of them posts `dsh:open` and costs no load at all — which is what keeps a tour of the
    ten destinations at ZERO top-level loads and, for these three, no second frame load either. */
 if(harnessMounted&&DSH_SURFACES[routeKey]){
  setStatus("", "", null);
  clearStatus();
  frame.hidden=false;
  currentMark(routeKey);
  document.title=destination[1];
  dshOpen(DSH_SURFACES[routeKey],routeKey);
  say(destination[1]+" opened.");
  nav.pending=null;
  clearTimeout(nav.timer);
  return;
 }
 var glue=destination[2].indexOf("?")===-1?"?":"&";
 frame.hidden=true;
 frame.src=SERVER_ORIGIN+destination[2]+glue+"shell=1&nav="+encodeURIComponent(nav.id)
  +"&tok="+encodeURIComponent(nav.token)+"&route="+encodeURIComponent(routeKey)
  +"&parent="+encodeURIComponent(PARENT_HINT);
 nav.timer=setTimeout(function(){timeout()},TIMEOUT_MS);
 nav.reveal=setTimeout(function(){arrived()},REVEAL_MS);
 if(options.focusTarget)options.focusTarget.focus();
}

/* THE DOCUMENT'S ARRIVAL IS NOT THE APP'S READINESS, but it IS the end of the wait this pane
   is for. Owen, 2026-11-09: the pane sat over a page that had already loaded — "Opening Agents…
   / Waiting for the page." — for as long as the child's `shell:ready` took to arrive, or for
   ever if it never did. A loaded document is a page a person can look at, so the pane must not
   cover it: `ready` still owns the title, the aria-current mark and the focus move, and the
   token is still revoked on a real timeout, so nothing here can be mistaken for that verdict. */
function arrived(){
 if(!nav.pending)return;
 /* THE LOAD IS THE END OF THE WAIT. Stop the verdict timer here too: a shell page whose
    `shell:ready` is late or absent must not be covered again by the timeout pane after it has
    already painted (measured 2026-11-09: Security loaded in 183 ms and the pane stayed for
    ever because only the child message could clear it). A late `ready` still owns the title,
    the mark and the focus move. */
 clearTimeout(nav.timer);
 clearTimeout(nav.reveal);
 nav.pending=null;
 frame.hidden=false;
 clearStatus();
}

function randomToken(){
 var bytes=new Uint8Array(24);
 (window.crypto||window.msCrypto).getRandomValues(bytes);
 var out="";
 for(var i=0;i<bytes.length;i++)out+=bytes[i].toString(36).padStart(2,"0");
 return out;
}

function timeout(){
 if(!nav.pending)return;
 /* The timeout REVOKES the token: a late ready cannot replace this pane (her NOTES). */
 clearTimeout(nav.reveal);
 nav.token="";
 nav.pending=null;
 setStatus(COPY.timeout[0],COPY.timeout[1],{label:RETRY_LABEL,onClick:retryPending});
 statusHeading.focus();
 say(COPY.timeout[0]+".");
}
var lastRoute=null;
function retryPending(){
 var route=lastRoute||nav.route||DEFAULT_DESTINATION;
 navigate(route,{source:"retry"});
}
function failed(statusCode){
 clearTimeout(nav.reveal);
 nav.pending=null;
 nav.token="";
 lastRoute=nav.route;
 var key=statusCode===403?"403":statusCode===404?"404":statusCode===401?"signin":
  statusCode===502?"502":"network";
 var copy=COPY[key];
 var verb=key==="signin"?{label:SIGNIN_LABEL,onClick:openAccount}:
  (key==="502"||key==="network")?{label:RETRY_LABEL,onClick:retryPending}:null;
 setStatus(copy[0],copy[1],verb);
 currentMark(null);
 statusHeading.focus();
 say(copy[0]+".");
}
function ready(message){
 var routeKey=String(message.routeKey||"");
 // THE ACCOUNT ROWS' SURFACES ARE NOT DESTINATIONS IN THE BAR, but they are registry-routed
 // pages the frame can be showing, so their route keys are known here too.
 var rowSurface=null;
 for(var rowKey in ROW_SURFACES){if(ROW_SURFACES[rowKey].route===routeKey)rowSurface=ROW_SURFACES[rowKey];}
 if(!byKey(routeKey)&&!rowSurface){failed(404);return;}
 // the harness has certified itself: its other faces now cost a message, never a load
 if(DSH_SURFACES[routeKey])harnessMounted=true;
 nav.pending=null;
 clearTimeout(nav.timer);
 clearTimeout(nav.reveal);
 nav.route=routeKey;
 var title=String(message.title||"").trim();
 document.title=title?title+" — e-server":"e-server";
 currentMark(routeKey);
 clearStatus();
 frame.hidden=false;
 /* Ready never steals focus from a bar control; content-initiated navigation moves focus INTO
    the new page (her NOTES, "Focus / scroll"). */
 if(nav.source==="content"){
  try{
   var heading=frame.contentWindow.document.querySelector("h1");
   if(heading){heading.setAttribute("tabindex","-1");heading.focus();}
  }catch(error){/* a heading we cannot reach is not a navigation failure */}
 }
 restoreScroll();
 say(byKey(routeKey)[1]+" opened.");
 nav.source="chrome";
}

/* The frame's OWN load event ends the wait: see `arrived()`. Registered once, here, beside
   the message listener so both halves of "did it work" live in one place. */
frame.addEventListener("load",function(){arrived();});

/* ── the child's verdicts: origin, source, token and CURRENT id, or nothing ───────────── */
window.addEventListener("message",function(event){
 if(event.origin!==SERVER_ORIGIN)return;
 if(!frame.contentWindow||event.source!==frame.contentWindow)return;
 var data=event.data;
 if(!data||typeof data!=="object")return;
 if(String(data.token||"")!==nav.token||String(data.navigationId||"")!==String(nav.id))return;
 if(data.type==="dsh:ready"||data.type==="dsh:route"||String(data.type||"").indexOf("dsh:")===0){dshAcknowledged();return;}
 if(data.type==="shell:ready")ready(data);
 else if(data.type==="shell:error")failed(parseInt(data.status,10)||0);
 else if(data.type==="shell:navigate"){
  var target=String(data.destination||"");
  if(byKey(target))navigate(target,{source:"content"});
 }else if(data.type==="shell:open"){
  if(data.control==="account")openAccount();
  else if(data.control==="menu")openMenu(true);
 }
});

/* ── the disclosure menu: her keyboard contract, and no tooltip-free guesswork ─────────── */
function setMenu(open){
 menu.hidden=!open;
 menuButton.setAttribute("aria-expanded",open?"true":"false");
}
function openMenu(focusButton){
 setMenu(true);
 if(focusButton)menuButton.focus();
}
function closeMenu(refocus){
 setMenu(false);
 if(refocus)menuButton.focus();
}
menuButton.addEventListener("click",function(){
 if(menu.hidden)openMenu(false);
 else closeMenu(false);
});
menuButton.addEventListener("keydown",function(event){
 if(event.key==="Escape"&&!menu.hidden){event.preventDefault();closeMenu(true);}
});
menu.addEventListener("keydown",function(event){
 if(event.key==="Escape"){event.preventDefault();closeMenu(true);}
});
document.addEventListener("pointerdown",function(event){
 if(menu.hidden)return;
 if(menu.contains(event.target)||menuButton.contains(event.target))return;
 closeMenu(false);
},true);
document.addEventListener("focusin",function(event){
 if(menu.hidden)return;
 if(menu.contains(event.target)||menuButton.contains(event.target))return;
 closeMenu(false);
});

/* ── chrome-initiated navigation ──────────────────────────────────────────────────────── */
function linkRoute(node){
 var key=node.getAttribute("data-destination");
 if(!key)return null;
 return byKey(key);
}
document.addEventListener("click",function(event){
 var link=event.target.closest?event.target.closest("a[data-destination]"):null;
 if(!link)return;
 /* Deliberate browser behaviour is preserved: a modified click is the person's, not ours. */
 if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||
    event.altKey)return;
 var destination=linkRoute(link);
 if(!destination)return;
 event.preventDefault();
 var insideMenu=menu.contains(link);
 var returnFocus=insideMenu?menuButton:link;
 if(insideMenu)closeMenu(false);
 navigate(destination[0],{source:"chrome",focusTarget:returnFocus});
});

/* Skip to content moves focus to the child's heading, never to the frame element. */
var skip=document.querySelector('[data-action="focus-content"]');
if(skip)skip.addEventListener("click",function(event){
 event.preventDefault();
 if(!frame.hidden){
  try{
   var heading=frame.contentWindow.document.querySelector("h1");
   if(heading){heading.setAttribute("tabindex","-1");heading.focus();return;}
  }catch(error){/* fall through to the status heading */}
 }
 statusHeading.focus();
});

/* ── the account menu: the four rows, in the site's own menu rules ─────────────────────── */
/* Owen's menu (2026-10-22): display name, then My Profile / Linked Accounts / Settings /
   Sign out. The markup and every style here are the site's own
   (`desktop/vendor/launcher/theme/account-control.css`, vendored; the module itself is vendored
   beside it as `desktop/vendor/launcher/account-control.mjs`), so the panel is the approved one.
   What each row DOES belongs to the e-app: it calls a hook the window's preload provides
   (`window.eServerChrome.<action>`); a row whose hook is absent says so in the live region rather
   than dying silently — a visible refusal, never a dead click. */
var accountMenu=null;
function accountName(account){
 var slot=document.querySelector(".sf-bar .sf-account");
 if(!slot)return;
 var person=account&&typeof account==="object"?account:null;
 var value=String(person?(person.name||person.username||""):(account||"")).trim();
 // NO PERSON, NO PILL. The bar is painted before the app answers; an empty control with the
 // app's icon read as a pretend signed-in user. It appears only with a real account.
 slot.hidden=!value;
 if(!value){
  var empty=slot.querySelector(".web-account-name");if(empty)empty.textContent="";
  slot.removeAttribute("data-account-name");
  slot.setAttribute("aria-label","Account");
  slot.setAttribute("title","Account");
  return;
 }
 slot.setAttribute("data-account-name",value);
 var name=slot.querySelector(".web-account-name");
 if(name)name.textContent=value;
 var face=slot.querySelector(".web-account-face");
 var initial=slot.querySelector(".web-account-initial");
 var picture=slot.querySelector(".web-account-picture");
 if(initial)initial.textContent=value.slice(0,1);
 if(picture){
  var portrait=person&&typeof person.picture==="string"&&person.picture.startsWith("data:image/png;base64,")?person.picture:null;
  if(portrait&&face){
   picture.src=portrait;picture.hidden=false;face.classList.add("has-picture");
  }else{
   picture.removeAttribute("src");picture.hidden=true;
   if(face)face.classList.remove("has-picture");
  }
 }
 slot.setAttribute("aria-label",value);
 slot.setAttribute("title",value);
}
window.addEventListener("e-app:account",function(event){accountName(event.detail||null);});
if(window.__eappAccount)accountName(window.__eappAccount);
function accountRow(label,action){
 var row=document.createElement("button");
 row.type="button";row.textContent=label;row.setAttribute("data-account-action",action);
 row.onclick=function(){
  closeAccountMenu();
  // SIGN OUT IS THE APP'S OWN ACTION, not a missing hook: the chrome is the connected document,
  // and the preload that owns it exposes the app's sign-out there (desktop/preload.cjs).
  if(action==="signOut"){
   if(window.eServerSetup&&typeof window.eServerSetup.signOut==="function"){
    try{return window.eServerSetup.signOut();}catch(error){}
   }
   say("Sign out is unavailable right now.");
   return;
  }
  var surface=ROW_SURFACES[action];
  if(surface&&typeof openSurface==="function"){openSurface(surface);return;}
  var hook=window.eServerChrome&&window.eServerChrome[action];
  if(typeof hook==="function"){try{hook()}catch(error){say(label+" is unavailable right now.")}return;}
  say(label+" is not available in this window yet.");
 };
 return row;
}
function buildAccountMenu(){
 var menu=document.createElement("div");
 menu.className="desktop-profile-menu";menu.id="chrome-account-menu";menu.hidden=true;
 var slot=document.querySelector(".sf-bar .sf-account");
 var who=slot?slot.getAttribute("data-account-name")||"":"";
 var identity=document.createElement("div");identity.className="web-account-identity";
 var name=document.createElement("span");name.className="web-account-identity-name";
 name.textContent=who||"Easter Company account";
 identity.appendChild(name);
 var rule=document.createElement("hr");rule.className="web-account-menu-rule";
 menu.appendChild(identity);menu.appendChild(rule);
 menu.appendChild(accountRow("My Profile","profile"));
 menu.appendChild(accountRow("Linked Accounts","accounts"));
 menu.appendChild(accountRow("Settings","settings"));
 menu.appendChild(accountRow("Sign out","signOut"));
 document.body.appendChild(menu);
 return menu;
}
function closeAccountMenu(){if(accountMenu)accountMenu.hidden=true;}
function openAccount(){
 if(!accountMenu)accountMenu=buildAccountMenu();
 if(!accountMenu.hidden){closeAccountMenu();return;}
 var slot=document.querySelector(".sf-bar .sf-account");
 if(!slot)return;
 var box=slot.getBoundingClientRect();
 accountMenu.hidden=false;
 accountMenu.style.left=Math.round(box.left)+"px";
 accountMenu.style.top=Math.round(box.bottom+4)+"px";
}

var accountSlot=document.querySelector(".sf-bar .sf-account");
if(accountSlot)accountSlot.addEventListener("click",function(event){event.preventDefault();openAccount();});
document.addEventListener("pointerdown",function(event){
 if(!accountMenu||accountMenu.hidden)return;
 if(accountMenu.contains(event.target))return;
 if(accountSlot&&accountSlot.contains(event.target))return;
 closeAccountMenu();
});
document.addEventListener("keydown",function(event){
 if(event.key==="Escape"&&accountMenu&&!accountMenu.hidden){closeAccountMenu();if(accountSlot)accountSlot.focus();}
});

/* ── the pill's NAME, which the clipping above hides from the accessibility tree ───────── */
/* Her NOTES: "Account is a 52x32px compact pill (identity/avatar only; full account name in
   accessible name and tooltip)". The space her design spends on the text is spent on the face
   here, so the name the module's own pill would carry as text is written where a screen reader
   and a tooltip read it. The vendored module swaps the server's seed for its own pill in the
   same task, so this runs again whenever the slot's children change. */
function nameAccountPill(){
 var slot=document.querySelector(".sf-bar .sf-account");
 if(!slot)return;
 var who=slot.getAttribute("data-account-name")||"";
 if(!who){
  var holder=slot.closest("[data-account-name]")||document.querySelector(".sf-bar [data-account-name]");
  who=(holder&&holder.getAttribute("data-account-name"))||"";
 }
 if(!who)return;
 var pills=slot.querySelectorAll(".web-account-nav");
 for(var i=0;i<pills.length;i++){
  if(pills[i].getAttribute("aria-label")!==who){
   pills[i].setAttribute("aria-label",who);
   pills[i].setAttribute("title",who);
  }
 }
}
(function watchAccount(){
 nameAccountPill();
 var slot=document.querySelector(".sf-bar .sf-account");
 if(!slot||typeof MutationObserver!=="function")return;
 // childList only: writing the name above is an ATTRIBUTE change, so this cannot feed itself.
 new MutationObserver(nameAccountPill).observe(slot,{childList:true,subtree:true});
})();

/* ── the marks' accessible names follow the state the shipped poll paints ────────────── */
/* HER WORDS AND NOT ONE MORE: the quiet sentence is her own ("{destination} — status
   unavailable"), and a mark whose state IS known is named by its destination alone. Nothing is
   announced (no aria-live here): the name is read when a person reaches the control. */
var MARKS=[["agent-pill","Agents"],["swarm-pill","Swarm"]];
function paintMarkName(node,label){
 var state=node.getAttribute("data-state")||"unknown";
 var known=state==="running"||state==="idle"||state==="queued";
 var text=known?label:label+" — status unavailable";
 if(node.getAttribute("aria-label")!==text){
  node.setAttribute("aria-label",text);
  node.setAttribute("title",text);
 }
}
(function watchMarks(){
 for(var i=0;i<MARKS.length;i++){
  var node=document.querySelector(".sf-bar ."+MARKS[i][0]);
  if(!node)continue;
  paintMarkName(node,MARKS[i][1]);
  new MutationObserver(function(){paintMarkName(node,MARKS[(function(){
   for(var j=0;j<MARKS.length;j++)if(document.querySelector(".sf-bar ."+MARKS[j][0])===node)return j;
   return 0;})()][1]);}).observe(node,{attributes:true,attributeFilter:["data-state"]});
 }
})();

/* ── the orb: the shipped status read, painted into her quiet fallback ────────────────── */
var orb=document.querySelector(".sf-orb");
function paintOrb(state,text){
 if(!orb)return;
 orb.setAttribute("data-orb-state",state);
 orb.setAttribute("aria-label",text);
 orb.setAttribute("title",text);
}
(function quietOrb(){paintOrb("quiet","Instance status unavailable")})();

/* ── THE HARNESS INTENT, chrome → frame, and it is STRICT (§4 of the frozen contract) ──────
   The three agent destinations are one document with three faces; switching between them posts
   `dsh:open` into the frame rather than reloading it, and the targetOrigin is the INSTANCE — the
   one value this document knows exactly — never `'*'`. The page acknowledges with `dsh:ready`
   carrying our token; a page that never acknowledges simply keeps its current face, which is the
   honest outcome rather than a reload loop. */
var DSH_SURFACES={agents:"inbox",swarm:"epsilons",processes:"processes"};
var harnessMounted=false,dshWait=null,dshToken="";
/** The harness page forwards this into its app frame; the app acknowledges EVERY accepted message
 *  (e-server 626d269fcc). If nothing comes back inside the bound, the honest floor is ONE load. */
var DSH_ACK_MS=1500;
function dshOpen(surface,fallbackKey){
 if(!frame.contentWindow){if(fallbackKey){harnessMounted=false;navigate(fallbackKey,{source:"chrome"})}return;}
 dshToken=(Date.now().toString(36)+Math.random().toString(36).slice(2));
 var intent={type:"dsh:open",surface:surface,conversation:null,token:dshToken};
 clearTimeout(dshWait);
 // NO ACKNOWLEDGEMENT INSIDE THE BOUND → ONE REAL LOAD. The intent is a message, not a promise:
 // a page that does not answer leaves the person on the face they were shown, so the fallback is
 // the same single load this controller would have done without the protocol.
 dshWait=setTimeout(function(){dshWait=null;// only if the person is still waiting on THIS one
  if(fallbackKey&&nav.pending===fallbackKey){harnessMounted=false;navigate(fallbackKey,{source:"chrome"})}},DSH_ACK_MS);
 try{frame.contentWindow.postMessage(intent,SERVER_ORIGIN)}catch(error){/* a frame mid-load */}
}
/** Any accepted `dsh:` message from the harness means the intent arrived: cancel the fallback. */
function dshAcknowledged(){
 if(!dshWait)return;
 clearTimeout(dshWait);dshWait=null;harnessMounted=true;
}

/* ── THE ACCOUNT ROWS' SURFACES, and every one of them already exists ────────────────────
   The pill's menu is hers; what a row opens is the app's. These are the INSTANCE's own account
   and settings documents — the same `site/account/index.html` the client's sign-in screen mounts,
   served by the instance — loaded in the frame this chrome owns, with the same marker, the same
   token and the same validation as any destination. Nothing new is drawn, and the top document
   never navigates: a row is a frame navigation like every other. */
var ROW_SURFACES={
 profile:{href:"/account",label:"My Profile",route:"account"},
 accounts:{href:"/account",label:"Linked Accounts",route:"account-linked"},
 settings:{href:"/system",label:"Settings",route:"settings"}
};
window.addEventListener("message",function(event){
 var data=event.data;
 if(!data||typeof data!=="object"||data.type!=="e-app:chrome-row")return;
 var surface=ROW_SURFACES[String(data.surface||"")];
 if(!surface)return;
 openSurface(surface);
});
function openSurface(surface){
 nav.id+=1;nav.token=(Date.now().toString(36)+Math.random().toString(36).slice(2));
 nav.route=surface.route;nav.started=Date.now();nav.source="chrome";nav.pending=surface.route;
 clearTimeout(nav.timer);
 clearTimeout(nav.reveal);
 setStatus(COPY.opening_heading.replace("{destination}",surface.label),COPY.opening_detail,null);
 currentMark(null);
 document.title="";
 var glue=surface.href.indexOf("?")===-1?"?":"&";
 frame.hidden=true;
 frame.src=SERVER_ORIGIN+surface.href+glue+"shell=1&nav="+encodeURIComponent(nav.id)
  +"&tok="+encodeURIComponent(nav.token)+"&route="+encodeURIComponent(surface.route)
  +"&parent="+encodeURIComponent(PARENT_HINT);
 nav.timer=setTimeout(function(){timeout()},TIMEOUT_MS);
 nav.reveal=setTimeout(function(){arrived()},REVEAL_MS);
}

/* ── first paint: her wait pane, already in the served markup, then the destination the URL
   asked for (or her default, when it asked for none) ────────────────────────────────────── */
/* THE BAR PAINTS BEFORE THE INSTANCE IS ASKED FOR. The first frame starts on the DOCUMENT'S
   OWN load event, not before it. A destination such as /system carries live media, and an
   iframe started before the parent's load event holds the parent open with it: measured
   2026-11-09, the chrome document never reached "complete" while that stream was pending, so
   the window's own load was tied to a media stream and automation could not resolve its
   frames. The wait pane is already in the markup; the frame is asked for a tick later, and
   from then on the page's load state is the instance page's own. */
function firstDestination(){
 navigate(FIRST_DESTINATION,{source:"chrome"});
}
if(document.readyState==="complete"){setTimeout(firstDestination,0);}
else{window.addEventListener("load",firstDestination,{once:true});}
})();
