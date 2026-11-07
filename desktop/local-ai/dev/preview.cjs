'use strict';
/**
 * preview.cjs — the plan table, printed by the machine that will run it.
 *
 *   node preview.cjs              what each tier would do on THIS computer
 *   node preview.cjs --matrix     the same table for every synthetic machine (fixtures.cjs)
 *   ARGS=1 node preview.cjs       add the exact launch arguments and environment
 *
 * Nothing is downloaded and no server is started: this is the planner reading the machine and
 * saying what it can hold, which is the whole product question. The table is OUTPUT, never a
 * shipped answer — the numbers come from the probes on the machine in front of you.
 */
const GiB = 1024 ** 3;
const cfg = require('../src/config.cjs');
const { detect } = require('../src/hardware.cjs');
const { planAll, buildServerArgs, buildEnv } = require('../src/planner.cjs');
const fixtures = require('./fixtures.cjs');

const gib = (b) => (b == null ? '?' : `${(b / GiB).toFixed(1)} GiB`);

function hardwareLines(hw) {
  const lines = [];
  lines.push(`machine:  ${hw.platform}-${hw.arch} · ${hw.cpu.model} · ${hw.cpu.logical} threads · ${gib(hw.ramTotal)} RAM (${gib(hw.ramFree)} free)`);
  if (hw.unifiedMemory) lines.push('memory:   unified — the GPU and the CPU share one pool, so nothing is counted twice');
  if (!hw.gpus.length) lines.push('gpus:     none reported');
  for (const g of hw.gpus) {
    const free = g.freeKnown ? `${gib(g.freeBytes)} free` : 'free not reported';
    const flags = [g.backend, g.integrated ? 'integrated' : null, g.unified ? 'unified memory' : null, g.display ? 'presents the display' : null]
      .filter(Boolean).join(', ');
    const held = g.busy ? `  BUSY (${g.busy}: ${g.busyOwner})` : '';
    lines.push(`  GPU ${g.index}: ${g.name} — ${gib(g.totalBytes)} total, ${free} [${flags}]${held}`);
  }
  const backends = Object.entries(hw.backends || {}).map(([name, b]) => (b.available ? `${name}` : `${name}: unavailable (${b.reason})`));
  lines.push(`backends: ${backends.join(' · ')}`);
  if (hw.streaming && hw.streaming.active) lines.push(`streaming: ${hw.streaming.processes.join(', ')} is running and holds a GPU`);
  return lines;
}

function planLines(tiers, { showArgs = false } = {}) {
  const lines = [];
  for (const plan of tiers) {
    const name = `Tier ${plan.tier} ${plan.label || ''}`.trim();
    if (!plan.ok) {
      lines.push(`  ${name.padEnd(16)} REFUSED — ${plan.reason}`);
      continue;
    }
    lines.push(`  ${name.padEnd(16)} ${plan.placement}`);
    lines.push(`  ${''.padEnd(16)} ${plan.quant} · ${plan.loops} loop(s) · ${plan.cache} KV ${plan.kvq} · ${plan.ctx} tokens/slot × ${cfg.server.parallel} slots · ${plan.estimate.weightsGiB} + ${plan.estimate.kvGiB} of ${plan.estimate.budgetGiB} GiB`);
    lines.push(`  ${''.padEnd(16)} why: ${plan.why}`);
    if (plan.rejectedQuants && plan.rejectedQuants.length) lines.push(`  ${''.padEnd(16)} larger quants that did not fit: ${plan.rejectedQuants.join(', ')}`);
    if (showArgs) {
      const args = buildServerArgs(plan, { port: 8080, apiKey: 'KEY', cfg, overrides: fixtures.ENGINE_META.overrides });
      lines.push(`  ${''.padEnd(16)} ${JSON.stringify(buildEnv(plan))} -m <model.gguf> ${args.join(' ')}`);
    }
  }
  return lines;
}

async function thisMachine() {
  const hw = await detect({ cfg });
  console.log(hardwareLines(hw).join('\n'));
  console.log('');
  console.log(planLines(planAll(hw, cfg, fixtures.INVENTORY), { showArgs: !!process.env.ARGS }).join('\n'));
}

async function matrix() {
  for (const machine of fixtures.MACHINES) {
    const hw = await detect(fixtures.optionsFor(machine, cfg));
    console.log(`\n=== ${machine.id} — ${machine.label}`);
    console.log(hardwareLines(hw).map((line) => `  ${line}`).join('\n'));
    console.log(planLines(planAll(hw, cfg, fixtures.INVENTORY)).join('\n'));
  }
}

const run = process.argv.includes('--matrix') ? matrix : thisMachine;
run().catch((error) => {
  console.error(`preview failed: ${error.message}`);
  process.exit(1);
});
