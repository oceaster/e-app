'use strict';
// The client half of the one-sign-in contract, driven against a REAL local HTTP server rather
// than a fake that agrees with its own caller: the request the main process sends, the answer
// it resolves for every shape the deployed server returns, and the order of a sign-out.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const bridge=require('../desktop/bridge.cjs');

// One request-recording server, exactly as the wire sees it: method, path, headers, body.
function serve(handle){
 const seen=[];
 const server=http.createServer((request,response)=>{
  let body='';request.on('data',chunk=>body+=chunk);
  request.on('end',()=>{seen.push({method:request.method,url:request.url,headers:request.headers,body});handle(request,response,body);});
 });
 return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve({
  origin:'http://127.0.0.1:'+server.address().port,seen,server,
  close:()=>new Promise(done=>{server.closeAllConnections?.();server.close(done);}),
 })));
}
const json=(status,document)=>(request,response)=>{
 response.writeHead(status,{'Content-Type':'application/json'});
 response.end(JSON.stringify(document));
};
// Node's fetch cannot read an opaque-redirect body, so these stubs stand in for the two shapes
// a redirecting server produces in an Electron session fetch: a manual 3xx, and an opaque one.
const redirecting=(status=302)=>({status,type:'basic',headers:new Map([['location','/elsewhere']]),text:async()=>''});
const opaque=()=>({status:0,type:'opaqueredirect',text:async()=>{throw Error('An opaque body cannot be read.');}});

test('bindSession sends the exact handoff request and resolves only the destination',async()=>{
 const server=await serve(json(200,{ok:true,next:'/home',profile:{username:'oceaster'}}));
 try{
  const answer=await bridge.bindSession({origin:server.origin,token:'COMPANY-TOKEN-123',next:'/profile'});
  assert.deepEqual(answer,{ok:true,next:'/home'});
  assert.equal(server.seen.length,1);
  const [request]=server.seen;
  assert.equal(request.method,'POST');
  assert.equal(request.url,'/desktop/auth/company');
  assert.equal(request.headers.authorization,'Bearer COMPANY-TOKEN-123');
  assert.equal(request.headers['content-type'],'application/json');
  assert.equal(request.headers['x-easter-desktop'],'e-server/1');
  assert.equal(request.headers['x-easter-desktop-request'],'1');
  assert.equal(request.body,'{"next":"/profile"}');
  // The token crossed to the server and to nothing else: not the answer, not the address.
  assert(!JSON.stringify(answer).includes('COMPANY-TOKEN-123'));
  assert(!request.url.includes('COMPANY-TOKEN-123'));
  // The account document the server also returned is not handed to the renderer.
  assert.equal(answer.profile,undefined);
 }finally{await server.close();}
});

test('every refusal the deployed server names resolves as its code, never as a rejection',async()=>{
 const refusals=[[401,'company_sign_in_required'],[403,'account_incomplete'],[409,'bound'],
                 [429,'rate_limited'],[503,'unavailable'],[413,'too_large'],[400,'invalid_request']];
 for(const [status,code] of refusals){
  const server=await serve(json(status,{ok:false,error:code,detail:'A sentence from the server.'}));
  try{
   const answer=await bridge.bindSession({origin:server.origin,token:'COMPANY-TOKEN-123',next:'/'});
   assert.equal(answer.ok,false,code);
   assert.equal(answer.error,code);
   assert.equal(answer.status,status);
   assert.equal(answer.detail,'A sentence from the server.');
  }finally{await server.close();}
 }
});

test('a refusal code the status alone does not determine is taken from the body',async()=>{
 const server=await serve(json(403,{ok:false,error:'refused',detail:'Not a household account.'}));
 try{
  assert.equal((await bridge.bindSession({origin:server.origin,token:'T',next:'/'})).error,'refused');
 }finally{await server.close();}
});

test('no redirect is followed and no redirect target is read',async()=>{
 const cases=[redirecting(302),redirecting(303),redirecting(307),opaque()];
 for(const response of cases){
  const seen=[];
  const answer=await bridge.bindSession({origin:'https://server.example',token:'COMPANY-TOKEN-123',next:'/',
   send:async(url,init)=>{seen.push({url,redirect:init.redirect,method:init.method});return response;}});
  assert.equal(seen.length,1);
  assert.equal(seen[0].redirect,'manual');
  assert.equal(answer.ok,false);
  assert.equal(answer.error,'unavailable');
  assert(!JSON.stringify(answer).includes('COMPANY-TOKEN-123'));
 }
});

test('a hung server is bounded, and a failed call names itself instead of throwing',async()=>{
 const hung=await serve(()=>{});
 try{
  const started=Date.now();
  const answer=await bridge.bindSession({origin:hung.origin,token:'T',next:'/',timeout:150});
  assert.equal(answer.ok,false);
  assert.equal(answer.error,'timeout');
  assert(Date.now()-started<5000);
 }finally{await hung.close();}
 const refused=await bridge.bindSession({origin:'http://127.0.0.1:1',token:'T',next:'/',timeout:500});
 assert.equal(refused.ok,false);
 assert.equal(refused.error,'unavailable');
});

test('signOut reports to /profiles/logout with the ended header and no credential',async()=>{
 const server=await serve(json(200,{ok:true,instance:'ended',global:'ended'}));
 try{
  assert.deepEqual(await bridge.report({origin:server.origin}),{ok:true,instance:'ended',global:'ended'});
  const [request]=server.seen;
  assert.equal(request.method,'POST');
  assert.equal(request.url,'/profiles/logout');
  assert.equal(request.headers['x-easter-desktop'],'e-server/1');
  assert.equal(request.headers['x-easter-desktop-global-signout'],'ended');
  assert.equal(request.headers.authorization,undefined);
  assert.equal(request.body,'');
 }finally{await server.close();}
});

test('a sign-out the server did not confirm is never reported as the global session ending',async()=>{
 // Every shape that is not "ok:true, global:ended": the client's half ended, the server's did not.
 for(const [status,document] of [[500,{}],[200,{ok:false}],[200,{ok:true,instance:'ended',global:'app'}],
                                 [200,{ok:true,instance:'ended',global:'none'}],[302,{}]]){
  const server=await serve(json(status,document));
  try{
   assert.deepEqual(await bridge.report({origin:server.origin}),{ok:true,instance:'ended',global:'not_ended'},
    status+' '+JSON.stringify(document));
  }finally{await server.close();}
 }
 const unreachable=await bridge.report({origin:'http://127.0.0.1:1',timeout:500});
 assert.deepEqual(unreachable,{ok:true,instance:'ended',global:'not_ended'});
});

test('signOut ends the client own session BEFORE it reports, and both through one path',async()=>{
 const order=[];
 const answer=await bridge.endSession({
  origin:'https://server.example',
  endOwn:async()=>{order.push('own-session-ended');},
  send:async(url,init)=>{order.push('report:'+url+':'+init.headers['X-Easter-Desktop-Global-Signout']);
   return {status:200,type:'basic',text:async()=>JSON.stringify({ok:true,instance:'ended',global:'ended'})};},
 });
 assert.deepEqual(order,['own-session-ended','report:https://server.example/profiles/logout:ended']);
 assert.deepEqual(answer,{ok:true,instance:'ended',global:'ended'});
});

test('a client half that could not end is not reported to the server at all',async()=>{
 let reported=false;
 const answer=await bridge.endSession({origin:'https://server.example',
  endOwn:async()=>{throw Error('The keyring refused.');},send:async()=>{reported=true;}});
 assert.equal(reported,false);
 assert.equal(answer.ok,false);
 assert.equal(answer.instance,'not_ended');
 assert.equal(answer.global,'not_ended');
});

test('the bridge hands a renderer no token, and the server page',async()=>{
 // Static, because these are the two files a renderer can reach: preload.cjs crosses
 // contextBridge, and main.cjs is the only thing that holds the Company session. A token in
 // either exposed surface would be a leak no runtime assertion could take back.
 const preload=fs.readFileSync(path.join(__dirname,'..','desktop','preload.cjs'),'utf8');
 assert.doesNotMatch(preload,/token/i);
 assert.doesNotMatch(preload,/bearer/i);
 assert.doesNotMatch(preload,/authorization/i);
 assert.doesNotMatch(preload,/company_sign_in_required|credential/i);
 // The server-window bridge is the second exposeInMainWorld block, and it is the one the page
 // calls: both actions are there, take a destination and nothing else, and return a promise.
 const server=preload.slice(preload.indexOf("exposeInMainWorld('eServerClient'"));
 assert.match(server,/bindSession:next=>ipcRenderer\.invoke\('client:handoff',next\)/);
 assert.match(server,/signOut:\(\)=>ipcRenderer\.invoke\('client:signout'\)/);
 assert.doesNotMatch(server,/company:signout/);
 // Both main-process handlers sit behind a guard, and that guard is the connected server's
 // own origin: the chrome is a file:// document framing the instance, so the handoff is called
 // FROM the framed page and `serverFrame` is the gate that admits exactly that frame. `remote`
 // (main-frame only) is still the gate for device/media/build controls; neither handler can
 // answer a request from any other origin.
 const main=fs.readFileSync(path.join(__dirname,'..','desktop','main.cjs'),'utf8');
 assert.match(main,/ipcMain\.handle\('client:handoff',\(event,next\)=>\{serverFrame\(event\);return bindCompanySession\(next\);\}\)/);
 assert.match(main,/ipcMain\.handle\('client:signout',event=>\{serverFrame\(event\);return endCompanySession\(\);\}\)/);
 // `serverFrame` really is the origin gate, not a pass: it requires a Company session, the
 // connected window's own webContents, and the sending frame's origin equal to the server.
 const guard=main.slice(main.indexOf('function serverFrame(event)'),main.indexOf('function serverFrame(event)')+900);
 assert.match(guard,/company\?\.require\(\)/);
 assert.match(guard,/event\.sender!==win\.webContents/);
 assert.match(guard,/from!==config\.server/);
 // The token has exactly one door out of the main process, and it is the bridge's Bearer header.
 const exits=main.match(/credential\(\)/g)||[];
 assert.equal(exits.length,1);
});
