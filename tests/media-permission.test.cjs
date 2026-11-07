'use strict';
// The device-instance camera relationship: asked once, remembered for ever, per instance.
// Owen, 2026-11-06: "the device-instance permission relationship should be persistent and the user
// should not be prompted again."
const test = require('node:test');
const assert = require('node:assert');
const { decisionFor, remember, allowsMedia } = require('../desktop/media-permission.cjs');

const ONE = 'https://easter-server.example';
const TWO = 'https://second-instance.example';

test('a device that has never answered has no decision, so the screen is shown', () => {
  assert.equal(decisionFor({}, ONE), '');
  assert.equal(decisionFor(undefined, ONE), '');
  assert.equal(decisionFor({}, ''), '', 'no origin is no relationship');
});

test('an answer is remembered exactly, both ways', () => {
  const granted = remember({}, ONE, 'granted');
  assert.equal(decisionFor(granted, ONE), 'granted');
  assert.equal(allowsMedia(granted, ONE), true, 'granted opens the camera');
  const denied = remember({}, ONE, 'denied');
  assert.equal(decisionFor(denied, ONE), 'denied');
  assert.equal(allowsMedia(denied, ONE), false, 'a remembered no is never a yes');
});

test('the relationship is per instance, not per app', () => {
  const settings = remember(remember({}, ONE, 'granted'), TWO, 'denied');
  assert.equal(decisionFor(settings, ONE), 'granted');
  assert.equal(decisionFor(settings, TWO), 'denied');
  assert.equal(decisionFor(settings, 'https://third.example'), '', 'a new instance is asked once');
});

test('nothing but the two answers is ever read as consent', () => {
  for (const value of ['yes', 'true', 1, true, 'GRANTED', 'allow', null, '']) {
    assert.equal(decisionFor({ mediaPermissions: { [ONE]: value } }, ONE), '',
      `${JSON.stringify(value)} is not an answer`);
  }
});

test('a junk answer is not written, and remembering never mutates its input', () => {
  const before = { server: ONE, mediaPermissions: { [ONE]: 'denied' } };
  const after = remember(before, ONE, 'granted');
  assert.equal(before.mediaPermissions[ONE], 'denied', 'the argument is untouched');
  assert.equal(decisionFor(after, ONE), 'granted');
  assert.equal(after.server, ONE, 'unrelated settings survive');
  assert.equal(remember(before, ONE, 'maybe'), before, 'only the two answers are stored');
});
