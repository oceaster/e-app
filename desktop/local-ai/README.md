# local-ai — Dexter's local model server, run on the person's own computer

Zero-dependency main-process CommonJS that measures a computer, decides which capability rung it
can hold, downloads a pinned engine and model into `userData`, runs `llama-server` behind an
OpenAI-compatible endpoint, and reports honestly when it cannot.

`node preview.cjs` prints what each rung would do **on this machine**; `node preview.cjs --matrix`
prints the same table for nine synthetic machines. The plan table is OUTPUT, never a shipped answer.

## Wire-up (already done in this app)

1. **Main** (`desktop/main.cjs`): `createLocalAI({app, ipcMain, BrowserWindow, trustedOrigins})`,
   then `await localAI.recover()` once at boot (adopts a healthy orphan engine from a crash, or kills
   it). `trustedOrigins` is a FUNCTION read live on every call, so it follows the server the person
   connected to; `syncTrust()` retires the engine when they switch.
2. **Preload** (`desktop/preload.cjs`): one self-contained block — `preload-block.cjs` — requiring
   only `electron`. A sandboxed preload cannot resolve a relative require, so the bridge asks main
   for trust synchronously (`localai:isTrusted`) and exposes `window.localAI` only when the answer is
   yes. It parses nothing and paints nothing.
3. **Manifest** (served by us): `{engine:{version, llamaCommit, features:["dory"],
   platforms:{"win32-x64-cuda":{files:[{name,url,sha256,size}]}, "win32-x64-vulkan":{…},
   "linux-x64-rocm":{…}, "darwin-arm64-metal":{…}, "…-cpu":{…}}}, models:{Q8_0:{name,url,sha256,size}}}`
   Every file is sha256-pinned, names must be basenames, https only, and the engine binary must pass
   `--version` carrying the pinned Dory commit or it is refused.

Web page: `localAI.capabilities()` → `{hardware, manifest, tiers}` where each tier is a plan with
`placement` + `why` or a refusal with `reason`; `localAI.start(tier)`, `localAI.endpoint()` →
`{baseUrl, apiKey}` (an OpenAI-compatible base URL; the page's CSP needs `connect-src
http://127.0.0.1:*`), `onStatus`, `onProgress`, `diagnostics()`, `selfTest()`.

## Tiers are CAPABILITY CLASSES, not hardware

| Tier | What it is | Where it may land |
|---|---|---|
| 0 Eco | the CPU floor, 50% of threads and RAM | any CPU: CUDA, Vulkan, Metal or nothing at all |
| 1 Light | the cheap rung: small quant, 1 loop, ≤16k, low priority | a GPU that is not presenting the desktop, else the display GPU with headroom, else the CPU |
| 2 Flash | best single GPU, Q8_0, 2 loops, lossless per-loop KV | any backend with ≥5 GiB it may spend |
| 3 Pro | the most capable placement: BF16→Q8_0, 4 loops, KV may spill to RAM | any backend with ≥6 GiB, and ≥32 GiB RAM when the pools are separate |

Every plan carries `placement`, a one-sentence `why`, `estimate`, `rejectedQuants` and the
`skippedGpus` with the owner of each. A rung that cannot be held is REFUSED with the shortfall in
GiB — never quietly re-planned onto the CPU, because a drop from 84k context to 8k is a quality
cliff.

## The rules the code keeps

- **Backends are probed**: CUDA (`nvidia-smi`), ROCm (`rocm-smi`), Vulkan (`vulkaninfo`), Metal
  (`system_profiler`), Windows WMI + the driver's registry VRAM size, and the CPU floor. Every probe
  has a timeout; a missing binary is a named `not available`, never a throw and never a hang.
- **A busy GPU is never planned onto.** A game, an encoder, a remote-stream host or another compute
  process (attributed to its card by GPU uuid) is named with its owner, and the rung either refuses or
  places somewhere else and says whose the skipped card is. A GPU presenting the desktop keeps 1 GiB
  and loses every preference contest.
- **Unified memory is one pool.** On Apple silicon and any integrated GPU the GPU addresses the same
  bytes as the CPU, so the budget is a share of RAM and never RAM plus VRAM.
- **The model fits the machine.** The largest quant that fits the MEASURED budget is chosen and the
  better ones it gave up are named; `-m <path>` always, `-hf` never, because a launch is not a
  download. A missing or hash-mismatched file is a named state (`download.state`), with progress,
  resume and an atomic install into `userData`.
- **Windows is the default path**: `taskkill /T /F` (a Job Object needs a native module this does not
  ship), a pidfile that adopts a healthy orphan or kills an unhealthy one and never touches a pid
  whose image is not ours, and no POSIX signal outside the non-Windows branch.
- **Nothing a person sees is built here.** No window, page, control or copy: the tier control and the
  download surface are a separate design ticket.

## What ships is ONE minified file, and the sources do not

Owen, 2026-11-07: "obfuscate the local AI stuff as much as possible … hide as much user touchable
code/tech/design". So the app loads `desktop/local-ai/bundle/index.cjs`, built by
`node desktop/local-ai/build.cjs` (`npm run build:local-ai`):

- comments stripped, every module-scope identifier and every exported API name renamed to `_0`/`k1`,
  modules inlined behind an integer require shim, **no source map**;
- `package.json` `build.files` EXCLUDES `desktop/local-ai/**` and re-includes only
  `desktop/local-ai/bundle/**`, so the readable sources and the test fixtures are not in the app;
- `node desktop/local-ai/build.cjs --check` fails when the shipped bundle is not what the committed
  sources build, and `tests/local-ai-packed.test.cjs` loads the bundle and asserts it answers the same
  tiers as the sources on every synthetic machine;
- paths and names a person can reach are opaque (`userData/e1`, files `c`, `p`, `l`), failures are
  codes (`E_TIMEOUT`, `E_VERIFY`, `E_ENGINE_BUILD`, …), and `capabilities()`/`status()` answer a
  reduced shape: a placement, one sentence, a context size and a download size — never a backend
  name, a quant, a loop count or the KV arithmetic. `diagnostics()` stays complete, deliberately: it
  is the maintainer's view and it is answered only to the trusted page's main frame.

**The documented limit.** Two things stay readable inside the archive, and both are protocols rather
than design: the engine's own required strings (its binary file name, the manifest build-family
marker, the `--override-kv` keys that address the model's metadata) and the vendor TOOLS we must call
by name (`nvidia-smi`, `vulkaninfo`, `rocm-smi`, `system_profiler`) along with the backend ids used as
manifest pack keys. The config module's constant names are also visible to someone who unzips the
asar — they are minified code, not a wire shape, and no page can read them.

## Tests

`node --test tests/*.test.cjs` from the app root. `tests/local-ai-{hardware,planner,matrix,store,
runtime,wiring}.test.cjs`: the probe parsers against canned real-world output, the planner's promises,
the synthetic hardware matrix (no test reads the real hardware), downloads and their refusals, the
engine's lifetime against a server that misbehaves on purpose (`fake-llama-server.cjs`), and the
wiring into `main.cjs` / `preload.cjs` driven through fake Electron objects.

## Still to prove on real hardware (not on a Linux CI box)

A real CUDA `llama-server` and its KV-size line (`diagnostics().kvCalibration` compares the estimate
to it), a real Vulkan and Metal start, a real Windows run (taskkill tree, WMI probes, GPU Engine
counters) and a real macOS run. `node selftest.cjs <baseUrl> <apiKey> [ctx]` checks effective context,
the context-exceeded refusal, streaming, a tool-call round trip, `-np` parallelism and prompt-cache
reuse against whatever engine is actually running.
