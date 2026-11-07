# local-ai — Dexter's local model server, run on the person's own computer

Zero-dependency main-process CommonJS that measures a computer, decides which capability rung it
can hold, downloads a pinned engine and model into `userData`, runs `llama-server` behind an
OpenAI-compatible endpoint, and reports honestly when it cannot.

`node desktop/local-ai/dev/preview.cjs` prints what each rung would do **on this machine**; add
`--matrix` for the same table on nine synthetic machines. The plan table is OUTPUT, never a shipped
answer.

## Layout, and what ships

| Path | What it is | Ships in the app? |
|---|---|---|
| `desktop/local-ai/src/*.cjs` | the readable modules, imported by the suites | **no** (`!desktop/local-ai/src/**`) |
| `desktop/local-ai/dev/*` | fixtures, preview, the fake engine, the preload block | **no** |
| `desktop/local-ai/dist/local-ai.cjs` | ONE minified file built by `scripts/build-local-ai.cjs` | **yes** |
| `desktop/local-ai/ATTRIBUTION.md` | the licence notices | **yes** |

`npm run build:local-ai` builds it; `pack`/`dist:linux`/`dist:windows` rebuild it first;
`node scripts/build-local-ai.cjs --check` fails when the shipped file is not what the committed
sources build. Ids carry the whole naming scheme (`m1`, `q1..q4`, `b0..b4`, `en`, `e1`), and the
manifest we serve is keyed by them.

## Wire-up (already done in this app)

1. **Main** (`desktop/main.cjs`): `createLocalAI({app, ipcMain, BrowserWindow, trustedOrigins})`,
   then `await localAI.recover()` once at boot (adopts a healthy orphan engine from a crash, or kills
   it). `trustedOrigins` is a FUNCTION read live on every call, so it follows the server the person
   connected to; `syncTrust()` retires the engine when they switch.
2. **Preload** (`desktop/preload.cjs`): one self-contained block — `preload-block.cjs` — requiring
   only `electron`. A sandboxed preload cannot resolve a relative require, so the bridge asks main
   for trust synchronously (`localai:isTrusted`) and exposes `window.localAI` only when the answer is
   yes. It parses nothing and paints nothing.
3. **Manifest** (served by us): `{engine:{version, build, features:["dory"],
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

**The documented limit, and it is now two lines.**

1. **The vendor probe TOOLS** — `nvidia-smi`, `vulkaninfo`, `rocm-smi`, `system_profiler` — because a
   machine has to be measured with the tools the machine's vendors installed, and we call them by
   name. There is no portable alternative.
2. **The backend pack-key ids** — `b0`..`b4` — because the download has to ask for the right engine
   pack, so its id crosses the wire. They are already opaque and never a backend word.

**No longer in the bundle at all (moved, not renamed):** the model FAMILY marker and the
`--override-kv` metadata keys. They arrive from the downloaded manifest as `engine.family`,
`engine.overrides.loops` and `engine.overrides.cache`, validated at parse and read at start by
`Store.launchData()`. A manifest that omits either is refused by name (`E_MANIFEST: engine.family`,
`E_MANIFEST: engine.overrides.loops`) rather than launching with an empty `--override-kv`, which would
silently run a different model configuration. Consequence: `grep -E 'dory|<family>|num_loops'` of
`desktop/local-ai/dist/local-ai.cjs` extracted from a packed `app.asar` returns nothing.

The manifest these fields belong to (served by e-server, not written yet):

```json
{ "engine": { "version": "…", "build": "<pinned build id>",
              "family": "<build family token>",
              "overrides": { "loops": "<family>.…", "cache": "<family>.…" },
              "platforms": { "<platform>-<arch>-<b#>": { "files": [ … ] } } },
  "models":   { "model-m1-q#": { "name": "m1-q#.bin", … } } }
```

## Debug mode — how to run it, what it changes, and what production never ships

ONE switch, resolved once at boot by `desktop/debug.cjs`:

| How you start it | Mode |
|---|---|
| `e-server-client --app-debug` (or `E_APP_DEBUG=1`) | **debug**, packaged or not |
| `e-server-client --app-no-debug` (or `E_APP_DEBUG=0`) | **production**, packaged or not |
| `--debug` / `--no-debug` (in a dev tree, or after `electron . --`) | same, when Electron passes them through |
| no flag, packaged build | production |
| no flag, unpackaged dev tree | debug |

THE FLAG IS NAMESPACED ON PURPOSE: Electron owns `--debug` in its own switch namespace (measured
2026-11-07: a packed build with `--debug` printed node's "`node --debug` is invalid" notice and the app
never saw it), so `--app-debug` is the spelling that reaches the app. `--debug` still works where it
arrives, and `E_APP_DEBUG=1` always works.

`app.isPackaged` is a SEPARATE fact: it only feeds that default. A person running a PACKAGED build
with `--debug` gets debug behaviour, and a packaged release started without the flag can never get it.
Nothing else in the app infers the mode; `main.cjs` resolves it once into `DEBUG_MODE` and prints one
line (`[e-app] mode=debug (flag) engine=app`).

WHAT DEBUG CHANGES — DETAIL ONLY:
- the app loads the READABLE engine sources (`desktop/local-ai/src/index.cjs`) instead of the minified
  bundle, which is the "non-obfuscated files for debugging" half of the owner's rule;
- `diagnostics()` answers to the trusted main frame (production refuses it with `E_DEBUG_ONLY`), so a
  maintainer can see the redacted argv, the plan, the KV calibration and the log lines;
- a failure's `status().detail` carries the code, the message and the stack, and the dialog prints it;
- the app log records the whole failure.

WHAT IT NEVER CHANGES — AUTHORITY: no new permission, no secret becomes readable (`redact()` still
strips the api key and long hex secrets), and the shape of what a page receives is the same object in
both modes; only whether `detail` is filled in. Debug is not a privilege escalation with a flag.

PRODUCTION NEVER SHIPS THE DEBUG SURFACE: the asar holds `desktop/local-ai/dist/local-ai.cjs` and
`ATTRIBUTION.md` only — no `src/`, no `.map`, no comments — and every user-facing failure is ONE PLAIN
SENTENCE plus ONE NEXT STEP (`desktop/local-ai/src/messages.cjs`), with the detail in the log.

The gate is `tests/debug-mode.test.cjs`: it packs nothing itself (re-run `npm run pack` first, or it
tells you "the pack predates the dist; run `npm run pack`"), lists the real asar, greps the packed
bundle for the engine/model words and the family marker, then starts the same tree with `--debug` and
proves the readable sources and the detail are back.

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
