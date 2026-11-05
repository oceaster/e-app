'use strict';
// THE APP-SIDE CALL THAT STAMPS THE PACKAGE REGISTRY, driven end to end with an injected fake
// (ticket 06becd1e). No root, no pkexec, no real pacman database: every environment touch —
// whether the sold helper exists, whether the shipped polkit rule is installed, whether pkexec is
// there, what the helper answered — is handed to `stamp()` by these tests.
//
// What this suite is for is the defect's shape: an activation that says "update installed" while
// the registry still reports another version. So each case asserts both halves of the answer —
// the outcome, and the sentence that reaches the app's update log — and the cases that must NOT
// reach the helper assert that nothing was run at all.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const registry=require('../desktop/registry.cjs');
const {stamp,privilege,UpdateLog,HELPER,RULE,RULE_DIRS,PKEXEC}=registry;

const RESOURCES='/opt/e-server/resources';
const HELPER_FILE=path.join(RESOURCES,HELPER);
const RULE_FILE=path.join(RULE_DIRS[0],RULE);

// A machine, described as files. `executable` is the separate X_OK set, because a helper that is
// shipped but not executable is a packaging defect and must be reported, not attempted.
function machine({helper=true,executable=helper,rule=false,pkexec=false}={}){
 const files=new Set([...helper?[HELPER_FILE]:[],...rule?[RULE_FILE]:[],...pkexec?[PKEXEC]:[]]);
 const executableFiles=new Set([...executable?[HELPER_FILE]:[],...pkexec?[PKEXEC]:[]]);
 return {
  exists:file=>files.has(file),
  access:(file)=>{if(!executableFiles.has(file)){const error=Error('EACCES: not executable');error.code='EACCES';throw error;}},
 };
}
function recording(answer){const calls=[];const run=async(program,args)=>{calls.push({program,args});return answer;};return {run,calls};}
const stamped=(sentence)=>({code:0,stdout:sentence+'\n',stderr:''});

test('a successful stamp is the app\'s record, in the helper\'s own words',async()=>{
 const sentence="e-app's pacman entry now reports 1.0.18-1 (was 1.0.8-1).";
 const {run,calls}=recording(stamped(sentence));
 const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform:'linux',uid:0,...machine(),run});
 assert.deepEqual(answer,{ok:true,outcome:'stamped',sentence,version:'1.0.18',code:0});
 // Root needs no grant, and the argument handed to a root program is the validated version only.
 assert.deepEqual(calls,[{program:HELPER_FILE,args:['1.0.18']}]);
});

test('a desktop session reaches the same helper through pkexec, the one program the rule allows',async()=>{
 const sentence="e-app's dpkg entry now reports 1.0.18 (was 1.0.14).";
 const {run,calls}=recording(stamped(sentence));
 const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform:'linux',uid:1000,...machine({rule:true,pkexec:true}),run});
 assert.equal(answer.ok,true);
 assert.equal(answer.sentence,sentence);
 assert.deepEqual(calls,[{program:PKEXEC,args:[HELPER_FILE,'1.0.18']}]);
});

test('a second identical run is recorded as unchanged, not as a write',async()=>{
 const sentence="e-app's pacman entry already reports 1.0.18-1; nothing to change.";
 const {run}=recording(stamped(sentence));
 const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform:'linux',uid:0,...machine(),run});
 assert.equal(answer.outcome,'unchanged');
 assert.equal(answer.ok,true);
 assert.equal(answer.sentence,sentence);
});

test('a refusal is a failed update record carrying the registry\'s sentence verbatim',async()=>{
 const sentence="Refusing to stamp /var/lib/pacman/local/e-app-1.0.8-1: that entry declares the package name 'not-e-app', not e-app.";
 const {run,calls}=recording({code:11,stdout:sentence+'\n',stderr:''});
 const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform:'linux',uid:0,...machine(),run});
 assert.equal(answer.ok,false);
 assert.equal(answer.outcome,'refused');
 assert.equal(answer.sentence,sentence);
 assert.equal(calls.length,1);
});

test('a write that could not complete is a failure, never a success claim',async()=>{
 const sentence='Refusing to stamp /var/lib/pacman/local/e-app-1.0.8-1: the entry could not be renamed to /var/lib/pacman/local/e-app-1.0.18-1, so the registry was left as it was.';
 const {run}=recording({code:13,stdout:sentence+'\n',stderr:''});
 const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform:'linux',uid:0,...machine(),run});
 assert.equal(answer.ok,false);
 assert.equal(answer.outcome,'failed');
 assert.equal(answer.sentence,sentence);
});

test('no e-app registry entry is the named no-op, and it is not a failure',async()=>{
 const sentence='No e-app entry exists under /var/lib/pacman/local or in /var/lib/dpkg/status, so there is nothing to stamp.';
 const {run}=recording({code:10,stdout:sentence+'\n',stderr:''});
 const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform:'linux',uid:0,...machine(),run});
 assert.equal(answer.outcome,'no-op');
 assert.equal(answer.ok,true);
 assert.equal(answer.sentence,sentence);
});

test('a missing privilege is DETECTED and named, and the helper is never run',async()=>{
 for(const [shape,expected,missing] of [
  [{helper:true,rule:false,pkexec:true},'unprivileged',RULE_FILE],
  [{helper:true,rule:true,pkexec:false},'unprivileged',PKEXEC],
  [{helper:false,rule:true,pkexec:true},'missing-helper',HELPER_FILE],
  [{helper:true,executable:false,rule:true,pkexec:true},'missing-helper',HELPER_FILE],
 ]){
  const {run,calls}=recording(stamped('should never be asked'));
  const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform:'linux',uid:1000,...machine(shape),run});
  assert.equal(answer.ok,false,`${JSON.stringify(shape)} must not be a success`);
  assert.equal(answer.outcome,expected,`${JSON.stringify(shape)} outcome`);
  assert.match(answer.sentence,/was not stamped/,`${JSON.stringify(shape)} sentence names what did not happen`);
  assert.equal(answer.sentence.includes(missing),true,`${JSON.stringify(shape)} sentence names ${missing}`);
  assert.equal(calls.length,0,`${JSON.stringify(shape)} must not attempt the call`);
 }
});

test('a version that is not strict X.Y.Z never reaches a root program',async()=>{
 for(const version of ['1.0','1.0.18-1','v1.0.18',' 1.0.18','1.0.18.0','01.0.18','',null,undefined,1.018,{}]){
  const {run,calls}=recording(stamped('should never be asked'));
  const answer=await stamp({version,resources:RESOURCES,platform:'linux',uid:0,...machine(),run});
  assert.equal(answer.ok,false,`${String(version)} must not be a success`);
  assert.equal(answer.outcome,'refused');
  assert.match(answer.sentence,/is not a strict X\.Y\.Z version/);
  assert.equal(calls.length,0,`${String(version)} must not be attempted`);
 }
});

test('the strict reader accepts exactly three dot-separated numbers with no leading zero',()=>{
 for(const good of ['0.0.0','1.0.18','10.20.30'])assert.equal(registry.strictVersion(good),good);
 for(const bad of ['1.0','1.0.18-1','01.0.18','1.0.018','-1.0.0','1.0.18 ','1,0,18'])assert.equal(registry.strictVersion(bad),null);
});

test('a platform with no package registry is a named no-op, not an attempt',async()=>{
 for(const platform of ['darwin','win32']){
  const {run,calls}=recording(stamped('should never be asked'));
  const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform,uid:0,...machine(),run});
  assert.equal(answer.ok,true);
  assert.equal(answer.outcome,'no-op');
  assert.match(answer.sentence,/no pacman or dpkg registry/);
  assert.equal(calls.length,0);
 }
});

test('a helper that cannot be run is a failure with its own sentence, not a thrown error',async()=>{
 const {run}=recording({code:null,error:'EACCES',stdout:'',stderr:''});
 const answer=await stamp({version:'1.0.18',resources:RESOURCES,platform:'linux',uid:0,...machine(),run});
 assert.equal(answer.ok,false);
 assert.equal(answer.outcome,'failed');
 assert.match(answer.sentence,/was not stamped/);
 assert.match(answer.sentence,new RegExp(HELPER));
});

test('the privilege probe answers with the reason, not just a boolean',()=>{
 assert.deepEqual(privilege({platform:'win32',uid:0,resources:RESOURCES}),{granted:false,outcome:'no-op',sentence:'This platform has no pacman or dpkg registry to stamp, so the e-server client version is recorded only by the client.'});
 assert.equal(privilege({platform:'linux',uid:0,resources:RESOURCES,...machine()}).via,'root');
 assert.equal(privilege({platform:'linux',uid:0,resources:RESOURCES,...machine({helper:false})}).outcome,'missing-helper');
 assert.equal(privilege({platform:'linux',uid:1000,resources:RESOURCES,...machine()}).outcome,'unprivileged');
 assert.equal(privilege({platform:'linux',uid:1000,resources:RESOURCES,...machine({rule:true,pkexec:true})}).via,'pkexec');
});

test('the update log is one bounded line per event, in the app\'s own directory',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'e-app-update-log-'));
 try{
  const file=path.join(root,'client','update.log'),log=new UpdateLog(file,{limit:3});
  await log.append({step:'package-registry',outcome:'stamped',version:'1.0.18',sentence:"e-app's pacman entry now reports 1.0.18-1 (was 1.0.8-1)."});
  await log.append({step:'package-registry',outcome:'unprivileged',version:'1.0.19',sentence:'x'});
  await log.append({step:'e-server client-update',outcome:'failed',note:'github.com'});
  await log.append({step:'package-registry',outcome:'unchanged',version:'1.0.19',sentence:'already reports'});
  const lines=fs.readFileSync(file,'utf8').split('\n').filter(Boolean);
  // Three kept: the log is bounded at its own limit, oldest first out.
  assert.equal(lines.length,3);
  assert.deepEqual(lines.map(line=>JSON.parse(line).outcome),['unprivileged','failed','unchanged']);
  const first=JSON.parse(lines[0]);
  assert.equal(first.version,'1.0.19');
  assert.match(first.at,/^\d{4}-\d\d-\d\dT/);
  assert.equal(fs.statSync(file).mode&0o777,0o600,'the log is the app\'s own, not the world\'s');
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('main.cjs has exactly one activation entry, and it stamps the registry before it returns',()=>{
 const main=fs.readFileSync(path.join(__dirname,'..','desktop','main.cjs'),'utf8');
 // One call to the activation, inside the one function that also stamps: a second call site would
 // be a path where a version becomes real and the registry is not told.
 assert.equal((main.match(/updater\.activateStaged\(/g)||[]).length,1,'exactly one activateStaged call');
 assert.match(main,/async function activateVersion\(\)\{[\s\S]{0,900}?await registry\.stamp\(\{version:record\.version,resources:process\.resourcesPath\}\)/);
 // The stamp's sentence reaches the app's update log verbatim and the published state.
 assert.match(main,/await updateLog\.append\(\{step:'package-registry',outcome:stamp\.outcome,version:record\.version,note:stamp\.sentence\}\)/);
 assert.match(main,/publish\(\{update:\{version:record\.version,registry:stamp\.outcome,sentence:stamp\.sentence\}\}\)/);
 // Both activation paths (the tray's apply and the startup gate) go through it.
 assert.match(main,/const record=await activateVersion\(\);if\(!record\)return false;/);
 assert.match(main,/if\(startup\)\{await activateVersion\(\);/);
 // The updater's documented failure seam is actually given a log now.
 assert.match(main,/updater\.setFailureLog\(updateLog\)/);
});

test('the updater\'s other activation entry cannot activate without a stamper',async()=>{
 const {update}=require('../desktop/updater.cjs');
 const crypto=require('node:crypto');
 const body=Buffer.from('a complete fixture ASAR payload'),digest=crypto.createHash('sha256').update(body).digest('hex');
 const manifest={schema:1,bootstrap:1,version:'1.0.1',platform:'linux',arch:'x64',runtime:'44.7.2',asset:'Easter-e-server-Update-linux-x64.asar',sha256:digest,size:body.length};
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'e-app-apply-'));
 try{
  const fetch=async url=>url.endsWith('.json')?new Response(JSON.stringify(manifest)):new Response(body);
  const base={current:'1.0.0',platform:'linux',arch:'x64',runtime:'44.7.2',root,fetch,apply:true};
  await assert.rejects(update(base),/without recording it in the package registry/);
  assert.equal(fs.existsSync(path.join(root,'current.json')),false,'the payload may be staged, but nothing was activated');
  const asked=[];
  const target=await update({...base,stamp:async version=>{asked.push(version);return {ok:true,outcome:'stamped',sentence:'stamped'};}});
  assert.deepEqual(asked,['1.0.1'],'the activation asks the stamper for the version it just made real');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'current.json'),'utf8')).version,'1.0.1');
  assert.equal(typeof target,'string');
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
