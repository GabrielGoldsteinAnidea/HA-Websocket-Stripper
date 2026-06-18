#!/usr/bin/env node
// ha_ws_trim_proxy.mjs — reverse proxy that serves the REAL Home Assistant frontend
// but trims the entity firehose so a kiosk dashboard loads fast with full fidelity.
//
// It proxies all HTTP straight through to HA (frontend bundles, auth, registries,
// lovelace config, custom-card resources — untouched), and intercepts ONLY the
// /api/websocket connection:
//   * subscribe_entities (no filter)  -> inject entity_ids = the dashboards' allowlist,
//                                         so HA streams only those entities.
//   * get_states result               -> filtered to the allowlist.
// Everything else (auth handshake, registries, config, events) passes through, so the
// real frontend renders your real cards — just without the all-entities firehose.
//
// The allowlist is computed once at startup from each dashboard's lovelace/config
// (walked by ./lovelace_extract.mjs), unioned across all configured dashboards.
//
// Runs in two modes (auto-detected):
//   * HA add-on  — reads /data/options.json, uses SUPERVISOR_TOKEN via the supervisor
//                  proxy for the allowlist precompute, proxies to http://homeassistant:8123.
//   * dev/CLI    — reads env vars, uses HA_TOKEN against HA_BASE directly.
//
// Env (dev): HA_TOKEN, HA_BASE (default http://homeassistant.mgmt:8123), PORT (8099),
//   DASH_PATHS (comma/newline list), ALWAYS_FORWARD, NEVER_FORWARD (literals or /regex/),
//   TRIM (default 1; 0 = passthrough for A/B compare),
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

const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

const HA_BASE = process.env.HA_BASE || (inAddon ? 'http://homeassistant:8123' : 'http://homeassistant.mgmt:8123');
const HA_WS = HA_BASE.replace(/^http/, 'ws') + '/api/websocket';     // browser ws relay target
const PORT = parseInt(process.env.PORT || '8099', 10);
const DASH_PATHS = toList(OPT.dashboards ?? (process.env.DASH_PATHS || process.env.DASH_PATH));
const TRIM = OPT.trim !== undefined ? !!OPT.trim : process.env.TRIM !== '0';

// allowlist-precompute connection (add-on: supervisor proxy + SUPERVISOR_TOKEN)
const ALLOW_WS_URL = process.env.ALLOW_WS_URL || (inAddon ? 'ws://supervisor/core/websocket' : HA_WS);
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

// ---- compute the union allowlist once (own short-lived HA ws) ----
function computeAllow() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ALLOW_WS_URL); let id = 1; const pending = {};
    const rpc = (o) => { o.id = id++; return new Promise((res, rej) => { pending[o.id] = [res, rej]; ws.send(JSON.stringify(o)); }); };
    ws.on('message', async (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: ALLOW_TOKEN }));
      if (m.type === 'auth_invalid') return reject(new Error('auth_invalid'));
      if (m.type === 'auth_ok') {
        try {
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
          ws.close(); resolve(union);
        } catch (e) { reject(e); }
      }
      if (m.type === 'result' && pending[m.id]) { const p = pending[m.id]; m.success ? p[0](m.result) : p[1](new Error(JSON.stringify(m.error))); delete pending[m.id]; }
    });
    ws.on('error', reject);
  });
}

// ---- HTTP passthrough to HA ----
const proxy = httpProxy.createProxyServer({ target: HA_BASE, changeOrigin: true, ws: false, autoRewrite: true });
proxy.on('error', (e, req, res) => { log('http proxy error', e.message); try { res.writeHead(502); res.end('proxy error'); } catch {} });
const server = http.createServer((req, res) => proxy.web(req, res));

// ---- intercept only the HA websocket ----
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/api/websocket')) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (browserWs) => bridge(browserWs));
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
    if (TRIM && m && m.type === 'get_states') getStatesIds.add(m.id);
    if (TRIM && m && m.type === 'subscribe_entities' && !m.entity_ids) {
      m.entity_ids = [...ALLOW];           // HA now streams only the allowlist
      s = JSON.stringify(m);
    }
    toHA(s);
  });

  haWs.on('message', (raw) => {
    let s = raw.toString(); let m;
    try { m = JSON.parse(s); } catch { return safeSend(s); }
    if (TRIM && m && m.type === 'result' && getStatesIds.has(m.id) && Array.isArray(m.result)) {
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
log(`mode: ${inAddon ? 'add-on' : 'dev'} | target ${HA_BASE} | allowlist via ${ALLOW_WS_URL}`);
computeAllow().then((set) => {
  ALLOW = set;
  log(`union allowlist for [${DASH_PATHS.join(', ')}]: ${ALLOW.size} entities (TRIM=${TRIM})`);
  server.listen(PORT, () => {
    log(`HA trim-proxy listening on :${PORT}  ->  ${HA_BASE}`);
    DASH_PATHS.forEach((p) => log(`  open: http://<host>:${PORT}/${p}`));
  });
}).catch((e) => { console.error('failed to compute allowlist:', e.message); process.exit(2); });
