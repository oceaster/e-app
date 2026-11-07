#!/usr/bin/env node
'use strict';
/**
 * Fake llama-server for CI. Same CLI surface the runtime uses; behaviour is steered by env vars:
 *   FAKE_DELAY_MS            become healthy after N ms             FAKE_HANG=1             never healthy
 *   FAKE_OOM_ABOVE=cells     exit 1 with a CUDA OOM if -c > cells  FAKE_DIE_AFTER_MS=n     exit after n ms
 *   FAKE_BIND_FAIL_MARKER=f  first run: exit "couldn't bind" (creates f)
 *   FAKE_UNHEALTHY_AFTER_MS  /health turns 503 after n ms          FAKE_TOKEN_MS=n         per-token delay (default 5)
 *   FAKE_COMMIT              commit printed by --version
 */
const http = require('http');
const fs = require('fs');
const argv = process.argv.slice(2);
const E = process.env;
if (argv.includes('--version')) { process.stderr.write(`version: 1 (${E.FAKE_COMMIT || '43e865e'})\n`); process.exit(0); }
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const port = Number(arg('--port')); const key = arg('--api-key'); const c = Number(arg('-c', 4096)); const np = Number(arg('-np', 1));
const nCtx = Math.floor(c / np); const t0 = Date.now();
const log = (s) => process.stderr.write(`${s}\n`);

log(`main: llama-server fake starting, auth enabled with key ${key}`);
if (E.FAKE_BIND_FAIL_MARKER && !fs.existsSync(E.FAKE_BIND_FAIL_MARKER)) {
  fs.writeFileSync(E.FAKE_BIND_FAIL_MARKER, '1');
  log(`couldn't bind HTTP server socket, hostname: 127.0.0.1, port: ${port}`); process.exit(1);
}
if (E.FAKE_OOM_ABOVE && c > Number(E.FAKE_OOM_ABOVE)) { log('ggml_cuda_host_malloc: failed to allocate CUDA0 buffer: out of memory'); process.exit(1); }
log(`llama_kv_cache: size = ${Math.round(c * 20 / 1024)}.00 MiB (${c} cells)`);
if (E.FAKE_DIE_AFTER_MS) setTimeout(() => process.exit(0), Number(E.FAKE_DIE_AFTER_MS));

let active = 0; let lastPrompt = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tokMs = Number(E.FAKE_TOKEN_MS || 5);
const healthy = () => {
  if (E.FAKE_HANG) return false;
  const age = Date.now() - t0;
  if (age < Number(E.FAKE_DELAY_MS || 0)) return false;
  return !(E.FAKE_UNHEALTHY_AFTER_MS && age > Number(E.FAKE_UNHEALTHY_AFTER_MS));
};
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  if (req.url === '/health') return send(res, healthy() ? 200 : 503, { status: healthy() ? 'ok' : 'loading model' });
  if (req.headers.authorization !== `Bearer ${key}`) return send(res, 401, { error: { message: 'bad key' } });
  if (req.url === '/props') return send(res, 200, { total_slots: np, default_generation_settings: { n_ctx: nCtx } });
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(res, 404, {});
  let raw = '';
  req.on('data', (d) => { raw += d; });
  req.on('end', async () => {
    const body = JSON.parse(raw || '{}');
    const prompt = JSON.stringify(body.messages || []);
    const nPrompt = Math.ceil(prompt.length / 4);
    if (nPrompt > nCtx) return send(res, 400, { error: { code: 400, type: 'exceed_context_size_error', message: 'request exceeds the available context size', n_prompt_tokens: nPrompt, n_ctx: nCtx } });
    while (active >= np) await sleep(10); // only np concurrent generations
    active += 1;
    try {
      let p = 0; while (p < prompt.length && p < lastPrompt.length && prompt[p] === lastPrompt[p]) p += 1;
      lastPrompt = prompt;
      const timings = { cache_n: Math.floor(p / 4), prompt_n: nPrompt - Math.floor(p / 4) };
      const last = (body.messages || []).slice(-1)[0] || {};
      if (body.tools && last.role !== 'tool') {
        const call = { id: 'call_1', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"city":"Paris"}' } };
        return send(res, 200, { choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }], timings });
      }
      const n = Math.min(body.max_tokens || 8, 400);
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (let i = 0; i < Math.min(n, 6); i += 1) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'tok ' } }] })}\n\n`); await sleep(tokMs); }
        res.write('data: [DONE]\n\n'); return res.end();
      }
      await sleep(n * tokMs);
      return send(res, 200, { choices: [{ message: { role: 'assistant', content: 'ok '.repeat(Math.min(n, 8)) }, finish_reason: 'stop' }], timings, usage: { prompt_tokens: nPrompt } });
    } finally { active -= 1; }
  });
}).listen(port, '127.0.0.1');
