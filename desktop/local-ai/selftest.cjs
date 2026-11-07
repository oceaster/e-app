'use strict';
/**
 * Proofs Dexter needs on the REAL build before anything is built on top of it:
 *   props/ctx, context-exceeded refusal, streaming, tool-call round trip, parallel slots, prompt-cache reuse.
 * Usage: node selftest.cjs <baseUrl> <apiKey> [ctxPerSlot]      (or call runSelfTest from main)
 */
async function runSelfTest({ baseUrl, apiKey, ctx = 8192 }) {
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  const chat = (body) => fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: H, body: JSON.stringify({ model: 'dory', temperature: 0, ...body }) });
  const results = [];
  const check = async (name, fn) => {
    const t = Date.now();
    try { const detail = await fn(); results.push({ name, pass: true, detail, ms: Date.now() - t }); }
    catch (e) { results.push({ name, pass: false, detail: e.message, ms: Date.now() - t }); }
  };
  const need = (c, msg) => { if (!c) throw new Error(msg); };
  const user = (content) => [{ role: 'user', content }];

  await check('effective context reported', async () => {
    const r = await fetch(baseUrl.replace(/\/v1$/, '/props'), { headers: H });
    const j = await r.json();
    const n = j.default_generation_settings && j.default_generation_settings.n_ctx;
    need(n > 0, '/props did not report n_ctx');
    return `n_ctx per slot = ${n}${j.total_slots ? `, slots = ${j.total_slots}` : ''}`;
  });

  await check('context exceeded is a real, parseable refusal', async () => {
    const r = await chat({ messages: user('lorem '.repeat(ctx * 2)), max_tokens: 4 });
    const j = await r.json().catch(() => ({}));
    need(r.status === 400, `expected HTTP 400, got ${r.status}`);
    need(j.error && (j.error.type === 'exceed_context_size_error' || /context/i.test(j.error.message || '')), `unexpected error body: ${JSON.stringify(j).slice(0, 160)}`);
    return `400 ${j.error.type || ''} n_prompt_tokens=${j.error.n_prompt_tokens} n_ctx=${j.error.n_ctx}`;
  });

  await check('streaming', async () => {
    const r = await chat({ messages: user('count to five'), max_tokens: 16, stream: true });
    const text = await r.text();
    const chunks = text.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'));
    need(chunks.length >= 2, `only ${chunks.length} SSE chunk(s)`);
    need(text.includes('[DONE]'), 'no [DONE] terminator');
    return `${chunks.length} chunks`;
  });

  await check('tool calling round-trips through the chat template', async () => {
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Get weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const first = await (await chat({ messages: user('What is the weather in Paris? Use the tool.'), tools, max_tokens: 128 })).json();
    const call = first.choices && first.choices[0].message.tool_calls && first.choices[0].message.tool_calls[0];
    need(call && call.function && call.function.name === 'get_weather', 'model did not emit a tool call');
    JSON.parse(call.function.arguments);
    const second = await (await chat({ tools, max_tokens: 64, messages: [
      ...user('What is the weather in Paris? Use the tool.'),
      { role: 'assistant', content: null, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: '{"temp_c":18}' },
    ] })).json();
    need(second.choices && second.choices[0].message.content, 'no final answer after tool result');
    return `called ${call.function.name}(${call.function.arguments})`;
  });

  await check('parallel slots: a long turn does not block chat', async () => {
    const t0 = Date.now();
    const longP = chat({ messages: user('write a long story'), max_tokens: 200 }).then((r) => r.json()).then(() => Date.now() - t0);
    await new Promise((r) => setTimeout(r, 150));
    const shortMs = await chat({ messages: user('hi'), max_tokens: 4 }).then((r) => r.json()).then(() => Date.now() - t0);
    const longMs = await longP;
    need(shortMs < longMs, `short request finished at ${shortMs}ms, after the long one (${longMs}ms): -np too low?`);
    return `short ${shortMs}ms < long ${longMs}ms`;
  });

  await check('prompt cache reuse (no full re-prefill each turn)', async () => {
    const prefix = 'The quick brown fox jumps over the lazy dog. '.repeat(Math.min(300, Math.floor(ctx / 40)));
    const a = await (await chat({ messages: user(`${prefix} Question A?`), max_tokens: 2, cache_prompt: true })).json();
    const b = await (await chat({ messages: user(`${prefix} Question B?`), max_tokens: 2, cache_prompt: true })).json();
    const cached = (b.timings && b.timings.cache_n) || (b.usage && b.usage.prompt_tokens_details && b.usage.prompt_tokens_details.cached_tokens) || 0;
    need(cached > 0, `second request reused 0 tokens (SWA caches often force a full re-prefill; try server.swaFull). first prompt_n=${a.timings && a.timings.prompt_n}`);
    return `reused ${cached} tokens`;
  });

  return results;
}

if (require.main === module) {
  const [baseUrl, apiKey, ctx] = process.argv.slice(2);
  if (!baseUrl || !apiKey) { console.error('usage: node selftest.cjs <baseUrl e.g. http://127.0.0.1:PORT/v1> <apiKey> [ctxPerSlot]'); process.exit(2); }
  runSelfTest({ baseUrl, apiKey, ctx: Number(ctx) || 8192 }).then((rs) => {
    rs.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.ms}ms)  ${r.detail}`));
    process.exit(rs.every((r) => r.pass) ? 0 : 1);
  });
}
module.exports = { runSelfTest };
