'use strict';
// THE PENDING-INSTANCE POLL: it starts on a pending row, reads on a bounded interval, and stops
// the moment the service says nothing is pending. The clock and timers are injected, so this is
// proved without waiting ten minutes for a deadline. The refresh callback publishes its list
// through `observe`, exactly as desktop/main.cjs does, so the stop path is the product's.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInstancePoller, pending, DEFAULT_INTERVAL_MS, DEFAULT_LIMIT_MS } =
  require('../desktop/instances-poll.cjs');

const row = (status) => ({ id: 'cy', billing: { status } });

/** A manual clock, a timer queue, and a scripted list the refresh publishes. */
function harness({ fail = false } = {}) {
  let moment = 0;
  let nextId = 1;
  const timers = new Map();
  const refreshes = [];
  let script = [row('pending')];
  const poller = createInstancePoller({
    refresh: async () => {
      refreshes.push(moment);
      if (fail) throw Error('offline');
      poller.observe(script);
    },
    now: () => moment,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: moment + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const advance = async (ms) => {
    const target = moment + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      timers.delete(id);
      moment = timer.at;
      timer.fn();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    }
    moment = target;
  };
  return {
    poller, advance, refreshes, timers,
    setScript: (rows) => { script = rows; },
  };
}

test('a pending row starts a poll, and no pending row starts nothing', async () => {
  const { poller, advance, timers, refreshes } = harness();
  poller.observe([row('active')]);
  assert.equal(poller.active(), false, 'an active-only list polls nothing');
  assert.equal(timers.size, 0);

  poller.observe([row('pending')]);
  assert.equal(poller.active(), true, 'a pending row starts one timer');
  assert.equal(timers.size, 1);

  await advance(DEFAULT_INTERVAL_MS);
  assert.equal(refreshes.length, 1, 'one interval is one read');
  assert.equal(poller.active(), true, 'the pending list keeps the poll alive');
  assert.equal(timers.size, 1, 'and schedules exactly one next tick');
});

test('the poll stops itself when the service reports no pending row', async () => {
  const h = harness();
  h.poller.observe([row('pending')]);
  h.setScript([row('active'), row('canceling')]);
  await h.advance(DEFAULT_INTERVAL_MS);
  assert.equal(h.refreshes.length, 1, 'the tick made one read');
  assert.equal(h.poller.active(), false, 'the activated list stopped the poll');
  assert.equal(h.timers.size, 0, 'no timer survives');
});

test('the wait is bounded: the deadline ends the poll', async () => {
  const h = harness();
  h.poller.observe([row('pending')]);
  await h.advance(DEFAULT_LIMIT_MS - DEFAULT_INTERVAL_MS);
  assert.equal(h.poller.active(), true, 'still polling just before the bound');
  await h.advance(DEFAULT_INTERVAL_MS);
  assert.equal(h.poller.active(), false, 'the deadline ends the wait');
  assert.equal(h.timers.size, 0);
});

test('a failed refresh does not break the rhythm', async () => {
  const h = harness({ fail: true });
  h.poller.observe([row('pending')]);
  await h.advance(DEFAULT_INTERVAL_MS);
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.poller.active(), true, 'a refusal is retried until the bound');
  assert.equal(h.timers.size, 1);
});

test('a list with no billing field is not pending, and malformed rows are ignored', () => {
  assert.equal(pending(null), false);
  assert.equal(pending([]), false);
  assert.equal(pending([{ id: 'x' }, null]), false);
  assert.equal(pending([{ id: 'x', billing: { status: 'active' } }]), false);
  assert.equal(pending([{ id: 'x', billing: { status: 'pending' } }]), true);
});
