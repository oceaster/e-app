// Attribute-only integration: the adapter owns the root state and button clicks.
// This module only mirrors presentation state into native accessibility behaviour.
const root = document.documentElement;
const stage = document.getElementById('permission-stage');
const buttons = [...stage.querySelectorAll('[data-permission-answer]')];

function syncState() {
  const state = root.getAttribute('data-permission-state');
  const asking = state === 'asking';
  stage.inert = !asking;
  for (const button of buttons) button.disabled = !asking;
  stage.setAttribute('aria-busy', String(state === 'os-pending'));
}

// Observe before first sync so an adapter update cannot be missed.
new MutationObserver(syncState).observe(root, {
  attributes: true,
  attributeFilter: ['data-permission-state'],
});
syncState();

// Block stale activations even before the mutation observer's microtask runs.
// Asking clicks are untouched: direct and delegated adapter listeners both work.
stage.addEventListener('click', event => {
  if (root.getAttribute('data-permission-state') !== 'asking') {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
