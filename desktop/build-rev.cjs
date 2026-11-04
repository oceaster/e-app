'use strict';
// WHICH BUILD IS THIS WINDOW SHOWING, AND WHICH ONE IS THE SERVER SERVING?
//
// Owen, 2026-11-03, twice in one evening: a fix was shipped, deployed and verified, and his
// window kept drawing the OLD editor, because an open page keeps the client JavaScript it
// loaded. `e-app 1.0.12` carries no editor code at all - it displays the server's page - so the
// only thing that can notice a replaced build is the app, comparing what the document it holds
// was built from against what the server says today.
//
// THE REV, AND WHY IT IS NOT A TIMESTAMP. The harness injects its composed client graph into
// index.html as `window.__AGENT_HARNESS_BOOT__ = {"rev":"<sha1-12>","entries":[...]}` right
// before the shell reads it (harness/packages/client/modules/src/index.ts:252 injectBootManifest
// and :428 compose, where `rev` is the sha1-12 of the composed entry list - every row carries its
// own bundle's content hash as `?rev=<sha1-12>`). So:
//
//   loaded  = `window.__AGENT_HARNESS_BOOT__.rev` read out of the document this window holds;
//   current = the same field, parsed out of the page the server serves NOW, fetched with the
//             person's own session cookie and with the cache bypassed.
//
// Both sides are the server's own statement about a build, neither is a clock, and neither is
// guessed from a date. Equal revs -> this window is current and nothing is said. Different revs
// -> the page predates the deploy and the person is offered a reload. Anything unreadable on
// EITHER side -> `unknown` -> silence, because that is what every other cloud-optional path in
// this client does when the server does not answer.
//
// THE TWO HARNESS-RESTART SHAPES, and why neither can produce a false claim:
//   * a plain service restart (systemctl restart, a crash, a redeploy of the same commit) serves
//     the SAME bundles, so the composed graph and its rev are unchanged, and the comparison is
//     `current` -> silence. The rev is derived from bundle content, not from a process start.
//   * a deploy that rebuilds a client bundle changes that bundle's content hash, which moves the
//     row's `?rev=`, which moves the graph rev - and only then are the two sides different.
//
// WHAT IT COSTS, PER INTERVAL. One `GET <origin>/` with `cache: 'no-store'` (the page is tens of
// kilobytes, on the connection the app already keeps) plus one `executeJavaScript` that reads a
// twelve-character string out of the page. No filesystem read, no second socket, no polling of
// anything else, and never more than one check in flight. BUILD_CHECK_MS is the whole frequency.
//
// THE FETCH ONLY SEES A BOOT GRAPH WHEN THE PERSON'S PIN SESSION IS LIVE: an unauthenticated `/`
// answers the PIN page (measured 2026-11-04: 401, no `__AGENT_HARNESS_BOOT__` in 4583 bytes), so
// a locked or signed-out window reads `unknown` and stays silent rather than claiming staleness.
const {HEADER,CLIENT}=require('./security.cjs');

/** How often the app asks the server which build it serves. Two minutes: a person who just
 *  deployed is looking at the window, and a page that is two minutes behind is still worth
 *  saying so. Named here rather than at the call site, so the cost is one number to read. */
const BUILD_CHECK_MS=2*60*1000;
/** One read, bounded. The server is a machine on the same network and answers in milliseconds;
 *  eight seconds is a broken link, not a slow page, and an unanswered check is `unknown`. */
const BUILD_FETCH_MS=8000;
/** The injected boot manifest's assignment. `<` is escaped inside the JSON (injectBootManifest),
 *  so the captured text can never contain `</script>` and this boundary is exact. */
const BOOT_MANIFEST=/window\.__AGENT_HARNESS_BOOT__\s*=\s*([\s\S]*?)<\/script>/;
/** A rev is the harness's shortened sha1. Anything else is not this app's to compare. */
const REV_SHAPE=/^[0-9a-f]{8,40}$/;

/**
 * The build a served document states it was composed from, or '' when the document states none.
 * Never throws: an unreadable page is an absent answer, not a broken check.
 * @param {string} html - the whole served document.
 * @returns {string} the graph rev, or ''.
 */
function revOf(html){
 const match=String(html||'').match(BOOT_MANIFEST);
 if(!match)return '';
 let graph;try{graph=JSON.parse(match[1]);}catch{return '';}
 const rev=graph&&typeof graph.rev==='string'?graph.rev.trim():'';
 return REV_SHAPE.test(rev)?rev:'';
}

/**
 * The decision, and it is three-valued on purpose: silence is a state, not an empty string.
 * @param {string} loaded - the rev of the document this window holds.
 * @param {string} current - the rev the server serves now.
 * @returns {'current'|'stale'|'unknown'} `unknown` whenever either side is missing, which is the
 *   only honest answer to "is this page older?" when one of the two builds cannot be named.
 */
function decide(loaded,current){
 const left=typeof loaded==='string'?loaded.trim():'';
 const right=typeof current==='string'?current.trim():'';
 if(!left||!right)return 'unknown';
 return left===right?'current':'stale';
}

/**
 * The rev the server serves RIGHT NOW, read through the person's own session.
 *
 * `cache:'no-store'` plus `no-cache`/`pragma` request headers are the whole point: the window's
 * partition keeps the HTTP cache across a quit and reopen (desktop/main.cjs's partition), so a
 * cached read of `/` would answer the OLD build for as long as its headers allow and the check
 * would never fire on the one machine that matters - the one that has been open all evening.
 *
 * @param {object} session - the Electron session that holds the PIN cookie.
 * @param {string} origin - the connected e-server.
 * @param {{timeout?:number}} [options]
 * @returns {Promise<string>} the rev, or '' for any refusal, error or timeout.
 */
async function fetchRev(session,origin,{timeout=BUILD_FETCH_MS}={}){
 if(!session||!origin)return '';
 try{
  const response=await session.fetch(String(origin)+'/',{
   method:'GET',credentials:'include',cache:'no-store',
   headers:{[HEADER]:CLIENT,'Cache-Control':'no-cache','Pragma':'no-cache'},
   signal:AbortSignal.timeout(timeout)
  });
  if(!response||!response.ok)return '';
  return revOf(await response.text());
 }catch{return '';}
}

/**
 * The window's build watch: one interval, one comparison, and the two things a person may do
 * about it. It owns no Electron object - the caller supplies how to read its own document, how to
 * tell its renderer, and how to reload - so the same code runs in main.cjs and in the gate.
 */
class BuildWatch{
 /**
  * @param {object} options
  * @param {object} options.session - the Electron session of the window.
  * @param {string} options.origin - the connected e-server.
  * @param {()=>Promise<string>} options.read - the rev of the document the window holds.
  * @param {(state:{state:string,server:string,loaded:string,current:string})=>void} options.notify
  * @param {()=>void} options.reload - apply the current build in place.
  * @param {(session:string,origin:string,options:object)=>Promise<string>} [options.rev]
  * @param {number} [options.interval]
  * @param {Function} [options.tick] - setInterval, injectable so a test owns time.
  * @param {Function} [options.stopTick] - clearInterval.
  */
 constructor({session,origin,read,notify,reload,rev=fetchRev,interval=BUILD_CHECK_MS,tick=setInterval,stopTick=clearInterval}){
  this.session=session;this.origin=origin;this.read=read;this.notify=notify;this.reload=reload;
  this.rev=rev;this.interval=interval;this.tick=tick;this.stopTick=stopTick;
  this.timer=null;this.busy=false;this.dismissed='';this.verdict='unknown';
 }
 /** The sentence this window is showing, for a caller that wants to know: 'current', 'stale' or
  *  'unknown'. Silence is `current` and `unknown` both, and this is not what the person sees. */
 get state(){return this.verdict;}
 start(){
  if(this.timer)return this;
  this.timer=this.tick(()=>void this.check(),this.interval);
  // The interval must never be the reason the app stays open: the window is the reason.
  if(this.timer&&typeof this.timer.unref==='function')this.timer.unref();
  return this;
 }
 stop(){if(this.timer)this.stopTick(this.timer);this.timer=null;return this;}
 /**
  * One comparison. Answers the verdict, and never rejects: this runs on a timer inside an app
  * whose window may be gone by the time the fetch comes back.
  * @returns {Promise<'current'|'stale'|'unknown'>}
  */
 async check(){
  if(this.busy)return this.verdict;
  this.busy=true;
  try{
   let loaded='';
   try{loaded=(await this.read())||'';}catch{loaded='';}
   const current=await this.rev(this.session,this.origin);
   let verdict=decide(loaded,current);
   // A dismissal belongs to the build it was made about: dismissing this page's line must not
   // silence the NEXT build, and must not survive the reload that makes the claim untrue.
   if(verdict==='stale'&&loaded&&loaded===this.dismissed)verdict='current';
   if(verdict==='current')this.dismissed='';
   this.verdict=verdict;
   this.emit({state:verdict,loaded,current});
   return verdict;
  }catch{
   this.verdict='unknown';
   this.emit({state:'unknown',loaded:'',current:''});
   return 'unknown';
  }finally{this.busy=false;}
 }
 /** The person said "not now": the line goes away and STAYS away for the build it was about.
  *  A later check that finds the same pair stays silent; a newer build on the server (or a
  *  reload that makes the window current) clears the refusal, so it can never become a
  *  permanent blind spot. */
 dismiss(){
  const loaded=this.loaded||'';
  if(loaded)this.dismissed=loaded;
  this.verdict='current';
  this.emit({state:'current',loaded,current:this.current||''});
  return this;
 }
 /** The person asked for the current build: the caller reloads the window in place. */
 async refresh(){this.dismissed='';this.verdict='unknown';this.emit({state:'current',loaded:'',current:''});this.reload();return this;}
 emit(value){
  this.loaded=value.loaded;this.current=value.current;
  try{this.notify(value);}catch{}
 }
}
module.exports={BUILD_CHECK_MS,BUILD_FETCH_MS,revOf,decide,fetchRev,BuildWatch};
