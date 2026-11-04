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
function render(state){
 current=state;
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
function rowNode(row){
 const item=document.createElement('li');item.className='server-row';item.dataset.origin=row.origin;
 const choose=document.createElement('button');choose.type='button';choose.className='server-connect';
 const name=document.createElement('span');name.className='server-name';name.textContent=row.label||hostOf(row.origin);
 // The address is the quiet second line - unless it is already the row's name, in which case
 // printing it twice says nothing and looks like a mistake (measured on a row whose label the
 // service derived from its host).
 choose.append(name);
 if(name.textContent!==hostOf(row.origin)){const where=document.createElement('span');where.className='server-origin';where.textContent=hostOf(row.origin);choose.append(where);}
 choose.onclick=()=>action(()=>bridge.connect(row.origin));
 const remove=document.createElement('button');remove.type='button';remove.className='server-remove';
 remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+(row.label||hostOf(row.origin)));
 remove.onclick=()=>action(async()=>{await bridge.removeServer(row.id,row.label);say('Removed '+(row.label||hostOf(row.origin))+' from your e-servers.');});
 item.append(choose,remove);return item;
}
function drawServers(state,shown){
 const list=boundedList(state.servers||{state:'idle',rows:[]});
 $('client-servers').hidden=!shown;
 if(!shown)return;
 watchLoading();
 $('client-servers').dataset.state=list.state||'idle';
 const adding=state.view==='add';
 $('servers').hidden=adding;$('add-server-view').hidden=!adding;
 // The rows are rebuilt only when the list they came from changed, so a keystroke in the add
 // form or a publish from the updater cannot move the person's focus out of a row.
 const key=JSON.stringify((list.rows||[]).map(row=>[row.id,row.label,row.origin]));
 if(key!==drawn){
  drawn=key;
  $('server-list').replaceChildren(...(list.rows||[]).map(rowNode));
  const previous=$('server-list').getAttribute('aria-busy');void previous;
 }
 $('servers-empty').hidden=list.state!=='empty';
 $('servers-empty').textContent='No e-servers yet. Add the address of one you can reach.';
 $('servers-error').hidden=list.state!=='error';
 $('servers-error-text').textContent=list.state==='error'?(list.error||'Your e-servers could not be loaded.'):'';
 $('servers-retry').hidden=list.state!=='error';
 const fallback=list.state==='error'?list.fallback||'':'';
 $('servers-fallback').hidden=!fallback;
 $('servers-fallback').textContent=fallback?'Connect to '+hostOf(fallback)+' instead':'';
 $('server-add').hidden=list.state==='loading'||list.state==='error';
 $('servers-copy').hidden=list.state==='error';
 $('servers-copy').textContent=state.message||'Choose an e-server to connect to. It will ask for its own PIN.';
 if(adding&&!document.activeElement?.closest('#add-server'))setTimeout(()=>$('add-origin').focus(),0);
}
function focusRow(origin){
 const row=origin&&[...$('server-list').children].find(item=>item.dataset.origin===origin);
 if(row)row.querySelector('.server-connect').focus();else $('server-add').focus();
}
$('server-add').onclick=()=>{problem('');$('add-problem').textContent='';void bridge.view('add');};
$('add-cancel').onclick=()=>{void bridge.view('servers');};
$('servers-retry').onclick=()=>action(()=>bridge.refresh());
$('servers-fallback').onclick=()=>action(()=>bridge.connect(current.servers?.fallback||''));
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
