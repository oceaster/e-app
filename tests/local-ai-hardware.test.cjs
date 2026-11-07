'use strict';
// THE PROBES, ON EVERY PLATFORM, WITHOUT A GPU IN SIGHT.
//
// hardware.cjs answers one shape on every platform. These tests drive that shape from canned tool
// output (the same strings the real tools print, shortened), assert that a missing binary or a
// throwing probe is a NAMED failure rather than an exception or a hang, and pin the busy-GPU rule.
// Nothing here reads the machine the test runs on.
const test = require('node:test');
const assert = require('node:assert');

const cfg = require('../desktop/local-ai/config.cjs');
const { detect, runCommand, parsers, classifyBusy, unifiedBudget, backendFor } = require('../desktop/local-ai/hardware.cjs');
const fixtures = require('../desktop/local-ai/fixtures.cjs');

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

/* ------------------------------------------------------------------ parsers */

test('nvidia-smi: total/free/display, and [N/A] stays an unknown rather than becoming zero', () => {
  const gpus = parsers.nvidiaSmi([
    '0, NVIDIA GeForce RTX 3080, 10240, 9876, Enabled, GPU-aaaa',
    '1, NVIDIA A100-SXM4-80GB, 81920, 79000, Disabled, GPU-bbbb',
    '2, NVIDIA vGPU, 8192, [N/A], [N/A], GPU-cccc',
  ].join('\n'));
  assert.strictEqual(gpus.length, 3);
  assert.strictEqual(gpus[0].totalBytes, 10240 * MiB);
  assert.strictEqual(gpus[0].display, true);
  assert.strictEqual(gpus[0].uuid, 'GPU-aaaa');
  assert.strictEqual(gpus[1].display, false);
  assert.strictEqual(gpus[2].freeKnown, false, 'an unreadable free figure must not read as 0 GiB free');
  assert.strictEqual(gpus[2].freeBytes, null);
});

test('nvidia-smi compute apps: the uuid names the card, and a path with commas stays whole', () => {
  const apps = parsers.nvidiaComputeApps([
    'GPU-aaaa, 4412, C:\\Program Files\\Fixture Game\\game.exe, 4210',
    'GPU-bbbb, 991, python, 16384',
  ].join('\n'));
  assert.deepStrictEqual(apps.map((a) => a.uuid), ['GPU-aaaa', 'GPU-bbbb']);
  assert.strictEqual(apps[0].name, 'C:\\Program Files\\Fixture Game\\game.exe');
  assert.strictEqual(apps[0].usedBytes, 4210 * MiB);
});

test('rocm-smi: both output shapes are read, and free is total minus used', () => {
  const modern = parsers.rocmSmi(JSON.stringify({
    card0: { 'Card series': 'Radeon RX 7900 XTX', 'VRAM Total Memory (B)': String(24 * GiB), 'VRAM Total Used Memory (B)': String(2 * GiB) },
  }));
  assert.strictEqual(modern.length, 1);
  assert.strictEqual(modern[0].freeBytes, 22 * GiB);
  assert.strictEqual(modern[0].backend, 'rocm');
  const older = parsers.rocmSmi(JSON.stringify({ 'GPU[0]': { 'Card series': 'Radeon VII', 'VRAM Total Memory (B)': '17163091968' } }));
  assert.strictEqual(older[0].freeKnown, false, 'no used figure means free is unknown, not the whole card');
  assert.deepStrictEqual(parsers.rocmSmi('not json at all'), [], 'garbage is empty, never a throw');
});

test('vulkaninfo: the vendor-neutral path, including whether the device is INTEGRATED', () => {
  const devices = parsers.vulkaninfo([
    'Devices:', '========', 'GPU0:',
    '\tdriverID           = DRIVER_ID_MESA_RADV',
    '\tdeviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU',
    '\tdeviceName         = AMD Radeon RX 6800 (RADV NAVI21)', '',
    'GPU1:',
    '\tdriverID           = DRIVER_ID_INTEL_OPEN_SOURCE_MESA',
    '\tdeviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU',
    '\tdeviceName         = Intel(R) Iris Xe Graphics (TGL GT2)', '',
  ].join('\n'));
  assert.strictEqual(devices.length, 2);
  assert.strictEqual(devices[0].integrated, false);
  assert.strictEqual(devices[1].integrated, true);
});

test('system_profiler: Apple silicon reports unified memory, which is RAM and not a second pool', () => {
  const gpus = parsers.systemProfiler(JSON.stringify({
    SPDisplaysDataType: [{ sppci_model: 'Apple M3 Max', spdisplays_ndrvs: [{ _name: 'Apple M3 Max', spdisplays_vram: '36864 MB', spdisplays_vram_shared: 'yes' }] }],
  }));
  assert.strictEqual(gpus.length, 1);
  assert.strictEqual(gpus[0].backend, 'metal');
  assert.strictEqual(gpus[0].unified, true);
  assert.strictEqual(gpus[0].totalBytes, 36864 * MiB);
});

test('Windows: AdapterRAM saturation is refused, and the registry QWORD is the real size', () => {
  const controllers = parsers.windowsVideoControllers(JSON.stringify([
    { Name: 'NVIDIA GeForce RTX 4090', AdapterRAM: 4293918720, AdapterCompatibility: 'NVIDIA' },
    { Name: 'Intel(R) UHD Graphics 630', AdapterRAM: 1073741824, AdapterCompatibility: 'Intel Corporation' },
    { Name: 'Microsoft Basic Display Adapter', AdapterRAM: 0, AdapterCompatibility: 'Microsoft' },
  ]));
  assert.strictEqual(controllers.length, 2, 'a basic display adapter is not a GPU we can use');
  assert.strictEqual(controllers[0].totalBytes, null, 'the uint32 saturation value is not 4 GiB');
  assert.strictEqual(controllers[1].integrated, true);
  const sizes = parsers.windowsVramRegistry(JSON.stringify([
    { 'HardwareInformation.qwMemorySize': { value: 25769803776 }, DriverDesc: 'NVIDIA GeForce RTX 4090' },
  ]));
  assert.strictEqual(sizes[0].bytes, 24 * GiB);
});

test('Windows GPU Engine counters: 3D and video-encode activity are read per instance', () => {
  const counters = parsers.windowsGpuCounters(JSON.stringify([
    { InstanceName: 'pid_4412_luid_0x00000000_0x0000C4B1_phys_0_eng_7_engtype_VideoEncode', CookedValue: 42 },
    { InstanceName: 'pid_800_luid_0x00000000_0x0000C4B1_phys_0_eng_0_engtype_3D', CookedValue: 3 },
    { InstanceName: 'pid_800_luid_0x00000000_0x0000C4B1_phys_0_eng_1_engtype_VideoDecode', CookedValue: 1 },
  ]));
  assert.ok(counters.encode >= 42);
  assert.strictEqual(counters.threeD, 3);
  assert.ok(counters.processes.some((p) => p.kind === 'videoencode' && p.pid === 4412));
});

test('a stream host is found by image name on both process-list shapes', () => {
  assert.deepStrictEqual(parsers.streamHostProcesses('/usr/bin/sunshine\n/usr/bin/Xorg', ['sunshine']), ['sunshine']);
  assert.deepStrictEqual(parsers.streamHostProcesses('"sunshinesvc.exe","2200","Services","0","12 MB"', ['sunshinesvc']), ['sunshinesvc']);
  assert.deepStrictEqual(parsers.streamHostProcesses('"explorer.exe","1","Console","1","90 MB"', ['sunshine']), []);
});

/* ------------------------------------------------------------------ the runner */

test('a missing binary is a named "not installed", not a throw and not a hang', async () => {
  const result = await runCommand('surely-not-a-real-binary-xyz', ['--version'], { timeoutMs: 2000 });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error, 'not installed');
  assert.ok(result.ms < 2000);
});

test('a command that never finishes is killed at its timeout', async () => {
  const started = Date.now();
  const result = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /timed out after 200ms/);
  assert.ok(Date.now() - started < 4000, 'the probe timeout is the bound, not the child');
});

/* ------------------------------------------------------------------ detect */

test('detect never rejects: a probe that THROWS is a named failure and the CPU floor survives', async () => {
  const machine = fixtures.byId('one-8gib-gpu');
  const options = fixtures.optionsFor(machine, cfg);
  options.exec = async (cmd, args, opts) => {
    if (String(cmd) === 'nvidia-smi') throw new Error('driver exploded');
    if (String(cmd) === 'powershell') return { ok: false, stdout: '', error: 'Access is denied' };
    return { ok: false, stdout: '', error: 'not installed' };
  };
  const hw = await detect(options);
  assert.deepStrictEqual(hw.gpus, []);
  assert.strictEqual(hw.backends.cpu.available, true);
  assert.strictEqual(hw.backends.cuda.available, false);
  assert.match(hw.backends.cuda.reason, /driver exploded/);
  assert.ok(hw.probes.some((p) => p.name === 'nvidia-smi' && p.ok === false));
  assert.ok(hw.probes.every((p) => typeof p.ms === 'number'), 'every probe records how long it took');
});

test('every probe is given a timeout, on every platform', async () => {
  const seen = [];
  for (const id of ['no-gpu', 'one-8gib-gpu', 'apple-silicon']) {
    const machine = fixtures.byId(id);
    const options = fixtures.optionsFor(machine, cfg);
    const inner = options.exec;
    options.exec = (cmd, args, opts) => { seen.push(opts && opts.timeoutMs); return inner(cmd, args, opts); };
    await detect(options);
  }
  assert.ok(seen.length >= 9, `only ${seen.length} probes ran`);
  assert.ok(seen.every((ms) => Number.isFinite(ms) && ms > 0), `a probe had no timeout: ${seen}`);
});

test('backends are PROBED, not assumed: each one answers its own availability and reason', async () => {
  const none = await detect(fixtures.optionsFor(fixtures.byId('no-gpu'), cfg));
  for (const name of ['cuda', 'rocm', 'vulkan', 'metal']) {
    assert.strictEqual(none.backends[name].available, false, `${name} must not be available with no GPU`);
    assert.ok(none.backends[name].reason && none.backends[name].reason.length > 3, `${name} has no named reason`);
  }
  assert.strictEqual(none.backends.cpu.available, true);
  const amd = await detect(fixtures.optionsFor(fixtures.byId('amd-no-nvidia-smi'), cfg));
  assert.strictEqual(amd.backends.cuda.available, false);
  assert.match(amd.backends.cuda.reason, /not installed/);
  assert.strictEqual(amd.backends.rocm.available, true);
  assert.deepStrictEqual(amd.backends.rocm.devices, [0]);
  const mac = await detect(fixtures.optionsFor(fixtures.byId('apple-silicon'), cfg));
  assert.strictEqual(mac.backends.metal.available, true);
  assert.strictEqual(mac.appleSilicon, true);
  assert.strictEqual(mac.unifiedMemory, true);
});

/* ------------------------------------------------------------------ busy GPUs */

test('busy: a stream host holds every GPU and is named', () => {
  const gpus = [{ index: 0, busy: false }, { index: 1, busy: false }];
  classifyBusy(gpus, { streaming: { active: true, processes: ['sunshine'] }, cfg });
  assert.deepStrictEqual(gpus.map((g) => g.busy), ['stream-host', 'stream-host']);
  assert.strictEqual(gpus[0].busyOwner, 'sunshine');
});

test('busy: a named compute process is attributed to ITS card by uuid, not to the whole machine', () => {
  const gpus = [{ index: 0, uuid: 'GPU-a', busy: false }, { index: 1, uuid: 'GPU-b', busy: false }];
  classifyBusy(gpus, { computeApps: [{ uuid: 'GPU-a', pid: 4412, name: 'Fixture Game', usedBytes: 4 * GiB }], cfg });
  assert.strictEqual(gpus[0].busy, 'compute');
  assert.match(gpus[0].busyOwner, /Fixture Game \(pid 4412\)/);
  assert.strictEqual(gpus[1].busy, false, 'the second card is free and must stay plannable');
});

test('busy: machine-wide counters may not condemn a GPU that reports most of its memory free', () => {
  const counters = { encode: 0, threeD: 95, decode: 0, processes: [] };
  const busyCard = { index: 0, totalBytes: 8 * GiB, freeBytes: 1 * GiB, freeKnown: true, busy: false };
  const idleCard = { index: 1, totalBytes: 12 * GiB, freeBytes: 11.6 * GiB, freeKnown: true, busy: false };
  classifyBusy([busyCard, idleCard], { counters, cfg });
  assert.strictEqual(busyCard.busy, 'game');
  assert.strictEqual(idleCard.busy, false);
  const encoder = [{ index: 0, totalBytes: 8 * GiB, freeBytes: 0.5 * GiB, freeKnown: true, busy: false }];
  classifyBusy(encoder, { counters: { encode: 30, threeD: 0, decode: 0, processes: [] }, cfg });
  assert.strictEqual(encoder[0].busy, 'encoding');
});

test('unified memory is capped by RAM, never by a VRAM claim of its own', () => {
  const bounded = unifiedBudget({ totalBytes: 40 * GiB, freeBytes: 40 * GiB }, { ramTotal: 16 * GiB, ramFree: 12 * GiB, cfg });
  assert.strictEqual(bounded.unified, true);
  assert.ok(bounded.totalBytes <= 16 * GiB, 'a 16 GiB machine cannot have 40 GiB of GPU memory');
  assert.ok(bounded.freeBytes <= 16 * GiB);
  assert.ok(bounded.freeBytes <= 12 * GiB, 'free can never exceed free system RAM');
});

test('an integrated adapter is unified whichever probe found it, on every platform', async () => {
  const win = await detect(fixtures.optionsFor(fixtures.byId('igpu-8gib'), cfg));
  assert.strictEqual(win.gpus[0].integrated, true);
  assert.strictEqual(win.gpus[0].unified, true);
  assert.strictEqual(win.unifiedMemory, true);
  assert.strictEqual(backendFor('intel', 'win32'), 'vulkan');
  assert.strictEqual(backendFor('amd', 'win32'), 'vulkan');
  assert.strictEqual(backendFor('amd', 'linux'), 'rocm');
  assert.strictEqual(backendFor('apple', 'darwin'), 'metal');
});
