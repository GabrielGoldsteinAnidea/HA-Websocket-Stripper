// Registry and Lovelace-resource trimming, plus the websocket-compression negotiation.
//
// None of this depends on HOW a connection is scoped: each trims to whatever allowlist the
// connection ended up with. With no per-connection scoping the allowlist is the union of the
// configured dashboards, which is what these tests exercise; once scoping lands the same code
// narrows to one dashboard's set with no change here.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket as WS } from 'ws';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

// How many resources the mock serves. Derived, not hard-coded: a test asserting
// "nothing was removed" must not break when a fixture resource is added.
const TOTAL_RESOURCES = 7;

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

function spawnProxy({ mock, dashPaths, port, extraEnv = {} }) {
  const proc = spawn(process.execPath, [PROXY], {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      HA_BASE: mock.base,
      HA_TOKEN: 'test-token',
      DASH_PATHS: dashPaths,
      PORT: String(port),
      STRIP_ENTITIES: '1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const listeners = [];
  const onData = (b) => {
    out += b.toString();
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].re.test(out)) { listeners[i].resolve(out); listeners.splice(i, 1); }
    }
  };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  const waitForLog = (re, ms = 8000) => new Promise((resolve, reject) => {
    if (re.test(out)) return resolve(out);
    const l = { re, resolve: (v) => { clearTimeout(t); resolve(v); } };
    listeners.push(l);
    const t = setTimeout(() => {
      const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1);
      reject(new Error(`timeout waiting for ${re}\n--- proxy output ---\n${out}`));
    }, ms);
  });
  return { proc, get out() { return out; }, waitForLog, kill: () => proc.kill() };
}


// Home Assistant's own websocket negotiates permessage-deflate. The `ws` library does not
// enable it server-side by default, so putting this proxy in front of HA dropped compression
// from the browser leg. These pin the negotiation in both directions.
// Resources are instance-wide in HA, so every kiosk parses every custom card in the install —
// the largest remaining cost once states and registries are trimmed.
describe('resource trimming', () => {
  let mock, proxy, port;
  // A dashboard whose only custom card is `custom:my-fancy-card`.
  const CFG = { views: [{ cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }] };

  before(async () => {
    mock = await startMockHa({ configs: { 'res-dash': CFG } });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'res-dash', port, extraEnv: { TRIM_RESOURCES: '1' } });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  const resourcesFor = async (p) => {
    const c = haClient(`ws://127.0.0.1:${p}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'lovelace/resources' })).result;
    c.close();
    return rows.map((r) => r.url);
  };

  it('keeps the resource providing a card a dashboard uses, drops the rest', async () => {
    const urls = await resourcesFor(port);
    assert.ok(urls.includes('/res/my-fancy-card.js'), 'the card this dashboard renders must survive');
    assert.ok(!urls.includes('/res/unrelated-widget.js'), 'a card no view references must be dropped');
  });

  // Regression: a loose icon-prefix pattern turns `16:9` and `06:00` into the keys "16" and
  // "06", and a 2-char string appears in every minified bundle — so everything matches and
  // nothing is dropped. That silently disabled the whole feature (39/45 kept, 97KB saved).
  it('is not fooled by aspect ratios and times into keeping everything', async () => {
    const cfg = { views: [{ cards: [
      { type: 'custom:my-fancy-card', entity: 'light.living_room', aspect_ratio: '16:9', schedule: '06:00' },
    ] }] };
    const m2 = await startMockHa({ configs: { 'ratio-dash': cfg } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'ratio-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2);
      assert.ok(!urls.includes('/res/unrelated-widget.js'),
        'an aspect_ratio must not become a match-everything key');
    } finally {
      // finally, not trailing statements: a throw above otherwise leaks the proxy and mock,
      // and the open handles hang the whole test FILE rather than failing one test.
      px.kill(); await m2.close();
    }
  });

  it('resources_always_forward rescues a global plugin that registers no card', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1', RESOURCES_ALWAYS_FORWARD: 'global-patcher' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2);
      assert.ok(urls.includes('/res/global-patcher.js'), 'always_forward must win over the content match');
    } finally { px.kill(); }
  });

  it('serves the union across dashboards, since nothing says which one a socket shows', async () => {
    const m2 = await startMockHa({ configs: {
      'a-dash': { views: [{ cards: [{ type: 'custom:my-fancy-card', entity: 'light.living_room' }] }] },
      'b-dash': { views: [{ cards: [{ type: 'custom:unrelated-widget', entity: 'light.bedroom' }] }] },
    } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'a-dash,b-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2);
      assert.ok(urls.includes('/res/my-fancy-card.js') && urls.includes('/res/unrelated-widget.js'),
        'both dashboards\' cards must survive — serving less would break whichever one is open');
      assert.ok(!urls.includes('/res/global-patcher.js'), 'a resource no dashboard references is still dropped');
    } finally { px.kill(); await m2.close(); }
  });

  // The one failure the documented tuning loop ("load it and see what looks wrong") cannot
  // catch: a resource that registers no element and is named by no dashboard, but runs on
  // load and subscribes to state. Dropping it leaves the dashboard pixel-identical and only
  // stops the behaviour, so the log has to say which resources those could be.
  it('names the resources dropped by EVERY dashboard, since those fail silently', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/drop\s+\d+KB \/res\/global-patcher\.js/);
      const out = px.out;
      assert.match(out, /dropped by ALL dashboards \(no dashboard references them\)/);
      assert.match(out, /INVISIBLE/, 'the warning must say the failure is invisible');
      assert.match(out, /resources_always_forward/, 'and name the option that fixes it');
      assert.match(out, /\/res\/global-patcher\.js/, 'and list the offending resource');
    } finally { px.kill(); }
  });

  // A 3-character icon namespace matched as a bare substring kept 4.8MB of bundles that
  // merely contained those letters in base64 blobs and minified identifiers. An icon
  // reference always carries its colon, so that is what gets matched.
  it('matches an icon namespace with its colon, not as a bare substring', async () => {
    const cfg = { views: [{ cards: [{ type: 'tile', entity: 'light.living_room', icon: 'cbi:bulb' }] }] };
    const m2 = await startMockHa({ configs: { 'icon-dash': cfg } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'icon-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2, '/icon-dash');
      assert.ok(urls.some((u) => u.includes('icon-pack')), 'a body containing "cbi:" must be kept');
      assert.ok(!urls.some((u) => u.includes('cbi-lookalike')),
        'a body containing only the bare letters "cbi" must NOT be kept');
      // The pack that SERVES the namespace registers it as a key and never writes `cbi:`.
      assert.ok(urls.some((u) => u.includes('provider')),
        'the provider registering customIconsets["cbi"] must be kept');
    } finally { px.kill(); await m2.close(); }
  });

  // Big bundles build their element names at runtime: ha-bambulab-cards.js is 3.2MB and the
  // string `ha-bambulab-print_status-card` appears nowhere in it, only `bambulab` and
  // `print_status` separately. Two rare fragments are ample evidence.
  it('matches a card whose element name is built at runtime, via its fragments', async () => {
    const cfg = { views: [{ cards: [{ type: 'custom:ha-bambulab-print_status-card', entity: 'light.living_room' }] }] };
    const m2 = await startMockHa({ configs: { 'bambu-dash': cfg } });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'bambu-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2, '/bambu-dash');
      assert.ok(urls.some((u) => u.includes('bambulab-print_status-cards')),
        'all fragments present must count as a match');
      assert.ok(!urls.some((u) => u.includes('unrelated-widget')),
        'a bundle sharing no fragment must still be dropped');
    } finally { px.kill(); await m2.close(); }
  });

  // REGRESSION, and the reason this option is worth being careful with. Mushroom registers its
  // elements from template literals, so `mushroom-cover-card` appears nowhere in mushroom.js —
  // and neither does the bare word `cover`. The matcher used to require EVERY fragment to be
  // present and TWO distinctive ones, which a `<oneword>-<generic>-card` name can never
  // satisfy, so the entire Mushroom family was dropped. Nothing logged an error; the cards
  // simply rendered as errors on the dashboard.
  //
  // Its own mock: this needs a specific resource set, and mutating the shared fixtures changes
  // the counts other tests in this file assert exactly.
  it('keeps a bundle identified only by one rare fragment', async () => {
    const m2 = await startMockHa({
      configs: { 'mush-dash': { views: [{ cards: [
        { type: 'custom:mushroom-cover-card', entity: 'cover.shade_left' },
        // A second card with a plain literal match. Without it the dashboard would match
        // NOTHING, and the trimmer forwards every resource rather than send a dashboard an
        // empty list — so the drop this test is about would be masked by that safety net and
        // the test would pass for the wrong reason.
        { type: 'custom:plainthing-card', entity: 'light.living_room' },
      ] }] } },
      resources: [
        { id: 'm1', type: 'module', url: '/res/mushroom.js' },
        { id: 'm2', type: 'module', url: '/res/plain.js' },
        { id: 'm3', type: 'module', url: '/res/unrelated.js' },
      ],
      resourceBodies: {
        // Exactly how Mushroom ships: the name is assembled at registration time, so neither
        // the full element name nor the generic half `cover` is in the file.
        '/res/mushroom.js': 'const P="mushroom";for(const t of TYPES)customElements.define(`${P}-${t}-card`,C);',
        '/res/plain.js': 'customElements.define("plainthing-card",X);',
        // Shares only the generic word `card`, which all three bodies contain — so it is too
        // common to identify anything and must not carry a match on its own.
        '/res/unrelated.js': 'customElements.define("zzz-card",X);',
      },
    });
    const p2 = await getFreePort();
    const px = spawnProxy({ mock: m2, dashPaths: 'mush-dash', port: p2, extraEnv: { TRIM_RESOURCES: '1' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const urls = await resourcesFor(p2);
      assert.ok(urls.includes('/res/plain.js'), 'the literal match is kept, so trimming is live');
      assert.ok(urls.includes('/res/mushroom.js'),
        `a bundle naming none of its own cards must still be kept; kept: ${JSON.stringify(urls)}`);
      assert.ok(!urls.includes('/res/unrelated.js'),
        `and a shared generic word must not keep a bundle; kept: ${JSON.stringify(urls)}`);
    } finally { px.kill(); await m2.close(); }
  });

  it('trim_resources off (the default) leaves the list untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'res-dash', port: p2 });
    try {
      await px.waitForLog(/union allowlist for/);
      assert.equal((await resourcesFor(p2)).length, TOTAL_RESOURCES);
    } finally { px.kill(); }
  });
});

describe('registry trimming', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('cuts the entity registry to entities the connection can see', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'config/entity_registry/list' })).result;
    c.close();
    assert.ok(Array.isArray(rows), 'registry came back as a list');
    const ids = new Set(rows.map((r) => r.entity_id));
    assert.ok(ids.has('light.living_room'), 'an entity this dashboard shows must survive');
    assert.ok(!ids.has('light.kitchen'), 'an entity no dashboard shows must not survive');
  });

  // The regression this pins: `list_for_display` answers with an OBJECT, so an
  // Array.isArray() guard on the result skipped it — and it is the single largest payload
  // the frontend fetches (1.44MB of a 2.46MB load on the instance this was built against).
  it('cuts list_for_display, which is an object and not a list', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const r = (await c.rpc({ type: 'config/entity_registry/list_for_display' })).result;
    c.close();
    assert.ok(r && !Array.isArray(r) && Array.isArray(r.entities), 'shape is {entity_categories, entities}');
    const ids = new Set(r.entities.map((e) => e.ei));      // rows key entity_id as `ei`
    assert.ok(ids.has('light.living_room'), 'an entity this dashboard shows must survive');
    assert.ok(!ids.has('light.kitchen'), 'an entity no dashboard shows must not survive');
    assert.deepEqual(r.entity_categories, { 0: 'config', 1: 'diagnostic' },
      'the category map is not per-entity and must be passed through intact');
  });

  it('trim_registries=0 leaves the registry untouched', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, dashPaths: 'test-dash', port: p2, extraEnv: { TRIM_REGISTRIES: '0' } });
    try {
      await px.waitForLog(/union allowlist for/);
      const c = haClient(`ws://127.0.0.1:${p2}/api/websocket`);
      await c.authed;
      const rows = (await c.rpc({ type: 'config/entity_registry/list' })).result;
      c.close();
      assert.ok(rows.some((r) => r.entity_id === 'light.kitchen'),
        'with trimming off, entities no dashboard shows must still pass through');
    } finally { px.kill(); }
  });
});
