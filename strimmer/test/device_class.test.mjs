// always_forward_device_class (what a panel is actually sent) and the diagnostics bundle's
// handling of credentials, bounds and the options a standalone run takes from its environment.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { STATES } from './fixtures.mjs';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ha_ws_trim_proxy.mjs');
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { 'x-ingress-path': '/api/hassio_ingress/abc' } }, (r) => {
    let b = ''; r.on('data', (c) => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b }));
  }).on('error', reject);
});

// A card that names one entity, with credentials in every place diagnostics must scrub.
let deep = { api_key: 'DEEPSECRET' };
for (let i = 0; i < 50; i++) deep = { n: deep };
const CONFIGS = {
  'test-dash': {
    views: [{ cards: [
      { type: 'entities', entities: ['light.living_room'] },
      { type: 'picture', camera_image: 'camera.front', image: 'http://admin:HUNTER2@cam.local/snap?token=QUERYSECRET&x=1',
        api_key: 'KEYSECRET', deep },
    ] }],
  },
};

describe('always_forward_device_class and diagnostics', () => {
  let mock, port, sp, proxy, out = '';
  before(async () => {
    mock = await startMockHa({ configs: CONFIGS });
    [port, sp] = [await getFreePort(), await getFreePort()];
    proxy = spawn(process.execPath, [PROXY], {
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash', PORT: String(port),
        STATS_PORT: String(sp), STRIP_ENTITIES: '1', ALWAYS_FORWARD_DEVICE_CLASS: 'binary_sensor:door,sensor:door',
        NEVER_FORWARD: 'binary_sensor.back_door' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 25000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(out);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('forwards the matching class, honours never_forward, and stays inside the named domain', async () => {
    const seq = mock.subscribeEntitiesSeq();
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    const sent = await mock.waitForSubscribeEntities(seq);
    c.close();
    assert.ok(sent.includes('binary_sensor.front_door'), 'door class forwarded');
    assert.ok(!sent.includes('binary_sensor.back_door'), 'never_forward wins over a class rule');
    assert.ok(!sent.some((id) => STATES.find((s) => s.entity_id === id)?.attributes?.device_class === 'motion'), 'other classes are not');
    assert.ok(sent.includes('light.living_room'), 'the card entity is still there');
  });

  it('records what a panel asked for that was not forwarded, ignoring oversized ids', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    c.send({ type: 'history/stream', entity_ids: ['sensor.not_forwarded_one', `sensor.${'x'.repeat(300)}`] });
    await new Promise((r) => setTimeout(r, 400));
    c.close();
    const d = JSON.parse((await get(sp, '/diagnostics.json')).body);
    const asked = Object.assign({}, ...Object.values(d.askedButNotForwarded));
    assert.equal(asked['sensor.not_forwarded_one'], 1);
    assert.ok(!Object.keys(asked).some((k) => k.length > 255), 'an oversized id is not retained');
  });

  it('removes credentials from keys, URLs, query strings and past the depth cap', async () => {
    const body = (await get(sp, '/diagnostics.json')).body;
    for (const secret of ['HUNTER2', 'QUERYSECRET', 'KEYSECRET', 'DEEPSECRET']) {
      assert.ok(!body.includes(secret), `${secret} must not appear in the bundle`);
    }
    assert.ok(body.includes('cam.local/snap'), 'the rest of the URL is kept for diagnosis');
  });

  it("reports the environment's settings, not just the options file", async () => {
    const d = JSON.parse((await get(sp, '/diagnostics.json')).body);
    assert.deepEqual(d.options.always_forward_device_class, ['binary_sensor:door', 'sensor:door']);
    assert.deepEqual(d.options.never_forward, ['binary_sensor.back_door']);
  });
});
