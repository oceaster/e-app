'use strict';
/**
 * fixtures.cjs — SYNTHETIC MACHINES, because a planner for strangers cannot be tested on one desk.
 *
 * Each entry is a whole computer described the way the platform tools would describe it: the exact
 * command output `hardware.cjs` parses, plus the RAM and core counts the OS would report. The stub
 * executor below routes on the command AND a signature fragment of its arguments, so `detect()` runs
 * its real probe path — parsers included — against a machine that does not exist.
 *
 * That is the point: NO TEST IN THIS REPOSITORY READS THE REAL HARDWARE, and `node preview.cjs
 * --matrix` prints the same seven answers anywhere.
 *
 * The seven the ticket names, in order:
 *   no-gpu            a machine with no GPU at all
 *   one-8gib-gpu      one 8 GiB card, presenting the display
 *   igpu-8gib         an 8 GiB integrated GPU sharing system RAM
 *   two-nvidia-gpus   8 GiB + 12 GiB, the small one presenting the display
 *   amd-no-nvidia-smi an AMD card on a machine with no nvidia-smi at all
 *   apple-silicon     Apple silicon, unified memory (VRAM IS system RAM)
 *   laptop-8gib-ram   an 8 GiB-RAM laptop with an integrated GPU
 * and two more that carry the rules those seven do not:
 *   gaming-pc         two NVIDIA cards with a full-screen game on the display one
 *   streaming-pc      a card with a remote-stream host encoding on it
 */
const GiB = 1024 ** 3;

const cpus = (n, model) => Array.from({ length: n }, () => ({ model }));
const missing = (error = 'not installed') => ({ ok: false, stdout: '', error });

const NVIDIA_8 = '0, NVIDIA GeForce RTX 4070, 8188, 7120, Enabled';
const NVIDIA_12 = '1, NVIDIA GeForce RTX 3060, 12288, 11900, Disabled';

const VULKAN_INTEL_UHD = [
  '==========',
  'VULKANINFO',
  '==========',
  'Devices:',
  '========',
  'GPU0:',
  '\tapiVersion         = 1.3.280',
  '\tdriverVersion      = 2.0.300',
  '\tdriverName         = Intel open-source Mesa driver',
  '\tdriverID           = DRIVER_ID_INTEL_OPEN_SOURCE_MESA',
  '\tdriverInfo         = Mesa 24.0.9',
  '\tdeviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU',
  '\tdeviceName         = Intel(R) UHD Graphics 770 (ADL-S GT1)',
  '',
].join('\n');

const VULKAN_AMD = [
  'Devices:',
  '========',
  'GPU0:',
  '\tapiVersion         = 1.3.289',
  '\tdriverName         = radv',
  '\tdriverID           = DRIVER_ID_MESA_RADV',
  '\tdriverInfo         = Mesa radv 24.1.2',
  '\tdeviceType         = PHYSICAL_DEVICE_TYPE_DISCRETE_GPU',
  '\tdeviceName         = AMD Radeon RX 6700 XT (RADV NAVI22)',
  '',
].join('\n');

const MACHINES = [
  {
    id: 'no-gpu',
    label: 'a machine with no GPU at all',
    platform: 'linux',
    arch: 'x64',
    os: { cpus: cpus(16, 'Fixture Core i7'), totalmem: 32 * GiB, freemem: 20 * GiB },
    commands: [
      { cmd: 'nvidia-smi', match: '--query-gpu', ...missing() },
      { cmd: 'nvidia-smi', match: '--query-compute-apps', ...missing() },
      { cmd: 'rocm-smi', ...missing() },
      { cmd: 'vulkaninfo', ...missing('no vulkan loader') },
      { cmd: 'ps', ok: true, stdout: '/sbin/init\n/usr/bin/gnome-shell\n' },
    ],
  },
  {
    id: 'one-8gib-gpu',
    label: 'one 8 GiB NVIDIA card, presenting the display',
    platform: 'win32',
    arch: 'x64',
    os: { cpus: cpus(16, 'Fixture Ryzen 5'), totalmem: 32 * GiB, freemem: 21 * GiB },
    commands: [
      { cmd: 'nvidia-smi', match: '--query-gpu', ok: true, stdout: NVIDIA_8 },
      { cmd: 'nvidia-smi', match: '--query-compute-apps', ok: true, stdout: '' },
      { cmd: 'vulkaninfo', ...missing() },
      { cmd: 'powershell', match: 'Win32_VideoController', ok: true, stdout: JSON.stringify([{ Name: 'NVIDIA GeForce RTX 4070', AdapterRAM: 4293918720, AdapterCompatibility: 'NVIDIA' }]) },
      { cmd: 'powershell', match: 'qwMemorySize', ok: true, stdout: JSON.stringify([{ 'HardwareInformation.qwMemorySize': { value: 8573157376 }, DriverDesc: 'NVIDIA GeForce RTX 4070' }]) },
      { cmd: 'powershell', match: 'GPU Engine', ok: true, stdout: JSON.stringify([{ InstanceName: 'pid_4412_luid_0x00000000_0x0000C4B1_phys_0_eng_0_engtype_3D', CookedValue: 1.5 }]) },
      { cmd: 'tasklist', ok: true, stdout: '"System","4","Services","0","80 K"\n' },
    ],
  },
  {
    id: 'igpu-8gib',
    label: 'an integrated GPU with 8 GiB of system RAM to address',
    platform: 'win32',
    arch: 'x64',
    os: { cpus: cpus(12, 'Fixture Core i5'), totalmem: 16 * GiB, freemem: 11 * GiB },
    commands: [
      { cmd: 'nvidia-smi', ...missing() },
      { cmd: 'vulkaninfo', ok: true, stdout: VULKAN_INTEL_UHD },
      { cmd: 'powershell', match: 'Win32_VideoController', ok: true, stdout: JSON.stringify([{ Name: 'Intel(R) UHD Graphics 770', AdapterRAM: 1073741824, AdapterCompatibility: 'Intel Corporation' }]) },
      { cmd: 'powershell', match: 'qwMemorySize', ok: true, stdout: JSON.stringify([{ 'HardwareInformation.qwMemorySize': { value: 8589934592 }, DriverDesc: 'Intel(R) UHD Graphics 770' }]) },
      { cmd: 'powershell', match: 'GPU Engine', ok: true, stdout: JSON.stringify([{ InstanceName: 'pid_998_luid_0x00000000_0x0000A1B2_phys_0_eng_0_engtype_3D', CookedValue: 3 }]) },
      { cmd: 'tasklist', ok: true, stdout: '"explorer.exe","1200","Console","1","90 MB"\n' },
    ],
  },
  {
    id: 'two-nvidia-gpus',
    label: 'two NVIDIA cards, 8 GiB (display) + 12 GiB',
    platform: 'win32',
    arch: 'x64',
    os: { cpus: cpus(24, 'Fixture Core i9'), totalmem: 64 * GiB, freemem: 48 * GiB },
    commands: [
      { cmd: 'nvidia-smi', match: '--query-gpu', ok: true, stdout: `${NVIDIA_8}\n${NVIDIA_12}` },
      { cmd: 'nvidia-smi', match: '--query-compute-apps', ok: true, stdout: '' },
      { cmd: 'vulkaninfo', ...missing() },
      { cmd: 'powershell', match: 'Win32_VideoController', ok: true, stdout: JSON.stringify([
        { Name: 'NVIDIA GeForce RTX 4070', AdapterRAM: 4293918720, AdapterCompatibility: 'NVIDIA' },
        { Name: 'NVIDIA GeForce RTX 3060', AdapterRAM: 4293918720, AdapterCompatibility: 'NVIDIA' },
      ]) },
      { cmd: 'powershell', match: 'qwMemorySize', ok: true, stdout: JSON.stringify([
        { 'HardwareInformation.qwMemorySize': { value: 8573157376 }, DriverDesc: 'NVIDIA GeForce RTX 4070' },
        { 'HardwareInformation.qwMemorySize': { value: 12884901888 }, DriverDesc: 'NVIDIA GeForce RTX 3060' },
      ]) },
      { cmd: 'powershell', match: 'GPU Engine', ok: true, stdout: JSON.stringify([{ InstanceName: 'pid_77_luid_0x00000000_0x0000C4B1_phys_0_eng_0_engtype_3D', CookedValue: 2 }]) },
      { cmd: 'tasklist', ok: true, stdout: '"explorer.exe","1200","Console","1","90 MB"\n' },
    ],
  },
  {
    id: 'amd-no-nvidia-smi',
    label: 'an AMD card on a machine with no nvidia-smi at all',
    platform: 'linux',
    arch: 'x64',
    os: { cpus: cpus(16, 'Fixture Ryzen 7'), totalmem: 32 * GiB, freemem: 22 * GiB },
    commands: [
      { cmd: 'nvidia-smi', match: '--query-gpu', ...missing('not installed') },
      { cmd: 'nvidia-smi', match: '--query-compute-apps', ...missing('not installed') },
      { cmd: 'rocm-smi', match: '--showmeminfo', ok: true, stdout: JSON.stringify({ card0: { 'Card series': 'Radeon RX 6700 XT', 'VRAM Total Memory (B)': String(12 * GiB), 'VRAM Total Used Memory (B)': String(256 * 1024 * 1024) } }) },
      { cmd: 'rocm-smi', match: '--showpids', ok: true, stdout: JSON.stringify({ card0: {} }) },
      { cmd: 'vulkaninfo', ok: true, stdout: VULKAN_AMD },
      { cmd: 'ps', ok: true, stdout: '/sbin/init\n/usr/bin/kwin_wayland\n' },
    ],
  },
  {
    id: 'apple-silicon',
    label: 'Apple silicon with unified memory (VRAM is system RAM)',
    platform: 'darwin',
    arch: 'arm64',
    os: { cpus: cpus(10, 'Apple M2 Pro'), totalmem: 16 * GiB, freemem: 12 * GiB },
    commands: [
      { cmd: 'system_profiler', ok: true, stdout: JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M2 Pro', spdisplays_ndrvs: [{ _name: 'Apple M2 Pro', spdisplays_vram: '10922 MB', spdisplays_vram_shared: 'yes' }] }] }) },
      { cmd: 'ps', ok: true, stdout: '/sbin/launchd\n/System/Library/CoreServices/WindowServer\n' },
    ],
  },
  {
    id: 'laptop-8gib-ram',
    label: 'an 8 GiB-RAM laptop with only an integrated GPU',
    platform: 'linux',
    arch: 'x64',
    os: { cpus: cpus(8, 'Fixture Core i5'), totalmem: 8 * GiB, freemem: 4 * GiB },
    commands: [
      { cmd: 'nvidia-smi', ...missing() },
      { cmd: 'rocm-smi', ...missing() },
      { cmd: 'vulkaninfo', ok: true, stdout: VULKAN_INTEL_UHD },
      { cmd: 'ps', ok: true, stdout: '/sbin/init\n' },
    ],
  },
  {
    id: 'gaming-pc',
    label: 'two NVIDIA cards with a full-screen game on the display one',
    platform: 'win32',
    arch: 'x64',
    os: { cpus: cpus(24, 'Fixture Core i9'), totalmem: 64 * GiB, freemem: 50 * GiB },
    commands: [
      { cmd: 'nvidia-smi', match: '--query-gpu', ok: true, stdout: `${NVIDIA_8}, GPU-3a1f0c22-8b6d-4f19-9c1e-77a1b0c9d001\n${NVIDIA_12}, GPU-5b2e7d41-1c3a-4e88-b0f2-19d4c8a7e002` },
      // The display card is held hard: nvidia-smi names the card (uuid), the process and the size,
      // which is exactly what lets the planner use the OTHER card and say whose the first one is.
      { cmd: 'nvidia-smi', match: '--query-compute-apps', ok: true, stdout: 'GPU-3a1f0c22-8b6d-4f19-9c1e-77a1b0c9d001, 4412, Fixture Game (Fixture Game.exe), 4210' },
      { cmd: 'vulkaninfo', ...missing() },
      { cmd: 'powershell', match: 'Win32_VideoController', ok: true, stdout: JSON.stringify([
        { Name: 'NVIDIA GeForce RTX 4070', AdapterRAM: 4293918720, AdapterCompatibility: 'NVIDIA' },
        { Name: 'NVIDIA GeForce RTX 3060', AdapterRAM: 4293918720, AdapterCompatibility: 'NVIDIA' },
      ]) },
      { cmd: 'powershell', match: 'qwMemorySize', ok: true, stdout: JSON.stringify([
        { 'HardwareInformation.qwMemorySize': { value: 8573157376 }, DriverDesc: 'NVIDIA GeForce RTX 4070' },
        { 'HardwareInformation.qwMemorySize': { value: 12884901888 }, DriverDesc: 'NVIDIA GeForce RTX 3060' },
      ]) },
      { cmd: 'powershell', match: 'GPU Engine', ok: true, stdout: JSON.stringify([{ InstanceName: 'pid_4412_luid_0x00000000_0x0000C4B1_phys_0_eng_0_engtype_3D', CookedValue: 92 }]) },
      { cmd: 'tasklist', ok: true, stdout: '"Fixture Game.exe","4412","Console","1","9,000 MB"\n' },
    ],
  },
  {
    id: 'streaming-pc',
    label: 'a workstation whose owner is streaming from it',
    platform: 'linux',
    arch: 'x64',
    os: { cpus: cpus(32, 'Fixture Threadripper'), totalmem: 64 * GiB, freemem: 50 * GiB },
    commands: [
      { cmd: 'nvidia-smi', match: '--query-gpu', ok: true, stdout: '0, NVIDIA GeForce RTX 4090, 24564, 21000, Enabled' },
      { cmd: 'nvidia-smi', match: '--query-compute-apps', ok: true, stdout: '' },
      { cmd: 'rocm-smi', ...missing() },
      { cmd: 'vulkaninfo', ...missing() },
      { cmd: 'ps', ok: true, stdout: '/usr/bin/sunshine\n/usr/bin/Xorg\n' },
    ],
  },
];

/**
 * An executor that answers from `machine.commands` and nothing else: same shape as runCommand,
 * routed by command name plus a substring of the joined arguments. An unmatched probe is a named
 * "not installed", which is what a machine without that tool would say.
 */
function stubExec(machine) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => {
    const line = `${cmd} ${(args || []).join(' ')}`;
    calls.push(line);
    const hit = (machine.commands || []).find((c) => c.cmd === cmd && (!c.match || line.includes(c.match)));
    if (!hit) return { ok: false, stdout: '', stderr: '', ms: 1, error: 'not installed' };
    return { ok: hit.ok !== false, stdout: hit.stdout || '', stderr: hit.stderr || '', ms: 1, error: hit.ok === false ? (hit.error || 'failed') : null };
  };
  exec.calls = calls;
  return exec;
}

/** detect() options for one fixture: the machine, all of it, and no fallback to the host. */
function optionsFor(machine, cfg) {
  const exec = stubExec(machine);
  return { cfg, platform: machine.platform, arch: machine.arch, os: machine.os, exec };
}

const byId = (id) => MACHINES.find((m) => m.id === id);

/** The model inventory a manifest would report, with realistic GGUF sizes for a ~4B model. */
const INVENTORY = {
  Q4_K_M: { bytes: Math.round(2.4 * GiB) },
  Q5_K_M: { bytes: Math.round(2.8 * GiB) },
  Q8_0: { bytes: Math.round(3.94 * GiB) },
  BF16: { bytes: Math.round(7.4 * GiB) },
};

module.exports = { MACHINES, stubExec, optionsFor, byId, INVENTORY, GiB };
