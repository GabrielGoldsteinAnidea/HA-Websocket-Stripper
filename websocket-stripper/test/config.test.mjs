// Guards the add-on config's port handling: single source of truth (the `port` option),
// no inert `ports:` Docker mapping, and all three version stamps kept in sync.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(DIR, '..', p), 'utf8');
const cfg = read('config.yaml');

test('config.yaml has no top-level ports: / ports_description: block (inert under host_network)', () => {
  assert.ok(!/^ports:/m.test(cfg), 'ports: should be removed');
  assert.ok(!/^ports_description:/m.test(cfg), 'ports_description: should be removed');
});

test('config.yaml exposes the port option in both options and schema', () => {
  assert.match(cfg, /^\s{2}port:\s*8099\s*$/m, 'options.port default present');
  assert.match(cfg, /^\s{2}port:\s*"int\(1,65535\)\?"\s*$/m, 'schema.port present');
});

test('host_network stays on (trusted-network kiosk login depends on it)', () => {
  assert.match(cfg, /^host_network:\s*true\s*$/m);
});

test('version is in sync across config.yaml, package.json, and the proxy VERSION const', () => {
  const cfgV = cfg.match(/^version:\s*"([^"]+)"/m)?.[1];
  const pkgV = JSON.parse(read('package.json')).version;
  const srcV = read('ha_ws_trim_proxy.mjs').match(/const VERSION = '([^']+)'/)?.[1];
  assert.ok(cfgV, 'config.yaml version found');
  assert.equal(pkgV, cfgV, 'package.json matches config.yaml');
  assert.equal(srcV, cfgV, 'VERSION const matches config.yaml');
});

// The add-on's Configuration tab renders from translations/en.yaml. Without an entry an
// option shows as its raw key with no help text — and several of these options have real
// footguns (trim_resources can fail silently), so an unlabelled one is a trap.
test('every schema option has a name and description in translations/en.yaml', () => {
  const tr = read('translations/en.yaml');
  const schema = cfg.slice(cfg.indexOf('\nschema:'));
  const options = [...schema.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(options.length >= 9, `expected the full schema, parsed ${options.length}`);

  // Split into per-option blocks rather than using a lookahead: the last entry has no
  // following key to look ahead to, and JS has no \Z, so a lookahead silently never
  // matches it — which is exactly how this test first passed everything but the last option.
  const body = tr.slice(tr.indexOf('configuration:'));
  const blocks = new Map();
  let key = null, buf = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^ {2}([a-z_]+):\s*$/);
    if (m) { if (key) blocks.set(key, buf.join('\n')); key = m[1]; buf = []; }
    else if (key) buf.push(line);
  }
  if (key) blocks.set(key, buf.join('\n'));

  for (const opt of options) {
    const block = blocks.get(opt);
    assert.ok(block !== undefined, `translations/en.yaml is missing an entry for "${opt}"`);
    assert.match(block, /^ {4}name: /m, `"${opt}" has no name:`);
    assert.match(block, /^ {4}description: /m, `"${opt}" has no description:`);
  }
});

test('translations/en.yaml describes no option that does not exist', () => {
  const tr = read('translations/en.yaml');
  const schema = cfg.slice(cfg.indexOf('\nschema:'));
  const options = new Set([...schema.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]));
  const body = tr.slice(tr.indexOf('configuration:'));
  for (const [, key] of body.matchAll(/^ {2}([a-z_]+):/gm)) {
    assert.ok(options.has(key), `translations/en.yaml documents "${key}", which is not in the schema`);
  }
});
