// Inline `data:` resources: a card registered as `data:text/javascript;base64,...`. Every edit
// changes the whole URL, so identity-by-path cannot save it; the keep-set must follow updates.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const dataUrl = (js) => 'data:text/javascript;base64,' + Buffer.from(js).toString('base64');
const CARD = (v) => dataUrl(`customElements.define('inline-card', class {}); /* v${v} */`);
const OTHER = dataUrl('customElements.define("something-else", class {});' + "/* pad ".repeat(40));
const CFG = { views: [{ cards: [{ type: 'custom:inline-card', entity: 'light.living_room' }] }] };

const get = (url) => new Promise((res, rej) => http.get(url, (r) => { r.resume(); r.on('end', res); }).on('error', rej));

describe('inline data: resources', () => {
  let mock, port, proc, out = '';
  before(async () => {
    mock = await startMockHa({
      configs: { 'inline-dash': CFG },
      resources: [{ id: 'a', type: 'module', url: CARD(1) }, { id: 'b', type: 'module', url: OTHER },
        { id: 'c', type: 'module', url: 'data:' + 'x'.repeat(500) }],
    });
    port = await getFreePort();
    proc = spawn(process.execPath, [path.join(DIR, '..', 'ha_ws_trim_proxy.mjs')], {
      cwd: path.join(DIR, '..'),
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 'test-token', DASH_PATHS: 'inline-dash',
        PORT: String(port), STATS_PORT: '0', STRIP_ENTITIES: '1', TRIM_RESOURCES: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (b) => { out += b; }); proc.stderr.on('data', (b) => { out += b; });
    await until(() => /for live allowlist updates/.test(out));
  });
  after(async () => { proc.kill(); await mock.close(); });

  async function until(fn, ms = 20000) {
    const t = Date.now();
    while (!(await fn())) { if (Date.now() - t > ms) throw new Error('timeout\n' + out); await new Promise((r) => setTimeout(r, 50)); }
  }
  const urls = async () => {
    await get(`http://127.0.0.1:${port}/inline-dash`);
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const rows = (await c.rpc({ type: 'lovelace/resources' })).result;
    c.close();
    return rows.map((r) => r.url);
  };

  it('reads data: URLs, so an unrelated inline resource is dropped and the card kept', async () => {
    const u = await urls();
    assert.ok(u.includes(CARD(1)));
    assert.ok(!u.includes(OTHER), 'its body was readable and names no card the dashboard uses');
  });

  it('never logs a whole data: URL', () => {
    assert.match(out, /could not read data:x+…\(\d+ chars\)/);
    assert.doesNotMatch(out, /x{150}/);
    assert.doesNotMatch(out, /base64,[A-Za-z0-9+/=]{60}/);
  });

  it('an update event rebuilds, so the re-versioned inline card stays', async () => {
    mock.updateResourceUrl('a', CARD(2));
    await until(() => /lovelace resources changed — rebuilding/.test(out));
    await until(async () => (await urls()).includes(CARD(2)));
  });

  it('a URL the last build never saw is forwarded, not dropped', async () => {
    mock.updateResourceUrl('a', CARD(3), false);
    assert.ok((await urls()).includes(CARD(3)));
  });
});
