'use strict';
// THE ACCOUNT'S THEME: what this app reads, how it caches it, and the one resolution rule.
//
// desktop/theme.cjs is the client's half of the accounts service's `GET /v2/accounts/settings`,
// and this file is the second author of that contract. It exists because the wire shape has
// already cost one defect: on 2026-11-04 the service nested the document in `settings` while the
// panel read a flat body, so every save repainted `system` over the account's real choice and
// every test stayed green. The first case below is that defect, written as a failing shape:
// a flat body must be refused, not silently read as "no theme".
//
// It also pins the two things a person notices: `light`/`dark` are ABSOLUTE (the account's word
// beats the machine's) and `system` is the machine's, resolved on every ask; and the cache is a
// 0600 file in the app's own config directory, because the next launch's first painted frame is
// read out of it before anything else can answer.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {AccountTheme,ThemeError,normalise,resolve,readCache,writeCache,ACCOUNT_SETTINGS_PATH,READ_TIMEOUT_MS}=require('../desktop/theme.cjs');

const ORIGIN='https://accounts.example.test';
const TOKEN='tok_test_secret_value';

/** The service's answer, in the shape its own routes write: nested, with a revision. */
const nested=(theme,extra={})=>({settings:{version:1,language:'auto',theme,...extra},revision:3,updatedAt:'2026-11-04T00:00:00Z'});

function transport(answers){
 const calls=[];
 const fetch=async(url,init={})=>{
  calls.push({url:String(url),method:init.method||'GET',headers:init.headers||{}});
  const next=answers.shift();
  if(next===undefined)throw Error('unexpected request '+url);
  if(next instanceof Error)throw next;
  const status=next.status===undefined?200:next.status;
  return {status,ok:status>=200&&status<300,text:async()=>JSON.stringify(next.body===undefined?null:next.body)};
 };
 return {fetch,calls};
}
function reader(answers,options={}){
 const spy=transport(answers);
 const theme=new AccountTheme({origin:ORIGIN,credential:()=>TOKEN,fetch:spy.fetch,...options});
 return {theme,calls:spy.calls};
}

test('the preference is read out of the NESTED document, one Bearer GET, no query',async()=>{
 const {theme,calls}=reader([{body:nested('dark')}]);
 const answer=await theme.read();
 assert.deepEqual(answer,{preference:'dark',revision:3});
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,ORIGIN+ACCOUNT_SETTINGS_PATH);
 assert.equal(ACCOUNT_SETTINGS_PATH,'/v2/accounts/settings');
 assert.equal(calls[0].method,'GET');
 assert.equal(calls[0].headers.Authorization,'Bearer '+TOKEN);
});

test('a FLAT document is refused, never read as "no theme"',async()=>{
 // The 2026-11-04 defect: the panel read `document.theme` off a nested body. A service answering
 // the flat shape is a client reading the wrong contract, and guessing `system` from it would
 // paint the OS answer over the account's real choice - the very defect this ticket fixes.
 const {theme}=reader([{body:{version:1,language:'auto',theme:'dark'}}]);
 await assert.rejects(()=>theme.read(),error=>error instanceof ThemeError&&error.code==='invalid_response');
});

test('a theme this client does not know falls back to system, and the known three survive',async()=>{
 for(const value of ['light','dark','system']){
  const {theme}=reader([{body:nested(value)}]);
  assert.equal((await theme.read()).preference,value);
 }
 const {theme}=reader([{body:nested('solarized')}]);
 assert.equal((await theme.read()).preference,'system','an unknown value is not a palette this client can paint');
 assert.deepEqual(['light','dark','system'].map(normalise),['light','dark','system']);
 assert.equal(normalise('rebeccapurple'),null);
});

test('light and dark are absolute; system is the machine, on every ask',()=>{
 assert.equal(resolve('dark',false),'dark','a dark account on a light machine stays dark');
 assert.equal(resolve('light',true),'light','a light account on a dark machine stays light');
 assert.equal(resolve('system',true),'dark');
 assert.equal(resolve('system',false),'light');
 assert.equal(resolve(null,false),'light','before the account answers, the machine is all anyone knows');
 assert.equal(resolve(null,true),'dark');
 assert.equal(resolve(undefined,false),'light');
});

test('a read is repeated once when the transport failed, and an ANSWER never is',async()=>{
 // A cold service or a dropped connection is what a second identical read can fix. A 401 is the
 // account's own answer and repeating it is asking a service to change its mind.
 const {theme,calls}=reader([new Error('socket hang up'),{body:nested('light')}]);
 assert.equal((await theme.read()).preference,'light');
 assert.equal(calls.length,2);
 const refused=reader([{status:401,body:{error:'invalid_session',message:'Sign in again.'}}]);
 await assert.rejects(()=>refused.theme.read(),error=>error.code==='invalid_session'&&error.status===401);
 assert.equal(refused.calls.length,1,'a refusal is an answer, not a failure to retry');
});

test('every call is bounded, and an expired read is a timeout rather than a wait for ever',async()=>{
 // The bound exists so a hung service cannot hold a window on a spinner. A transport that never
 // answers is the case: the abort is what ends it, and the code names it.
 const hanging=new AccountTheme({origin:ORIGIN,credential:()=>TOKEN,timeout:40,fetch:(url,init)=>new Promise((_,reject)=>{
  init.signal.addEventListener('abort',()=>{const error=Error('aborted');error.name='AbortError';reject(error);});
 })});
 assert.ok(READ_TIMEOUT_MS>0&&READ_TIMEOUT_MS<=30000,'the read bound is named and finite');
 await assert.rejects(()=>hanging.read(),error=>error.code==='timeout');
});

test('no session is a refusal this client states itself, with no request at all',async()=>{
 const spy=transport([]);
 const theme=new AccountTheme({origin:ORIGIN,credential:()=>'',fetch:spy.fetch});
 await assert.rejects(()=>theme.read(),error=>error.code==='invalid_session');
 assert.equal(spy.calls.length,0,'nothing is asked when there is no session to ask with');
});

test('the cache is written 0600 in its own directory and read back synchronously',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'eapp-theme-'));
 try{
  const file=path.join(home,'theme.json');
  assert.equal(readCache(file),null,'no cache is not an error: it is a first launch');
  assert.equal(await writeCache(file,'dark'),true);
  assert.equal(readCache(file),'dark');
  assert.equal(fs.statSync(file).mode&0o777,0o600,'the cached theme is private to this account');
  // A file the next launch cannot trust is the OS answer, never a crash on the way to painting.
  fs.writeFileSync(file,'{ not json');
  assert.equal(readCache(file),null);
  fs.writeFileSync(file,JSON.stringify({theme:'chartreuse'}));
  assert.equal(readCache(file),null);
  assert.equal(await writeCache(file,'sunset'),false,'a value this client cannot paint is never cached');
  assert.equal(readCache(file),null);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
