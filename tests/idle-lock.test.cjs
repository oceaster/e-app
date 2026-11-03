'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {IdleLock,IDLE_MS,PIN_MS}=require('../desktop/idle-lock.cjs');

test('locks after 30 minutes and disconnects after ten more without successful PIN',async()=>{
 let time=0,locks=0,disconnects=0;
 const idle=new IdleLock({now:()=>time,lock:async()=>{locks++;},disconnect:async()=>{disconnects++;}});
 time=IDLE_MS-1;await idle.tick();assert.equal(locks,0);
 time++;await idle.tick();assert.equal(locks,1);
 time+=PIN_MS-1;idle.activity();await idle.tick();assert.equal(disconnects,0);
 time++;await idle.tick();assert.equal(disconnects,1);
});
test('successful PIN resets the inactivity window',async()=>{
 let time=0,locks=0,disconnects=0;
 const idle=new IdleLock({now:()=>time,lock:async()=>{locks++;},disconnect:async()=>{disconnects++;}});
 time=IDLE_MS;await idle.tick();time+=PIN_MS-1;idle.authenticated();
 time+=IDLE_MS-1;await idle.tick();assert.equal(locks,1);assert.equal(disconnects,0);
 time++;await idle.tick();assert.equal(locks,2);
});
test('recent interaction postpones lock and a failed lock disconnects',async()=>{
 let time=0,disconnects=0;
 const idle=new IdleLock({now:()=>time,lock:async()=>{throw Error('offline');},disconnect:async()=>{disconnects++;}});
 time=IDLE_MS-1;idle.activity();time+=IDLE_MS-1;await idle.tick();assert.equal(disconnects,0);
 time++;await idle.tick();assert.equal(disconnects,1);
});
test('disconnect deadline still fires if the PIN page never finishes loading',async()=>{
 let time=0,disconnects=0;
 const idle=new IdleLock({now:()=>time,lock:()=>new Promise(()=>{}),disconnect:async()=>{disconnects++;}});
 time=IDLE_MS;void idle.tick();time+=PIN_MS;await idle.tick();
 assert.equal(disconnects,1);
});
