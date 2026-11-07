'use strict';
// THE DEVICE-INSTANCE CAMERA RELATIONSHIP, AND NOTHING ELSE.
//
// Owen, 2026-11-06: "the device-instance permission relationship should be persistent and the
// user should not be prompted again." So this is a RELATIONSHIP, not a preference and not a
// question: this install's answer for one e-server, kept for ever, across restarts and sign-ins,
// and asked exactly once — the first time this device meets that instance. A second e-server is a
// different relationship and is asked once on its own, which is why the key is the ORIGIN.
//
// It lives in its own module, away from main.cjs, for one reason: a rule this small is the kind
// that rots silently. Here it is a pure function over the settings object, so
// tests/media-permission.test.cjs can hold it to its own words without an Electron window — and a
// future change that starts prompting again, or that reads "yes"/"true"/anything else as a grant,
// fails that gate instead of a person's evening.
//
// WHAT IT IS NOT: it is not the operating system's permission (that is asked by the OS and
// remembered by the OS), and it is not the server's trust decision (that is the account binding in
// e-server). It is only "did the person, on this device, answer this instance's camera question,
// and what did they say".

/** The only two answers this relationship has. Anything else on disk is not an answer. */
const DECISIONS = Object.freeze(['granted', 'denied']);

/** The decision this device has recorded for an instance, or '' when it has none. */
function decisionFor(settings, origin) {
  if (!origin) return '';
  const table = settings && typeof settings === 'object' ? settings.mediaPermissions : null;
  const row = table && typeof table === 'object' ? table[origin] : '';
  // Exact equality, never a truthy read: a file edited by hand, a half-written settings object or
  // an older shape must read as "never answered" rather than as consent.
  return DECISIONS.includes(row) ? row : '';
}

/** The settings object with this answer recorded. Returns a new object; the argument is untouched. */
function remember(settings, origin, decision) {
  const base = settings && typeof settings === 'object' ? settings : {};
  if (!origin || !DECISIONS.includes(decision)) return base;
  const table = base.mediaPermissions && typeof base.mediaPermissions === 'object' ? base.mediaPermissions : {};
  return { ...base, mediaPermissions: { ...table, [origin]: decision } };
}

/** True only for an answer that lets the camera and microphone open. */
function allowsMedia(settings, origin) {
  return decisionFor(settings, origin) === 'granted';
}

module.exports = { DECISIONS, decisionFor, remember, allowsMedia };
