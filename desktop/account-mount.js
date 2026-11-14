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
    node.dataset.accountAvatar = account.picture || '';
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
