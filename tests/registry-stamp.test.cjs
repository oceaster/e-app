'use strict';
// THE ROOT HELPER ITSELF, exercised against TEMPORARY fixture registries (ticket 06becd1e).
//
// Keyless and rootless: every case builds a throwaway tree under os.tmpdir(), points the helper at
// it with E_APP_REGISTRY_ROOT, and runs it as this user. The live /var/lib/pacman and
// /var/lib/dpkg are never touched — the tree the helper reads is the tree this file wrote, which is
// the whole reason the override exists.
//
// A pacman fixture is the real shape of /var/lib/pacman/local: one directory per installed package
// named <name>-<version>-<rel>, with a `desc` holding %NAME% and %VERSION% sections. A dpkg fixture
// is the real shape of /var/lib/dpkg/status: blank-line separated stanzas of Field: value.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');

const HELPER=path.join(__dirname,'..','desktop','packaging','e-app-registry-stamp');
const DESC=(name,version)=>`%NAME%\n${name}\n\n%VERSION%\n${version}\n\n%DESC%\nYour private e-server desktop client\n\n%URL%\nhttps://easter.company/\n\n%ARCH%\nx86_64\n\n%PACKAGER%\nEaster LTD\n`;

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'e-app-registry-'));
 return {root,cleanup(){fs.rmSync(root,{recursive:true,force:true});}};
}
function pacmanEntry(root,name='e-app',version='1.0.8-1'){
 const dir=path.join(root,'var/lib/pacman/local',`${name}-${version}`);
 fs.mkdirSync(dir,{recursive:true});
 fs.writeFileSync(path.join(dir,'desc'),DESC(name,version));
 fs.writeFileSync(path.join(dir,'files'),'%FILES%\nopt/\nusr/\n');
 return dir;
}
function dpkgStatus(root,stanzas){
 const file=path.join(root,'var/lib/dpkg/status');
 fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,stanzas.map(fields=>Object.entries(fields).map(([key,value])=>`${key}: ${value}`).join('\n')).join('\n\n')+'\n');
 return file;
}
// The helper is run the way the app runs it: one argument, its own environment, nothing else.
function stamp(root,args=['1.0.18']){
 const answer=spawnSync(HELPER,args,{env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',E_APP_REGISTRY_ROOT:root},encoding:'utf8'});
 const lines=String(answer.stdout||'').split('\n').filter(line=>line.trim()!=='');
 return {code:answer.status,signal:answer.signal,stdout:String(answer.stdout||''),stderr:String(answer.stderr||''),lines,sentence:lines[0]};
}
const entries=root=>fs.readdirSync(path.join(root,'var/lib/pacman/local')).filter(name=>name!=='ALPM_DB_VERSION').sort();
const read=(...parts)=>fs.readFileSync(path.join(...parts),'utf8');

test('the pacman entry is renamed and its %VERSION% rewritten, everything else untouched',()=>{
 const {root,cleanup}=fixture();
 try{
  const dir=pacmanEntry(root);
  const before=read(dir,'desc');
  const answer=stamp(root);
  assert.equal(answer.code,0,`exit 0, said: ${answer.sentence}`);
  assert.equal(answer.lines.length,1,'exactly one sentence');
  assert.equal(answer.sentence,"e-app's pacman entry now reports 1.0.18-1 (was 1.0.8-1).");
  assert.deepEqual(entries(root),['e-app-1.0.18-1'],'the directory carries the new version');
  const desc=read(root,'var/lib/pacman/local/e-app-1.0.18-1/desc');
  assert.match(desc,/%VERSION%\n1\.0\.18-1\n/);
  assert.equal(desc,before.replace('%VERSION%\n1.0.8-1\n','%VERSION%\n1.0.18-1\n'),'one value changed, every other byte kept');
  assert.equal(read(root,'var/lib/pacman/local/e-app-1.0.18-1/files'),'%FILES%\nopt/\nusr/\n','the payload list moves with the entry');
 }finally{cleanup();}
});

test('a second run is idempotent: no write, and it says so',()=>{
 const {root,cleanup}=fixture();
 try{
  pacmanEntry(root);
  assert.equal(stamp(root).code,0);
  const descFile=path.join(root,'var/lib/pacman/local/e-app-1.0.18-1/desc');
  const before=read(descFile),statBefore=fs.statSync(descFile).mtimeMs,directoryBefore=fs.statSync(path.dirname(descFile)).mtimeMs;
  const again=stamp(root);
  assert.equal(again.code,0);
  assert.equal(again.sentence,"e-app's pacman entry already reports 1.0.18-1; nothing to change.");
  assert.equal(read(descFile),before);
  assert.equal(fs.statSync(descFile).mtimeMs,statBefore,'the desc was not rewritten');
  assert.equal(fs.statSync(path.dirname(descFile)).mtimeMs,directoryBefore,'the entry was not renamed again');
  assert.deepEqual(entries(root),['e-app-1.0.18-1']);
 }finally{cleanup();}
});

test('an entry that does not declare %NAME% e-app is refused and left alone',()=>{
 const {root,cleanup}=fixture();
 try{
  const dir=pacmanEntry(root,'e-app-client','1.0.8-1');
  const before=read(dir,'desc');
  const answer=stamp(root);
  assert.equal(answer.code,11);
  assert.equal(answer.sentence,`Refusing to stamp ${dir}: that entry declares the package name 'e-app-client', not e-app.`);
  assert.equal(read(dir,'desc'),before,'the desc is untouched');
  assert.deepEqual(entries(root),['e-app-client-1.0.8-1']);
 }finally{cleanup();}
});

test('the pkgrel is carried over, and a target entry that already exists is refused',()=>{
 const {root,cleanup}=fixture();
 try{
  pacmanEntry(root);
  assert.equal(stamp(root).code,0);
  // A machine that already has 1.0.18-1 on disk while 1.0.8-1 lingers must not be clobbered.
  fs.mkdirSync(path.join(root,'var/lib/pacman/local/e-app-1.0.8-1'),{recursive:true});
  fs.writeFileSync(path.join(root,'var/lib/pacman/local/e-app-1.0.8-1/desc'),DESC('e-app','1.0.8-1'));
  // Two entries claim e-app now, so the helper refuses the ambiguity rather than guessing.
  const answer=stamp(root);
  assert.equal(answer.code,11);
  assert.match(answer.sentence,/2 pacman entries under .* claim e-app/);
  assert.deepEqual(entries(root),['e-app-1.0.18-1','e-app-1.0.8-1']);
 }finally{cleanup();}
});

test('a target directory occupied by another entry is refused, not overwritten',()=>{
 const {root,cleanup}=fixture();
 try{
  pacmanEntry(root);
  fs.mkdirSync(path.join(root,'var/lib/pacman/local/e-app-1.0.18-2'),{recursive:true});
  fs.writeFileSync(path.join(root,'var/lib/pacman/local/e-app-1.0.18-2/desc'),DESC('e-app','1.0.18-2'));
  const answer=stamp(root);
  assert.equal(answer.code,11);
  assert.match(answer.sentence,/2 pacman entries under .* claim e-app/);
  assert.equal(entries(root).length,2);
 }finally{cleanup();}
});

test('a version that is not strict X.Y.Z is refused before anything is read or written',()=>{
 const {root,cleanup}=fixture();
 try{
  pacmanEntry(root);
  const before=read(root,'var/lib/pacman/local/e-app-1.0.8-1/desc');
  for(const bad of ['1.0','1.0.18-1','v1.0.18','01.0.18','1.0.018','1.0.18.0','',' 1.0.18']){
   const answer=stamp(root,[bad]);
   assert.equal(answer.code,12,`'${bad}' refused`);
   assert.equal(answer.sentence,`Refusing to stamp: '${bad}' is not a strict X.Y.Z version.`);
  }
  assert.equal(stamp(root,['1.0.18','2.0.0']).sentence,'Refusing to stamp: expected exactly one strict X.Y.Z version argument, got 2.');
  assert.equal(stamp(root,[]).sentence,'Refusing to stamp: expected exactly one strict X.Y.Z version argument, got 0.');
  assert.equal(read(root,'var/lib/pacman/local/e-app-1.0.8-1/desc'),before,'nothing changed');
  assert.deepEqual(entries(root),['e-app-1.0.8-1']);
 }finally{cleanup();}
});

test('the dpkg stanza\'s Version: is rewritten, and every other byte of the status file survives',()=>{
 const {root,cleanup}=fixture();
 try{
  const file=dpkgStatus(root,[
   {'Package':'bash',Status:'install ok installed','Version':'5.2.15-1',Description:'The GNU Bourne Again SHell'},
   {'Package':'e-app',Status:'install ok installed','Version':'1.0.14',Architecture:'amd64',Description:'Your private e-server desktop client'},
   {'Package':'zlib1g',Status:'install ok installed','Version':'1:1.3.dfsg-3',Description:'compression library'},
  ]);
  const before=read(file);
  const answer=stamp(root);
  assert.equal(answer.code,0,`exit 0, said: ${answer.sentence}`);
  assert.equal(answer.sentence,"e-app's dpkg entry now reports 1.0.18 (was 1.0.14).");
  const after=read(file);
  assert.equal(after,before.replace('Version: 1.0.14\n','Version: 1.0.18\n'),'exactly one line changed');
  assert.match(after,/Package: bash\nStatus: install ok installed\nVersion: 5\.2\.15-1\n/);
  assert.match(after,/Package: zlib1g\nStatus: install ok installed\nVersion: 1:1\.3\.dfsg-3\n/);
  assert.equal(stamp(root).sentence,"e-app's dpkg entry already reports 1.0.18; nothing to change.",'idempotent');
 }finally{cleanup();}
});

test('a dpkg status file with no e-app stanza is a named no-op, not a failure',()=>{
 const {root,cleanup}=fixture();
 try{
  const file=dpkgStatus(root,[{'Package':'bash',Status:'install ok installed',Version:'5.2.15-1'}]);
  const before=read(file);
  const answer=stamp(root);
  assert.equal(answer.code,10);
  assert.equal(answer.sentence,`No e-app entry exists under ${root}/var/lib/pacman/local or in ${root}/var/lib/dpkg/status, so there is nothing to stamp.`);
  assert.equal(read(file),before);
 }finally{cleanup();}
});

test('a machine with neither registry is a named no-op',()=>{
 const {root,cleanup}=fixture();
 try{
  const answer=stamp(root);
  assert.equal(answer.code,10);
  assert.match(answer.sentence,/^No e-app entry exists under .* so there is nothing to stamp\.$/);
  assert.equal(fs.readdirSync(root).length,0,'a no-op writes nothing at all');
 }finally{cleanup();}
});

test('a relative E_APP_REGISTRY_ROOT is refused rather than resolved somewhere surprising',()=>{
 const {root,cleanup}=fixture();
 try{
  const answer=spawnSync(HELPER,['1.0.18'],{env:{PATH:'/usr/bin:/bin',E_APP_REGISTRY_ROOT:'var/lib'},encoding:'utf8'});
  assert.equal(answer.status,12);
  assert.equal(String(answer.stdout).trim(),"Refusing to stamp: E_APP_REGISTRY_ROOT must be an absolute path, not 'var/lib'.");
  assert.equal(fs.readdirSync(root).length,0);
 }finally{cleanup();}
});

test('the helper is a sh script the package can install executable, with the argv contract it documents',()=>{
 const source=fs.readFileSync(HELPER,'utf8');
 assert.match(source,/^#!\/bin\/sh\n/);
 assert.equal(fs.statSync(HELPER).mode&0o111,0o111,'shipped executable: pkexec refuses a program it cannot run');
 assert.match(source,/E_APP_REGISTRY_ROOT/);
 // The exit codes main.cjs switches on are the ones the header documents.
 for(const code of [0,10,11,12,13])assert.match(source,new RegExp(`\\n#   ${code} `),`exit ${code} is documented for the caller`);
});
