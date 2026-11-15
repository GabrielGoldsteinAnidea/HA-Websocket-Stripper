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

test('config.yaml exposes the listen port in both options and schema', () => {
  // proxy_port is the canonical name; `port` (upstream's) stays schema-only so an existing
  // config keeps working without Supervisor discarding it.
  assert.match(cfg, /^\s{2}proxy_port:\s*9123\s*$/m, 'options.proxy_port default present');
  assert.match(cfg, /^\s{2}proxy_port:\s*"int\(1,65535\)\?"\s*$/m, 'schema.proxy_port present');
  assert.match(cfg, /^\s{2}port:\s*"int\(1,65535\)\?"\s*$/m, 'schema still accepts the old name');
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
  assert.ok(options.length >= 10, `expected the full schema, parsed ${options.length}`);

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

// The stats `options` block is hand-maintained, and it silently fell behind three times:
// log_level, trim_repairs and trim_translations were each added to config.yaml without it. The
// panel then reported them as absent, which reads identically to "Supervisor never passed this"
// — the precise question that block exists to answer. So the list is pinned to the schema.
test('the stats options block reports every simple option the schema declares', async () => {
  const { LEGACY_KEYS: LEGACY, REMOVED_KEYS } = await import('../config_store.mjs');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cfg = fs.readFileSync(path.join(dir, '..', 'config.yaml'), 'utf8');
  const src = fs.readFileSync(path.join(dir, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

  // Toggles and choices — the options a person reads off the panel to answer "is it on?".
  // List and free-string options are reported elsewhere and are deliberately out of scope.
  const simple = [...cfg.matchAll(/^  ([a-z_]+): "?(bool\??|list\([a-z|]+\)\?)"?$/gm)]
    .map((m) => m[1])
    // A renamed option is reported under its new name only; the stats block has one field per
    // setting, not one per spelling.
    .filter((k) => !LEGACY.has(k) && !REMOVED_KEYS.has(k));
  assert.ok(simple.length >= 6, `expected several simple options, found ${simple.length}`);

  const block = src.slice(src.indexOf('    options: {'), src.indexOf('    allowlist: {'));
  const missing = simple.filter((k) => !block.includes(`${k}:`));
  assert.deepEqual(missing, [], `options missing from the stats block: ${missing.join(', ')}`);
});

// ingress_port is metadata Supervisor reads at install time; INGRESS_PORT is a constant compiled
// into the proxy, because the running process cannot see config.yaml. If they drift apart the
// sidebar panel breaks over Ingress while the direct port keeps working — a failure that looks
// like Ingress being broken rather than like a configuration mismatch.
test('ingress_port matches the INGRESS_PORT the proxy compiles in', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const cfg = fs.readFileSync(path.join(dir, '..', 'config.yaml'), 'utf8');
  const src = fs.readFileSync(path.join(dir, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

  const declared = Number((cfg.match(/^ingress_port:\s*(\d+)/m) || [])[1]);
  const compiled = Number((src.match(/^const INGRESS_PORT = (\d+);/m) || [])[1]);
  assert.ok(declared, 'config.yaml must declare an ingress_port');
  assert.ok(compiled, 'the proxy must compile in an INGRESS_PORT');
  assert.equal(compiled, declared,
    `INGRESS_PORT ${compiled} does not match config.yaml ingress_port ${declared}`);

  // And the option's default must be the same, or a fresh install has a panel that cannot be
  // reached from the sidebar out of the box.
  const dflt = Number((cfg.match(/^  mgmt_port:\s*(\d+)/m) || [])[1]);
  assert.ok(dflt, 'config.yaml must declare a mgmt_port default');
  assert.equal(dflt, declared, `mgmt_port default ${dflt} must equal ingress_port ${declared}`);

  // Both spellings must stay in the schema. `port` is upstream's name and `stats_port` is in
  // every config written before the rename; dropping either from the schema would make Supervisor
  // discard a working setting on upgrade, which is silent and costs someone their listen port.
  for (const k of ['proxy_port', 'port', 'mgmt_port', 'stats_port']) {
    assert.match(cfg, new RegExp(`^  ${k}: `, 'm'), `${k} must remain in the schema`);
  }
});

// The healthcheck used to carry its own copy of the stats port as a shell default. As an add-on
// that copy is the ONLY one that runs — Supervisor passes config in /data/options.json, so
// STATS_PORT is never in the container's environment. When the port moved 8100 -> 9122 the copy
// stayed behind, and a container that served every request correctly was marked unhealthy,
// restarted by the watchdog every ~85 seconds, and never reported `started` — so Ingress showed
// "The app is starting" forever. No test saw it, because every test asks the server directly on a
// port it was told. The fix was to delete the duplicate: the proxy writes the port it bound and
// the probe reads that file. This keeps it deleted.
test('the Dockerfile healthcheck reads the bound port instead of hardcoding one', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const dockerfile = fs.readFileSync(path.join(dir, '..', 'Dockerfile'), 'utf8');
  const src = fs.readFileSync(path.join(dir, '..', 'ha_ws_trim_proxy.mjs'), 'utf8');

  // The env override exists for tests, which must not all fight over one file in /tmp; the
  // default is what the image runs with, and what the probe has to read.
  const portFile = (src.match(/^const STATS_PORT_FILE = (?:process\.env\.STATS_PORT_FILE \|\| )?'([^']+)';/m) || [])[1];
  assert.ok(portFile, 'the proxy must define STATS_PORT_FILE');
  // ...and must actually write it, or the probe has nothing to read.
  assert.match(src, new RegExp(`writeFileSync\\(STATS_PORT_FILE`),
    'the proxy must write STATS_PORT_FILE once the stats server binds');

  const probe = (dockerfile.match(/^HEALTHCHECK[\s\S]*?\n(?:\s+CMD[\s\S]*?)(?=\n\n|\n#|$)/m) || [])[0];
  assert.ok(probe, 'the Dockerfile must declare a HEALTHCHECK');
  assert.ok(probe.includes(portFile),
    `the healthcheck must read the port from ${portFile}, got: ${probe}`);
  // Any bare 4-5 digit number in the probe is a second source of truth for the port.
  const literal = probe.split(portFile).join('').match(/\b\d{4,5}\b/);
  assert.equal(literal, null,
    `the healthcheck must not hardcode a port (found ${literal && literal[0]})`);
});

// Both spellings of each port must stay readable in the source.
//
// `port` is upstream's name and `stats_port` is in every config written before the rename, so
// dropping either read would break a working install on upgrade — silently, since the option
// would simply stop being seen and the default would quietly take over. The env aliases are
// exercised by the whole suite, which spawns the proxy with PORT and STATS_PORT throughout; the
// options-file aliases have no such coverage, hence this.
test('the proxy still reads the pre-rename port option names', () => {
  const src = read('ha_ws_trim_proxy.mjs');
  for (const pair of [['proxy_port', 'port'], ['mgmt_port', 'stats_port']]) {
    const [canonical, legacy] = pair;
    assert.match(src, new RegExp(`OPT\\.${canonical}\\s*\\|\\|\\s*OPT\\.${legacy}`),
      `the proxy must read OPT.${canonical} and fall back to OPT.${legacy}`);
  }
  assert.match(src, /process\.env\.PROXY_PORT\s*\|\|\s*process\.env\.PORT/);
  assert.match(src, /process\.env\.MGMT_PORT\s*\|\|\s*process\.env\.STATS_PORT/);
});

// EDITABLE_KEYS is the console's catalogue of what it may change. It is declared rather than
// derived from /data/options.json, because an option nobody has set yet is precisely the one
// someone opens the console to set — deriving the list would hide it. A declared list drifts,
// though: the stats options block silently fell behind the schema three times. So it is pinned.
test('EDITABLE_KEYS covers every schema option that is not a setup option', async () => {
  const { EDITABLE_KEYS, BOOTSTRAP_KEYS, LEGACY_KEYS, REMOVED_KEYS } = await import('../config_store.mjs');
  const schema = cfg.slice(cfg.indexOf('\nschema:'));
  const declared = [...schema.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 20, `expected the full schema, parsed ${declared.length}`);

  // Renamed options stay in the schema so Supervisor does not discard them, but the console
  // deliberately does not offer them — the canonical name is the row.
  // A RETIRED option stays in the schema so an existing config survives the update, and is
  // deliberately absent from the console: a switch that does nothing is worse than no switch.
  const missing = declared.filter((k) => !BOOTSTRAP_KEYS.has(k) && !LEGACY_KEYS.has(k)
    && !REMOVED_KEYS.has(k) && !EDITABLE_KEYS[k]);
  assert.deepEqual(missing, [], `schema options the console cannot see: ${missing.join(', ')}`);

  // And nothing invented: a key here that is not in the schema is a setting that would be
  // written to the store, reported as managed, and read by nobody.
  const known = new Set(declared);
  const extra = Object.keys(EDITABLE_KEYS).filter((k) => !known.has(k));
  assert.deepEqual(extra, [], `EDITABLE_KEYS names options that are not in the schema: ${extra.join(', ')}`);
});

// Adopting the port the console is served on is the one change that can make the console
// unreachable — and the rename to proxy_port/mgmt_port briefly left the canonical spellings
// unprotected while only the legacy aliases were refused.
test('both spellings of both ports are setup options', async () => {
  const { BOOTSTRAP_KEYS, adopt } = await import('../config_store.mjs');
  for (const k of ['proxy_port', 'port', 'mgmt_port', 'stats_port', 'ha_base', 'log_level']) {
    assert.ok(BOOTSTRAP_KEYS.has(k), `${k} must never be adoptable`);
    assert.throws(() => adopt({ version: 1, managed: {}, history: [] }, k, 1, {}),
      /setup option/, `adopt("${k}") must be refused`);
  }
});

// A rename is only safe if the old name keeps working.
//
// `strip_entities: false` is a deliberate choice — it turns the app into a pass-through proxy for
// an A/B comparison. If the rename made that key inert, trimming would switch back ON for anyone
// who had turned it off, silently, and the app would start filtering a firehose they had asked it
// to leave alone. So the old name must still be honoured, and the new one must win when both are
// present.
test('the pre-rename entity-trim option is still honoured', () => {
  const src = read('ha_ws_trim_proxy.mjs');
  const decl = src.match(/const STRIP = [\s\S]*?;\n/)?.[0];
  assert.ok(decl, 'the proxy must resolve STRIP');
  assert.match(decl, /OPT\.trim_entities/, 'the new name must be read');
  assert.match(decl, /OPT\.strip_entities/, 'the old name must still be read');
  // Order matters: the canonical name has to be consulted first, or a config carrying both (which
  // is what a half-migrated config looks like) would obey the one being retired.
  assert.ok(decl.indexOf('OPT.trim_entities') < decl.indexOf('OPT.strip_entities'),
    'trim_entities must take precedence over strip_entities');
});

// The same guarantee, executed rather than read off the source: boot the proxy with ONLY the old
// name set to false and check it really does pass the websocket through untrimmed.
test('a config with only the old name still turns trimming off', async () => {
  const { spawn } = await import('node:child_process');
  const { startMockHa, getFreePort } = await import('./mock-ha.mjs');
  const http = await import('node:http');

  const mock = await startMockHa();
  const port = await getFreePort();
  const sp = await getFreePort();
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const proxy = spawn(process.execPath, [path.join(dir, '..', 'ha_ws_trim_proxy.mjs')], {
    cwd: path.join(dir, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    // STRIP_ENTITIES is the old ENV name and is set to 0; nothing sets the new one.
    env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
      PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '0' },
  });
  try {
    let out = '';
    proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 10000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const s = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: sp, path: '/stats.json' }, (res) => {
        let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(JSON.parse(b)));
      }).on('error', reject);
    });
    assert.equal(s.options.trim_entities, false,
      'the old name must still be able to turn trimming off');
  } finally { proxy.kill(); await mock.close(); }
});

// A config written before a rename has nothing under the new name. The console still has to show
// the value that is actually in effect, or the row for the central trim option renders blank on
// every install that predates the rename — which reads as "unset", the one thing it is not.
test('a renamed option shows the value its old spelling carries', async () => {
  const { LEGACY_ALIASES, legacyNameFor } = await import('../config_store.mjs');
  assert.equal(LEGACY_ALIASES.strip_entities, 'trim_entities');
  assert.equal(legacyNameFor('trim_entities'), 'strip_entities');
  assert.equal(legacyNameFor('mgmt_port'), 'stats_port');
  assert.equal(legacyNameFor('dashboards'), undefined, 'a name that was never renamed has no alias');

  // Every legacy key must point at a name the console actually offers, or the fallback reads a
  // key nothing will ever render and the row stays blank anyway.
  const { EDITABLE_KEYS, BOOTSTRAP_KEYS } = await import('../config_store.mjs');
  for (const [old, canonical] of Object.entries(LEGACY_ALIASES)) {
    assert.ok(EDITABLE_KEYS[canonical] || BOOTSTRAP_KEYS.has(canonical),
      `${old} points at ${canonical}, which is neither offered nor a setup option`);
  }

  const src = read('ha_ws_trim_proxy.mjs');
  assert.match(src, /value: eff\[k\] !== undefined \? eff\[k\]\s*: eff\[legacyNameFor\(k\)\] !== undefined \? eff\[legacyNameFor\(k\)\]/,
    'the config endpoint must fall back to the old spelling for a value');
});

// The same guarantee as the entity-trim rename, for every renamed option at once.
//
// Turning by_dashboard off is a deliberate choice for panels that navigate between dashboards
// without reloading; making the old key inert would re-scope those connections and blank half
// their cards until someone reloaded. Every rename has a story like that, which is why the old
// name is read at all — and why the new one has to be read FIRST, or a half-migrated config
// carrying both would obey the name being retired.
test('every renamed option reads the new name first and still reads the old one', async () => {
  const { LEGACY_ALIASES } = await import('../config_store.mjs');
  const src = read('ha_ws_trim_proxy.mjs');
  // The ports resolve in their own expression, already covered by its own test.
  const bools = Object.entries(LEGACY_ALIASES).filter(([old]) => !old.endsWith('port'));
  assert.ok(bools.length >= 2, 'expected several renamed non-port options');

  for (const [old, canonical] of bools) {
    const decl = src.match(new RegExp(`const [A-Z_]+ = OPT\\.${canonical}[\\s\\S]*?;\\n`))?.[0];
    assert.ok(decl, `the proxy must resolve ${canonical} starting from OPT.${canonical}`);
    assert.ok(decl.includes(`OPT.${old}`), `${old} must still be read`);
    assert.ok(decl.indexOf(`OPT.${canonical}`) < decl.indexOf(`OPT.${old}`),
      `${canonical} must be consulted before ${old}`);
  }
});

// The console groups options into sections. An option that names a section which does not exist
// renders into nothing — it vanishes from the page while still being a real, settable option,
// which is the worst of both: present in the schema, absent from the UI meant to replace it.
test('every option belongs to a section that exists, and no section is empty', async () => {
  const { OPTIONS, SECTIONS, EDITABLE_KEYS } = await import('../config_store.mjs');
  const ids = new Set(SECTIONS.map((s) => s.id));
  assert.equal(ids.size, SECTIONS.length, 'section ids must be unique');

  for (const [key, o] of Object.entries(OPTIONS)) {
    assert.ok(o.section, `${key} declares no section`);
    assert.ok(ids.has(o.section), `${key} is in section "${o.section}", which is not declared`);
    assert.ok(o.label && o.label !== key, `${key} needs a human label, not its own key`);
    assert.ok(o.type, `${key} declares no type`);
  }
  // A section with nothing in it renders as a heading over empty space.
  for (const s of SECTIONS) {
    assert.ok(Object.values(OPTIONS).some((o) => o.section === s.id),
      `section "${s.id}" has no options`);
    assert.ok(s.title && s.blurb, `section "${s.id}" needs a title and a blurb`);
  }
  // EDITABLE_KEYS is derived now rather than maintained twice; if that derivation broke, the
  // endpoint's write guard would start refusing every key.
  assert.deepEqual(Object.keys(EDITABLE_KEYS), Object.keys(OPTIONS));
});

// The pill row and the Config tab must group options the same way.
//
// They did not: the pills keyed off the `trim_` prefix while the page groups by declared section,
// so by_dashboard sat inside Trimming on one screen and stood alone on the other. Two answers to
// "is this a trim option" on two halves of the same panel. The page now reads the sections the
// server declares, which only works if the server actually sends them.
test('stats.json carries the section map the pill row groups by', () => {
  const src = read('ha_ws_trim_proxy.mjs');
  assert.match(src, /optionSections: Object\.fromEntries\(/,
    'stats.json must publish which section each option is in');

  const panel = read('panel.html');
  assert.match(panel, /s\.optionSections/, 'the pill row must read the published sections');
  // The prefix rule survives only as a fallback for an older server; if it were still the primary
  // rule the map would be published and ignored.
  const inTrim = panel.match(/const inTrim = \(k\) => [^;]+;/)?.[0];
  assert.ok(inTrim, 'the pill row must decide trim membership in one place');
  // Both must be present before comparing positions: indexOf returns -1 for a missing needle,
  // and -1 sorts "before" everything, so an ordering check alone passes when the section lookup
  // has been deleted entirely — which is the exact regression this test exists to catch.
  const iSection = inTrim.indexOf('sections[k]');
  const iPrefix = inTrim.indexOf("startsWith('trim_')");
  assert.notEqual(iSection, -1, 'the declared section must be consulted');
  assert.notEqual(iPrefix, -1, 'the name-prefix fallback must remain for an older server');
  assert.ok(iSection < iPrefix,
    'the declared section must be consulted before the name-prefix fallback');
});

// by_dashboard is the case that exposed the mismatch, so it is worth naming outright: it does not
// start with trim_, and it IS a trimming option.
test('by_dashboard is grouped with trimming despite its name', async () => {
  const { OPTIONS } = await import('../config_store.mjs');
  assert.equal(OPTIONS.by_dashboard.section, 'trim');
  assert.equal(OPTIONS.trim_entities.section, 'trim');
  assert.equal(OPTIONS.mdns_discovery.section, 'discovery', 'mDNS stays out of the trim count');
  assert.equal(OPTIONS.esphome_api.section, 'monitoring');
  assert.equal(OPTIONS.compress_websocket.section, 'websocket');
});

// The Config tile and the status pill must say the same words. They used to be two lists — a
// regex on the key in panel.html, a caption in the catalogue — and six of the twelve had already
// drifted ("resources" vs "Custom cards", "compress" vs "Compression"). The pill now reads the
// catalogue, so this guards the remaining assumption: that every boolean HAS a caption to read.
test('every boolean option carries a short caption and an icon for its tile', () => {
  const src = fs.readFileSync(path.join(DIR, '..', 'config_store.mjs'), 'utf8');
  const bools = [...src.matchAll(/^ {2}(\w+): \{ type: 'bool'[^}]*\}/gm)];
  assert.ok(bools.length >= 12, `expected the boolean options, found ${bools.length}`);
  for (const [decl, key] of bools.map((m) => [m[0], m[1]])) {
    assert.match(decl, /short: '[^']+'/, `${key} needs a short caption for its tile`);
    assert.match(decl, /icon: '[a-z0-9-]+'/, `${key} needs an MDI icon name for its tile`);
  }
});

// The add-on must START with an options file from an older version still in it.
//
// This is the failure that took the add-on down on the one install that mattered: a boot-time
// notice about the retired `mqtt_sensors` was written beside the option read at the top of the
// file, where `warn` — a const declared fifty lines further down — is in its temporal dead zone.
// Every test configured the proxy through the ENVIRONMENT, so nothing ever set that option and
// the crash reached production instead. It boots from an options FILE here for that reason.
test('boots with a retired option still in the options file, and says it does nothing', async () => {
  const { startMockHa, getFreePort } = await import('./mock-ha.mjs');
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const mock = await startMockHa();
  const port = await getFreePort(); const sp = await getFreePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strimmer-retired-'));
  fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify({
    dashboards: ['test-dash'], mqtt_sensors: true,
  }));
  const proxy = spawn(process.execPath, [path.join(dir, '..', 'ha_ws_trim_proxy.mjs')], {
    cwd: path.join(dir, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
      PORT: String(port), STATS_PORT: String(sp), CONFIG_DIR: dataDir },
  });
  let out = '';
  proxy.stdout.on('data', (b) => { out += b; });
  proxy.stderr.on('data', (b) => { out += b; });
  try {
    const deadline = Date.now() + 25000;
    while (!/for live allowlist updates/.test(out) && Date.now() < deadline) {
      assert.doesNotMatch(out, /ReferenceError|Cannot access/, `the add-on crashed on boot:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(out, /for live allowlist updates/, `never finished booting:\n${out}`);
    assert.match(out, /mqtt_sensors no longer does anything/,
      'a setting that has stopped working has to say so, or its sensors just vanish');
  } finally {
    proxy.kill(); await mock.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Boot a proxy for the two tests below and wait until it is serving.
async function bootProxy(env) {
  const { startMockHa } = await import('./mock-ha.mjs');
  const { spawn } = await import('node:child_process');
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const mock = await startMockHa();
  const proxy = spawn(process.execPath, [path.join(dir, '..', 'ha_ws_trim_proxy.mjs')], {
    cwd: path.join(dir, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HA_BASE: mock.base, ...env(mock) },
  });
  let out = '';
  proxy.stdout.on('data', (b) => { out += b; });
  proxy.stderr.on('data', (b) => { out += b; });
  const deadline = Date.now() + 25000;
  while (!/for live allowlist updates/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /for live allowlist updates/, `never finished booting:\n${out}`);
  return { mock, proxy, out: () => out, stop: async () => { proxy.kill(); await mock.close(); } };
}

// As an add-on, only Supervisor's address speaks for Ingress. Every other Ingress test sets
// INGRESS_PEERS or runs standalone, so without this one a default that let loopback back in (the
// host-network forgery fixed in 2026.10.02.3) would pass the whole suite.
test('as an add-on, a request from loopback is not Ingress, whatever its headers say', async () => {
  const { getFreePort } = await import('./mock-ha.mjs');
  const os = await import('node:os');
  const http = await import('node:http');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strimmer-addon-'));
  fs.writeFileSync(path.join(dataDir, 'options.json'), JSON.stringify({ dashboards: ['test-dash'] }));
  const sp = await getFreePort();
  const port = await getFreePort();
  const p = await bootProxy((mock) => ({
    PORT: String(port), STATS_PORT: String(sp),
    SUPERVISOR_TOKEN: 'supervisor-token', ALLOW_WS_URL: mock.base.replace(/^http/, 'ws') + '/api/websocket',
    CONFIG_DIR: dataDir, STATS_PORT_FILE: path.join(dataDir, 'stats-port'), INGRESS_PEERS: '',
  }));
  const forged = { 'x-ingress-path': '/api/hassio_ingress/forged', 'x-remote-user-id': 'u-david', 'content-type': 'application/json' };
  const call = (method, p2, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: sp, path: p2, method, headers: forged }, (r) => {
      let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    const write = await call('POST', '/config', { key: 'trim_services', value: true });
    assert.equal(write.status, 403, 'loopback is every host-network process, not Supervisor');
    const snap = JSON.parse((await call('GET', '/stats.json')).body);
    assert.equal(snap.redacted, true);
    assert.deepEqual(snap.viewer, { ingress: false, admin: false });
  } finally {
    await p.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// The proxy deliberately keeps running when its console port is taken. The healthcheck probes that
// port, so without "unbound" it failed, and the Supervisor watchdog restarted a working proxy in a
// loop. The file is seeded with a stale port first: it must not survive into this run.
test('a console port that cannot bind tells the healthcheck "unbound", and the proxy keeps serving', async () => {
  const { getFreePort } = await import('./mock-ha.mjs');
  const os = await import('node:os');
  const net = await import('node:net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strimmer-unbound-'));
  const portFile = path.join(dir, 'stats-port');
  fs.writeFileSync(portFile, '12345');
  const taken = await getFreePort();
  const holder = net.createServer();
  await new Promise((r) => holder.listen(taken, r));
  const port = await getFreePort();
  let p;
  try {
    p = await bootProxy(() => ({
      HA_TOKEN: 't', DASH_PATHS: 'test-dash', PORT: String(port), STATS_PORT: String(taken),
      STATS_PORT_FILE: portFile, SUPERVISOR_TOKEN: '',
    }));
    assert.match(p.out(), /stats server could not start/);
    assert.equal(fs.readFileSync(portFile, 'utf8'), 'unbound',
      'the probe must be told there is nothing to probe, not left with an old port');
  } finally {
    await p?.stop();
    holder.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
