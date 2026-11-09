// THE ACCOUNT CONTROL, AS ONE MOUNTABLE OBJECT.
//
// This is site/web.js's control, lifted out unchanged so a SECOND first-party site can put the same
// button in its own header instead of growing a copy: the Easter Company corporate site imports this
// module from https://launcher.easter.company/account-control.mjs (GitHub Pages serves .mjs with
// `access-control-allow-origin: *`, measured 2026-10-27). One implementation, two sites - which is the
// rule Owen keeps paying for: the launcher's face, the site's face and the browser's face have to be
// the same face, and two copies of the precedence rules drift the first time one of them is edited.
//
// WHAT IS SHARED AND WHAT IS NOT. The control draws the button, the menu, My Profile, Linked
// Accounts and Sign out, and the face's three-step precedence (picture, then the head cropped from
// the Minecraft skin, then the letter tile). It takes the account seam as an argument, so the caller
// decides WHICH account client it talks to - the site's own module instance, or one the corporate page
// builds with its own registered Microsoft redirect URI. Its dynamic imports of company-profile.mjs are
// relative to THIS module's URL, so they resolve to the launcher origin wherever the control is mounted.
//
// Every rule this code enforces is stated where it was decided, in the comments below - they moved with
// the code rather than being summarised here.
import {createCompanyAuth} from './company-auth.mjs';

// THE THEME PUBLISHER, imported from the shared module so there is ONE implementation of
// "resolve this preference and publish it" — the panel's applyTheme and this both go through it.
// Loaded once, in parallel with the control's own wiring, and remembered; a host that mounts this
// control gets the account's theme without importing anything itself.
let publishTheme = null;
const publishThemeReady = import('./theme-publish.mjs').then(module => { publishTheme = module.publishTheme; }, () => { /* theme-publish.mjs is unreachable: nothing publishes a theme */ });
const publishThemeLater = theme => { if (publishTheme) publishTheme(theme); else void publishThemeReady.then(() => publishTheme?.(theme)); };

export async function mountAccountControl({nav, seam, auth: providedAuth = null, document: doc = globalThis.document, window: win = globalThis.window} = {}){
 if(!nav||!seam)return null;
 const webAccount=seam;
  // ---- The account control's face ----------------------------------------------
  // Owen, 2026-10-26, signed in on the live site: "there's no user image in the `oceaster` user
  // element"; and the next day, signed in on both surfaces: "I am logged in on both web and
  // launcher, but web shows the placeholder profile image while the launcher is showing my
  // minecraft skin based one." So this control draws the launcher's own three-step precedence
  // (site/desktop.js, "The player's face"), in the same order and ending where it already did:
  // the account's uploaded `picture`; else the head cropped here from the account's Minecraft
  // `skin`; else the deliberate teal letter tile.
  //
  // Both images reach this control only inside the account document, as data:image/png;base64
  // URIs - the cloud validates them into that form and publicAccount in
  // site/account-client.mjs keeps that form and drops any other - so the page shows a face it
  // already holds and asks nobody for one. That is not a shortcut. The launcher's first source,
  // sessionserver.mojang.com, answers a page with no Access-Control-Allow-Origin, so a browser's
  // own uuid-to-texture lookup fails as a CORS error before any JSON exists (measured in
  // Chromium at this origin, 2026-10-26: "TypeError: Failed to fetch" from sessionserver while
  // textures.minecraft.net itself answered). The whole texture travels to the page instead, and
  // the crop happens here.
  //
  // The tile is a primary state, not an edge case: the account wipe in flight keeps username,
  // password and roles and drops every provider link, so accounts arrive here with neither a
  // picture nor a Minecraft identity, and an account whose skin will not decode lands on the tile
  // too. That is the launcher's own last resort - #536b66 with the first letter of the name in
  // cream #eedbb2 - so one player sees one face on both surfaces.
  const account=doc.createElement('button');account.type='button';account.className='web-account-nav';account.disabled=true;
  // Fixed-size slot, absolutely positioned image inside it: whether the picture is absent,
  // loading, painted or failed, the control's box cannot move.
  const face=doc.createElement('span');face.className='web-account-face';face.setAttribute('aria-hidden','true');face.hidden=true;
  const initial=doc.createElement('span');initial.className='web-account-initial';
  // An empty alt plus the aria-hidden slot keep the control's name the account and never a
  // filename; the visible name stays the button's own text so nothing about it changes.
  const portrait=doc.createElement('img');portrait.className='web-account-picture';portrait.alt='';portrait.decoding='async';portrait.hidden=true;
  face.append(initial,portrait);
  const name=doc.createElement('span');name.className='web-account-name';name.textContent='Sign in';
  account.append(name,face);nav.append(account);
  // NAME THEN FACE, because this control only ever sits on the RIGHT of a header: the site's
  // header, the corporate site's header and the launcher's web surface all put it at the right
  // end of the nav. The face leads only where the button is on the left, which is e-server's
  // topbar, and e-server draws its own control (api/page_utils.py) rather than mounting this
  // one. Owen, 2026-10-28: "[ PROFILE_PICTURE DISPLAY_NAME ] but it should only appear this on
  // e-server because the button is on the left hand side ... on the right hand side ... should
  // be mirror [ DISPLAY_NAME PROFILE_PICTURE ]". The launcher's native window header already
  // appends name then face for the same reason (site/desktop.js:1139).
  // MANUAL, NOT AUTO. Owen, 2026-11-01: "clicking away or on other things doesn't close it,
  // and neither does clicking the user button again". An `auto` popover is light-dismissed by
  // the UA on the very press meant to toggle it, so the pill's own click handler saw a closed
  // menu and re-opened it: the menu could only be put away by an action that called
  // hidePopover() itself. A manual popover has no light dismiss to race, so this module owns
  // the three ways a person puts a menu away — the pill toggles, a press outside closes,
  // Escape closes — and it closes any other open popover when it opens, which is the one
  // behaviour auto was giving for free (Owen: "or open the menu drop down" closed it).
  const menu=doc.createElement('div');menu.id='web-account-menu';menu.className='desktop-profile-menu';menu.setAttribute('popover','manual');menu.setAttribute('aria-label','Account options');doc.body.append(menu);
  // THE IDENTITY PAIR LEADS THE MENU. Owen asked for the launcher's own pair - "OCEaster" over
  // "oceaster" - to reach "all other user drop downs across other platforms and interfaces"
  // (2026-10-30), and this menu is the drop down on both of the browser surfaces: the launcher's
  // site mounts this module, and easter.company imports it over the network. So the names are
  // drawn here, from the account document the control already holds, and neither surface grows a
  // copy of the rule that decides them.
  //
  // THE USERNAME IS NEVER GUESSED. It comes from the account document (`publicAccount` keeps it,
  // site/account-client.mjs) and is absent until the player claims one, which happens with the
  // first password; a fresh Microsoft signup therefore opens a one-line menu rather than a
  // second line reading `undefined`, an address, or a Company ID. An account whose display name
  // already IS its username does not print it twice - that is the launcher's own rule for its
  // own menu (site/desktop.js), and one player should read one menu.
  const identity=doc.createElement('div');identity.className='web-account-identity';identity.hidden=true;
  const identityName=doc.createElement('span');identityName.className='web-account-identity-name';
  const identityUser=doc.createElement('span');identityUser.className='web-account-identity-username';
  identity.append(identityName,identityUser);
  const identityRule=doc.createElement('hr');identityRule.className='web-account-menu-rule';identityRule.hidden=true;
  menu.append(identity,identityRule);
  // THE STYLESHEET COMES WITH THE MODULE, for the same reason: the corporate site cannot link a
  // file it does not host, and a rule added to this origin would otherwise reach only this
  // origin. The address is resolved against THIS module's own url, so it is one request to
  // launcher.easter.company whichever page mounted the control - the same rule its relative
  // imports already follow. One link per page, however many times a control is mounted.
  if(!doc.head.querySelector('link[data-account-control]')){
   const stylesheet=doc.createElement('link');stylesheet.rel='stylesheet';stylesheet.dataset.accountControl='';
   stylesheet.href=new URL('./account-control.css',import.meta.url).href;doc.head.append(stylesheet);
  }
  const notice=doc.createElement('p');notice.className='web-account-notice';notice.setAttribute('role','alert');notice.hidden=true;menu.append(notice);
  let current=webAccount.getState(),profile=null,linked=null;
  // Microsoft signs in on its own page. site/account/ is the address Microsoft sends the browser
  // back to, and is where a Company session for a Microsoft account is made; doc/BROWSER_SIGN_IN.md
  // in the cloud repository is the contract. Pressing the button in this dialog therefore starts
  // the flow here and sends the browser straight to Microsoft. It used to send it to
  // /account/?provider=microsoft first: one whole page load that answered nothing, and one the
  // Back button re-entered and re-started (Owen, 2026-10-26, after signing in for real: "too many
  // full page loads"). The address Microsoft is handed is the registered redirect either way, and
  // the answer is exchanged on /account/ whether the flow started there or here.
  //
  // LINKING IS THE SAME FLOW, NOT A LAUNCHER-ONLY ONE. Owen, 2026-11-01, pasting this dialog:
  // "we need to re-enable microsoft account linking across all surfaces." This wrapper used to
  // answer every `link` press here with "Connect Microsoft in the launcher.", so the Microsoft row
  // was a dead end on every web surface. It is not a second mechanism: the flow is the same one,
  // and what makes it a link is the session the seam carries to the exchange. The account service
  // applies a Microsoft proof to an account only when the proof OWNS it - a live session for that
  // same account is exactly that case (api/identity_store.login_microsoft, "what decides between
  // refusing a proof and repairing a link") - and a proof that resolves to a DIFFERENT Company
  // account is still refused with the conflict answer the launcher shows. So `link` is passed
  // down, never re-decided here.
  //
  // `started` is reported rather than assumed: a web surface sends the browser to Microsoft before
  // this answers, so the row that pressed Connect has no outcome to print and must not claim one.
  const signInMicrosoft=async options=>{
   const result=await webAccount.startMicrosoftSignIn({link:options?.link===true});
   if(result&&result.ok===false)return {ok:false,error:result.error};
   return result?.value?.started===true?{ok:true,started:true}:{ok:true};
  };
  // `startsOnPage` tells the dialog that pressing Microsoft begins the flow on the page the
  // player is on, so the dialog stays up and reports the start instead of closing first.
  // `auth` may be an instance this control did not build. The launcher WINDOW has opened its
  // sign-in chooser for years and everything that reaches it - the hero's sign-in action, the
  // access panel's password step, the identity-conflict stop - is wired to that one instance;
  // company-auth.mjs appends four dialogs with fixed ids when it is constructed, so a second
  // instance on the same page is a second set of those ids. A host that already owns one passes
  // it here and both the menu's sign-in and the window's keep talking to the same dialogs. This
  // is the only seam the window needed, and it changes nothing for a caller that passes none.
  const auth=providedAuth||createCompanyAuth({desktop:webAccount,signInMicrosoft,startsOnPage:true});
  const action=(label,fn)=>{const button=doc.createElement('button');button.type='button';button.textContent=label;button.onclick=()=>{menu.hidePopover();void fn();};menu.append(button);return button;};
  const options={desktop:webAccount,getState:()=>current,isAccountLocked:()=>current.accountWorking===true,cancelSignIn:()=>webAccount.cancelSignIn()};
  action('My Profile',async()=>{const {openMyProfile}=await import('./company-profile.mjs');profile=await openMyProfile({...options,openEmails:()=>auth.emails()});});
  action('Linked Accounts',async()=>{const {openLinkedAccounts}=await import('./company-profile.mjs');linked=await openLinkedAccounts({...options,signInMicrosoft});});
  // SETTINGS OPENS THE ACCOUNT-WIDE PANEL, HERE - not a link to e-server, which is a different
  // product on a different origin, and not a row that goes nowhere. The panel is
  // site/user-settings.mjs, ported from Diana's prototype, and it is the same component on both
  // surfaces: this import resolves against THIS module's url, so the corporate site loads it from
  // launcher.easter.company exactly as it loads the control itself.
  let settings=null;
  action('Settings',async()=>{
   const {openUserSettings}=await import('./user-settings.mjs');
   // The control the player pressed is the panel's opener, so closing it returns focus to the
   // pill rather than to the top of the document.
   settings=(await openUserSettings({seam:webAccount,opener:account}))||settings;
  });
  action('Sign out',async()=>{await webAccount.signOut();});
  // OPENING, CLOSING AND THE THREE WAYS A PERSON EXPECTS TO PUT IT AWAY.
  //
  // Owen, 2026-11-01: "opening the user drop down inside e-app, clicking away or on other
  // things doesn't close it, and neither does clicking the user button again - only way to
  // get rid of it is to select an option". Measured against this handler: the popover is
  // `auto`, so the browser light-dismisses it on the press that lands outside — and then
  // this very click handler called showPopover() again in the same gesture, so pressing the
  // pill re-opened what the browser had just closed. A press outside the popover on a page
  // that also re-opens on other events looked the same: shut one frame, open the next.
  //
  // So the control now owns the decision instead of racing the platform: the pill toggles,
  // a press anywhere outside the menu closes it, and Escape closes it and returns focus to
  // the pill. The native light-dismiss still runs underneath; these handlers agree with it
  // rather than fighting it, because every one of them only ever closes an open menu.
  const isOpen=()=>menu.matches(':popover-open');
  const closeMenu=(restoreFocus=false)=>{
   if(!isOpen())return;
   menu.hidePopover();
   if(restoreFocus)account.focus();
  };
  account.onclick=event=>{
   if(!current.account){auth.open();return;}
   if(current.account.passwordRequired){auth.setup();return;}
   // THE PILL TOGGLES — FOR A REAL GESTURE. Without this the press that light-dismissed
   // the popover also re-opened it, which is the bug Owen reported. But only a trusted
   // click toggles: an untrusted one is a synthetic dispatch (a test, a script, a helper
   // opening the menu for someone), and a toggle there means "open the menu" can silently
   // close it — which is exactly how this broke the dialog-parity suite when the toggle
   // landed (measured: passes at 719afe8bc0, fails after). A screen reader's activation is
   // a trusted click, so assistive users keep the toggle.
   if(isOpen() && event.isTrusted){event.preventDefault();closeMenu();return;}
   // ONE MENU AT A TIME. With no UA light dismiss nothing closes a second popover for us, so
   // opening this one puts every other open popover away first.
   doc.querySelectorAll(':popover-open').forEach(other=>{if(other!==menu)other.hidePopover();});
   menu.style.top=(account.getBoundingClientRect().bottom+8)+'px';menu.style.right=Math.max(12,win.innerWidth-account.getBoundingClientRect().right)+'px';
   menu.showPopover();menu.querySelector('button')?.focus();
  };
  // A press outside the menu closes it. `pointerdown` rather than `click`, so the menu is
  // already gone by the time the press lands on whatever is underneath - the same order a
  // native menu has, and the reason a click on another control cannot leave it hanging.
  doc.addEventListener('pointerdown',event=>{
   if(!isOpen())return;
   const target=event.target;
   if(menu.contains(target)||account.contains(target))return;
   closeMenu();
  },true);
  doc.addEventListener('keydown',event=>{
   if(event.key!=='Escape'||!isOpen())return;
   closeMenu(true);
  },true);
  // The face follows the account and only the account: while a sign-in is in flight there is no
  // account to show, so the slot is hidden and the control is exactly the text it always was.
  // The one other state is a boot that cannot paint yet (site/web-account.mjs: a saved session with
  // no stored document), and there the slot holds the Easter Company mark with no name beside it.
  let facePicture=null,faceGeneration=0;
  const firstLetter=value=>{
   const letter=[...String(value||'').trim()][0];
   return letter?letter.toUpperCase():'';
  };
  const setInitial=letter=>{initial.textContent=letter;face.classList.toggle('web-account-face-mark',!letter);};
  const showPicture=(src,pixelated=false)=>{
   // The cropped head is 32 canvas pixels of an 8x8 texture, and this slot is 16: the same
   // nearest-neighbour intent the launcher states for its own canvas (site/desktop.css,
   // image-rendering:pixelated). An uploaded picture keeps the ordinary smoothing a photograph
   // wants, so this is a class on this one source and not a rule on the image.
   portrait.classList.toggle('web-account-head',Boolean(src)&&pixelated);
   if(src===facePicture)return;
   facePicture=src;
   face.classList.remove('has-picture');
   if(!src){portrait.hidden=true;portrait.removeAttribute('src');return;}
   portrait.src=src;portrait.hidden=false;
  };
  // A picture that never arrives leaves the tile showing, at the same size, under the same name:
  // a face is never a reason to fail at anything, which is also the launcher's rule.
  portrait.onload=()=>face.classList.add('has-picture');
  portrait.onerror=()=>{portrait.hidden=true;face.classList.remove('has-picture');};
  // The head, cropped exactly as the launcher crops it (site/desktop.js:1251-1257): the skin's
  // 8x8 face at 8,8 and its 8x8 hat overlay at 40,8, each drawn into the same 32x32 canvas with
  // the hat painted over the face, nearest-neighbour, which is how the game renders a player's
  // head. A 64x32 skin of the old shape has both of those squares and crops identically. The
  // result is a data URL, so it travels back through the one image the slot already knows.
  const HEAD_CROP=32;
  const cropHead=skin=>new Promise((resolve,reject)=>{
   const image=new Image();
   image.onload=()=>{
    try{
     const canvas=doc.createElement('canvas');canvas.width=HEAD_CROP;canvas.height=HEAD_CROP;
     const ctx=canvas.getContext('2d');
     if(!ctx)throw Error('no canvas');
     ctx.imageSmoothingEnabled=false;
     ctx.drawImage(image,8,8,8,8,0,0,HEAD_CROP,HEAD_CROP);
     ctx.drawImage(image,40,8,8,8,0,0,HEAD_CROP,HEAD_CROP);
     const head=canvas.toDataURL('image/png');
     // A canvas that hands back nothing is the same answer as an image that would not decode:
     // no head, and the tile stays.
     if(!head.startsWith('data:image/png;base64,'))throw Error('no crop');
     resolve(head);
    }catch(error){reject(error);}
   };
   image.onerror=()=>reject(Error('the skin did not decode'));
   image.src=skin;
  });
  // One skin crops to one head, so the work is done once per skin: the control is painted again
  // on every account broadcast, and re-decoding the same texture each time would be wasted work
  // and a second asynchronous paint for nothing. The promise itself is what is remembered, so
  // two paints while a crop is in flight share it; a skin that cannot be decoded is remembered
  // as no head at all rather than retried on every broadcast.
  let headSkin=null,headPending=null;
  const headFor=skin=>{
   if(headSkin!==skin){headSkin=skin;headPending=cropHead(skin).catch(()=>'');}
   return headPending;
  };
  const showFace=(user,generation)=>{
   const picture=typeof user.picture==='string'?user.picture:'';
   if(picture){showPicture(picture);return;}
   const skin=typeof user.skin==='string'?user.skin:'';
   if(!skin){showPicture('');return;}
   void headFor(skin).then(head=>{if(generation===faceGeneration)showPicture(head,true);});
  };
  // The words 'Company member' are publicAccount's last resort for an account with no name at all
  // (site/account-client.mjs:274): it is a sentence, not a name, so it is never lettered.
  const GENERIC_NAME='Company member';
  const paintFace=next=>{
   const user=next.account;
   // A saved session this load cannot paint yet: the account exists and nothing else about it is
   // known, so the slot is the Easter Company mark and the control carries no name. It is never the
   // tile's letter, because no name has been read to take a letter from.
   const waiting=!user&&next.startupReady===false;
   // A crop still in flight belongs to the account this paint is replacing, and it must never
   // arrive on top of the next account's face: one counter, read once, decides that.
   const generation=++faceGeneration;
   face.hidden=!user&&!waiting;
   // The narrowest header gives the face the control and takes the name away; signed out there is
   // no face, so the name must stay - the control is never an empty box.
   account.classList.toggle('web-account-with-face',Boolean(user)||waiting);
   if(!user){setInitial('');showPicture(null);return;}
   const called=typeof user.name==='string'&&user.name!==GENERIC_NAME?user.name:'';
   // The letter is the display name's first character, then the Minecraft name's, then the
   // username's: the same order as the label, because `name` is that mapping. An account with no
   // name at all - the moment between a provider sign-in and a first name - is the mark, because
   // a C for 'Company member' would be a letter that means nothing.
   setInitial(firstLetter(called));
   showFace(user,generation);
  };
  const paint=next=>{
   current=next;auth.render(next);profile?.syncLock();linked?.syncLock();
   // A saved session that has not been read yet is the third state of this control, and it is the
   // one Owen met on a cold refresh: it says neither `Sign in`, which the seam would refuse to honour
   // ("Sign out before using another account.", site/web-account.mjs), nor a name it does not have.
   // It is the Easter Company mark, disabled, until /me settles. No new words: the accessible name is
   // the one the signed-in control uses, and the control says why it is inert with aria-busy.
   const waiting=!next.account&&next.startupReady===false;
   // The name the player is called, not the handle they type - the launcher's own rule (site/desktop.js,
   // accountName, after Owen's same report there on 2026-10-19): publicAccount gives the display
   // name, then the Minecraft name, then the username. Owen, 2026-10-26, on this site: the nav showed
   // `oceaster` where the launcher shows `OCEaster`.
   name.textContent=next.account?next.account.passwordRequired?'Finish setup':next.account.name||GENERIC_NAME:waiting?'':'Sign in';
   // The menu's two lines follow the same authority as the pill: the display name the player is
   // called, then the bare username they sign in with. A setup in progress is not an account yet,
   // so it gets no identity block - the dialog that is up asks for the username instead.
   const named=next.account&&!next.account.passwordRequired?next.account:null;
   identity.hidden=!named;
   identityRule.hidden=!named;
   if(named){
    identityName.textContent=named.name||GENERIC_NAME;
    const username=typeof named.username==='string'?named.username.trim():'';
    identityUser.textContent=username===identityName.textContent?'':username;
    identityUser.hidden=!identityUser.textContent;
   }
   paintFace(next);
   account.setAttribute('aria-label',waiting?'Account options':next.account?.passwordRequired?'Finish account setup':next.account?'Account options':'Sign in or create an Easter Company account');
   account.setAttribute('aria-busy',String(waiting));
   // WHAT THE BUTTON OPENS DEPENDS ON WHO IS SIGNED IN, so the attribute that promises it says
   // which: an account menu when there is an account, the sign-in chooser dialog when there is
   // not, and the same dialog for an account that still has to finish setup. Left implicit, a
   // reader learns nothing about what pressing it does — and a launcher journey that had always
   // asserted `dialog` here was right while the control was wrong (2026-10-30: 1.0.53's release
   // sweep stopped on exactly that assertion).
   account.setAttribute('aria-haspopup',next.account&&!next.account.passwordRequired?'menu':'dialog');
   account.setAttribute('aria-expanded',String(menu.matches(':popover-open')));
   account.disabled=next.accountWorking===true||waiting;
   if(!next.account&&!waiting){menu.hidePopover();doc.querySelector('#company-profile')?.close();doc.querySelector('#company-linked-accounts')?.close();
    // A panel about an account that has just gone has nothing left to edit: a signed-out save
    // could only be refused, and the honest thing is to close it rather than leave the player
    // typing into a document the session behind it no longer reaches.
    settings?.close();}
  };
  menu.addEventListener('toggle',()=>account.setAttribute('aria-expanded',String(menu.matches(':popover-open'))));
  webAccount.subscribe(paint);
  await webAccount.ready;paint(webAccount.getState());
  // THE PAGE'S THEME IS THE ACCOUNT'S, AND IT IS DECIDED HERE FOR EVERY HOST THAT MOUNTS THIS.
  // Until now the only thing that ever published `data-easter-theme` was the settings panel's
  // applyTheme(), which runs when the panel opens or a save lands — so a signed-in page whose
  // preference was `light` on a light OS painted dark until the player opened the panel, which
  // is exactly what Owen reported on easter.company (2026-10-30). The store is the account
  // document; this publishes it once per account state, without a panel and without a click.
  // Signing out puts the page back on `system`, because that is what a visitor without a
  // document is: the OS's own answer.
  const theme = publishAccountTheme({webAccount, doc, win});
 return {account, menu, paint, theme};
}

// A HOST MOUNTS THIS AND GETS THE PAGE'S THEME WITH IT. The seam is the only source: a signed-in
// page reads the account's saved Theme setting (`settingsRead()` — the same document the panel
// shows) and publishes its resolution; a signed-out page publishes `system`. Nothing is cached,
// written to storage or remembered between visits — the next load asks again, which is what makes
// a preference saved on another surface apply here on the next visit.
//
// WHAT IT RETURNS IS THE SEAM OTHER HOSTS NEED: `choice()` is `light`, `dark` or `system` (the
// PREFERENCE, which the published attribute cannot carry — `data-easter-theme` is resolved, so a
// page cannot tell `system` from a `dark` chosen on a dark OS), and `subscribe(fn)` hears every
// change. A host that needs the preference — the corporate page's hero, which must keep following
// the OS under `system` — takes it from here instead of calling `settingsRead()` a second time.
// That second read is not merely wasteful: the seam answers one account request at a time and
// refuses a concurrent one with "Another account request is in progress." (measured 2026-10-30,
// two readers on load), so two hosts asking is a refusal, not a duplicate answer.
function publishAccountTheme({webAccount, doc, win}) {
  const listeners = new Set();
  let choice = 'system';
  let seen;                              // the account id this state was decided for
  let settled;                           // resolves with the first answer, for a host that waits
  const mark = () => { for (const listener of listeners) { try { listener(choice); } catch { /* a host that throws is not this page's problem */ } } };
  const repaint = () => { publishThemeLater(choice); };
  const announce = next => {
    if (next === choice) return;
    choice = next;
    repaint();
    mark();
  };
  // `system` follows the OS for as long as it is the choice — including a change made while the
  // page is open, which is the whole point of `system` rather than a one-time guess.
  try {
    win.matchMedia?.('(prefers-color-scheme: light)')?.addEventListener?.('change', () => {
      if (choice !== 'system') return;      // an explicit choice is never overruled by the OS
      repaint();
      mark();
    });
  } catch { /* no media support: the resolved value stands */ }
  const read = async (attempt = 0) => {
    let theme = 'system';
    let retry = false;
    try {
      const answer = await webAccount.settingsRead();
      const stored = answer?.ok ? answer.value?.settings?.theme : null;
      if (stored === 'light' || stored === 'dark' || stored === 'system') theme = stored;
      // The seam serialises account requests; a read refused because the panel (or another host)
      // holds it is worth one more ask, not a page left on the wrong palette.
      else if (/in progress/i.test(String(answer?.error || ''))) retry = true;
    } catch { /* signed out, or the account service cannot answer: system */ }
    if (retry && attempt < 8) { setTimeout(() => { void read(attempt + 1); }, 150 * (attempt + 1)); return; }
    announce(theme);
    settled?.();
  };
  repaint();                              // no document yet, so `system`, before anything else
  try {
    webAccount.subscribe(state => {
      // The seam's public account document names the account as it likes (`id`, or a username for
      // an account that has not claimed one), so the key is "what identifies this session", not a
      // field this module guessed: any truthy identity means read the document, none means system.
      const key = state?.account ? (state.account.id ?? state.account.username ?? 'signed-in') : null;
      if (key === seen) return;
      seen = key;
      if (key === null) { if (choice !== 'system') { announce('system'); settled?.(); } else settled?.(); }
      else void read();
    });
  } catch { /* a seam without subscribe still gets the initial read below */ }
  void read();
  return {
    choice: () => choice,
    subscribe(listener) { listeners.add(listener); try { listener(choice); } catch { /* see mark() */ } return () => listeners.delete(listener); },
    ready: new Promise(resolve => { settled = resolve; }),
  };
}
