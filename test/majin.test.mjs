/* Majin — unit tests (built-in node:test, zero dependencies).
   Run with: `npm test`  (→ `node --test`)
   Only pure, side-effect-free exports are covered here. server.js is intentionally
   NOT imported — it opens a listening socket at import time — so the jail, tool
   classification and provider-history helpers are tested straight from their modules. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { withinJail, expandHome, allowedRoots, systemRoots, commandIsDangerous, isDangerous, TOOLS } from '../tools.js';
import { normalizeHistory, stripImages, providerConfig, PROVIDER_ORDER } from '../providers.js';

/* ---------- file jail: read/write confinement ---------- */
test('withinJail keeps paths under a root and rejects anything outside it', () => {
  const home = os.homedir();
  const root = path.join(home, 'MajinTestRoot');
  assert.equal(withinJail(path.join(root, 'a', 'b.txt'), [root]), true);
  assert.equal(withinJail(root, [root]), true);                    // the root itself is allowed
  assert.equal(withinJail(path.join(root, '..', 'escape.txt'), [root]), false);
});

test('withinJail is not fooled by a shared name prefix (sibling directory)', () => {
  const home = os.homedir();
  const root = path.join(home, 'Proj');
  assert.equal(withinJail(path.join(home, 'Proj2', 'x.txt'), [root]), false);
});

test('allowedRoots / systemRoots return absolute path strings', () => {
  for (const list of [allowedRoots(), systemRoots()]) {
    assert.ok(Array.isArray(list) && list.length);
    for (const r of list) assert.equal(typeof r, 'string');
  }
});

/* ---------- ~ expansion ---------- */
test('expandHome resolves ~ and ~/, leaving absolute paths untouched', () => {
  const home = os.homedir();
  assert.equal(expandHome('~'), home);
  assert.equal(expandHome('~/Documents'), path.join(home, 'Documents'));
  assert.equal(expandHome('~/x'), path.join(home, 'x'));
  const abs = path.resolve('some', 'where');
  assert.equal(expandHome(abs), abs);
});

/* ---------- shell danger classification ---------- */
test('commandIsDangerous flags destructive/network verbs, passes read-only ones', () => {
  assert.equal(commandIsDangerous('rm -rf ./tmp'), true);
  assert.equal(commandIsDangerous('curl https://evil.test'), true);
  assert.equal(commandIsDangerous('taskkill /pid 4242'), true);
  assert.equal(commandIsDangerous('ls -la'), false);
  assert.equal(commandIsDangerous('echo hello world'), false);
});

/* ---------- confirmation gate ---------- */
test('isDangerous drives the confirm gate from risk + dangerousWhen', () => {
  assert.equal(isDangerous({ risk: 'dangerous' }, {}), true);
  assert.equal(isDangerous({ risk: 'safe' }, {}), false);
  assert.equal(isDangerous({ risk: 'conditional', dangerousWhen: () => true }, {}), true);
  assert.equal(isDangerous({ risk: 'conditional', dangerousWhen: () => false }, {}), false);
  assert.equal(isDangerous({ risk: 'conditional', dangerousWhen: () => { throw new Error('x'); } }, {}), false); // a broken predicate must not crash the loop
});

test('run_command is classified dangerous — it always requires confirmation now', () => {
  const run = TOOLS.find(t => t.name === 'run_command');
  assert.ok(run, 'run_command tool must exist');
  assert.equal(run.risk, 'dangerous');
  assert.equal(isDangerous(run, { command: 'echo hi' }), true);      // even a harmless command confirms
});

/* ---------- provider history normalization (legacy <-> normalized) ---------- */
test('normalizeHistory converts legacy Gemini model parts to a normalized assistant turn', () => {
  const out = normalizeHistory([{ role: 'model', parts: [{ text: 'hi there' }] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'hi there');
});

test('normalizeHistory turns legacy functionResponses into tool_results', () => {
  const out = normalizeHistory([{ role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { ok: true } } }] }]);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].tool_results.length, 1);
  assert.equal(out[0].tool_results[0].name, 'read_file');
});

test('normalizeHistory passes normalized turns straight through', () => {
  const m = { role: 'user', content: 'hello' };
  const out = normalizeHistory([m]);
  assert.equal(out[0], m);
  assert.deepEqual(normalizeHistory(undefined), []);
});

test('stripImages removes inline bytes, notes the attach, and drops transient _fields', () => {
  const out = stripImages({ role: 'user', content: 'look', images: [{ mime: 'image/png', data: 'AAAA' }], _provider: 'gemini' });
  assert.ok(!out.images, 'images must be gone');
  assert.match(out.content, /look \[image attached\]/);
  assert.ok(!('_provider' in out), '_-prefixed keys must be stripped');
});

/* ---------- provider registry ---------- */
test('providerConfig falls back to gemini; every listed provider resolves', () => {
  const fb = providerConfig('does-not-exist');
  assert.equal(fb.keyEnv, 'GEMINI_API_KEY');
  assert.ok(PROVIDER_ORDER.length >= 1);
  for (const id of PROVIDER_ORDER) {
    const c = providerConfig(id);
    assert.ok(c.label && c.keyEnv);
  }
});
