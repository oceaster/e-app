'use strict';
/**
 * config.cjs — every tuning constant the local model engine has, and nothing about one machine.
 *
 * The old shape's centre of gravity was here: a table of numbers for one pair of cards. A tier is
 * a CAPABILITY BUDGET now, the numbers below are the *policy* (how much of a machine a rung may
 * spend), and which rung a particular computer lands on is computed at run time by planner.cjs from
 * measured hardware. Override any key with createLocalAI({config: {...}}) — nested objects merge.
 */
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

module.exports = {
  // Used only to ESTIMATE a weight size when the manifest has no size for a quant.
  model: {
    paramsB: 3.97,
    bytesPerParam: { Q4_K_M: 0.60, Q5_K_M: 0.71, Q8_0: 1.07, BF16: 2.0 },
    // Best quality first. planner.cjs takes the LARGEST of these that fits the measured budget.
    quality: ['BF16', 'Q8_0', 'Q5_K_M', 'Q4_K_M'],
    // Stated default: the quant used when none of a tier's better quants fit at all, so a refusal
    // can name exactly what it would have needed instead of only saying "too small".
    defaultQuant: 'Q4_K_M',
  },

  // Dory attention layout (from the model card): 20 recurrent layers, 3 sliding-window : 1 full,
  // 4 KV heads, head_dim 256 -> 4 KiB/token/layer at f16. Sliding layers are capped at the window
  // (llama.cpp's iSWA cache, i.e. WITHOUT --swa-full), so only the 5 full layers grow with context.
  // Verify against the server's own "KV buffer size" line: see diagnostics().kvCalibration.
  arch: { recurrentLayers: 20, fullEvery: 4, kvHeads: 4, headDim: 256, slidingWindow: 1024, swaPadTokens: 512 },

  ctx: {
    max: 262144, // Dory's window. All values are PER SLOT (per parallel sequence).
    min: { 0: 4096, 1: 8192, 2: 8192, 3: 16384 },
    target: { 0: 8192, 1: 16384, 2: 131072, 3: 262144 },
  },

  loops: { 0: 2, 1: 1, 2: 2, 3: 4 }, // 2 = default, 4 = agentic/accuracy; Tier 1 is the cheap rung

  // The quants each rung is WILLING to use, best first. The plan reports which one it chose and why
  // the better ones were rejected.
  quant: {
    cpu: ['Q4_K_M', 'Q5_K_M', 'Q8_0'],
    t1: ['Q4_K_M', 'Q5_K_M'],
    t2: ['Q8_0'],
    t3: ['BF16', 'Q8_0'],
  },

  // KV layouts tried in order until one fits at >= the rung's minimum context.
  candidates: {
    default: [{ cache: 'per_loop', kvq: 'f16' }, { cache: 'last_loop', kvq: 'f16' }, { cache: 'last_loop', kvq: 'q8_0' }],
    lossless: [{ cache: 'per_loop', kvq: 'f16' }],
    pro: [{ cache: 'per_loop', kvq: 'f16' }, { cache: 'last_loop', kvq: 'f16' }, { cache: 'last_loop', kvq: 'q8_0' }],
  },

  memory: {
    // Never budgeted to the engine: the desktop needs it. On a small machine the reserve scales
    // down with what is free, because 2 GiB of an 8 GiB laptop's 4 GiB free is the whole answer.
    osReserveBytes: 2 * GiB,
    osReserveFloorBytes: 512 * MiB,
    // Unified memory (Apple silicon, an integrated GPU): the GPU addresses system RAM, so this is
    // the FRACTION of RAM a GPU on the same pool may use, and the RAM budget is never added to it.
    appleGpuFraction: 0.7,
    unifiedReserveBytes: 1.5 * GiB,
    cpuT0: { threadFraction: 0.5, ramFraction: 0.5, priority: 'below_normal' },
    cpuT1: { threadFraction: 1.0, ramFraction: 1.0, priority: 'low' },
    spillFraction: 0.6, // tier 3: KV in system RAM, and how much of RAM it may use
  },

  gpu: {
    overheadBytes: 0.75 * GiB, // driver + compute context
    displayHeadroomBytes: 1 * GiB, // a GPU presenting a desktop keeps this much for it
    minUsefulBytes: 2 * GiB, // below this a GPU cannot help: it is not a placement
    integratedMinUsefulBytes: 1 * GiB,
    integratedFraction: 0.5, // an iGPU may use half of system RAM at most (Windows does this too)
    unknownFreeFraction: 0.6, // free VRAM not reported by the driver: budget this share of the total
    primaryGpuIndex: null, // force which GPU presents the display; null = read it from the probes
    allowMultiGpu: false, // OPT-IN: --tensor-split with looped KV is untested
  },

  probe: { timeoutMs: 4000 },

  // A GPU that is doing work is never planned onto. Each floor is the point at which the probe's
  // signal counts as "somebody is using this now".
  guard: {
    streamProcessNames: ['sunshine', 'sunshinesvc', 'parsecd', 'obs64'],
    encoderPercent: 2,
    fullscreen3dPercent: 50,
    computeUsedBytes: 512 * MiB,
    // A GPU whose driver reports at least this share of its memory free is demonstrably idle, so
    // machine-wide activity counters may not condemn it.
    idleFreeShare: 0.6,
  },

  // What a rung needs before it is worth offering at all (checked before any quant is tried).
  minimums: {
    // THE FLOOR IS THE FLOOR. These are the smallest machines a rung is offered on at all; whether
    // a particular quant then fits is decided by the measured budget, with an exact refusal.
    cpu: { logicalCores: 4, ramBytes: 8 * GiB },
    t1GpuFreeBytes: 4 * GiB,
    t2GpuFreeBytes: 5 * GiB,
    t3: { gpuFreeTotalBytes: 6 * GiB, ramBytes: 32 * GiB },
  },

  // Advanced override only. 'auto' resolves from the machine; the plan always reports placement+why.
  tier1: { prefer: 'auto' }, // 'auto' | 'gpu' | 'cpu'

  engine: { imageNames: ['llama-server'] }, // process image names we are allowed to adopt/kill

  labels: { 0: 'Eco', 1: 'Light', 2: 'Flash', 3: 'Pro' },
  titles: {
    0: 'Eco — the CPU floor, half the machine, nothing else slows down',
    1: 'Light — the cheap rung: small quant, one loop, short context',
    2: 'Flash — the best single GPU, lossless layout, long context',
    3: 'Pro — the most capable placement this machine can hold',
  },

  server: {
    startTimeoutMs: 300000,
    healthIntervalMs: 500,
    parallel: 2, // -np: a long agent turn must not block the person's chat
    swaFull: false, // true = full-size sliding caches (better prefix reuse, ~4x KV): measure first
    baseArgs: ['--jinja', '--reasoning', 'on', '--temp', '1.0', '--top-p', '0.95', '--top-k', '0', '--min-p', '0', '--repeat-penalty', '1'],
  },
};
