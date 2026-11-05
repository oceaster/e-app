'use strict';
// THE ONE PLACE THE OS PACKAGE REGISTRY IS TOLD WHAT THIS INSTALL RUNS.
//
// The e-server client updates itself: desktop/updater.cjs verifies a payload and writes
// updates/current.json, and desktop/bootstrap.cjs loads that payload as the app path on the next
// start. Nothing in that path ever told the package manager, so one install ends up reporting
// three different versions at once — measured on this machine 2026-11-05:
//   pacman -Q e-app -> e-app 1.0.8-1, /opt/e-server/resources/app.asar -> 1.0.14, running -> 1.0.18.
// Anyone reading the registry is told a version that is not running.
//
// desktop/main.cjs calls `stamp()` at the one moment a version becomes real — the activation
// (activateVersion) — and records the sentence it answers with in the app's update log and in the
// update result. The write itself is desktop/packaging/e-app-registry-stamp, which the package
// ships at resources/e-app-registry-stamp and which the package's polkit rule
// (desktop/packaging/49-e-app-registry-stamp.rules) allows through pkexec without a prompt.
//
// THE RULES THIS MODULE KEEPS, all of them because the alternative is the defect again:
//   * It never claims the registry was updated unless the helper said so. The helper's sentence is
//     the record, verbatim; `ok` is true only for a write or a named no-op.
//   * It never attempts blindly. No shipped helper, no installed rule, no pkexec: each is detected
//     first and reported as its own outcome, because a denied pkexec on a desktop is a dialogue and
//     an update must never become one.
//   * It never throws. An activation that reached here has already verified and written the
//     payload; the registry is a record of that fact, so a failure to record it is recorded instead
//     of raised into the update path.
//
// Everything the environment touches is injectable (`run`, `exists`, `access`, `platform`, `uid`,
// `resources`) so tests/registry.test.cjs drives the whole call — success, refusal, missing
// privilege, invalid version — without root, without pkexec and without a real registry.
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');

// The helper and the rule the package installs (electron-builder `extraResources` and the fpm
// mapping in package.json). The app does not write either of them; it only looks for them.
const HELPER='e-app-registry-stamp';
const RULE='49-e-app-registry-stamp.rules';
// /usr/share is where a package puts policy it ships; /etc is where an operator overrides it.
// polkit reads both; the shipped one lives in the first.
const RULE_DIRS=['/usr/share/polkit-1/rules.d','/etc/polkit-1/rules.d'];
const PKEXEC='/usr/bin/pkexec';
// The helper answers in under a second (three file writes at most). A bound that expires is a
// refusal with its own sentence, never an unbounded wait on a startup path.
const TIMEOUT_MS=20000;

// The strict version the helper itself accepts: three dot-separated non-negative integers with no
// leading zero. Kept here as well because an argument that fails it must not reach a root program
// at all — the helper would refuse it, but nothing sends root a version this module cannot read.
const VERSION_PATTERN=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function strictVersion(value){return typeof value==='string'&&VERSION_PATTERN.test(value)?value:null;}

function helperPath(resources){return path.join(resources,HELPER);}

// Which sentence a failure carries, so main.cjs logs a fact rather than an error code. The
// registry's own sentence is used verbatim whenever the helper produced one.
function result(outcome,sentence,extra={}){
 return {ok:outcome==='stamped'||outcome==='unchanged'||outcome==='no-op',outcome,sentence,...extra};
}

// THE PRIVILEGE, DETECTED RATHER THAN ATTEMPTED. Running as root needs no grant at all (a root
// process, a container, a test); a desktop needs both the shipped helper and the shipped polkit
// rule, and pkexec to reach it. Anything missing is named, with the path that is missing, so an
// operator can see what the package did not install.
function privilege({platform=process.platform,uid=process.getuid?process.getuid():null,resources,exists=fs.existsSync,access=fs.accessSync}={}){
 if(platform!=='linux')return {granted:false,outcome:'no-op',sentence:'This platform has no pacman or dpkg registry to stamp, so the e-server client version is recorded only by the client.'};
 // The shipped helper is checked first, before anything about identity: a package that did not ship
 // it cannot stamp whatever the caller's privilege is, and that is a packaging defect worth naming
 // rather than a spawn that fails with ENOENT.
 const helper=helperPath(resources);
 if(!exists(helper))return {granted:false,outcome:'missing-helper',sentence:`The update is installed but the package registry was not stamped: this package does not ship ${helper}.`};
 try{access(helper,fs.constants.X_OK);}
 catch{return {granted:false,outcome:'missing-helper',sentence:`The update is installed but the package registry was not stamped: ${helper} is not executable.`};}
 if(uid===0)return {granted:true,via:'root'};
 const rule=RULE_DIRS.map(dir=>path.join(dir,RULE)).find(file=>exists(file));
 if(!rule)return {granted:false,outcome:'unprivileged',sentence:`The update is installed but the package registry was not stamped: the update privilege ${path.join(RULE_DIRS[0],RULE)} is not installed on this machine.`};
 if(!exists(PKEXEC))return {granted:false,outcome:'unprivileged',sentence:`The update is installed but the package registry was not stamped: ${PKEXEC} is not installed, so the privilege ${rule} grants cannot be used.`};
 return {granted:true,via:'pkexec',program:helper};
}

// The default runner: the helper itself when this process is root, otherwise pkexec with the one
// program path the rule allows. `E_APP_REGISTRY_ROOT` is deliberately NOT passed through: pkexec
// scrubs the environment, so a caller can never point the root helper at another tree.
function execRunner(program,args){return new Promise(resolve=>{
 execFile(program,args,{timeout:TIMEOUT_MS,windowsHide:true,env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',LANG:'C'}},(error,stdout,stderr)=>{
  const code=error&&typeof error.code==='number'?error.code:(error?null:0);
  resolve({code,signal:error?.signal,error:error&&typeof error.code!=='number'?error.code:null,stdout:String(stdout||''),stderr:String(stderr||'')});
 });
});}

// One sentence out of the helper's answer: the first non-empty line it printed on stdout, or its
// stderr when it printed none (a shell error, a missing interpreter).
function line(answer){
 const pick=(text)=>String(text||'').split('\n').map(text=>text.trim()).filter(Boolean)[0]||'';
 return {sentence:pick(answer.stdout)||pick(answer.stderr)};
}

// THE CALL. `version` is the version that was just activated. Answers
// {ok, outcome, sentence, version, code}: `outcome` is what happened, `sentence` is the record —
// the helper's own words when it spoke, or this module's when it could not be run at all.
async function stamp({version,resources=process.resourcesPath,platform=process.platform,uid,exists=fs.existsSync,access=fs.accessSync,run=execRunner}={}){
 const target=strictVersion(version);
 if(!target)return result('refused',`The update is installed but the package registry was not stamped: '${version}' is not a strict X.Y.Z version.`,{version:String(version)});
 const allowed=privilege({platform,uid,resources,exists,access});
 if(!allowed.granted)return result(allowed.outcome,allowed.sentence,{version:target});
 const program=allowed.via==='root'?helperPath(resources):PKEXEC;
 const args=allowed.via==='root'?[target]:[helperPath(resources),target];
 let answer;
 try{answer=await run(program,args);}
 catch(error){return result('failed',`The update is installed but the package registry was not stamped: ${helperPath(resources)} could not be run (${error&&error.message||'unknown error'}).`,{version:target});}
 const {sentence}=line(answer);
 if(answer.code===0){
  // "already reports" is the helper's idempotent answer: nothing was written and the registry was
  // already right, which is a different record from a write.
  const outcome=/already reports/.test(sentence)?'unchanged':'stamped';
  return result(outcome,sentence||`${HELPER} stamped ${target}, but printed no sentence.`,{version:target,code:0});
 }
 if(answer.code===10)return result('no-op',sentence||`No pacman or dpkg entry exists for this install, so there was nothing to stamp for ${target}.`,{version:target,code:10});
 const outcome=answer.code===11||answer.code===12?'refused':answer.code===null?'failed':'failed';
 return result(outcome,sentence||`The update is installed but the package registry was not stamped: ${HELPER} exited with ${answer.code===null?answer.error||'no status':answer.code}.`,{version:target,code:answer.code});
}

// THE APP'S UPDATE LOG. The updater already documents this shape ("the same bounded, redacted line
// log the sign-in uses ... main.cjs owns the paths and hands the log in through setFailureLog()")
// and nothing had ever handed it one, so every update failure went nowhere. It is one JSON line per
// event in the app's own config directory, bounded so it cannot grow without limit, written 0600
// and appended in order. It carries what this module and the updater put in it — a step, an
// outcome, a version, a sentence — never a token, a URL query or an address.
const LOG_LIMIT=200;
class UpdateLog{
 constructor(file,{limit=LOG_LIMIT}={}){this.file=file;this.limit=limit;this.chain=Promise.resolve();}
 append(entry){this.chain=this.chain.then(()=>this.write(entry)).catch(()=>{});return this.chain;}
 async write(entry){
  const line=JSON.stringify({at:new Date().toISOString(),...entry})+'\n';
  await fs.promises.mkdir(path.dirname(this.file),{recursive:true,mode:0o700});
  await fs.promises.appendFile(this.file,line,{mode:0o600});
  const text=await fs.promises.readFile(this.file,'utf8');
  const lines=text.split('\n').filter(Boolean);
  if(lines.length>this.limit)await fs.promises.writeFile(this.file,lines.slice(-this.limit).join('\n')+'\n',{mode:0o600});
 }
}

module.exports={stamp,privilege,strictVersion,helperPath,UpdateLog,execRunner,HELPER,RULE,RULE_DIRS,PKEXEC,VERSION_PATTERN};
