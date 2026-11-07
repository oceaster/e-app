'use strict';
/** Process-lifetime helpers: kill whole trees, probe liveness/identity, pidfile. */
const { execFile, execFileSync } = require('child_process');
const fs = require('fs');
const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 5000 }, (e, o) => resolve(e ? null : String(o))));

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Executable image name of a pid, or null. Used so a recycled pid is never killed by mistake. */
async function imageName(pid) {
  if (isWin) {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    const m = out && out.match(/^"([^"]+)"/);
    return m ? m[1] : null;
  }
  const out = await run('ps', ['-p', String(pid), '-o', 'comm=']);
  return out && out.trim() ? out.trim() : null;
}

async function waitDead(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!isAlive(pid)) return true; await sleep(40); }
  return !isAlive(pid);
}

/**
 * WINDOWS IS THE DEFAULT PATH, NOT A PORT. `taskkill /T /F /PID` kills the process AND its children,
 * which is the guarantee a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE would give — and a Job
 * Object cannot be created from JavaScript without a native module, which this module deliberately
 * does not ship (zero dependencies, and a native addon cannot be built for every person's machine).
 * So: taskkill here, and the pidfile below so a crash cannot leave an engine we do not know about.
 * POSIX: the engine is spawned detached into its own process group, so the GROUP is signalled and a
 * shell's children cannot outlive it. Nothing outside this file's `isWin` branches touches a signal.
 */
async function killTree(pid) {
  if (!pid || !isAlive(pid)) return;
  if (isWin) { await run('taskkill', ['/T', '/F', '/PID', String(pid)]); await waitDead(pid, 5000); return; }
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  if (await waitDead(pid, 4000)) return;
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await waitDead(pid, 2000);
}

/** Last-resort synchronous kill for process 'exit' handlers. */
function killTreeSync(pid) {
  if (!pid) return;
  try {
    if (isWin) execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, timeout: 4000, stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * The pidfile is 0600 and it is the ONLY record of an engine this app started. Three orphan cases,
 * all of them real: the process is gone (stale file), the pid belongs to somebody else (a recycled
 * pid — never killed, our image name is checked first), or it is our engine and it is either healthy
 * (adopt it) or not (kill it). It is written with a plain write and read with a plain parse: a
 * half-written file must be a stale file, never a crash.
 */
const writePid = (file, data) => { fs.mkdirSync(require('path').dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 }); };
const readPid = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const removePid = (file) => { try { fs.unlinkSync(file); } catch { /* none */ } };

module.exports = { isAlive, imageName, killTree, killTreeSync, waitDead, writePid, readPid, removePid, sleep };
