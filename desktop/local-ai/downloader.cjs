'use strict';
/** Resumable, hash-verified, atomic file download. Never leaves unverified bytes at `dest`. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

function request(url, { headers, allowInsecure }, redirects = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) return reject(new Error(`E_INSECURE: ${u.protocol} is not allowed`));
    const req = (u.protocol === 'https:' ? https : http).get(u, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (!redirects) return reject(new Error('too many redirects'));
        return resolve(request(new URL(res.headers.location, u).toString(), { headers, allowInsecure }, redirects - 1));
      }
      return resolve(res);
    });
    req.on('error', reject);
  });
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * opts: { url, dest, sha256, size, onProgress({received,total}), allowInsecure, signal }
 * Resumes from dest+'.part' with a Range request; if the server ignores Range it restarts cleanly.
 */
async function downloadVerified({ url, dest, sha256, size, onProgress, allowInsecure = false, signal }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    if ((await hashFile(dest)) === sha256.toLowerCase()) return dest;
    fs.unlinkSync(dest);
  }
  const part = `${dest}.part`;
  let have = 0;
  let hash = crypto.createHash('sha256');
  if (fs.existsSync(part)) {
    have = fs.statSync(part).size;
    if (have > size) { fs.unlinkSync(part); have = 0; } else if (have > 0) {
      await new Promise((res, rej) => fs.createReadStream(part).on('data', (c) => hash.update(c)).on('error', rej).on('end', res));
    }
  }

  if (have < size) {
    const res = await request(url, { headers: have ? { Range: `bytes=${have}-` } : {}, allowInsecure });
    if (signal) signal.addEventListener('abort', () => res.destroy(new Error('aborted')), { once: true });
    if (res.statusCode === 200 && have > 0) { have = 0; hash = crypto.createHash('sha256'); } // server ignored Range
    else if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); throw new Error(`E_DOWNLOAD: HTTP ${res.statusCode}`); }

    let received = have;
    let last = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
      let failed = null;
      const fail = (e) => { failed = failed || e; out.end(); };
      res.on('data', (c) => {
        hash.update(c); received += c.length;
        const now = Date.now();
        if (onProgress && now - last > 250) { last = now; onProgress({ received, total: size }); }
      });
      res.on('error', fail);
      res.on('close', () => { if (!res.complete) fail(new Error('connection closed early')); });
      out.on('error', reject);
      out.on('close', () => (failed ? reject(failed) : resolve()));
      res.pipe(out);
    });
    if (onProgress) onProgress({ received, total: size });
  }

  const got = fs.statSync(part).size;
  const digest = hash.digest('hex');
  if (got !== size || digest !== sha256.toLowerCase()) {
    fs.unlinkSync(part);
    throw new Error(`E_VERIFY: the downloaded file did not match its manifest entry (size ${got}/${size}, digest ${digest === sha256.toLowerCase() ? 'ok' : 'MISMATCH'})`);
  }
  fs.renameSync(part, dest); // atomic: dest only ever holds verified bytes
  return dest;
}

module.exports = { downloadVerified, hashFile };
