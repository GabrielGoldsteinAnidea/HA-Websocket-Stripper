// A tiny fake Home Assistant: HTTP (for passthrough) + a /api/websocket endpoint that
// speaks enough of HA's ws protocol for the proxy (auth -> get_states / lovelace/config /
// subscribe_events / subscribe_entities), plus a plain echo ws on any other path (to test
// the /api/webrtc/ws passthrough). Used by proxy.test.mjs.
import http from 'node:http';
import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { STATES, DASH_TEST, DASH_AUTO, AREAS, DEVICES, ENTITY_REGISTRY, LABELS } from './fixtures.mjs';

export function getFreePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => res(p));
    });
    srv.on('error', rej);
  });
}

const DEFAULT_CONFIGS = { 'test-dash': DASH_TEST, 'auto-dash': DASH_AUTO };

const DEFAULT_REGISTRIES = {
  'config/area_registry/list': AREAS,
  'config/device_registry/list': DEVICES,
  'config/entity_registry/list': ENTITY_REGISTRY,
  'config/label_registry/list': LABELS,
};

// `port` pins the listen port so a test can take HA down and bring it back on the same
// address — i.e. simulate an HA restart under a running proxy.
export async function startMockHa({ configs = DEFAULT_CONFIGS, states = STATES, registries = DEFAULT_REGISTRIES, port: fixedPort } = {}) {
  const port = fixedPort ?? await getFreePort();
  configs = { ...configs };    // per-mock copy, so a setConfig() in one test can't leak into the next
  const state = {
    lastXFF: null,
    httpHits: [],
    conns: new Set(),          // { ws, eventSubs:Map<event_type,id>, entitySubIds:Set }
    lastSubscribeEntities: null,
    hangUpgrades: false,       // accept the TCP connection, never answer the upgrade
    rawUpgrades: new Set(),
    sockets: new Set(),        // EVERY accepted socket, so close() can't hang (see close())
  };

  const server = http.createServer((req, res) => {
    state.lastXFF = req.headers['x-forwarded-for'] ?? null;
    state.httpHits.push({ url: req.url, xff: state.lastXFF });
    res.setHeader('x-echo-xff', state.lastXFF ?? '');
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
      wss.handleUpgrade(req, socket, head, (ws) => haProtocol(ws));
    } else {
      // plain echo socket — stands in for /api/webrtc/ws camera signaling
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ type: 'echo_hello', path: req.url }));
        ws.on('message', (m) => ws.send(m.toString()));
      });
    }
  });

  function haProtocol(ws) {
    const conn = { ws, eventSubs: new Map(), entitySubIds: new Set() };
    state.conns.add(conn);
    ws.on('close', () => state.conns.delete(conn));
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.7.0' }));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'auth') { ws.send(JSON.stringify({ type: 'auth_ok', ha_version: '2026.7.0' })); return; }
      const ok = (result) => ws.send(JSON.stringify({ id: m.id, type: 'result', success: true, result }));
      if (m.type in registries) return ok(registries[m.type]);   // config/*_registry/list
      switch (m.type) {
        case 'get_states': return ok(states);
        case 'lovelace/config': {
          const cfg = configs[m.url_path];
          if (!cfg) return ws.send(JSON.stringify({ id: m.id, type: 'result', success: false, error: { code: 'not_found', message: m.url_path } }));
          return ok(cfg);
        }
        case 'lovelace/dashboards/list':
          return ok(Object.keys(configs).map((url_path) => ({ id: url_path, url_path, title: url_path })));
        case 'subscribe_events':
          conn.eventSubs.set(m.event_type, m.id);
          return ok(null);
        case 'subscribe_entities':
          state.lastSubscribeEntities = m.entity_ids ?? null;
          conn.entitySubIds.add(m.id);
          return ok(null);
        default: return ok(null);
      }
    });
  }

  await new Promise((res) => server.listen(port, '127.0.0.1', res));

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/websocket`,
    state,
    lastSubscribeEntities: () => state.lastSubscribeEntities,
    lastXFF: () => state.lastXFF,
    // Push an entity event on every active subscribe_entities subscription.
    pushEntityEvent(payload) {
      for (const c of state.conns) {
        for (const id of c.entitySubIds) {
          c.ws.send(JSON.stringify({ id, type: 'event', event: payload }));
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
export function haClient(url, token = 'test-token') {
  const ws = new WebSocket(url);
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
