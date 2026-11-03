// LIVE END-TO-END: the account's list, an add, and the PIN the SERVER asks for.
//
// NOT part of `npm test`: it needs a real Easter Company account, a real network and a deployed
// accounts API, so it is run deliberately by hand against an account whose password you hold:
//
//   xvfb-run -a node scripts/live-connections.cjs --account /root/.auth/easter-delta.json \
//       --origin https://easter-server.char-istrian.ts.net
//
// One run proves every sentence of Owen's request (2026-11-03): sign-in lands on the account's
// list rather than on the last server; the add view proves an e-server answers at the address and
// stores the row on the account; choosing a row opens that origin; and what the person then sees
// is the INSTANCE's own PIN gate, not anything this client drew. No PIN is entered and no
// credential is printed — the account file is read, used and never echoed.
//
// The client runs as a child with an isolated HOME and CDP on loopback, as scripts/smoke.cjs
// drives the packaged build.
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const argument=name=>{const at=process.argv.indexOf('--'+name);return at>0?process.argv[at+1]:null;};
const ACCOUNT=argument('account')||process.env.EASTER_TEST_ACCOUNT||'/root/.auth/easter-delta.json';
const ORIGIN=argument('origin')||process.env.EASTER_TEST_ORIGIN||'https://easter-server.char-istrian.ts.net';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

if(!fs.existsSync(ACCOUNT)){
 console.log('SKIP: no test account at '+ACCOUNT+' (pass --account <path> holding {"username","password","api_base"})');
 process.exit(0);
}
const account=JSON.parse(fs.readFileSync(ACCOUNT,'utf8'));
const electron=require(path.join(ROOT,'node_modules','electron'));

async function targets(port){
 for(let attempt=0;attempt<240;attempt++){
  try{return await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();}catch{}
  await wait(250);
 }
 throw Error('the debugger never answered');
}
async function attach(target){
 const socket=new WebSocket(target.webSocketDebuggerUrl);
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 let next=0;const pending=new Map();
 socket.onmessage=event=>{const message=JSON.parse(event.data);const promise=pending.get(message.id);
  if(promise){pending.delete(message.id);message.error?promise.reject(Error(message.error.message)):promise.resolve(message.result);}};
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const answer=await rpc('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return answer.exceptionDetails?null:answer.result?.value;};
 return {socket,rpc,evaluate};
}

(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'eapp-live-'));
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
 const child=spawn(electron,['--no-sandbox','--disable-gpu','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port,'.'],{cwd:ROOT,env:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache')},stdio:['ignore','pipe','pipe']});
 let log='';
 child.stdout.on('data',data=>log=(log+data).slice(-8000));
 child.stderr.on('data',data=>log=(log+data).slice(-8000));
 let setup=null,server=null;
 try{
  const list=await targets(port);
  const shell=list.find(target=>target.type==='page'&&target.url.includes('shell.html'));
  assert.ok(shell,'the setup window never opened\n'+log);
  setup=await attach(shell);
  const until=async(description,expression,tries=240)=>{
   for(let attempt=0;attempt<tries;attempt++){const value=await setup.evaluate(expression);if(value)return value;await wait(250);}
   throw Error('timed out waiting for '+description+'\n--- app log ---\n'+log);
  };

  // 1. signed out: the account page, no e-server views
  await until('the sign-in form',`!!document.querySelector('input[name=identifier]')`);
  assert.equal(await setup.evaluate(`document.querySelector('#client-servers').hidden`),true,'the e-server views are not painted before sign-in');
  console.log('signed out: the account page, no e-server views');

  // 2. sign in through the client's own form
  await setup.evaluate(`(()=>{const id=document.querySelector('input[name=identifier]'),pw=document.querySelector('input[name=password]');
   id.value=${JSON.stringify(account.username)};id.dispatchEvent(new Event('input',{bubbles:true}));
   pw.value=${JSON.stringify(account.password)};pw.dispatchEvent(new Event('input',{bubbles:true}));
   pw.closest('form').requestSubmit();return true})()`);

  // 3. the list, read from the live accounts service
  await until('the list after sign-in',`(()=>{const n=document.querySelector('#client-servers');return !!n&&n.hidden===false&&['ready','empty','error'].includes(n.dataset.state)})()`);
  const view=await setup.evaluate(`(()=>{const n=document.querySelector('#client-servers');return {state:n.dataset.state,heading:document.querySelector('#title').textContent,
   rows:[...n.querySelectorAll('.server-row')].map(r=>r.dataset.origin),problem:document.querySelector('#servers-error-text').textContent}})()`);
  assert.notEqual(view.state,'error','the accounts service answered with the list: '+view.problem);
  assert.equal(view.heading,'Your e-servers.');
  console.log('after sign-in:',JSON.stringify(view));

  // 4. add the instance by its address, on the account
  await setup.evaluate(`(()=>{document.querySelector('#server-add').click();return true})()`);
  await until('the add view',`document.querySelector('#add-server-view').hidden===false`);
  await setup.evaluate(`(()=>{const input=document.querySelector('#add-origin');input.value=${JSON.stringify(ORIGIN)};
   input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#add-server').requestSubmit();return true})()`);
  const added=await until('the add to settle',`(()=>{const problem=document.querySelector('#add-problem').textContent;
   const rows=[...document.querySelectorAll('.server-row')].map(row=>row.dataset.origin);
   return problem||(rows.includes(${JSON.stringify(ORIGIN)})?'row':'')})()`);
  assert.equal(added,'row','the address must be added, not refused: '+added);
  console.log('added:',ORIGIN);

  // 5. choose it: the app goes to that origin, and the INSTANCE asks for its PIN
  const clicked=await setup.evaluate(`(()=>{const row=[...document.querySelectorAll('.server-row')].find(r=>r.dataset.origin===${JSON.stringify(ORIGIN)});
   if(!row)return false;row.querySelector('.server-connect').click();return true})()`);
  assert.equal(clicked,true,'the row for '+ORIGIN+' must be on screen to choose');
  let page=null;
  for(let attempt=0;attempt<240;attempt++){
   const now=await targets(port).catch(()=>[]);
   page=now.find(target=>target.type==='page'&&target.url.startsWith(ORIGIN));
   if(page)break;
   await wait(250);
  }
  assert.ok(page,'choosing a row must open the chosen origin\n--- app log ---\n'+log);
  server=await attach(page);
  let title='',asking=false;
  for(let attempt=0;attempt<240;attempt++){
   title=await server.evaluate(`document.title`)||'';
   asking=await server.evaluate(`!!document.querySelector('input[type=password],#pin,input[name=pin]')`)||/unlock|pin/i.test(title);
   if(asking)break;
   await wait(250);
  }
  console.log('the server window:',JSON.stringify(title),'asking for its PIN:',asking);
  assert.equal(new URL(page.url).origin,ORIGIN);
  assert.ok(asking,'the instance must ask for its own PIN after the choice');
  console.log('PASS: the list came from the account, the add proved an e-server and stored the row,');
  console.log('      choosing it opened '+ORIGIN+', and the instance is asking for its PIN.');
 }finally{
  for(const session of [server,setup]){try{await session?.rpc('Browser.close');}catch{}session?.socket?.close();}
  child.kill();
  await wait(400);
  try{fs.rmSync(home,{recursive:true,force:true});}catch{}
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
