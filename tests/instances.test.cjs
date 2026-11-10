'use strict';
// THE ACCOUNT'S INSTANCES: the client's half of the accounts service's instance plane.
//
// desktop/instances.cjs is what the first screen after sign-in is made of. This file exercises
// everything about it that can be proved without Electron: the exact request per verb, the shape
// the renderer reads, the retry policy (a read and a leave may be repeated, a create/rename/delete
// may not), the code carried out of every refusal, and the two answers that mean "this service
// has not shipped the plane yet" rather than "you did something wrong".
const test=require('node:test'),assert=require('node:assert/strict');
const {Instances,InstanceError,instance,plan,originOf,MESSAGES,MAX_DISPLAY_NAME}=require('../desktop/instances.cjs');

const ORIGIN='https://accounts.example.test';
const TOKEN='tok_test_secret_value';
const ROW={
 id:'cy',displayName:'Cy',domain:'cy.instance.easter.company',origin:'https://cy.instance.easter.company',
 role:'owner',state:'active',createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z',
 plan:{key:'family',name:'Family',includedTokensBillions:0},
 billing:{status:'active',cancelAtPeriodEnd:false,currentPeriodEnd:'2026-12-01T00:00:00Z'},
 deletion:{scheduledFor:null}
};

function transport(answers){
 const calls=[];
 const fetch=async(url,init={})=>{
  calls.push({url:String(url),method:init.method||'GET',headers:init.headers||{},body:init.body?JSON.parse(init.body):undefined});
  const next=answers.shift();
  if(next===undefined)throw Error('unexpected request '+url);
  if(next instanceof Error)throw next;
  const status=next.status===undefined?200:next.status;
  return {status,ok:status>=200&&status<300,text:async()=>JSON.stringify(next.body===undefined?null:next.body)};
 };
 return {fetch,calls};
}
function client(answers,options={}){
 const spy=transport(answers);
 const instances=new Instances({origin:ORIGIN,token:TOKEN,fetch:spy.fetch,...options});
 return {instances,calls:spy.calls};
}

test('the token leaves as one Bearer header and never comes back in the answer',async()=>{
 const {instances}=client([{body:{instances:[ROW],count:1}}]);
 const answer=await instances.list();
 assert.equal(JSON.stringify(answer).includes(TOKEN),false);
});

test('the list is read from the account route, in the shape the menu renders',async()=>{
 const {instances,calls}=client([{body:{instances:[ROW],count:1}}]);
 const answer=await instances.list();
 assert.equal(calls[0].url,ORIGIN+'/v2/accounts/instances');
 assert.equal(calls[0].method,'GET');
 assert.equal(calls[0].headers.Authorization,'Bearer '+TOKEN);
 assert.deepEqual(answer.instances[0],{
  id:'cy',displayName:'Cy',domain:'cy.instance.easter.company',origin:'https://cy.instance.easter.company',
  role:'owner',owned:true,state:'active',
  plan:{key:'family',name:'Family',includedTokensBillions:0},
  billing:{status:'active',cancelAtPeriodEnd:false,currentPeriodEnd:'2026-12-01T00:00:00Z'},
  deletion:{scheduledFor:null},createdAt:'2026-11-01T00:00:00Z',updatedAt:'2026-11-01T00:00:00Z'
 });
});

test('a member is not an owner, and a row with no plan or billing says so with nulls',async()=>{
 const {instances}=client([{body:{instances:[{...ROW,role:'member',plan:null,billing:null,deletion:null}]}}]);
 const {instances:[row]}=await instances.list();
 assert.equal(row.owned,false);
 assert.equal(row.role,'member');
 assert.equal(row.plan,null);
 assert.deepEqual(row.billing,{status:'none',cancelAtPeriodEnd:false,currentPeriodEnd:null});
 assert.deepEqual(row.deletion,{scheduledFor:null});
});

test('an unrouted list is a capability answer, not a failure sentence',async()=>{
 const {instances}=client([{status:404,body:{message:'Not Found'}}]);
 await assert.rejects(()=>instances.list(),error=>{
  assert.equal(error.code,'instances_unavailable');
  assert.equal(error.message,MESSAGES.instances_unavailable);
  return true;
 });
});

test('an unrouted plan catalogue is an empty catalogue, not a broken page',async()=>{
 const {instances}=client([{status:404,body:{message:'Not Found'}}]);
 assert.deepEqual(await instances.plans(),{configured:false,mode:null,plans:[]});
});

test('the plan list is formatted from the service, key and all',async()=>{
 const {instances,calls}=client([{body:{configured:true,mode:'test',plans:[
  {key:'family',name:'Family',monthlyPence:1299,currency:'GBP',includedTokensBillions:0,description:'Metered'}
 ]}}]);
 const answer=await instances.plans();
 assert.equal(calls[0].url,ORIGIN+'/v2/accounts/instance-plans');
 assert.equal(answer.mode,'test');
 assert.equal(answer.plans[0].key,'family');
 assert.equal(answer.plans[0].monthlyPence,1299);
});

test('create names a display name, a domain and a plan, and answers the Checkout URL',async()=>{
 const {instances,calls}=client([{status:201,body:{instance:ROW,checkout:{url:'https://checkout.stripe.com/c/pay/cs_test_1',sessionId:'cs_test_1'}}}]);
 const answer=await instances.create({displayName:'  Cy  ',domain:' CY.Instance.Easter.Company ',plan:'family'});
 assert.equal(calls[0].url,ORIGIN+'/v2/accounts/instances');
 assert.equal(calls[0].method,'POST');
 assert.deepEqual(calls[0].body,{displayName:'Cy',domain:'cy.instance.easter.company',plan:'family'});
 assert.equal(answer.checkout,'https://checkout.stripe.com/c/pay/cs_test_1');
 assert.equal(answer.instance.id,'cy');
});

test('create checks the fields before a round trip, and never invents a domain',async()=>{
 const {instances,calls}=client([]);
 await assert.rejects(()=>instances.create({displayName:'',domain:'cy.example',plan:'family'}),e=>e.code==='invalid_display_name');
 await assert.rejects(()=>instances.create({displayName:'x'.repeat(MAX_DISPLAY_NAME+1),domain:'cy.example',plan:'family'}),e=>e.code==='invalid_display_name');
 await assert.rejects(()=>instances.create({displayName:'Cy',domain:'',plan:'family'}),e=>e.code==='invalid_domain');
 assert.equal(calls.length,0);
 assert.equal(originOf('Cy.Example.Test'),'https://cy.example.test');
});

test('a refusal code and the service sentence travel out unchanged',async()=>{
 const {instances}=client([{status:409,body:{error:'domain_taken',message:'That domain is already in use by another instance.'}}]);
 await assert.rejects(()=>instances.create({displayName:'Cy',domain:'cy.example',plan:'family'}),error=>{
  assert.equal(error.code,'domain_taken');
  assert.equal(error.status,409);
  assert.equal(error.message,MESSAGES.domain_taken);
  return true;
 });
});

test('rename sends one display name to one instance',async()=>{
 const {instances,calls}=client([{body:{instance:{...ROW,displayName:'Cyan'}}}]);
 const answer=await instances.rename('cy',' Cyan ');
 assert.equal(calls[0].url,ORIGIN+'/v2/accounts/instances/cy');
 assert.equal(calls[0].method,'PATCH');
 assert.deepEqual(calls[0].body,{displayName:'Cyan'});
 assert.equal(answer.displayName,'Cyan');
});

test('delete answers the deadline rather than claiming the instance is gone',async()=>{
 const {instances,calls}=client([{body:{instance:{...ROW,billing:{...ROW.billing,status:'canceling',cancelAtPeriodEnd:true}},
  deletion:{scheduledFor:'2026-12-01T00:00:00Z'}}}]);
 const answer=await instances.remove('cy');
 assert.equal(calls[0].method,'DELETE');
 assert.equal(answer.deleted,false);
 assert.equal(answer.deletion.scheduledFor,'2026-12-01T00:00:00Z');
});

test('delete with no plan is gone now, and says so',async()=>{
 const {instances}=client([{status:204}]);
 assert.deepEqual(await instances.remove('cy'),{deleted:true,instance:null,deletion:{scheduledFor:null}});
});

test('leave is a repeatable DELETE of the caller own membership',async()=>{
 const {instances,calls}=client([{status:204}]);
 const answer=await instances.leave('cy');
 assert.equal(answer.ok,true);
 assert.equal(calls[0].url,ORIGIN+'/v2/accounts/instances/cy/members/me');
 assert.equal(calls[0].method,'DELETE');
});

test('the owner cannot leave, and the service sentence is what the page prints',async()=>{
 const {instances}=client([{status:403,body:{error:'owner_cannot_leave',message:'You own this instance, so you delete it rather than leave it.'}}]);
 await assert.rejects(()=>instances.leave('cy'),error=>{
  assert.equal(error.code,'owner_cannot_leave');
  assert.equal(error.message,MESSAGES.owner_cannot_leave);
  return true;
 });
});

test('a read is repeated once when the transport failed, and an answer never is',async()=>{
 const flaky=client([Error('socket hang up'),{body:{instances:[ROW],count:1}}]);
 assert.equal((await flaky.instances.list()).instances.length,1);
 assert.equal(flaky.calls.length,2);

 const refused=client([{status:409,body:{error:'deletion_already_scheduled',message:'Already scheduled.'}},{body:{}}]);
 await assert.rejects(()=>refused.instances.remove('cy'),e=>e.code==='deletion_already_scheduled');
 assert.equal(refused.calls.length,1);
});

test('no session is refused without a request, and every call is bounded',async()=>{
 const bare=new Instances({origin:ORIGIN,credential:()=>'',fetch:async()=>{throw Error('should not be called');}});
 await assert.rejects(()=>bare.list(),e=>e.code==='invalid_session');

 const hung=new Instances({origin:ORIGIN,token:TOKEN,timeout:25,
  fetch:(url,init)=>new Promise((resolve,reject)=>{
   init.signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})));
  })});
 const started=Date.now();
 await assert.rejects(()=>hung.list(),e=>e.code==='timeout');
 assert.ok(Date.now()-started<2000);
});

test('a missing or unreadable row is a refusal, never a half-drawn screen',()=>{
 assert.throws(()=>instance(null),e=>e.code==='invalid_response');
 assert.throws(()=>instance({domain:'x.example'}),e=>e.code==='invalid_response');
 assert.throws(()=>plan(null),e=>e.code==='invalid_response');
 assert.equal(instance({id:'x',domain:'x.example'}).displayName,'x');
});

test('an instance that predates domains still renders, without an address it does not have',()=>{
 // The account service's own registration predates the domain field and publishes domain:null
 // rather than an invented host. The menu must draw the row (and its owner actions) and must
 // not pretend there is a place to connect to.
 const legacy=instance({id:'easter-server',displayName:'Easter-Server',domain:null,origin:null,role:'owner'});
 assert.equal(legacy.displayName,'Easter-Server');
 assert.equal(legacy.domain,'');
 assert.equal(legacy.origin,'');
 assert.equal(legacy.owned,true);
 // A row whose origin survived but whose domain did not still gets its domain from the origin.
 const fromOrigin=instance({id:'old',origin:'https://Old.Example.Test',role:'member'});
 assert.equal(fromOrigin.domain,'old.example.test');
 assert.equal(fromOrigin.origin,'https://Old.Example.Test');
});
