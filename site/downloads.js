/* Shared e-server installer control, used by e-server and easter.company. */
(()=>{
 'use strict';
 const BASE='https://github.com/oceaster/e-app/releases/latest/download/';
 const platforms=[
  {id:'windows',name:'Windows 10+',file:'Easter-e-server-Windows-x64.exe',type:'Windows installer · x64',instructions:'Run the installer and choose your installation folder and shortcuts. This installer is not code-signed: Windows SmartScreen may show “Windows protected your PC”. Confirm you downloaded it from oceaster/e-app before choosing More info → Run anyway.'},
  {id:'ubuntu',name:'Ubuntu',file:'Easter-e-server-Linux-amd64.deb',type:'Debian package · amd64',instructions:'Install the package from your Downloads folder with your software installer, or run:',command:'sudo apt install "$HOME/Downloads/Easter-e-server-Linux-amd64.deb"'},
  {id:'arch',name:'Arch Linux',file:'Easter-e-server-Linux-x64.pacman',type:'Pacman package · x64',instructions:'Install the package from your Downloads folder with:',command:'sudo pacman -U "$HOME/Downloads/Easter-e-server-Linux-x64.pacman"'},
  {id:'appimage',name:'Linux AppImage',file:'Easter-e-server-Linux-x86_64.AppImage',type:'Portable Linux app · x86_64',instructions:'Mark the file in your Downloads folder executable, then run it. Some distributions need FUSE 2 support (libfuse2 or libfuse2t64 on Ubuntu).',command:'chmod +x "$HOME/Downloads/Easter-e-server-Linux-x86_64.AppImage"\n"$HOME/Downloads/Easter-e-server-Linux-x86_64.AppImage"'}
 ];
 const element=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;};
 function preferred(){const ua=navigator.userAgent;if(/Windows NT/.test(ua))return platforms[0];if(/Linux/.test(ua)&&!/Android/.test(ua))return platforms[3];return null;}
 let dialog;
 function instructions(platform){
  if(!dialog){dialog=element('dialog','eserver-install');dialog.innerHTML='<form method="dialog"><header><h2></h2><button aria-label="Close installation instructions" value="close">×</button></header><p class="eserver-install-type"></p><p class="eserver-install-help"></p><pre hidden></pre><ol><li>Install and open e-server.</li><li>Connect to your server’s private network or VPN.</li><li>Enter your e-server address, then verify your PIN and Easter Company account.</li></ol><p class="eserver-install-note">The app keeps its desktop client up to date automatically. A newer Electron runtime is installed through a new installer. macOS and mobile devices are not supported.</p><footer><a target="_blank" rel="noopener" class="eserver-redownload">Download again ↗</a><button value="close">Done</button></footer></form>';document.body.append(dialog);}
  dialog.querySelector('h2').textContent='Install e-server on '+platform.name;dialog.querySelector('.eserver-install-type').textContent=platform.type;dialog.querySelector('.eserver-install-help').textContent=platform.instructions;
  const code=dialog.querySelector('pre');code.hidden=!platform.command;code.textContent=platform.command||'';
  dialog.querySelector('.eserver-redownload').href=BASE+platform.file;dialog.showModal();
 }
 function mount(host){
  if(host.dataset.mounted)return;host.dataset.mounted='true';host.classList.add('eserver-download');
  const selection=preferred(),label=host.dataset.label||'Download e-server client';
  const primary=element(selection?'a':'button','eserver-download-primary',label);
  if(selection){primary.href=BASE+selection.file;primary.target='_blank';primary.rel='noopener';primary.addEventListener('click',()=>instructions(selection));}else primary.type='button';
  const details=element('details','eserver-download-picker'),summary=element('summary','','⌄');summary.setAttribute('aria-label','Choose e-server desktop platform');
  const menu=element('div','eserver-download-menu');menu.setAttribute('role','group');menu.setAttribute('aria-label','Desktop installers');
  for(const platform of platforms){const link=element('a');link.href=BASE+platform.file;link.target='_blank';link.rel='noopener';link.append(element('strong','',platform.name),element('small','',platform.type));link.onclick=()=>{details.open=false;instructions(platform);};menu.append(link);}
  details.append(summary,menu);if(!selection)primary.onclick=()=>{details.open=!details.open;};host.append(primary,details);
  details.addEventListener('keydown',event=>{if(event.key==='Escape'){details.open=false;summary.focus();}});
  document.addEventListener('click',event=>{if(!host.contains(event.target))details.open=false;});
 }
 document.querySelectorAll('[data-eserver-download]').forEach(mount);
 window.EServerDownloads=Object.freeze({mount,platforms:platforms.map(({id,name,file})=>({id,name,file}))});
})();
