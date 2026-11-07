'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const {loadServerPage,showingFile}=require('../desktop/navigation.cjs');

test('a successful server load resolves normally',async()=>{
 const calls=[];
 await loadServerPage({loadURL:async url=>calls.push(url)},'https://server.example/');
 assert.deepEqual(calls,['https://server.example/']);
});

test('a page replaced by billing does not become a fatal startup failure',async()=>{
 for(const details of [{errno:-3},{code:'ERR_ABORTED'}]){
  const cancellation=Object.assign(Error('Navigation replaced'),details);
  await assert.doesNotReject(loadServerPage({loadURL:async()=>{throw cancellation;}},'https://server.example/'));
 }
});

test('connection, certificate and renderer errors remain failures',async()=>{
 for(const code of ['ERR_CONNECTION_REFUSED','ERR_CERT_AUTHORITY_INVALID','ERR_FAILED']){
  const failure=Object.assign(Error(code),{code,errno:-2});
  await assert.rejects(loadServerPage({loadURL:async()=>{throw failure;}},'https://server.example/'),error=>error===failure);
 }
 const failure=Error('ERR_ABORTED appears in text but is not the navigation error code');
 await assert.rejects(loadServerPage({loadURL:async()=>{throw failure;}},'https://server.example/'),error=>error===failure);
});

// THE PERMISSION SCREEN MUST NOT RELOAD ITSELF. The connected window answers every
// `did-finish-load` by asking whether the permission screen is needed; loading the screen again
// from that answer is the loop that made the question impossible to answer (125 loads a second
// in the client's own log). `showingFile` is the check that makes the answer idempotent.
const winShowing=url=>({isDestroyed:()=>false,webContents:{getURL:()=>url}});

test('the permission document is recognised by the exact URL Electron reports',()=>{
 const file='/opt/e-server/resources/app.asar/desktop/permission/permission.html';
 assert.equal(showingFile(winShowing(pathToFileURL(file).href),file),true,
  'the packaged ASAR URL is the same URL getURL() reports');
 assert.equal(showingFile(winShowing('https://server.example/'),file),false,
  'a server page is not the permission screen');
 assert.equal(showingFile(winShowing(pathToFileURL(file).href+'?again'),file),false,
  'a different document at a similar URL is not the screen');
});

test('a window that is gone is showing nothing',()=>{
 const file='/opt/e-server/resources/app.asar/desktop/permission/permission.html';
 assert.equal(showingFile(null,file),false);
 assert.equal(showingFile({isDestroyed:()=>true,webContents:{getURL:()=>pathToFileURL(file).href}},file),false);
 assert.equal(showingFile({isDestroyed:()=>false,webContents:{getURL:()=>{throw Error('no contents');}}},file),false);
});

test('a finished load of the screen never starts another load',async()=>{
 // The exact shape of the loop: did-finish-load -> gate -> (only if not showing) loadFile. A
 // counting fake window makes the recursion visible here instead of in a person's window.
 const file='/opt/e-server/resources/app.asar/desktop/permission/permission.html';
 const url=pathToFileURL(file).href;
 let loads=0;
 const window={
  isDestroyed:()=>false,
  webContents:{
   getURL:()=>url,
   // Mimic Electron: a load finishes, which is what calls the gate again.
   finishLoad:async()=>{loads++;},
  },
 };
 const gate=async()=>{
  if(showingFile(window,file))return true;
  await window.webContents.finishLoad();
  return true;
 };
 for(let turn=0;turn<50;turn++)await gate();
 assert.equal(loads,0,'a screen that is already showing was loaded again');
});
