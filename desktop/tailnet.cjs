'use strict';
/*
 * THE E-SERVERS ON THIS PERSON'S TAILNET.
 *
 * Owen, 2026-11-16: "if a e-server is on the same tailscale network as you it will always
 * show up as an option to join for any user using e-app on that tailscale network."
 *
 * The client asks the local Tailscale daemon who is on the tailnet (`tailscale status
 * --json`), then probes each online peer's `/healthz` on 443. A peer that answers as an
 * e-server is returned as an address-only row; the setup page offers Join. Nothing here
 * carries a credential: the e-server's own PIN gate still decides whether this person may
 * enter, and the account service still decides whether the address is saved to their list.
 *
 * Discovery is best effort. No Tailscale daemon, a daemon that is logged out, a peer with
 * no HTTPS certificate, or a probe timeout all mean "nothing to show", never a setup error.
 */
const { execFile } = require('node:child_process');
const https = require('node:https');

const HEADER = 'X-Easter-Desktop';
const CLIENT = 'e-app/1';
const STATUS_TIMEOUT_MS = 4000;
const PROBE_TIMEOUT_MS = 2500;
const MAX_PEERS = 32;
const CACHE_MS = 15000;

let cache = { at: 0, value: null };

function runStatus(command) {
  return new Promise((resolve) => {
    execFile(command, ['status', '--json'], { timeout: STATUS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout));
  });
}

async function status() {
  const candidates = process.platform === 'win32'
    ? ['tailscale.exe', 'tailscale']
    : ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const command of candidates) {
    const raw = await runStatus(command);
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object') return value;
    } catch { /* another command may still answer */ }
  }
  return null;
}

function labelOf(peer) {
  const dns = String(peer.DNSName || '').replace(/\.$/, '');
  if (dns) return dns.split('.')[0];
  return String(peer.HostName || peer.Hostname || 'e-server');
}

function endpointOf(peer) {
  const dns = String(peer.DNSName || '').replace(/\.$/, '');
  return dns ? 'https://' + dns : '';
}

function probe(origin) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; resolve(ok); };
    let request;
    try {
      request = https.get(origin + '/healthz', {
        timeout: PROBE_TIMEOUT_MS,
        rejectUnauthorized: true,
        headers: { [HEADER]: CLIENT, Accept: 'text/plain' },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { if (body.length < 64) body += chunk; });
        response.on('end', () => finish(response.statusCode === 200 && /^ok/i.test(body.trim())));
      });
    } catch { finish(false); return; }
    request.on('timeout', () => { request.destroy(); finish(false); });
    request.on('error', () => finish(false));
  });
}

/** The tailnet's advertised e-server addresses, or a quiet empty answer. */
async function discover(now = Date.now()) {
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  const raw = await status();
  if (!raw) {
    const value = { state: 'unavailable', rows: [] };
    cache = { at: now, value };
    return value;
  }
  // THIS MACHINE COUNTS TOO. `Self` is not in `Peer`; a person running e-app on the same host
  // as an e-server should still see it in the list.
  const candidates = [raw.Self, ...Object.values(raw.Peer || {})]
    .filter((peer) => peer && peer.Online === true && String(peer.DNSName || '').trim())
    .slice(0, MAX_PEERS);
  const found = await Promise.all(candidates.map(async (peer) => {
    const origin = endpointOf(peer);
    if (!origin) return null;
    return (await probe(origin)) ? { origin, label: labelOf(peer) } : null;
  }));
  const rows = found.filter(Boolean).sort((a, b) => a.label.localeCompare(b.label));
  const value = { state: rows.length ? 'ready' : 'empty', rows };
  cache = { at: now, value };
  return value;
}

module.exports = { discover };
