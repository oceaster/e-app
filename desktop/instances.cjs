'use strict';
// THE ACCOUNT'S e-server INSTANCES: the first screen after sign-in, and the four things a person
// may do to one of them.
//
// Owen, 2026-11-09: after sign-in the client must land on the instance menu, each instance must
// carry a display name and a domain, and the owner must be able to rename, delete (cancelling the
// plan at the end of the paid period) and create a new one; a member must be able to leave. Those
// facts live on the Easter Company accounts service's instance plane, not on this disk, so this
// module is the client's half of that API and nothing else:
//
//     GET    /v2/accounts/instances                     every instance this account may use
//     GET    /v2/accounts/instance-plans                the plans the create page may offer
//     POST   /v2/accounts/instances                     create one, opening Stripe Checkout
//     PATCH  /v2/accounts/instances/{id}                rename the display name (owner)
//     DELETE /v2/accounts/instances/{id}                delete (owner): plan cancels at period end
//     DELETE /v2/accounts/instances/{id}/members/me     leave (member): remove my records
//
// THE RULES ARE THE CONNECTIONS LIST'S, deliberately: a READ is repeated once when the transport
// failed and never when the service answered; every call is bounded; a 4xx is an ANSWER whose code
// travels out unchanged so the renderer can say the true sentence; a store failure is never an
// empty list. The two lists differ in what they are about, not in how they are fetched.
//
// THE TOKEN NEVER COMES NEAR THE RENDERER. `credential()` is read per call by the main process and
// is the only thing that leaves this module's bearer header; the page names an instance, a name or
// a plan and never sees the Company session or the accounts origin.
const {serverOrigin}=require('./security.cjs');

const INSTANCES_PATH='/v2/accounts/instances';
const PLANS_PATH='/v2/accounts/instance-plans';
const READ_TIMEOUT_MS=10000;
const WRITE_TIMEOUT_MS=15000;
const MAX_DISPLAY_NAME=80;
const MAX_DOMAIN=253;

/** Shown for a refusal whose code this client does not know; the service's own sentence wins. */
const FALLBACK='The instance service refused this request.';

const MESSAGES={
 invalid_session:'Sign in to your Easter Company account again.',
 instances_unavailable:'This account service does not offer instance management yet.',
 not_the_owner:'Only the account that owns this instance can do that.',
 not_a_member:'You are not a member of this instance.',
 not_found:'That instance is no longer on your account.',
 instance_exists:'That name is already used by another instance. Choose a different display name.',
 account_owns_an_instance:'Your account already owns an instance. Delete it before creating another.',
 domain_taken:'That domain is already in use by another instance.',
 invalid_display_name:'A display name is 1 to '+MAX_DISPLAY_NAME+' characters.',
 invalid_domain:'That is not a usable instance domain.',
 invalid_plan:'Choose one of the plans offered.',
 checkout_not_configured:'Plans are not available on this service yet, so a new instance cannot be paid for.',
 deletion_already_scheduled:'This instance is already scheduled for deletion.',
 owner_cannot_leave:'You own this instance, so you delete it rather than leave it.',
 rate_limited:'Too many changes at once. Wait a moment and try again.',
 database_unavailable:'Your instances could not be read. Try again in a moment.',
 unreachable:'The Easter Company account service could not be reached.',
 timeout:'The account service did not answer in time.',
 invalid_response:'The account service answered with something this app cannot read.'
};

class InstanceError extends Error{
 constructor(code,message,{status=0,detail=''}={}){
  super(message||detail||code);
  this.name='InstanceError';this.code=code;this.status=status;this.detail=detail||message||code;
 }
}

const text=value=>typeof value==='string'?value:'';
const number=value=>Number.isFinite(value)?value:null;
const iso=value=>typeof value==='string'&&value?value:null;

/** The origin a domain means. A domain is a HOST; the client always speaks https to it. */
function originOf(domain){
 const host=text(domain).trim().toLowerCase();
 return host?'https://'+host:'';
}

/** One instance, in the shape every view reads. Missing optional parts are explicit nulls so a
 *  renderer never has to tell "absent" from "the service does not have one". */
function instance(row){
 if(!row||typeof row!=='object')throw new InstanceError('invalid_response',MESSAGES.invalid_response);
 const id=text(row.id);
 if(!id)throw new InstanceError('invalid_response',MESSAGES.invalid_response);
 // AN INSTANCE CAN PREDATE DOMAINS. The plane registered instances before the field existed, and
 // a legacy row publishes domain:null rather than an invented address - so the menu must render
 // it (owner actions and all) instead of failing the whole list. `origin` falls back to the
 // domain when the service did not send one; an instance with neither is shown as having no
 // address yet and cannot be connected to.
 let domain=text(row.domain).trim().toLowerCase();
 let origin=text(row.origin);
 if(!domain&&origin){try{domain=new URL(origin).hostname.toLowerCase();}catch{domain='';}}
 if(!origin&&domain)origin=originOf(domain);
 const plan=row.plan&&typeof row.plan==='object'?row.plan:null;
 const billing=row.billing&&typeof row.billing==='object'?row.billing:null;
 const deletion=row.deletion&&typeof row.deletion==='object'?row.deletion:null;
 const role=row.role==='owner'?'owner':row.role==='member'?'member':'member';
 return {
  id,
  displayName:text(row.displayName).trim()||domain.split('.')[0]||id,
  domain,
  origin,
  role,
  owned:role==='owner',
  state:text(row.state)||'active',
  plan:plan?{key:text(plan.key)||'',name:text(plan.name)||text(plan.key)||'',
   includedTokensBillions:number(plan.includedTokensBillions)}:null,
  billing:billing?{status:text(billing.status)||'none',cancelAtPeriodEnd:billing.cancelAtPeriodEnd===true,
   currentPeriodEnd:iso(billing.currentPeriodEnd)}:{status:'none',cancelAtPeriodEnd:false,currentPeriodEnd:null},
  deletion:{scheduledFor:deletion?iso(deletion.scheduledFor):null},
  createdAt:iso(row.createdAt),
  updatedAt:iso(row.updatedAt)
 };
}

function plan(row){
 if(!row||typeof row!=='object')throw new InstanceError('invalid_response',MESSAGES.invalid_response);
 const key=text(row.key);
 if(!key)throw new InstanceError('invalid_response',MESSAGES.invalid_response);
 return {
  key,
  name:text(row.name)||key,
  monthlyPence:number(row.monthlyPence),
  currency:text(row.currency)||'GBP',
  includedTokensBillions:number(row.includedTokensBillions),
  description:text(row.description)
 };
}

/**
 * @param {{origin:string, credential:Function, fetch?:Function, development?:boolean}} options
 *   `origin` is the accounts API origin the vendored account client authored; `credential()` is
 *   read per call so a refreshed session needs no rebuild.
 */
class Instances{
 constructor({origin,credential,token,fetch:fetchImpl,development=false,timeout}={}){
  if(!origin)throw Error('An instances client needs the accounts API origin.');
  this.origin=String(origin).replace(/\/+$/,'');
  this.development=!!development;
  // A test may shorten the bound; production never passes one, so the value is the constant.
  this.readTimeout=Number.isFinite(timeout)&&timeout>0?timeout:READ_TIMEOUT_MS;
  this.credential=credential||(()=>token);
  this.fetch=fetchImpl||((url,init)=>fetch(url,init));
 }

 /** One bounded call, with the read/answer rule stated at every caller. */
 async call(path,{method='GET',body,timeout,repeat=false}={}){
  const limit=Number.isFinite(timeout)&&timeout>0?timeout:this.readTimeout;
  const bearer=this.credential();
  if(!bearer)throw new InstanceError('invalid_session',MESSAGES.invalid_session);
  const attempt=async()=>{
   const controller=new AbortController();
   const timer=setTimeout(()=>controller.abort(),limit);
   try{
    const headers={Authorization:'Bearer '+bearer,'Accept':'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    const response=await this.fetch(this.origin+path,{method,headers,
     body:body===undefined?undefined:JSON.stringify(body),signal:controller.signal,redirect:'error',cache:'no-store'});
    const raw=await response.text().catch(()=>'');
    let document=null;try{document=raw?JSON.parse(raw):null;}catch{document=null;}
    if(response.status===204)return null;
    if(response.ok)return document;
    let code=document&&typeof document.error==='string'?document.error:'invalid_response';
    // An unrouted path on the accounts API is API Gateway's own {"message":"Not Found"} with no
    // code. On the LIST that is "this service has not shipped the instance plane yet", which is a
    // capability fact and not a failure to report as one.
    if(!document||typeof document.error!=='string'){
     if(response.status===404)code='instances_unavailable';
     else if(response.status===503)code='database_unavailable';
    }
    const detail=document&&typeof document.message==='string'?document.message:
     document&&typeof document.detail==='string'?document.detail:'';
    throw new InstanceError(code,MESSAGES[code]||detail||FALLBACK,{status:response.status,detail});
   }catch(error){
    if(error instanceof InstanceError)throw error;
    if(error&&(error.name==='AbortError'||error.name==='TimeoutError'))throw new InstanceError('timeout',MESSAGES.timeout);
    throw new InstanceError('unreachable',MESSAGES.unreachable);
   }finally{clearTimeout(timer);}
  };
  if(!repeat)return attempt();
  try{return await attempt();}
  catch(error){
   if(!['unreachable','timeout'].includes(error.code))throw error;
   return attempt();
  }
 }

 /** Every instance this account owns or is a member of, in the service's order. */
 async list(){
  try{
   const document=await this.call(INSTANCES_PATH,{repeat:true});
   const rows=document&&Array.isArray(document.instances)?document.instances:[];
   return {instances:rows.map(instance),count:number(document&&document.count)??rows.length};
  }catch(error){
   // The LIST path has no per-resource 404: a 404 here is this service not routing the plane at
   // all, which is a capability answer rather than a missing instance.
   if(error.status===404)throw new InstanceError('instances_unavailable',MESSAGES.instances_unavailable,{status:404});
   throw error;
  }
 }

 /** The plans the create page may offer, and whether this service sells any at all. */
 async plans(){
  let document;
  try{document=await this.call(PLANS_PATH,{repeat:true});}
  catch(error){
   // An unrouted catalogue is the same fact as an empty one: nothing to sell yet.
   if(error.status===404)return {configured:false,mode:null,plans:[]};
   throw error;
  }
  const rows=document&&Array.isArray(document.plans)?document.plans:[];
  return {
   configured:document&&document.configured===true,
   mode:document&&(document.mode==='test'||document.mode==='production')?document.mode:null,
   plans:rows.map(plan)
  };
 }

 /** Create one. The service derives the instance id, records the plan and returns the Stripe
  *  Checkout URL; the main process opens that URL in the person's own browser. */
 async create({displayName,domain,plan:planKey}={}){
  const name=String(displayName||'').trim();
  const host=String(domain||'').trim().toLowerCase();
  if(!name||name.length>MAX_DISPLAY_NAME)throw new InstanceError('invalid_display_name',MESSAGES.invalid_display_name);
  if(!host||host.length>MAX_DOMAIN)throw new InstanceError('invalid_domain',MESSAGES.invalid_domain);
  // The domain is validated once more by the service; this is the same rule the page's field
  // states so the person is corrected before a round trip.
  try{serverOrigin(originOf(host),{development:this.development});}
  catch{throw new InstanceError('invalid_domain',MESSAGES.invalid_domain);}
  const document=await this.call(INSTANCES_PATH,{method:'POST',timeout:WRITE_TIMEOUT_MS,
   body:{displayName:name,domain:host,plan:String(planKey||'')}});
  return {
   instance:instance(document&&document.instance),
   checkout:document&&document.checkout&&typeof document.checkout.url==='string'?document.checkout.url:null
  };
 }

 /** Rename the display name. Owner only, enforced by the service. */
 async rename(id,displayName){
  const name=String(displayName||'').trim();
  if(!id)throw new InstanceError('not_found',MESSAGES.not_found);
  if(!name||name.length>MAX_DISPLAY_NAME)throw new InstanceError('invalid_display_name',MESSAGES.invalid_display_name);
  const document=await this.call(INSTANCES_PATH+'/'+encodeURIComponent(String(id)),
   {method:'PATCH',body:{displayName:name},timeout:WRITE_TIMEOUT_MS});
  return instance(document&&document.instance);
 }

 /** Delete an owned instance. The plan is cancelled at the end of the paid period, so the
  *  answer carries the deadline rather than claiming the instance is already gone. */
 async remove(id){
  if(!id)throw new InstanceError('not_found',MESSAGES.not_found);
  const document=await this.call(INSTANCES_PATH+'/'+encodeURIComponent(String(id)),
   {method:'DELETE',timeout:WRITE_TIMEOUT_MS});
  if(!document)return {deleted:true,instance:null,deletion:{scheduledFor:null}};
  return {
   deleted:false,
   instance:document.instance?instance(document.instance):null,
   deletion:{scheduledFor:document.deletion?iso(document.deletion.scheduledFor):null}
  };
 }

 /** Leave an instance somebody else owns: this account's membership and the per-instance records
  *  the service holds for it are removed, and the caller removes it from the local list too. */
 async leave(id){
  if(!id)throw new InstanceError('not_found',MESSAGES.not_found);
  await this.call(INSTANCES_PATH+'/'+encodeURIComponent(String(id))+'/members/me',
   {method:'DELETE',timeout:WRITE_TIMEOUT_MS,repeat:true});
  return {ok:true};
 }
}

module.exports={Instances,InstanceError,instance,plan,originOf,MESSAGES,INSTANCES_PATH,PLANS_PATH,
 MAX_DISPLAY_NAME,MAX_DOMAIN,READ_TIMEOUT_MS,WRITE_TIMEOUT_MS};
