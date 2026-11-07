'use strict';
/**
 * context-window.cjs — reading llama-server's OWN refusal, for the main process.
 *
 * When a request does not fit, llama-server answers 400 with a parseable body instead of truncating
 * the person's text:
 *   { error: { type: 'exceed_context_size_error', message: …, n_prompt_tokens: N, n_ctx: M } }
 * An agent that sees this can compact and retry rather than fail. It lives HERE and not in the
 * preload because the preload is the security surface: desktop/bridge.test.cjs pins that preload.cjs
 * never mentions a credential-shaped word at all, and a renderer that needs this reads the response
 * body it already holds.
 */
function contextExceeded(body) {
  const error = body && body.error;
  if (!error) return null;
  if (error.type === 'exceed_context_size_error' || (/context/i.test(String(error.message || '')) && error.n_ctx !== undefined)) {
    return { nPrompt: error.n_prompt_tokens, nCtx: error.n_ctx };
  }
  return null;
}

module.exports = { contextExceeded };
