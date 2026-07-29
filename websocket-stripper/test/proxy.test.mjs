// Integration tests: spawn the REAL proxy (ha_ws_trim_proxy.mjs) in dev mode against the
// mock HA, and drive it over real HTTP + websockets. Exercises buildAllow, the
// subscribe_entities injection, get_states trimming, X-Forwarded-For normalization, the
// non-/api/websocket upgrade passthrough, and live allowlist rebuild on lovelace_updated.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';
import { STATES, DASH_TEST } from './fixtures.mjs';

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
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const waitForLog = (re, ms = 8000) => new Promise((resolve, reject) => {
    if (re.test(out)) return resolve(out);
    // Clear the reject timer on resolve: left running, a 40s timer pins the event loop for
    // its full duration even after the wait succeeded, which silently added ~36s of dead
    // idle to the suite. (Deliberately NOT unref'd — that would turn a missing log line into
    // a hang instead of a clean timeout failure.)
    const l = { re, resolve: (v) => { clearTimeout(t); resolve(v); } };
    listeners.push(l);
    const t = setTimeout(() => { const i = listeners.indexOf(l); if (i >= 0) { listeners.splice(i, 1); reject(new Error(`timeout waiting for ${re}\n--- proxy output ---\n${out}`)); } }, ms);
  });
  return { proc, get out() { return out; }, waitForLog, kill: () => proc.kill() };
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = ''; res.on('data', (c) => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Raw (non-ws-library) upgrade request, so the test controls exactly how the socket dies.
function rawUpgrade(port, path) {
  const sock = net.connect(port, '127.0.0.1');
  return new Promise((resolve, reject) => {
    sock.on('error', reject);
    sock.on('connect', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
        'Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      resolve(sock);
    });
  });
}

describe('proxy integration (strip on)', () => {
  let mock, proxy, port;
  // test-dash: 6 explicit/text-scanned ids. auto-dash: a label:1st_floor filter that the
  // #4 registry resolver expands to light.living_room (already present) + light.bedroom.
  const EXPECTED = ['light.living_room', 'sensor.temperature', 'camera.front', 'binary_sensor.front_door', 'sensor.humidity', 'switch.fan', 'light.bedroom'];

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash,auto-dash', port });
    // The proxy now listens BEFORE the allowlist exists, so "listening" no longer means
    // ready — the allowlist line is the real ready signal.
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('unions both dashboards; #4 registry resolver expands the auto-dash label filter', () => {
    const m = proxy.out.match(/union allowlist for \[[^\]]+\]: (\d+) entities/);
    assert.ok(m, 'allowlist log line present');
    assert.equal(Number(m[1]), EXPECTED.length);
  });

  it('HTTP passes through to HA and normalizes X-Forwarded-For to bare IPv4', async () => {
    const r = await httpGet(`http://127.0.0.1:${port}/some/path`);
    assert.equal(r.status, 200);
    assert.match(r.body, /MOCK_HA_BODY \/some\/path/);
    const xff = mock.lastXFF();
    assert.ok(xff, 'HA saw an X-Forwarded-For header');
    assert.ok(!xff.includes('::ffff:'), `XFF should be bare IPv4, got ${xff}`);
  });

  it('injects the allowlist into a no-filter subscribe_entities', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 300));
    const injected = mock.lastSubscribeEntities();
    assert.ok(Array.isArray(injected), 'entity_ids were injected');
    assert.deepEqual(new Set(injected), new Set(EXPECTED));
    assert.ok(!injected.includes('light.decoy'), 'decoy entity was trimmed');
    c.close();
  });

  it('trims the get_states result to the allowlist', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const res = await c.rpc({ type: 'get_states' });
    const ids = res.result.map((e) => e.entity_id);
    assert.deepEqual(new Set(ids), new Set(EXPECTED));
    assert.ok(!ids.includes('sensor.decoy_power'));
    c.close();
  });

  it('egress filter drops out-of-allowlist entities from subscribe_entities events (PR #1)', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const subId = c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 200));
    const evP = c.waitFor((msg) => msg.type === 'event' && msg.id === subId);
    // Simulate a misbehaving HA that ignores entity_ids and streams a decoy anyway.
    mock.pushEntityEvent({
      a: {
        'light.living_room': { s: 'on' },   // allowlisted -> kept
        'light.decoy': { s: 'on' },          // NOT allowlisted -> must be stripped
      },
      r: ['sensor.decoy_power'],             // NOT allowlisted -> must be stripped
    });
    const ev = await evP;
    assert.ok(ev.event.a['light.living_room'], 'allowlisted entity passes through');
    assert.ok(!ev.event.a['light.decoy'], 'decoy entity stripped from added');
    assert.deepEqual(ev.event.r, [], 'decoy stripped from removed list');
    c.close();
  });

  it('passes non-/api/websocket ws upgrades straight through (e.g. /api/webrtc/ws)', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/webrtc/ws`);
    const hello = await new Promise((resolve, reject) => {
      ws.on('message', (m) => resolve(JSON.parse(m.toString())));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('no passthrough hello')), 3000);
    });
    assert.equal(hello.type, 'echo_hello');
    assert.equal(hello.path, '/api/webrtc/ws');
    assert.match(proxy.out, /ws upgrade passthrough -> HA: \/api\/webrtc\/ws/);
    ws.close();
  });
});

describe('live allowlist rebuild on lovelace_updated', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    // The proxy now listens BEFORE the allowlist exists, so "listening" no longer means
    // ready — the allowlist line is the real ready signal.
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('rebuilds the allowlist when a dashboard is edited (no restart)', async () => {
    // Add an entity to the dashboard, then fire lovelace_updated.
    mock.setConfig('test-dash', { views: [{ path: 'main', cards: [
      { type: 'entities', entities: ['light.living_room', 'light.decoy'] },
    ] }] });
    mock.fireLovelaceUpdated('test-dash');
    // #7: the recompute logs the added/removed diff, not just the total. `-removed` is the
    // last line applyAllow emits, so waiting on it guarantees the whole diff was flushed.
    await proxy.waitForLog(/-removed:[^\n]*sensor\.temperature/, 6000);
    assert.match(proxy.out, /allowlist recomputed \(test-dash\): \d+ entities \(\+1 -5\)/);
    assert.match(proxy.out, /\+added:[^\n]*light\.decoy/);

    // A NEW connection now gets the updated list including the formerly-decoy entity.
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(mock.lastSubscribeEntities().includes('light.decoy'));
    c.close();
  });
});

// Regression tests for the HA-reboot crash: the add-on used to die outright when HA went
// away (unhandled socket 'error' on an in-flight ws upgrade), and on restart it exited 2 if
// HA wasn't back yet — a Supervisor crash-restart loop that never recovered on its own.
const TEST_DASH_ENTITIES = ['light.living_room', 'sensor.temperature', 'camera.front',
  'binary_sensor.front_door', 'sensor.humidity', 'switch.fan'];

describe('survives an HA restart', () => {
  let mock, proxy, port, haPort;
  before(async () => {
    haPort = await getFreePort();
    mock = await startMockHa({ port: haPort });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('does not crash on a client reset while HA has not answered an upgrade', async () => {
    // Freeze HA mid-upgrade so the proxy's client socket sits in the pre-101 window, where
    // http-proxy has not yet attached its own 'error' handler.
    mock.setHangUpgrades(true);
    try {
      const sock = await rawUpgrade(port, '/api/camera_stream/ws');
      await proxy.waitForLog(/ws upgrade passthrough -> HA: \/api\/camera_stream\/ws/);
      sock.resetAndDestroy();        // RST -> read ECONNRESET on a socket with no listener
      // Assert the per-socket handler in server.on('upgrade') is what caught it. Without
      // this the test also passes on the process-wide guard alone, so it would not fail if
      // the actual fix were deleted.
      await proxy.waitForLog(/ws upgrade socket error \(\/api\/camera_stream\/ws\): .*ECONNRESET/);
      // exitCode alone is not enough: a signal-kill (OOM, SIGSEGV) also leaves it null.
      assert.equal(proxy.proc.exitCode, null, `proxy died:\n${proxy.out}`);
      assert.equal(proxy.proc.signalCode, null, `proxy was killed by a signal:\n${proxy.out}`);
      assert.doesNotMatch(proxy.out, /Unhandled 'error' event/);
    } finally {
      mock.setHangUpgrades(false);   // must not leak into the next test even if this one fails
    }
  });

  it('stays up while HA is gone, then rebuilds when it returns', async () => {
    await mock.close();                                    // HA reboots
    // Traffic keeps arriving while HA is down — none of it may take the proxy with it.
    const outage = await httpGet(`http://127.0.0.1:${port}/during-outage`);
    assert.equal(outage.status, 502, 'HTTP degrades to 502 rather than killing the proxy');
    const dead = await rawUpgrade(port, '/api/camera_stream/ws');
    await delay(200); dead.resetAndDestroy();
    const browser = new WebSocket(`ws://127.0.0.1:${port}/api/websocket`);
    browser.on('error', () => {});
    await delay(300);
    assert.equal(proxy.proc.exitCode, null, `proxy died during the outage:\n${proxy.out}`);

    mock = await startMockHa({ port: haPort });            // HA is back on the same address
    await proxy.waitForLog(/allowlist recomputed \(reconnect\)/, 40000);
    assert.equal(proxy.proc.exitCode, null);

    // ...and it is trimming again, with no restart and no reconfiguration.
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const res = await c.rpc({ type: 'get_states' });
    assert.deepEqual(new Set(res.result.map((e) => e.entity_id)), new Set(TEST_DASH_ENTITIES));
    c.close();
  });
});

// A restarting HA does not come back all at once: it accepts a websocket and authenticates
// well before lovelace serves configs or the state machine has finished loading. A rebuild
// in that window comes back SHORT — and since no dashboard edit follows a restart, nothing
// would ever rebuild it, so the kiosk would sit with "unavailable" cards indefinitely.
describe('a half-started HA never shrinks the allowlist', () => {
  let mock, proxy, port, haPort;
  before(async () => {
    haPort = await getFreePort();
    mock = await startMockHa({ port: haPort, configs: { 'test-dash': DASH_TEST } });
    port = await getFreePort();
    proxy = spawnProxy({ mock, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/union allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('refuses to commit an allowlist when no dashboard config is available yet', async () => {
    await mock.close();
    // Back up enough to authenticate and answer get_states, but lovelace is not serving.
    mock = await startMockHa({ port: haPort, configs: {} });
    await proxy.waitForLog(/post-auth setup failed: no dashboard config available yet/, 40000);
    // The previous allowlist is still served, so open dashboards keep working.
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const res = await c.rpc({ type: 'get_states' });
    assert.deepEqual(new Set(res.result.map((e) => e.entity_id)), new Set(TEST_DASH_ENTITIES));
    c.close();
  });

  it('merges instead of replacing when the rebuild comes back short', async () => {
    await mock.close();
    // lovelace serves again, but the state machine is still filling: only two of the six
    // dashboard entities exist yet. A replacing rebuild would drop the other four for good.
    mock = await startMockHa({
      port: haPort,
      configs: { 'test-dash': DASH_TEST },
      states: STATES.filter((s) => ['light.living_room', 'sensor.temperature'].includes(s.entity_id)),
    });
    await proxy.waitForLog(/allowlist recomputed \(reconnect\)/, 40000);
    assert.doesNotMatch(proxy.out, /-removed:[^\n]*switch\.fan/);

    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    await delay(300);
    const injected = new Set(mock.lastSubscribeEntities());
    for (const e of TEST_DASH_ENTITIES) assert.ok(injected.has(e), `${e} is still allowlisted`);
    c.close();
  });
});

// The failure mode that turned a misconfiguration into an OOM crash-loop on a real instance:
// the add-on shipped the author's own dashboards as defaults, so a fresh install resolved
// NOTHING. An empty allowlist is not a harmless no-op — HA reads
// `set(msg["entity_ids"]) or None`, so an empty entity_ids means *no filter*, and the proxy
// dutifully relayed all ~3,600 entities until it hit the 2GB heap limit.
describe('an empty allowlist is never forwarded as "no filter"', () => {
  let mock, proxy, port;
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    // Dashboards that don't exist on this instance — exactly the shipped-defaults case.
    proxy = spawnProxy({ mock, dashPaths: 'someone-elses-dash,also-missing', port });
    await proxy.waitForLog(/no dashboard config available yet/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('refuses the websocket instead of subscribing to every entity', async () => {
    mock.state.lastSubscribeEntities = 'NOT_CALLED';
    const sock = await rawUpgrade(port, '/api/websocket');
    const head = await new Promise((res) => sock.on('data', (b) => res(b.toString())));
    assert.match(head, /^HTTP\/1\.1 503/);
    sock.destroy();
    await delay(200);
    assert.equal(mock.state.lastSubscribeEntities, 'NOT_CALLED',
      'no subscribe_entities may reach HA while the allowlist is empty');
  });

  it('logs the dashboards that DO exist, so the misconfiguration is self-diagnosing', () => {
    assert.match(proxy.out, /dashboards on this HA: lovelace, test-dash, auto-dash/);
    assert.match(proxy.out, /set the `dashboards` option/);
  });
});

describe('boots while HA is still down', () => {
  let mock, proxy, port, haPort;
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('waits for HA instead of exiting, then serves once it comes up', async () => {
    haPort = await getFreePort();
    port = await getFreePort();
    // Nothing is listening on haPort yet — the host-boot case where the add-on starts before
    // HA core does. 0.2.1 logged "failed to compute allowlist" and exited 2 right here.
    proxy = spawnProxy({ mock: { base: `http://127.0.0.1:${haPort}` }, dashPaths: 'test-dash', port });
    await proxy.waitForLog(/waiting for HA to come up/);
    assert.equal(proxy.proc.exitCode, null, 'proxy stayed up while HA was down');
    assert.doesNotMatch(proxy.out, /failed to compute allowlist/);

    // It is already listening, and refuses /api/websocket rather than handing the frontend
    // an empty allowlist (which would show every card as unavailable until a manual reload).
    const sock = await rawUpgrade(port, '/api/websocket');
    const head = await new Promise((res) => sock.on('data', (b) => res(b.toString())));
    assert.match(head, /^HTTP\/1\.1 503/);
    sock.destroy();

    mock = await startMockHa({ port: haPort });
    await proxy.waitForLog(/union allowlist for/, 40000);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const res = await c.rpc({ type: 'get_states' });
    assert.deepEqual(new Set(res.result.map((e) => e.entity_id)), new Set(TEST_DASH_ENTITIES));
    c.close();
  });
});
