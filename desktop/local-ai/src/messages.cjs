'use strict';
/**
 * messages.cjs — WHAT A PERSON IS ALLOWED TO SEE WHEN SOMETHING FAILS.
 *
 * Owen, 2026-11-07: "in production mode these things should never have exposing error messages or
 * transparent whatevers". So in production every failure the person can reach is ONE PLAIN SENTENCE
 * plus ONE NEXT STEP. The detail — the stack, the argv, the path, an upstream body — goes to the log
 * and nowhere else. In debug the same failure carries all of it, because a maintainer needs it.
 *
 * Debugging changes DETAIL, never AUTHORITY: no message here grants a permission, reveals a secret, or
 * changes the shape of anything the page receives. `userFailure` cannot even carry detail — the object
 * it returns has three keys and no way to hold a stack.
 */
const SENTENCES = {
  E_MANIFEST: { message: 'The local model files are incomplete for this version.', next: 'Restart the app to download them again.' },
  E_DOWNLOAD: { message: 'The local model could not be downloaded.', next: 'Check your connection and try again.' },
  E_VERIFY: { message: 'A downloaded file did not match what this version expects.', next: 'Try again — the download starts over.' },
  E_PACK: { message: 'This version cannot run a local model on this computer.', next: 'Update the app to get the right files.' },
  E_MODEL: { message: 'The local model is not available for that setting.', next: 'Choose another tier, or update the app.' },
  E_NOT_INSTALLED: { message: 'The local model is not installed yet.', next: 'Download it from the local model panel.' },
  E_ENGINE_BUILD: { message: 'The installed local model engine is the wrong build.', next: 'Download it again from the local model panel.' },
  E_ENGINE_HASH: { message: 'The installed local model engine is damaged.', next: 'Download it again from the local model panel.' },
  E_TIMEOUT: { message: 'The local model did not start in time.', next: 'Close other apps that use the graphics card, then try again.' },
  E_EXIT: { message: 'The local model stopped unexpectedly.', next: 'Try again. If it keeps stopping, choose a lighter tier.' },
  E_BUSY: { message: 'The local model is already starting.', next: 'Wait a moment, then try again.' },
  E_INSECURE: { message: 'A download was refused for security reasons.', next: 'Update the app to get a valid download address.' },
  E_DEBUG_ONLY: { message: 'That information is only available in debug mode.', next: 'Start the app with --debug if you are maintaining it.' },
  DEFAULT: { message: 'Something went wrong with the local model.', next: 'Try again. The details are in the app log.' },
};

const CODE = /\b(E_[A-Z][A-Z0-9_]{2,})\b/;

/** The `E_…` code a failure names, or '' when it names none. Never the prose around it. */
function codeOf(error) {
  const text = typeof error === 'string' ? error : (error && error.message) || '';
  const found = CODE.exec(String(text));
  return found ? found[1] : '';
}

/**
 * WHAT A PERSON SEES — in production and in debug alike. Three keys, no `detail`, so a page, a dialog
 * or a status object built from it cannot carry a stack, a path, an argv or an upstream body.
 */
function userFailure(error, { code, message, next } = {}) {
  const named = code || codeOf(error);
  const known = SENTENCES[named] || SENTENCES.DEFAULT;
  return {
    code: named || 'E_UNKNOWN',
    message: message || known.message,
    next: next || known.next,
  };
}

/**
 * THE DETAIL, FOR THE LOG ONLY. Production gets the sentence (a log line is still useful, and still
 * says nothing a page would print); debug gets the whole failure, stack included.
 */
function detailFor(error, debug = false) {
  if (debug) {
    const text = typeof error === 'string' ? error : (error && (error.stack || error.message)) || String(error || '');
    return text;
  }
  return userFailure(error).message;
}

/** Strip api keys and long hex secrets from anything that reaches a log line. */
function redact(text) {
  return String(text == null ? '' : text)
    .replace(/(--api-key[\s=]+)\S+/gi, '$1***')
    .replace(/\b(?:sk|pk|tok)_[A-Za-z0-9_-]{8,}/g, '***')
    .replace(/\b[0-9a-f]{32,}\b/gi, '***');
}

module.exports = { SENTENCES, codeOf, userFailure, detailFor, redact };
