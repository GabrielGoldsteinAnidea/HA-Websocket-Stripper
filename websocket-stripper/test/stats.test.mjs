// The stats panel and its JSON API.
//
// The behaviour worth pinning here is not "a number appears". It is that the numbers mean
// what the panel claims they mean:
//   - trimmed payloads report a real before/after taken from the same answer;
//   - the event stream is reported as throughput and NEVER as a saving, because the
//     untrimmed volume does not exist to be measured (HA filters server-side);
//   - the API is read-only and unknown paths 404 rather than reaching the proxy.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';
import * as stats from '../stats.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

const httpGet = (url) => new Promise((resolve, reject) => {
  const req = http.get(url, (res) => {
    let body = ''; res.on('data', (c) => body += c);
    res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
  });
  req.on('error', reject);
});

describe('stats counters', () => {
  it('reports a real before/after per category', () => {
    stats.reset();
    stats.recordTrim('states', 1000, 100);
    stats.recordTrim('states', 1000, 300);
    const s = stats.snapshot();
    assert.equal(s.savings.byCategory.states.count, 2);
    assert.equal(s.savings.byCategory.states.before, 2000);
    assert.equal(s.savings.byCategory.states.after, 400);
    assert.equal(s.savings.byCategory.states.saved, 1600);
    assert.equal(s.savings.byCategory.states.savedPct, 80);
  });

  it('keeps the event stream out of the savings total', () => {
    stats.reset();
    stats.recordTrim('states', 1000, 100);
    stats.recordEvent(5000);
    const s = stats.snapshot();
    // 5000 bytes of events must not inflate either side of the saving.
    assert.equal(s.savings.before, 1000);
    assert.equal(s.savings.after, 100);
    assert.equal(s.eventStream.bytes, 5000);
    assert.equal(s.eventStream.count, 1);
    assert.ok(!('saved' in s.eventStream), 'the event stream must never report a saving');
  });

  it('tracks open connections and forgets closed ones', () => {
    stats.reset();
    const a = stats.connOpen({ ip: '10.0.0.1', allowSize: 12 });
    stats.connOpen({ ip: '10.0.0.2', allowSize: 99 });
    stats.connTraffic(a, 500, 100, false);
    let s = stats.snapshot();
    assert.equal(s.clients.open, 2);
    assert.equal(s.clients.total, 2);
    const first = s.clients.list.find((c) => c.id === a);
    assert.equal(first.allowSize, 12);
    assert.equal(first.fromHA, 500);
    assert.equal(first.toBrowser, 100);

    stats.connClose(a);
    s = stats.snapshot();
    assert.equal(s.clients.open, 1);
    assert.equal(s.clients.total, 2, 'lifetime count must not go down when a client leaves');
  });

  it('reports no rate for a connection too young to have one', () => {
    stats.reset();
    const id = stats.connOpen({ ip: '10.0.0.3', allowSize: 5 });
    stats.connTraffic(id, 200000, 200000, true);
    const c = stats.snapshot().clients.list[0];
    // Extrapolating 200KB from a connection milliseconds old would claim megabytes/min.
    assert.equal(c.eventBytesPerMin, null, 'a sub-minute connection must not report a rate');
    assert.equal(c.eventBytes, 200000, 'the raw total is still reported');
  });

  it('counts only genuine events as event traffic', () => {
    stats.reset();
    const id = stats.connOpen({ ip: '10.0.0.4', allowSize: 1 });
    stats.connTraffic(id, 500, 500, false);   // an untrimmed reply, e.g. lovelace/config
    stats.connTraffic(id, 100, 100, true);    // an actual state event
    const c = stats.snapshot().clients.list[0];
    assert.equal(c.eventBytes, 100, 'untrimmed replies must not be counted as update traffic');
    assert.equal(c.toBrowser, 600, 'but they do count toward total traffic');
  });

  it('survives a division by zero when nothing has been trimmed', () => {
    stats.reset();
    const s = stats.snapshot();
    assert.equal(s.savings.savedPct, 0);
    assert.equal(s.savings.before, 0);
    assert.deepEqual(s.savings.byCategory, {});
  });
});

describe('stats peer gate', () => {
  it('admits Supervisor (the hassio network) and loopback, and nothing else by default', () => {
    for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.30.32.2', '172.30.33.11']) {
      assert.ok(stats.statsPeerAllowed(ok, false), `${ok} should be admitted`);
    }
    for (const no of ['192.168.5.10', '::ffff:10.2.4.129', '172.31.0.1', '172.30.34.1', '']) {
      assert.ok(!stats.statsPeerAllowed(no, false), `${no} should be refused`);
    }
  });
  it('stats_lan opens it to everyone', () => {
    assert.ok(stats.statsPeerAllowed('192.168.5.10', true));
  });
});

describe('stats API over HTTP', () => {
  let mock, proxy, port, statsPort, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    statsPort = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base,
        HA_TOKEN: 'test-token',
        DASH_PATHS: 'test-dash',
        PORT: String(port),
        STATS_PORT: String(statsPort),
        STRIP_ENTITIES: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => { out += b.toString(); });
    proxy.stderr.on('data', (b) => { out += b.toString(); });
    const deadline = Date.now() + 8000;
    while (!/stats panel on/.test(out) || !/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`proxy never started its stats server / built an allowlist\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(() => { proxy?.kill(); mock?.close(); });

  it('serves the panel HTML', async () => {
    const res = await httpGet(`http://127.0.0.1:${statsPort}/`);
    assert.equal(res.status, 200);
    assert.match(res.type, /text\/html/);
    assert.match(res.body, /WebSocket Stripper/);
    assert.match(res.body, /stats\.json/);
  });

  it('serves stats.json with the live configuration', async () => {
    const res = await httpGet(`http://127.0.0.1:${statsPort}/stats.json`);
    assert.equal(res.status, 200);
    assert.match(res.type, /application\/json/);
    const s = JSON.parse(res.body);
    assert.ok(s.version, 'version is reported');
    assert.equal(s.options.strip_entities, true);
    assert.ok(s.allowlist.union > 0, 'the allowlist size is reported');
    assert.equal(s.allowlist.ready, true);
  });

  it('counts a get_states trim with the instance size behind it', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'get_states' });
    await new Promise((r) => setTimeout(r, 400));
    c.close();

    const s = JSON.parse((await httpGet(`http://127.0.0.1:${statsPort}/stats.json`)).body);
    const states = s.savings.byCategory.states;
    assert.ok(states, 'a states trim was recorded');
    assert.ok(states.before > states.after, `expected a real reduction, got ${states.before} -> ${states.after}`);
    assert.ok(states.saved > 0);
    // The untrimmed get_states IS the whole instance, so it doubles as the instance size.
    assert.ok(s.allowlist.instanceEntities > 0, 'instance size learned from the untrimmed answer');
    assert.ok(s.allowlist.instanceEntities >= s.allowlist.union);
  });

  it('still serves when the Supervisor port lookup fails', async () => {
    // The add-on asks Supervisor which ingress port it was assigned. That call must never be
    // able to hang or kill startup: an unreachable Supervisor has to fall back to the
    // configured port, or a transient supervisor blip would cost the panel entirely.
    const failPort = await getFreePort();
    const proc = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env,
        HA_BASE: mock.base,
        HA_TOKEN: 'test-token',
        DASH_PATHS: 'test-dash',
        PORT: String(await getFreePort()),
        STATS_PORT: String(failPort),
        STRIP_ENTITIES: '1',
        // Points the lookup at a host that does not resolve, so it errors rather than answers.
        SUPERVISOR_TOKEN: 'not-a-real-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (b) => { out += b.toString(); });
    proc.stderr.on('data', (b) => { out += b.toString(); });
    try {
      const deadline = Date.now() + 15000;
      while (!/stats panel on/.test(out)) {
        if (Date.now() > deadline) throw new Error(`stats server never came up\n${out}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.match(out, /could not ask Supervisor for the ingress port/);
      const res = await httpGet(`http://127.0.0.1:${failPort}/stats.json`);
      assert.equal(res.status, 200, 'fell back to the configured port');
    } finally {
      proc.kill();
    }
  });

  it('404s unknown paths instead of proxying them', async () => {
    const res = await httpGet(`http://127.0.0.1:${statsPort}/lovelace`);
    assert.equal(res.status, 404);
  });
});
