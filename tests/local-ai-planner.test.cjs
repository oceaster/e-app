'use strict';
// THE PLANNER'S PROMISES, PROVEN WITHOUT A GPU.
//
// Every hardware snapshot in here is built from `desktop/local-ai/fixtures.cjs` — synthetic machines
// run through the real probe path — so this suite gives the identical verdict on a developer's
// laptop, on a CI box with no GPU, and on a Windows runner. No test here reads the real hardware.
const test = require('node:test');
const assert = require('node:assert');

const cfg = require('../desktop/local-ai/src/config.cjs');
const { planTier, planAll, buildServerArgs, buildEnv, kvBytes, chooseQuant } = require('../desktop/local-ai/src/planner.cjs');
const { detect } = require('../desktop/local-ai/src/hardware.cjs');
const fixtures = require('../desktop/local-ai/dev/fixtures.cjs');

const GiB = 1024 ** 3;
const inv = fixtures.INVENTORY;

/** A plan for `tier` on a synthetic machine, measured through the real probe path. */
const planOn = async (id, tier, override) => {
  const machine = fixtures.byId(id);
  const hw = await detect(fixtures.optionsFor(override ? { ...machine, ...override } : machine, cfg));
  return planTier(tier, hw, cfg, inv);
};
const hwOn = (id, override) => detect(fixtures.optionsFor(override ? { ...fixtures.byId(id), ...override } : fixtures.byId(id), cfg));

test('KV math is sliding-window aware: ~20 KiB/token/loop of growth, not 144', () => {
  const single = { ...cfg, server: { ...cfg.server, parallel: 1 } };
  const k = (ctx) => kvBytes(single, { ctx, loops: 1, cache: 'per_loop', kvq: 'f16' });
  const perToken = (k(101024) - k(100024)) / 1000;
  assert.ok(Math.abs(perToken - 20 * 1024) < 1, `growth per token = ${perToken}`);
  assert.ok(k(512) < 15 * 4096 * 512 + 5 * 4096 * 512 + 1); // below the window: all 20 layers grow
  assert.ok(k(100000) < 100000 * 80 * 1024 * 0.3); // ~4x+ smaller than the naive all-layers number
});

test('every tier on a capable machine is a plan with a placement and ONE sentence why', async () => {
  const hw = await hwOn('two-nvidia-gpus');
  for (const plan of planAll(hw, cfg, inv)) {
    assert.strictEqual(plan.ok, true, `tier ${plan.tier}: ${plan.reason}`);
    assert.ok(plan.placement && plan.placement.length > 3, `tier ${plan.tier} has no placement`);
    assert.ok(plan.why && plan.why.length > 20, `tier ${plan.tier} has no why`);
    assert.match(plan.why, /^[A-Z].*\.$/, `tier ${plan.tier} why is not one sentence: ${plan.why}`);
    assert.ok(plan.why.length <= 300, `tier ${plan.tier} why is ${plan.why.length} chars`);
    assert.ok(!/undefined|NaN|\[object/.test(`${plan.placement} ${plan.why} ${JSON.stringify(plan.estimate)}`), `tier ${plan.tier} leaked a placeholder`);
  }
});

test('the ladder is four DIFFERENT rungs, ordered by capability class', async () => {
  const hw = await hwOn('two-nvidia-gpus');
  const plans = planAll(hw, cfg, inv);
  assert.strictEqual(new Set(plans.map((p) => p.quant + p.ctx)).size, 4, plans.map((p) => `${p.quant}@${p.ctx}`).join(' '));
  const [eco, light, flash, pro] = plans;
  assert.strictEqual(eco.backend, 'cpu');
  assert.ok(light.ctx <= 16384 && light.loops === 1 && light.priority === 'low', 'Light is the cheap rung');
  assert.strictEqual(flash.quant, 'q2');
  assert.strictEqual(pro.loops, 4);
  assert.ok(light.gpus.every((g) => !light.displayGpus.includes(g)), 'Light avoids the display GPU');
});

test('the LAUNCH ARGS: -ngl 999 on a GPU, 0 on the CPU, -c = ctx*np, -np 2, and never -hf', async () => {
  const gpu = await planOn('two-nvidia-gpus', 2);
  const args = buildServerArgs(gpu, { port: 1, apiKey: 'k', cfg });
  assert.strictEqual(args[args.indexOf('-ngl') + 1], '999');
  assert.strictEqual(args[args.indexOf('-np') + 1], String(cfg.server.parallel));
  assert.strictEqual(args[args.indexOf('-c') + 1], String(gpu.ctx * cfg.server.parallel));
  assert.ok(!args.includes('-hf'), 'a launch must never download the model');
  const cpu = await planOn('no-gpu', 0);
  const cpuArgs = buildServerArgs(cpu, { port: 1, apiKey: 'k', cfg });
  assert.strictEqual(cpuArgs[cpuArgs.indexOf('-ngl') + 1], '0');
  assert.deepStrictEqual(buildEnv(cpu), { CUDA_VISIBLE_DEVICES: '-1' }, 'a CPU plan hides the GPUs');
});

test('each backend gets its own device environment, and Metal gets none', async () => {
  assert.deepStrictEqual(buildEnv(await planOn('one-8gib-gpu', 1)), { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: '0' });
  assert.deepStrictEqual(buildEnv(await planOn('amd-no-nvidia-smi', 1)), { HIP_VISIBLE_DEVICES: '0', CUDA_VISIBLE_DEVICES: '-1' });
  assert.deepStrictEqual(buildEnv(await planOn('igpu-8gib', 1)), { GGML_VK_VISIBLE_DEVICES: '0', CUDA_VISIBLE_DEVICES: '-1' });
  assert.deepStrictEqual(buildEnv(await planOn('apple-silicon', 1)), {});
});

test('the LARGEST quant that fits is chosen, and the plan names the ones it gave up', async () => {
  // A model whose q1 build is too big for any card here: Pro must fall to q2 and SAY so.
  const machine = fixtures.byId('two-nvidia-gpus');
  const hw = await detect(fixtures.optionsFor(machine, cfg));
  const heavy = { ...inv, q1: { bytes: 40 * GiB } };
  const pro = planTier(3, hw, cfg, heavy);
  assert.strictEqual(pro.ok, true, pro.reason);
  assert.strictEqual(pro.quant, 'q2');
  assert.deepStrictEqual(pro.rejectedQuants, ['q1'], 'the better quant it could not hold must be named');
  // And on the largest card Pro does hold q1 (the quant ladder is measured, not fixed).
  assert.strictEqual((await planOn('streaming-pc', 3, { commands: fixtures.byId('streaming-pc').commands.map((c) => (c.cmd === 'ps' ? { ...c, stdout: '/sbin/init\n' } : c)) })).quant, 'q1');
  // And a budget that only fits the default quant with a short context is a REFUSAL, not a guess.
  const tight = chooseQuant(cfg, inv, { allowed: cfg.quant.t3, room: 2 * GiB, loops: 4, candidates: cfg.candidates.pro, minCtx: cfg.ctx.min[3], targetCtx: cfg.ctx.target[3] });
  assert.strictEqual(tight.ok, false);
  assert.ok(tight.needsBytes > 2 * GiB);
});

test('a refusal names the SHORTFALL in GiB and never becomes a silent CPU plan', async () => {
  const flash = await planOn('one-8gib-gpu', 2, { commands: fixtures.byId('one-8gib-gpu').commands.map((c) => (c.match === '--query-gpu' ? { ...c, stdout: '0, Fixture Card, 4096, 3900, Enabled' } : c)) });
  assert.strictEqual(flash.ok, false);
  assert.match(flash.reason, /needs >= \d+(\.\d+)? GiB free VRAM/);
  for (const tier of [2, 3]) {
    const plan = await planOn('no-gpu', tier);
    assert.strictEqual(plan.ok, false, `tier ${tier} must refuse on a machine with no GPU`);
    assert.match(plan.reason, /no GPU backend found/, plan.reason);
  }
});

test('a GPU another thing is USING is never planned onto, and the why names it and its owner', async () => {
  const hw = await hwOn('gaming-pc');
  assert.strictEqual(hw.gpus[0].busy, 'compute');
  assert.match(hw.gpus[0].busyOwner, /Fixture Game/);
  for (const plan of planAll(hw, cfg, inv)) {
    if (!plan.ok) continue;
    for (const index of plan.gpus) assert.strictEqual(hw.gpus[index].busy, false, `tier ${plan.tier} planned onto busy GPU ${index}`);
    if (plan.gpus.length) {
      assert.match(plan.why, /Fixture Game/, `tier ${plan.tier} did not say why it skipped the held GPU`);
      assert.match(plan.why, /GPU 0/, 'the skipped GPU is named by index');
    }
  }
  // Tier 2 and 3 move to the free card rather than refusing the whole machine.
  assert.deepStrictEqual((await planOn('gaming-pc', 2)).gpus, [1]);
  assert.deepStrictEqual((await planOn('gaming-pc', 3)).gpus, [1]);
});

test('a BUSY-ONLY machine refuses the GPU rungs rather than quietly dropping to the CPU', async () => {
  const held = await planOn('streaming-pc', 3);
  assert.strictEqual(held.ok, false);
  assert.match(held.reason, /no GPU backend found .*sunshine/);
  const light = await planOn('streaming-pc', 1);
  assert.strictEqual(light.backend, 'cpu', 'the cheap rung may run on the CPU…');
  assert.match(light.why, /sunshine/, '…but it must say which GPU was passed over and who holds it');
});

test('unified memory is ONE pool: the budget is never RAM plus VRAM', async () => {
  const hw = await hwOn('apple-silicon');
  assert.strictEqual(hw.unifiedMemory, true);
  const share = cfg.memory.appleGpuFraction;
  for (const plan of planAll(hw, cfg, inv)) {
    if (!plan.ok) continue;
    const budget = plan.estimate.budgetGiB;
    assert.ok(budget <= +(hw.ramTotal * share / GiB).toFixed(2) + 0.01, `tier ${plan.tier} budgeted ${budget} GiB of a ${hw.ramTotal / GiB} GiB machine`);
    assert.ok(plan.estimate.weightsGiB + plan.estimate.kvGiB <= budget + 0.01, `tier ${plan.tier} overcommitted its own pool`);
    assert.ok(!plan.nkvo, 'there is no second pool to spill into on unified memory');
  }
});

test('no plan, and no shipped constant, names a GPU model we happen to own', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  for (const file of ['planner.cjs', 'config.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'local-ai', 'src', file), 'utf8');
    assert.ok(!/GeForce|Radeon|RTX \d|Apple M\d/i.test(source), `${file} still carries a GPU model name`);
  }
  // A plan's placement is whatever the PROBES said, so a fixture with no GPU names produces none.
  const plans = planAll(await hwOn('no-gpu'), cfg, inv);
  assert.ok(!/GeForce|Radeon|RTX/.test(JSON.stringify(plans)), 'a plan invented a GPU name');
});
