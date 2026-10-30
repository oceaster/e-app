'use strict';
const path=require('node:path'),crypto=require('node:crypto');
let raw;try{raw=require('original-fs');}catch{raw=require('node:fs');}
const fs=raw.promises;
// WHERE THIS CLIENT LOOKS FOR ITS OWN UPDATES is the repository it is built from.
// The client moved to oceaster/e-app (Owen, 2026-10-30: "make sure that the e-app auto
// update feature is still going to work now we moved the repo location"), so the feed
// moved with it - the old EasterCompany/e-server-client path is not where releases are
// published any more. An install built before this change still asks the old address and
// will never see a new release: 1.0.5 needs one fresh download and install, and every
// release after it updates itself from here. tests/update-feed.test.cjs holds this line
// to the repository the checkout came from.
const REPO='https://github.com/oceaster/e-app/releases/download/';
const LATEST='https://github.com/oceaster/e-app/releases/latest/download/';
const BOOTSTRAP=1,MAX_BYTES=200*1024*1024;
// WHICH package names this client accepts as ITS OWN update payload, and why that is a list.
//
// Owen, 2026-10-29: "you mean easter-server-client lol?" - the package really is misnamed. It
// cannot be renamed in one edit, and the reason is the machines already in the field, not caution:
// every published build (1.0.0, 1.0.1, 1.0.2) carries a guard that compares the DOWNLOADED
// payload's package.json name to the OLD literal, so a renamed payload is refused by every install
// that exists - the app keeps working and silently stops updating forever. That is the worst
// failure shape there is, so the rename takes three releases:
//   * 1.0.3 keeps PUBLISHING the old name, and both guards accept EITHER name. This build.
//   * 1.0.4 publishes the new name. Only an install that passed through 1.0.3 can read it.
//   * 1.0.5 is the earliest release that may DROP the old name from this list - and only after
//     every install that can auto-update has been through 1.0.3, because releases/latest is the
//     only address an old app ever consults: a machine that missed 1.0.3 will be handed the
//     renamed payload and refuse it, and needs a manual reinstall rather than a cleverer guard.
//
// The unguarded alternative - accepting any name, or any version - is not available: this is the
// check that stops a foreign asar being installed as this app.
const PAYLOAD_NAMES=['easter-eserver-client','easter-server-client'];
function identifies(pkg,manifest){return !!pkg&&!!manifest&&PAYLOAD_NAMES.includes(pkg.name)&&pkg.version===manifest.version;}
// The one refusal for a version this e-server client cannot read. It carries a name and a code as
// well as the sentence a player sees, because the clear policy below has to be able to say
// "this pair was unparsable" without mistaking it for a filesystem failure.
function invalidVersion(){const invalid=Error('Invalid e-server client release version.');invalid.name='EServerVersionError';invalid.code='invalid-version';return invalid;}
function version(value){
 const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value));
 if(!match)throw invalidVersion();
 const parts=match.slice(1).map(Number);if(!parts.every(Number.isSafeInteger))throw invalidVersion();return parts;
}
function compare(a,b){const left=version(a),right=version(b);for(let i=0;i<3;i++)if(left[i]!==right[i])return left[i]>right[i]?1:-1;return 0;}
function validate(manifest,{release,platform,arch,runtime}){
 if(!manifest||manifest.schema!==1||manifest.version!==release||manifest.platform!==platform||manifest.arch!==arch)throw Error('The e-server client update manifest does not match this release or device.');
 version(release);
 if(manifest.bootstrap!==BOOTSTRAP||manifest.runtime!==runtime)throw Error('This release needs a newer e-server client runtime. Install the latest e-server client to continue.');
 const asset='Easter-e-server-Update-'+platform+'-'+arch+'.asar';
 if(manifest.asset!==asset||!/^[a-f0-9]{64}$/.test(manifest.sha256)||!Number.isSafeInteger(manifest.size)||manifest.size<1||manifest.size>MAX_BYTES)throw Error('The e-server client update manifest is invalid.');
 return {...manifest,url:REPO+'client-v'+release+'/'+asset};
}
// A e-server client-update failure is worded for the player: what stopped and what to do about it. The
// HTTP status stays off the sentence and on the error (`httpStatus`, with the `host` and `step`
// that produced it), and one line per failure goes to the e-server client's failure record — the same
// bounded, redacted line log the sign-in uses (desktop/auth.cjs SignInLog). main.cjs owns the
// paths and hands the log in through setFailureLog(); until it does, a failure carries its status
// and writes nothing. This file keeps its own copy of these ten lines deliberately: it runs before
// the gate, and requiring desktop/install.cjs here would pull the whole Minecraft installer in
// front of it.
let failureLog=null;
function setFailureLog(log){failureLog=log&&typeof log.append==='function'?log:null;}
function fault(message,{step='e-server client-update',status,host}={}){
 const failed=Error(message);
 if(Number.isInteger(status))failed.httpStatus=status;
 if(typeof host==='string'&&host)failed.host=host;
 failed.step=step;
 try{failureLog?.append({step,outcome:'failed',status:Number.isInteger(status)?status:undefined,note:host});}catch{}
 return failed;
}
// One timeout, or the caller's own cancellation AND that timeout: a check the e-server client can
// abort on quit is also bounded by the same number it was bounded by before.
function bounded(signal,ms){return signal?AbortSignal.any([signal,AbortSignal.timeout(ms)]):AbortSignal.timeout(ms);}
async function json(fetch,url,{signal}={}){
 const response=await fetch(url,{signal:bounded(signal,20000),cache:'no-store',headers:{Accept:'application/json'}});
 if(!response.ok)throw fault('The e-server client update could not be checked. Check your connection and try again.',{status:response.status,host:hostOf(url)});
 const text=await response.text();if(text.length>65536)throw Error('The update response is too large.');
 return JSON.parse(text);
}
function hostOf(url){try{return new URL(url).hostname;}catch{return '';}}
async function atomic(file,value){
 const temp=file+'.'+crypto.randomUUID()+'.tmp';
 try{await fs.writeFile(temp,JSON.stringify(value),{mode:0o600});await fs.rename(temp,file);}
 finally{await fs.rm(temp,{force:true});}
}
async function stage(manifest,{root,fetch,notify=()=>{},signal}={}){
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const target=path.join(root,manifest.sha256+'.asar'),temp=target+'.'+crypto.randomUUID()+'.part';
 let handle;
 try{
  const response=await fetch(manifest.url,{signal:bounded(signal,300000)});
  if(!response.ok||!response.body)throw fault('The e-server client update could not be downloaded. Try again.',{step:'e-server client-asset',status:response.status,host:hostOf(manifest.url)});
  const length=response.headers.get('content-length');
  if(length!==null&&Number(length)!==manifest.size)throw Error('The e-server client update size does not match the release.');
  handle=await fs.open(temp,'wx',0o600);
  const hash=crypto.createHash('sha256');let done=0;
  for await(const chunk of response.body){
   done+=chunk.length;if(done>manifest.size)throw Error('The e-server client update exceeds its declared size.');
   hash.update(chunk);await handle.writeFile(chunk);
   notify({phase:'downloading',version:manifest.version,percent:Math.floor(done/manifest.size*100),message:'Updating e-server client…'});
  }
  notify({phase:'verifying',version:manifest.version,percent:100,message:'Verifying e-server client…'});
  if(done!==manifest.size||hash.digest('hex')!==manifest.sha256)throw Error('The e-server client update failed verification. Retry to download a fresh copy.');
  await handle.sync();await handle.close();handle=null;
  // Validate package identity before activation; no downloaded code executes here.
  await fs.rename(temp,target);
  return target;
 }finally{await handle?.close();await fs.rm(temp,{force:true});}
}
// The one pipeline that turns "a release is published" into a verified payload on disk. It
// answers the path of the verified payload when a strictly newer release was downloaded, and
// null when this e-server client already is the published one.
//
// `apply` decides what happens after the payload is verified, and it is the whole difference
// between the startup gate and the background check:
//   * `apply:true` (the startup gate) writes `current.json`, the activation record bootstrap
//     loads on the next start, and announces the restart. This is the only path that
//     activates anything, and the version policy's clear belongs to it because it is the one
//     moment a version change may destroy something.
//   * `apply:false` (the background check, ticket 2cd301e3) writes `staged.json` instead and
//     announces nothing. A background stage that wrote `current.json` would make a minor
//     release activate on the next ordinary start *without* the clear its level asks for,
//     because bootstrap would then load the new bundle and the startup gate would find
//     nothing newer. So the staged record is a fact about the stash, not an activation.
async function update({current,platform=process.platform,arch=process.arch,runtime,root,fetch=globalThis.fetch,notify=()=>{},inspect=()=>{},apply=true,signal}={}){
 notify({phase:'checking',percent:null,message:'Checking e-server client updates…'});
 const name='Easter-e-server-Update-'+platform+'-'+arch+'.json';
 const info=await json(fetch,LATEST+name,{signal});
 const release=info?.version;
 const manifest=validate(info,{release,platform,arch,runtime});
 if(compare(release,current)<=0){notify({phase:'current',version:current,percent:null,message:null});return null;}
 const target=await stage(manifest,{root,fetch,notify,signal});
 await inspect(target,manifest);
 if(!apply){await atomic(path.join(root,'staged.json'),manifest);return target;}
 await atomic(path.join(root,'current.json'),manifest);
 notify({phase:'restarting',version:release,percent:100,message:'Restarting e-server client…'});
 return target;
}
function selected(root,{bundled,runtime,platform=process.platform,arch=process.arch,inspect=()=>{}}){
 try{
  const manifest=JSON.parse(raw.readFileSync(path.join(root,'current.json'),'utf8'));
  validate(manifest,{release:manifest.version,platform,arch,runtime});
  if(compare(manifest.version,bundled)<=0)return null;
  const target=path.join(root,manifest.sha256+'.asar');
  if(raw.statSync(target).size!==manifest.size)return null;
  const bytes=raw.readFileSync(target);
  if(bytes.length!==manifest.size||crypto.createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)return null;
  inspect(target,manifest);return target;
 }catch{return null;}
}
// What the background check has staged, and where it is. `selected` above answers "may this
// payload be loaded as the running e-server client now?" and hashes the whole payload because it is
// about to execute it; this answers "what is sitting in the stash, verified, waiting for an
// apply step?", so it validates the record exactly as `selected` does and checks the payload's
// length. The bytes were hashed by `stage` when they were written and the file is named after
// that hash, so re-hashing here would be a 40 MB read on every question and prove nothing new.
//
// `stagedState` is the same question asked with the reason attached, because the apply step has
// to do something different with each answer: nothing staged is silence, a record that names a
// version this e-server client already runs or a payload that no longer matches itself is discarded
// rather than applied, and only `ready` may be activated. A reader asking "may I apply this?"
// gets the same verdict from `staged` below; the poller uses that one and needs no reasons.
function stagedState(root,{current,runtime,platform=process.platform,arch=process.arch}={}){
 let manifest;
 try{manifest=JSON.parse(raw.readFileSync(path.join(root,'staged.json'),'utf8'));}
 catch{return {outcome:'none',record:null,manifest:null};}
 try{validate(manifest,{release:manifest.version,platform,arch,runtime});}
 catch{return {outcome:'invalid',record:null,manifest};}
 if(current!==undefined&&compare(manifest.version,current)<=0)return {outcome:'stale',record:null,manifest};
 const target=path.join(root,manifest.sha256+'.asar');
 try{if(raw.statSync(target).size!==manifest.size)return {outcome:'invalid',record:null,manifest};}
 catch{return {outcome:'invalid',record:null,manifest};}
 return {outcome:'ready',record:{...manifest,file:target},manifest};
}
function staged(root,options={}){
 const {outcome,record}=stagedState(root,options);
 return outcome==='ready'?record:null;
}
// The apply step's one write: what the background check staged becomes what bootstrap.cjs loads
// on the next start. The record is re-read and re-validated here rather than trusted from the
// earlier question, and the payload is hashed against it, because this is the moment the bytes
// become the code that runs next — the same standard `selected` applies when it loads them. The
// staged record is removed afterwards: it has been activated, and a record naming a version this
// e-server client already runs is a stale file the next start would have to discard.
//
// This is the activation and nothing else. It writes no cache, clears nothing and restarts
// nothing: the version policy's clear and the relaunch are the caller's, and they belong
// together because they are the one moment a version change may destroy something.
async function activateStaged({root,runtime,current,platform=process.platform,arch=process.arch,inspect=()=>{}}={}){
 const record=staged(root,{current,runtime,platform,arch});
 if(!record)return null;
 const {file,...manifest}=record;
 const bytes=await fs.readFile(file);
 if(bytes.length!==manifest.size||crypto.createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)return null;
 inspect(file,manifest);
 await atomic(path.join(root,'current.json'),manifest);
 // A record that survives its own activation would be answered "not newer than the e-server client"
 // on the next question, so it is removed here, once, rather than left for the next start.
 await fs.rm(path.join(root,'staged.json'),{force:true});
 return {...manifest,file};
}

module.exports={update,selected,staged,activateStaged,validate,compare,version,identifies,PAYLOAD_NAMES};
