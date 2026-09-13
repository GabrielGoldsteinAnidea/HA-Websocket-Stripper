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
import crypto from 'node:crypto';
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
const VERSION = '0.3.0';

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

// ---- per-connection scoping (optional; off by default) ----
// The allowlist is normally the UNION of every configured dashboard, so each kiosk receives
// what ALL of them need. With more than a couple of dashboards that dominates: adding one grows
// what every other kiosk gets, and the trim you measured on day one quietly erodes.
//
// The websocket cannot be attributed to a dashboard — it is a separate connection from the page
// load and carries no path. It CAN be attributed to a user: the browser's `auth` frame crosses
// this proxy, and one `auth/current_user` call answers who it belongs to. So the map is
// user -> dashboards, and anything unrecognised falls back to the union, i.e. to the old
// behaviour. Nothing here can make a connection see LESS than it would have without the option
// on, except when a scope is deliberately configured for it.
const SCOPING = !!(OPT.scope_per_connection ?? (process.env.SCOPE_PER_CONNECTION === '1'));
// user id -> [url_path, ...]. Keyed on the ID: a display name does not survive a rename, and a
// scope that silently stops matching just falls back to the union, which looks like nothing
// happening rather than like a fault.
const SCOPE_BY_USER = new Map();
// Dev/CLI mode takes the same structure as JSON, so the option is reachable without an
// options.json — every other option already has an env fallback.
let scopeRows = Array.isArray(OPT.scope_by_user) ? OPT.scope_by_user : null;
if (!scopeRows && process.env.SCOPE_BY_USER) {
  try { scopeRows = JSON.parse(process.env.SCOPE_BY_USER); }
  catch (e) { console.error(`ERROR: SCOPE_BY_USER is not valid JSON (${e.message}) — ignoring it`); }
}
for (const row of (Array.isArray(scopeRows) ? scopeRows : [])) {
  const user = String(row?.user || '').trim();
  const dashes = toList(row?.dashboards).filter(Boolean);
  if (!user || !dashes.length) continue;
  SCOPE_BY_USER.set(user, [...new Set([...(SCOPE_BY_USER.get(user) || []), ...dashes])]);
}
// A scope naming a dashboard that is not served is the failure this warns about: it resolves to
// an empty set, and an empty set can never be forwarded (that means "no filter" to HA), so the
// connection would fall back to the union and the scope would do nothing at all — silently.
if (SCOPING) {
  for (const [user, dashes] of SCOPE_BY_USER) {
    const unknown = dashes.filter((d) => !DASH_PATHS.includes(d));
    if (unknown.length) {
      console.error(`WARNING: scope_by_user[${user}] names dashboard(s) not in \`dashboards\`: ${unknown.join(', ')} — they resolve to nothing. Add them to \`dashboards\` or remove them here.`);
    }
  }
}

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

let ALLOW = new Set();
// url_path -> that dashboard's own allowlist. Only consulted when SCOPING is on.
let PER_DASH = new Map();
// Every live browser <-> HA bridge, so a grown allowlist can reach already-open pages
// (issue #7). Keyed by SCOPE — a url_path, or UNION_SCOPE for a connection on the union — so a
// dashboard edit only recycles the connections it actually affects. See refreshOpenConnections().
const UNION_SCOPE = ' union';        // cannot collide with a url_path
const openBridges = new Map();            // scopeKey -> Set<closeFn>
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

// `always_forward` / `never_forward`, applied to ONE set. Called for the union and, when
// scoping is on, for each dashboard's own set — so a scoped connection still receives the
// always_forward entities. That matters more than it looks: those are typically the entities
// that appear on NO dashboard (a kiosk-health helper, a command channel), which is exactly why
// they need forcing, and a scoped connection has an even smaller set to find them in.
// `never` is applied after `always`, so never wins. Order preserved from the original.
function applyOverrides(set, realIds) {
  const base = set.size;
  ALWAYS.forEach((r) => {
    if (r.literal) set.add(r.literal);
    else realIds.forEach((eid) => { if (r.re.test(eid)) set.add(eid); });
  });
  const afterAlways = set.size;
  [...set].forEach((eid) => { if (matchesAny(NEVER, eid)) set.delete(eid); });
  return { base, added: afterAlways - base, removed: afterAlways - set.size };
}

// Build the allowlist over all configured dashboards using an authed rpc().
// Returns BOTH the union and each dashboard's own set. The per-dashboard sets were always
// computed here — they were just discarded into the union — so keeping them costs nothing and
// is what per-connection scoping selects from.
async function buildAllow(rpc, renderTemplate) {
  const states = await rpc({ type: 'get_states' });
  const realIds = states.map((s) => s.entity_id);
  const registries = await fetchRegistries(rpc);
  const union = new Set();
  const per = new Map();
  let failed = 0;
  for (const p of DASH_PATHS) {
    try {
      const cfg = await rpc({ type: 'lovelace/config', url_path: p });
      const tpls = await renderTemplates(cfg, renderTemplate);
      const set = allowlistFor(cfg, states, registries, tpls);
      log(`  ${p}: ${set.size} entities`);
      set.forEach((e) => union.add(e));
      applyOverrides(set, realIds);
      per.set(p, set);
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
  const ov = applyOverrides(union, realIds);
  log(`overrides: base ${ov.base}, +always ${ov.added}, -never ${ov.removed}`);
  if (SCOPING) {
    const sizes = [...per.values()].map((s) => s.size).sort((a, b) => a - b);
    if (sizes.length) {
      log(`per-connection scoping ON: ${SCOPE_BY_USER.size} user scope(s); per-dashboard min ${sizes[0]}, max ${sizes[sizes.length - 1]} vs union ${union.size}`);
    }
  }
  return { union, per };
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
function applyAllow(next, why, { merge = false } = {}) {
  let union = next.union;
  let per = next.per;
  if (merge) {
    union = new Set([...ALLOW, ...union]);
    per = new Map([...per].map(([p, s]) => [p, new Set([...(PER_DASH.get(p) || []), ...s])]));
    for (const [p, s] of PER_DASH) if (!per.has(p)) per.set(p, s);   // a dashboard that failed this round
  }
  const added = [...union].filter((e) => !ALLOW.has(e)).sort();
  const removed = [...ALLOW].filter((e) => !union.has(e)).sort();
  // Which SCOPES grew, so only the connections on those get recycled (see
  // refreshOpenConnections). Computed before the swap, against the previous per-dashboard sets.
  const grown = new Set();
  for (const [p, s] of per) {
    const before = PER_DASH.get(p);
    if (!before || [...s].some((e) => !before.has(e))) grown.add(p);
  }
  if (added.length) grown.add(UNION_SCOPE);
  ALLOW = union;
  PER_DASH = per;
  const fmt = (a) => (a.length > 25 ? `${a.slice(0, 25).join(', ')} …(+${a.length - 25} more)` : a.join(', '));
  log(`allowlist ${why}: ${ALLOW.size} entities (+${added.length} -${removed.length})`);
  if (added.length) log(`  +added: ${fmt(added)}`);
  if (removed.length) log(`  -removed: ${fmt(removed)}`);
  if (!added.length && !removed.length) log('  (no change)');
  if (grown.size) refreshOpenConnections(grown);
}

// `subscribe_entities` is sent ONCE per connection and HA has no way to amend a live
// subscription, so a recompute only ever affected NEW connections — an already-open kiosk
// kept streaming its original entity list until someone reloaded the tab (issue #7).
// Dropping the browser socket fixes that: the HA frontend treats it as an ordinary
// disconnect, reconnects on its own, and re-subscribes against the current allowlist.
// Only on GROWTH. A shrink means the open page is carrying entities it no longer needs,
// which is harmless — and churning every kiosk over a removal would be a bad trade.
//
// Only the SCOPES that grew. Under a global union any growth anywhere is growth for everyone,
// so a registry event — a device renamed, a label moved, an entity added somewhere unrelated —
// recycles every open kiosk at once. Measured on a 50-dashboard fleet: 8 whole-fleet reconnect
// storms in 76 minutes, and 16 of 20 recomputes came from registry churn rather than from
// anybody editing a dashboard. With scoping on, a dashboard edit reaches the kiosks showing
// that dashboard and nobody else.
function refreshOpenConnections(grown) {
  if (!STRIP || !openBridges.size) return;
  let n = 0;
  for (const [scope, set] of openBridges) {
    if (!grown.has(scope)) continue;
    n += set.size;
    for (const close of [...set]) { try { close(); } catch {} }
  }
  if (n) log(`  reconnecting ${n} open dashboard connection(s) to pick up the new entities`);
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
              ALLOW = next.union; PER_DASH = next.per;
              settled = true; ALLOW_READY = true; resolve(ALLOW);
            } else applyAllow(next, 'recomputed (reconnect)', { merge: true });
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
const proxy = httpProxy.createProxyServer({ target: HA_BASE, changeOrigin: true, ws: false, autoRewrite: true, xfwd: true });
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
const server = http.createServer((req, res) => proxy.web(req, res));

// ---- websocket upgrades ----
// We intercept ONLY /api/websocket (the entity firehose) to trim it. EVERY other ws
// upgrade passes straight through to HA — notably /api/webrtc/ws (go2rtc / WebRTC & MSE
// camera-stream signaling) and Assist-pipeline sockets. Destroying them (the old default
// branch) broke camera streams with ws close code 1006.
const wss = new WebSocketServer({ noServer: true });
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

// ---- who does this connection belong to? (per-connection scoping) ----
// HA rejects a message whose id is not greater than the highest seen on that connection
// (`id_reuse`), so the proxy CANNOT ask `auth/current_user` on the browser's own socket: a low
// id collides with the frontend's sequence, and a high id poisons every later browser message
// for the life of the connection. It asks on a socket of its own instead, using the token it
// just watched cross the handshake, and closes it again.
//
// AT THE HANDSHAKE, NEVER LATER. An access token is good for 30 minutes, but HA never re-checks
// one on an already-open socket — so a kiosk page that has been up for hours holds a long-dead
// token beside a perfectly healthy connection (measured: 3,469 s past expiry). The token is
// guaranteed valid at exactly one moment, when the browser sends it, because the frontend
// refreshes an expired one before it connects. Re-resolving later would fail, fall back to the
// union, and look exactly like a kiosk that was never mapped.
const RESOLVE_TIMEOUT = 5000;
const USER_CACHE_TTL = 10 * 60 * 1000;      // deliberately under the 30 min token lifetime
const userCache = new Map();                // sha256(token) -> { user, at }

function resolveUser(token) {
  // Keyed on a HASH. The cache holds the ANSWER, not the credential, so nothing here can
  // replay a token and an expired one cannot linger in memory as a usable secret.
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const hit = userCache.get(key);
  if (hit && Date.now() - hit.at < USER_CACHE_TTL) return Promise.resolve(hit.user);
  return new Promise((resolve) => {
    let ws; let done = false;
    const finish = (user) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { if (ws) ws.close(); } catch { /* already gone */ }
      if (user) userCache.set(key, { user, at: Date.now() });
      resolve(user);
    };
    const timer = setTimeout(() => finish(null), RESOLVE_TIMEOUT);
    timer.unref?.();
    try { ws = new WebSocket(HA_WS, { handshakeTimeout: RESOLVE_TIMEOUT }); }
    catch { return finish(null); }
    ws.on('error', (e) => { logThrottled(`resolve:${e.code || e.message}`, `user lookup failed (${e.message}) — connection falls back to the union allowlist`); finish(null); });
    ws.on('close', () => finish(null));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      if (m.type === 'auth_invalid') return finish(null);
      // `auth/current_user` needs no admin rights — it is what populates `hass.user` in the
      // frontend for every user, including a non-admin kiosk account.
      if (m.type === 'auth_ok') return ws.send(JSON.stringify({ id: 1, type: 'auth/current_user' }));
      if (m.id === 1 && m.type === 'result') finish((m.success && m.result && m.result.id) || null);
    });
  });
}

// The allowlist for a resolved user: the union of the dashboards mapped to them.
// EVERY fallback lands on the global union, never on an empty set — HA reads an empty
// entity_ids as "no filter", so an empty scope would relay the very firehose this exists to
// prevent. An unmapped user (someone's laptop, an admin, a kiosk not in the map) therefore
// behaves exactly as it did before the option existed.
function scopeFor(userId) {
  if (!SCOPING || !userId) return { keys: [UNION_SCOPE], allow: ALLOW };
  const dashes = SCOPE_BY_USER.get(userId);
  if (!dashes || !dashes.length) return { keys: [UNION_SCOPE], allow: ALLOW };
  const allow = new Set();
  for (const d of dashes) for (const e of (PER_DASH.get(d) || [])) allow.add(e);
  if (!allow.size) return { keys: [UNION_SCOPE], allow: ALLOW };
  return { keys: dashes, allow };
}

function bridge(browserWs) {
  const haWs = new WebSocket(HA_WS, { perMessageDeflate: true, maxPayload: 0 });
  const getStatesIds = new Set();
  const subEntityIds = new Set();   // subscribe_entities subs we injected the allowlist into
  const queue = []; let haOpen = false;
  const toHA = (s) => { if (haOpen) haWs.send(s); else queue.push(s); };

  haWs.on('open', () => { haOpen = true; queue.forEach((s) => haWs.send(s)); queue.length = 0; });

  // What THIS connection is filtered against. Starts as the union — which is what it would have
  // received anyway — and narrows only if the user resolves to a configured scope.
  let allow = ALLOW;
  let scopeKeys = [UNION_SCOPE];
  let scopeSettled = !SCOPING;        // nothing to wait for when the option is off
  let resolveStarted = false;
  const held = [];
  let holdTimer = null;

  // Only these two need the scope. But holding ONE message means holding EVERY message after
  // it: HA requires ids to increase, so releasing a held frame after a later one has already
  // gone through would make HA reject the held one with `id_reuse` — the frontend would see its
  // own `get_states` fail for no visible reason. The hold is a barrier, not a filter.
  const needsScope = (m) => !!m && (m.type === 'get_states'
    || (m.type === 'subscribe_entities' && !m.entity_ids));

  function onUser(userId) {
    if (scopeSettled) return;
    clearTimeout(holdTimer);
    const sc = scopeFor(userId);
    allow = sc.allow;
    setScopeKeys(sc.keys);
    if (sc.keys[0] !== UNION_SCOPE) {
      log(`scoped connection: user ${String(userId).slice(0, 8)}… -> ${sc.keys.join(', ')} (${allow.size} entities, union is ${ALLOW.size})`);
    }
    scopeSettled = true;
    for (const raw of held.splice(0)) forwardBrowser(raw);
  }

  function forwardBrowser(raw) {
    let s = raw.toString(); let m;
    try { m = JSON.parse(s); } catch { return toHA(s); }
    if (STRIP && m && m.type === 'get_states') getStatesIds.add(m.id);
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
    if (m && m.type === 'unsubscribe_events' && m.subscription != null) subEntityIds.delete(m.subscription);
    toHA(s);
  }

  browserWs.on('message', (raw) => {
    if (!SCOPING) return forwardBrowser(raw);
    let m; try { m = JSON.parse(raw.toString()); } catch { m = null; }
    // Start the lookup the moment the token crosses — that overlaps the browser's own auth
    // round trip and the frontend's startup, so the answer is normally in hand before it
    // subscribes. The frame itself is relayed untouched and immediately; auth is never delayed.
    if (!resolveStarted && m && m.type === 'auth' && m.access_token) {
      resolveStarted = true;
      resolveUser(m.access_token).then(onUser, () => onUser(null));
      return forwardBrowser(raw);
    }
    if (!scopeSettled && (held.length || needsScope(m))) {
      // Bounded even if the client never authenticates or HA never answers: the connection
      // must not stall on a lookup, so give up and use the union.
      if (!held.length) holdTimer = setTimeout(() => onUser(null), RESOLVE_TIMEOUT);
      held.push(raw);
      return;
    }
    forwardBrowser(raw);
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

  // Registered under EVERY dashboard in its scope (or under UNION_SCOPE), so growth in any one
  // of them recycles this connection and growth anywhere else does not.
  const unregister = () => {
    for (const k of scopeKeys) {
      const set = openBridges.get(k);
      if (!set) continue;
      set.delete(close);
      if (!set.size) openBridges.delete(k);
    }
  };
  const close = () => {
    clearTimeout(holdTimer);
    unregister();
    try { browserWs.close(); } catch {}
    try { haWs.close(); } catch {}
  };
  function setScopeKeys(keys) {
    unregister();
    scopeKeys = keys;
    for (const k of scopeKeys) {
      if (!openBridges.has(k)) openBridges.set(k, new Set());
      openBridges.get(k).add(close);
    }
  }
  setScopeKeys(scopeKeys);           // so a grown allowlist can recycle this connection (#7)
  browserWs.on('close', close); browserWs.on('error', close);
  haWs.on('close', close);
  haWs.on('error', (e) => { logThrottled(`haws:${e.code || e.message}`, `HA ws error ${e.message}`); close(); });
}

// ---- boot ----
log(`ha-ws-trim-proxy v${VERSION} starting`);
log(`mode: ${inAddon ? 'add-on' : 'dev'} | target ${HA_BASE} | allowlist via ${ALLOW_WS_URL}`);
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
