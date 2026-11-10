// THE CLIENT'S SIGN-IN SCREEN IS THE HOUSEHOLD'S ACCOUNT PAGE, NOT A LOOK-ALIKE.
//
// desktop/shell.html carries site/account/index.html's markup (body.account, main.account-main,
// #account-panel with its overline, heading, wait line, one alert region and #account-root) and
// desktop/vendor/launcher/account/account.css is the site's own sheet, copied byte for byte. So
// the panel, the Microsoft row, the provider rows, the direct form, the busy state and the footer
// are painted by the page's rules and this file adds no paint at all (see desktop/shell.css).
//
// This module is the adapter, and its differences from site/account/account.mjs are the client's
// own and live only here: the account seam is window.eServerSetup inside Electron rather than
// webAccount in a browser (desktop/preload.cjs), the page's Microsoft button starts the browser
// flow from the main process, a success navigates nowhere because the window stays and becomes the
// app, and the client owns steps the page has never had - the username/password finish, the server
// address, and the update phases with their installer.
//
// ONE COLLISION, and it is here and not in the copy: the page shows nothing interactive while a
// sign-in is in flight, and a LAN client must keep "Cancel sign-in" reachable, so that one row
// lives outside .account-body and stays on screen under the busy sentence (desktop/shell.css).
//
// THE TWO VIEWS THIS CLIENT ADDED (2026-11-03, Owen): after sign-in the person lands on the list
// of e-servers their Easter Company account holds - `view: 'servers'` - and the second view,
// `view: 'add'`, is where a new address is entered. Both are client steps, drawn by
// desktop/connections.css, and neither holds a secret: an address goes to the main process,
// which normalizes it, proves an e-server answers there and stores the row on the account. The
// PIN is never asked here - the server asks, after a row is chosen.
import {SIGN_IN_TITLE,SIGN_IN_WAIT,createSignInOptions} from './vendor/launcher/signin-options.mjs';
const $=id=>document.getElementById(id),bridge=window.eServerSetup;
let providersLoaded=false,shownError=null;
// An IPC rejection arrives wrapped - "Error invoking remote method 'company:login': Error: ..." -
// and that wrapper is Electron's plumbing, not a sentence for a player. The main process already
// names what happened ("Sign-in cancelled."), so the wrapper is unwrapped and nothing else is
// rewritten: the client shows the meaning it was given, never the transport.
// Electron's wrapper has two shapes and both are plumbing, not sentences: "Error invoking remote
// method 'x': Error: ..." and, when the rejection is itself an Error, a leading "Error: " in front
// of that. Strip a leading "Error: " first, then the wrapper, so the person reads the meaning the
// main process gave them and never "Error invoking remote method".
const sentence=value=>String(value??'').replace(/^Error:\s*/,'').replace(/^Error invoking remote method '[^']+':\s*(?:Error|TypeError|RangeError|SyntaxError|URIError|ReferenceError|EvalError)?:?\s*/,'');
// One alert region, the page's (#account-error, above the options): one <p> per line, blank lines
// dropped, exactly as site/account/account.mjs draws it.
function problem(value){
 const shown=(Array.isArray(value)?value:[value&&value.message!==undefined?value.message:String(value??'')]).map(line=>typeof line==='string'?sentence(line):line).filter(line=>typeof line==='string'&&line.trim());
 $('account-error').replaceChildren(...shown.map(line=>{const text=document.createElement('p');text.textContent=line;return text;}));
 $('account-error').hidden=!shown.length;
}
async function action(work){try{await work();}catch(error){problem(error);}finally{options.clearPassword();}}
// The options panel is the site's module, vendored untouched: the same rows, the same order, the
// same words. The client supplies only what a press means on this surface.
const options=createSignInOptions({onSubmit:(id,password)=>{options.clearPassword();return action(()=>bridge.login(id,password));},onMicrosoft:()=>action(()=>bridge.provider('microsoft')),onProvider:provider=>action(()=>bridge.provider(provider)),onProblem:lines=>problem(lines)});
$('account-root').append(options.node);
let current={};
// ── THE BAR'S ACCOUNT PILL ─────────────────────────────────────────────────────────────────────
// Diana's pre-connection bar (shell-frame.html's second fragment) puts the account control at
// x=12 y=12 as a 52x32 pill: identity only, with the account's full name as the accessible name
// and the tooltip. The markup is HERS (desktop/shell.html copies the fragment, including her
// {{ACCOUNT_PILL_INNER}} slot); this fills it from the account the main process already publishes
// and gives it the one action an account control has before an instance is connected. It is not a
// new menu: the bar's real controls arrive with the connected shell (ticket f1bdcd46), and this
// screen has no instance whose state they could read.
//
// THE FACE IS THE LAUNCHER'S, copied as markup into her slot rather than nested as a control:
// `.web-account-face` holding `.web-account-initial` and `.web-account-picture` — the account's
// uploaded picture when the account document carries one (a data:image/png URI, which the vendored
// account client is the only thing allowed to hand this window), else the first letter of the name
// on the teal tile. Never a remote URL: the document's CSP allows `self` and `data:` and nothing
// else, and a portrait that cannot be painted must not become a request.
function drawAccountPill(account){
 const pill=$('account-pill');if(!pill)return;
 const name=account&&typeof account.name==='string'?account.name.trim():'';
 const signedIn=!!account;
 // THE BAR'S MOOD IS THE ACCOUNT'S. Owen, 2026-11-09: the bar is glassy while nobody is
 // signed in. The document carries that one fact as an attribute (the paint is
 // desktop/shell-bar-adapter.css), so a sign-in or a sign-out repaints the row in the frame
 // that learns it and no second state lives in this file.
 document.body.dataset.accountState=signedIn?'signed-in':'signed-out';
 // THE PILL IS PRESENT IN BOTH MOODS, AND IT MEANS DIFFERENT THINGS. Signed in it is the
 // account's face and name. Signed out it is the app's own mark on the glass, with the one
 // accessible name "Account": pressing it puts the cursor on the sign-in options (showAccount),
 // which is what the site's own account control does. It never prints a name it does not have.
 pill.hidden=false;
 pill.classList.toggle('web-account-face-mark',!signedIn);
 document.body.dataset.accountState=signedIn?'signed-in':'signed-out';
 if(!signedIn){
  pill.dataset.state='signed-out';
  pill.setAttribute('aria-label','Account');pill.title='Account';
  const face=pill.querySelector('.web-account-face');
  if(face)face.classList.add('web-account-face-mark');
  const initial=pill.querySelector('.web-account-initial');
  if(initial)initial.textContent='';
  const picture=pill.querySelector('.web-account-picture');
  if(picture){picture.removeAttribute('src');picture.hidden=true;}
  return;
 }
 // Identity, not a label: the full name (with no second line, no badge and no count) in both the
 // accessible name and the tooltip, exactly as Diana's NOTES require for the compact pill.
 const label=signedIn?name||'Account':'Account';
 pill.setAttribute('aria-label',label);pill.title=label;
 pill.dataset.state=signedIn?'signed-in':'signed-out';
 const face=pill.querySelector('.web-account-face');
 const initial=pill.querySelector('.web-account-initial');
 const picture=pill.querySelector('.web-account-picture');
 if(!face||!initial||!picture)return;
 initial.textContent=signedIn?(name||(account.username||'')).slice(0,1):'';
 const portrait=signedIn&&typeof account.picture==='string'&&account.picture.startsWith('data:image/png;base64,')?account.picture:null;
 if(portrait){if(picture.getAttribute('src')!==portrait)picture.src=portrait;picture.hidden=false;face.classList.add('has-picture');}
 else{picture.removeAttribute('src');picture.hidden=true;face.classList.remove('has-picture');}
 // Signed out there is no face to draw: the tile carries the mark instead (the launcher's own
 // last resort, in desktop/shell-bar-adapter.css).
 face.classList.toggle('web-account-face-mark',!signedIn);
}
/** What pressing the pill does before an instance is connected: it takes the person to the
 *  account the window actually shows — the name and Sign out row when signed in, the sign-in
 *  options when not — and never opens a second account menu of its own. */
function showAccount(){
 const row=$('account-status');
 if(row&&!row.hidden){
  row.tabIndex=-1;row.focus({preventScroll:false});
  if(row.scrollIntoView)row.scrollIntoView({block:'nearest'});
  return;
 }
 const first=$('account-root').querySelector('button:not([hidden]),input:not([hidden])');
 if(first)first.focus();
}
$('account-pill').addEventListener('click',showAccount);
function render(state){
 current=state;
 // THE ACCOUNT'S THEME, in the same publish that carries the account card and the e-server list.
 // desktop/theme-shell.js owns the rule (light/dark absolute, `system` resolved through the OS on
 // every ask, plus the live OS listener) and the two attributes every surface publishes; this line
 // is only the wiring, so a sign-in, a re-read or a save in e-server's settings panel repaints this
 // window in the frame that learns it instead of leaving the OS answer standing.
 if(state.theme)window.easterShellTheme?.paint(state.theme);
 // The bar's pill is drawn from the same publish that carries the card and the list, so a
 // sign-in or a sign-out moves the face in the frame that learns it.
 drawAccountPill(state.account);
 const ready=state.accountReady===true,finish=!!state.account&&!ready,busy=state.accountBusy===true;
 const updating=['checking','downloading','verifying'].includes(state.phase);
 $('version').textContent=state.version;
 // The page's heading is the dialog's heading, written in one file (site/signin-options.mjs), so a
 // plain sign-in reads exactly what the site reads. Every other phase is the client's own.
 $('title').textContent=ready?state.title||'Your e-servers.':finish?'Make it yours.':SIGN_IN_TITLE;
 // One sentence, one author: the main process publishes the step's own words and the view shows
 // them once. `#message` belongs to the client's other steps (finish, update); the e-server views
 // carry their sentence in the view itself, so a plain sign-in and a list do not say two things.
 $('message').textContent=finish?'Choose your username and password to finish your global account.':'';
 // The page's busy state: the panel drops its overline, heading and body by itself (account.css)
 // and shows one sentence, the dialog's own wait line - the client adds no words to it.
 $('account-panel').dataset.busy=String(busy);
 // The wait line is never hidden, exactly as the page's own markup is not: at rest it is an empty
 // paragraph that still carries the sheet's 14px bottom margin, and a hidden one would make this
 // card 14px shorter than the site's for no reason a person could name. The second child is the
 // page's own spinning mark - `.wait-feedback-mark`, painted by the vendored
 // site/account-control.css - created for the length of the flow and removed after it, which is
 // what site/account/account.mjs's busyMark()/end() do on the site.
 $('account-busy-line').textContent=busy?SIGN_IN_WAIT:'';
 const mark=$('account-wait').querySelector('.wait-feedback-mark');
 if(busy&&!mark){const ring=document.createElement('span');ring.className='wait-feedback-mark';ring.setAttribute('aria-hidden','true');$('account-wait').prepend(ring);}
 else if(!busy&&mark)mark.remove();
 // The shared options are the sign-in face of this window; a client step or an update replaces them.
 $('account-root').hidden=ready||finish||updating;
 // The two client steps keep their own hidden flag - the wrapper exists only to give the page's
 // .company-signin form rules something to match, exactly as the site's panel nests them.
 $('account-finish').hidden=!finish||updating;
 drawServers(state,ready&&state.phase==='setup'&&!updating);
 $('account-status').hidden=!state.account||updating;
 $('account-name').textContent=state.account?.name||'';
 $('retry').hidden=!(ready&&['offline','update-error'].includes(state.phase));$('installer').hidden=state.phase!=='update-error';
 $('cancel-signin').hidden=!busy;
 // A plain sign-in is the page, entire: every client row is absent from it.
 $('client-steps').hidden=!(ready||finish||updating);
 $('note').hidden=!(ready||finish||updating)||busy;
 options.lock(busy);
 for(const item of $('account-finish').elements)item.disabled=busy;
 if(finish&&state.account.username){$('username').value=state.account.username;$('username').readOnly=true;}else $('username').readOnly=false;
 $('progress').hidden=!updating;
 if(Number.isFinite(state.percent))$('progress').value=state.percent;else $('progress').removeAttribute('value');
 // A refusal arrives in the one alert region, and a refusal the main process withdrew is withdrawn
 // here too: only a change of the state's own sentence redraws, so a locally drawn refusal stands.
 const error=state.accountError||state.error||'';
 if(error!==shownError){shownError=error;problem(error);}
 $('account-notice').textContent=state.accountNotice||'';$('account-notice').hidden=!state.accountNotice;
 if(!ready&&!finish&&!providersLoaded&&!busy){providersLoaded=true;bridge.providers().then(answer=>options.setProviders(answer.providers||[])).catch(()=>{providersLoaded=false;options.providersUnreadable();});}
}
$('username').addEventListener('input',event=>{event.target.value=event.target.value.toLowerCase();});
$('account-finish').onsubmit=event=>{
 event.preventDefault();
 if($('new-password').value!==$('confirm-password').value){problem('Passwords must match.');return;}
 const password=$('new-password').value;$('new-password').value='';$('confirm-password').value='';
 void action(()=>bridge.finish($('username').value,password));
};
// ── the e-server list ─────────────────────────────────────────────────────────────────────
// Every row is a real button, and the remove control says WHICH server it removes: a list of
// places is read by a person and by a screen reader, and "Remove" alone is a control with no
// object. `data-origin` on the row is how focus follows an add back to the row it made.
let drawn=null;
// A LIST THAT NEVER ANSWERS IS A BROKEN SCREEN, NOT A WAIT.
// Measured 2026-11-04, Owen's report: after signing out (or reopening the app) and signing back
// in, the e-server selector is bare 60-70% of the time — no rows, no Add button, no sentence, and
// nothing that ever repairs it — because the list's only state was `loading`: `drawServers` hides
// both the rows and the Add control in that state, and `#servers-error` is shown only for `error`.
// A single publish is all this view is ever promised, so one lost or one stuck read is a
// permanently blank screen. `loading` is therefore BOUNDED here — but THE BOUND IS A LAST RESORT,
// NOT A STOPWATCH ON A SLOW READ. Measured on Owen's own window (1.0.15, 2026-11-04): the list sat
// bare for 10-15 s and then showed "Try again" for ONE FRAME before the rows arrived, because an
// 8 s bound fired a moment before the real answer — worse than either outcome alone. The main
// process bounds the read itself (SERVER_LIST_WATCHDOG_MS, 15 s) and publishes a real error when it
// gives up, so this reader-side bound only has to catch a state that was never published at all:
// it sits ABOVE that watchdog, so a slow but real answer always wins and a lost one still ends in a
// sentence with a way through.
// Set when a wait took the focus off a control it was about to hide, so the settlement can hand it
// to something real: the first Connect row, Add, or Retry — never stolen from anywhere else.
let parkedFocus=false;
const LOADING_PATIENCE_MS=20000;
const LOADING_FAILED='Your e-servers did not load. Try again.';
let loadingAt=0, loadingTimer=null;
function boundedList(raw){
 if(raw.state!=='loading'){loadingAt=0;return raw;}
 if(!loadingAt)loadingAt=Date.now();
 if(Date.now()-loadingAt<LOADING_PATIENCE_MS)return raw;
 return {...raw,state:'error',error:LOADING_FAILED};
}
function watchLoading(){
 if((current.servers||{}).state!=='loading'){
  loadingAt=0;
  if(loadingTimer){clearTimeout(loadingTimer);loadingTimer=null;}
  return;
 }
 if(loadingTimer)return;
 // One redraw per loading window: the bound must be observed even when no further publish comes.
 loadingTimer=setTimeout(()=>{
  loadingTimer=null;
  if((current.servers||{}).state==='loading')drawServers(current,current.accountReady===true&&current.phase==='setup');
 },LOADING_PATIENCE_MS);
}
function hostOf(origin){try{return new URL(origin).host}catch{return String(origin||'')}}
// What changed, said once, politely: the rows are rebuilt on a list change and a screen reader
// has no way to notice that on its own.
function say(sentence){$('servers-status').textContent=sentence||'';}
// ONE MENU, TWO SOURCES, AND THE INSTANCE IS THE ROW. Owen, 2026-11-09: the instance menu is the
// first screen after sign-in, and every instance carries a display name and a domain. The account
// service owns the instances; the account's connections list still owns an address somebody typed.
// A row is keyed by HOSTNAME, so one e-server is one row even when both sources know it, and a
// service that has not shipped the instance plane degrades to today's list rather than a dead end.
function hostnameOf(origin){try{return new URL(origin).hostname.toLowerCase()}catch{return String(origin||'').toLowerCase()}}
function mergeRows(state){
 const rows=new Map();
 for(const row of (state.servers?.rows||[])){
  const key=hostnameOf(row.origin);
  rows.set(key,{connection:row,instance:null,origin:row.origin});
 }
 for(const inst of (state.instances?.rows||[])){
  // A legacy instance may have no domain. It is still its own row (keyed by its id), never
  // merged into another instance that also has none.
  const key=inst.domain?String(inst.domain).toLowerCase():'instance:'+inst.id;
  const entry=rows.get(key)||{connection:null,instance:null,origin:inst.origin};
  entry.instance=inst;entry.origin=inst.origin||entry.origin;rows.set(key,entry);
 }
 // OWNED FIRST, THEN MEMBERSHIPS, THEN ADDRESSES ONLY THIS MACHINE KNOWS. The sort is stable, so
 // within a group the service's own order (created soonest first) survives.
 const rank=entry=>entry.instance?(entry.instance.owned?0:1):2;
 return [...rows.values()].sort((a,b)=>rank(a)-rank(b));
}
function instanceDay(value){
 if(!value)return '';
 const at=new Date(value);if(!Number.isFinite(at.getTime()))return '';
 try{return at.toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'});}catch{return '';}
}
/** The quiet sentence under a row: what the plan is doing, if anything. */
function billingLine(inst){
 if(!inst)return '';
 if(inst.deletion?.scheduledFor)return 'Deletes when the paid period ends on '+instanceDay(inst.deletion.scheduledFor);
 if(inst.billing?.cancelAtPeriodEnd&&inst.billing.currentPeriodEnd)return 'Plan ends on '+instanceDay(inst.billing.currentPeriodEnd);
 if(inst.billing?.status==='pending')return 'Waiting for the plan payment';
 if(inst.billing?.status==='past_due')return 'Plan payment is past due';
 return inst.plan?.name?inst.plan.name:'';
}
function rowNode(entry){
 const inst=entry.instance,conn=entry.connection;
 const label=inst?inst.displayName:(conn?.label||hostOf(entry.origin));
 const where=inst?(inst.domain||'No domain yet'):hostOf(entry.origin);
 const item=document.createElement('li');item.className='server-row';item.dataset.origin=entry.origin;
 if(inst)item.dataset.instance=inst.id;
 const choose=document.createElement('button');choose.type='button';choose.className='server-connect';
 const name=document.createElement('span');name.className='server-name';name.textContent=label;
 choose.append(name);
 // THE DOMAIN IS ALWAYS THE SECOND LINE FOR AN INSTANCE (it is the identifier the requirement
 // names); for an address-only row it appears only when it is not already the name, exactly as
 // before.
 if(inst||name.textContent!==hostOf(entry.origin)){const line=document.createElement('span');line.className='server-origin';line.textContent=where;choose.append(line);}
 if(inst){const role=document.createElement('span');role.className='server-role';role.dataset.role=inst.role;role.textContent=inst.owned?'Owner':'Member';choose.append(role);}
 const billing=billingLine(inst);
 if(billing){const line=document.createElement('span');line.className='server-billing';line.textContent=billing;choose.append(line);}
 // No address, no connection: a legacy instance with neither a domain nor an origin is a row
 // whose owner can still rename and delete it, and whose Connect cannot lie about a place.
 if(entry.origin)choose.onclick=()=>action(()=>bridge.connect(entry.origin));
 else{choose.disabled=true;choose.setAttribute('aria-disabled','true');choose.title='This instance has no domain yet.';}

 const actions=document.createElement('div');actions.className='server-actions';
 if(inst&&inst.owned){
  const rename=document.createElement('button');rename.type='button';rename.className='server-rename';
  rename.textContent='Rename';rename.setAttribute('aria-label','Rename '+label);
  rename.onclick=()=>{startRename(inst);};
  const remove=document.createElement('button');remove.type='button';remove.className='server-delete';
  remove.textContent='Delete';remove.setAttribute('aria-label','Delete '+label);
  remove.onclick=()=>action(async()=>{
   const answer=await bridge.deleteInstance(inst.id);
   if(!answer||!answer.ok)return;
   say(answer.deleted?'Deleted '+label+'.':'Deleting '+label+' when its paid period ends'+(answer.deletion?.scheduledFor?' on '+instanceDay(answer.deletion.scheduledFor):'')+'.');
  });
  actions.append(rename,remove);
 }else if(inst){
  const leave=document.createElement('button');leave.type='button';leave.className='server-leave';
  leave.textContent='Leave';leave.setAttribute('aria-label','Leave '+label);
  leave.onclick=()=>action(async()=>{
   const answer=await bridge.leaveInstance(inst.id);
   if(answer&&answer.ok)say('You left '+label+'.');
  });
  actions.append(leave);
 }
 // A connection row whose instance the account service does not know (or an instance-free list)
 // keeps the only action it has ever had: remove it from this account's address list.
 if(conn&&!inst){
  const remove=document.createElement('button');remove.type='button';remove.className='server-remove';
  remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+label);
  remove.onclick=()=>action(async()=>{await bridge.removeServer(conn.id,conn.label);say('Removed '+label+' from your e-servers.');});
  actions.append(remove);
 }
 if(actions.childElementCount)item.append(choose,actions);else item.append(choose);
 return item;
}
function drawServers(state,shown){
 const servers=boundedList(state.servers||{state:'idle',rows:[]});
 const instances=state.instances||{state:'idle',rows:[],available:true};
 $('client-servers').hidden=!shown;
 if(!shown)return;
 watchLoading();
 const rows=mergeRows({servers,instances});
 // THE VISIBLE STATE is the menu's, not the connections list's: an account whose instances exist
 // but whose address list is empty is a list with rows, not an empty pane.
 const stateName=rows.length?'ready':
  (servers.state==='error'?'error':servers.state==='loading'?'loading':'empty');
 $('client-servers').dataset.state=stateName;
 // The rows are rebuilt only when the list they came from changed, so a keystroke in a form or a
 // publish from the updater cannot move the person's focus out of a row.
 const key=JSON.stringify(rows.map(entry=>[entry.origin,entry.instance?.id||'',entry.instance?.displayName||'',
  entry.instance?.role||'',entry.instance?.billing?.status||'',entry.connection?.label||'']));
 if(key!==drawn){
  drawn=key;
  $('server-list').replaceChildren(...rows.map(rowNode));
 }
 const view=state.view||'servers';
 $('servers').hidden=view!=='servers';
 $('add-server-view').hidden=view!=='add';
 $('create-instance-view').hidden=view!=='create';
 $('rename-instance-view').hidden=view!=='rename';
 $('servers-empty').hidden=stateName!=='empty';
 $('servers-empty').textContent='No e-servers yet. Create a new one, or add the address of one you can reach.';
 $('servers-error').hidden=servers.state!=='error';
 $('servers-error-text').textContent=servers.state==='error'?(servers.error||'Your e-servers could not be loaded.'):'';
 $('servers-retry').hidden=servers.state!=='error';
 const fallback=servers.state==='error'?servers.fallback||'':'';
 $('servers-fallback').hidden=!fallback;
 $('servers-fallback').textContent=fallback?'Connect to '+hostOf(fallback)+' instead':'';
 // THE INSTANCE PLANE'S OWN TWO ANSWERS. `available:false` is the service saying it has not
 // shipped it: a capability sentence, not an error, and the create button says why it is gone.
 const unavailable=instances.available===false;
 $('instances-unavailable').hidden=!unavailable;
 const instanceProblem=instances.state==='error';
 $('instances-error').hidden=!instanceProblem;
 $('instances-error-text').textContent=instanceProblem?(instances.error||'Your instances could not be loaded.'):'';
 $('server-add').hidden=servers.state==='loading'||servers.state==='error';
 const create=$('instance-create');
 create.hidden=unavailable||instanceProblem||servers.state==='loading';
 create.textContent='Create a new e-server';
 $('servers-actions').hidden=$('server-add').hidden&&create.hidden;
 // A WAIT IS VISIBLE, IN DIANA'S WORDS AND HER LAYOUT. Unchanged from the connections list: the
 // wait belongs to the address read, and it ends when that read does.
 const loading=servers.state==='loading'&&!rows.length;
 const line=$('servers-loading');
 if(line){
  if(loading&&line.hidden){
   line.textContent='Loading your e-servers…';
   if(document.activeElement?.id==='servers-retry'){line.tabIndex=-1;line.focus();parkedFocus=true;}
  }
  if(!loading&&!line.hidden){line.textContent='';}
  line.hidden=!loading;
 }
 $('servers-copy').hidden=stateName==='error'||loading;
 $('servers-copy').textContent=state.message||'Choose an e-server to connect to. It will ask for its own PIN.';
 if(view==='add'&&!document.activeElement?.closest('#add-server'))setTimeout(()=>$('add-origin').focus(),0);
 if(view==='create')drawCreate(state);
 if(view==='rename')drawRename(state);
 if(parkedFocus&&!loading){
  parkedFocus=false;
  const target=servers.state==='error'?$('servers-retry'):(rows.length?$('server-list').querySelector('.server-connect'):($('instance-create').hidden?$('server-add'):$('instance-create')));
  if(target&&!target.hidden)target.focus();
 }
}
function focusRow(origin){
 const row=origin&&[...$('server-list').children].find(item=>item.dataset.origin===origin);
 if(row)row.querySelector('.server-connect').focus();
 else if(!$('instance-create').hidden)$('instance-create').focus();
 else $('server-add').focus();
}
// ── the create page ──────────────────────────────────────────────────────────────────────
// THE PLAN LIST IS THE SERVICE'S. This file never invents a plan, a price or a currency: it draws
// the rows the account service returned and sends back the key the person chose. When the service
// has no catalogue the page says so and the button cannot be pressed — the honest failure the
// whole transport is written for.
let chosenPlan='';
function moneyLabel(plan){return plan.price||(Number.isFinite(plan.monthlyPence)
 ?(plan.monthlyPence/100).toFixed(plan.monthlyPence%100?2:0)+' '+(plan.currency||''):'');}
function drawCreate(state){
 const plans=state.plans||{loaded:false,configured:false,rows:[]};
 const list=$('plan-list');
 const key=JSON.stringify((plans.rows||[]).map(plan=>[plan.key,plan.name,plan.price,plan.monthlyPence,plan.currency]));
 if(list.dataset.key!==key||!list.childElementCount){
  list.dataset.key=key;
  list.replaceChildren(...(plans.rows||[]).map(plan=>{
   const option=document.createElement('label');option.className='plan-option';
   const input=document.createElement('input');input.type='radio';input.name='plan';input.value=plan.key;
   input.checked=plan.key===chosenPlan;
   input.onchange=()=>{chosenPlan=plan.key;drawSummary(state);};
   const copy=document.createElement('span');
   const name=document.createElement('span');name.className='plan-name';name.textContent=plan.name;
   copy.append(name);
   if(plan.description){const detail=document.createElement('span');detail.className='plan-copy';detail.textContent=plan.description;copy.append(detail);}
   const price=document.createElement('span');price.className='plan-price';price.textContent=moneyLabel(plan);
   option.append(input,copy,price);
   return option;
  }));
  if(!chosenPlan&&plans.rows?.length)chosenPlan=plans.rows[0].key;
  for(const input of list.querySelectorAll('input'))input.checked=input.value===chosenPlan;
 }
 const empty=$('plan-empty');
 if(!plans.loaded){empty.hidden=false;empty.textContent='Loading plans…';}
 else if(plans.error){empty.hidden=false;empty.textContent=plans.error;}
 else if(!plans.configured){empty.hidden=false;empty.textContent='Plans are not available on this service yet, so a new instance cannot be paid for.';}
 else if(!(plans.rows||[]).length){empty.hidden=false;empty.textContent='No plans are offered right now.';}
 else empty.hidden=true;
 $('plan-retry').hidden=!(plans.loaded&&plans.error);
 const ready=plans.loaded&&plans.configured&&(plans.rows||[]).length>0&&!!chosenPlan;
 $('create-submit').disabled=!ready;
 $('plan-fieldset').hidden=!(plans.rows||[]).length&&plans.loaded&&!plans.error;
 if(!document.activeElement?.closest('#create-instance'))setTimeout(()=>$('create-name').focus(),0);
 drawSummary(state);
}
function drawSummary(state){
 const name=$('create-name').value.trim(),domain=$('create-domain').value.trim();
 const plan=(state.plans?.rows||[]).find(row=>row.key===chosenPlan);
 $('create-summary').hidden=!(name||domain||plan);
 $('create-summary-name').textContent=name||'';
 $('create-summary-plan').textContent=plan?plan.name:'';
 $('create-summary-price').textContent=plan?moneyLabel(plan):'';
}
// ── the rename page ──────────────────────────────────────────────────────────────────────
let renaming=null;
function startRename(inst){
 renaming={id:inst.id,name:inst.displayName};
 $('rename-name').value=inst.displayName;
 $('rename-problem').textContent='';
 void bridge.view('rename');
}
function drawRename(state){
 if(!renaming){void bridge.view('servers');return;}
 if($('rename-name').value===''||$('rename-name').dataset.instance!==renaming.id){
  $('rename-name').value=renaming.name;
  $('rename-name').dataset.instance=renaming.id;
 }
 if(!document.activeElement?.closest('#rename-instance'))setTimeout(()=>$('rename-name').focus(),0);
 void state;
}
$('server-add').onclick=()=>{problem('');$('add-problem').textContent='';void bridge.view('add');};
$('add-cancel').onclick=()=>{void bridge.view('servers');};
$('servers-retry').onclick=()=>action(()=>bridge.refresh());
$('instances-retry').onclick=()=>action(async()=>{await bridge.instances();say('');});
$('plan-retry').onclick=()=>action(async()=>{await bridge.plans();});
$('instance-create').onclick=()=>{problem('');$('create-problem').textContent='';$('create-wait').hidden=true;void bridge.view('create');};
$('create-cancel').onclick=()=>{void bridge.view('servers');};
$('rename-cancel').onclick=()=>{renaming=null;void bridge.view('servers');};
$('create-name').addEventListener('input',()=>drawSummary(current));
$('create-domain').addEventListener('input',()=>drawSummary(current));
// THE CREATE PAGE'S ONE WRITE. The fields are checked here so a typo costs no round trip, the
// service checks them again (it is the authority), and a refusal is printed under the form. A
// success has already opened Stripe Checkout in the person's browser from the main process; the
// list is where they come back to, and the instance appears as `pending` until Stripe confirms it.
$('create-instance').onsubmit=event=>{
 event.preventDefault();
 const displayName=$('create-name').value.trim(),domain=$('create-domain').value.trim();
 $('create-problem').textContent='';
 if(!displayName){$('create-problem').textContent='Enter a display name for the instance.';$('create-name').focus();return;}
 if(!domain){$('create-problem').textContent='Enter the domain the instance will answer on.';$('create-domain').focus();return;}
 if(!chosenPlan){$('create-problem').textContent='Choose a plan.';return;}
 const form=$('create-instance'),submit=$('create-submit');
 form.dataset.busy='true';submit.disabled=true;$('create-wait').hidden=false;
 bridge.createInstance({displayName,domain,plan:chosenPlan}).then(answer=>{
  form.dataset.busy='false';submit.disabled=false;$('create-wait').hidden=true;
  if(answer&&answer.ok){
   $('create-name').value='';$('create-domain').value='';chosenPlan='';
   void bridge.view('servers');
   say((answer.instance?.displayName||displayName)+' was created'+(answer.checkout?'. Finish the payment in your browser.':'.'));
   return;
  }
  $('create-problem').textContent=(answer&&answer.error)||'The instance could not be created.';
  submit.disabled=false;
 }).catch(error=>{
  form.dataset.busy='false';submit.disabled=false;$('create-wait').hidden=true;
  $('create-problem').textContent=sentence(error);
 });
};
$('rename-instance').onsubmit=event=>{
 event.preventDefault();
 if(!renaming)return;
 const displayName=$('rename-name').value.trim();
 $('rename-problem').textContent='';
 if(!displayName){$('rename-problem').textContent='Enter a display name.';$('rename-name').focus();return;}
 const form=$('rename-instance'),submit=$('rename-submit');
 form.dataset.busy='true';submit.disabled=true;
 bridge.renameInstance(renaming.id,displayName).then(answer=>{
  form.dataset.busy='false';submit.disabled=false;
  if(answer&&answer.ok){const next=answer.instance?.displayName||displayName;renaming=null;void bridge.view('servers');say('Renamed to '+next+'.');return;}
  $('rename-problem').textContent=(answer&&answer.error)||'The name could not be saved.';
 }).catch(error=>{form.dataset.busy='false';submit.disabled=false;$('rename-problem').textContent=sentence(error);});
};
$('add-server').onsubmit=event=>{
 event.preventDefault();
 const origin=$('add-origin').value.trim(),label=$('add-name').value.trim();
 $('add-problem').textContent='';
 if(!origin){$('add-problem').textContent='Enter your e-server HTTPS address.';$('add-origin').focus();return;}
 $('add-server').dataset.busy='true';
 // A probe of a name that may not answer takes seconds: the button says what is happening rather
 // than dimming and leaving the person to guess.
 const submit=$('add-submit');if(submit)submit.textContent='Checking…';
 const settle=()=>{$('add-server').dataset.busy='false';if(submit)submit.textContent='Add e-server';};
 bridge.addServer({origin,label}).then(answer=>{
  settle();
  if(answer&&answer.ok){
   $('add-origin').value='';$('add-name').value='';
   void bridge.view('servers');
   say('Added '+(answer.row&&answer.row.label?answer.row.label:origin)+' to your e-servers.');
   // The new row is the one to land on: the person just made it, and the list is where it lives.
   void bridge.state().then(next=>{current=next;drawServers(next,true);focusRow(answer.row&&answer.row.origin);});
   return;
  }
  $('add-problem').textContent=(answer&&answer.error)||'That e-server could not be added.';
  $('add-origin').focus();
 }).catch(error=>{settle();$('add-problem').textContent=sentence(error);});
};
$('signout').onclick=()=>action(()=>bridge.signOut());
$('cancel-signin').onclick=()=>bridge.cancelAccount();
$('retry').onclick=()=>bridge.retry();$('installer').onclick=()=>bridge.download();bridge.onState(render);bridge.state().then(render);
// THE ACCOUNT DOCUMENT CHANGES WHILE THIS WINDOW IS NOT LOOKING: a save in e-server's settings
// panel is made on another surface, so the window asks again the next time it has the person's
// attention. The main process bounds how often it will ask (THEME_REFRESH_MIN_MS), and the answer
// arrives on the usual `client:state` channel, so nothing here knows what the answer will be.
window.addEventListener('focus',()=>{void bridge.themeRefresh?.().catch(()=>{});});
// AND ONCE WHEN THIS DOCUMENT HAS RENDERED ITS FIRST STATE, for the same reason: `bridge.state()`
// can be answered a moment before the account's theme has been read, and the publish that then
// carries it can land before this window is listening. Asking again republishes the state to a
// window that is listening by definition, so the correction is never lost between the two.
bridge.state().then(()=>{void bridge.themeRefresh?.().catch(()=>{});}).catch(()=>{});
