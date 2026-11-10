'use strict';
// A PAID INSTANCE BECOMES ACTIVE WHILE THE PERSON IS LOOKING AT THE MENU.
//
// The create page opens Stripe Checkout in the person's own browser; the app cannot see the
// payment. The subscription's activation arrives at the webhook, so the row's `billing.status`
// stays `pending` until the next read. Asking once would usually be too early: a test-mode card
// clears in seconds, a real one can take longer. So while at least one row is `pending`, this
// polls the account's instances on a fixed interval, bounded by a deadline, and stops the moment
// no row is pending. It is a view refresh, not a state machine: the service remains the only
// author of the status.
//
// The clock and the timers are injected, so the behaviour is proved without waiting in a test.
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_LIMIT_MS = 10 * 60 * 1000;

function pending(rows) {
  return Array.isArray(rows) && rows.some((row) => row && row.billing && row.billing.status === 'pending');
}

/**
 * @param {{refresh:Function, intervalMs?:number, limitMs?:number, now?:Function,
 *          setTimeout?:Function, clearTimeout?:Function}} options
 * @returns {{observe:Function, stop:Function, active:Function}}
 *   `observe(rows)` is called after every published list. It starts the poll when a row is
 *   pending, and stops it when none is (or the deadline passed).
 */
function createInstancePoller({ refresh, intervalMs = DEFAULT_INTERVAL_MS,
  limitMs = DEFAULT_LIMIT_MS, now = Date.now,
  setTimeout: schedule = setTimeout, clearTimeout: cancel = clearTimeout } = {}) {
  if (typeof refresh !== 'function') throw Error('an instance poller needs a refresh function');
  let timer = null;
  let deadline = 0;
  let wanted = false;

  function stop() {
    if (timer !== null) cancel(timer);
    timer = null;
    wanted = false;
    deadline = 0;
  }

  function active() {
    return timer !== null;
  }

  function scheduleNext() {
    if (timer !== null || !wanted) return;
    if (now() >= deadline) return stop();
    timer = schedule(tick, intervalMs);
  }

  function tick() {
    timer = null;
    if (!wanted) return;
    if (now() >= deadline) return stop();
    Promise.resolve()
      .then(() => refresh())
      .catch(() => {})
      .then(() => {
        // `observe` runs from the refresh's own publisher and has the last word: if the rows
        // are no longer pending it calls stop(), and nothing here restarts it.
        if (wanted) scheduleNext();
      });
  }

  function observe(rows) {
    wanted = pending(rows);
    if (!wanted) return stop();
    if (deadline === 0) deadline = now() + limitMs;
    scheduleNext();
  }

  return { observe, stop, active };
}

module.exports = { createInstancePoller, pending, DEFAULT_INTERVAL_MS, DEFAULT_LIMIT_MS };
