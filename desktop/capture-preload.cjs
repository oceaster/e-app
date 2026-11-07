'use strict';
// THE CAMERA'S OWN DOCUMENT. A live user feed's device is opened HERE, in a window that never
// navigates, and never in the window a person is reading.
//
// Owen, 2026-11-06: "every time I switch page my web cam turns off and comes back on". He was
// right, and it was structural: a media stream belongs to a DOCUMENT, so a camera opened by the
// server's page dies with that page. The e-server UI is server-rendered, so every navigation is a
// new document, which released the stream and reopened the device — an LED blinking at every
// click, and a feed that restarted on the dashboard he had just arrived at.
//
// So the device lives in this hidden window (main.cjs, `feedCaptureWindow()`, `show:false` with
// `backgroundThrottling:false`), which loads this preload once per connection and is never
// navigated. Proven before it was written: a hidden BrowserWindow holding getUserMedia produced
// real 640x480 JPEGs on every grab for nine seconds (measured 2026-11-06, /tmp/captest, fake
// device: frames 6554-9142 bytes, `hidden=true visible=false`).
//
// Nothing here decides when the feed runs: main.cjs owns the socket (desktop/live-feed.cjs) and
// sends three messages — begin (ask, open, report the two channel states), grab (one JPEG for one
// tick), stop (release) — and this document answers them and nothing else.
const {ipcRenderer}=require('electron');
 // ── THIS CLIENT'S CAMERA, AS A LIVE USER FEED ───────────────────────────────────────────────
 // Owen, 2026-11-06: "Each client connected to an e-server instance MUST access it's web camera and
 // create a stream on the e-server security dashboard ... while logged into e-app and connected to
 // their e-server instance". THE DEVICE IS OPENED HERE, AND THE SOCKET IS NOT: this window is the
 // renderer that has a camera and a person's attention, while the publish socket belongs to the
 // main process, which owns the connection (desktop/live-feed.cjs is theirs to drive — a sandboxed
 // preload cannot require a local module, and the protocol is one shipped, tested file).
 //
 // This half is only the device: it answers three messages — begin (ask, open, report the two
 // channel states), grab (one JPEG for one tick), stop (release) — and it never decides when the
 // feed runs. Nothing here draws chrome and nothing gates capture on a viewer: recording is
 // unconditional while connected, and the camera's own LED is the physical awareness (Owen cut
 // the indicator on 2026-11-06).
 const FRAME_WIDTH=640,FRAME_HEIGHT=480,FRAME_QUALITY=0.72;
 const media={video:null,canvas:null,context:null,streams:[]};
 //: The answer this document already gave, kept for the life of the document. A reconnect re-asks
 //: (the feed gives a new socket a new epoch), and re-asking must NOT open a second camera: the
 //: first stream was never released and the LED blinked for every drop (measured 2026-11-06).
 let mediaStates=null;
 function releaseMedia(){
  mediaStates=null;
  for(const stream of media.streams){try{stream.getTracks().forEach(track=>track.stop());}catch{}}
  media.streams=[];
  if(media.video){try{media.video.srcObject=null;}catch{}media.video=null;}
  media.canvas=null;media.context=null;
 }
 async function beginMedia(){
  // The device is already open for this document, so a reconnect re-uses it: no second
  // getUserMedia, no second stream left running, and no second permission question.
  if(mediaStates&&media.video&&media.streams.length)return mediaStates;
  // THE QUESTION FIRST (main.cjs owns it): a denial is reported as `denied`, never as an error and
  // never as silence, and nothing is inferred on the server side.
  let answer={camera:false,microphone:false};
  try{answer=await ipcRenderer.invoke('client:media-ask')||answer;}catch{answer={camera:false,microphone:false};}
  const result={camera:'denied',microphone:'denied',detail:''};
  if(answer.camera){
   try{
    const stream=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:FRAME_WIDTH},height:{ideal:FRAME_HEIGHT}},audio:false});
    media.streams.push(stream);
    const video=document.createElement('video');
    video.muted=true;video.playsInline=true;video.autoplay=true;video.srcObject=stream;
    await video.play();
    const canvas=document.createElement('canvas');
    canvas.width=video.videoWidth||FRAME_WIDTH;
    canvas.height=video.videoHeight||FRAME_HEIGHT;
    const context=canvas.getContext('2d',{alpha:false});
    if(!context)throw Error('no 2d context');
    media.video=video;media.canvas=canvas;media.context=context;
    result.camera='granted';
   }catch(error){
    // A granted permission with nothing behind it is GRANTED-NO-DEVICE, which the server's state
    // model keeps as its own state: it is not a denial and must never be shown as one.
    result.camera=error&&error.name==='NotAllowedError'?'denied':'granted-no-device';
    result.detail='camera: '+((error&&error.name)||'error')+(error&&error.message?': '+error.message:'');
   }
  }
  if(answer.microphone){
   // The server records video only today (`-an` in e_server/streaming/client_feed.py, a named
   // follow-up), so the microphone is PROVEN and then released rather than held open by an app
   // that is not sending it: the report says what the person allowed, and no device stays busy.
   try{
    const mic=await navigator.mediaDevices.getUserMedia({audio:true});
    try{mic.getTracks().forEach(track=>track.stop());}catch{}
    result.microphone='granted';
   }catch(error){
    result.microphone=error&&error.name==='NotAllowedError'?'denied':'granted-no-device';
    result.detail=(result.detail?result.detail+'; ':'')+'microphone: '+((error&&error.name)||'error');
   }
  }
  mediaStates=result;
  return result;
 }
 /** One frame for one tick: a JPEG ArrayBuffer, or null when there is nothing to draw. */
 function grabFrame(){
  const {video,canvas,context}=media;
  if(!video||!canvas||!context)return Promise.resolve(null);
  const width=video.videoWidth,height=video.videoHeight;
  if(!width||!height)return Promise.resolve(null);
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  return new Promise(resolve=>{
   try{
    context.drawImage(video,0,0,canvas.width,canvas.height);
    canvas.toBlob(blob=>{
     if(!blob)return resolve(null);
     const reader=new FileReader();
     reader.onload=()=>resolve(reader.result);
     reader.onerror=()=>resolve(null);
     reader.readAsArrayBuffer(blob);
    },'image/jpeg',FRAME_QUALITY);
   }catch{resolve(null);}
  });
 }
 ipcRenderer.on('client:feed-begin',event=>{
  beginMedia().then(states=>{
   try{ipcRenderer.send('client:feed-state',states);}catch{}
  }).catch(()=>{
   // beginMedia catches its own failures, so this is the end of the world rather than a normal
   // denial — and an unknown answer reports NOTHING: the server keeps the channels `pending`, which
   // is the honest state, instead of being told a state nobody measured.
   try{ipcRenderer.send('client:feed-state',{});}catch{}
  });
 });
 // EVERY TICK ASKS THIS DOCUMENT AND WAITS FOR THIS DOCUMENT'S ANSWER: the pacing lives in the
 // protocol, so a slow frame drops one frame instead of building a queue of stale ones.
 ipcRenderer.on('client:feed-grab',(event,id)=>{
  grabFrame().then(frame=>{
   try{ipcRenderer.send('client:feed-frame',id,frame);}catch{}
  }).catch(()=>{
   try{ipcRenderer.send('client:feed-frame',id,null);}catch{}
  });
 });
 ipcRenderer.on('client:feed-stop',()=>releaseMedia());
 // A document that is going away releases the device even if the last message was lost: the next
 // document is a new epoch, and a camera nobody is publishing must not stay open.
 window.addEventListener('pagehide',()=>{try{releaseMedia();ipcRenderer.send('client:feed-gone');}catch{}},{once:true});
