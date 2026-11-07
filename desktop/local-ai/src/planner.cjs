'use strict';
/**
 * planner.cjs — PURE PLANNING: (hardware snapshot, config, model inventory) -> launch plan. No I/O.
 *
 * A tier is a CAPABILITY BUDGET, not a hardware claim, and not a table of numbers for one desk.
 * Every machine lands on a rung by measuring itself, and every answer is either a plan carrying
 * `placement` + a one-sentence `why`, or a refusal naming the shortfall. There is no third answer
 * and no silent fallback: a drop from a long context to a short one is a quality cliff, not a
 * fallback, so a rung that cannot be held is REFUSED rather than quietly re-planned onto the CPU.
 *
 * The rules this file enforces, in the order they bite:
 *  1. A GPU another thing is USING (a game, an encoder, a remote stream, a compute process) is
 *     never planned onto. The refusal, or the different placement, names the GPU and its owner.
 *  2. A GPU presenting a desktop is not "free": it loses every preference contest, it costs its
 *     display headroom, and the `why` says so. It is still usable — on a one-GPU laptop refusing it
 *     is refusing the product — but it is never the first choice while another GPU exists.
 *  3. UNIFIED MEMORY IS ONE POOL. On Apple silicon (and any integrated GPU) the GPU addresses
 *     system RAM, so a budget must never add `ramTotal` to a VRAM figure.
 *  4. THE LARGEST QUANT THAT FITS the MEASURED budget is the one chosen, and the plan names the
 *     better quants it had to give up. A stated default (config.model.defaultQuant) is what a
 *     refusal names when nothing better fits.
 *  5. Sliding-window-aware KV math (unchanged from the first cut, because it was right): of Dory's
 *     20 layers only the 5 full-attention ones grow with context, ~20 KiB/token/loop at f16.
 */
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

const fmt = (b) => +(Number(b || 0) / GiB).toFixed(2);
const no = (tier, reason, extra = {}) => ({ ok: false, tier, reason, ...extra });
const short = (s, n = 34) => {
  const text = String(s || 'GPU');
  return text.length <= n ? text : `${text.slice(0, n - 1)}…`;
};

/* --------------------------------- KV and weight math (unchanged, and still right) ------------ */

/** KV bytes for `ctx` tokens per slot. Sliding-window layers are capped; only full layers grow. */
function kvBytes(cfg, { ctx, loops, cache, kvq }) {
  const a = cfg.arch;
  const np = cfg.server.parallel;
  const perLayerTok = 2 * a.kvHeads * a.headDim * (kvq === 'q8_0' ? 1.0625 : 2);
  const full = a.recurrentLayers / a.fullEvery;
  const sliding = a.recurrentLayers - full;
  const cells = ctx * np;
  const swaCells = cfg.server.swaFull ? cells : Math.min(cells, np * (a.slidingWindow + a.swaPadTokens));
  return (cache === 'per_loop' ? loops : 1) * perLayerTok * (full * cells + sliding * swaCells);
}

/** Largest ctx (multiple of 1024, <= cap) whose KV fits in `room` bytes. */
function maxCtx(cfg, room, loops, cache, kvq, cap) {
  if (!(room > 0)) return 0;
  let lo = 0;
  let hi = Math.floor(cap / 1024);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (kvBytes(cfg, { ctx: mid * 1024, loops, cache, kvq }) <= room) lo = mid; else hi = mid - 1;
  }
  return lo * 1024;
}

function weightsBytes(cfg, inv, quant) {
  const known = inv && inv[quant] && inv[quant].bytes;
  if (known) return known;
  const per = cfg.model.bytesPerParam[quant];
  return per ? Math.round(cfg.model.paramsB * 1e9 * per) : 0;
}

/** The best KV layout that still gives at least `minCtx` tokens per slot in `room` bytes. */
function fitKv(cfg, { room, loops, candidates, minCtx, targetCtx }) {
  for (const c of candidates) {
    const ctx = maxCtx(cfg, room, loops, c.cache, c.kvq, Math.min(targetCtx, cfg.ctx.max));
    if (ctx >= minCtx) return { cache: c.cache, kvq: c.kvq, ctx };
  }
  return null;
}

/**
 * The largest quant of `allowed` that fits, and what the losers would have needed. The refused
 * figure is what a tier's minimum would cost at `defaultQuant`, which is what a refusal names.
 */
function chooseQuant(cfg, inv, { allowed, room, loops, candidates, minCtx, targetCtx }) {
  const order = [...new Set(allowed)].sort((a, b) => weightsBytes(cfg, inv, b) - weightsBytes(cfg, inv, a));
  const rejected = [];
  for (const quant of order) {
    const weights = weightsBytes(cfg, inv, quant);
    const kv = fitKv(cfg, { room: room - weights, loops, candidates, minCtx, targetCtx });
    if (kv) return { ok: true, quant, weights, ...kv, rejected };
    rejected.push({ quant, weightsBytes: weights });
  }
  const fallback = cfg.model.defaultQuant;
  const need = weightsBytes(cfg, inv, fallback) + kvBytes(cfg, { ctx: minCtx, loops, cache: candidates[0].cache, kvq: candidates[0].kvq });
  return { ok: false, rejected, needsBytes: need, rejectedBecause: order };
}

const estimateOf = (cfg, { weights, room, kv, loops }) => ({
  weightsGiB: fmt(weights),
  kvGiB: fmt(kvBytes(cfg, { ctx: kv.ctx, loops, cache: kv.cache, kvq: kv.kvq })),
  budgetGiB: fmt(room),
});

/* --------------------------------- Memory pools -------------------------------------------- */

/**
 * The bytes one GPU can actually spend on weights + KV: its free memory (measured, or an explicit
 * share of the total when the driver does not report free), minus driver overhead, minus the
 * display headroom if it is presenting a desktop.
 */
function gpuRoom(cfg, gpu) {
  const total = Number(gpu.totalBytes) || 0;
  const measured = gpu.freeKnown && gpu.freeBytes != null;
  const free = measured ? gpu.freeBytes : Math.round((total || 0) * cfg.gpu.unknownFreeFraction);
  const headroom = cfg.gpu.overheadBytes + (gpu.display ? cfg.gpu.displayHeadroomBytes : 0);
  const ceiling = measured ? free : Math.min(free, total || free);
  return Math.max(0, ceiling - headroom);
}

/** System RAM the engine may spend. On unified memory this is the SAME pool the GPU draws on. */
function ramRoom(cfg, hw, fraction) {
  const cap = hw.ramTotal * (fraction == null ? 1 : fraction);
  const reserve = Math.min(cfg.memory.osReserveBytes, Math.max(cfg.memory.osReserveFloorBytes || 0, hw.ramFree * 0.25));
  return Math.max(0, Math.min(cap, hw.ramFree - reserve));
}

const heldBy = (gpu) => (gpu && gpu.busy ? `${gpu.busyOwner || 'another application'}` : null);
const isHeld = (gpu) => !!gpu.busy;

const BACKEND_LABEL = { cuda: 'CUDA', rocm: 'ROCm', vulkan: 'Vulkan', metal: 'Metal', cpu: 'CPU' };
const gpuLabel = (gpu) => `${BACKEND_LABEL[gpu.backend] || String(gpu.backend || 'GPU')} GPU ${gpu.index} (${short(gpu.name)})`;
const samePool = (cfg, hw) => hw.unifiedMemory === true;

/**
 * The GPUs a rung may plan onto, best first, plus WHY each of the others was passed over. A GPU
 * presenting a desktop is passed over for any GPU that is not, but it is not removed: refusing the
 * only GPU on a laptop would be refusing the product.
 */
function usableGpus(cfg, hw) {
  const usable = [];
  const skipped = [];
  for (const gpu of hw.gpus || []) {
    const room = gpuRoom(cfg, gpu);
    const floor = gpu.integrated ? cfg.gpu.integratedMinUsefulBytes : cfg.gpu.minUsefulBytes;
    if (isHeld(gpu)) {
      skipped.push({ gpu, why: `${gpuLabel(gpu)} is being used by ${heldBy(gpu)}` });
      continue;
    }
    if (room < floor) {
      skipped.push({ gpu, why: `${gpuLabel(gpu)} can offer only ${fmt(room)} GiB` });
      continue;
    }
    usable.push({ gpu, room });
  }
  usable.sort((a, b) => {
    const da = a.gpu.display ? 1 : 0;
    const db = b.gpu.display ? 1 : 0;
    if (da !== db) return da - db;
    return b.room - a.room;
  });
  return { usable, skipped };
}

/** One sentence, naming whatever was passed over and who holds it. */
function whySentence(base, skipped) {
  if (!skipped || !skipped.length) return base;
  const extra = ` Skipping ${skipped.map((s) => s.why).join(' and ')}.`;
  const text = `${base}${extra}`;
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`;
}

/* --------------------------------- Placement results --------------------------------------- */

function gpuPlan(tier, hw, cfg, inv, o) {
  const picked = o.picks;
  const totalRoom = picked.reduce((sum, p) => sum + p.room, 0);
  const loops = cfg.loops[tier];
  const chosen = chooseQuant(cfg, inv, { allowed: o.quants, room: totalRoom, loops, candidates: o.candidates, minCtx: cfg.ctx.min[tier], targetCtx: cfg.ctx.target[tier] });
  if (!chosen.ok) {
    return no(tier, `needs >= ${fmt(chosen.needsBytes)} GiB free on ${picked.map((p) => gpuLabel(p.gpu)).join(' + ')} (found ${fmt(totalRoom)} GiB)`, { skippedGpus: o.skipped });
  }
  const gpus = picked.map((p) => p.gpu);
  const backend = gpus[0].backend;
  const display = gpus.filter((g) => g.display);
  const base = o.why(chosen, gpus, display);
  return {
    ok: true,
    tier,
    backend,
    gpus: gpus.map((g) => g.index),
    placement: gpus.map(gpuLabel).join(' + '),
    quant: chosen.quant,
    loops,
    cache: chosen.cache,
    kvq: chosen.kvq,
    ctx: chosen.ctx,
    threads: gpus.some((g) => g.integrated) || o.threads ? o.threads || 1 : 1,
    priority: o.priority || 'normal',
    nkvo: !!o.nkvo,
    tensorSplit: gpus.length > 1 ? picked.map((p) => Math.max(1, Math.round(p.room / MiB))) : null,
    unified: samePool(cfg, hw),
    displayGpus: display.map((g) => g.index),
    skippedGpus: (o.skipped || []).map((s) => ({ index: s.gpu.index, why: s.why })),
    rejectedQuants: chosen.rejected.map((r) => r.quant),
    estimate: estimateOf(cfg, { weights: chosen.weights, room: totalRoom, kv: chosen, loops }),
    why: whySentence(base, o.skipped),
  };
}

/* ---------------------------------- The four rungs ----------------------------------------- */

function tier0(hw, cfg, inv) {
  const tier = 0;
  const m = cfg.minimums.cpu;
  if (!hw.cpu || hw.cpu.logical < m.logicalCores) return no(tier, `needs >= ${m.logicalCores} logical cores (found ${(hw.cpu && hw.cpu.logical) || 0})`);
  if (hw.ramTotal < m.ramBytes) return no(tier, `needs >= ${fmt(m.ramBytes)} GiB RAM (found ${fmt(hw.ramTotal)})`);
  const threads = Math.max(1, Math.floor(hw.cpu.logical * cfg.memory.cpuT0.threadFraction));
  const room = ramRoom(cfg, hw, cfg.memory.cpuT0.ramFraction);
  const loops = cfg.loops[tier];
  const chosen = chooseQuant(cfg, inv, { allowed: cfg.quant.cpu, room, loops, candidates: cfg.candidates.default, minCtx: cfg.ctx.min[tier], targetCtx: cfg.ctx.target[tier] });
  if (!chosen.ok) return no(tier, `needs >= ${fmt(chosen.needsBytes)} GiB of RAM budget (found ${fmt(room)} GiB)`, { skippedGpus: [] });
  return {
    ok: true,
    tier,
    backend: 'cpu',
    gpus: [],
    placement: `CPU only (${threads} of ${hw.cpu.logical} threads)`,
    quant: chosen.quant,
    loops,
    cache: chosen.cache,
    kvq: chosen.kvq,
    ctx: chosen.ctx,
    threads,
    priority: cfg.memory.cpuT0.priority,
    nkvo: false,
    tensorSplit: null,
    unified: samePool(cfg, hw),
    displayGpus: (hw.gpus || []).filter((g) => g.display).map((g) => g.index),
    skippedGpus: [],
    rejectedQuants: chosen.rejected.map((r) => r.quant),
    estimate: estimateOf(cfg, { weights: chosen.weights, room, kv: chosen, loops }),
    why: `CPU only, capped at ${Math.round(cfg.memory.cpuT0.threadFraction * 100)}% of threads and ${Math.round(cfg.memory.cpuT0.ramFraction * 100)}% of RAM so nothing else on this computer slows down.`,
  };
}

function tier1(hw, cfg, inv) {
  const tier = 1;
  const { usable, skipped } = usableGpus(cfg, hw);
  const floor = cfg.minimums.t1GpuFreeBytes;
  const candidates = usable.filter((p) => p.room >= floor);
  const tooSmall = usable.filter((p) => p.room < floor).map((p) => ({ gpu: p.gpu, why: `${gpuLabel(p.gpu)} has only ${fmt(p.room)} GiB to offer` }));
  const tryGpu = () => {
    if (!candidates.length) {
      return no(tier, usable.length
        ? `needs >= ${fmt(floor)} GiB free on a GPU (best offers ${fmt(usable[0].room)} GiB)`
        : `no GPU backend found${skipped.length ? ` (${skipped[0].why})` : ''}`);
    }
    const pick = candidates[0];
    return gpuPlan(tier, hw, cfg, inv, {
      picks: [pick], quants: cfg.quant.t1, candidates: cfg.candidates.default, priority: cfg.memory.cpuT1.priority,
      skipped: [...skipped, ...tooSmall.filter((s) => s.gpu !== pick.gpu)],
      why: (chosen, gpus, display) => `The cheap rung: ${chosen.quant}, ${cfg.loops[1]} loop, ${chosen.ctx} tokens per slot, low priority, so the rest of this computer keeps up${display.length ? ` (${gpuLabel(display[0])} is presenting the desktop, so ${fmt(cfg.gpu.displayHeadroomBytes)} GiB is kept for it)` : ''}.`,
    });
  };
  const tryCpu = () => {
    const plan = cpuFallback(tier, hw, cfg, inv, 'CPU at the lowest priority');
    if (!plan.ok) return plan;
    // A CPU answer that does not say why the GPU was passed over would be the silent replan this
    // module refuses to make. One sentence, naming the first GPU and its owner.
    const because = skipped.length
      ? `no GPU could be used (${skipped[0].why})`
      : `no GPU offers ${fmt(floor)} GiB free`;
    return {
      ...plan,
      skippedGpus: skipped.map((s) => ({ index: s.gpu.index, why: s.why })),
      why: `CPU at the lowest priority so foreground applications win: ${because}.`,
    };
  };
  const prefer = cfg.tier1.prefer;
  if (prefer === 'cpu') return tryCpu();
  const gpuPlanResult = tryGpu();
  if (gpuPlanResult.ok || prefer === 'gpu') return gpuPlanResult;
  return tryCpu();
}

/** The CPU plan at a rung's own budget (the cheap rung's honest fallback, never a silent one). */
function cpuFallback(tier, hw, cfg, inv, label) {
  const plan = tier0(hw, cfg, inv);
  if (!plan.ok) return no(tier, plan.reason);
  const m = cfg.minimums.cpu;
  if (!hw.cpu || hw.cpu.logical < m.logicalCores) return no(tier, `needs >= ${m.logicalCores} logical cores (found ${(hw.cpu && hw.cpu.logical) || 0})`);
  const room = ramRoom(cfg, hw, cfg.memory.cpuT1.ramFraction);
  const threads = Math.max(1, Math.floor(hw.cpu.logical * cfg.memory.cpuT1.threadFraction));
  const loops = cfg.loops[tier];
  const chosen = chooseQuant(cfg, inv, { allowed: cfg.quant.t1, room, loops, candidates: cfg.candidates.default, minCtx: cfg.ctx.min[tier], targetCtx: cfg.ctx.target[tier] });
  if (!chosen.ok) return no(tier, `needs >= ${fmt(chosen.needsBytes)} GiB of RAM budget for ${label} (found ${fmt(room)} GiB)`);
  return {
    ...plan,
    ok: true,
    tier,
    quant: chosen.quant,
    loops,
    cache: chosen.cache,
    kvq: chosen.kvq,
    ctx: chosen.ctx,
    threads,
    priority: cfg.memory.cpuT1.priority,
    estimate: estimateOf(cfg, { weights: chosen.weights, room, kv: chosen, loops }),
    rejectedQuants: chosen.rejected.map((r) => r.quant),
    why: `${label}, so foreground applications always win.`,
  };
}

function tier2(hw, cfg, inv) {
  const tier = 2;
  const { usable, skipped } = usableGpus(cfg, hw);
  const floor = cfg.minimums.t2GpuFreeBytes;
  const fits = usable.filter((p) => p.room >= floor);
  if (!fits.length) {
    if (!usable.length) {
      return no(tier, `no GPU backend found${skipped.length ? ` (${skipped[0].why})` : ''}`, { skippedGpus: skipped.map((s) => ({ index: s.gpu.index, why: s.why })) });
    }
    return no(tier, `needs >= ${fmt(floor)} GiB free VRAM (best GPU offers ${fmt(usable[0].room)} GiB)`, { skippedGpus: [...skipped, ...usable.filter((p) => p.room < floor)].map((s) => ({ index: s.gpu.index, why: s.why })) });
  }
  const plan = gpuPlan(tier, hw, cfg, inv, {
    picks: [fits[0]], quants: cfg.quant.t2, candidates: cfg.candidates.lossless,
    skipped,
    why: (chosen, gpus, display) => `The best single GPU, lossless layout: ${chosen.quant}, ${cfg.loops[2]} loops, full-precision per-loop KV, ${chosen.ctx} tokens per slot${display.length ? ` (it also presents the desktop, so ${fmt(cfg.gpu.displayHeadroomBytes)} GiB is reserved)` : ''}.`,
  });
  if (plan.ok && hw.streaming && hw.streaming.active) return { ...plan, notes: ['A stream host is running; expect contention on this GPU.'] };
  return plan;
}

function tier3(hw, cfg, inv) {
  const tier = 3;
  const m = cfg.minimums.t3;
  const { usable, skipped } = usableGpus(cfg, hw);
  if (!usable.length) {
    return no(tier, `no GPU backend found${skipped.length ? ` (${skipped[0].why})` : ''}`, { skippedGpus: skipped.map((s) => ({ index: s.gpu.index, why: s.why })) });
  }
  const candidates = usable.filter((p) => p.room >= m.gpuFreeTotalBytes);
  if (!candidates.length) {
    return no(tier, `needs >= ${fmt(m.gpuFreeTotalBytes)} GiB free VRAM (best GPU offers ${fmt(usable[0].room)} GiB)`,
      { skippedGpus: [...skipped, ...usable].map((s) => ({ index: s.gpu.index, why: s.why })) });
  }
  const unified = samePool(cfg, hw);
  if (hw.ramTotal < m.ramBytes && !unified) {
    return no(tier, `needs >= ${fmt(m.ramBytes)} GiB RAM (found ${fmt(hw.ramTotal)})`);
  }
  const picks = cfg.gpu.allowMultiGpu ? candidates.slice(0, 2) : [candidates[0]];
  const totalRoom = picks.reduce((sum, p) => sum + p.room, 0);
  const loops = cfg.loops[tier];
  const gpus = picks.map((p) => p.gpu);
  const display = gpus.filter((g) => g.display);
  const skippedOut = skipped.map((s) => ({ index: s.gpu.index, why: s.why }));
  const poolNote = unified
    ? ' (one memory pool, so the GPU and the CPU share it rather than adding up)'
    : display.length ? `, ${fmt(cfg.gpu.displayHeadroomBytes)} GiB kept for the desktop` : '';

  const onGpu = chooseQuant(cfg, inv, { allowed: cfg.quant.t3, room: totalRoom, loops, candidates: cfg.candidates.pro, minCtx: cfg.ctx.min[tier], targetCtx: cfg.ctx.target[tier] });
  // THE KV CACHE CAN LIVE IN SYSTEM RAM when the card holds the weights but not the context. That is
  // a real placement with a real cost (slower attention), not a fallback, and it is only offered
  // where the two pools are genuinely separate: on unified memory it would be counting the same GiB
  // twice, which is the defect this module exists to prevent.
  const spill = !unified && onGpu.ok && onGpu.ctx < cfg.ctx.target[tier];
  let chosen = onGpu;
  let nkvo = false;
  if (spill) {
    const weights = weightsBytes(cfg, inv, onGpu.quant);
    const ram = ramRoom(cfg, hw, cfg.memory.spillFraction);
    const inRam = fitKv(cfg, { room: ram, loops, candidates: [{ cache: 'last_loop', kvq: 'f16' }], minCtx: cfg.ctx.min[tier], targetCtx: cfg.ctx.target[tier] });
    // Only when it buys a materially longer context: the attention is slower, so a small win is not worth it.
    if (inRam && weights <= totalRoom && inRam.ctx > onGpu.ctx * 1.5) {
      chosen = { ...onGpu, ...inRam };
      nkvo = true;
    }
  }
  if (!chosen.ok) {
    const missed = onGpu.needsBytes;
    return no(tier, `needs >= ${fmt(missed)} GiB free VRAM for ${cfg.model.defaultQuant} at ${cfg.ctx.min[tier]} tokens/slot (found ${fmt(totalRoom)} GiB)`, { skippedGpus: skippedOut });
  }
  return {
    ok: true,
    tier,
    backend: gpus[0].backend,
    gpus: gpus.map((g) => g.index),
    placement: gpus.map(gpuLabel).join(' + '),
    quant: chosen.quant,
    loops,
    cache: chosen.cache,
    kvq: chosen.kvq,
    ctx: chosen.ctx,
    threads: Math.max(1, Math.floor((hw.cpu ? hw.cpu.logical : 1) * 0.5)),
    priority: 'normal',
    nkvo,
    tensorSplit: picks.length > 1 ? picks.map((p) => Math.max(1, Math.round(p.room / MiB))) : null,
    unified,
    displayGpus: display.map((g) => g.index),
    skippedGpus: skippedOut,
    rejectedQuants: chosen.rejected.map((r) => r.quant),
    estimate: estimateOf(cfg, { weights: weightsBytes(cfg, inv, chosen.quant), room: nkvo ? ramRoom(cfg, hw, cfg.memory.spillFraction) : totalRoom, kv: chosen, loops }),
    why: whySentence(`The most capable placement this machine can hold: ${chosen.quant}, ${cfg.loops[3]} loops, ${chosen.cache} KV, ${chosen.ctx} tokens per slot${nkvo ? ', with the KV cache in system RAM because the card cannot hold that much context' : ''}${poolNote}.`, skipped),
  };
}

const RUNGS = [tier0, tier1, tier2, tier3];

function planTier(tier, hw, cfg, inv = {}) {
  const fn = RUNGS[tier];
  if (!fn) return no(tier, 'unknown tier');
  const plan = fn(hw, cfg, inv);
  return { ...plan, label: cfg.labels[tier], title: (cfg.titles || {})[tier] || cfg.labels[tier] };
}

const planAll = (hw, cfg, inv) => [0, 1, 2, 3].map((t) => planTier(t, hw, cfg, inv));

/* ---------------------------------- Launch arguments --------------------------------------- */

/**
 * The engine's CLI args. The model's `-m <path>` is added by the caller and is ALWAYS a local file:
 * `-hf` (download at launch) is never emitted, because a launch is not a download.
 *
 * THE OVERRIDE KEYS ARE DATA, NEVER LITERALS. They address the model's own metadata (its loop count
 * and its per-loop KV layout), so they name the model family — and a person with our bundle should not
 * be able to learn that family from one grep. They arrive from the downloaded manifest as
 * `engine.overrides.loops` / `engine.overrides.cache`, and a launch with neither is REFUSED rather
 * than run with an empty flag: an empty override silently gives a different model configuration,
 * which is worse than a refusal.
 */
function buildServerArgs(plan, { port, apiKey, cfg, overrides } = {}) {
  const keys = overrides || {};
  if (!keys.loops || !keys.cache) throw new Error('E_MANIFEST: the engine override keys were not supplied to the launch');
  const np = cfg.server.parallel;
  const args = [
    '--host', '127.0.0.1', '--port', String(port), '--api-key', apiKey,
    '-c', String(plan.ctx * np), '-np', String(np),
    '-ngl', plan.backend === 'cpu' ? '0' : '999', // virtual layers (192 at 4 loops): a small -ngl silently offloads part of the model
    '-t', String(plan.threads), '--threads-batch', String(plan.threads),
    '-fa', 'on', '-ctk', plan.kvq, '-ctv', plan.kvq, '--no-context-shift',
    '--override-kv', `${keys.loops}=int:${plan.loops},${keys.cache}=str:${plan.cache}`,
    ...cfg.server.baseArgs,
  ];
  if (cfg.server.swaFull) args.push('--swa-full');
  if (plan.tensorSplit) args.push('--tensor-split', plan.tensorSplit.join(','));
  if (plan.nkvo) args.push('-nkvo');
  return args;
}

/**
 * The environment the engine needs for the backend it was planned onto, and NOTHING for the others:
 * CUDA device order for CUDA, the Vulkan visibility list for Vulkan, and a hidden CUDA for the CPU
 * floor so a CUDA-capable machine cannot silently offload a "CPU" plan.
 */
function buildEnv(plan) {
  if (plan.backend === 'cuda') return { CUDA_DEVICE_ORDER: 'PCI_BUS_ID', CUDA_VISIBLE_DEVICES: plan.gpus.join(',') };
  if (plan.backend === 'vulkan') return { GGML_VK_VISIBLE_DEVICES: plan.gpus.join(','), CUDA_VISIBLE_DEVICES: '-1' };
  if (plan.backend === 'rocm') return { HIP_VISIBLE_DEVICES: plan.gpus.join(','), CUDA_VISIBLE_DEVICES: '-1' };
  if (plan.backend === 'metal') return {}; // one unified device: nothing to select, nothing to hide
  return { CUDA_VISIBLE_DEVICES: '-1' }; // the CPU floor must not be able to offload
}

module.exports = {
  planTier, planAll, buildServerArgs, buildEnv,
  kvBytes, maxCtx, weightsBytes, chooseQuant, gpuRoom, ramRoom, usableGpus, fitKv,
  RUNGS, GiB, MiB,
};
