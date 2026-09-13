// Per-connection scoping, driven through a real proxy process against the mock HA.
//
// The allowlist is normally the UNION of every configured dashboard, so each kiosk receives what
// ALL of them need and adding a dashboard grows what every other kiosk gets. With
// `scope_per_connection` on, a connection gets only the dashboards mapped to the HA user it
// authenticated as, and anything unrecognised falls back to the union.
//
// Two properties carry most of the weight here and neither is obvious:
//
//   * EVERY fallback lands on the union, never on an empty set. HA reads an empty entity_ids as
//     "no filter", so an empty scope would relay the whole firehose. That makes "it silently
//     fell back" indistinguishable from "it worked" unless a test proves the scope actually
//     discriminates — which is what `a mapped user does NOT see another dashboard's entities`
//     is for.
//   * Holding a frame means holding EVERY frame after it. HA requires ids to increase, so
//     releasing a held get_states after a later message already went through would earn an
//     `id_reuse` rejection. The mock enforces that rule, so a reordering bug fails loudly.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Two kiosks with deliberately disjoint entities, so "did it scope?" has a yes/no answer
// rather than a size comparison that a fallback could accidentally satisfy.
const DASH_A = { title: 'A', views: [{ path: 'main', cards: [{ type: 'entities', entities: ['light.living_room', 'sensor.temperature'] }] }] };
const DASH_B = { title: 'B', views: [{ path: 'main', cards: [{ type: 'entities', entities: ['light.kitchen', 'sensor.humidity'] }] }] };
const CONFIGS = { 'dash-a': DASH_A, 'dash-b': DASH_B };
const USERS = {
  'tok-a': { id: 'user-a', name: 'Kiosk A', is_admin: false },
  'tok-b': { id: 'user-b', name: 'Kiosk B', is_admin: false },
  'tok-nomap': { id: 'user-unmapped', name: 'Someone', is_admin: false },
};
const SCOPES = JSON.stringify([
  { user: 'user-a', dashboards: ['dash-a'] },
  { user: 'user-b', dashboards: ['dash-b'] },
]);

function spawnProxy({ mock, port, extraEnv = {} }) {
  const proc = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env, HA_BASE: mock.base, HA_TOKEN: 'test-token',
      DASH_PATHS: 'dash-a,dash-b', PORT: String(port), SUPERVISOR_TOKEN: '', ...extraEnv,
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
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const waitForLog = (re, ms = 8000) => new Promise((resolve, reject) => {
    if (re.test(out)) return resolve(out);
    const l = { re, resolve: (v) => { clearTimeout(t); resolve(v); } };
    listeners.push(l);
    const t = setTimeout(() => {
      const i = listeners.indexOf(l);
      if (i >= 0) { listeners.splice(i, 1); reject(new Error(`timeout waiting for ${re}\n--- proxy output ---\n${out}`)); }
    }, ms);
  });
  return { proc, get out() { return out; }, waitForLog, kill: () => proc.kill() };
}

// The entity set a given kiosk actually receives, asked for the way the frontend does.
async function seenBy(port, token) {
  const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, token);
  await c.authed;
  const res = await c.rpc({ type: 'get_states' });
  c.close();
  assert.ok(res.success !== false, `get_states failed: ${JSON.stringify(res.error)}`);
  return new Set(res.result.map((s) => s.entity_id));
}

describe('per-connection scoping is off by default', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa({ configs: CONFIGS, users: USERS });
    port = await getFreePort();
    // The map is present but the switch is not, which is the upgrade case: an install that
    // gains the option must behave exactly as it did before anyone turns it on.
    proxy = spawnProxy({ mock, port, extraEnv: { SCOPE_BY_USER: SCOPES } });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('a mapped user still receives the union', async () => {
    const seen = await seenBy(port, 'tok-a');
    assert.ok(seen.has('light.living_room'), 'own dashboard');
    assert.ok(seen.has('light.kitchen'), 'the OTHER dashboard too — this is the old behaviour');
  });
});

describe('per-connection scoping', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa({ configs: CONFIGS, users: USERS });
    port = await getFreePort();
    proxy = spawnProxy({
      mock,
      port,
      extraEnv: {
        SCOPE_PER_CONNECTION: '1',
        SCOPE_BY_USER: SCOPES,
        // On no dashboard at all, so it can only arrive by being forced.
        ALWAYS_FORWARD: 'switch.fan',
        NEVER_FORWARD: 'sensor.temperature',
      },
    });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('a mapped user gets its own dashboard and NOT the other one', async () => {
    const a = await seenBy(port, 'tok-a');
    assert.ok(a.has('light.living_room'), 'own dashboard present');
    assert.ok(!a.has('light.kitchen'), 'the other dashboard is NOT forwarded — the scope discriminates');
    assert.ok(!a.has('sensor.humidity'), 'nor its second entity');
  });

  it('a different user gets a different set on the same proxy', async () => {
    const b = await seenBy(port, 'tok-b');
    assert.ok(b.has('light.kitchen'), 'own dashboard present');
    assert.ok(!b.has('light.living_room'), 'not dashboard A');
  });

  it('an unmapped user falls back to the union', async () => {
    const seen = await seenBy(port, 'tok-nomap');
    assert.ok(seen.has('light.living_room') && seen.has('light.kitchen'),
      'both dashboards — a user with no scope must not be narrowed');
  });

  it('a connection whose user cannot be identified falls back to the union', async () => {
    // No entry in `users`, so `auth/current_user` fails — an old client, a service account,
    // anything the lookup cannot answer for.
    const seen = await seenBy(port, 'tok-unknown');
    assert.ok(seen.has('light.living_room') && seen.has('light.kitchen'));
  });

  it('always_forward reaches a SCOPED connection', async () => {
    // The entities most worth forcing are the ones on no dashboard — a health helper, a command
    // channel. A scoped connection has an even smaller set to find them in, so if per-scope
    // overrides were skipped this is where it would show.
    const a = await seenBy(port, 'tok-a');
    assert.ok(a.has('switch.fan'), 'always_forward applied to the scope, not only to the union');
  });

  it('never_forward still wins inside a scope', async () => {
    const a = await seenBy(port, 'tok-a');
    assert.ok(!a.has('sensor.temperature'), 'on dashboard A, but excluded');
  });
});

describe('a scope that resolves to nothing falls back rather than emptying', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa({ configs: CONFIGS, users: USERS });
    port = await getFreePort();
    proxy = spawnProxy({
      mock,
      port,
      extraEnv: {
        SCOPE_PER_CONNECTION: '1',
        SCOPE_BY_USER: JSON.stringify([{ user: 'user-a', dashboards: ['dash-typo'] }]),
      },
    });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('warns that the scope names a dashboard which is not served', () => {
    assert.match(proxy.out, /scope_by_user\[user-a\] names dashboard\(s\) not in `dashboards`: dash-typo/);
  });

  it('serves the union instead of an empty allowlist', async () => {
    // An empty entity_ids means "no filter" to HA, so an empty scope must never be forwarded.
    // Falling back to the union is the safe direction: the kiosk still works.
    const seen = await seenBy(port, 'tok-a');
    assert.ok(seen.has('light.living_room') && seen.has('light.kitchen'));
  });
});

describe('a slow user lookup must not reorder frames', () => {
  let mock, proxy, port;
  before(async () => {
    // Slow enough that get_states is certain to arrive while the scope is still unknown.
    mock = await startMockHa({ configs: CONFIGS, users: USERS, currentUserDelayMs: 600 });
    port = await getFreePort();
    proxy = spawnProxy({ mock, port, extraEnv: { SCOPE_PER_CONNECTION: '1', SCOPE_BY_USER: SCOPES } });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('a message sent after a held one does not overtake it', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'tok-a');
    await c.authed;
    // id 1 needs the scope and is held; id 2 does not. If id 2 were forwarded first, HA would
    // reject id 1 with `id_reuse` — the mock enforces the same rule real HA does.
    const first = c.rpc({ type: 'get_states' });
    const second = c.rpc({ type: 'lovelace/dashboards/list' });
    const [a, b] = await Promise.all([first, second]);
    assert.ok(a.success !== false, `held get_states rejected: ${JSON.stringify(a.error)}`);
    assert.ok(b.success !== false, `following message rejected: ${JSON.stringify(b.error)}`);
    // and it was still scoped, i.e. the wait was not simply skipped
    const ids = new Set(a.result.map((s) => s.entity_id));
    assert.ok(!ids.has('light.kitchen'), 'released against the SCOPE, not the union');
    c.close();
  });
});

describe('allowlist growth recycles only the affected scope', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa({ configs: CONFIGS, users: USERS });
    port = await getFreePort();
    proxy = spawnProxy({ mock, port, extraEnv: { SCOPE_PER_CONNECTION: '1', SCOPE_BY_USER: SCOPES } });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('editing dashboard B leaves a connection scoped to A alone', async () => {
    // Under a global union ANY growth is growth for everyone, so an unrelated registry event or
    // a neighbour's dashboard edit recycles every open kiosk. That is the behaviour this
    // changes, and it is the whole reason the reconnect set is keyed by scope.
    const a = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'tok-a');
    await a.authed;
    await a.rpc({ type: 'get_states' });          // settle the scope before measuring
    const b = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'tok-b');
    await b.authed;
    await b.rpc({ type: 'get_states' });

    let aClosed = false;
    a.ws.on('close', () => { aClosed = true; });
    const bClosed = new Promise((res) => b.ws.on('close', res));

    mock.setConfig('dash-b', {
      title: 'B',
      views: [{ path: 'main', cards: [{ type: 'entities', entities: ['light.kitchen', 'sensor.humidity', 'light.bedroom'] }] }],
    });
    mock.fireLovelaceUpdated('dash-b');

    await proxy.waitForLog(/reconnecting 1 open dashboard connection/, 10000);
    await bClosed;
    assert.equal(aClosed, false, 'the connection scoped to dash-a was NOT recycled');
    assert.equal(a.ws.readyState, WebSocket.OPEN, 'and is still open');
    a.close();
  });
});
