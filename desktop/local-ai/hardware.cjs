'use strict';
/**
 * hardware.cjs — ONE HARDWARE SNAPSHOT SHAPE, ON EVERY PLATFORM.
 *
 * This file used to answer one question ("what does nvidia-smi say?") and therefore described one
 * desk. A model server that ships to strangers has to answer the same questions on a Windows
 * laptop with an Intel iGPU, on an AMD desktop with no `nvidia-smi` anywhere on PATH, on an Apple
 * silicon Mac where VRAM *is* system RAM, and on a machine with no GPU at all. So the snapshot is
 * a fixed shape, and every probe belongs to one of five backends or is a fallback for one:
 *
 *   CUDA   nvidia-smi (the NVML CLI: total/free VRAM, display state, compute-app owners)
 *   ROCm   rocm-smi --json (AMD on Linux; total + used VRAM, and the pids holding it)
 *   Vulkan vulkaninfo --summary (AMD + Intel + NVIDIA: device name and INTEGRATED/DISCRETE)
 *   Metal  system_profiler SPDisplaysDataType -json (Apple; unified memory)
 *   CPU    no probe at all: always available, it is the floor
 *
 * VRAM SIZE on Windows comes from the driver's own registry value (HardwareInformation.qwMemorySize)
 * because Win32_VideoController.AdapterRAM is a uint32 and reports 4 GiB for a 24 GiB card.
 *
 * THREE RULES THIS FILE KEEPS, and they are why it is written this defensively:
 *  1. NOTHING HERE THROWS OR HANGS. Every probe has a timeout, and a missing binary is a named
 *     "not installed" in `backends`, never an exception and never an await that never returns.
 *  2. A BUSY GPU IS NAMED. Whether a GPU presents a display, is encoding, is held by a game or by
 *     another compute process is PROBED per platform, and the snapshot carries who holds it, so
 *     the planner can refuse or place elsewhere and say whose it is.
 *  3. IT IS INJECTABLE. `detect({exec, platform, arch, os})` takes every source of machine truth as
 *     a parameter, because a planner for strangers can only be tested against synthetic machines —
 *     no test in this repository reads the real hardware.
 *
 * The snapshot (same keys on every platform):
 *   { platform, arch, cpu:{model,logical}, ramTotal, ramFree, unifiedMemory, appleSilicon,
 *     gpus:[{ index, name, vendor, backend, integrated, unified, totalBytes, freeBytes, freeKnown,
 *             display, busy, busyOwner, sources }],
 *     backends:{ cuda|rocm|vulkan|metal|cpu: { available, devices:[], reason } },
 *     streaming:{ active, processes }, probes:[{ name, ok, ms, error }] }
 */
const os = require('os');
const { execFile } = require('child_process');

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** PowerShell's uint32 VideoController.AdapterRAM saturates here; a bigger card reports garbage. */
const UINT32_SATURATION = 4293918720;

/* ------------------------------------------------------------------ the runner */

/**
 * Run one command. NEVER throws, NEVER hangs: a missing binary, a non-zero exit, a timeout and
 * garbage output are all just `{ ok:false, error:'…' }`. `opts.name` is the probe name, which is
 * what the synthetic fixtures route on, so a test can drive a Windows machine from any desk.
 */
function runCommand(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs || 4000;
  const started = Date.now();
  return new Promise((resolve) => {
    const finish = (ok, stdout, stderr, error) => resolve({
      ok, stdout: String(stdout || ''), stderr: String(stderr || ''),
      ms: Date.now() - started, error: ok ? null : String(error || 'failed'),
    });
    let child;
    try {
      child = execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return finish(true, stdout, stderr, null);
          const reason = err.killed ? `timed out after ${timeoutMs}ms`
            : err.code === 'ENOENT' ? 'not installed'
              : String(err.code || err.message || 'failed');
          finish(false, stdout, stderr, reason);
        });
    } catch (e) {
      finish(false, '', '', e.message);
    }
    try { if (child && child.stdin) child.stdin.end(); } catch { /* already closed */ }
  });
}

/** One probe, contained: any rejection becomes a named failure and the snapshot keeps going. */
async function probe(name, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const row = { name, ok: !(result && result.ok === false), ms: Date.now() - started, error: (result && result.error) || null };
    return { name, result: result || { ok: false, error: 'no answer' }, row };
  } catch (e) {
    return { name, result: { ok: false, error: e.message }, row: { name, ok: false, ms: Date.now() - started, error: e.message } };
  }
}

/* ------------------------------------------------------------------ parsers */
/* Exported so every one of them is a unit test with a canned real-world sample.                  */

const num = (v) => {
  if (v == null) return null;
  const digits = String(v).replace(/[^\d.\-]/g, '');
  if (!digits || !/\d/.test(digits)) return null; // '[N/A]', 'NA', '' are unknowns, never zero
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
};
const tidy = (s) => String(s == null ? '' : s).trim().replace(/^"|"$/g, '');

/**
 * `nvidia-smi --query-gpu=index,name,memory.total,memory.free,display_active --format=csv,noheader,nounits`
 * nvidia-smi can emit `[N/A]` for individual fields (a vGPU, a WSL stub): that is an unknown, not a
 * zero, so it stays null and the planner is told `freeKnown:false`.
 */
function nvidiaSmi(out) {
  const gpus = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < 4) continue;
    const total = num(cells[2]);
    const free = num(cells[3]);
    if (total === null) continue;
    gpus.push({
      index: num(cells[0]) === null ? gpus.length : num(cells[0]),
      uuid: cells[5] || null,
      name: cells[1] || 'GPU',
      vendor: 'nvidia',
      backend: 'cuda',
      integrated: false,
      unified: false,
      totalBytes: total * MiB,
      freeBytes: free === null ? null : free * MiB,
      freeKnown: free !== null,
      display: /^enabled$/i.test(cells[4] || ''),
      sources: ['nvidia-smi'],
    });
  }
  return gpus;
}

/**
 * `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory --format=csv,noheader,nounits`
 * The owner of a GPU that is already doing work, and WHICH card it holds: the uuid is what lets the
 * planner say "GPU 0 is being used by Fixture Game" instead of refusing every GPU on the machine.
 * Process names can contain commas (a full path), so the pid is the second cell, the memory the
 * last, and everything between is the name.
 */
function nvidiaComputeApps(out) {
  const apps = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = line.split(',').map((c) => c.trim());
    if (cells.length < 3) continue;
    const used = num(cells[cells.length - 1]);
    const uuid = /^GPU-[0-9a-f-]+$/i.test(cells[0]) ? cells[0] : null;
    const body = uuid ? cells.slice(1) : cells;
    apps.push({ uuid, pid: num(body[0]), name: body.slice(1, -1).join(',') || 'unknown', usedBytes: used === null ? null : used * MiB });
  }
  return apps;
}

/**
 * `rocm-smi --showmeminfo vram --showproductname --json`
 * Shape varies by version (`card0` vs `GPU[0]`); both are read. Free is total minus used.
 */
function rocmSmi(out) {
  let json;
  try { json = JSON.parse(String(out || '')); } catch { return []; }
  const gpus = [];
  for (const [key, card] of Object.entries(json || {})) {
    if (!card || typeof card !== 'object') continue;
    if (!/^(card|GPU\[|gpu)/i.test(key)) continue;
    const pick = (re) => {
      for (const [k, v] of Object.entries(card)) if (re.test(k)) return v;
      return null;
    };
    const total = num(pick(/VRAM Total Memory/i));
    const used = num(pick(/VRAM Total Used Memory/i));
    if (total === null) continue;
    const name = tidy(pick(/Card series|Card model|Device Name|Card SKU/i)) || 'GPU';
    gpus.push({
      index: gpus.length,
      name,
      vendor: 'amd',
      backend: 'rocm',
      integrated: /graphics/i.test(name) && !/\brx\b|\bpro\b|\bvii\b/i.test(name),
      unified: false,
      totalBytes: total,
      freeBytes: used === null ? null : Math.max(0, total - used),
      freeKnown: used !== null,
      display: false,
      sources: ['rocm-smi'],
    });
  }
  return gpus;
}

/** `rocm-smi --showpids --json` — { card0: { processes: [{ pid, name, … }] } } (older builds: arrays). */
function rocmPids(out) {
  let json;
  try { json = JSON.parse(String(out || '')); } catch { return []; }
  const apps = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    if (value.pid !== undefined) return apps.push({ pid: num(value.pid), name: String(value.name || value.processName || 'unknown'), usedBytes: null });
    for (const child of Object.values(value)) walk(child);
  };
  walk(json);
  return apps;
}

/**
 * `vulkaninfo --summary` — the vendor-neutral path used by AMD and Intel cards, and by NVIDIA when
 * the CUDA pack cannot run. It answers the two questions no other portable tool does: what the
 * device is, and whether it is INTEGRATED (memory shared with the OS) or DISCRETE.
 */
function vulkaninfo(out) {
  const text = String(out || '');
  const blocks = text.split(/^\s*GPU\d+:\s*$/m).slice(1);
  const devices = [];
  for (const block of blocks) {
    const field = (re) => { const m = re.exec(block); return m ? tidy(m[1]) : ''; };
    const name = field(/deviceName\s*=\s*(.+)/i);
    if (!name) continue;
    const type = field(/deviceType\s*=\s*(.+)/i);
    const driver = `${field(/driverID\s*=\s*(.+)/i)} ${field(/driverName\s*=\s*(.+)/i)}`.trim();
    devices.push({
      name,
      type,
      driver,
      integrated: /INTEGRATED_GPU/i.test(type) || /intel|llvmpipe/i.test(driver),
      index: devices.length,
    });
  }
  return devices;
}

/**
 * `system_profiler SPDisplaysDataType -json` on macOS. On Apple silicon the VRAM row is the unified
 * memory the GPU may address, so the caller marks it `unified` and never adds it to RAM.
 */
function systemProfiler(out) {
  let json;
  try { json = JSON.parse(String(out || '')); } catch { return []; }
  const blocks = json && json.SPDisplaysDataType;
  if (!Array.isArray(blocks)) return [];
  const gpus = [];
  for (const block of blocks) {
    const model = tidy(block.sppci_model) || 'Apple GPU';
    const chips = Array.isArray(block.spdisplays_ndrvs) ? block.spdisplays_ndrvs : [];
    const seen = chips.length ? chips : [{}];
    for (const chip of seen) {
      const name = tidy(chip._name || chip.spdisplays_name) || model;
      const vramText = tidy(chip.spdisplays_vram || chip.spdisplays_vram_shared || '');
      const m = /([\d.]+)\s*(TB|GB|MB|GiB|MiB)/i.exec(vramText);
      const scale = !m ? 0 : /^T/i.test(m[2]) ? 1024 * GiB : /^G/i.test(m[2]) ? GiB : MiB;
      const apple = /apple/i.test(model) || /apple/i.test(name);
      const unified = apple || /yes/i.test(tidy(chip.spdisplays_vram_shared));
      gpus.push({
        index: gpus.length,
        name,
        vendor: apple ? 'apple' : 'unknown',
        backend: 'metal',
        integrated: unified,
        unified,
        totalBytes: m ? Math.round(Number(m[1]) * scale) : null,
        freeBytes: null,
        freeKnown: false,
        display: true,
        sources: ['system_profiler'],
      });
    }
  }
  return gpus;
}

/**
 * `Get-CimInstance Win32_VideoController | ConvertTo-Json` — the Windows fallback that exists when
 * nvidia-smi does not, and the only place an integrated Intel/AMD adapter is visible on a machine
 * whose drivers expose no other tool. AdapterRAM is junk above 4 GiB; the real size comes from the
 * registry probe below, and this fills the name/vendor/integration.
 */
function windowsVideoControllers(out) {
  let json;
  try { json = JSON.parse(String(out || '')); } catch { return []; }
  if (!json) return [];
  const rows = Array.isArray(json) ? json : [json];
  const gpus = [];
  for (const row of rows) {
    if (!row) continue;
    const name = tidy(row.Name || row.name);
    if (!name) continue;
    if (/Microsoft Basic|Remote Display|DameWare|Virtual Desktop/i.test(name)) continue;
    const vendorText = `${tidy(row.AdapterCompatibility || row.adaptercompatibility)} ${name}`;
    const vendor = /nvidia/i.test(vendorText) ? 'nvidia'
      : /intel/i.test(vendorText) ? 'intel'
        : /amd|advanced micro devices|radeon|ati/i.test(vendorText) ? 'amd' : 'unknown';
    const raw = num(row.AdapterRAM != null ? row.AdapterRAM : row.adapterram);
    const totalBytes = raw && raw < UINT32_SATURATION ? raw : null;
    const integrated = /intel/i.test(vendorText)
      || /radeon\(tm\) graphics|vega \d+ graphics|radeon graphics|uhd graphics|iris/i.test(name);
    gpus.push({ index: gpus.length, name, vendor, integrated, totalBytes, sources: ['win32-video-controller'] });
  }
  return gpus;
}

/**
 * `Get-ItemProperty …\Class\{4d36e968-…}\* -Name 'HardwareInformation.qwMemorySize','DriverDesc'`
 * The only dependency-free source of a real VRAM size on Windows (a QWORD per adapter).
 */
function windowsVramRegistry(out) {
  let json;
  try { json = JSON.parse(String(out || '')); } catch { return []; }
  if (!json) return [];
  const rows = Array.isArray(json) ? json : [json];
  const sizes = [];
  for (const row of rows) {
    if (!row) continue;
    const raw = row['HardwareInformation.qwMemorySize'];
    const bytes = raw && typeof raw === 'object' && raw.value !== undefined ? num(raw.value) : num(raw);
    if (!bytes) continue;
    sizes.push({ name: tidy(row.DriverDesc || ''), bytes });
  }
  return sizes;
}

/**
 * `Get-Counter '\GPU Engine(*)\Utilization Percentage' | ConvertTo-Json` — the Windows answer to
 * "is a game or an encoder using this GPU", per engine type, which is the only per-process signal
 * Windows exposes to a process without a native module.
 */
function windowsGpuCounters(out) {
  let json;
  try { json = JSON.parse(String(out || '')); } catch { return null; }
  const raw = (json && json.CounterSamples) || json;
  const samples = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const totals = { threeD: 0, encode: 0, decode: 0 };
  const seen = [];
  for (const sample of samples) {
    if (!sample) continue;
    const instance = String(sample.InstanceName || sample.Path || '');
    const value = Number(sample.CookedValue);
    if (!Number.isFinite(value)) continue;
    const type = /engtype_(\w+)/i.exec(instance);
    const pid = /pid_(\d+)/i.exec(instance);
    const kind = type ? type[1].toLowerCase() : '';
    if (kind === '3d') totals.threeD += value;
    else if (kind === 'videoencode') totals.encode += value;
    else if (kind === 'videodecode') totals.decode += value;
    if (pid && value >= 1) seen.push({ pid: Number(pid[1]), kind, percent: value });
  }
  return { ...totals, processes: seen };
}

/** `ps -A -o comm=` or `tasklist /FO CSV /NH`: which known stream host is running, by name. */
function streamHostProcesses(out, names) {
  const text = String(out || '').toLowerCase();
  return (names || []).filter((n) => n && text.includes(n.toLowerCase()));
}

/* ------------------------------------------------------------------ merging */

const INTEGRATED_NAME = /uhd graphics|iris|radeon\(tm\) graphics|vega \d+ graphics|radeon graphics|intel.*graphics/i;

function backendFor(vendor, platform) {
  if (vendor === 'apple') return 'metal';
  if (vendor === 'nvidia') return 'cuda';
  if (vendor === 'amd' && platform !== 'win32') return 'rocm';
  return 'vulkan';
}

/**
 * One adapter list from every source that saw something. Preference order: a vendor tool that
 * reports FREE memory beats a Vulkan summary that only knows the name, which beats WMI.
 */
function mergeGpus({ primary = [], macGpus = [], vulkanDevices = [], winControllers = [], winSizes = [], platform }) {
  const gpus = [...primary, ...macGpus].map((g) => ({ ...g }));
  const sameName = (a, b) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));
  const find = (name) => gpus.find((g) => sameName(g.name, name));

  for (const device of vulkanDevices) {
    const existing = find(device.name);
    if (existing) {
      existing.sources.push('vulkaninfo');
      if (!['cuda', 'metal', 'rocm'].includes(existing.backend)) existing.backend = 'vulkan';
      if (existing.integrated == null) existing.integrated = device.integrated;
      continue;
    }
    gpus.push({
      index: gpus.length,
      name: device.name,
      vendor: /intel/i.test(`${device.driver} ${device.name}`) ? 'intel' : /amd|radeon/i.test(device.name) ? 'amd' : 'unknown',
      backend: 'vulkan', integrated: device.integrated, unified: false,
      totalBytes: null, freeBytes: null, freeKnown: false, display: false, sources: ['vulkaninfo'],
    });
  }

  for (const controller of winControllers) {
    const existing = find(controller.name);
    if (existing) {
      existing.sources.push(...controller.sources);
      if (existing.totalBytes == null) existing.totalBytes = controller.totalBytes;
      if (existing.integrated == null) existing.integrated = controller.integrated;
      continue;
    }
    gpus.push({
      ...controller, backend: backendFor(controller.vendor, platform),
      unified: false, freeBytes: null, freeKnown: false, display: false,
    });
  }

  for (const gpu of gpus) {
    if (gpu.totalBytes == null) {
      const match = winSizes.find((s) => sameName(s.name, gpu.name));
      if (match) gpu.totalBytes = match.bytes;
    }
    if (gpu.integrated == null) gpu.integrated = INTEGRATED_NAME.test(gpu.name);
    // An integrated adapter has no memory of its own: it addresses system RAM, so it must never be
    // counted as a second pool beside `ramTotal`. That is true whichever probe found it, and the
    // first version of this line only honoured it when no probe had claimed otherwise.
    if (gpu.integrated) gpu.unified = true;
    if (gpu.vendor === 'apple') gpu.unified = true;
    gpu.backend = gpu.backend || backendFor(gpu.vendor, platform);
    gpu.display = !!gpu.display;
    gpu.busy = gpu.busy || false;
    gpu.busyOwner = gpu.busyOwner || '';
    if (gpu.freeBytes == null && gpu.freeKnown == null) gpu.freeKnown = false;
  }
  return gpus;
}

/**
 * WHO HOLDS THE GPU. A GPU already doing work is never planned onto: it is refused, or placed
 * elsewhere, and the `why` names it. Levels, strongest first:
 *   'stream-host' — a remote-stream host (Sunshine/Parsec/OBS) is running: which GPU it encodes on
 *                   is not something we can know, so every GPU is treated as held.
 *   'encoding'    — a video encoder is active (Windows GPU Engine counters).
 *   'game'        — loud 3D work: a full-screen game owns the GPU right now.
 *   'compute'     — another compute process holds a real allocation (nvidia-smi/rocm-smi names it).
 * A `display` flag is recorded separately: a desktop GPU is not "free", it is *presenting*, which
 * costs headroom and loses every preference contest, but is not the same as being held by a game.
 */
function classifyBusy(gpus, { streaming, counters, computeApps, cfg } = {}) {
  const guard = (cfg && cfg.guard) || {};
  const encoderFloor = guard.encoderPercent == null ? 2 : guard.encoderPercent;
  const gameFloor = guard.fullscreen3dPercent == null ? 50 : guard.fullscreen3dPercent;
  const computeFloor = guard.computeUsedBytes == null ? 512 * MiB : guard.computeUsedBytes;
  const idleShare = guard.idleFreeShare == null ? 0.6 : guard.idleFreeShare;
  const idle = (gpu) => gpu.freeKnown && gpu.totalBytes && gpu.freeBytes / gpu.totalBytes >= idleShare;
  const held = (computeApps || []).filter((a) => a.usedBytes == null || a.usedBytes >= computeFloor);

  for (const gpu of gpus) {
    gpu.busy = false;
    gpu.busyOwner = '';
    // A stream host is the only holder we cannot place on a card: it is treated as holding them all.
    if (streaming && streaming.active) {
      gpu.busy = 'stream-host';
      gpu.busyOwner = (streaming.processes || []).join(', ');
      continue;
    }
    // A named compute process, attributed by GPU uuid, is exact evidence: it wins over counters.
    const named = gpu.uuid ? held.filter((a) => !a.uuid || a.uuid === gpu.uuid) : held;
    if (named.length) {
      gpu.busy = 'compute';
      gpu.busyOwner = named.map((a) => `${a.name}${a.pid ? ` (pid ${a.pid})` : ''}`).join(', ');
      continue;
    }
    // Windows GPU Engine counters are machine-wide: they may only speak about a GPU that has not
    // just told us most of its memory is free. Otherwise one full-screen game would condemn every
    // card in the box, and a second card is exactly the placement that should happen instead.
    if (idle(gpu)) continue;
    if (counters && counters.encode >= encoderFloor) { gpu.busy = 'encoding'; gpu.busyOwner = 'a video encoder'; continue; }
    if (counters && counters.threeD >= gameFloor) { gpu.busy = 'game'; gpu.busyOwner = 'a full-screen application'; continue; }
  }
  return gpus;
}

/**
 * Unified memory (Apple silicon, and any integrated adapter): the GPU addresses the SAME bytes the
 * CPU does, so a budget that adds `ramTotal` to a VRAM figure counts the same GiB twice. For a
 * unified GPU the size it may use is a fraction of system RAM, and its "free" is what is left of
 * that fraction after the OS reserve — never `ramTotal` added to a VRAM number.
 */
function unifiedBudget(gpu, { ramTotal, ramFree, cfg }) {
  const fraction = (cfg && cfg.memory && cfg.memory.appleGpuFraction) || 0.7;
  const reserve = (cfg && cfg.memory && cfg.memory.unifiedReserveBytes) || 1.5 * GiB;
  const usable = Math.min(Math.round(ramTotal * fraction), Math.max(0, ramFree - reserve));
  return { totalBytes: usable, freeBytes: Math.max(0, usable), freeKnown: true, unified: true };
}

/* ------------------------------------------------------------------ detect */

const PLATFORM_PROBES = {
  // Linux: the vendor tools, the vendor-neutral Vulkan summary, and the stream-host list.
  linux: (call) => [
    probe('nvidia-smi', () => call('nvidia-smi', ['--query-gpu=index,name,memory.total,memory.free,display_active,uuid', '--format=csv,noheader,nounits'], 6000)),
    probe('nvidia-smi-apps', () => call('nvidia-smi', ['--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'], 6000)),
    probe('rocm-smi', () => call('rocm-smi', ['--showmeminfo', 'vram', '--showproductname', '--json'], 6000)),
    probe('rocm-smi-pids', () => call('rocm-smi', ['--showpids', '--json'], 6000)),
    probe('vulkaninfo', () => call('vulkaninfo', ['--summary'], 6000)),
    probe('stream-hosts', () => call('ps', ['-A', '-o', 'comm='], 4000)),
  ],
  // Windows is the default path, so it gets its own tools: the WMI adapter list (works with no
  // vendor tool at all), the driver's registry VRAM size, and GPU Engine counters for activity.
  win32: (call) => [
    probe('nvidia-smi', () => call('nvidia-smi', ['--query-gpu=index,name,memory.total,memory.free,display_active,uuid', '--format=csv,noheader,nounits'], 6000)),
    probe('nvidia-smi-apps', () => call('nvidia-smi', ['--query-compute-apps=gpu_uuid,pid,process_name,used_gpu_memory', '--format=csv,noheader,nounits'], 6000)),
    probe('vulkaninfo', () => call('vulkaninfo', ['--summary'], 6000)),
    probe('windows-controllers', () => call('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,AdapterCompatibility,DriverVersion | ConvertTo-Json -Compress'], 10000)),
    probe('windows-vram', () => call('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\*' -Name HardwareInformation.qwMemorySize,DriverDesc -ErrorAction SilentlyContinue | ConvertTo-Json -Compress"], 10000)),
    probe('windows-counters', () => call('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "(Get-Counter -Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Select-Object InstanceName,CookedValue | ConvertTo-Json -Compress"], 12000)),
    probe('stream-hosts', () => call('tasklist', ['/FO', 'CSV', '/NH'], 6000)),
  ],
  // macOS: Metal, and unified memory is the NORM rather than an exception.
  darwin: (call) => [
    probe('mac-displays', () => call('system_profiler', ['SPDisplaysDataType', '-json'], 12000)),
    probe('stream-hosts', () => call('ps', ['-A', '-o', 'comm='], 4000)),
  ],
};

/**
 * Measure THE MACHINE THIS RUNS ON — or the machine a fixture describes, when every source of
 * truth is injected. Never throws; every probe's verdict lands in `probes`.
 */
async function detect(options = {}) {
  const cfg = options.cfg || require('./config.cjs');
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const exec = options.exec || runCommand;
  const info = options.os || { cpus: os.cpus(), totalmem: os.totalmem(), freemem: os.freemem() };
  const timeoutMs = (cfg.probe && cfg.probe.timeoutMs) || 4000;
  const call = (cmd, args, ownTimeout) => exec(cmd, args, { timeoutMs: ownTimeout || timeoutMs });

  const cpus = Array.isArray(info.cpus) ? info.cpus : [];
  const ramTotal = Number(info.totalmem) || 0;
  const ramFree = Number(info.freemem) || 0;

  const build = PLATFORM_PROBES[platform] || PLATFORM_PROBES.linux;
  const results = await Promise.all(build(call));
  const by = {};
  for (const item of results) by[item.name] = item;

  const text = (name) => (by[name] && by[name].result && by[name].result.ok ? by[name].result.stdout : '');
  const failOf = (name, fallback) => (by[name] && by[name].result && by[name].result.error) || fallback;
  const streamNames = (cfg.guard && cfg.guard.streamProcessNames) || [];

  const gpus = mergeGpus({
    primary: [...nvidiaSmi(text('nvidia-smi')), ...rocmSmi(text('rocm-smi'))],
    macGpus: systemProfiler(text('mac-displays')),
    vulkanDevices: vulkaninfo(text('vulkaninfo')),
    winControllers: windowsVideoControllers(text('windows-controllers')),
    winSizes: windowsVramRegistry(text('windows-vram')),
    platform,
  });

  const counters = by['windows-counters'] && by['windows-counters'].result.ok
    ? windowsGpuCounters(by['windows-counters'].result.stdout) : null;
  const computeApps = [...nvidiaComputeApps(text('nvidia-smi-apps')), ...rocmPids(text('rocm-smi-pids'))];
  const streamingProcesses = streamHostProcesses(text('stream-hosts'), streamNames);
  const streaming = { active: streamingProcesses.length > 0, processes: streamingProcesses };

  classifyBusy(gpus, { streaming, counters, computeApps, cfg });

  for (const gpu of gpus) {
    if (!gpu.unified) continue;
    Object.assign(gpu, unifiedBudget(gpu, { ramTotal, ramFree, cfg }));
  }

  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  const backends = {
    cuda: backendState(gpus, 'cuda', failOf('nvidia-smi', 'nvidia-smi reported no devices')),
    rocm: backendState(gpus, 'rocm', failOf('rocm-smi', 'rocm-smi reported no devices')),
    vulkan: backendState(gpus, 'vulkan', failOf('vulkaninfo', 'no Vulkan device reported')),
    metal: backendState(gpus, 'metal', appleSilicon ? 'no Metal device reported' : 'not macOS on Apple silicon'),
    cpu: { available: true, devices: [], reason: null },
  };

  return {
    platform,
    arch,
    cpu: { model: (cpus[0] && cpus[0].model) || info.model || 'unknown', logical: cpus.length || Number(info.logical) || 0 },
    ramTotal,
    ramFree,
    appleSilicon,
    unifiedMemory: appleSilicon || gpus.some((g) => g.unified),
    gpus,
    backends,
    streaming,
    probes: results.map((r) => r.row),
  };
}

function backendState(gpus, backend, reason) {
  const devices = gpus.filter((g) => g.backend === backend).map((g) => g.index);
  return { available: devices.length > 0, devices, reason: devices.length ? null : reason };
}

module.exports = {
  detect,
  runCommand,
  // exported for tests: each parser is a unit with a canned real-world sample
  parsers: {
    nvidiaSmi, nvidiaComputeApps, rocmSmi, rocmPids, vulkaninfo, systemProfiler,
    windowsVideoControllers, windowsVramRegistry, windowsGpuCounters, streamHostProcesses,
  },
  mergeGpus,
  classifyBusy,
  unifiedBudget,
  backendFor,
  GiB,
  MiB,
};
