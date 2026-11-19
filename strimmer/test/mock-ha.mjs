// A tiny fake Home Assistant: HTTP (for passthrough) + a /api/websocket endpoint that
// speaks enough of HA's ws protocol for the proxy (auth -> get_states / lovelace/config /
// subscribe_events / subscribe_entities), plus a plain echo ws on any other path (to test
// the /api/webrtc/ws passthrough). Used by proxy.test.mjs.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { STATES, DASH_TEST, DASH_AUTO, AREAS, DEVICES, ENTITY_REGISTRY, ENTITY_REGISTRY_DISPLAY, LABELS } from './fixtures.mjs';

// Ports for the tests' proxies and mocks, unique across every test PROCESS, not just this one.
//
// This used to ask the kernel for a free port (listen on 0), close the probe and hand the number
// out. Two collisions in CI showed why that is not enough. 2026-10-02: the same process got one
// number twice, for PORT and STATS_PORT. 2026-10-06: another test file's proxy, started with
// STATS_PORT=0, was given 40009 by the kernel between this file's probe and its bind. The kernel
// picks those from the EPHEMERAL range, the very range the probe drew from.
//
// So: allocate from 20000-32767, below the ephemeral range on Linux (32768+) and macOS (49152+),
// where nothing picks a port by itself; claim each number with an exclusive-create lock file
// shared by every test process; and bind the exact port (on all interfaces, as the proxy does)
// before handing it out. A lock older than ten minutes is from a run that died, and is taken.
const PORT_MIN = 20000, PORT_MAX = 32767;
const LOCK_DIR = path.join(os.tmpdir(), 'strimmer-test-ports');
const STALE_MS = 10 * 60 * 1000;
const claimed = [];
let next = PORT_MIN + Math.floor(Math.random() * (PORT_MAX - PORT_MIN));

fs.mkdirSync(LOCK_DIR, { recursive: true });
process.on('exit', () => { for (const f of claimed) { try { fs.rmSync(f); } catch {} } });

function claim(port) {
  const f = path.join(LOCK_DIR, String(port));
  try {
    fs.writeFileSync(f, String(process.pid), { flag: 'wx' });
  } catch {
    try {
      if (Date.now() - fs.statSync(f).mtimeMs < STALE_MS) return null;
      fs.rmSync(f);
      fs.writeFileSync(f, String(process.pid), { flag: 'wx' });
    } catch { return null; }
  }
  claimed.push(f);
  return f;
}

function bindable(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen(port, () => srv.close(() => res(true)));
  });
}

export async function getFreePort() {
  for (let tries = 0; tries < PORT_MAX - PORT_MIN; tries++) {
    const port = next;
    next = next >= PORT_MAX ? PORT_MIN : next + 1;
    const lock = claim(port);
    if (!lock) continue;
    if (await bindable(port)) return port;
    // Held by something outside the tests. Keep the lock, so nobody else tries it this run.
  }
  throw new Error(`no free test port in ${PORT_MIN}-${PORT_MAX}`);
}

// token -> the user HA would report for it.
const DEFAULT_USERS = {
  // `credentials` mirrors what auth/current_user really returns, so a rule matching the
  // sign-in method is exercised against the real shape rather than an invented one.
  'david-token': { id: 'u-david', name: 'David', is_admin: true,
    credentials: [{ type: 'homeassistant' }] },
  'kiosk-token': { id: 'u-kiosk', name: 'Kiosk', is_admin: false,
    credentials: [{ type: 'trusted_networks' }] },
  'michelle-token': { id: 'u-michelle', name: 'Michelle', is_admin: false,
    credentials: [{ type: 'homeassistant' }] },
  default: { id: 'u-default', name: 'Default', is_admin: false },
};

const DEFAULT_CONFIGS = { 'test-dash': DASH_TEST, 'auto-dash': DASH_AUTO };
// render_template bodies, keyed by the template source the config asks for.
const DEFAULT_TEMPLATES = { PV_TEMPLATE: "[{'entity': 'sensor.pv_roof_power'}, {'entity': 'sensor.pv_shed_power'}]" };

// The mock's HTTP handler answers 'MOCK_HA_BODY <url>', so a resource whose URL contains a
// card type behaves like a bundle that defines it — which is what the content match tests.
const DEFAULT_RESOURCES = [
  { id: 'r1', type: 'module', url: '/res/my-fancy-card.js' },
  { id: 'r2', type: 'module', url: '/res/unrelated-widget.js' },
  { id: 'r3', type: 'module', url: '/res/global-patcher.js' },
  // Body contains the bare letters "cbi" but never "cbi:" — the shape that made a
  // 3-character icon namespace keep megabytes of unrelated bundles.
  { id: 'r4', type: 'module', url: '/res/cbi-lookalike.js' },
  // Body contains a real "cbi:" icon reference.
  { id: 'r5', type: 'module', url: '/res/icon-pack.js' },
  // A provider: registers the namespace as a key and never writes the colon form.
  { id: 'r7', type: 'module', url: '/res/provider.js' },
  // Never contains the literal element name, only its fragments — a bundle that builds
  // `ha-bambulab-print_status-card` at runtime.
  { id: 'r6', type: 'module', url: '/res/bambulab-print_status-cards.js' },
];

// Bodies for resources whose content matters. An icon PACK registers its namespace as a
// key and never writes `cbi:` anywhere, so matching only the colon form would drop it.
const DEFAULT_RESOURCE_BODIES = {
  '/res/provider.js': 'window.customIconsets["cbi"]={getIcon:n=>n};',
  '/res/icon-pack.js': 'const sample="cbi:bulb";',
  // Mirrors how Mushroom really ships: element names are built from template literals, so the
  // string "mushroom-cover-card" appears NOWHERE in the bundle, and the only usable clue is
  // the near-unique word "mushroom". The generic halves ("cover", "card") are absent too.
  '/res/mushroom.js': 'const P="mushroom";for(const t of TYPES)customElements.define(`${P}-${t}-card`,C);',
};

const DEFAULT_REGISTRIES = {
  'config/area_registry/list': AREAS,
  'config/device_registry/list': DEVICES,
  'config/entity_registry/list': ENTITY_REGISTRY,
  'config/entity_registry/list_for_display': ENTITY_REGISTRY_DISPLAY,
  'config/label_registry/list': LABELS,
};

// `port` pins the listen port so a test can take HA down and bring it back on the same
// address — i.e. simulate an HA restart under a running proxy.
export async function startMockHa({ users = DEFAULT_USERS, configs = DEFAULT_CONFIGS, states = STATES, registries = DEFAULT_REGISTRIES, templates = DEFAULT_TEMPLATES, resources = DEFAULT_RESOURCES, resourceBodies = DEFAULT_RESOURCE_BODIES, extraModules = null, port: fixedPort } = {}) {
  const port = fixedPort ?? await getFreePort();
  configs = { ...configs };    // per-mock copy, so a setConfig() in one test can't leak into the next
  const state = {
    lastXFF: null,
    httpHits: [],
    conns: new Set(),          // { ws, eventSubs:Map<event_type,id>, entitySubIds:Set }
    lastSubscribeEntities: null,
    // Monotonic count of subscribe_entities received. `lastSubscribeEntities` alone cannot
    // tell "the proxy has not answered yet" from "it answered with the same set as last
    // time", so a test that sleeps and reads it races: under load it reads the PREVIOUS
    // test's set and asserts against the wrong connection. Waiting for this to advance is
    // the deterministic signal that a new subscription actually arrived.
    subscribeEntitiesSeq: 0,
    currentUserDelayMs: 0,       // see auth/current_user below
    rpcCounts: new Map(),       // message type -> how many times the proxy asked HA
    renderedTemplates: [],       // template sources the proxy asked HA to render
    unsubscribed: [],            // subscription ids the proxy released
    hangTemplates: false,        // accept render_template, never push the event
    hangHttp: false,           // accept the HTTP request, never answer it — a STALLED upstream,
                               // which is different from a dead one and is the case nothing
                               // used to bound
    hangUpgrades: false,       // accept the TCP connection, never answer the upgrade
    hangTypes: new Set(),      // message types to accept and never answer — a wedged command,
                               // on an otherwise healthy socket, which is what a timeout is for
    wsUpgradeHeaders: [],      // headers of every /api/websocket upgrade accepted, in order. The
                               // proxy opens TWO per browser — the bridge, then an identity probe —
                               // so a test wanting the bridge's takes the first after its marker.
    rawUpgrades: new Set(),
    sockets: new Set(),        // EVERY accepted socket, so close() can't hang (see close())
    mainSockets: [],           // client sockets, oldest first — see sendRaw below
  };

  const server = http.createServer((req, res) => {
    // Deliberately never responds and never closes: the connection stays open and silent, so
    // the proxy sees no error at all. That is what makes it a hang rather than a failure.
    if (state.hangHttp) return;
    state.lastXFF = req.headers['x-forwarded-for'] ?? null;
    state.httpHits.push({ url: req.url, xff: state.lastXFF });
    res.setHeader('x-echo-xff', state.lastXFF ?? '');
    // Echoed so a test can assert the invariant Home Assistant actually enforces: the
    // X-Forwarded-For and X-Forwarded-Proto chains must agree in length (or proto must be a
    // single value). A mismatch is what makes HA answer 400.
    res.setHeader('x-echo-xfproto', req.headers['x-forwarded-proto'] ?? '');
    // A resource with an explicit body, for tests that need real content rather than the
    // echoed URL — quotes and colons do not survive a round trip through a URL.
    const path = req.url.split('?')[0];
    if (Object.prototype.hasOwnProperty.call(resourceBodies, path)) {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end(resourceBodies[path]);
    }
    // A dashboard page, shaped like Home Assistant's: each injected module is one
    // import(...).catch(...) block. Tests that exercise trim_extra_modules need the real shape,
    // because that shape is exactly what the rewrite matches on.
    if (extraModules && /text\/html/i.test(String(req.headers.accept || ''))) {
      const blocks = extraModules.map((u) => `        import(${JSON.stringify(u)}).catch(function (err) {\n`
        + `          console.error("Failed to load extra module ${u}", err);\n        });`).join('\n');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!DOCTYPE html><html><head><script type="module">\n${blocks}\n</script></head><body></body></html>`);
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('MOCK_HA_BODY ' + req.url);
  });

  server.on('connection', (s) => { state.sockets.add(s); s.on('close', () => state.sockets.delete(s)); });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (state.hangUpgrades) {
      // Hold the upgrade open without answering — keeps the PROXY's client-side socket in
      // the pre-101 window, which is where an unhandled socket error used to kill it.
      state.rawUpgrades.add(socket);
      socket.on('close', () => state.rawUpgrades.delete(socket));
      return;
    }
    if (req.url.startsWith('/api/websocket')) {
      state.wsUpgradeHeaders.push({ ...req.headers });
      wss.handleUpgrade(req, socket, head, (ws) => haProtocol(ws));
    } else {
      // plain echo socket — stands in for /api/webrtc/ws camera signaling
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: 'echo_hello', path: req.url }));
        ws.on('message', (m) => ws.send(m.toString()));
      });
    }
  });

  // The newest socket that is a real client rather than an identity probe.
  const lastMain = () => state.mainSockets[state.mainSockets.length - 1] ?? state.lastSocket;

  function haProtocol(ws) {
    const conn = { ws, eventSubs: new Map(), entitySubIds: new Set() };
    state.conns.add(conn);
    state.lastSocket = ws;      // so a test can push a raw binary frame at the proxy
    state.mainSockets.push(ws);
    ws.on('close', () => {
      state.conns.delete(conn);
      const i = state.mainSockets.indexOf(ws);
      if (i >= 0) state.mainSockets.splice(i, 1);
    });
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.7.0' }));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'auth') {
        // One token is always rejected, so a test can exercise the path where Home Assistant
        // says no. Without it this mock accepts anything, and a test asserting that a bad token
        // is refused passes for the wrong reason — the mock handed back a user, so the code under
        // test never had a refusal to make.
        if (m.access_token === 'invalid-token') {
          ws.send(JSON.stringify({ type: 'auth_invalid', message: 'Invalid access token' }));
          return;
        }
        // Remember which token authenticated, so auth/current_user can answer per-token the
        // way HA does — that is the whole mechanism the per-user rules rely on.
        conn.token = m.access_token;
        ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.7.0' }));
        return;
      }
      if (m.type) state.rpcCounts.set(m.type, (state.rpcCounts.get(m.type) || 0) + 1);
      if (state.hangTypes.has(m.type)) return;          // counted, then never answered
      const ok = (result) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result }));
      // config/auth/list answers in Home Assistant's real shape: no is_admin field, the role is
      // the `system-admin` group. Built from the same table auth/current_user reads, so a test
      // user's role cannot differ between the two.
      if (m.type === 'config/auth/list') {
        const seen = new Map();
        for (const u of Object.values(users)) {
          if (u?.id && !seen.has(u.id)) {
            seen.set(u.id, { id: u.id, name: u.name, is_owner: false, is_active: true,
              group_ids: [u.is_admin ? 'system-admin' : 'system-users'], credentials: u.credentials ?? [] });
          }
        }
        return ok([...seen.values()]);
      }
      if (m.type === 'auth/current_user') {
        // This socket is an identity probe, not a browser connection — the proxy opens it purely
        // to ask who a token belongs to and closes it again. Take it out of the push list so a
        // raw frame meant for the browser is not delivered to a socket nobody is reading.
        const probeIdx = state.mainSockets.indexOf(ws);
        if (probeIdx >= 0) state.mainSockets.splice(probeIdx, 1);
        // Optionally answer slowly. The proxy holds a connection's messages until the user is
        // known, so how long this takes decides whether the frontend's first
        // subscribe_entities is queued or sails straight through — the race that made
        // per-user rules apply intermittently. A test needs to be able to lose it on purpose.
        const answer = () => ok(users[conn.token] ?? users.default ?? null);
        if (state.currentUserDelayMs > 0) { setTimeout(answer, state.currentUserDelayMs); return; }
        return answer();
      }
      if (m.type in registries) return ok(registries[m.type]);   // config/*_registry/list
      switch (m.type) {
        case 'get_states': return ok(states);
        // The admin Repairs backlog. Two issues is enough to tell "emptied" from "untouched".
        // Shaped like the real thing: every key `component.<x>.…`, mixing entity DOMAINS with
        // INTEGRATIONS, because the distinction is the whole difficulty of trimming it.
        // Four themes; the fixture dashboard names one, and HA reports one as default.
        case 'frontend/get_themes': return ok({
          default_theme: 'Mushroom', default_dark_theme: null,
          themes: { Mushroom: { 'primary-color': '#111' }, Frosted: { 'primary-color': '#222' },
                    minimalist: { 'primary-color': '#333' }, iCloud3: { 'primary-color': '#444' } },
        });
        case 'frontend/get_translations': return ok({ resources: {
          'component.light.entity_component._.state.on': 'On',
          'component.sensor.entity_component._.state.unknown': 'Unknown',
          // the integration that PROVIDES light.living_room in the fixtures
          'component.hue.entity.light.x.state.on': 'Lit',
          // integrations no fixture dashboard can see
          'component.tuya_local.entity.sensor.y.state.z': 'Tuya',
          'component.roborock.entity.vacuum.v.state.w': 'Roborock',
          // not component-shaped: must survive whatever else happens
          'ui.panel.lovelace.editor.save': 'Save',
        } });
        case 'repairs/list_issues': return ok({ issues: [
          { issue_id: 'i1', domain: 'hassio', severity: 'warning', ignored: false },
          { issue_id: 'i2', domain: 'cloud', severity: 'error', ignored: false },
        ] });
        case 'get_services': return ok({
          light: { turn_on: {} }, sensor: { x: {} }, camera: { snapshot: {} },
          switch: { turn_on: {} }, binary_sensor: { y: {} },
          homeassistant: { restart: {} },            // generic services, must always survive
          vacuum: { start: {} }, lawn_mower: { mow: {} },   // no entity on any dashboard
        });
        case 'lovelace/resources': return ok(resources);
        case 'lovelace/config': {
          const cfg = configs[m.url_path];
          if (!cfg) return ws.send(JSON.stringify({ id: m.id, type: 'result', success: false, error: { code: 'not_found', message: m.url_path } }));
          return ok(cfg);
        }
        case 'lovelace/dashboards/list':
          return ok(Object.keys(configs).map((url_path) => ({ id: url_path, url_path, title: url_path })));
        // Like real HA: `result: null`, then events carrying the COMMAND's id.
        case 'lovelace/resources/subscribe':
          conn.resSubId = m.id;
          return ok(null);
        case 'subscribe_events':
          conn.eventSubs.set(m.event_type, m.id);
          return ok(null);
        case 'subscribe_entities':
          state.lastSubscribeEntities = m.entity_ids ?? null;
          state.subscribeEntitiesSeq += 1;
          conn.entitySubIds.add(m.id);
          return ok(null);
        // Real HA answers render_template with an empty `result`, THEN pushes the rendered
        // text as an event on the same id (it's a subscription, re-firing on every change).
        // The proxy must take that first event and unsubscribe.
        case 'render_template': {
          state.renderedTemplates.push(m.template);
          const body = templates[m.template];
          if (body === undefined) {
            return ws.send(JSON.stringify({ id: m.id, type: 'result', success: false, error: { code: 'template_error', message: `unknown template: ${m.template}` } }));
          }
          ok(null);
          if (state.hangTemplates) return;             // never answers — exercises the timeout
          return setTimeout(() => { try { ws.send(JSON.stringify({ id: m.id, type: 'event', event: { result: body, listeners: {} } })); } catch {} }, 5);
        }
        case 'unsubscribe_events':
          state.unsubscribed.push(m.subscription);
          return ok(null);
        default: return ok(null);
      }
    });
  }

  await new Promise((res) => server.listen(port, '127.0.0.1', res));

  return {
    // Push a raw binary frame at the most recent client, mimicking HA's media frames.
    // Push a raw text frame (used to emit a BATCHED array, which HA really does send).
    // Push at the newest socket that is a real CLIENT connection.
    //
    // `lastSocket` alone was only ever accidentally right: it assumed the proxy opens exactly one
    // socket to HA per browser, which stopped being true once the proxy began resolving a user's
    // identity on a second, short-lived connection. That probe would arrive last and quietly
    // become the push target, so a frame meant for the browser went somewhere else — which reads
    // exactly like the proxy dropping an allowed entity. An identity probe identifies itself by
    // asking `auth/current_user` and nothing else, so it is removed from the list below.
    sendRaw: (str) => { try { lastMain()?.send(str); } catch {} },
    sendBinaryToLastClient: (buf) => { try { lastMain()?.send(buf, { binary: true }); } catch {} },
    rpcCount: (type) => state.rpcCounts.get(type) || 0,
    mainSocketCount: () => state.mainSockets.length,
    port,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/websocket`,
    state,
    lastSubscribeEntities: () => state.lastSubscribeEntities,
    subscribeEntitiesSeq: () => state.subscribeEntitiesSeq,
    // Resolve once a subscribe_entities arrives after `seq`. Callers snapshot the sequence
    // BEFORE opening their socket, so no subscription can slip through between the two.
    // Same reasoning as waitForLog in the proxy test files: parallel spawns, not a budget.
    async waitForSubscribeEntities(seq, ms = 25000) {
      const deadline = Date.now() + ms;
      while (state.subscribeEntitiesSeq <= seq) {
        if (Date.now() > deadline) {
          throw new Error(`timeout waiting for subscribe_entities past seq ${seq}`);
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      return state.lastSubscribeEntities;
    },
    lastXFF: () => state.lastXFF,
    renderedTemplates: () => state.renderedTemplates,
    unsubscribed: () => state.unsubscribed,
    setHangTemplates(v) { state.hangTemplates = v; },
    setHangHttp(v) { state.hangHttp = v; },
    // Rewrite a resource's URL in place, the way a HACS update does: same path, same id, new
    // cache-busting query string. Deliberately does NOT notify anyone — the whole point of the
    // bug it reproduces is that the proxy is not told.
    bumpResourceQuery(pathFragment, qs) {
      for (const r of resources) {
        if (r.url.includes(pathFragment)) r.url = r.url.split('?')[0] + qs;
      }
    },
    // Change a resource's URL and, unless `notify` is false, send the collection's `updated` event.
    updateResourceUrl(id, url, notify = true) {
      const r = resources.find((x) => x.id === id);
      r.url = url;
      if (!notify) return;
      for (const c of state.conns) {
        if (c.resSubId != null) c.ws.send(JSON.stringify({ id: c.resSubId, type: 'event', event: [{ change_type: 'updated', item_id: id, item: r }] }));
      }
    },
    setCurrentUserDelay(ms) { state.currentUserDelayMs = ms; },
    // Push an entity event on every active subscribe_entities subscription.
    pushEntityEvent(payload) {
      for (const c of state.conns) {
        for (const id of c.entitySubIds) {
          c.ws.send(JSON.stringify({ id, type: 'event', event: payload }));
        }
      }
    },
    // Push the initial `a` block BATCHED into an array alongside unrelated messages, which is
    // what HA actually does. The proxy must size the `a` block, not the frame — measuring the
    // frame is how a 149-entity dashboard reported a 246KB "payload" on one client and 1.5KB
    // on another.
    pushEntityEventBatched(payload, ...alongside) {
      for (const c of state.conns) {
        for (const id of c.entitySubIds) {
          c.ws.send(JSON.stringify([{ id, type: 'event', event: payload }, ...alongside]));
        }
      }
    },
    // Fire an HA event on every connection subscribed to it.
    fireEvent(event_type, data = {}) {
      for (const c of state.conns) {
        const id = c.eventSubs.get(event_type);
        if (id != null) c.ws.send(JSON.stringify({ id, type: 'event', event: { event_type, data } }));
      }
    },
    fireLovelaceUpdated(url_path) { this.fireEvent('lovelace_updated', { url_path }); },
    setConfig(url_path, cfg) { configs[url_path] = cfg; },
    setHangUpgrades(v) { state.hangUpgrades = v; },
    // Go away the way a real restart does: stop accepting AND drop every open socket, so the
    // proxy sees resets rather than a graceful shutdown.
    // Destroy from state.sockets, not just the ws/upgrade bookkeeping: server.close() waits
    // for EVERY accepted connection, including ones no other set tracks (keep-alive HTTP
    // sockets, the echo ws used for the passthrough test, an upgrade left hanging). Missing
    // one makes close() hang forever instead of failing, which is a very expensive way to
    // find out about it.
    close() {
      for (const c of state.conns) { try { c.ws.terminate(); } catch {} }
      for (const s of state.rawUpgrades) { try { s.destroy(); } catch {} }
      for (const s of state.sockets) { try { s.destroy(); } catch {} }
      return new Promise((res) => server.close(res));
    },
  };
}

// Minimal browser-side ws client that performs the HA auth handshake, then lets tests
// send commands and await specific replies.
export function haClient(url, token = 'test-token', headers = undefined) {
  // `headers` lets a test send a Cookie, which is how per-browser dashboard attribution
  // is exercised without needing two source IPs.
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  let nextId = 1;
  const waiters = [];
  const authed = new Promise((resolve, reject) => {
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      if (m.type === 'auth_ok') return resolve();
      if (m.type === 'auth_invalid') return reject(new Error('auth_invalid'));
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].match(m)) { waiters[i].resolve(m); waiters.splice(i, 1); }
      }
    });
    ws.on('error', reject);
  });
  const waitFor = (match, ms = 3000) => new Promise((resolve, reject) => {
    const w = { match, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting for message')); } }, ms);
  });
  return {
    ws, authed,
    send(obj) { const id = nextId++; ws.send(JSON.stringify({ id, ...obj })); return id; },
    waitFor,
    async rpc(obj) { const id = nextId++; const p = waitFor((m) => m.id === id); ws.send(JSON.stringify({ id, ...obj })); return p; },
    close() { try { ws.close(); } catch {} },
  };
}
