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
import {SIGN_IN_TITLE,SIGN_IN_WAIT,createSignInOptions} from './vendor/launcher/signin-options.mjs';
const $=id=>document.getElementById(id),bridge=window.eServerSetup;
let providersLoaded=false,shownError=null;
// An IPC rejection arrives wrapped - "Error invoking remote method 'company:login': Error: ..." -
// and that wrapper is Electron's plumbing, not a sentence for a player. The main process already
// names what happened ("Sign-in cancelled."), so the wrapper is unwrapped and nothing else is
// rewritten: the client shows the meaning it was given, never the transport.
const sentence=value=>String(value??'').replace(/^Error invoking remote method '[^']+':\s*(?:Error|TypeError|RangeError|SyntaxError|URIError|ReferenceError|EvalError)?:?\s*/,'');
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
function render(state){
 const ready=state.accountReady===true,finish=!!state.account&&!ready,busy=state.accountBusy===true;
 const updating=['checking','downloading','verifying'].includes(state.phase);
 $('version').textContent=state.version;
 // The page's heading is the dialog's heading, written in one file (site/signin-options.mjs), so a
 // plain sign-in reads exactly what the site reads. Every other phase is the client's own.
 $('title').textContent=ready?state.title||'Your e-server.':finish?'Make it yours.':SIGN_IN_TITLE;
 $('message').textContent=ready?state.message||'Connect to your private network, then enter your server HTTPS address.':finish?'Choose your username and password to finish your global account.':'';
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
 $('connect').hidden=!(ready&&['setup','offline'].includes(state.phase));
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
 if(ready&&!$('server').value)$('server').value=state.server||'https://easter-server.char-istrian.ts.net';
 if(!ready&&!finish&&!providersLoaded&&!busy){providersLoaded=true;bridge.providers().then(answer=>options.setProviders(answer.providers||[])).catch(()=>{providersLoaded=false;options.providersUnreadable();});}
}
$('username').addEventListener('input',event=>{event.target.value=event.target.value.toLowerCase();});
$('account-finish').onsubmit=event=>{
 event.preventDefault();
 if($('new-password').value!==$('confirm-password').value){problem('Passwords must match.');return;}
 const password=$('new-password').value;$('new-password').value='';$('confirm-password').value='';
 void action(()=>bridge.finish($('username').value,password));
};
$('connect').onsubmit=event=>{event.preventDefault();void action(()=>bridge.connect($('server').value));};
$('signout').onclick=()=>action(()=>bridge.signOut());
$('cancel-signin').onclick=()=>bridge.cancelAccount();
$('retry').onclick=()=>bridge.retry();$('installer').onclick=()=>bridge.download();bridge.onState(render);bridge.state().then(render);
