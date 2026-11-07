'use strict';
// THE SYNTHETIC HARDWARE MATRIX — the gate that proves the planner without our desks.
//
// Seven machines the ticket names, measured through the REAL probe path from canned tool output.
// The rules: no test reads the real machine's hardware, every tier on every machine is either a
// plan carrying a placement and a one-sentence why or a refusal naming the shortfall, and no
// refusal is allowed to become a silent CPU plan.
const test = require('node:test');
const assert = require('node:assert');

const cfg = require('../desktop/local-ai/src/config.cjs');
const { detect } = require('../desktop/local-ai/src/hardware.cjs');
const { planAll } = require('../desktop/local-ai/src/planner.cjs');
const { MACHINES, optionsFor, stubExec, INVENTORY } = require('../desktop/local-ai/dev/fixtures.cjs');

const REQUIRED = ['no-gpu', 'one-8gib-gpu', 'igpu-8gib', 'two-nvidia-gpus', 'amd-no-nvidia-smi', 'apple-silicon', 'laptop-8gib-ram'];
const SHORTFALL = [
  /needs >= [\d.]+ GiB free VRAM/,
  /needs >= [\d.]+ GiB free on /,
  /needs >= \d+ logical cores/,
  /needs >= [\d.]+ GiB RAM/,
  /needs >= [\d.]+ GiB of RAM budget/,
  /no GPU backend found/,
];

/** Every machine measured through the probe path, with the executor it was driven by. */
const measured = MACHINES.map((machine) => {
  const exec = stubExec(machine);
  return { machine, exec, hardware: detect({ cfg, platform: machine.platform, arch: machine.arch, os: machine.os, exec }) };
});

test('the matrix holds the seven machines the ticket names', () => {
  for (const id of REQUIRED) assert.ok(MACHINES.some((m) => m.id === id), `matrix is missing ${id}`);
});

test('NO TEST READS THE REAL HARDWARE: every answer comes from an injected machine', async () => {
  for (const { machine, exec, hardware } of measured) {
    const hw = await hardware;
    assert.strictEqual(exec.calls.length > 0, true, `${machine.id}: no probe was run`);
    assert.strictEqual(hw.platform, machine.platform, `${machine.id} was measured as ${hw.platform}`);
    assert.strictEqual(hw.arch, machine.arch);
    // RAM and cores are the fixture's, not this machine's: no probe can have supplied them.
    assert.strictEqual(hw.ramTotal, machine.os.totalmem, `${machine.id} RAM leaked from the host`);
    assert.strictEqual(hw.cpu.logical, machine.os.cpus.length);
    for (const gpu of hw.gpus) {
      assert.ok(machine.commands.some((c) => (c.stdout || '').includes(gpu.name)), `${machine.id}: ${gpu.name} did not come from a canned probe`);
    }
  }
});

for (const id of REQUIRED) {
  test(`${id}: every tier is a plan with placement + why, or a refusal naming the shortfall`, async () => {
    const machine = MACHINES.find((m) => m.id === id);
    const exec = stubExec(machine);
    const hw = await detect({ cfg, platform: machine.platform, arch: machine.arch, os: machine.os, exec });
    const tiers = planAll(hw, cfg, INVENTORY);
    assert.strictEqual(tiers.length, 4);
    let available = 0;
    for (const plan of tiers) {
      assert.ok(plan.label, `tier ${plan.tier} has no label`);
      if (plan.ok) {
        available += 1;
        assert.ok(plan.placement && plan.placement.length > 3, `${id} tier ${plan.tier} has no placement`);
        assert.match(plan.why, /^[A-Z].*\.$/, `${id} tier ${plan.tier} why is not one sentence: ${plan.why}`);
        assert.ok(plan.ctx >= cfg.ctx.min[plan.tier], `${id} tier ${plan.tier} planned a context below its own floor`);
        assert.ok(plan.quant && plan.loops && plan.cache && plan.kvq, `${id} tier ${plan.tier} plan is incomplete`);
        for (const index of plan.gpus) {
          assert.strictEqual(hw.gpus[index].busy, false, `${id} tier ${plan.tier} planned onto a GPU that is in use`);
        }
        // A placement may only name a GPU the probes reported: nothing is hard-coded.
        for (const index of plan.gpus) {
          assert.ok(plan.placement.includes(hw.gpus[index].name.slice(0, 12)), `${id} tier ${plan.tier} placement does not name GPU ${index} as probed`);
        }
      } else {
        assert.ok(plan.reason && plan.reason.length > 8, `${id} tier ${plan.tier} refused without a reason`);
        assert.ok(SHORTFALL.some((re) => re.test(plan.reason)), `${id} tier ${plan.tier} refusal does not name a shortfall: ${plan.reason}`);
        assert.ok(!/^\s*$/.test(plan.reason));
      }
    }
    assert.ok(available >= 1, `${id}: no rung is available at all, so this machine gets nothing`);
  });
}

test('no refusal silently becomes a CPU plan: a CPU answer names the GPU it passed over', async () => {
  for (const id of ['gaming-pc', 'streaming-pc', 'one-8gib-gpu']) {
    const machine = MACHINES.find((m) => m.id === id);
    const hw = await detect({ cfg, platform: machine.platform, arch: machine.arch, os: machine.os, exec: stubExec(machine) });
    for (const plan of planAll(hw, cfg, INVENTORY)) {
      // Tier 0 IS the CPU rung: it does not pass a GPU over, it is defined as the CPU floor.
      if (!plan.ok || plan.tier === 0 || plan.backend !== 'cpu' || !hw.gpus.length) continue;
      const explains = /no GPU (offers|could be used)|GPU \d+/.test(plan.why);
      assert.ok(explains, `${id} tier ${plan.tier} ran on the CPU without saying why the GPU was not used: ${plan.why}`);
    }
  }
});

test('a machine with no GPU at all still lands on the CPU rung and refuses the GPU rungs by name', async () => {
  const machine = MACHINES.find((m) => m.id === 'no-gpu');
  const hw = await detect({ cfg, platform: machine.platform, arch: machine.arch, os: machine.os, exec: stubExec(machine) });
  const [eco, light, flash, pro] = planAll(hw, cfg, INVENTORY);
  assert.strictEqual(eco.ok, true);
  assert.strictEqual(eco.backend, 'cpu');
  assert.match(eco.placement, /CPU only/);
  assert.strictEqual(light.ok, true, 'the cheap rung exists on the CPU');
  for (const plan of [flash, pro]) {
    assert.strictEqual(plan.ok, false);
    assert.match(plan.reason, /no GPU backend found/);
  }
});

test('the 8 GiB-RAM laptop is not left with nothing: the CPU floor holds a small model', async () => {
  const machine = MACHINES.find((m) => m.id === 'laptop-8gib-ram');
  const hw = await detect({ cfg, platform: machine.platform, arch: machine.arch, os: machine.os, exec: stubExec(machine) });
  const eco = planAll(hw, cfg, INVENTORY)[0];
  assert.strictEqual(eco.ok, true, `the floor refused an 8 GiB laptop: ${eco.reason}`);
  assert.ok(eco.quant !== 'q2', 'a 3.94 GiB quant does not belong in an 8 GiB machine');
  assert.ok(eco.ctx >= 4096);
  assert.ok(eco.estimate.weightsGiB + eco.estimate.kvGiB <= eco.estimate.budgetGiB + 0.01);
});
