'use strict';

// A document may replace itself (for example with the billing route) before
// Electron's original loadURL promise settles. That cancellation is not a
// failed connection. Genuine failures still reach the caller and the existing
// did-fail-load handler; the window's navigation/security policy is unchanged.
async function loadServerPage(window,url){
 try{return await window.loadURL(url);}
 catch(error){
  if(error?.errno===-3||error?.code==='ERR_ABORTED')return;
  throw error;
 }
}
const {pathToFileURL}=require('node:url');

// A LOCAL DOCUMENT THAT IS ALREADY SHOWING IS NOT A NEW QUESTION. `loadFile` finishes by
// emitting `did-finish-load`, and the connected window's handler asks whether the permission
// screen is needed; without this check that handler called `loadFile` again, so the screen
// reloaded itself as fast as it could load. Measured 2026-11-06 20:54: about 125 loads a second,
// each one resetting the page before a person could click Allow. The URL Electron reports is the
// exact `pathToFileURL` of the file, including the `.asar` path when packaged (verified against
// the installed 1.0.24 ASAR), so equality is the right test rather than a suffix guess.
function showingFile(window,file){
 try{return !!(window&&!window.isDestroyed()&&window.webContents.getURL()===pathToFileURL(file).href);}
 catch{return false;}
}
module.exports={loadServerPage,showingFile};
