'use strict';
// THE PERSON'S OWN LIST OF E-SERVERS, KEPT IN THEIR EASTER COMPANY ACCOUNT.
//
// What this replaces: `settings.json`'s one `server` field, which meant the app reconnected a
// signed-in person to whichever e-server they used last, decided on one machine, and lost if
// they signed in on another. Owen, 2026-11-03: after sign-in there should be an intermediary
// view of the e-servers that account may connect to, with a way to remove one and a second view
// to add one, and the list belongs to the account, not the disk. So the list is a row per
// e-server on the accounts service, and this module is the client's half of that API:
// `GET`/`POST /v2/accounts/connections` and `DELETE`/`PATCH /v2/accounts/connections/{id}`.
//
// WHY THIS IS NOT api/account-client.mjs: that file is VENDORED VERBATIM from the launcher's
// site (desktop/vendor/launcher/README.md) and its OPERATIONS table is the launcher's policy for
// the routes the launcher calls - it throws for a path it does not name. Adding a route there
// would be editing the owner's module, which the household rule forbids. So the transport here
// is this app's own, with this app's own bounds, and it borrows exactly one thing from the
// vendored client: the API origin, passed in rather than written down twice.
//
// THE RULES THIS TRANSPORT KEEPS, for the same reasons the vendored one has them:
//   * A READ may be repeated: it changes nothing server side. A WRITE may not: a lost answer
//     may have committed, so a POST that timed out is reported, never retried behind the
//     person's back. A DELETE is the exception and is retried, because the route is idempotent
//     (204 for an id that is already gone) - that is what makes removing a stale row safe.
//   * 401/403/409/422/429 are ANSWERS, not failures. They are never repeated and their code is
//     carried out unchanged, so the renderer can say the true sentence.
//   * Every call is bounded. A hung service must not hold the window on a spinner.
const {serverOrigin}=require('./security.cjs');

const CONNECTIONS_PATH='/v2/accounts/connections';
//: A read the person is waiting on. The gateway cuts an integration at 30 s; ten is already a
//: service that is not answering, and the view has a retry.
const READ_TIMEOUT_MS=10000;
//: A write carries more consequence than a read and is still one round trip.
const WRITE_TIMEOUT_MS=15000;
//: The service's own bound, restated here so the client refuses the 51st row with a sentence
//: instead of an error the person cannot act on. The service is the authority; this is a copy
//: of a number it owns and it is checked by tests/connections.test.cjs against the API's limit.
const MAX_CONNECTIONS=50;
//: The service's label bound, same reason as above.
const MAX_LABEL=60;

/** What a connection is, as this app reads it. `label` is always present; the service fills it. */
function connection(item){
 if(!item||typeof item!=='object')throw new ConnectionError('invalid_response','The account service returned an e-server this app cannot read.');
 const origin=String(item.origin||''),id=String(item.id||'');
 if(!origin||!id)throw new ConnectionError('invalid_response','The account service returned an e-server this app cannot read.');
 return {
  id,
  origin,
  label:String(item.label||host(origin)),
  addedAt:item.added_at||null,
  lastUsedAt:item.last_used_at||null,
 };
}

/** The quiet half of a row: the address a person recognises, without the scheme or a bare port. */
function host(origin){
 try{const url=new URL(origin);return url.host;}catch{return String(origin||'');}
}

/** A name for a row the person did not name, derived from the address they typed. */
function defaultLabel(origin){
 return host(origin).slice(0,MAX_LABEL);
}

/**
 * The one error shape this module raises: a code the renderer can branch on and the sentence the
 * person should read. `detail` is the service's own sentence when it named one, so a refusal is
 * never paraphrased into something it did not say.
 */
class ConnectionError extends Error{
 constructor(code,message,{status=0,detail=''}={}){
  super(message||detail||code);
  this.name='ConnectionError';this.code=code;this.status=status;this.detail=detail||message||code;
 }
}

/** The service's named refusals, with the sentence this app shows for each. */
const MESSAGES={
 connection_exists:'That e-server is already in your list.',
 connections_limit:'Your list is full. Remove an e-server before adding another.',
 connection_not_found:'That e-server is no longer in your list.',
 invalid_origin:'That is not an e-server address. Enter its HTTPS origin, such as https://easter-server.example.net.',
 invalid_label:'A name can be up to '+MAX_LABEL+' characters.',
 invalid_session:'Sign in to your Easter Company account again.',
 database_unavailable:'Your e-servers could not be saved. Try again in a moment.',
 rate_limited:'Too many changes at once. Wait a moment and try again.',
 unreachable:'The Easter Company account service could not be reached.',
 timeout:'The account service did not answer in time.',
 invalid_response:'The account service answered with something this app cannot read.'
};

/**
 * @param {{origin:string, token?:string, fetch?:Function, now?:Function, baseUrl?:string}} options
 *   `origin` is the accounts API origin; `token` is read per call through `credential()` so a
 *   refreshed session is used without rebuilding this object.
 */
class Connections{
 constructor({origin,token,credential,fetch:fetchImpl,now=Date.now,development=false}={}){
  if(!origin)throw Error('A connections client needs the accounts API origin.');
  this.origin=String(origin).replace(/\/+$/,'');
  // A development checkout may point at a loopback fixture, exactly as the sign-in transport
  // does (api/accounts.cjs's own rule); a packaged app never does, and main.cjs passes nothing.
  this.development=!!development;
  this.credential=credential||(()=>token);
  this.fetch=fetchImpl||((url,init)=>fetch(url,init));
  this.now=now;
 }
 url(path=''){return this.origin+CONNECTIONS_PATH+path;}
 /** One bounded call. `repeat` is the read/delete rule above and nothing else decides it. */
 async call(path,{method='GET',body,timeout=READ_TIMEOUT_MS,repeat=false}={}){
  const token=this.credential();
  if(!token)throw new ConnectionError('invalid_session',MESSAGES.invalid_session);
  const attempt=async()=>{
   const controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),timeout);
   try{
    const headers={Authorization:'Bearer '+token,'Accept':'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await this.fetch(this.url(path),{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,redirect:'error',cache:'no-store'});
    const text=await response.text().catch(()=>'');
    let document=null;try{document=text?JSON.parse(text):null;}catch{document=null;}
    if(response.status===204)return null;
    if(response.ok)return document;
    const code=document&&typeof document.error==='string'?document.error:'invalid_response';
    const detail=document&&typeof document.message==='string'?document.message:document&&typeof document.detail==='string'?document.detail:'';
    throw new ConnectionError(code,MESSAGES[code]||detail||MESSAGES.invalid_response,{status:response.status,detail});
   }catch(error){
    if(error instanceof ConnectionError)throw error;
    if(error&&(error.name==='AbortError'||error.name==='TimeoutError'))throw new ConnectionError('timeout',MESSAGES.timeout);
    throw new ConnectionError('unreachable',MESSAGES.unreachable);
   }finally{clearTimeout(timer);}
  };
  if(!repeat)return attempt();
  try{return await attempt();}
  catch(error){
   // One repeat, and only for the two outcomes a second identical request can honestly fix: the
   // service was cold or the connection dropped. An answer (any 4xx) is never repeated.
   if(!['unreachable','timeout'].includes(error.code))throw error;
   return attempt();
  }
 }
 /** Every connection this account holds, in the service's order (most recently used first). */
 async list(){
  const document=await this.call('',{timeout:READ_TIMEOUT_MS,repeat:true});
  const rows=document&&Array.isArray(document.connections)?document.connections:[];
  return {connections:rows.map(connection),limit:Number(document&&document.limit)||MAX_CONNECTIONS};
 }
 /**
  * Add one. The origin is normalized exactly as the app's server selection normalizes it, so the
  * list cannot hold two spellings of one server; `label` falls back to the host so no row is
  * anonymous. Refusals carry the service's code through unchanged.
  */
 async add({origin,label}={}){
  const normalized=serverOrigin(origin,{development:this.development});
  const name=String(label||'').trim().slice(0,MAX_LABEL)||defaultLabel(normalized);
  const document=await this.call('',{method:'POST',body:{origin:normalized,label:name},timeout:WRITE_TIMEOUT_MS});
  return connection(document&&document.connection);
 }
 /** Remove one. Idempotent on the service, so a retry after a lost answer cannot fail a person,
  *  and a row the service says is already gone is the outcome that was asked for. */
 async remove(id){
  if(!id)throw new ConnectionError('connection_not_found',MESSAGES.connection_not_found);
  try{await this.call('/'+encodeURIComponent(String(id)),{method:'DELETE',timeout:WRITE_TIMEOUT_MS,repeat:true});}
  catch(error){
   if(error.code==='connection_not_found')return {ok:true,already:true};
   throw error;
  }
  return {ok:true};
 }
 /** Record that this server was chosen. Best effort: a list that cannot be touched is not a
  *  reason to refuse a connection the person asked for, so callers get a code and never a throw. */
 async touch(id){
  if(!id)return {ok:false,error:'connection_not_found'};
  try{await this.call('/'+encodeURIComponent(String(id)),{method:'PATCH',body:{touch:true},timeout:WRITE_TIMEOUT_MS});return {ok:true};}
  catch(error){return {ok:false,error:error.code||'unreachable'};}
 }
 async rename(id,label){
  const name=String(label||'').trim().slice(0,MAX_LABEL);
  if(!name)throw new ConnectionError('invalid_label',MESSAGES.invalid_label);
  const document=await this.call('/'+encodeURIComponent(String(id)),{method:'PATCH',body:{label:name},timeout:WRITE_TIMEOUT_MS});
  return connection(document&&document.connection);
 }
}

module.exports={Connections,ConnectionError,connection,host,defaultLabel,MESSAGES,MAX_CONNECTIONS,MAX_LABEL,CONNECTIONS_PATH,READ_TIMEOUT_MS,WRITE_TIMEOUT_MS};
