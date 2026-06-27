#!/usr/bin/env node
// ha_ws_trim_proxy.mjs — reverse proxy that serves the REAL Home Assistant frontend
// but trims the entity firehose so a kiosk dashboard loads fast with full fidelity.
//
// It proxies all HTTP straight through to HA (frontend bundles, auth, registries,
// lovelace config, custom-card resources — untouched). All websocket upgrades also pass
// through EXCEPT /api/websocket, which is the only connection it intercepts:
//   * subscribe_entities (no filter)  -> inject entity_ids = the dashboards' allowlist,
//                                         so HA streams only those entities.
//   * get_states result               -> filtered to the allowlist.
// Everything else (auth handshake, registries, config, events) passes through, so the
// real frontend renders your real cards — just without the all-entities firehose.
//
// The allowlist is computed at startup from each dashboard's lovelace/config (walked by
// ./lovelace_extract.mjs), unioned across all configured dashboards, then rebuilt live
// whenever HA fires `lovelace_updated` (a dashboard was edited) — no restart needed.
//
// Runs in two modes (auto-detected):
//   * HA add-on  — reads /data/options.json, uses SUPERVISOR_TOKEN via the supervisor
//                  proxy for the allowlist precompute, proxies to http://homeassistant:8123.
//   * dev/CLI    — reads env vars, uses HA_TOKEN against HA_BASE directly.
//
// Env (dev): HA_TOKEN, HA_BASE (default http://homeassistant.mgmt:8123), PORT (8099),
//   DASH_PATHS (comma/newline list), ALWAYS_FORWARD, NEVER_FORWARD (literals or /regex/),
//   STRIP_ENTITIES (default 1; 0 = passthrough for A/B compare),
//   ALLOW_WS_URL / ALLOW_TOKEN (override the allowlist-precompute connection).

import http from 'node:http';
import fs from 'node:fs';
import httpProxy from 'http-proxy';
import { WebSocketServer, WebSocket } from 'ws';
import { extractEntities } from './lovelace_extract.mjs';

// ---- config (add-on options.json or env) ----
function loadOptions() {
  try { if (fs.existsSync('/data/options.json')) return JSON.parse(fs.readFileSync('/data/options.json', 'utf8')); }
  catch (e) { console.error('could not read /data/options.json:', e.message); }
  return {};
}
const OPT = loadOptions();
const inAddon = !!process.env.SUPERVISOR_TOKEN;
// Bump together with config.yaml `version`. Logged at boot so the add-on log shows exactly
// which code is running — the only reliable way to tell a Rebuild actually picked up changes
// (a local add-on bakes in whatever files are in the host's /addons folder, not GitHub).
const VERSION = '0.0.4';

const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

const HA_BASE = process.env.HA_BASE || OPT.ha_base || (inAddon ? 'http://homeassistant:8123' : 'http://homeassistant.mgmt:8123');
const HA_WS = HA_BASE.replace(/^http/, 'ws') + '/api/websocket';     // browser ws relay target
const PORT = parseInt(process.env.PORT || '8099', 10);
const DASH_PATHS = toList(OPT.dashboards ?? (process.env.DASH_PATHS || process.env.DASH_PATH));
// strip_entities: true (default) = inject the allowlist so HA streams only needed entities.
//   false = pass the websocket straight through (full firehose) for A/B comparison.
const STRIP = OPT.strip_entities !== undefined ? !!OPT.strip_entities
  : (process.env.STRIP_ENTITIES ?? process.env.TRIM) !== '0';

// allowlist-precompute connection (add-on: supervisor proxy + SUPERVISOR_TOKEN)
const ALLOW_WS_URL = process.env.ALLOW_WS_URL || OPT.allow_ws_url || (inAddon ? 'ws://supervisor/core/websocket' : HA_WS);
const ALLOW_TOKEN = process.env.ALLOW_TOKEN || process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN;

// allow/deny overrides — each entry is a literal entity_id or a /regex/ (optional flags).
function parseRules(v) {
  return toList(v).map((tok) => {
    const m = tok.match(/^\/(.*)\/([a-z]*)$/);
    return m ? { re: new RegExp(m[1], m[2] || undefined) } : { literal: tok };
  });
}
const ALWAYS = parseRules(OPT.always_forward ?? process.env.ALWAYS_FORWARD);
const NEVER = parseRules(OPT.never_forward ?? process.env.NEVER_FORWARD);
const matchesAny = (rules, id) => rules.some((r) => (r.re ? r.re.test(id) : r.literal === id));

if (!ALLOW_TOKEN || !DASH_PATHS.length) {
  console.error('ERROR: need a token (SUPERVISOR_TOKEN / HA_TOKEN / ALLOW_TOKEN) and at least one dashboard.');
  process.exit(1);
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

let ALLOW = new Set();

// Allowlist for one dashboard = entities used across ALL its views. Two passes unioned:
//  1) structured walk (explicit cards + auto-entities filter expansion)
//  2) every REAL entity id appearing anywhere in the config text (catches ids inside
//     button-card / mushroom-template / decluttering templates the walker can't parse).
// Over-including is harmless (still tiny vs the instance); under-including breaks cards.
function allowlistFor(cfg, states) {
  const real = new Set(states.map((s) => s.entity_id));
  const out = new Set(extractEntities(cfg, states).entities);   // all views
  const text = JSON.stringify(cfg);
  const re = /[a-z_][a-z0-9_]*\.[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(text))) if (real.has(m[0])) out.add(m[0]);
  return out;
}

// Build the union allowlist over all configured dashboards using an authed rpc().
async function buildAllow(rpc) {
  const states = await rpc({ type: 'get_states' });
  const realIds = states.map((s) => s.entity_id);
  const union = new Set();
  for (const p of DASH_PATHS) {
    try {
      const cfg = await rpc({ type: 'lovelace/config', url_path: p });
      const set = allowlistFor(cfg, states);
      log(`  ${p}: ${set.size} entities`);
      set.forEach((e) => union.add(e));
    } catch (e) { log(`  ${p}: FAILED ${e.message}`); }
  }
  const baseN = union.size;
  ALWAYS.forEach((r) => {
    if (r.literal) union.add(r.literal);
    else realIds.forEach((eid) => { if (r.re.test(eid)) union.add(eid); });
  });
  const afterAlways = union.size;
  [...union].forEach((eid) => { if (matchesAny(NEVER, eid)) union.delete(eid); });
  log(`overrides: base ${baseN}, +always ${afterAlways - baseN}, -never ${afterAlways - union.size}`);
  return union;
}

// ---- persistent control connection: compute the allowlist + watch for dashboard edits ----
// One long-lived HA ws (the supervisor proxy in add-on mode). After auth it builds the
// allowlist once (resolving boot), then subscribes to `lovelace_updated` and rebuilds on
// every dashboard save — so card edits take effect without an add-on restart. Reconnects
// with backoff on drop so live updates keep working for the life of the add-on.
// Resolves with the first allowlist; rejects only if the very first connect/auth fails.
function startController() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let backoff = 1000;
    let recomputeTimer = null;

    const connect = () => {
      const ws = new WebSocket(ALLOW_WS_URL); let id = 1; const pending = {}; let gone = false;
      const rpc = (o) => { o.id = id++; return new Promise((res, rej) => { pending[o.id] = [res, rej]; ws.send(JSON.stringify(o)); }); };

      // Debounce bursts of edits (the editor can fire several saves) into one rebuild.
      const scheduleRecompute = (why) => {
        clearTimeout(recomputeTimer);
        recomputeTimer = setTimeout(async () => {
          try { ALLOW = await buildAllow(rpc); log(`allowlist recomputed (${why}): ${ALLOW.size} entities`); }
          catch (e) { log('recompute failed:', e.message); }
        }, 1500);
      };

      ws.on('message', async (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: ALLOW_TOKEN }));
        if (m.type === 'auth_invalid') { if (!settled) { settled = true; reject(new Error('auth_invalid')); } try { ws.close(); } catch {} return; }
        if (m.type === 'auth_ok') {
          try {
            backoff = 1000;
            ALLOW = await buildAllow(rpc);
            if (!settled) { settled = true; resolve(ALLOW); }
            else log(`allowlist recomputed (reconnect): ${ALLOW.size} entities`);
            await rpc({ type: 'subscribe_events', event_type: 'lovelace_updated' });
            log('watching lovelace_updated for live allowlist updates');
          } catch (e) { if (!settled) { settled = true; reject(e); } else log('post-auth setup failed:', e.message); }
          return;
        }
        if (m.type === 'event' && m.event?.event_type === 'lovelace_updated') {
          const p = m.event.data?.url_path ?? '(default)';
          log(`lovelace_updated: ${p}`);
          scheduleRecompute(p);
          return;
        }
        if (m.type === 'result' && pending[m.id]) { const p = pending[m.id]; m.success ? p[0](m.result) : p[1](new Error(JSON.stringify(m.error))); delete pending[m.id]; }
      });

      const onGone = (e) => {
        if (gone) return; gone = true;
        if (e) log('control ws error:', e.message);
        Object.values(pending).forEach(([, rej]) => rej(new Error('control ws closed')));
        if (!settled) { settled = true; reject(new Error('control ws closed before first allowlist')); return; }
        log(`control ws down; reconnecting in ${backoff}ms (serving last allowlist: ${ALLOW.size})`);
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30000);
      };
      ws.on('close', () => onGone());
      ws.on('error', (e) => onGone(e));
    };

    connect();
  });
}

// ---- HTTP passthrough to HA ----
// xfwd:true adds X-Forwarded-For/Proto/Host so HA's trusted_networks auth provider
// sees the real browser IP (needs http.use_x_forwarded_for + trusted_proxies on HA side).
const proxy = httpProxy.createProxyServer({ target: HA_BASE, changeOrigin: true, ws: false, autoRewrite: true, xfwd: true });
// Node reports dual-stack client IPs as IPv4-mapped IPv6 (e.g. ::ffff:192.168.5.247).
// HA's trusted_networks auth provider matches plain IPv4 subnets, and a mapped address
// won't match an IPv4 network — so normalize X-Forwarded-For to the bare IPv4 here, or
// trusted-network (password-less) kiosk login silently falls through to a password prompt.
proxy.on('proxyReq', (proxyReq, req) => {
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip) proxyReq.setHeader('x-forwarded-for', ip);
});
// Error arg is an http res for proxy.web() but a raw socket for proxy.ws() — handle both.
proxy.on('error', (e, req, res) => {
  log('proxy error', e.message);
  try {
    if (res && typeof res.writeHead === 'function') { res.writeHead(502); res.end('proxy error'); }
    else if (res && typeof res.destroy === 'function') res.destroy();   // ws upgrade socket
  } catch {}
});
const server = http.createServer((req, res) => proxy.web(req, res));

// ---- websocket upgrades ----
// We intercept ONLY /api/websocket (the entity firehose) to trim it. EVERY other ws
// upgrade passes straight through to HA — notably /api/webrtc/ws (go2rtc / WebRTC & MSE
// camera-stream signaling) and Assist-pipeline sockets. Destroying them (the old default
// branch) broke camera streams with ws close code 1006.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/api/websocket')) {
    wss.handleUpgrade(req, socket, head, (browserWs) => bridge(browserWs));
  } else {
    log(`ws upgrade passthrough -> HA: ${req.url}`);   // e.g. /api/webrtc/ws camera streams
    proxy.ws(req, socket, head);
  }
});

function bridge(browserWs) {
  const haWs = new WebSocket(HA_WS, { perMessageDeflate: true, maxPayload: 0 });
  const getStatesIds = new Set();
  const queue = []; let haOpen = false;
  const toHA = (s) => { if (haOpen) haWs.send(s); else queue.push(s); };

  haWs.on('open', () => { haOpen = true; queue.forEach((s) => haWs.send(s)); queue.length = 0; });

  browserWs.on('message', (raw) => {
    let s = raw.toString(); let m;
    try { m = JSON.parse(s); } catch { return toHA(s); }
    if (STRIP && m && m.type === 'get_states') getStatesIds.add(m.id);
    if (STRIP && m && m.type === 'subscribe_entities' && !m.entity_ids) {
      m.entity_ids = [...ALLOW];           // HA now streams only the allowlist
      s = JSON.stringify(m);
    }
    toHA(s);
  });

  haWs.on('message', (raw) => {
    let s = raw.toString(); let m;
    try { m = JSON.parse(s); } catch { return safeSend(s); }
    if (STRIP && m && m.type === 'result' && getStatesIds.has(m.id) && Array.isArray(m.result)) {
      const before = m.result.length;
      m.result = m.result.filter((e) => ALLOW.has(e.entity_id));
      getStatesIds.delete(m.id);
      s = JSON.stringify(m);
      log(`get_states trimmed ${before} -> ${m.result.length}`);
    }
    safeSend(s);
  });

  function safeSend(s) { try { if (browserWs.readyState === 1) browserWs.send(s); } catch {} }
  const close = () => { try { browserWs.close(); } catch {} try { haWs.close(); } catch {} };
  browserWs.on('close', close); browserWs.on('error', close);
  haWs.on('close', close); haWs.on('error', (e) => { log('HA ws error', e.message); close(); });
}

// ---- boot ----
log(`ha-ws-trim-proxy v${VERSION} starting`);
log(`mode: ${inAddon ? 'add-on' : 'dev'} | target ${HA_BASE} | allowlist via ${ALLOW_WS_URL}`);
startController().then((set) => {
  ALLOW = set;
  log(`union allowlist for [${DASH_PATHS.join(', ')}]: ${ALLOW.size} entities (strip_entities=${STRIP})`);
  server.listen(PORT, () => {
    log(`HA trim-proxy listening on :${PORT}  ->  ${HA_BASE}`);
    DASH_PATHS.forEach((p) => log(`  open: http://<host>:${PORT}/${p}`));
  });
}).catch((e) => { console.error('failed to compute allowlist:', e.message); process.exit(2); });
