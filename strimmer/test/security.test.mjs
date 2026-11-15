// What the network may read.
//
// The management server binds every interface, so everything it serves is reachable by anything
// on the LAN — including the IoT VLAN the panels sit on. Writes were gated from the start. Reads
// were not, and "statistics are harmless" turned out to be wrong in a way that is worth pinning
// down forever: Home Assistant puts credentials in request PATHS, and the request log kept them.
//
// Measured on a live instance before this was fixed: 2 webhook ids, 37 HLS stream tokens and 4
// signed camera-proxy paths, all readable without authentication. A webhook id is a bearer
// credential — anyone holding one can POST to it and fire whatever automation it drives.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startMockHa, getFreePort, haClient } from './mock-ha.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(DIR, '..', 'ha_ws_trim_proxy.mjs');

const req = (port, p, { headers = {}, method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
    let b = ''; res.on('data', (c) => b += c);
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  });
  r.on('error', reject); r.end();
});
// Supervisor's own address plus the header it sets. Loopback counts as Ingress for local testing,
// so a plain request from the test IS the "through Ingress" case once the header is present.
const ING = { 'x-ingress-path': '/api/hassio_ingress/abc' };

describe('what the network may read', () => {
  let mock, proxy, port, sp, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    sp = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '1',
        USER_OVERRIDES: JSON.stringify([{ user: 'David Coulson', always_forward: ['/^update\\./'] }]) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 25000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('refuses every identity-bearing read that did not come through Ingress', async () => {
    for (const p of ['/access.json', '/entities.json', '/devices.json', '/config.json', '/history.json', '/diagnostics.json']) {
      const res = await req(sp, p);
      assert.equal(res.status, 403, `${p} must not be readable from the network`);
      assert.match(res.body, /Ingress/, `${p} must say why`);
    }
  });

  it('still serves all of them through Ingress', async () => {
    for (const p of ['/access.json', '/entities.json', '/devices.json', '/config.json', '/history.json', '/diagnostics.json']) {
      const res = await req(sp, p, { headers: ING });
      assert.equal(res.status, 200, `${p} must still work for the console`);
    }
  });

  it('diagnostics is a download, lists the allowlist per dashboard and carries no credentials', async () => {
    const res = await req(sp, '/diagnostics.json', { headers: ING });
    assert.match(res.headers['content-disposition'], /attachment/);
    const d = JSON.parse(res.body);
    assert.ok(d.version && d.node);
    assert.ok(Array.isArray(d.allowlist.byDashboard['test-dash']));
    assert.ok(d.dashboards['test-dash'], 'the dashboard config is included');
    assert.ok(!/"(ha_token|supervisor_token)"\s*:\s*"(?!\[redacted\])/i.test(res.body));
  });

  // /access.json is the one that carried credentials, so it gets its own test naming them.
  it('never hands the request log — webhook ids and stream tokens — to the network', async () => {
    const res = await req(sp, '/access.json?limit=200');
    assert.equal(res.status, 403);
    assert.ok(!/\/api\/webhook\//.test(res.body), 'a webhook id must never appear in a refusal');
    assert.ok(!/\/api\/hls\//.test(res.body), 'nor a stream token');
  });

  // stats.json stays public on purpose: a `rest:` sensor polls it from HA core, not via Ingress.
  // Gating it wholesale would take that health sensor down — which this add-on already did once
  // by moving its port. So the aggregates stay and the identities go.
  it('keeps stats.json readable but strips who is connected', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    c.send({ type: 'subscribe_entities' });
    // So the translations diagnostic has something to report.
    await c.rpc({ type: 'frontend/get_translations', language: 'en', category: 'entity_component' });
    await new Promise((r) => setTimeout(r, 250));
    try {
      const lan = await req(sp, '/stats.json');
      assert.equal(lan.status, 200, 'a health check must still be able to poll this');
      const d = JSON.parse(lan.body);

      // What a health check needs.
      assert.equal(typeof d.allowlist.ready, 'boolean');
      assert.ok(d.allowlist.union > 0);
      assert.ok(d.savings, 'aggregates are kept');
      assert.equal(d.redacted, true, 'and it says it is not the whole picture');

      // What it does not.
      assert.deepEqual(d.clients.list, [], 'no per-client rows');
      assert.deepEqual(d.clients.recent, [], 'nor the 24h history of them');
      assert.ok(typeof d.clients.open === 'number', 'a count is fine, and useful');
      assert.deepEqual(d.mdns.devices, [], 'no discovered device names or addresses');
      assert.ok(!('routeNames' in d), 'no resolved internal hostnames');
      assert.ok(!('paths' in d),
        'the routing breakdown names the hostname each client arrived on, and is keyed by it');

      // Belt and braces, and how the `paths` miss was actually found: scan the WHOLE payload for
      // anything shaped like an address or a hostname, rather than trusting a list of field names
      // to stay complete as the snapshot grows.
      const raw = lan.body;
      assert.ok(!/\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(raw),
        'no private address anywhere in the public payload');
      // Resource URLs are configuration and are deliberately kept, and some are public CDNs
      // (fonts.googleapis.com), so they are excluded rather than allowed to raise a false alarm
      // that trains people to ignore this check. Everything else that looks like a host is a leak.
      const withoutResourceUrls = raw.replace(/"https?:\/\/[^"]*"/g, '""');
      assert.ok(!/\b[a-z0-9-]+\.(?:local|lan|internal)\b/i.test(withoutResourceUrls),
        'no internal hostname anywhere in the public payload');
      // Dashboard names and installed-card paths are deliberately KEPT: they are configuration,
      // not identity — no person, machine or credential is named by them, and anyone who can load
      // a dashboard already sees both. Redacting them cost the health sensor detail and bought
      // nothing, so the line is drawn at identity rather than at "anything descriptive".
      assert.ok(d.allowlist.byDashboard, 'configuration aggregates are kept');
      // The translations breakdown is keyed by integration name — an inventory of what is
      // installed. The counts stay; the keys do not.
      assert.ok(d.translations && typeof d.translations.keys === 'number', 'the size stays');
      assert.ok(!('byPrefix' in d.translations), 'the per-integration keys do not');

      // And through Ingress the console still sees everything.
      const ing = JSON.parse((await req(sp, '/stats.json', { headers: ING })).body);
      assert.ok(ing.clients.list.length >= 1, 'the console still gets the detail');
      assert.ok(ing.translations.byPrefix['component.tuya_local'], 'including the breakdown');
      assert.ok(!ing.redacted);
    } finally { c.close(); }
  });
});

describe('the client status endpoint', () => {
  let mock, proxy, port, sp, out = '';

  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    sp = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 25000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('refuses a request with no token', async () => {
    const res = await req(port, '/strimmer/client.json');
    assert.equal(res.status, 401);
    assert.match(res.headers['www-authenticate'] || '', /Bearer/);
    // It must not leak the answer in the refusal.
    assert.ok(!/trimming/.test(res.body), 'a refusal must not carry the payload');
  });

  it('refuses a token Home Assistant does not accept', async () => {
    const res = await req(port, '/strimmer/client.json', { headers: { authorization: 'Bearer invalid-token' } });
    assert.equal(res.status, 401);
    assert.ok(!/trimming/.test(res.body));
  });

  it('answers a caller holding a valid token', async () => {
    const res = await req(port, '/strimmer/client.json', { headers: { authorization: 'Bearer david-token' } });
    assert.equal(res.status, 200, `expected an answer, got ${res.status}: ${res.body}`);
    const d = JSON.parse(res.body);
    assert.equal(d.strimmer.running, true);
    assert.equal(typeof d.trimming.entities, 'boolean');
  });

  // An Authorization header makes this a non-simple cross-origin request, so a panel admin page
  // on its own origin preflights and never sends the real request if nobody answers.
  it('answers the CORS preflight the Authorization header forces', async () => {
    const res = await req(port, '/strimmer/client.json', { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.match(res.headers['access-control-allow-headers'] || '', /authorization/i,
      'without this a browser will not send the token at all');
    assert.match(res.headers['access-control-allow-methods'] || '', /GET/);
  });
});

// Where a request came from, checked before who it is.
//
// Almost every caller is a wall panel a few metres away. Refusing a remote one early means a
// caller from the internet cannot make this add-on open a websocket to Home Assistant to validate
// a token — it never gets that far. That ordering is the entire point, so it is asserted directly
// rather than inferred from a status code.
//
// What this is worth, and what it is not: the Cloudflare headers and the peer address cannot be
// forged, and those carry the check. The resolved client address comes from X-Forwarded-For,
// whose leftmost entry is supplied by the caller — so a remote caller behind a proxy that appends
// can still look local. This narrows who may TRY. The token is still the boundary.
describe('the panel status API access list', () => {
  const spawnWith = async (env) => {
    const mock = await startMockHa();
    const port = await getFreePort();
    const sp = await getFreePort();
    const proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(sp), STRIP_ENTITIES: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 25000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    return { mock, proxy, port, log: () => out };
  };

  it('refuses a Cloudflare request before it ever looks at the token', async () => {
    const t = await spawnWith({});
    try {
      // cf-ray is stamped by Cloudflare's edge and a client cannot remove it, which is what makes
      // this the trustworthy half of the check.
      const res = await req(t.port, '/strimmer/client.json', {
        headers: { 'cf-ray': '8abc-DFW', authorization: 'Bearer david-token' },
      });
      assert.equal(res.status, 403, 'a Cloudflare request must be refused');
      assert.match(res.body, /Cloudflare/i, 'and told why');
      // 403, never 404: a panel reads 404 as "the trimmer is not in front of me", and a blocked
      // local panel being told that would be the opposite of the truth.
      assert.notEqual(res.status, 404);
      // The valid token above must NOT have been spent. Asked of the MOCK, which counts the RPCs
      // it actually received — an earlier version of this grepped the proxy's own log for
      // `auth/current_user`, which the proxy never writes, so it passed against code that
      // validated the token first. A test of ordering has to observe the thing being ordered.
      //
      // And it has to WAIT: the lookup is asynchronous, so reading the count the instant the 403
      // arrives finds zero whether or not one was started. The pause is what gives a wrongly
      // ordered implementation time to betray itself.
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(t.mock.rpcCount('auth/current_user'), 0,
        'the network check must run before the token is validated');
    } finally { t.proxy.kill(); await t.mock.close(); }
  });

  it('refuses a caller whose own address is public', async () => {
    const t = await spawnWith({});
    try {
      // The peer here is loopback, so this stands in for the forwarded case: a proxy that says
      // the original caller was public.
      const res = await req(t.port, '/strimmer/client.json', {
        headers: { 'x-forwarded-for': '203.0.113.7', authorization: 'Bearer david-token' },
      });
      assert.equal(res.status, 403);
      assert.match(res.body, /local network/i);
    } finally { t.proxy.kill(); await t.mock.close(); }
  });

  it('still answers a local caller with a token', async () => {
    const t = await spawnWith({});
    try {
      const res = await req(t.port, '/strimmer/client.json', {
        headers: { authorization: 'Bearer david-token' },
      });
      assert.equal(res.status, 200, `a local panel must still work, got ${res.body}`);
    } finally { t.proxy.kill(); await t.mock.close(); }
  });

  it('honours an explicit allow entry over the heuristics', async () => {
    const t = await spawnWith({ CLIENT_API_ALLOW: '203.0.113.7' });
    try {
      const res = await req(t.port, '/strimmer/client.json', {
        headers: { 'x-forwarded-for': '203.0.113.7', authorization: 'Bearer david-token' },
      });
      assert.equal(res.status, 200, 'an address someone listed on purpose is allowed');
    } finally { t.proxy.kill(); await t.mock.close(); }
  });

  it('can be switched off entirely, and then answers nobody', async () => {
    const t = await spawnWith({ CLIENT_API_ACCESS: 'off' });
    try {
      const res = await req(t.port, '/strimmer/client.json', {
        headers: { authorization: 'Bearer david-token' },
      });
      assert.equal(res.status, 403);
      assert.match(res.body, /disabled/i);
      assert.ok(!/trimming/.test(res.body), 'and carries none of the payload');
    } finally { t.proxy.kill(); await t.mock.close(); }
  });

  it('can be opened up, leaving the token as the only check', async () => {
    const t = await spawnWith({ CLIENT_API_ACCESS: 'any' });
    try {
      const open = await req(t.port, '/strimmer/client.json', {
        headers: { 'cf-ray': '8abc-DFW', authorization: 'Bearer david-token' },
      });
      assert.equal(open.status, 200, 'the network check is off');
      // But the token still is not.
      const noToken = await req(t.port, '/strimmer/client.json', { headers: { 'cf-ray': '8abc-DFW' } });
      assert.equal(noToken.status, 401, 'opening the network check must not open the endpoint');
    } finally { t.proxy.kill(); await t.mock.close(); }
  });
});

// One client must not be able to block every other panel. `ws` defaults a server to a 100MB
// maxPayload, and every text frame from a browser is JSON.parse'd on the shared event loop —
// and with permessage-deflate negotiated, a 100MB payload is ~109KB on the wire, so it is an
// amplification rather than an upload.
describe('an oversized browser frame cannot block the event loop', () => {
  let mock, proxy, port, out = '';
  before(async () => {
    mock = await startMockHa();
    port = await getFreePort();
    proxy = spawn(process.execPath, [PROXY], {
      cwd: path.join(DIR, '..'),
      env: { ...process.env, HA_BASE: mock.base, HA_TOKEN: 't', DASH_PATHS: 'test-dash',
        PORT: String(port), STATS_PORT: String(await getFreePort()), STRIP_ENTITIES: '1',
        BROWSER_MAX_PAYLOAD_BYTES: '65536' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proxy.stdout.on('data', (b) => out += b); proxy.stderr.on('data', (b) => out += b);
    const deadline = Date.now() + 25000;
    while (!/union allowlist for/.test(out)) {
      if (Date.now() > deadline) throw new Error(`no boot\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  after(async () => { proxy?.kill(); await mock?.close(); });

  it('drops the connection with 1009 instead of parsing it', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const closed = new Promise((r) => c.ws.on('close', (code) => r(code)));
    // Comfortably over the 64KB test limit. `ws` enforces maxPayload while INFLATING, so a
    // compressible payload is refused on its decompressed size — which is the whole point.
    c.ws.send(JSON.stringify({ id: 99, type: 'x', pad: 'x'.repeat(80000) }));
    assert.equal(await closed, 1009, 'ws must refuse the frame, not buffer and parse it');
  });

  it('and a normal-sized frame on a fresh connection still works', async () => {
    const c = haClient(`ws://127.0.0.1:${port}/api/websocket`);
    await c.authed;
    const res = await c.rpc({ type: 'get_states' });
    assert.ok(Array.isArray(res.result), 'the limit must not affect ordinary traffic');
    c.close();
  });
});
