'use strict';
// THE ACCOUNT-SCOPED E-SERVER LIST: what this app sends, what it does with every answer.
//
// desktop/connections.cjs is the client's half of the accounts service's /v2/accounts/connections
// API and holds everything about it that can be exercised without Electron: the exact request per
// verb, the origin normalization, the retry policy (a read and a delete may be repeated, a write
// may not), the code carried out of every refusal, and the rule that the Company token leaves only
// as one Authorization header and never comes back in an answer.
//
// The service's own gates live in the cloud repository (tests/test_connections_dynamo.py). This
// file is the other author of the same contract, so it pins the numbers the service owns (the 50
// row bound, the 60 character label) and fails if this side drifts from them.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {Connections,ConnectionError,host,defaultLabel,MESSAGES,MAX_CONNECTIONS,MAX_LABEL}=require('../desktop/connections.cjs');

const ORIGIN='https://accounts.example.test';
const TOKEN='tok_test_secret_value';
const ROW={id:'c0123456789abcdef',origin:'https://home.example.test',label:'Home',added_at:'2026-11-03T00:00:00Z',last_used_at:null};

/**
 * A fetch stand-in that answers each call in order and records the request it was given. An
 * `Error` in the queue is thrown (a transport failure); anything else is answered as written.
 */
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
 const connections=new Connections({origin:ORIGIN,token:TOKEN,fetch:spy.fetch,...options});
 return {connections,calls:spy.calls};
}

test('the origin is normalized, so the list cannot hold two spellings of one server', async()=>{
 const {connections,calls}=client([{status:201,body:{connection:ROW}}]);
 await connections.add({origin:' https://home.example.test/ ',label:'Home'});
 assert.equal(calls[0].body.origin,'https://home.example.test');
 assert.equal(calls[0].method,'POST');
 assert.equal(calls[0].url,ORIGIN+'/v2/accounts/connections');
});

test('a row without a name is named after its host, never left anonymous', async()=>{
 const {connections,calls}=client([{status:201,body:{connection:ROW}}]);
 await connections.add({origin:'https://easter-server.example.net'});
 assert.equal(calls[0].body.label,'easter-server.example.net');
 assert.equal(defaultLabel('https://easter-server.example.net:8443'),'easter-server.example.net:8443');
 assert.equal(host('https://easter-server.example.net:8443'),'easter-server.example.net:8443');
});

test('a name is trimmed and bounded, and a blank name falls back to the host', async()=>{
 const {connections,calls}=client([{status:201,body:{connection:ROW}},{status:201,body:{connection:ROW}}]);
 await connections.add({origin:'https://home.example.test',label:'  The house  '});
 await connections.add({origin:'https://home.example.test',label:'   '});
 assert.equal(calls[0].body.label,'The house');
 assert.equal(calls[1].body.label,'home.example.test');
 assert.equal(MAX_LABEL,60);
 assert.equal(MAX_CONNECTIONS,50);
});

test('an address that is not an https origin is refused before anything is sent', async()=>{
 const {connections,calls}=client([]);
 for(const value of ['home.example.test','http://home.example.test','https://home.example.test/path','https://user:pw@home.example.test']){
  await assert.rejects(connections.add({origin:value}),error=>{
   assert.ok(!(error instanceof ConnectionError),'this is the address rule, not a service answer');
   // security.cjs's own sentences: "must use HTTPS" for a scheme, "without a path, password or
   // query" for a shape. Both are the app's rule and neither is a service answer.
   assert.match(error.message,/address|origin/i);
   return true;
  });
 }
 assert.equal(calls.length,0,'nothing may be sent for an address the app already knows is wrong');
});

test('a loopback http fixture is only allowed to a development checkout', async()=>{
 const dev=client([{status:201,body:{connection:{...ROW,origin:'http://127.0.0.1:9443'}}}],{development:true});
 await dev.connections.add({origin:'http://127.0.0.1:9443'});
 assert.equal(dev.calls[0].body.origin,'http://127.0.0.1:9443');
 const packaged=client([]);
 await assert.rejects(packaged.connections.add({origin:'http://127.0.0.1:9443'}),/address/i);
});

test('the list reads the service order and carries the service bound', async()=>{
 const {connections,calls}=client([{status:200,body:{connections:[ROW,{...ROW,id:'c2',origin:'https://work.example.test',label:'Work'}],limit:50}}]);
 const answer=await connections.list();
 assert.equal(calls[0].method,'GET');
 assert.equal(calls[0].headers.Authorization,'Bearer '+TOKEN);
 assert.deepEqual(answer.connections.map(row=>row.label),['Home','Work']);
 assert.equal(answer.limit,50);
 assert.equal(answer.connections[0].addedAt,'2026-11-03T00:00:00Z');
 assert.equal(answer.connections[0].lastUsedAt,null);
});

test('a read that never reached an answer is asked once more; an answer is never repeated', async()=>{
 let {connections,calls}=client([Error('connection reset'),{status:200,body:{connections:[],limit:50}}]);
 assert.deepEqual((await connections.list()).connections,[]);
 assert.equal(calls.length,2,'a read may be asked again');

 ({connections,calls}=client([{status:401,body:{error:'invalid_session',message:'that session has ended'}}]));
 await assert.rejects(connections.list(),error=>{
  assert.equal(error.code,'invalid_session');
  assert.equal(error.status,401);
  assert.equal(error.detail,'that session has ended','the service sentence is kept, not paraphrased');
  return true;
 });
 assert.equal(calls.length,1,'401 is an answer, not a failure');
});

test('a write that never reached an answer is reported, not repeated', async()=>{
 const {connections,calls}=client([Error('socket hang up')]);
 await assert.rejects(connections.add({origin:'https://home.example.test'}),error=>{
  assert.equal(error.code,'unreachable');
  return true;
 });
 assert.equal(calls.length,1,'a POST may have committed; a silent second one could duplicate it');
});

test('every refusal keeps the service code and carries a sentence a person can act on', async()=>{
 const cases=[
  ['connection_exists',409,MESSAGES.connection_exists],
  ['connections_limit',409,MESSAGES.connections_limit],
  ['invalid_origin',422,MESSAGES.invalid_origin],
  ['rate_limited',429,MESSAGES.rate_limited],
  ['database_unavailable',503,MESSAGES.database_unavailable],
 ];
 for(const [code,status,sentence] of cases){
  const {connections}=client([{status,body:{error:code,message:'service sentence'}}]);
  await assert.rejects(connections.add({origin:'https://home.example.test'}),error=>{
   assert.equal(error.code,code);
   assert.equal(error.message,sentence);
   assert.equal(error.detail,'service sentence');
   return true;
  });
 }
});

test('an unnamed refusal still says something a person can read', async()=>{
 const {connections}=client([{status:500,body:{message:'something burnt'}}]);
 await assert.rejects(connections.add({origin:'https://home.example.test'}),error=>{
  assert.equal(error.code,'invalid_response');
  assert.equal(error.detail,'something burnt');
  return true;
 });
});

test('removing is idempotent: a row that is already gone is the outcome that was asked for', async()=>{
 const already=client([{status:404,body:{error:'connection_not_found',message:'gone'}}]);
 assert.deepEqual(await already.connections.remove('c0123456789abcdef'),{ok:true,already:true});
 assert.equal(already.calls[0].method,'DELETE');

 const repeated=client([Error('connection reset'),{status:204}]);
 assert.deepEqual(await repeated.connections.remove('c0123456789abcdef'),{ok:true});
 assert.equal(repeated.calls.length,2,'a delete may be asked again: the route is idempotent');
});

test('an empty delete is refused locally rather than sent as a request for nothing', async()=>{
 const {connections,calls}=client([]);
 await assert.rejects(connections.remove(''),error=>error.code==='connection_not_found');
 assert.equal(calls.length,0);
});

test('recording that a server was used never blocks the connection', async()=>{
 const {connections}=client([Error('offline')]);
 assert.deepEqual(await connections.touch('c0123456789abcdef'),{ok:false,error:'unreachable'});
 const ok=client([{status:200,body:{connection:ROW}}]);
 assert.deepEqual(await ok.connections.touch('c0123456789abcdef'),{ok:true});
 assert.equal(ok.calls[0].body.touch,true);
});

test('with no session nothing is sent at all', async()=>{
 const spy=transport([]);
 const connections=new Connections({origin:ORIGIN,token:'',fetch:spy.fetch});
 await assert.rejects(connections.list(),error=>error.code==='invalid_session');
 assert.equal(spy.calls.length,0);
});

test('a refreshed session is used without rebuilding the client', async()=>{
 let token='first';
 const spy=transport([{status:200,body:{connections:[],limit:50}},{status:200,body:{connections:[],limit:50}}]);
 const connections=new Connections({origin:ORIGIN,credential:()=>token,fetch:spy.fetch});
 await connections.list();
 token='second';
 await connections.list();
 assert.deepEqual(spy.calls.map(call=>call.headers.Authorization),['Bearer first','Bearer second']);
});

test('the Company token leaves as one header and comes back in nothing', async()=>{
 const {connections}=client([{status:200,body:{connections:[ROW],limit:50}}]);
 const answer=await connections.list();
 assert.ok(!JSON.stringify(answer).includes(TOKEN),'no answer may echo the credential');
});

test('the API origin has exactly one author in this tree, and it is the vendored client', ()=>{
 // A second copy of the accounts API address is a second place to change when it moves. The
 // vendored account client owns it (API_ORIGIN) and main.cjs passes it in.
 const root=path.resolve(__dirname,'..','desktop');
 const offenders=[];
 const walk=directory=>{
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
   const file=path.join(directory,entry.name);
   if(entry.isDirectory()){if(entry.name!=='vendor')walk(file);continue;}
   if(!/\.(cjs|mjs|js)$/.test(entry.name))continue;
   if(fs.readFileSync(file,'utf8').includes('execute-api'))offenders.push(path.relative(root,file));
  }
 };
 walk(root);
 assert.deepEqual(offenders,[],'only the vendored account client may name the API origin');
});
