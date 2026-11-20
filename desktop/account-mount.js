/* Mount the household's own account control (api/profile_assets/account-host.mjs) after
   e-app has told this document who is signed in. External, not inline: the chrome's CSP is
   `script-src 'self'` and an inline module is refused. */
(async function () {
  var account = window.__eappAccount;
  if (!account) {
    account = await new Promise(function (resolve) {
      var done = false;
      function finish(value) { if (done) return; done = true; resolve(value || null); }
      window.addEventListener('e-app:account', function (event) { finish(event.detail); }, { once: true });
      setTimeout(function () { finish(window.__eappAccount); }, 1500);
    });
  }
  var node = document.querySelector('.topbar-account');
  if (node && account) {
    node.dataset.accountName = account.name || account.username || '';
    node.dataset.accountUsername = account.username || '';
    // THE INSTANCE'S OWN FACE ROUTE, not only the account document's picture. That route
    // resolves the same precedence every e-server surface uses (uploaded photo, Company
    // picture, Minecraft head, letter tile); the Company document has no skin field on this
    // seam, so using `account.picture` alone left a Minecraft-only account on the letter tile.
    // The Company client spells its account id `EC-3`; this server's profile key is `3`.
    const profileId = String(account.id || '').replace(/^EC-/i, '');
    // PRIORITY 1 IS THE UPLOADED PHOTO, and the Company document already carries it as the
    // data URI the control can paint. Use it first; the instance's avatar route (which also
    // resolves an e-server upload and the Minecraft head) is the fallback when there is no
    // uploaded photo. This also keeps the connected pill on the same face the setup pill uses.
    const photo = typeof account.picture === 'string'
      && account.picture.startsWith('data:image/png;base64,') ? account.picture : '';
    // PRIORITY 2 REQUIRES A CONNECTED MICROSOFT ACCOUNT. The route can resolve a stored
    // Minecraft head, but a skin without that link is not the person's verified face here.
    const linked = account.microsoftLinked === true;
    node.dataset.accountAvatar = photo || (linked && profileId
      ? '/profiles/avatar/' + encodeURIComponent(profileId)
      : '');
    // The dialogs read the public account document, including providers and details, on their
    // first paint. E-app's account object already is that document; carry only its public half.
    node.dataset.account = JSON.stringify({
      id: account.id, username: account.username, name: account.name,
      picture: account.picture || null, providers: account.providers || [],
      microsoftLinked: account.microsoftLinked === true,
      providerDetails: account.providerDetails || null,
      minecraftName: account.minecraftName || null
    });
  }
  await import('/profiles/assets/account-host.mjs');
})();
