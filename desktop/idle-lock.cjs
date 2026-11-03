'use strict';

// The clock belongs to the connection, not the machine's global idle state.
const IDLE_MS=30*60*1000, PIN_MS=10*60*1000;
class IdleLock{
 constructor({now=Date.now,lock,disconnect}){this.now=now;this.lock=lock;this.disconnect=disconnect;this.reset();}
 reset(){this.last=this.now();this.deadline=null;this.busy=false;this.disconnected=false;}
 activity(){if(this.deadline===null)this.last=this.now();}
 authenticated(){if(this.deadline!==null){this.deadline=null;this.last=this.now();}}
 async tick(){
  const now=this.now();
  if(this.deadline!==null&&now>=this.deadline){
   if(!this.disconnected){this.disconnected=true;await this.disconnect();}return;
  }
  if(this.busy||this.deadline!==null)return;
  if(now-this.last>=IDLE_MS){this.deadline=now+PIN_MS;this.busy=true;try{await this.lock();}catch{await this.disconnect();}finally{this.busy=false;}}
 }
}
module.exports={IdleLock,IDLE_MS,PIN_MS};
