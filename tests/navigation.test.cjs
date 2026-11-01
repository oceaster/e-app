'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadServerPage}=require('../desktop/navigation.cjs');

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
