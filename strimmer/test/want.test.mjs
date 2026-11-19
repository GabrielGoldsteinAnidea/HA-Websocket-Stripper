// strimmer/want: a page asks for entities by glob, for its user's connections only.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

describe('strimmer/want', () => {
  let mock, proxy, port, dataDir, out = '';

  const injectedFor = async (token) => {
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, token);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    const got = await mock.waitForSubscribeEntities(seq);
    c.close();
    return got ?? null;
  };

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strimmer-wantdata-'));
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: {
        ...process.env, HA_BASE: mock.base, HA_TOKEN: 'test-token', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(await getFreePort()), STRIP_ENTITIES: '1',
        CONFIG_DIR: dataDir, NEVER_FORWARD: 'sensor.decoy_power',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => { out += b.toString(); });
    proxy.stderr.on('data', (b) => { out += b.toString(); });
    const deadline = Date.now() + 40000;
    while (!/for live allowlist updates/.test(out)) {
      if (Date.now() > deadline) throw new Error(`proxy never started\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(() => {
    proxy?.kill(); mock?.close();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not serve the entities before anyone asks', async () => {
    const ids = await injectedFor('david-token');
    assert.ok(ids.length && !ids.includes('sensor.decoy_energy'));
  });

  it('ignores patterns it will not run, and says added 0', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'david-token');
    await c.authed;
    const r = await c.rpc({ type: 'strimmer/want', entity_ids: ['*', '/.*/', '(a+)+', 'x'.repeat(201), 42, '*.*.*.*a'] });
    assert.deepEqual([r.success, r.result], [true, { strimmer: true, added: 0 }]);
    c.close();
  });

  it('answers the ask itself and reconnects the page to add them', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'david-token');
    await c.authed;
    const closed = new Promise((r) => c.ws.once('close', () => r(true)));
    const r = await c.rpc({ type: 'strimmer/want', entity_ids: ['sensor.decoy_*'] });
    assert.equal(r.success, true);
    assert.equal(r.result.strimmer, true, 'answered by Strimmer, not Home Assistant');
    assert.equal(r.result.added, 1, 'decoy_energy only: decoy_power is never_forward');
    assert.equal(await Promise.race([closed, new Promise((x) => setTimeout(() => x(false), 3000))]), true);
  });

  it('serves them on that user\'s next connection, never past never_forward', async () => {
    const ids = await injectedFor('david-token');
    assert.ok(ids.includes('sensor.decoy_energy'));
    assert.ok(!ids.includes('sensor.decoy_power'));
  });

  it('leaves everyone else alone', async () => {
    assert.ok(!(await injectedFor('michelle-token')).includes('sensor.decoy_energy'));
  });

  it('does not reconnect when it already has them', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`, 'david-token');
    await c.authed;
    const r = await c.rpc({ type: 'strimmer/want', entity_ids: ['sensor.decoy_*'] });
    assert.equal(r.result.added, 0);
    const stillOpen = await new Promise((x) => { c.ws.once('close', () => x(false)); setTimeout(() => x(true), 800); });
    assert.equal(stillOpen, true, 'a page asking on every connection must not loop');
    c.close();
  });
});
