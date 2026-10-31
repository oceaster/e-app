// The browser half of Microsoft sign-in: authorization code + PKCE, exchanged by the API.
// doc/BROWSER_SIGN_IN.md in the cloud repository is the contract this module consumes:
//
//   POST /v2/oauth/microsoft/start     -> {state, authorizeUrl, expiresIn, redirectUri}
//   the page navigates to authorizeUrl; Microsoft sends the browser back with ?code=&state=
//   POST /v2/oauth/microsoft/exchange  {code, state} -> the account envelope + a session
//
// WHAT THIS MODULE NEVER HOLDS. No Microsoft token of any kind - not the access token, not
// the refresh token, not the PKCE verifier. The code comes back in this page's own URL and
// is posted once; the service redeems it against a verifier that never left the server, so
// a stolen code is a string Microsoft refuses. The Company session token that comes back
// belongs to the session seam (site/web-account.mjs), not to this file.
//
// AND WHAT IT NEVER ASKS FOR. There is no call to /v2/game/session here and there can be
// none that works: the exchange stores no provider refresh token (the backend discards it
// by design), so Play stays in the launcher. A browser session can identify the player,
// read the store and place orders. That is the product boundary, not an unfinished edge.
import {API_ORIGIN,AccountError} from '../account-client.mjs';

// THE REDIRECT IS A CONTRACT. This exact literal - scheme, host, path, trailing slash - is
// what has to be registered as a Web redirect URI on the Easter Company Microsoft
// application, and Microsoft compares it as a string. It moved with the site to the custom
// domain on 2026-10-26: Owen registered https://launcher.easter.company/account/ and the
// API's BROWSER_REDIRECT_URI moved in the same change, because shipping one without the
// other refuses every sign-in. GitHub Pages answers /account with a redirect to /account/,
// so the two spellings are never interchangeable either: a flow started from any other
// address would be sent to a URI nobody registered and Microsoft would refuse it after the
// player had already signed in.
export const REDIRECT_URI='https://launcher.easter.company/account/';
// The path that literal names. Starting a flow compares the page's own pathname with it, which is
// the one part of the address this page can check on its own and the one part a preview or a
// mirror of the site shares; the origin is checked where it matters, on the redirect URI the
// service answers with, in start() below.
export const ACCOUNT_PATH=new URL(REDIRECT_URI).pathname;

// The one authority this page may be sent to. The API builds the address, and this module
// refuses to navigate anywhere else, the same rule site/web-account.mjs applies to the
// provider broker's address: a response that named another host would otherwise be able to
// turn this page into an open redirect.
const AUTHORITY_ORIGIN='https://login.microsoftonline.com';
const AUTHORIZE_PATH='/consumers/oauth2/v2.0/authorize';
// 43 characters of urlsafe base64: 32 bytes from secrets.token_urlsafe (api/microsoft_oauth.py
// STATE_BYTES). A state of another shape is not one this service minted.
const STATE_PATTERN=/^[-_A-Za-z0-9]{43}$/;

// The account service scales to zero, and its one declared "nothing was carried out" answer is
// 503 database_unavailable: the claim happens before any upstream call, so a second attempt
// cannot double-spend a code or write a second flow row. These are the launcher's own numbers
// (site/account-client.mjs, DATABASE_RESUME_*): four attempts inside a ninety-second window,
// three seconds of backoff per attempt. Nothing else is ever retried - a refusal is an answer,
// and a lost answer stays "start again" rather than becoming a replay.
const WAKING_ATTEMPTS=4,WAKING_BACKOFF_MS=3000,WAKING_BUDGET_MS=90000;
const UNREACHABLE='The Easter Company account service could not be reached.';
const UNREADABLE='The Easter Company account service could not complete that request.';
// The account service's own sentence for `microsoft_not_configured` (MESSAGES in
// api/microsoft_oauth.py). It is used here as well, because a page that refuses to start a
// flow for its own reason is in exactly that state: nothing is registered to receive the
// answer. One wording for one situation, whichever half noticed it.
export const NOT_CONFIGURED='Browser Microsoft sign-in is not configured yet.';
// The account service's own sentence for `oauth_state_invalid`, used when this page refuses
// a callback before sending anything: a state that did not come back cannot open a flow.
export const START_AGAIN='This sign-in has expired or was already used. Start again.';
// The account service's own sentence for an exchange with no code in it
// (api/microsoft_oauth.py, sign_in). A cancelled sign-in arrives here without one.
export const NO_CODE='Microsoft did not return an authorization code. Start again.';
// Rate limiting is the one refusal the service answers without a sentence of its own
// (_rate_limited sends only {"error":"rate_limited"}), so the wording is the launcher's:
// MESSAGES.rate_limited in the generated site/account-client.mjs, copied because that table
// is not exported from the generated file.
const RATE_LIMITED='Too many account requests just now. Wait a moment and try again.';

// Control and bidi-override characters are dropped before either a service message or an
// authority description is drawn: a string that could reorder the text around it has no
// business in a sentence a player reads. Lengths are bounded because one of these values
// arrives in this page's own query string and anyone can put anything there.
const INVISIBLE=/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const text=(value,max)=>{const raw=typeof value==='string'?value:'';const clean=raw.replace(INVISIBLE,' ').replace(/\s+/g,' ').trim();return clean.slice(0,max);};

// The longest refusal this API sends is the redirect_uri_not_registered sentence, which names
// the URI to register and is longer than 200 characters: truncating it would cut off the one
// thing it exists to say, so the service's own text gets room the authority's prose does not.
const MESSAGE_MAX=400;
const DESCRIPTION_MAX=200;
const CODE_MAX=4096;

// One refusal, as the page needs it: the service's own sentence (its `message`), its own code
// word (its `error`), and the status. Nothing here is invented when the service spoke - the
// two fallbacks exist only for the answers that arrive without a sentence at all.
export function serviceError(status,body){
 const code=text(body?.error,64);
 const message=text(body?.message,MESSAGE_MAX);
 const sentence=message||(status===429?RATE_LIMITED:UNREADABLE);
 const error=new AccountError(code||'service_'+(status||'error'),sentence);
 error.status=status;
 return error;
}

// What arrived in this page's own query string. Three shapes are possible and they are not
// interchangeable: a code with a state (finish the sign-in), an error with a description (the
// authority refused, and no exchange may be attempted), and neither (a plain visit). A code
// with no state is refused here rather than posted: the service would refuse it anyway, and
// asking it to try is a request that cannot succeed.
export function readCallback(search){
 const params=new URLSearchParams(typeof search==='string'?search:'');
 const error=text(params.get('error'),64);
 const description=text(params.get('error_description'),DESCRIPTION_MAX);
 const code=text(params.get('code'),CODE_MAX);
 const state=text(params.get('state'),128);
 if(error)return {kind:'refused',error,description};
 if(!code)return {kind:'none'};
 if(!state||!STATE_PATTERN.test(state))return {kind:'state-missing',code};
 return {kind:'code',code,state};
}

// THE REDIRECT IS A PARAMETER, DEFAULTING TO THIS SITE'S OWN REGISTERED LITERAL.
//
// A second first-party site signs in on its OWN address: Owen registered
// https://easter.company/account/ on the Easter Company application on 2026-10-27, and the
// service takes the address a caller names as long as the deployment allows it
// (api/microsoft_oauth.py, the allow-list). So the page hands the address over instead of
// assuming launcher.easter.company: `createMicrosoftSignIn({redirectUri})`. A caller that
// passes nothing gets REDIRECT_URI and the behaviour every existing page already has.
export function createMicrosoftSignIn({request=(...args)=>fetch(...args),baseUrl=API_ORIGIN,timeout=30000,waitFor=ms=>new Promise(done=>setTimeout(done,ms)),now=Date.now,redirectUri=REDIRECT_URI}={}){
 // One POST, with the browser transport rules the rest of this site already uses: no ambient
 // cookies, no cache, no redirect followed, no referrer.
 const once=async (pathname,body,ceiling)=>{
  let response;
  try{
   response=await request(baseUrl+pathname,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(ceiling)});
  }catch{throw new AccountError('unreachable',UNREACHABLE);}
  let data=null;
  try{data=await response.json();}catch{}
  if(!response.ok)throw serviceError(response.status,data);
  if(!data||typeof data!=='object'||Array.isArray(data))throw new AccountError('invalid_response',UNREADABLE);
  return data;
 };
 // One POST, and at most a wait for a waking account service on the one answer that proves it
 // carried nothing out. Nothing else is asked twice: a start that lost its answer has written a
 // row that expires on its own, and an exchange is single use by construction, so a second
 // attempt would spend the player's code on a question the service has already answered.
 const send=async (pathname,body)=>{
  const deadline=now()+WAKING_BUDGET_MS;
  let lastError=null;
  for(let attempt=1;;attempt++){
   const remaining=deadline-now();
   if(remaining<=0)throw lastError||new AccountError('unreachable',UNREACHABLE);
   try{return await once(pathname,body,Math.max(1,Math.min(timeout,remaining)));}
   catch(error){
    if(error?.code!=='database_unavailable'||attempt>=WAKING_ATTEMPTS)throw error;
    lastError=error;
    const delay=Math.min(WAKING_BACKOFF_MS*attempt,deadline-now());
    if(delay<=0)throw error;
    await waitFor(delay);
   }
  }
 };
 return {
  // Ask the service to begin a flow, and check the answer before the browser is sent anywhere.
  // Two refusals can happen here and both mean "not configured yet" rather than "your sign-in
  // is broken": an address this page will not navigate to, and an answer whose redirect is not
  // this page's registered literal. The second names the disagreement before a code is spent
  // on a URI Microsoft does not know.
  async start(){
   // The address this page is registered at is NAMED to the service, so the flow is minted
   // for the right one: the start answer and the authorize URL are then checked against it
   // below, and a deployment that does not allow it refuses before a browser moves.
   const answer=await send('/v2/oauth/microsoft/start',{redirectUri});
   const state=typeof answer.state==='string'?answer.state:'';
   let url=null;
   try{url=new URL(typeof answer.authorizeUrl==='string'?answer.authorizeUrl:'');}catch{url=null;}
   if(!url||!STATE_PATTERN.test(state)||url.origin!==AUTHORITY_ORIGIN||url.pathname!==AUTHORIZE_PATH||url.username||url.password)throw new AccountError('invalid_request','The sign-in address is invalid.');
   if(answer.redirectUri!==redirectUri||url.searchParams.get('redirect_uri')!==redirectUri)throw new AccountError('not_configured',NOT_CONFIGURED);
   return {state,authorizeUrl:url.href};
  },
  // Finish a callback this page received. `code` and `state` are the two values the URL
  // actually carried, and the state is posted exactly as received: it is the handle on the
  // verifier the service kept, and a flow can only be redeemed with the state that started it.
  async exchange(code,state){
   if(!code)throw new AccountError('invalid_request',NO_CODE);
   if(!state)throw new AccountError('oauth_state_invalid',START_AGAIN);
   return send('/v2/oauth/microsoft/exchange',{code,state,client:'website/1'});
  }
 };
}
