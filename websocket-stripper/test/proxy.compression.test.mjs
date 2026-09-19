// Home Assistant's own websocket negotiates permessage-deflate. The `ws` library does not
// enable it server-side by default, so simply putting this proxy in front of HA removed
// compression from the browser leg — kiosks that had been receiving deflated frames started
// receiving plaintext JSON. These tests pin the negotiation in both directions.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startMockHa, getFreePort } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

function spawnProxy({ mock, port, extraEnv = {} }) {
  const proc = spawn(process.execPath, [PROXY], {
    cwd: path.join(DIR, '..'),
    env: {
      ...process.env,
      HA_BASE: mock.base,
      HA_TOKEN: 'test-token',
      DASH_PATHS: 'test-dash',
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
  return { proc, waitForLog, kill: () => proc.kill() };
}

// The negotiated extension is visible on the upgrade response, so this reads what the
// browser would actually be given rather than inferring it from config.
const negotiated = (url) => new Promise((resolve) => {
  const ws = new WebSocket(url, { perMessageDeflate: true });
  let done = false;
  const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
  ws.on('upgrade', (r) => finish(r.headers['sec-websocket-extensions'] || ''));
  ws.on('error', () => finish(''));
  setTimeout(() => finish(''), 5000);
});

describe('websocket compression', () => {
  let mock, proxy, port;

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawnProxy({ mock, port });
    await proxy.waitForLog(/allowlist for/);
  });
  after(async () => { proxy.kill(); await mock.close(); });

  it('offers permessage-deflate to the browser, as HA itself does', async () => {
    assert.match(await negotiated(`ws://127.0.0.1:${port}/api/websocket`), /permessage-deflate/);
  });

  it('compress_websocket=0 turns it off', async () => {
    const p2 = await getFreePort();
    const px = spawnProxy({ mock, port: p2, extraEnv: { COMPRESS_WS: '0' } });
    try {
      await px.waitForLog(/allowlist for/);
      assert.doesNotMatch(await negotiated(`ws://127.0.0.1:${p2}/api/websocket`), /permessage-deflate/);
    } finally {
      px.kill();
    }
  });
});
