'use strict';
// WHERE THE CLIENT LOOKS FOR UPDATES MUST BE WHERE THE CLIENT IS BUILT.
//
// The feed addresses are literals in desktop/updater.cjs and desktop/main.cjs, and a repository
// move silently strands every install: the app keeps asking an address nobody publishes to,
// finds no release, and stays on its old build forever without ever looking broken. That is the
// shape of failure that is cheapest to catch here and most expensive to catch in the field, and
// it happened for real on 2026-10-30 when the client moved from EasterCompany/e-server-client to
// oceaster/e-app.
//
// So this gate reads the repository this checkout actually came from (origin, or $GITHUB_REPOSITORY
// in CI) and requires every feed literal to name that same owner/repo. It fails on a stale
// literal AND on a checkout whose remote was moved without repointing the code.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');

/** `owner/repo` from the environment CI provides, else from this checkout's origin remote. */
function repository() {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (typeof fromEnv === 'string' && /^[^/]+\/[^/]+$/.test(fromEnv)) return fromEnv;
  const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  // git@github.com:owner/repo.git, https://github.com/owner/repo.git, and a bare owner/repo.
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url) ?? /^([^/]+)\/([^/]+)$/.exec(url);
  assert.ok(match, `cannot read an owner/repo out of the origin remote: ${JSON.stringify(url)}`);
  return `${match[1]}/${match[2]}`;
}

/** Every `github.com/<owner>/<repo>/releases` address in a source file. */
function feeds(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  return [...text.matchAll(/github\.com\/([^/\s'"]+)\/([^/\s'"]+)\/releases/g)]
    .map(match => ({ file, repo: `${match[1]}/${match[2]}`, at: match.index }));
}

test('every update feed names the repository this client is built from', () => {
  const expected = repository();
  const found = [...feeds('desktop/updater.cjs'), ...feeds('desktop/main.cjs')];
  assert.ok(found.length > 0, 'no update feed address found in desktop/updater.cjs or desktop/main.cjs');
  const wrong = found.filter(feed => feed.repo !== expected);
  assert.deepEqual(
    wrong.map(feed => `${feed.file}: ${feed.repo}`), [],
    `the update feed must point at ${expected} (this checkout's repository); `
    + 'a stale address means no install built from here can ever see a release',
  );
});

test('the feed addresses are the two GitHub release endpoints, not a hand-rolled path', () => {
  const text = fs.readFileSync(path.join(root, 'desktop/updater.cjs'), 'utf8');
  const repo = /const REPO='(https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/)';/.exec(text)?.[1];
  const latest = /const LATEST='(https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/)';/.exec(text)?.[1];
  assert.ok(repo, 'desktop/updater.cjs must still declare REPO as the releases/download endpoint');
  assert.ok(latest, 'desktop/updater.cjs must still declare LATEST as releases/latest/download');
  assert.equal(repo.replace('/releases/download/', '/releases/latest/download/'), latest);
  assert.equal(repo.replace('/releases/download/', ''), `https://github.com/${repository()}`);
});
