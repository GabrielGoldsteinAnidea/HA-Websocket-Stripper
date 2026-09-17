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
import { extractEntities, collectTemplates, expandGroupMembers } from './lovelace_extract.mjs';

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
const VERSION = '0.2.4';

const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

const HA_BASE = process.env.HA_BASE || OPT.ha_base || (inAddon ? 'http://homeassistant:8123' : 'http://homeassistant.mgmt:8123');
const HA_WS = HA_BASE.replace(/^http/, 'ws') + '/api/websocket';     // browser ws relay target
// Port precedence: PORT env (dev) > `port` add-on option > 8099. Under host_network the
// add-on binds this directly on the host, so the option is the only way to move it off
// 8099 (the Network tab can't remap a host-network port) — see issue #6.
const PORT = parseInt(process.env.PORT || OPT.port || '8099', 10);
const DASH_PATHS = toList(OPT.dashboards ?? (process.env.DASH_PATHS || process.env.DASH_PATH));
// strip_entities: true (default) = inject the allowlist so HA streams only needed entities.
//   false = pass the websocket straight through (full firehose) for A/B comparison.
const STRIP = OPT.strip_entities !== undefined ? !!OPT.strip_entities
  : (process.env.STRIP_ENTITIES ?? process.env.TRIM) !== '0';
// HA's own websocket negotiates permessage-deflate. The `ws` library does NOT enable it
// server-side by default, so putting this proxy in front of HA silently REMOVES compression
// from the browser leg — a kiosk that used to receive deflated frames receives plaintext
// JSON instead. Default on, to restore what clients had before the proxy existed; the cost
// is deflate CPU on the HA host, which is why it can be turned off on very weak hardware.
const COMPRESS_WS = OPT.compress_websocket !== undefined ? !!OPT.compress_websocket
  : (process.env.COMPRESS_WS ?? '1') !== '0';

// Lovelace resources are instance-wide: HA has no per-dashboard scoping, so every kiosk
// downloads, parses and compiles EVERY custom card in the install. Measured on the instance
// this was built against: 45 resources, 21MB of JavaScript, for a wall panel that uses four
// custom card types. With states and registries already trimmed, this is what the load time
// actually consists of — ~73% of the main thread's busy time is module parse/compile, not
// script execution, style or layout.
//
// Off by default. Unlike entity trimming, a wrongly dropped resource is *visible* — a card
// renders as "Custom element doesn't exist" — so this is opt-in, and every drop is logged.
const TRIM_RESOURCES = OPT.trim_resources !== undefined ? !!OPT.trim_resources
  : (process.env.TRIM_RESOURCES ?? '0') !== '0';
const RES_ALWAYS = parseRules(OPT.resources_always_forward ?? process.env.RESOURCES_ALWAYS_FORWARD);
const RES_NEVER = parseRules(OPT.resources_never_forward ?? process.env.RESOURCES_NEVER_FORWARD);

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

if (!ALLOW_TOKEN) {
  console.error('ERROR: need a token (SUPERVISOR_TOKEN / HA_TOKEN / ALLOW_TOKEN).');
  process.exit(1);
}
// No dashboards is a config error, but exiting would just hand the Supervisor a restart loop
// (and a fresh install starts here). Stay up and say what to set; with an empty allowlist the
// upgrade gate refuses /api/websocket, so we never fall back to relaying the firehose.
if (!DASH_PATHS.length) {
  console.error('ERROR: no dashboards configured — set the `dashboards` option to your dashboard url_path values (Settings -> Dashboards). Until then /api/websocket is refused.');
}
const log = (...a) => console.log(new Date().toISOString(), ...a);

// While HA is down (a restart, or a host boot where core isn't up yet) every kiosk retry and
// every in-flight stream produces the SAME error, hundreds of times a second — that flood is
// what made the old logs unreadable. Collapse repeats: log the first occurrence of a key
// immediately, then at most one summary line per window with the suppressed count.
const THROTTLE_MS = 10000;
const throttleState = new Map();
function logThrottled(key, msg) {
  const t = throttleState.get(key);
  if (t) { t.n++; t.msg = msg; return; }
  log(msg);
  const timer = setTimeout(() => {
    const s = throttleState.get(key);
    throttleState.delete(key);
    if (s?.n) log(`${s.msg} (repeated ${s.n}x in the last ${THROTTLE_MS / 1000}s)`);
  }, THROTTLE_MS);
  timer.unref?.();                       // never hold the process open just to flush a log
  throttleState.set(key, { n: 0, msg, timer });
}

// Last-resort safety net. An HA restart resets every in-flight socket at once (camera
// streams, Assist pipelines, the browser's own connections), and a socket that errors before
// http-proxy has attached its handlers reaches Node as an unhandled 'error' event — which
// killed the whole add-on (`throw er` / `read ECONNRESET`), turning an HA reboot into a
// crash-restart loop. Transient network errnos are logged and swallowed; anything else is a
// real bug and still exits loudly.
// Socket-level errnos ONLY. DNS failures (ENOTFOUND/EAI_AGAIN) are deliberately excluded:
// under host_network the internal `homeassistant`/`supervisor` names may genuinely not
// resolve, and that misconfiguration should stay loud rather than be swallowed.
const NET_ERRNOS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN']);
const survivable = (e, what) => {
  if (!NET_ERRNOS.has(e?.code)) return false;
  logThrottled(`${what}:${e.code}`, `ignored ${what} (${e.code}): ${e.message}`);
  return true;
};
process.on('uncaughtException', (e) => {
  if (survivable(e, 'socket error')) return;
  console.error('fatal uncaught exception:', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  if (survivable(e, 'rejection')) return;
  console.error('fatal unhandled rejection:', e);
  process.exit(1);
});

// ALLOW is the UNION across every configured dashboard. It stays the fallback for any
// connection we can't attribute to one dashboard, so behaviour never regresses below
// "what this add-on did before per-dashboard trimming existed".
let ALLOW = new Set();
// url_path -> that dashboard's own allowlist (overrides already applied). A kiosk that only
// ever shows one dashboard has no business receiving the other dashboards' entities: on the
// instance this was built against the union was 388 entities while the kiosk's own dashboard
// needed 60, so the union costs a small panel ~6x more state than it can display.
let ALLOW_BY_DASH = new Map();
// trim_registries: also cut the entity/device/area registries to what the connection can
// see. Separate from strip_entities because it is the more invasive of the two — states are
// self-describing, whereas a registry row missing here makes the frontend treat the entity as
// unregistered. Default on; turn it off first if something renders oddly.
const TRIM_REGISTRIES = OPT.trim_registries !== undefined ? !!OPT.trim_registries
  : (process.env.TRIM_REGISTRIES ?? '1') !== '0';
// Every live browser <-> HA bridge, so a grown allowlist can reach already-open pages
// (issue #7). See refreshOpenConnections().
const openBridges = new Set();
// False until the first allowlist lands. HA may still be booting when we start, and injecting
// an EMPTY allowlist would render every card "unavailable" until a manual reload — so until
// this flips we refuse /api/websocket upgrades instead (the frontend just keeps retrying).
let ALLOW_READY = false;

// HA events that can change the computed allowlist: a dashboard edit, or a registry change
// that alters what an area/label/device/integration auto-entities filter resolves to.
const WATCH_EVENTS = ['lovelace_updated', 'entity_registry_updated', 'device_registry_updated', 'area_registry_updated', 'label_registry_updated'];

// Allowlist for one dashboard = entities used across ALL its views. Two passes unioned:
//  1) structured walk (explicit cards + auto-entities filter expansion)
//  2) every REAL entity id appearing anywhere in the config text (catches ids inside
//     button-card / mushroom-template / decluttering templates the walker can't parse).
// Over-including is harmless (still tiny vs the instance); under-including breaks cards.
function allowlistFor(cfg, states, registries, renderedTemplates) {
  const real = new Set(states.map((s) => s.entity_id));
  // overInclude: forward every entity a card COULD show (don't shrink on volatile
  // state/attributes filters); registries resolve area/label/device/integration filters.
  const out = new Set(extractEntities(cfg, states, { registries, overInclude: true, renderedTemplates }).entities);
  const text = JSON.stringify(cfg);
  const re = /[a-z_][a-z0-9_]*\.[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(text))) if (real.has(m[0])) out.add(m[0]);
  // Finally pull in group members: a card can name only the group (or expand it client-side
  // via `show_group_members`) while the members appear nowhere in the config text (issue #4).
  return expandGroupMembers(out, states);
}

// Fetch the area/device/entity/label registries so auto-entities `area`/`label`/`device`/
// `integration` filters resolve (issue #4). Each is optional — on older HA or a permission
// error we degrade to the pre-registry behavior (those filters just match nothing) rather
// than failing the whole allowlist build.
async function fetchRegistries(rpc) {
  const get = async (type) => { try { return await rpc({ type }); } catch (e) { log(`  registry ${type} unavailable: ${e.message}`); return []; } };
  const [areas, devices, entities, labels] = await Promise.all([
    get('config/area_registry/list'),
    get('config/device_registry/list'),
    get('config/entity_registry/list'),
    get('config/label_registry/list'),
  ]);
  return { areas, devices, entities, labels };
}

// When a dashboard can't be fetched, the single most useful thing to print is the list of
// url_paths that DO exist — otherwise the log just repeats `config_not_found` forever and the
// user has no way to tell a typo from an HA that isn't ready. Throttled, because a failing
// dashboard re-fails on every registry event. Best-effort: never let this break a build.
async function logAvailableDashboards(rpc) {
  try {
    const list = await rpc({ type: 'lovelace/dashboards/list' });
    const paths = (Array.isArray(list) ? list : []).map((d) => d.url_path).filter(Boolean);
    // The default dashboard has a null url_path and is reachable as `lovelace`.
    logThrottled('dash-list', `  dashboards on this HA: ${['lovelace', ...paths].join(', ')}`);
    logThrottled('dash-hint', '  set the `dashboards` option to the url_path values above (Settings -> Dashboards)');
  } catch (e) {
    logThrottled('dash-list-fail', `  (could not list available dashboards: ${e.message})`);
  }
}

// Render every `filter.template` in a dashboard config through HA, so auto-entities cards
// whose entity list only exists after Jinja evaluation resolve too (issue #4). Best-effort
// per template: a template that errors or times out just contributes nothing, exactly as
// before, rather than failing the whole dashboard.
async function renderTemplates(cfg, renderTemplate) {
  const out = new Map();
  if (!renderTemplate) return out;
  const tpls = collectTemplates(cfg);
  if (!tpls.length) return out;
  const results = await Promise.all(tpls.map(async (t) => {
    try { return [t, await renderTemplate(t)]; }
    catch (e) { logThrottled(`tpl:${e.message}`, `  auto-entities template not rendered (${e.message})`); return null; }
  }));
  results.filter(Boolean).forEach(([t, r]) => out.set(t, r));
  if (out.size) log(`  rendered ${out.size}/${tpls.length} auto-entities template filter(s)`);
  return out;
}

// Apply the always/never overrides to one dashboard's set. Done PER DASHBOARD, not just to
// the union: `always_forward` exists for entities no card names — the Assist pipeline and
// wake-word entities a Voice Satellite card drives, say — and those are needed on whichever
// dashboard the kiosk actually has open, not merely somewhere in the union.
function applyOverrides(set, realIds) {
  const out = new Set(set);
  ALWAYS.forEach((r) => {
    if (r.literal) out.add(r.literal);
    else realIds.forEach((eid) => { if (r.re.test(eid)) out.add(eid); });
  });
  [...out].forEach((eid) => { if (matchesAny(NEVER, eid)) out.delete(eid); });
  return out;
}

// Build the per-dashboard allowlists (and their union) using an authed rpc().
async function buildAllow(rpc, renderTemplate) {
  const states = await rpc({ type: 'get_states' });
  const realIds = states.map((s) => s.entity_id);
  const byId = new Map(states.map((st) => [st.entity_id, st]));
  const registries = await fetchRegistries(rpc);
  const union = new Set();
  const perDash = new Map();
  const keysByDash = new Map();
  let failed = 0;
  for (const p of DASH_PATHS) {
    try {
      const cfg = await rpc({ type: 'lovelace/config', url_path: p });
      const tpls = await renderTemplates(cfg, renderTemplate);
      const set = allowlistFor(cfg, states, registries, tpls);
      log(`  ${p}: ${set.size} entities`);
      perDash.set(p, set);
      // Resource keys come from the dashboard config AND from the icons of the entities
      // this dashboard shows. The second half matters: an entity's icon usually lives in
      // the entity registry, not in any dashboard's YAML, so a config-only scan misses it
      // and drops the icon pack that renders it. Measured here: 20 entities carry `phu:`
      // icons set in the registry, and the string "phu" appears in no dashboard config.
      keysByDash.set(p, resourceKeys(cfg, set, byId));
      set.forEach((e) => union.add(e));
    } catch (e) { failed++; log(`  ${p}: FAILED ${e.message}`); }
  }
  // Any failure at all is worth naming the alternatives for: `config_not_found` means the
  // url_path simply isn't a dashboard on this instance, and the fix is always "look at what
  // is actually there". Cheap, and it turns a repeating FAILED line into a self-answering one.
  if (failed) await logAvailableDashboards(rpc);
  // A single dashboard failing is a config error (a typo'd url_path) and must not stop the
  // others from being served. EVERY dashboard failing is something else: an HA that is up
  // enough to authenticate but not yet to serve lovelace — precisely what a core restart
  // looks like from here. Bail so the caller retries, rather than committing an empty
  // allowlist that nothing would rebuild (no dashboard edit follows a restart).
  if (DASH_PATHS.length && failed === DASH_PATHS.length) {
    throw new Error(`no dashboard config available yet (all ${failed} failed) — HA not ready, or none of these url_paths exist`);
  }
  const baseN = union.size;
  for (const [p, set] of perDash) perDash.set(p, applyOverrides(set, realIds));
  const withOverrides = applyOverrides(union, realIds);
  // Registry reachability is computed against the UNION deliberately: a connection served a
  // single dashboard's entities may still legitimately name a device or area belonging to
  // another, and a device row wrongly dropped costs a name with no bandwidth saving worth it.
  if (TRIM_REGISTRIES) {
    rebuildRegCache(registries, withOverrides);
    log(`  registry reach: ${REG_CACHE.devices.size} device(s), ${REG_CACHE.areas.size} area(s)`);
  }
  await buildResources(rpc, keysByDash);
  const afterAlways = new Set([...union, ...withOverrides]).size;
  log(`overrides: base ${baseN}, +always ${afterAlways - baseN}, -never ${afterAlways - withOverrides.size}`);
  return { union: withOverrides, perDash };
}

// Swap in a freshly-computed allowlist and log exactly what changed — the entity ids
// added and removed, not just the new total (issue #7). This makes it visible from the
// add-on log whether a dashboard edit's recompute actually picked up the entities you
// expect. Remember: the new list only affects NEW ws connections — an already-open kiosk
// page must be reloaded to use it.
// `merge` unions with the current list instead of replacing it, and is used for the rebuild
// after a reconnect. A core that has just restarted can answer with a partially-loaded state
// machine, so the rebuild legitimately comes back SHORT — and since no dashboard edit follows
// a restart, nothing would ever rebuild it, leaving cards permanently "unavailable". Over-
// including is harmless here by design (see allowlistFor); under-including breaks cards. An
// actual dashboard/registry edit still replaces, so removals take effect.
function applyAllow(built, why, { merge = false } = {}) {
  let next = built.union;
  let nextByDash = built.perDash;
  if (merge) {
    next = new Set([...ALLOW, ...next]);
    // Merge per dashboard too, for the same reason the union is merged: a core that has just
    // restarted can answer a rebuild with a partial state machine, and a dashboard that came
    // back short would otherwise permanently lose entities nothing will rebuild.
    const merged = new Map(ALLOW_BY_DASH);
    for (const [p, s] of nextByDash) merged.set(p, new Set([...(ALLOW_BY_DASH.get(p) ?? []), ...s]));
    nextByDash = merged;
  }
  const added = [...next].filter((e) => !ALLOW.has(e)).sort();
  const removed = [...ALLOW].filter((e) => !next.has(e)).sort();
  ALLOW = next;
  ALLOW_BY_DASH = nextByDash;
  const fmt = (a) => (a.length > 25 ? `${a.slice(0, 25).join(', ')} …(+${a.length - 25} more)` : a.join(', '));
  log(`allowlist ${why}: ${ALLOW.size} entities (+${added.length} -${removed.length})`);
  if (added.length) log(`  +added: ${fmt(added)}`);
  if (removed.length) log(`  -removed: ${fmt(removed)}`);
  if (!added.length && !removed.length) log('  (no change)');
  if (added.length) refreshOpenConnections();
}

// `subscribe_entities` is sent ONCE per connection and HA has no way to amend a live
// subscription, so a recompute only ever affected NEW connections — an already-open kiosk
// kept streaming its original entity list until someone reloaded the tab (issue #7).
// Dropping the browser socket fixes that: the HA frontend treats it as an ordinary
// disconnect, reconnects on its own, and re-subscribes against the current allowlist.
// Only on GROWTH. A shrink means the open page is carrying entities it no longer needs,
// which is harmless — and churning every kiosk over a removal would be a bad trade.
function refreshOpenConnections() {
  if (!STRIP || !openBridges.size) return;
  log(`  reconnecting ${openBridges.size} open dashboard connection(s) to pick up the new entities`);
  for (const close of [...openBridges]) { try { close(); } catch {} }
}

// ---- persistent control connection: compute the allowlist + watch for dashboard edits ----
// One long-lived HA ws (the supervisor proxy in add-on mode). After auth it builds the
// allowlist once (resolving boot), then subscribes to `lovelace_updated` and rebuilds on
// every dashboard save — so card edits take effect without an add-on restart. Reconnects
// with backoff on drop so live updates keep working for the life of the add-on.
// Resolves with the first allowlist and NEVER rejects: a failure *before* the first allowlist
// (HA restarting, core still booting, the supervisor proxy answering 502) is retried with the
// same backoff as any later drop. It used to reject, and boot turned that into `process.exit(2)`
// — so an HA reboot put the add-on into a ~300ms crash/restart loop instead of just waiting.
function startController() {
  return new Promise((resolve) => {
    let settled = false;
    let backoff = 1000;
    let recomputeTimer = null;
    let attempts = 0;

    const connect = () => {
      // handshakeTimeout: an HA that WEDGES mid-restart (accepts the TCP connection, never
      // completes the ws handshake) would otherwise never fire 'close' or 'error', so nothing
      // would ever schedule a reconnect and the add-on would sit at 503 forever looking healthy.
      const ws = new WebSocket(ALLOW_WS_URL, { handshakeTimeout: 15000 });
      let id = 1; const pending = {}; let gone = false;
      const rpc = (o) => { o.id = id++; return new Promise((res, rej) => { pending[o.id] = [res, rej]; ws.send(JSON.stringify(o)); }); };

      // `render_template` is a SUBSCRIPTION, not a one-shot: HA answers `result` (null)
      // immediately and then pushes an `event` carrying the rendered text, re-pushing it
      // whenever a referenced entity changes. We want a single snapshot, so we take the
      // first event and unsubscribe. Kept separate from rpc() precisely because rpc()
      // resolves on `result`, which for this command carries no output. (issue #4)
      const tplWaiters = new Map();
      const settleTpl = (tplId, err, value) => {
        const w = tplWaiters.get(tplId);
        if (!w) return;
        clearTimeout(w.timer);
        tplWaiters.delete(tplId);
        try { ws.send(JSON.stringify({ id: id++, type: 'unsubscribe_events', subscription: tplId })); } catch {}
        err ? w.rej(err) : w.res(value);
      };
      const renderTemplate = (template) => new Promise((res, rej) => {
        const tplId = id++;
        // A template referencing a slow or missing entity must not stall the whole rebuild.
        const timer = setTimeout(() => settleTpl(tplId, new Error('render_template timed out')), 10000);
        timer.unref?.();
        tplWaiters.set(tplId, { res, rej, timer });
        try { ws.send(JSON.stringify({ id: tplId, type: 'render_template', template, report_errors: false })); }
        catch (e) { settleTpl(tplId, e); }
      });

      // Debounce bursts of edits (the editor can fire several saves) into one rebuild.
      const scheduleRecompute = (why) => {
        clearTimeout(recomputeTimer);
        recomputeTimer = setTimeout(async () => {
          try { applyAllow(await buildAllow(rpc, renderTemplate), `recomputed (${why})`); }
          catch (e) { log('recompute failed:', e.message); }
        }, 1500);
      };

      ws.on('message', async (raw) => {
        // Guarded: this handler is async, so a throw here becomes an unhandled rejection —
        // i.e. a process-level crash — and a restarting HA/supervisor can answer with
        // something that isn't JSON.
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: ALLOW_TOKEN }));
        // A bad token is a config error, not a transient one — but exiting would just hand the
        // Supervisor a restart loop, so say so loudly and keep retrying. Retry SLOWLY though:
        // in dev mode the control ws authenticates against HA directly, and a failed auth
        // every few seconds would walk into HA's login_attempts_threshold / ip_ban.
        if (m.type === 'auth_invalid') {
          logThrottled('auth_invalid', `ERROR: HA rejected the token (auth_invalid) — check the add-on's ${inAddon ? 'homeassistant_api permission' : 'HA_TOKEN'}`);
          backoff = Math.max(backoff, 60000);
          try { ws.close(); } catch {}
          return;
        }
        if (m.type === 'auth_ok') {
          try {
            backoff = 1000; attempts = 0;
            const next = await buildAllow(rpc, renderTemplate);
            if (!settled) {
              ALLOW = next.union; ALLOW_BY_DASH = next.perDash;
              settled = true; ALLOW_READY = true; resolve(ALLOW);
            }
            else applyAllow(next, 'recomputed (reconnect)', { merge: true });
            // lovelace_updated -> a dashboard's cards changed. The *_registry_updated
            // events -> a device moved area, a label was (un)assigned, etc., which can
            // change what an area/label/device/integration auto-entities filter resolves
            // to (issue #4). Rebuild (debounced) on any of them.
            for (const ev of WATCH_EVENTS) await rpc({ type: 'subscribe_events', event_type: ev });
            log(`watching ${WATCH_EVENTS.join(', ')} for live allowlist updates`);
          } catch (e) {
            // HA answered the handshake but died mid-build (a restart in progress). Drop the
            // socket so onGone() schedules a retry — never leave a half-set-up control ws.
            log('post-auth setup failed:', e.message);
            try { ws.close(); } catch {}
          }
          return;
        }
        // First render of a template subscription -> hand it back and unsubscribe.
        if (m.type === 'event' && tplWaiters.has(m.id)) {
          settleTpl(m.id, null, m.event?.result ?? '');
          return;
        }
        // An invalid template fails at `result` time and never emits an event.
        if (m.type === 'result' && tplWaiters.has(m.id) && !m.success) {
          settleTpl(m.id, new Error(m.error?.message || 'render_template failed'));
          return;
        }
        if (m.type === 'event' && WATCH_EVENTS.includes(m.event?.event_type)) {
          const ev = m.event.event_type;
          const why = ev === 'lovelace_updated' ? (m.event.data?.url_path ?? '(default)') : ev;
          log(`${ev}: ${ev === 'lovelace_updated' ? why : ''}`.trim());
          scheduleRecompute(why);
          return;
        }
        if (m.type === 'result' && pending[m.id]) { const p = pending[m.id]; m.success ? p[0](m.result) : p[1](new Error(JSON.stringify(m.error))); delete pending[m.id]; }
      });

      const onGone = (e) => {
        if (gone) return; gone = true;
        if (e) logThrottled(`ctrl:${e.code || e.message}`, `control ws error: ${e.message}`);
        Object.values(pending).forEach(([, rej]) => rej(new Error('control ws closed')));
        [...tplWaiters.keys()].forEach((k) => settleTpl(k, new Error('control ws closed')));
        const state = settled ? `serving last allowlist: ${ALLOW.size}` : 'waiting for HA to come up';
        logThrottled('ctrl-down', `control ws down; reconnecting in ${backoff}ms (${state})`);
        // Never exiting means a genuine misconfiguration (a host that doesn't resolve, a
        // wrong ha_base) now looks like a healthy add-on that is merely waiting. Say the
        // quiet part out loud once we've clearly waited longer than a restart would take.
        if (!settled && ++attempts === 6) {
          log(`WARNING: still no allowlist after ${attempts} attempts to reach ${ALLOW_WS_URL}.`);
          log('  If HA is actually running, this add-on may not be able to resolve that name');
          log('  (common under host_network) — pin it with the `ha_base` / `allow_ws_url` options.');
        }
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
// autoRewrite is deliberately OFF: it rewrites a redirect's HOST but never its SCHEME, which
// is an infinite redirect loop behind TLS termination (see rewriteLocation below). We do the
// whole job in a proxyRes handler instead — same condition, plus scheme and query params.
const proxy = httpProxy.createProxyServer({ target: HA_BASE, changeOrigin: true, ws: false, xfwd: true });

// The origin as the BROWSER sees it, which is not necessarily the one we were reached on.
// Note xfwd APPENDS our own hop to x-forwarded-proto (so Caddy's "https" becomes
// "https,http"), hence first-entry-wins. x-forwarded-host is not appended, so it keeps the
// outermost value. With no upstream proxy this yields exactly our own scheme/host.
function clientOrigin(req) {
  const first = (v) => String(v || '').split(',')[0].trim();
  return {
    proto: first(req.headers['x-forwarded-proto']) || 'http',
    host: first(req.headers['x-forwarded-host']) || req.headers.host || '',
  };
}

const TARGET_HOST = (() => { try { return new URL(HA_BASE).host; } catch { return ''; } })();

// Set scheme + authority on a URL. Deliberately NOT `url.host = host`: the WHATWG host setter
// keeps the existing port when the value it's given has none, so rewriting HA's
// `http://10.0.0.5:8123/...` to a port-less public host left `https://example.org:8123/...`.
// hostname/port must be set separately. The `]` check keeps IPv6 literals (`[::1]:8123`) intact.
function setOrigin(url, proto, host) {
  const i = host.lastIndexOf(':');
  const hasPort = i > host.lastIndexOf(']');
  url.protocol = `${proto}:`;
  url.hostname = hasPort ? host.slice(0, i) : host;
  url.port = hasPort ? host.slice(i + 1) : '';
}

// Point a redirect back at the origin the browser actually used.
//
// `changeOrigin` makes HA see the request as arriving at HA_BASE, so its absolute redirects
// come back naming HA's own address. http-proxy's `autoRewrite` fixed the host but left the
// scheme alone, so behind an HTTPS terminator the browser was sent from
// `https://ha.example.org/...` to `http://ha.example.org/...`; the edge proxy bounced it
// straight back to HTTPS, HA reissued the same redirect, and the page never loaded —
// `.../:8123./:8123./:8123./...` (issue #9).
//
// Query params matter just as much: HA's auth flow carries absolute URLs in `redirect_uri`,
// and autoRewrite never touched those, so login bounced the browser to HA's internal address
// — unreachable from outside the LAN.
function rewriteLocation(raw, proto, host, targetHost = TARGET_HOST) {
  if (!raw || !host) return raw;
  const base = `${proto}://${host}`;
  let u;
  try { u = new URL(raw, base); } catch { return raw; }
  // Rewrite when it points at HA itself, or already at the browser's host but on the wrong
  // scheme. Anything genuinely third-party is left alone.
  if (u.host === targetHost || u.host === host) setOrigin(u, proto, host);
  for (const key of ['redirect_uri', 'hass_url']) {
    const v = u.searchParams.get(key);
    if (!v) continue;
    try {
      const q = new URL(v);
      if (q.host === targetHost || q.host === host) {
        setOrigin(q, proto, host);
        u.searchParams.set(key, q.toString());
      }
    } catch { /* not an absolute URL — leave it */ }
  }
  // A relative Location stays relative; making it absolute would be a gratuitous change.
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? u.toString() : u.pathname + u.search + u.hash;
}

proxy.on('proxyRes', (proxyRes, req) => {
  const loc = proxyRes.headers.location;
  if (!loc || proxyRes.statusCode < 300 || proxyRes.statusCode >= 400) return;
  const { proto, host } = clientOrigin(req);
  const next = rewriteLocation(loc, proto, host);
  if (next !== loc) {
    logThrottled(`redirect:${proto}:${host}`, `rewrote redirect for ${proto}://${host}: ${loc} -> ${next}`);
    proxyRes.headers.location = next;
  }
});
// Node reports dual-stack client IPs as IPv4-mapped IPv6 (e.g. ::ffff:192.168.5.247).
// HA's trusted_networks auth provider matches plain IPv4 subnets, and a mapped address
// won't match an IPv4 network — so normalize X-Forwarded-For to bare IPv4, or
// trusted-network (password-less) kiosk login silently falls through to a password prompt.
//
// Normalize IN PLACE, preserving the chain. This used to `setHeader('x-forwarded-for', ip)`,
// replacing the whole chain with our immediate peer — which broke every setup with another
// reverse proxy in front (issue #9). http-proxy's xfwd APPENDS our hop to all three headers,
// so behind e.g. Caddy HA received:
//     X-Forwarded-For:   <client>,<caddy>      (2 entries — then flattened by us to 1)
//     X-Forwarded-Proto: https,http            (2 entries)
// and HA's forwarded middleware raises HTTPBadRequest on
//     `len(forwarded_proto) not in (1, len(forwarded_for))`
// -> a hard 400 on every request. Keeping the chain intact keeps the counts in step, and
// preserves the real client IP through the upstream proxy instead of hiding it behind Caddy.
const normalizeXff = (v) => String(v).split(',').map((s) => s.trim().replace(/^::ffff:/, '')).filter(Boolean).join(', ');
proxy.on('proxyReq', (proxyReq, req) => {
  const xff = proxyReq.getHeader('x-forwarded-for') ?? req.headers['x-forwarded-for'];
  if (xff) proxyReq.setHeader('x-forwarded-for', normalizeXff(xff));
});
// proxy.ws() never fires 'proxyReq' — it has its own event — so without this the websocket
// upgrade would carry the un-normalized IPv4-mapped form that HTTP no longer does.
proxy.on('proxyReqWs', (proxyReq, req) => {
  const xff = proxyReq.getHeader('x-forwarded-for') ?? req.headers['x-forwarded-for'];
  if (xff) proxyReq.setHeader('x-forwarded-for', normalizeXff(xff));
});
// Error arg is an http res for proxy.web() but a raw socket for proxy.ws() — handle both.
proxy.on('error', (e, req, res) => {
  logThrottled(`proxy:${e.code || e.message}`, `proxy error ${e.message}`);
  try {
    if (res && typeof res.writeHead === 'function') { res.writeHead(502); res.end('proxy error'); }
    else if (res && typeof res.destroy === 'function') res.destroy();   // ws upgrade socket
  } catch {}
});
// ---- registry trimming ----
// The frontend asks for these three registries on every load, and each is instance-wide.
// The entity registry in particular is one row per entity — the single largest payload left
// once states are trimmed, and the one that scales with instance size rather than with what
// the dashboard shows.
const REGISTRY_TYPES = new Map([
  ['config/entity_registry/list', 'entity'],
  ['config/entity_registry/list_for_display', 'entity_display'],
  ['config/device_registry/list', 'device'],
  ['config/area_registry/list', 'area'],
]);

// Trim one registry result to what `allow` can reach. Entity rows are filtered directly;
// device and area rows are kept only when a surviving entity still points at them, so a
// card's "Kitchen / Ceiling Light" secondary text keeps resolving. Rows we don't understand
// are kept — over-including is harmless, under-including breaks names.
function trimRegistry(kind, rows, allow) {
  // `list_for_display` is NOT a list. It answers with an object — `{entity_categories,
  // entities}` — whose rows use two-letter keys (`ei` entity_id, `di` device_id, `ai`
  // area_id, `en` name, `pl` platform...). Measured on a 9,553-entity instance it is
  // 1.44MB, and it was the single largest thing the kiosk still downloaded: 58% of the
  // whole websocket load, because the array-shaped guard below passed it straight through.
  // Filter `entities` and leave `entity_categories` (a tiny id->name map) alone.
  if (kind === 'entity_display') {
    const list = rows?.entities;
    if (!Array.isArray(list) || !list.every((r) => r && typeof r === 'object' && 'ei' in r)) return rows;
    return { ...rows, entities: list.filter((r) => allow.has(r.ei)) };
  }
  if (kind === 'entity') {
    // Rows we don't understand are kept: over-including is harmless, under-including
    // breaks names.
    if (!Array.isArray(rows) || !rows.every((r) => r && typeof r === 'object' && 'entity_id' in r)) return rows;
    return rows.filter((r) => allow.has(r.entity_id));
  }
  if (!Array.isArray(rows)) return rows;
  // Devices and areas are kept only where a surviving entity still reaches them, so a tile's
  // "Kitchen — Ceiling Light" secondary text still resolves. The reachable sets come from
  // REG_CACHE, built alongside the allowlist; if it's empty we haven't got a registry yet and
  // pass everything through rather than blanking names.
  const keep = kind === 'device' ? REG_CACHE.devices : REG_CACHE.areas;
  if (!keep.size) return rows;
  const idOf = (r) => (kind === 'device' ? r?.id : (r?.area_id ?? r?.id));
  return rows.filter((r) => keep.has(idOf(r)));
}

// Which devices/areas the current allowlist still reaches. Built from the control
// connection's own registry fetch, so a browser asking for devices before entities still
// gets a correct answer. Areas come from the entities directly AND from the devices those
// entities belong to, because an entity with no area_id of its own inherits its device's.
const REG_CACHE = { devices: new Set(), areas: new Set() };
function rebuildRegCache(registries, allow) {
  const devices = new Set();
  const areas = new Set();
  for (const r of registries?.entities ?? []) {
    if (!allow.has(r.entity_id)) continue;
    if (r.device_id) devices.add(r.device_id);
    if (r.area_id) areas.add(r.area_id);
  }
  for (const d of registries?.devices ?? []) {
    if (devices.has(d.id) && d.area_id) areas.add(d.area_id);
  }
  REG_CACHE.devices = devices;
  REG_CACHE.areas = areas;
}

// ---- per-dashboard Lovelace resources ----
// Namespaces the frontend resolves itself; an `mdi:` icon needs no custom resource.
const BUILTIN_ICON_NS = new Set(['mdi', 'hass', 'hassio', 'homeassistant', 'custom']);

const RESOURCE_CACHE = new Map();     // url -> { tested:Set, present:Set|null, bytes }
let RESOURCES_BY_DASH = new Map();    // dash -> Set(url) to keep
// What a connection is actually served: the union of every configured dashboard's keep
// set. Without per-connection scoping the proxy cannot know which dashboard a socket is
// showing, and serving less than the union would break whichever one it turns out to be.
// This still drops every resource NO dashboard references. It narrows to a single
// dashboard's set once per-connection scoping (PR #13) lands.
let RESOURCES_KEEP = new Set();

// Every token a dashboard might need a resource FOR: `custom:x` card/row/badge/feature types,
// and icon-pack prefixes (`foo:bar` where foo isn't built in).
//
// These are matched as plain substrings against each resource's body rather than by scanning
// for `customElements.define(...)`. That looks like the rigorous approach and is in fact the
// broken one: big bundles (mushroom, 639KB) construct element names at runtime, so a define()
// scan finds almost nothing and would drop a resource the dashboard needs. The literal name
// is still present in the bundle, so a substring test finds it. Errs toward keeping — a false
// positive costs bytes, a false negative breaks a card.
// Both halves of the icon pattern must START WITH A LETTER, and keys shorter than
// MIN_KEY are discarded. That is not fussiness — a loose pattern here silently disables the
// whole feature. `16:9` (a picture card's aspect_ratio) and `06:00` (any schedule) match a
// digit-tolerant pattern and yield the keys "16" and "06", and a two-character string occurs
// in every minified bundle ever written, so every resource "matches" and nothing is dropped.
// Observed exactly that: 45 resources, 39 kept, 97KB saved instead of 18MB.
const MIN_KEY = 3;
function resourceKeys(cfg, allowed = null, byId = null) {
  const cards = new Set();      // custom card/row/badge/feature types
  const icons = new Set();      // non-builtin icon namespaces
  const addIcon = (ns) => { if (ns.length >= MIN_KEY && !BUILTIN_ICON_NS.has(ns)) icons.add(ns); };
  // Icons of the entities this dashboard actually shows, which are typically registry
  // values rather than anything written in the config.
  if (allowed && byId) {
    for (const id of allowed) {
      const ic = byId.get(id)?.attributes?.icon;
      if (typeof ic !== 'string') continue;
      const m = ic.match(/^([a-z][a-z0-9_]{2,15}):[a-z]/);
      if (m) addIcon(m[1]);
    }
  }
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') return Object.values(n).forEach(walk);
    if (typeof n !== 'string') return;
    if (n.startsWith('custom:') && n.length > 7 + MIN_KEY) cards.add(n.slice(7));
    const ic = n.match(/^([a-z][a-z0-9_]{2,15}):([a-z][a-z0-9-]*)$/);
    if (ic) addIcon(ic[1]);
  })(cfg);
  return { cards, icons };
}

// A card type split into candidate identifying parts. Split on `-` only: an underscore
// usually sits inside one meaningful word (`print_status`), and breaking it would leave
// fragments generic enough to match anything.
function cardFragments(type) {
  return type.split('-').filter((p) => p.length >= 4);
}

// How many resources contain each fragment, and the cutoff above which a fragment is too
// common to identify anything. MEASURED rather than a hand-maintained stop-word list: the
// first attempt at this used one, and `grid`, `layout`, `entity` and `progress` all slipped
// through it and matched nearly every bundle on the instance — which took one panel from
// 2,998KB to 11,876KB. A fragment present in a quarter of all resources says nothing.
let FRAG_DF = new Map();
let FRAG_DF_MAX = 0;
const isDistinctive = (f) => (FRAG_DF.get(f) || 0) <= FRAG_DF_MAX;
// A fragment so rare it effectively names one bundle. Kept separate from "distinctive"
// because the evidence is much stronger: `mushroom` appears in 2 files out of 48, so a bundle
// containing it is almost certainly the Mushroom bundle, whereas `cover` tells you nothing.
let FRAG_RARE_MAX = 2;
const isRare = (f) => (FRAG_DF.get(f) || 0) <= FRAG_RARE_MAX;

// Does this bundle look like it provides `type`?
//
// The literal name is the strong signal. The fragment fallback exists for bundles that BUILD
// their element names at runtime: `ha-bambulab-cards.js` is 3.2MB, a dashboard renders
// `ha-bambulab-print_status-card`, and that string appears nowhere in the file — only
// `bambulab` and `print_status` separately.
//
// Two earlier rules made a very common case impossible, and both are gone:
//
//   - requiring EVERY fragment to be present. Mushroom registers its elements from template
//     literals, so `mushroom-cover-card` appears nowhere in `mushroom.js` — and neither does
//     the bare word `cover`. One missing generic word discarded the bundle even though the
//     near-unique `mushroom` was sitting right there.
//   - requiring TWO distinctive fragments, which no `<oneword>-<generic>-card` name can ever
//     satisfy, because it only has one distinctive word to give.
//
// Together they silently dropped the entire Mushroom family — one of the most widely
// installed card sets there is — with no error anywhere, just blank cards on the dashboard.
//
// Now: one RARE fragment carries a match on its own; otherwise fall back to two merely
// distinctive ones. Erring toward keeping is the right bias here, because the two failure
// modes are not symmetric — a resource kept needlessly costs some bytes, a resource wrongly
// dropped breaks a card and says nothing about why.
function cardMatchesBody(type, cached) {
  if (cached.literal.has(type)) return true;
  const present = cardFragments(type).filter((f) => cached.frags.has(f));
  if (!present.length) return false;
  if (present.some(isRare)) return true;
  return present.filter(isDistinctive).length >= 2;
}

// An icon namespace is matched two ways, and it needs both.
//
// A *user* of the namespace writes `cbi:bulb`, so the colon form finds them. Matching the
// bare namespace instead is how the 3-character `cbi` came to keep 4.8MB of bundles that
// merely contained those letters in base64 blobs and minified identifiers — `cbi:` appeared
// in none of them.
//
// But the *provider* never writes the colon form at all: it registers the namespace as a
// key, `customIconsets["cil"]`. Matching only the colon form drops the very bundle that
// serves the icons, which is what happened to custom-icons.js, the provider of `cil:`.
const ICON_REG = (ns) => new RegExp('customIcons(?:ets)?\\s*\\[\\s*[\'"`]' + ns + '[\'"`]');
const bodyHasIcon = (body, ns) => body.includes(ns + ':') || ICON_REG(ns).test(body);

// never > always > content match > fail-open. A resource we could not read is always kept:
// being unable to check is not evidence it is unused.
// Resource rules match on a SUBSTRING of the URL, not the whole of it — unlike entity rules,
// which compare entity_ids exactly. Nobody wants to write out
// `/hacsfiles/kiosk-mode/kiosk-mode.js?hacstag=1234567890`; they want to write `kiosk-mode`.
const matchesUrl = (rules, url) => rules.some((r) => (r.re ? r.re.test(url) : url.includes(r.literal)));

function keepResource(url, keys) {
  if (matchesUrl(RES_NEVER, url)) return false;
  if (matchesUrl(RES_ALWAYS, url)) return true;
  const c = RESOURCE_CACHE.get(url);
  if (!c || c.unreadable) return true;            // cannot check, so keep
  for (const k of keys.icons) if (c.icons.has(k)) return true;
  for (const k of keys.cards) if (cardMatchesBody(k, c)) return true;
  return false;
}

async function buildResources(rpc, keysByDash) {
  if (!TRIM_RESOURCES) return;
  let rows;
  try { rows = await rpc({ type: 'lovelace/resources' }); }
  catch (e) { log(`  resources: FAILED (${e.message}) — forwarding all resources`); RESOURCES_BY_DASH = new Map(); RESOURCES_KEEP = new Set(); return; }
  if (!Array.isArray(rows)) { RESOURCES_BY_DASH = new Map(); RESOURCES_KEEP = new Set(); return; }

  // Every token any dashboard could match on, tagged by kind so a card type and an icon
  // namespace that happen to share a name can never be confused for one another.
  const unionCards = new Set(), unionIcons = new Set();
  for (const ks of keysByDash.values()) {
    ks.cards.forEach((k) => unionCards.add(k));
    ks.icons.forEach((k) => unionIcons.add(k));
  }
  const unionFrags = new Set();
  for (const c of unionCards) for (const f of cardFragments(c)) unionFrags.add(f);
  const unionKeys = new Set([...[...unionCards].map((k) => 'card:' + k),
                             ...[...unionIcons].map((k) => 'icon:' + k),
                             ...[...unionFrags].map((k) => 'frag:' + k)]);
  // One fetch per resource, tested against every dashboard's keys at once. Bodies are read
  // and discarded one at a time — the whole set is ~21MB on a large install and must not be
  // held in memory. The cache is keyed by URL, which carries HACS's version tag, so an
  // updated card re-fetches on its own.
  for (const r of rows) {
    const c = RESOURCE_CACHE.get(r.url);
    if (c && [...unionKeys].every((k) => c.tested.has(k))) continue;
    try {
      const abs = /^https?:/i.test(r.url) ? r.url : HA_BASE + r.url;
      const body = await (await fetch(abs, { signal: AbortSignal.timeout(20000) })).text();
      RESOURCE_CACHE.set(r.url, {
        tested: new Set(unionKeys),
        literal: new Set([...unionCards].filter((k) => body.includes(k))),
        icons: new Set([...unionIcons].filter((k) => bodyHasIcon(body, k))),
        frags: new Set([...unionFrags].filter((f) => body.includes(f))),
        unreadable: false,
        bytes: body.length,
      });
    } catch (e) {
      RESOURCE_CACHE.set(r.url, { tested: new Set(unionKeys), literal: new Set(), icons: new Set(), frags: new Set(), unreadable: true, bytes: 0 });
      logThrottled(`res:${r.url}`, `  resources: could not read ${r.url} (${e.message}) — always forwarding it`);
    }
  }

  // Document frequency across the resources we could actually read. A fragment in more than
  // a quarter of them identifies nothing, so it cannot carry a fragment match on its own.
  const readable = rows.filter((r) => !RESOURCE_CACHE.get(r.url)?.unreadable);
  FRAG_DF = new Map();
  for (const f of unionFrags) {
    FRAG_DF.set(f, readable.filter((r) => RESOURCE_CACHE.get(r.url).frags.has(f)).length);
  }
  FRAG_DF_MAX = Math.max(1, Math.floor(readable.length * 0.25));
  // Both cutoffs scale with how many resources the instance has, so a small install and a
  // large one behave the same way. 5% is "this word appears in almost nothing", with a floor
  // of 2 so a tiny instance still has a workable notion of rare.
  FRAG_RARE_MAX = Math.max(2, Math.floor(readable.length * 0.05));
  const common = [...unionFrags].filter((f) => !isDistinctive(f));
  if (common.length) {
    log(`  resources: ${common.length} fragment(s) too common to identify a card (>${FRAG_DF_MAX} of ${readable.length}): ${common.sort().join(', ')}`);
  }

  const byDash = new Map();
  for (const [dash, keys] of keysByDash) {
    const keep = new Set();
    let keptB = 0, dropB = 0;
    for (const r of rows) {
      const bytes = RESOURCE_CACHE.get(r.url)?.bytes || 0;
      if (keepResource(r.url, keys)) { keep.add(r.url); keptB += bytes; }
      else dropB += bytes;
    }
    byDash.set(dash, keep);
    const needs = [...[...keys.cards].sort(), ...[...keys.icons].sort().map((i) => i + ':')];
    log(`  resources ${dash} needs: ${needs.join(', ') || '(none)'}`);
    log(`  resources ${dash}: ${keep.size}/${rows.length} kept (${(keptB / 1024).toFixed(0)}KB), ${rows.length - keep.size} dropped (${(dropB / 1024).toFixed(0)}KB)`);
  }
  RESOURCES_BY_DASH = byDash;
  const servedUnion = new Set();
  for (const keep of byDash.values()) for (const u of keep) servedUnion.add(u);
  RESOURCES_KEEP = servedUnion;
  log(`  resources served: ${servedUnion.size}/${rows.length} (union of all dashboards)`);

  // Resources dropped by EVERY dashboard get their own warning, because this set is the
  // exact signature of the one failure the tuning loop cannot catch.
  //
  // The documented way to tune this option is "load the dashboard and see what looks
  // wrong". That works for a card that fails to render or an icon that goes blank. It does
  // not work for a resource that registers no element and is named by no dashboard, but
  // runs on load and subscribes to state — an idle timer, a camera pop-up, a heartbeat.
  // Drop one of those and the dashboard is pixel-identical; only the behaviour stops, and
  // nothing reports it on either side. (Reported by @ajguerre1 on upstream #15, who lost a
  // doorbell pop-up on 28 panels for three days to the same failure one level down, via
  // entities.)
  //
  // The proxy cannot tell that class apart from a genuinely unused resource — but the
  // reader can, instantly. So say which ones they are rather than burying them in the
  // per-dashboard drop lists.
  const servedAnywhere = new Set();
  for (const keep of byDash.values()) for (const u of keep) servedAnywhere.add(u);
  const droppedByAll = rows.filter((r) => !servedAnywhere.has(r.url));
  if (droppedByAll.length) {
    const kb = droppedByAll.reduce((t, r) => t + (RESOURCE_CACHE.get(r.url)?.bytes || 0), 0) / 1024;
    log(`  resources: ${droppedByAll.length} dropped by ALL dashboards (no dashboard references them), ${kb.toFixed(0)}KB.`);
    log('    If any of these run on load rather than rendering a card — an idle timer, a');
    log('    pop-up, a heartbeat — add them to resources_always_forward. Dropping one of');
    log('    those is INVISIBLE: the dashboard renders normally and only the behaviour stops.');
    for (const r of droppedByAll) {
      const b = ((RESOURCE_CACHE.get(r.url)?.bytes || 0) / 1024).toFixed(0);
      log(`      drop ${String(b).padStart(6)}KB ${r.url.split('?')[0]}`);
    }
  }
}

// NOTE: there is deliberately NO per-connection dashboard attribution here.
// An earlier version of this branch inferred it from the page GET preceding the
// websocket, keyed by client IP. That is a heuristic — it breaks behind NAT, and a
// client fetching a dashboard's config is not necessarily displaying it. PR #13
// resolves the user from the `auth` frame the client actually presents, which is
// strictly better, so this branch no longer competes with it. Everything below
// trims to whatever allowlist the connection ends up with, so it narrows on its
// own once per-connection scoping lands.

const server = http.createServer((req, res) => proxy.web(req, res));

// ---- websocket upgrades ----
// We intercept ONLY /api/websocket (the entity firehose) to trim it. EVERY other ws
// upgrade passes straight through to HA — notably /api/webrtc/ws (go2rtc / WebRTC & MSE
// camera-stream signaling) and Assist-pipeline sockets. Destroying them (the old default
// branch) broke camera streams with ws close code 1006.
// threshold: don't spend CPU deflating small control chatter; the payloads that matter
// (get_states, registries, get_services) are hundreds of KB and compress roughly 10x.
// concurrencyLimit caps simultaneous zlib jobs so a burst of kiosks reconnecting at once
// cannot saturate the host. Deflate runs on libuv's threadpool, not the main loop.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: COMPRESS_WS ? { threshold: 1024, concurrencyLimit: 10 } : false,
});
server.on('upgrade', (req, socket, head) => {
  // A raw upgrade socket arrives with NO 'error' listener, and http-proxy only attaches one
  // once HA has answered 101 (see ws-incoming.js). Anything that errors in that window — an
  // HA restart resetting an in-flight camera/Assist stream, a kiosk abandoning a retry —
  // reaches Node as an unhandled 'error' event and killed the add-on outright. Claim it
  // first: this is the crash that turned "HA rebooted" into "the add-on is dead".
  socket.on('error', (e) => {
    logThrottled(`upgrade:${e.code || e.message}`, `ws upgrade socket error (${req.url}): ${e.message}`);
    socket.destroy();
  });
  if (req.url.startsWith('/api/websocket')) {
    // No USABLE allowlist — either none built yet (HA still booting) or one that came back
    // empty (every configured dashboard missing). Refusing is not just about cards showing
    // "unavailable": HA reads `set(msg["entity_ids"]) or None`, so forwarding an empty
    // entity_ids means NO filter, and the proxy would relay the entire firehose it exists to
    // prevent — enough to OOM it on a large instance. The frontend treats a refused upgrade
    // as an ordinary disconnect and retries, so kiosks heal once the allowlist is real.
    if (STRIP && (!ALLOW_READY || !ALLOW.size)) {
      logThrottled('not-ready', `refusing /api/websocket: ${ALLOW_READY ? 'allowlist is EMPTY — check the `dashboards` option' : 'allowlist not built yet (waiting for HA)'}`);
      // end(), not write()+destroy(): destroy() gives no flush guarantee, so the 503 could be
      // discarded and the client would see a bare connection drop instead.
      try {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      } catch { socket.destroy(); }
      return;
    }
    wss.handleUpgrade(req, socket, head, (browserWs) => bridge(browserWs));
  } else {
    // Keyed on the path, not req.url: camera stream URLs carry a per-request signature, so
    // keying on the whole thing would defeat the throttle (and grow the map) during a retry storm.
    logThrottled(`passthrough:${req.url.split('?')[0]}`, `ws upgrade passthrough -> HA: ${req.url}`);
    proxy.ws(req, socket, head);
  }
});

// `allow` is THIS connection's allowlist — one dashboard's, or the union when the client
// couldn't be attributed. Captured per bridge rather than read from the global, so two
// kiosks on different dashboards get genuinely different subscriptions.
function bridge(browserWs, allow = ALLOW) {
  const haWs = new WebSocket(HA_WS, { perMessageDeflate: true, maxPayload: 0 });
  const getStatesIds = new Set();
  const subEntityIds = new Set();   // subscribe_entities subs we injected the allowlist into
  const registryIds = new Map();    // request id -> which registry, to trim its result
  const resourceIds = new Set();    // lovelace/resources requests, to trim their result
  const queue = []; let haOpen = false;
  const toHA = (s) => { if (haOpen) haWs.send(s); else queue.push(s); };

  haWs.on('open', () => { haOpen = true; queue.forEach((s) => haWs.send(s)); queue.length = 0; });

  browserWs.on('message', (raw) => {
    let s = raw.toString(); let m;
    try { m = JSON.parse(s); } catch { return toHA(s); }
    if (STRIP && m && m.type === 'get_states') getStatesIds.add(m.id);
    if (STRIP && TRIM_REGISTRIES && m && REGISTRY_TYPES.has(m.type)) registryIds.set(m.id, REGISTRY_TYPES.get(m.type));
    if (STRIP && TRIM_RESOURCES && m && m.type === 'lovelace/resources') resourceIds.add(m.id);
    if (STRIP && m && m.type === 'subscribe_entities' && !m.entity_ids) {
      // Belt-and-braces to the upgrade gate: an empty entity_ids is NOT "subscribe to
      // nothing", it's "no filter" (HA: `set(msg["entity_ids"]) or None`). Sending one would
      // invert the add-on's entire purpose, so drop the connection instead.
      if (!allow.size) {
        logThrottled('empty-allow', 'ERROR: refusing subscribe_entities — the allowlist is empty, and forwarding that would stream EVERY entity. Check the `dashboards` option.');
        return close();
      }
      m.entity_ids = [...allow];           // HA now streams only this connection's allowlist
      subEntityIds.add(m.id);              // remember it, to defensively re-filter its events
      s = JSON.stringify(m);
    }
    // NB: `lovelace/config` is deliberately NOT used to re-attribute a live connection.
    //
    // It looks like the perfect signal — the frontend naming the dashboard it is about to
    // render — but a client fetching a dashboard's config does not mean it is DISPLAYING
    // that dashboard. Kiosk Satellite, for one, enumerates every dashboard's views at
    // startup, so a panel showing `basement-stairs-panel` requests the config of all five.
    // Acting on that flipped the stored hint to whichever dashboard was enumerated last and
    // recycled the socket to "follow" it, which produced a reconnect storm and then served
    // the panel the wrong dashboard's allowlist. Observed live, 2026-09-11.
    //
    // The page GET that precedes the websocket is the only signal that actually means "this
    // client is displaying this dashboard", so it is the only one used. The cost is that a
    // client-side navigation to a DIFFERENT dashboard keeps the old allowlist until the page
    // reloads; set `per_dashboard: false` if that matters more than the trimming does.
    if (m && m.type === 'unsubscribe_events' && m.subscription != null) subEntityIds.delete(m.subscription);
    toHA(s);
  });

  haWs.on('message', (raw) => {
    let s = raw.toString(); let m;
    try { m = JSON.parse(s); } catch { return safeSend(s); }
    if (STRIP && m && m.type === 'result' && getStatesIds.has(m.id) && Array.isArray(m.result)) {
      const before = m.result.length;
      m.result = m.result.filter((e) => allow.has(e.entity_id));
      getStatesIds.delete(m.id);
      s = JSON.stringify(m);
      log(`get_states trimmed ${before} -> ${m.result.length}`);
    }
    // Registry trimming. The entity registry is one row per entity for the WHOLE instance —
    // on a 9,553-entity install that is megabytes of JSON the kiosk parses on every load,
    // dwarfing the states we just trimmed to a few hundred. Cut it to the entities this
    // connection can actually see, plus the devices/areas those rows still reference so
    // names and area assignments keep resolving.
    // Note the guard is on `m.result` being an object of ANY shape, not on it being an
    // array: `list_for_display` answers with `{entity_categories, entities}`, and an
    // Array.isArray() guard here silently skipped the largest payload of the lot.
    if (STRIP && TRIM_REGISTRIES && m && m.type === 'result' && registryIds.has(m.id) && m.result && typeof m.result === 'object') {
      const kind = registryIds.get(m.id);
      registryIds.delete(m.id);
      const rowsOf = (r) => (Array.isArray(r) ? r.length : (Array.isArray(r?.entities) ? r.entities.length : -1));
      const before = rowsOf(m.result);
      m.result = trimRegistry(kind, m.result, allow);
      const after = rowsOf(m.result);
      if (after !== before) {
        s = JSON.stringify(m);
        logThrottled(`reg:${kind}`, `${kind} registry trimmed ${before} -> ${after}`);
      }
    }
    // Lovelace resources, trimmed to the ones this dashboard actually needs. Only ever for a
    // connection we attributed to a dashboard: an unattributed connection gets the union of
    // entities, and must likewise get every resource — guessing wrong here renders a card as
    // "Custom element doesn't exist", which is far worse than sending bytes it won't use.
    if (STRIP && TRIM_RESOURCES && m && m.type === 'result' && resourceIds.has(m.id) && Array.isArray(m.result)) {
      resourceIds.delete(m.id);
      const keep = RESOURCES_KEEP;
      if (keep?.size) {
        const before = m.result.length;
        m.result = m.result.filter((r) => keep.has(r?.url));
        if (m.result.length !== before) {
          s = JSON.stringify(m);
          logThrottled('resources', `lovelace resources trimmed ${before} -> ${m.result.length}`);
        }
      }
    }
    // Defensive egress filter (belt-and-suspenders): HA already trims to the injected
    // entity_ids, so this is normally a no-op. But if a future HA ever ignored that
    // filter, re-filter the subscribe_entities event payload to the allowlist here so
    // the full firehose can never leak to the browser. Compressed format: a=added,
    // c=changed (both dicts keyed by entity_id), r=removed (list of entity_ids).
    // (Adapted from PR #1 / DragonHunter274's homeassistant-entity-filter-proxy.)
    if (STRIP && m && m.type === 'event' && subEntityIds.has(m.id) && m.event) {
      const ev = m.event; let changed = false;
      for (const k of ['a', 'c']) {
        if (ev[k]) for (const eid of Object.keys(ev[k])) {
          if (!allow.has(eid)) { delete ev[k][eid]; changed = true; }
        }
      }
      if (Array.isArray(ev.r)) {
        const before = ev.r.length;
        ev.r = ev.r.filter((eid) => allow.has(eid));
        if (ev.r.length !== before) changed = true;
      }
      if (changed) s = JSON.stringify(m);
    }
    safeSend(s);
  });

  function safeSend(s) { try { if (browserWs.readyState === 1) browserWs.send(s); } catch {} }
  const close = () => { openBridges.delete(close); try { browserWs.close(); } catch {} try { haWs.close(); } catch {} };
  openBridges.add(close);            // so a grown allowlist can recycle this connection (#7)
  browserWs.on('close', close); browserWs.on('error', close);
  haWs.on('close', close);
  haWs.on('error', (e) => { logThrottled(`haws:${e.code || e.message}`, `HA ws error ${e.message}`); close(); });
}

// ---- boot ----
log(`ha-ws-trim-proxy v${VERSION} starting`);
log(`mode: ${inAddon ? 'add-on' : 'dev'} | target ${HA_BASE} | allowlist via ${ALLOW_WS_URL}`);
log(`options: trim_registries=${TRIM_REGISTRIES} compress_websocket=${COMPRESS_WS} trim_resources=${TRIM_RESOURCES}`);
// Listen FIRST, before HA is known to be reachable. The add-on and HA core restart together
// (host boot, a core update), and core can take minutes to answer — the proxy's job is to
// wait for it, not to exit. HTTP proxies through immediately (502 while HA is down, like any
// reverse proxy); /api/websocket is refused until the first allowlist lands, above.
server.listen(PORT, () => {
  log(`HA trim-proxy listening on :${PORT}  ->  ${HA_BASE}`);
  DASH_PATHS.forEach((p) => log(`  open: http://<host>:${PORT}/${p}`));
});
// A port we can't bind is a real config error (another add-on on :8099 — see issue #6) and
// worth exiting for; anything else the server surfaces is not worth dying over.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
    console.error(`fatal: cannot listen on :${PORT} (${e.code}) — set the add-on's \`port\` option to a free port`);
    process.exit(2);
  }
  logThrottled(`server:${e.code || e.message}`, `server error ${e.message}`);
});

// ALLOW / ALLOW_READY are already set at the point the first allowlist is built, so this only
// logs. The catch is not dead code: connect() runs synchronously inside the promise executor,
// so a malformed `allow_ws_url` throws `Invalid URL` right here — a config error worth dying
// on, but with a message rather than a raw stack.
startController()
  .then(() => log(`union allowlist for [${DASH_PATHS.join(', ')}]: ${ALLOW.size} entities (strip_entities=${STRIP})`))
  .catch((e) => { console.error('fatal: cannot start the control connection:', e.message); process.exit(2); });
