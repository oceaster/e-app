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
module.exports={loadServerPage};
