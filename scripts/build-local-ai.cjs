'use strict';
/**
 * build-local-ai.cjs — THE READABLE SOURCES ARE NOT WHAT SHIPS.
 *
 * Owen, 2026-11-07: "obfuscate the local AI stuff as much as possible … hide as much user touchable
 * code/tech/design". So the packaged app carries ONE file — `bundle/index.cjs` — built here from the
 * readable sources beside it: comments stripped, nothing but required whitespace, every module-scope
 * identifier renamed to `_0`/`_1`/…, modules inlined behind an integer require shim, and NO source
 * map (a source map would hand the whole thing back). The readable `.cjs` sources are excluded from
 * `build.files` in package.json, so they are not in the asar at all.
 *
 *   node scripts/build-local-ai.cjs           build desktop/local-ai/dist/local-ai.cjs
 *   node scripts/build-local-ai.cjs --check   exit 1 if the shipped file is not what this builds
 *
 * It runs from the npm scripts (`build:local-ai`, and before every pack/dist), and `main.cjs`
 * requires the result: desktop/local-ai/dist/local-ai.cjs. The readable sources live in
 * desktop/local-ai/src/ and are excluded from `build.files`, so they are not in the app at all.
 *
 * THE GATE IS NOT THIS FILE'S OPINION. `tests/local-ai-packed.test.cjs` loads the bundle and runs the
 * same synthetic machines through it as through the sources, asserting the two agree; and the build is
 * deterministic, so `--check` proves the shipped bytes came from the committed sources.
 *
 * LLAMA.CPP'S OWN REQUIRED PROTOCOL SURVIVES, and it has to: the manifest's build-family marker, the
 * `--override-kv` keys and the engine binary's own file name are the ENGINE's contract, not our
 * design. Everything a person can reach through the product — folder names, file names, error
 * sentences, tier labels, the wire shapes — is opaque instead.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HERE = path.join(ROOT, 'desktop', 'local-ai', 'src');
const BUNDLE = path.join(ROOT, 'desktop', 'local-ai', 'dist', 'local-ai.cjs');

/** Dependency order: a module may only require one before it. */
const MODULES = [
  'config.cjs',
  'messages.cjs',
  'context-window.cjs',
  'downloader.cjs',
  'proc.cjs',
  'hardware.cjs',
  'planner.cjs',
  'store.cjs',
  'runtime.cjs',
  'selftest.cjs',
  'index.cjs',
];
const ID = new Map(MODULES.map((name, index) => [name, index]));

/* ------------------------------------------------------------------ lexer */

const REGEX_PREFIX = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'instanceof', 'do', 'else', 'yield', 'await']);

/**
 * Tokens: { t: 'ident'|'number'|'string'|'template'|'regex'|'punct'|'comment', v }
 * A template is emitted as its own token for each literal chunk plus '{' expression tokens: that way a
 * renamed identifier inside `${…}` is still renamed (a template is the one place a naive minifier
 * breaks a program).
 */
function lex(source) {
  const tokens = [];
  let i = 0;
  const push = (t, v) => tokens.push({ t, v });
  const comments = [];
  const pushComment = (text) => comments.push(text);
  const lexUntilBrace = () => {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === '}' && depth === 0) return;
      if (c === '{') depth += 1;
      if (c === '}') depth -= 1;
      step();
    }
  };
  function step() {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const start = i;
      while (i < source.length && source[i] !== '\n') i += 1;
      pushComment(source.slice(start, i));
      return;
    }
    if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      pushComment(source.slice(start, i));
      return;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c) { j += 1; break; }
        j += 1;
      }
      push('string', source.slice(i, j));
      i = j;
      return;
    }
    if (c === '`') {
      let j = i + 1;
      let chunk = '`';
      while (j < source.length) {
        if (source[j] === '\\') { chunk += source[j] + source[j + 1]; j += 2; continue; }
        if (source[j] === '`') { chunk += '`'; j += 1; push('template', chunk); i = j; return; }
        if (source[j] === '$' && source[j + 1] === '{') {
          chunk += '${';
          push('template', chunk);
          chunk = '';
          i = j + 2;
          // The braces of a template expression are emitted so they are RENDERED, but marked `tpl`
          // so bracket counting ignores them: `${` lives inside the template token, so a plain `}`
          // here would drive the depth negative and make every later line look top-level.
          push('punct', '{');
          tokens[tokens.length - 1].tpl = 'open';
          lexUntilBrace();
          push('punct', '}');
          tokens[tokens.length - 1].tpl = 'close';
          // continue the template literal after the closing brace
          j = i + 1;
          chunk = '';
          i = i + 1;
          continue;
        }
        chunk += source[j];
        j += 1;
      }
      push('template', chunk);
      i = j;
      return;
    }
    if (c === '/') {
      const prev = [...tokens].reverse().find((t) => t.t !== 'comment');
      const regex = !prev || (prev.t === 'punct' && REGEX_PREFIX.has(prev.v)) || (prev.t === 'ident' && REGEX_KEYWORD.has(prev.v));
      if (regex) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length) {
          const d = source[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { j += 1; break; }
          else if (d === '\n') break;
          j += 1;
        }
        while (j < source.length && /[a-z]/i.test(source[j])) j += 1;
        push('regex', source.slice(i, j));
        i = j;
        return;
      }
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[\w$]/.test(source[j])) j += 1;
      push('ident', source.slice(i, j));
      i = j;
      return;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < source.length && /[\w.]/.test(source[j])) j += 1;
      push('number', source.slice(i, j));
      i = j;
      return;
    }
    if (/\s/.test(c)) {
      while (i < source.length && /\s/.test(source[i])) i += 1;
      return;
    }
    push('punct', c);
    i += 1;
  }
  while (i < source.length) step();
  return tokens.filter((t) => t.t !== 'comment');
}

/** Every comment in a source, for the gate that proves the shipped bundle has none. */
function comments(source) {
  const found = [];
  const tokens = lex(source);
  const scan = (text) => {
    // Re-lex with a collector: the lexer's own scanner decides what a comment is, so a `//` inside
    // a URL or a string is never counted.
    let depth = 0;
    for (let i = 0; i < text.length;) {
      const c = text[i];
      if (c === '\'' || c === '"' || c === '`') { const q = c; i += 1; while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === q) { i += 1; break; } i += 1; } continue; }
      if (c === '/' && text[i + 1] === '/') { const start = i; while (i < text.length && text[i] !== '\n') i += 1; found.push(text.slice(start, i)); continue; }
      if (c === '/' && text[i + 1] === '*') { const start = i; i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 2; found.push(text.slice(start, i)); continue; }
      i += 1;
    }
    return depth;
  };
  scan(source);
  void tokens;
  return found;
}

/* ------------------------------------------------------------------ top-level names */

const RESERVED = new Set(['module', 'exports', 'require', 'process', 'console', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Math', 'JSON', 'Date', 'Error', 'Promise', 'Set', 'Map', 'Buffer', 'JSON', 'RegExp', 'Symbol', 'parseInt', 'parseFloat']);

/** Depth BEFORE each token, so a declaration can be judged by where it starts, not where it ends. */
function depthMap(tokens) {
  const depths = [];
  let depth = 0;
  for (const token of tokens) {
    depths.push(depth);
    if (token.t !== 'punct' || token.tpl) continue;
    if ('([{'.includes(token.v)) depth += 1;
    else if (')]}'.includes(token.v)) depth = Math.max(0, depth - 1);
  }
  return depths;
}

/**
 * Names this module declares at its OWN top level: function/class/const/let/var, destructuring
 * included. Nothing nested is touched — a parameter or a loop variable is not a design name, and
 * renaming one would be the kind of cleverness that quietly breaks a program.
 */
function topLevelNames(tokens) {
  const depths = depthMap(tokens);
  const names = new Set();
  const significant = (index) => {
    for (let i = index - 1; i >= 0; i -= 1) return tokens[i];
    return null;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (depths[i] !== 0 || token.t !== 'ident') continue;
    const prev = significant(i);
    const statementStart = !prev || (prev.t === 'punct' && (prev.v === ';' || prev.v === '}'));
    if (!statementStart) continue;
    let j = i + 1;
    if (token.v === 'async') {
      if (!tokens[j] || tokens[j].v !== 'function') continue;
      j += 1;
    }
    if (tokens[j - 1] && tokens[j] && (token.v === 'function' || token.v === 'class' || tokens[j - 1].v === 'function')) {
      if (!['function', 'class', 'async'].includes(token.v)) continue;
      if (tokens[j] && tokens[j].v === '*') j += 1;
      if (tokens[j] && tokens[j].t === 'ident') names.add(tokens[j].v);
      continue;
    }
    if (token.v !== 'const' && token.v !== 'let' && token.v !== 'var') continue;
    for (;;) {
      const item = tokens[j];
      if (!item) break;
      if (item.t === 'ident') { names.add(item.v); j += 1; }
      else if (item.t === 'punct' && (item.v === '{' || item.v === '[')) {
        // destructuring: an identifier is a BINDING unless it is followed by ':' (a key)
        let depth = 0;
        for (j += 1; j < tokens.length; j += 1) {
          const inner = tokens[j];
          if (inner.t === 'punct' && '{['.includes(inner.v)) { depth += 1; continue; }
          if (inner.t === 'punct' && '}]'.includes(inner.v)) { if (depth === 0) break; depth -= 1; continue; }
          if (inner.t !== 'ident') continue;
          const after = tokens[j + 1];
          if (after && after.t === 'punct' && after.v === ':') continue;
          names.add(inner.v);
        }
        j += 1;
      }
      // skip the initialiser: to the next declarator comma or the end of the statement, at depth 0
      let depth = 0;
      for (; j < tokens.length; j += 1) {
        const inner = tokens[j];
        if (inner.t === 'punct' && inner.tpl) continue;
        if (inner.t === 'punct' && '([{'.includes(inner.v)) depth += 1;
        else if (inner.t === 'punct' && ')]}'.includes(inner.v)) { if (depth === 0) break; depth -= 1; }
        else if (inner.t === 'punct' && inner.v === ';' && depth === 0) break;
        else if (inner.t === 'punct' && inner.v === ',' && depth === 0) break;
      }
      if (!tokens[j] || tokens[j].v === ';') break;
      j += 1;
    }
  }
  return names;
}

/* ------------------------------------------------------------------ mangling + emission */

function mangle(tokens) {
  const declared = [...topLevelNames(tokens)].filter((name) => !RESERVED.has(name));
  const taken = new Set(tokens.filter((t) => t.t === 'ident').map((t) => t.v));
  const map = new Map();
  let n = 0;
  for (const name of declared) {
    let alias;
    do { alias = `_${n.toString(36)}`; n += 1; } while (taken.has(alias));
    map.set(name, alias);
    taken.add(alias);
  }
  return map;
}

const WORDISH = /[\w$]/;

/**
 * Is the `{` at `index` an OBJECT literal (so `{a}` and `{a: b}` are keys) or a BLOCK (so `{a}` is
 * a statement and `a:` is a label)? Guessed from the token before it, which is the only signal a
 * minifier has. A wrong guess in either direction is a broken program, so every object/array/brace
 * is tracked on a stack and the key rules only ever fire inside an object.
 */
function opensObject(tokens, index) {
  const prev = tokens[index - 1];
  if (!prev) return false;
  if (prev.t === 'punct') {
    if (prev.v === '>' && tokens[index - 2] && tokens[index - 2].v === '=') return false; // arrow body
    if (['(', '[', ',', '=', ':', '?', '+', '-'].includes(prev.v)) return true;
    return false;
  }
  // `const {a, b} = require(...)` is a DESTRUCTURING PATTERN, not a block: its braces select
  // properties, so `a` there must become `a:_0` and not `_0`.
  if (prev.t === 'ident') return ['return', 'const', 'let', 'var'].includes(prev.v);
  return false;
}

function render(tokens, map, keyMap = new Map(), keyIndexes = new Set()) {
  const parts = [];
  const stack = [];
  let last = '';
  const emit = (text) => {
    if (!text) return;
    if (last && WORDISH.test(last.slice(-1)) && WORDISH.test(text[0])) parts.push(' ');
    else if (last.endsWith('/') && text[0] === '/') parts.push(' ');
    parts.push(text);
    last = text;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    // A template's opening brace is already part of the `${` chunk; its closing brace is not.
    if (token.tpl === 'open') continue;
    if (token.t === 'punct') {
      if (token.v === '{') stack.push(opensObject(tokens, i) ? 'object' : 'block');
      else if (token.v === '[') stack.push('array');
      else if (token.v === '(') stack.push('paren');
      else if (token.v === '}' || token.v === ']' || token.v === ')') stack.pop();
      emit(token.v);
      continue;
    }
    if (token.t !== 'ident') { emit(token.v); continue; }
    const alias = map.get(token.v);
    if (!alias) { emit(token.v); continue; }
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    const before = tokens[i - 2];
    // `.` is a property access — unless it is the tail of a spread (`...name`) or of `?.`.
    const member = prev && prev.t === 'punct' && prev.v === '.'
      && !(before && before.t === 'punct' && (before.v === '.' || before.v === '?'));
    if (member) { emit(token.v); continue; }
    const inObject = stack.length && stack[stack.length - 1] === 'object';
    const atItemStart = prev && prev.t === 'punct' && (prev.v === '{' || prev.v === ',');
    if (keyIndexes.has(i) && keyMap.has(token.v)) {
      // A module-API key. Shorthand (`{detect}`) carries its binding too: `{k3:_3}`.
      const shorthandKey = !(next && next.t === 'punct' && next.v === ':');
      emit(shorthandKey ? `${keyMap.get(token.v)}:${alias}` : keyMap.get(token.v));
      continue;
    }
    if (inObject && atItemStart && next && next.t === 'punct' && next.v === ':') { emit(token.v); continue; } // a key
    if (inObject && atItemStart && next && next.t === 'punct' && (next.v === ',' || next.v === '}' || next.v === '=')) {
      emit(`${token.v}:${alias}`); // {planTier} -> {planTier:_0}; {a = 1} -> {a:_0 = 1}
      continue;
    }
    emit(alias);
  }
  return parts.join('');
}

/**
 * The names a module EXPORTS are design names as well (`planTier`, `kvBytes`, `classifyBusy`), and
 * they survive mangling because they are object keys. They are renamed too, in the two places they
 * appear: the `module.exports = {…}` literal and the `const {…} = __r(n)` that reads it. Every
 * consumer is inside the bundle, so nothing outside notices.
 */
function exportKeys(tokens) {
  const names = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const at = tokens[i];
    if (!(at.t === 'ident' && at.v === 'module' && tokens[i + 1] && tokens[i + 1].v === '.'
      && tokens[i + 2] && tokens[i + 2].v === 'exports' && tokens[i + 3] && tokens[i + 3].v === '='
      && tokens[i + 4] && tokens[i + 4].v === '{')) continue;
    let depth = 0;
    for (let j = i + 4; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token.t === 'punct' && !token.tpl && token.v === '{') { depth += 1; continue; }
      if (token.t === 'punct' && !token.tpl && token.v === '}') { depth -= 1; if (depth === 0) break; continue; }
      if (depth !== 1 || token.t !== 'ident') continue;
      if (!tokens[j - 1] || (tokens[j - 1].v !== '{' && tokens[j - 1].v !== ',')) continue;
      // `key: value` or the shorthand `key,` — both export a name.
      if (!tokens[j + 1] || tokens[j + 1].v === ':' || tokens[j + 1].v === ',' || tokens[j + 1].v === '}') names.push(token.v);
    }
  }
  return [...new Set(names)];
}

/** Indices of ident tokens that are module-API KEYS, so `render` can replace them. */
function exportKeyIndexes(tokens, { skipOwnExports = false } = {}) {
  const marked = new Set();
  // 1. the object literal of `module.exports = {…}` (skipped for the bundle's own public entry)
  for (let i = 0; skipOwnExports ? false : i < tokens.length; i += 1) {
    const at = tokens[i];
    if (!(at.t === 'ident' && at.v === 'module' && tokens[i + 1] && tokens[i + 1].v === '.'
      && tokens[i + 2] && tokens[i + 2].v === 'exports' && tokens[i + 3] && tokens[i + 3].v === '='
      && tokens[i + 4] && tokens[i + 4].v === '{')) continue;
    let depth = 0;
    for (let j = i + 4; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token.t === 'punct' && !token.tpl && token.v === '{') { depth += 1; continue; }
      if (token.t === 'punct' && !token.tpl && token.v === '}') { depth -= 1; if (depth === 0) break; continue; }
      if (depth !== 1 || token.t !== 'ident') continue;
      if (!tokens[j - 1] || (tokens[j - 1].v !== '{' && tokens[j - 1].v !== ',')) continue;
      if (!tokens[j + 1] || tokens[j + 1].v === ':' || tokens[j + 1].v === ',' || tokens[j + 1].v === '}') marked.add(j);
    }
  }
  // 2. a destructuring read of the bundle's own require: `const {…} = __r(n)`
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i].t !== 'punct' || tokens[i].v !== '{') continue;
    let depth = 0;
    let end = -1;
    for (let j = i; j < tokens.length; j += 1) {
      const token = tokens[j];
      if (token.t === 'punct' && !token.tpl && token.v === '{') depth += 1;
      else if (token.t === 'punct' && !token.tpl && token.v === '}') { depth -= 1; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) continue;
    const after = tokens.slice(end + 1, end + 6).map((t) => t.v).join('');
    if (!/^=__r\(\d+\)/.test(after)) continue;
    let inner = 0;
    for (let j = i; j <= end; j += 1) {
      const token = tokens[j];
      if (token.t === 'punct' && !token.tpl && token.v === '{') { inner += 1; continue; }
      if (token.t === 'punct' && !token.tpl && token.v === '}') { inner -= 1; continue; }
      if (inner !== 1 || token.t !== 'ident') continue;
      const nextToken = tokens[j + 1];
      if (!nextToken || nextToken.v === ':' || nextToken.v === ',' || nextToken.v === '}') marked.add(j);
    }
  }
  return marked;
}

/** `require('./x.cjs')` becomes `__r(<id>)`; anything built in stays a real require. */
function rewriteRequires(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.t === 'ident' && token.v === 'require' && tokens[i + 1] && tokens[i + 1].v === '('
      && tokens[i + 2] && tokens[i + 2].t === 'string' && tokens[i + 3] && tokens[i + 3].v === ')') {
      const request = tokens[i + 2].v.slice(1, -1);
      const local = request.replace(/^\.\//, '');
      if (ID.has(local)) {
        out.push({ t: 'ident', v: '__r' });
        out.push({ t: 'punct', v: '(' });
        out.push({ t: 'number', v: String(ID.get(local)) });
        out.push({ t: 'punct', v: ')' });
        i += 3;
        continue;
      }
    }
    out.push(token);
  }
  return out;
}

/** One module, wrapped exactly as the bundle wraps it: what the parity test parses on its own. */
function renderModule(name) {
  const list = sources();
  const keyMap = apiKeyMap(list);
  const { tokens } = list.find((entry) => entry.name === name);
  const marked = exportKeyIndexes(tokens, { skipOwnExports: name === 'index.cjs' });
  return `((module,exports,__r)=>{${render(tokens, mangle(tokens), keyMap, marked)}})`;
}

function sources() {
  return MODULES.map((name) => {
    const source = fs.readFileSync(path.join(HERE, name), 'utf8');
    return { name, tokens: rewriteRequires(lex(source)) };
  });
}

/**
 * A module whose exports are read as a NAMESPACE (`const proc = require('./proc.cjs')` then
 * `proc.removePid`), rather than destructured, cannot have its keys renamed without also rewriting
 * member accesses on every alias of it — so it keeps them. `config.cjs` (read as `cfg.<key>`) and
 * `index.cjs` (the bundle's own entry point) are the same case.
 */
function namespaceRequired(list) {
  const ids = new Set();
  for (const { tokens } of list) {
    for (let i = 0; i < tokens.length; i += 1) {
      if (!(tokens[i].v === '=' && tokens[i + 1] && tokens[i + 1].v === '__r' && tokens[i + 3] && tokens[i + 3].t === 'number')) continue;
      if (tokens[i - 1] && tokens[i - 1].v === '}') continue; // a destructuring read
      ids.add(Number(tokens[i + 3].v));
    }
  }
  return ids;
}

/** One opaque key per exported name, shared by the exporter and by every destructuring consumer. */
function apiKeyMap(list) {
  const names = [];
  const keepWhole = namespaceRequired(list);
  for (const [index, { name, tokens }] of list.entries()) {
    if (name === 'config.cjs' || name === 'index.cjs' || keepWhole.has(index)) continue;
    for (const key of exportKeys(tokens)) if (!names.includes(key)) names.push(key);
  }
  return new Map(names.map((key, index) => [key, `k${index.toString(36)}`]));
}

function build() {
  const list = sources();
  const keyMap = apiKeyMap(list);
  const bodies = list.map(({ name, tokens }) => {
    const map = mangle(tokens);
    // `index.cjs` IS the bundle's public entry: its export names are the app's contract, so they are
    // never renamed even though the modules it re-exports have their keys mangled.
    const marked = exportKeyIndexes(tokens, { skipOwnExports: name === 'index.cjs' });
    // A body starts with `'use strict';`, which is a STATEMENT: it needs a block, not parentheses.
    return `((module,exports,__r)=>{${render(tokens, map, keyMap, marked)}})`;
  });
  const shim = 'const __c={},__d=[' + bodies.join(',') + '];'
    + 'function __r(i){const h=__c[i];if(h)return h.exports;const m={exports:{}};__c[i]=m;__d[i](m,m.exports,__r);return m.exports;}'
    + `module.exports=__r(${ID.get('index.cjs')});`;
  return `${shim}\n`;
}

function main() {
  const bundle = build();
  const check = process.argv.includes('--check');
  if (check) {
    const shipped = fs.existsSync(BUNDLE) ? fs.readFileSync(BUNDLE, 'utf8') : '';
    if (shipped !== bundle) {
      console.error('E_BUNDLE: desktop/local-ai/dist/local-ai.cjs is not what the committed sources build — run `npm run build:local-ai`');
      process.exit(1);
    }
    console.log(`bundle is current (${bundle.length} bytes, ${bundle.split('\n').length - 1} newlines)`);
    return;
  }
  fs.mkdirSync(path.dirname(BUNDLE), { recursive: true });
  fs.writeFileSync(BUNDLE, bundle);
  console.log(`built ${path.relative(process.cwd(), BUNDLE)} (${bundle.length} bytes from ${MODULES.length} modules)`);
}

if (require.main === module) main();

module.exports = { build, renderModule, lex, comments, mangle, topLevelNames, exportKeys, MODULES, BUNDLE };
