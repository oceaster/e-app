// Exercise the actual packaged executable through Chromium's loopback-only CDP.
// This is a disposable CI profile, never a person's existing app data or browser.
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net'),{spawn}=require('node:child_process'),assert=require('node:assert/strict');
(async()=>{
 const executable=path.resolve(process.argv[2]),home=await fs.mkdtemp(path.join(os.tmpdir(),'eserver-smoke-'));
 const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
 const child=spawn(executable,['--no-sandbox','--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{env:{...process.env,HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_CACHE_HOME:path.join(home,'cache'),APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local')},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',data=>log=(log+data).slice(-16000));child.stderr.on('data',data=>log=(log+data).slice(-16000));
 let socket;
 try{
  let target;
  for(let i=0;i<240;i++){
   if(child.exitCode!==null)throw Error('Packaged client exited: '+log);
   try{const targets=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();target=targets.find(t=>t.type==='page'&&t.url.includes('shell.html'));if(target)break;}catch{}
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(target,'Packaged first screen did not open: '+log);
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let next=0;const pending=new Map();socket.onmessage=event=>{const data=JSON.parse(event.data);const promise=pending.get(data.id);if(promise){pending.delete(data.id);data.error?promise.reject(Error(data.error.message)):promise.resolve(data.result);}};
  socket.onclose=()=>{for(const promise of pending.values())promise.reject(Error('The client closed its debugging session.'));pending.clear();};
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  let result;
  for(let i=0;i<60;i++){
   result=await rpc('Runtime.evaluate',{expression:'({title:document.title,heading:document.querySelector("h1")?.textContent,servers:!!document.querySelector("#client-servers"),serversHidden:document.querySelector("#client-servers")?.hidden===true,signin:!!document.querySelector("input[name=identifier]"),bridge:!!window.eServerSetup,node:typeof require,process:typeof process})',returnByValue:true});
   if(result.result?.value?.bridge&&result.result.value.signin)break;
   await new Promise(resolve=>setTimeout(resolve,250));
  }
  const view=result.result.value;assert.equal(view.title,'e-server');
  // The signed-out first screen is the account page. The e-server views exist in the document
  // and are HIDDEN until there is an account to list servers for - a shipped build that dropped
  // them, or one that painted them over the sign-in rows, fails here.
  assert.equal(view.servers,true,'the packaged shell carries the e-server views');
  assert.equal(view.serversHidden,true,'and does not paint them before sign-in');
  assert.equal(view.signin,true);assert.equal(view.bridge,true);assert.equal(view.node,'undefined');assert.equal(view.process,'undefined');
  const screenshot=await rpc('Page.captureScreenshot',{format:'png'});await fs.mkdir('release',{recursive:true});await fs.writeFile('release/packaged-first-screen-'+process.platform+'.png',Buffer.from(screenshot.data,'base64'));
  console.log('Packaged e-server first screen verified:',JSON.stringify(view));
  await rpc('Browser.close').catch(()=>{});
 }finally{socket?.close();child.kill();await fs.rm(home,{recursive:true,force:true}).catch(()=>{});}
})().catch(error=>{console.error(error);process.exitCode=1;});
