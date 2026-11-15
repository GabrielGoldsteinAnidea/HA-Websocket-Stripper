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
// Env (dev): HA_TOKEN, HA_BASE (default http://homeassistant.mgmt:8123), PORT (9123),
//   DASH_PATHS (comma/newline list), ALWAYS_FORWARD, NEVER_FORWARD (literals or /regex/),
//   STRIP_ENTITIES (default 1; 0 = passthrough for A/B compare),
//   ALLOW_WS_URL / ALLOW_TOKEN (override the allowlist-precompute connection).

import http from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import fs from 'node:fs';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { createProxyServer } from 'httpxy';
import { WebSocketServer, WebSocket } from 'ws';
import { extractEntities, collectTemplates, expandGroupMembers, buildRegistryCtx, splitDeviceEntities, deviceEntityIds } from './lovelace_extract.mjs';
import * as stats from './stats.mjs';
import * as history from './history.mjs';
import { classify, normalizeIp, isPrivate } from './route.mjs';
import { createDiscovery, DEFAULT_SERVICES, preferredRow } from './mdns.mjs';
import { certDaysLeft } from './metrics.mjs';
import { createPublisher as createEsphomePublisher } from './esphome_api.mjs';
import * as httpLog from './http_log.mjs';
import { readStore, writeStore, adopt, release, effectiveOptions, ownership, isKnownOption, valueError, BOOTSTRAP_KEYS, EDITABLE_KEYS, LEGACY_KEYS, REMOVED_KEYS, legacyNameFor, OPTIONS, SECTIONS } from './config_store.mjs';
import { resourceInvariantProblems } from './resource_invariants.mjs';
import { readPauses, writePauses, pauseUser, resumeUser, sweep as sweepPauses, pausedUntil, pausedForUser, anyActive as anyPauseActive, listPauses, msUntilEndOfDay, ADMINS, isRoleKey, MAX_PAUSE_MS } from './pause.mjs';

// Compiled bytecode is cached between runs, which is worth having because this add-on restarts
// far more often than a typical service — every config change, every rebuild — and each restart
// is a window in which a panel that reconnects before it re-fetches its page falls back to the
// union allowlist.
//
// It is turned on by NODE_COMPILE_CACHE in the Dockerfile rather than by module.enableCompileCache()
// here, and that is not a style preference. This is an ES module: every static import below is
// evaluated BEFORE this file's body runs, so a call placed here — anywhere here — happens after
// the last thing it could have cached, and silently caches nothing. The environment variable is
// read before any of it is compiled. Measured, not assumed: in-body call 0 files cached, env var
// 2 (see test/runtime.test.mjs).
//
// The other half is in the shutdown handler at the end of this file: Node writes the cache at a
// normal exit, and the SIGTERM the Supervisor sends is not one.

// ---- config (add-on options.json, overlaid by anything the panel owns) ----
// `/data` on a real install; `CONFIG_DIR` otherwise, which is what lets a dev run — and the test
// suite — boot with an options FILE rather than only with environment variables. That gap is not
// academic: a boot-time notice about a retired option crashed every install that had one, and
// could not have crashed anything here, because nothing here could set one.
const CONFIG_DIR = fs.existsSync('/data') ? '/data' : (process.env.CONFIG_DIR || null);
function loadOptions() {
  const p = CONFIG_DIR ? `${CONFIG_DIR}/options.json` : null;
  try { if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error(`could not read ${p}:`, e.message); }
  return {};
}
const YAML_OPT = loadOptions();
// Warnings are collected rather than logged here: log levels are derived from the options this
// very call is producing, so nothing can be written through log()/warn() yet.
const CONFIG_WARNINGS = [];
let CONFIG_STORE = CONFIG_DIR
  ? readStore(CONFIG_DIR, (m) => CONFIG_WARNINGS.push(m))
  : { version: 1, managed: {}, history: [] };
const OPT = effectiveOptions(YAML_OPT, CONFIG_STORE);
// An option a past version had. Still accepted by the schema so an existing configuration stays
// valid on update — Supervisor rejects a key it does not know — but nothing reads it, and someone
// whose sensors have moved deserves to be told where. Through CONFIG_WARNINGS, which exists
// precisely because logging is not configured yet at this point in the file.
for (const [key, why] of REMOVED_KEYS) {
  if (YAML_OPT[key] !== undefined) CONFIG_WARNINGS.push(`${key} no longer does anything: ${why}. Remove it from the add-on configuration.`);
}
const inAddon = !!process.env.SUPERVISOR_TOKEN;
// Bump together with config.yaml `version`. Logged at boot so the add-on log shows exactly
// which code is running — the only reliable way to tell a Rebuild actually picked up changes
// (a local add-on bakes in whatever files are in the host's /addons folder, not GitHub).
const VERSION = '2026.11.02.1';

const toList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]/))
  .map((s) => String(s).trim()).filter(Boolean);

const HA_BASE = process.env.HA_BASE || OPT.ha_base || (inAddon ? 'http://homeassistant:8123' : 'http://homeassistant.mgmt:8123');
const HA_WS = HA_BASE.replace(/^http/, 'ws') + '/api/websocket';     // browser ws relay target
// Port precedence: PORT env (dev) > `port` add-on option > 9123. Under host_network the
// add-on binds this directly on the host, so the option is the only way to move it off
// 9123 (the Network tab can't remap a host-network port) — see issue #6.
// `port` and `stats_port` were the original names and both aged badly: with two listeners,
// a bare `port` does not say which, and the second one stopped being only about stats several
// releases ago. They are now `proxy_port` (what browsers and wall panels connect to) and
// `mgmt_port` (where the management console and its JSON API live).
//
// Both old names keep working, permanently rather than deprecated-then-removed: `port` is
// upstream's and `stats_port` is in every config written before this. New name first, old name
// second, default last — so an install that sets neither is unaffected and an install that sets
// the old one never notices the rename.
const PORT = parseInt(process.env.PROXY_PORT || process.env.PORT
  || OPT.proxy_port || OPT.port || '9123', 10);
// The Ingress panel + JSON API live on their own port, deliberately NOT on PORT: everything
// on PORT is the proxied Home Assistant namespace, and a dashboard whose url_path collided
// with a stats path would be a genuinely confusing failure. Fixed rather than an option
// because Supervisor reads `ingress_port` from config.yaml at install time — an option the
// user could change would silently break the sidebar panel.
// The port Supervisor routes Ingress to. It is add-on METADATA, fixed in config.yaml at install
// time, and this process cannot read it — so it is duplicated here and pinned by a test in
// test/config.test.mjs. 9122 sits next to the proxy's own 9123; 8100 (the old value) is a popular
// enough port to collide with, and under host_network a collision is not cosmetic: the server
// cannot bind, so Ingress has nothing to reach either.
// Where a panel asks about itself. A constant because two things have to agree on it: this
// server, and every panel that was told the path — so it is quoted in the docs from here.
const CLIENT_INFO_PATH = '/strimmer/client.json';
// The path this endpoint had before the app was renamed. It keeps answering, permanently rather
// than deprecated-then-removed: panels in the wild — ha-paneld, Kiosk Satellite — were written
// against it, and a renamed app that silently stops answering their status check is a worse
// outcome than one extra string here.
const CLIENT_INFO_PATH_LEGACY = '/stripper/client.json';
const isClientInfoPath = (url) => {
  const path = String(url || '').split('?')[0];
  return path === CLIENT_INFO_PATH || path === CLIENT_INFO_PATH_LEGACY;
};

// Who may reach the panel status endpoint, checked BEFORE the token.
//
// Most callers are a wall panel a few metres away; almost none are legitimately remote. Refusing
// a remote one early means a caller from the internet cannot make this add-on open a websocket to
// Home Assistant to validate a token — it never gets that far.
//
// HOW MUCH THIS IS WORTH, honestly. Three signals, in descending order of trust:
//
//   1. Cloudflare's own headers. The edge sets cf-connecting-ip / cf-ray and a client cannot
//      remove them, so "came via Cloudflare" is reliable.
//   2. The peer address. The TCP source cannot be forged, so a request arriving directly from a
//      public address is reliably remote.
//   3. The resolved client address, which comes from X-Forwarded-For. The LEFTMOST entry is
//      whatever the original caller claimed, so a remote caller behind a reverse proxy that
//      appends rather than replaces can assert a private address and look local.
//
// So this narrows who may TRY. The token is still the boundary, and the comment above the auth
// block still holds. Anything else would be security theatre with a configuration page.
const CLIENT_API_ACCESS = (() => {
  const v = String(OPT.client_api_access ?? process.env.CLIENT_API_ACCESS ?? 'lan').toLowerCase();
  return ['lan', 'any', 'off'].includes(v) ? v : 'lan';
})();
const CLIENT_API_ALLOW = toList(OPT.client_api_allow ?? process.env.CLIENT_API_ALLOW)
  .map((c) => ({ raw: c, cidr: parseCidr(c), ip: normalizeIp(c) }))
  .filter((r) => r.cidr || r.ip);

// Returns null when the request may proceed, or a reason to refuse it.
function clientApiRefusal(req, rt) {
  if (CLIENT_API_ACCESS === 'off') return 'the panel status API is disabled';
  // An explicit allow wins over everything, including the Cloudflare check: someone who lists an
  // address has said what they mean more clearly than any heuristic here can.
  const hop = normalizeIp(req.socket?.remoteAddress);
  for (const a of CLIENT_API_ALLOW) {
    if (a.cidr ? (a.cidr(rt.ip) || a.cidr(hop)) : (a.ip === rt.ip || a.ip === hop)) return null;
  }
  if (CLIENT_API_ACCESS === 'any') return null;
  if (rt.route === 'cloudflare') return 'this endpoint does not answer requests that came through Cloudflare';
  if (hop && !isPrivate(hop)) return 'this endpoint only answers requests from the local network';
  if (rt.origin === 'internet') return 'this endpoint only answers requests from the local network';
  return null;
}
const INGRESS_PORT = 9122;
// Configurable, but only the default can be reached over Ingress — see the warning at listen().
const STATS_PORT = parseInt(process.env.MGMT_PORT || process.env.STATS_PORT
  || OPT.mgmt_port || OPT.stats_port || INGRESS_PORT, 10);
// Where the Dockerfile's HEALTHCHECK learns which port to probe. It cannot work it out for
// itself: as an add-on the config arrives in /data/options.json, so STATS_PORT is NOT in the
// container's environment and a shell default in the Dockerfile is the ONLY value that ever
// applies. That default was a second copy of the one above, and when this moved 8100 -> 9122 the
// copy stayed behind: the probe hit a closed port, Docker marked the container unhealthy, and the
// watchdog restarted it every ~85 seconds while Supervisor never reported `started` — so Ingress
// served "The app is starting" indefinitely. Writing the bound port removes the duplicate rather
// than correcting it. Absent file means the stats server never bound, which is genuinely
// unhealthy, so the probe is right to fail on it.
const STATS_PORT_FILE = process.env.STATS_PORT_FILE || '/tmp/stats-port';
// Deliberately env-only, not a config.yaml option: adding to the schema forces users through
// a Supervisor store refresh before the new key is even accepted, which is a lot of friction for
// a value almost nobody should change. The default suits every normal setup; this exists so the
// timeout is testable at a sane duration, and as an escape hatch for a pathologically slow
// upstream. 0 disables it.
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || '120000', 10);
// How long one command on the CONTROL connection may go unanswered. Env-only for the same
// reasons as PROXY_TIMEOUT_MS. Nothing bounded this before: handshakeTimeout covers only the
// upgrade, so a Home Assistant that answered the handshake and then wedged on `get_states` left
// the rebuild awaiting forever — and with it the `rebuilding` flag, so no later dashboard edit
// could ever trigger another. The add-on sat up, serving the last allowlist, logging nothing.
// Generous, because a full get_states on a large instance is legitimately slow; it only has to be
// shorter than "forever". On expiry the socket is dropped, so the ordinary reconnect path rebuilds.
const CONTROL_RPC_TIMEOUT_MS = parseInt(process.env.CONTROL_RPC_TIMEOUT_MS || '60000', 10);
// The least time between two rebuilds that REGISTRY events cause. The field filter
// (registryEventMatters) is the real defence against a rebuild storm; this is the backstop for
// whatever it does not recognise — an integration rewriting a field that does matter, every few
// seconds. A dashboard edit, a resource change and a pin are never held: someone is watching for
// those. Env-only, like the timeouts above, and 0 turns it off.
const REGISTRY_REBUILD_MIN_MS = parseInt(process.env.REGISTRY_REBUILD_MIN_MS || '30000', 10);
let LAST_REBUILD_AT = 0;
// Backpressure on the browser leg. A wall panel on weak wifi that stops reading — or a phone
// that went to sleep mid-stream — leaves everything sent to it queued in THIS process, and nothing
// stopped reading from Home Assistant on its behalf, so the queue had no bound but the panel's
// eventual TCP reset. Home Assistant itself drops a client that falls 4,096 messages behind. Here
// the HA-side socket is paused instead once the browser's send queue passes the high mark, and
// resumed once it drains to a quarter of that; a client that makes no progress at all for the
// stall window is closed, since it will reconnect fresh and re-subscribe, which is cheaper than
// holding its backlog. Sized in bytes because that is what the memory cost is.
const BP_HIGH_BYTES = parseInt(process.env.BACKPRESSURE_HIGH_BYTES || String(8 * 1024 * 1024), 10);
const BP_LOW_BYTES = Math.max(1, Math.floor(BP_HIGH_BYTES / 4));
const BRIDGE_PING_MS = parseInt(process.env.BRIDGE_PING_MS || '30000', 10);   // liveness ping on both bridge legs
const BP_STALL_MS = parseInt(process.env.BACKPRESSURE_STALL_MS || '60000', 10);
// The largest frame a BROWSER may send us. `ws` defaults a server to 100MB, and every text frame
// from a browser is JSON.parse'd on the one event loop that relays every other panel — so one
// client could block everything for as long as that parse takes.
//
// It is an amplification, not just a large upload. permessage-deflate is negotiated on this leg,
// and `ws` inflates up to maxPayload before anything can look at the result: measured, a 100MB
// JSON payload compresses to 109KB on the wire, parses in ~130ms, and can be repeated as fast as
// the client likes. About 1000:1, from any client that can open the socket.
//
// 4MB is far above anything legitimate. Commands are bytes; a voice satellite's audio chunks are
// kilobytes; the largest real frame is a dashboard save (`lovelace/config/save`), which is
// hundreds of KB for a big dashboard. At 4MB a parse is ~5ms. `ws` answers an oversized frame with
// close code 1009 and drops the connection, which is the right outcome — nothing legitimate is
// near it. The HA leg keeps `maxPayload: 0`: Home Assistant genuinely does send 14MB registry
// frames, and that side is not an untrusted peer.
const BROWSER_MAX_PAYLOAD = parseInt(process.env.BROWSER_MAX_PAYLOAD_BYTES || String(4 * 1024 * 1024), 10);
const DASH_PATHS = toList(OPT.dashboards ?? (process.env.DASH_PATHS || process.env.DASH_PATH));
// trim_entities: true (default) = inject the allowlist so HA streams only needed entities.
//   false = pass the websocket straight through (full firehose) for A/B comparison.
//
// `strip_entities` is the original name and is still read, because it is in every config written
// before the rename and dropping it would silently turn trimming back on for anyone who had
// deliberately turned it off — the one setting where a silent revert is most visible.
const STRIP = OPT.trim_entities !== undefined ? !!OPT.trim_entities
  : OPT.strip_entities !== undefined ? !!OPT.strip_entities
  : (process.env.TRIM_ENTITIES ?? process.env.STRIP_ENTITIES ?? process.env.TRIM) !== '0';
// HA's own websocket negotiates permessage-deflate. `ws` does NOT enable it server-side by
// default, so simply putting this proxy in front of HA silently REMOVED compression from the
// browser leg — the kiosk went from deflated frames to plaintext JSON over wifi. Default on
// to restore what clients had before the proxy existed; the cost is deflate CPU on the HA
// host, which is why it can be turned off on very weak hardware.
const COMPRESS_WS = OPT.compress_websocket !== undefined ? !!OPT.compress_websocket
  : (process.env.COMPRESS_WS ?? '1') !== '0';

// `get_services` is every service of every integration, and it is sent on every page load:
// 193KB across 115 domains on the instance this was built against, of which only 45 domains
// had any entity at all. The frontend needs it for service pickers and the automation
// editor, so trimming it to the domains a connection can see is the same trade as
// trim_resources — fine for a kiosk, visibly lossy in the admin UI. Off by default.
// repairs/list_issues is the admin "Repairs" panel's backlog. A kiosk never renders it, and it
// costs ~27KB on every page load. Off by default like the other lossy trims: an admin browsing a
// trimmed dashboard would stop seeing repair notifications, which is a real thing to lose.
// Translations are ~247KB per page load and the largest untrimmed payload in the boot path.
// Measured on a live instance: 5,359 keys, 432KB, and 100% of them `component.<domain>` across
// 69 domains — tuya_local alone carries 823 keys on an instance whose panels show none of it.
//
// OFF by default and the most lossy trim here. A missing translation does not degrade quietly
// like a missing service: it renders its raw key ON the dashboard, so a wall panel shows
// `component.light.entity_component._.state.on` where "On" should be.
const TRIM_TRANSLATIONS = OPT.trim_translations !== undefined ? !!OPT.trim_translations
  : (process.env.TRIM_TRANSLATIONS ?? '0') !== '0';
// Payloads whose structure is reported once to stats so a trim can be designed from the real
// thing. Purely observational and costs one shallow walk per reply.
const SHAPE_TYPES = new Set(['frontend/get_themes', 'custom_icons/list', 'frontend/get_icons']);
// Home Assistant sends every installed theme to every client: 10 themes and 28,138 bytes on the
// instance this was built against, of which a panel renders exactly one. Off by default and
// visibly lossy if it gets it wrong — an unthemed dashboard is obvious.
const TRIM_THEMES = OPT.trim_themes !== undefined ? !!OPT.trim_themes
  : (process.env.TRIM_THEMES ?? '0') !== '0';
const TRIM_REPAIRS = OPT.trim_repairs !== undefined ? !!OPT.trim_repairs
  : (process.env.TRIM_REPAIRS ?? '0') !== '0';
const TRIM_SERVICES = OPT.trim_services !== undefined ? !!OPT.trim_services
  : (process.env.TRIM_SERVICES ?? '0') !== '0';

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
// Requires trim_resources: the whole decision is "did the resource trim already drop this?", so
// with the resource trim off there is no decision to apply and nothing is ever removed.
const TRIM_EXTRA_MODULES = (OPT.trim_extra_modules !== undefined ? !!OPT.trim_extra_modules
  : (process.env.TRIM_EXTRA_MODULES ?? '0') !== '0') && TRIM_RESOURCES;
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
// `battery` or `sensor:battery`: forward every entity whose device_class matches. For cards that
// discover entities by scanning hass.states at runtime, which no config walk can predict. Matched
// against live state at each rebuild, so a newly added battery sensor joins on the next one.
const CLASS_RULES = toList(OPT.always_forward_device_class ?? process.env.ALWAYS_FORWARD_DEVICE_CLASS)
  .map((t) => { const [a, b] = t.toLowerCase().split(':'); return b === undefined ? { cls: a } : { dom: a, cls: b }; });
let CLASS_IDS = new Set();   // set by each build, read by applyOverrides
function deviceClassIds(states) {
  const out = new Set();
  if (!CLASS_RULES.length) return out;
  for (const s of states) {
    const cls = s.attributes?.device_class;
    if (cls && CLASS_RULES.some((r) => r.cls === cls && (!r.dom || s.entity_id.startsWith(`${r.dom}.`)))) out.add(s.entity_id);
  }
  return out;
}
// Set by the control connection once it is up. Lets the stats panel ask for a rebuild after
// pinning something, so a pin takes effect immediately instead of waiting for a restart.
//
// Deliberately narrow. General config hot-reload was considered and rejected — it would mean
// mutable state for every option and half-applied configurations where old connections behave
// differently from new ones. This is the opposite: two lists the panel itself writes, applied
// through the rebuild path that already exists for a dashboard edit.
let requestRecompute = null;
const NEVER = parseRules(OPT.never_forward ?? process.env.NEVER_FORWARD);
// Per-dashboard always/never, on top of the global lists above.
//
// The global lists are the right shape for something every dashboard needs (a clock, an
// Assist pipeline). They are the wrong shape for something ONE dashboard needs: forcing
// `update.*` in globally to fix a sidebar counter on the admin dashboard added 252 entities
// to a wall panel that shows four lights, which is most of the trimming given back.
// User-Agent patterns that name a dashboard, used ONLY as a last-resort attribution fallback.
//
// The companion app's native connection never fetches a dashboard page, so it has neither a
// cookie nor an IP hint and lands on the union — 390 entities where the app actually shows one
// dashboard. Its User-Agent does identify it (`io.robbie.HomeAssistant`), so it can stand in
// for the missing page GET. Deliberately last: a real signal always wins, and a UA is
// trivially spoofed, so it may only ever pick between dashboards the add-on already serves.
const UA_DASHBOARDS = (() => {
  const raw = OPT.user_agent_dashboards
    ?? (process.env.UA_DASHBOARDS ? JSON.parse(process.env.UA_DASHBOARDS) : []);
  const legacy = (Array.isArray(raw) ? raw : [])
    .filter((o) => o && typeof o.match === 'string' && typeof o.dashboard === 'string')
    .map((o) => ({ ...parseRules([o.match])[0], dashboard: o.dashboard }));
  // The same thing said in the unified list: `user_agent` plus `assume_dashboard`. Without this
  // the unified list could MATCH on a User-Agent but not do the one thing the old key existed
  // for, so the four-lists-into-one migration would have quietly lost a capability.
  const unified = (Array.isArray(OPT.overrides) ? OPT.overrides
    : (process.env.OVERRIDES ? JSON.parse(process.env.OVERRIDES) : []))
    .filter((o) => o && typeof o.user_agent === 'string' && typeof o.assume_dashboard === 'string')
    .map((o) => ({ ...parseRules([o.user_agent])[0], dashboard: o.assume_dashboard }));
  return [...unified, ...legacy];
})();

// user (lower-cased name, or id) -> { always: rules, never: rules }
//
// Per-USER rules, because per-dashboard cannot express "David sees update.* on lovelace but
// Michelle does not" — they load the same dashboard. The identity comes from the browser's own
// auth token, resolved once per session against HA's `auth/current_user`.
// A list, not a map: a user may have several rules, and each may be scoped to one dashboard.
// `dashboard` omitted means "any dashboard this user opens".
// Per-user rules are compiled into CONN_RULES below, alongside every other kind.

// dash -> { always: rules, never: rules }
const PER_DASH_RULES = new Map(
  (() => {
    const raw = OPT.dashboard_overrides
      ?? (process.env.DASHBOARD_OVERRIDES ? JSON.parse(process.env.DASHBOARD_OVERRIDES) : []);
    return Array.isArray(raw) ? raw : [];
  })()
    .filter((o) => o && typeof o.dashboard === 'string')
    .map((o) => [o.dashboard, {
      always: parseRules(o.always_forward),
      never: parseRules(o.never_forward),
    }]),
);
// Rules pinned to a physical CLIENT rather than to a dashboard or a user.
//
// Some entities belong to the device in front of you, not to whatever page it happens to be
// showing. A browser-based voice satellite is the clearest case: `assist_satellite.office_panel`
// and its twenty siblings are only ever useful to the one panel that IS that satellite, and a
// dashboard-scoped rule gets this wrong in both directions — the panel loses them the moment it
// navigates elsewhere, and every other client opening that dashboard pays for them.
//
// `client` is an IP, a CIDR, or a hostname. Hostnames are resolved when the allowlist is built
// (see resolveClientRules): a DHCP lease can move, and a name that resolves through your own DNS
// keeps working when it does. Note mDNS/`.local` names generally do NOT resolve from inside the
// container — use a real DNS record, which a UniFi client reservation can provide.
//
// `devices` names whole DEVICES, by registry name or id, and expands to every entity that device
// owns. That is deliberately coarser than listing entity ids: a voice satellite integration adds
// entities between releases, and a rule that has to be re-edited to keep working is a rule that
// silently stops working.
// ---- one rule type, any combination of matchers ----
//
// `overrides` is a flat list where every matcher is optional and the ones present must ALL hold.
// The three older lists are compiled into the same shape at startup, so there is one matcher and
// one place rules are merged — which is why the existing per-client and per-user tests are
// exercising this engine rather than a parallel one.
//
// A rule is evaluated at the latest moment its matchers are all knowable. Address, User-Agent and
// the attributed dashboard are known when the socket opens; the USER is not, because identity
// comes from the auth token in the first frame. So rules are split by that one question — a rule
// naming a user waits for the auth gate, everything else applies at connect. That split is the
// only thing the old four-list arrangement was really encoding, and it is the only thing kept.
function compileOverride(o) {
  const client = typeof o.client === 'string' && o.client.trim() ? o.client.trim() : null;
  return {
    dashboard: typeof o.dashboard === 'string' && o.dashboard ? o.dashboard : null,
    user: typeof o.user === 'string' && o.user ? o.user.toLowerCase() : null,
    // Home Assistant has exactly two roles — administrator or not — so this is a two-value
    // matcher rather than a name. `role` rather than `admin: true` because it reads the way the
    // question is asked, and because it does not need rewriting if HA ever grows a third.
    role: o.role === 'admin' || o.role === 'user' ? o.role : null,
    // How the user signed in: `homeassistant` (password) or `trusted_networks`. Identity, so it
    // waits for the auth gate like `user` and `role` do.
    authProvider: typeof o.auth_provider === 'string' && o.auth_provider
      ? o.auth_provider.trim().toLowerCase() : null,
    // What the device says it IS, over mDNS: "Kiosk Satellite", "ESPHome", "ha-paneld".
    //
    // An mDNS name is a label a device chose for itself, unverified and trivially spoofable by
    // anything on the network. That is fine for "serve this panel more entities" and is NOT a
    // security boundary — the same reason discovery is observational everywhere else here.
    mdnsKind: typeof o.mdns_kind === 'string' && o.mdns_kind
      ? o.mdns_kind.trim().toLowerCase() : null,
    // WHICH ENTRY POINT the client arrived through — the hostname it connected to, since one
    // instance is reachable by several names: an IoT one, a Cloudflare one, a bare address.
    //
    // Called `entrypoint` rather than `host` because "host" is ambiguous here — this add-on
    // already uses it for the Home Assistant it proxies TO, for the machine it runs on, and for
    // the hop in front of it. `host` is still accepted: it was the name for one release.
    entrypoint: (() => {
      const v = typeof o.entrypoint === 'string' && o.entrypoint ? o.entrypoint
        : typeof o.host === 'string' && o.host ? o.host : null;
      return v ? v.trim().toLowerCase() : null;
    })(),
    client,
    // A UA is matched the same way an entity pattern is: literal substring or /regex/.
    userAgent: typeof o.user_agent === 'string' && o.user_agent ? parseRules([o.user_agent])[0] : null,
    devices: toList(o.devices),
    always: parseRules(o.always_forward),
    never: parseRules(o.never_forward),
    // Lovelace resources this connection is sent regardless of what its dashboard references,
    // and resources withheld from it. URL fragments matched as substrings, exactly like the
    // global `resources_always_forward` / `resources_never_forward` lists — but scoped to the
    // rule. The case that needed it: a browser voice satellite's engine is injected into every
    // page AND registered as a resource, no dashboard places the card, so the trim rightly drops
    // it everywhere — and the one panel that IS the satellite stops working. The global list
    // would hand that 669KB bundle to every other panel too.
    resAlways: parseRules(o.resources_always_forward),
    resNever: parseRules(o.resources_never_forward),
    // Filled in by resolveConnRules once DNS and the device registry are available.
    ips: new Set(), cidr: null, deviceEntities: [],
  };
}

const CONN_RULES = (() => {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const unified = arr(OPT.overrides
    ?? (process.env.OVERRIDES ? JSON.parse(process.env.OVERRIDES) : []));
  const legacyClient = arr(OPT.client_overrides
    ?? (process.env.CLIENT_OVERRIDES ? JSON.parse(process.env.CLIENT_OVERRIDES) : []))
    .filter((o) => o && typeof o.client === 'string' && o.client.trim());
  // Per-user rules join the same list. They were separate only because they are evaluated later,
  // and that timing is now derived from the rule itself rather than from which key it sat under.
  const legacyUser = arr(OPT.user_overrides
    ?? (process.env.USER_OVERRIDES ? JSON.parse(process.env.USER_OVERRIDES) : []))
    .filter((o) => o && typeof o.user === 'string');

  return [...unified, ...legacyClient, ...legacyUser]
    .filter((o) => o && typeof o === 'object')
    .map(compileOverride)
    // A rule with no matcher at all matches every connection, which is what the global
    // always/never lists already are. Silently applying one everywhere is not a reasonable
    // reading of a rule someone thought they were scoping, so it is dropped and logged.
    .filter((r) => {
      const scoped = r.dashboard || r.user || r.role || r.authProvider
        || r.client || r.userAgent || r.mdnsKind || r.entrypoint;
      if (!scoped) CONFIG_WARNINGS.push('ignoring an override with no matcher — it would apply to every connection; use always_forward/never_forward for that');
      return scoped;
    });
})();

// Does this rule's non-user half match? Split out because the user half resolves later.
function matchesConnection(r, ctx) {
  if (r.dashboard && r.dashboard !== ctx.dash) return false;
  if (r.client) {
    if (!ctx.ip) return false;
    if (!(r.cidr ? r.cidr(ctx.ip) : r.ips.has(ctx.ip))) return false;
  }
  if (r.userAgent) {
    if (!ctx.ua) return false;
    const hit = r.userAgent.re ? r.userAgent.re.test(ctx.ua) : ctx.ua.includes(r.userAgent.literal);
    if (!hit) return false;
  }
  if (r.entrypoint) {
    if (!ctx.host || String(ctx.host).toLowerCase() !== r.entrypoint) return false;
  }
  if (r.mdnsKind) {
    // EVERY record for this address, not the first. A panel here advertises itself twice — as a
    // Kiosk Satellite and as ESPHome, with different versions — so testing only the first record
    // would answer "is this ESPHome?" with whichever one happened to arrive first.
    const rows = ctx.ip ? (discovery.lookup(ctx.ip) || []) : [];
    if (!rows.some((row) => String(row.kind || '').toLowerCase() === r.mdnsKind)) return false;
  }
  return true;
}

// Which entity_category buckets to drop when a DEVICE is expanded — by a card that names one,
// or by a client rule. Home Assistant labels entities `config` (controls that configure the
// device: panel brightness, a reset button) and `diagnostic` (readings about its health: last
// seen, firmware, signal). A litter robot carries 21 entities and a card rendering a fill level
// needs a handful.
//
// Empty by DEFAULT, deliberately. Whether a given card renders `status_code` is not knowable
// from here, and a wrongly dropped entity blanks part of a card with no error anywhere — the
// same silent failure this add-on keeps having to fix. The breakdown is logged on every expansion
// so the saving can be seen BEFORE it is taken.
const EXCLUDE_DEVICE_CATEGORIES = toList(
  OPT.exclude_device_categories ?? process.env.EXCLUDE_DEVICE_CATEGORIES,
).filter((c) => ['config', 'diagnostic'].includes(c));

// Ask the network what each client IS. Purely observational — it labels a connection on the
// stats panel and resolves a `.local` name in a client rule, and it never decides what a client
// is served. An mDNS instance name is a label a device chose for itself; matching it against
// Home Assistant device names would be fuzzy string matching, and a wrong match would silently
// serve the wrong entities.
const MDNS_ENABLED = (OPT.mdns_discovery ?? process.env.MDNS_DISCOVERY ?? '1') !== false
  && String(OPT.mdns_discovery ?? process.env.MDNS_DISCOVERY ?? '1') !== '0';
const MDNS_SERVICES = (() => {
  const raw = toList(OPT.mdns_services ?? process.env.MDNS_SERVICES);
  return raw.length ? raw : DEFAULT_SERVICES;
})();
// `log` is declared further down, so bind it lazily rather than by value — this module runs
// its config block before the logger exists.
const discovery = createDiscovery({ services: MDNS_SERVICES, log: (...a) => log(...a) });


// Host whose SERVED certificate to watch. Measured by connecting, not by reading a file: a
// renewal that succeeded into the wrong directory looks perfect on disk and still breaks clients.
const CERT_HOST = String(OPT.cert_monitor_host ?? process.env.CERT_MONITOR_HOST ?? '').trim();
// Metrics over ESPHome's native API: Home Assistant's own integration connects to this port and
// the entities appear with no broker in between. This replaced MQTT discovery in 2026.09.25.3 —
// the catalogue that describes them lives in metrics.mjs, which knows about no transport at all.
// NOT the two-clause shape used by the options above: those default ON, and their second clause
// exists to let an explicit `false` win. Written that way here it read `(undefined ?? false) !==
// false`, which is false for everyone, and the listener never started however the option was set.
const ESPHOME_API = OPT.esphome_api !== undefined
  ? Boolean(OPT.esphome_api)
  : String(process.env.ESPHOME_API ?? '0') !== '0';
const ESPHOME_PORT = parseInt(OPT.esphome_port ?? process.env.ESPHOME_PORT ?? '6053', 10) || 6053;
const ESPHOME_KEY = String(OPT.esphome_key ?? process.env.ESPHOME_KEY ?? '').trim();
const esphomeSensors = createEsphomePublisher({ version: VERSION, log: (...a) => log(...a) });
// Counted for the rebuilds sensor: a steadily climbing number is the rebuild storm this add-on
// has already had once, and it is invisible in any single snapshot.
let REBUILD_COUNT = 0;
let CERT_DAYS = null;

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
// ---- log levels ----
//
// The service log had no volume control. `logThrottled` collapses REPEATS of one key, which does
// nothing about a hundred distinct clients each logging once — and this instance turns over ~22
// connections a minute, so the per-connection lines alone were writing tens of thousands of
// lines a day. All of it invaluable while diagnosing something and noise the rest of the time.
//
//   warn   problems, and the handful of startup lines without which a log cannot be read at all
//   info   normal operation — the DEFAULT, and exactly what this always printed
//   debug  per-connection and per-decision detail, most of which did not exist before
//
// `info` is the default deliberately: upgrading changes nothing about what you see. The point of
// the exercise is `debug` — a way to ASK for more when hunting something — not quieter defaults.
const LEVELS = { warn: 0, info: 1, debug: 2 };
const LOG_LEVEL = LEVELS[String(process.env.LOG_LEVEL ?? OPT.log_level ?? 'info').toLowerCase()] ?? LEVELS.info;

const stamp = (a) => [new Date().toISOString(), ...a];
// Always printed. Used for real problems AND for the version/listening/allowlist lines, because
// a log that cannot tell you which build produced it is not worth keeping at any level.
const warn = (...a) => console.log(...stamp(a));
const log = (...a) => { if (LOG_LEVEL >= LEVELS.info) console.log(...stamp(a)); };
const debug = (...a) => { if (LOG_LEVEL >= LEVELS.debug) console.log(...stamp(a)); };
const debugging = () => LOG_LEVEL >= LEVELS.debug;

// While HA is down (a restart, or a host boot where core isn't up yet) every kiosk retry and
// every in-flight stream produces the SAME error, hundreds of times a second — that flood is
// what made the old logs unreadable. Collapse repeats: log the first occurrence of a key
// immediately, then at most one summary line per window with the suppressed count.
const THROTTLE_MS = 10000;
const throttleState = new Map();
function logThrottled(key, msg, level = LEVELS.info) {
  if (LOG_LEVEL < level) return;
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

// True the first time a key is seen, false ever after. For lines that are worth saying once and
// are noise the thousandth time, where logThrottled cannot help: it collapses repeats INSIDE a
// ten-second window, and these recur every thirty seconds or every five minutes.
const SAID = new Set();
const SAID_MAX = 1000;
function onceOnly(key) {
  if (SAID.has(key)) return false;
  // Evict the OLDEST, one at a time. This used to clear the whole set at the cap, which inverts
  // the guarantee: under key churn every key is forgotten the moment the set fills, so "say it
  // once" becomes "say it every time". A Set iterates in insertion order, so the first key is the
  // oldest.
  while (SAID.size >= SAID_MAX) SAID.delete(SAID.values().next().value);
  SAID.add(key);
  return true;
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
// by_dashboard: serve each connection only its own dashboard's entities. Off => every
// connection gets the union (the pre-2026.09 behaviour), which is also the automatic
// fallback whenever a connection can't be attributed.
// `per_dashboard` is the original name and is still read: turning it off is a deliberate
// choice for panels that navigate between dashboards without reloading, and making the key inert
// would re-scope those connections and blank half their cards until someone reloaded.
const PER_DASH = OPT.by_dashboard !== undefined ? !!OPT.by_dashboard
  : OPT.per_dashboard !== undefined ? !!OPT.per_dashboard
  : (process.env.BY_DASHBOARD ?? process.env.PER_DASHBOARD ?? '1') !== '0';
// trim_registries: also cut the entity/device/area registries to what the connection can
// see. Separate from strip_entities because it is the more invasive of the two — states are
// self-describing, whereas a registry row missing here makes the frontend treat the entity as
// unregistered. Default on; turn it off first if something renders oddly.
const TRIM_REGISTRIES = OPT.trim_registries !== undefined ? !!OPT.trim_registries
  : (process.env.TRIM_REGISTRIES ?? '1') !== '0';
// Every live browser <-> HA bridge, so a grown allowlist can reach already-open pages
// (issue #7). close() -> { dash, ip }: the dashboard it serves (null for the union), so a rebuild
// can recycle only the connections whose set actually grew, and the client address, so the log
// can say WHICH ones it recycled. See refreshOpenConnections().
const openBridges = new Map();
// Trimming paused for one Home Assistant user, until a timestamp. See pause.mjs for why this is
// keyed on the user rather than the device: the case it exists for is a person troubleshooting
// from a phone on cellular behind Cloudflare, where no address is stable and the token's identity
// is. Loaded from /data so a restart mid-pause does not silently re-trim, and swept on a timer so
// it ends on its own.
let PAUSES = readPauses(CONFIG_DIR);
// How long the Home Assistant switch pauses for. Env-only: the console offers a choice, the
// switch is the one-tap path and does not stop to ask.
const ADMIN_PAUSE_MS = Math.min(
  Math.max(parseInt(process.env.ADMIN_PAUSE_MINUTES || '60', 10) || 60, 1) * 60000,
  MAX_PAUSE_MS,
);
const pauseKey = (u) => String(u ?? '').trim().toLowerCase();

// Drop every open connection belonging to one user, so it re-subscribes under the new answer.
// Same mechanism as a grown allowlist (see refreshOpenConnections) and for the same reason: HA
// cannot amend a live `subscribe_entities`, so a pause that started or ended only reaches a
// connection that opens again. Both directions matter — starting one is useless if the phone
// keeps its trimmed subscription, and ending one has to put the trim back without a manual
// reload.
function recycleUser(userKey, why) {
  // The admin pause is not a user id — it matches whoever is an administrator, which is a fact
  // about the connection rather than a name to compare against.
  const hit = isRoleKey(userKey)
    ? ([, b]) => b.isAdmin
    : ([, b]) => pauseKey(b.user) === userKey;
  const victims = [...openBridges].filter(hit);
  if (!victims.length) return 0;
  log(`  reconnecting ${victims.length} connection(s) for ${userKey} (${why}): `
    + victims.map(([, b]) => `${b.ip ?? '?'} (${b.dash ?? 'union'})`).join(', '));
  for (const [close] of victims) { try { close(); } catch {} }
  return victims.length;
}

// Start or end the ADMIN pause. The switch in Home Assistant has no user behind it — the API
// delivers a command, not who sent it — so what it can offer is a role, and administrators is
// the right one: they are the people who troubleshoot, and every kiosk keeps its trim.
function setAdminPause(on, ms, by) {
  if (on) {
    PAUSES = pauseUser(PAUSES, ADMINS, ms, { name: 'administrators', by });
    const until = pausedUntil(PAUSES, ADMINS);
    log(`trim PAUSED for ADMIN users until ${new Date(until).toISOString()} `
      + `(${Math.round(ms / 60000)} min, via ${by})`);
  } else {
    if (!pausedUntil(PAUSES, ADMINS)) return 0;
    PAUSES = resumeUser(PAUSES, ADMINS);
    log(`trim resumed for admin users (via ${by})`);
  }
  try { writePauses(CONFIG_DIR, PAUSES); } catch (e) { warn(`pause: could not persist (${e.message})`); }
  // Tell the transports now rather than at the next sample: the person who flipped the switch is
  // watching it, and a toggle that takes a minute to agree with itself reads as broken.
  esphomeSensors.push();
  return recycleUser(ADMINS, on ? 'admin trim paused' : 'admin pause ended');
}

// Ending a pause is as important as starting one, and nothing else would do it: the person who
// paused is by definition busy with something else. Checked on a timer rather than scheduled per
// pause so a clock jump or a restart cannot leave one armed forever.
const PAUSE_SWEEP_MS = 15000;
const pauseSweeper = setInterval(() => {
  const [next, expired] = sweepPauses(PAUSES);
  if (!expired.length) return;
  PAUSES = next;
  try { writePauses(CONFIG_DIR, PAUSES); } catch (e) { warn(`pause: could not persist expiry (${e.message})`); }
  for (const k of expired) {
    log(`trim pause expired for ${k} — trimming again`);
    recycleUser(k, 'pause expired');
  }
  // Or the admin switch reads "off" for up to a minute after trimming came back on.
  esphomeSensors.push();
}, PAUSE_SWEEP_MS);
pauseSweeper.unref?.();

// False until the first allowlist lands. HA may still be booting when we start, and injecting
// an EMPTY allowlist would render every card "unavailable" until a manual reload — so until
// this flips we refuse /api/websocket upgrades instead (the frontend just keeps retrying).
let ALLOW_READY = false;
// Every entity_id on the instance, from the last allowlist build. User rules are applied per
// connection, long after buildAllow has returned, so a /regex/ needs something to expand over.
let REAL_IDS = [];

// HA events that can change the computed allowlist: a dashboard edit, or a registry change
// that alters what an area/label/device/integration auto-entities filter resolves to.
// Registry fields a rebuild can safely ignore.
//
// `entity_registry_updated` fires for far more than the allowlist depends on. Measured on a
// live instance: 24 full rebuilds in 14 minutes, EVERY one reporting "+0 -0" — a full
// get_states over 9,592 entities plus all four registries, roughly 20MB pulled from Home
// Assistant each time, to change nothing.
//
// Listed here are fields that cannot move an allowlist. Everything else — including anything
// unrecognised — still rebuilds, because the asymmetry runs the usual way: a wasted rebuild
// costs bandwidth, a skipped one serves a dashboard entities it no longer has.
const IGNORABLE_REGISTRY_FIELDS = new Set([
  'options',                 // per-domain display settings, e.g. sensor precision
  'capabilities',
  'supported_features',
  'unit_of_measurement',
  'previous_unique_id',
  'suggested_object_id',
]);

// The same list for `device_registry_updated`, which the filter above never covered — and which
// turned out to be the louder of the two. Measured on a live instance, 2026-09-19: 33 full
// rebuilds in 8.5 minutes, 28 of them from device events, every one "+0 -0".
//
// A device row reaches an allowlist through exactly five fields: `id`, `area_id`, `name`,
// `name_by_user` and `via_device_id` (see buildRegistryCtx and the sub-device folding in
// lovelace_extract.mjs). Listed here is what an integration rewrites on every reconnect or
// firmware report and that none of those paths read. `manufacturer`, `model` and `model_id` are
// here only because auto-entities' `device_manufacturer` / `device_model` filters are unsupported;
// whoever adds them must take these three back out.
const IGNORABLE_DEVICE_FIELDS = new Set([
  'sw_version',
  'hw_version',
  'configuration_url',
  'serial_number',
  'connections',
  'manufacturer',
  'model',
  'model_id',
]);
const IGNORABLE_BY_EVENT = new Map([
  ['entity_registry_updated', IGNORABLE_REGISTRY_FIELDS],
  ['device_registry_updated', IGNORABLE_DEVICE_FIELDS],
]);

// Does this registry event plausibly change what a dashboard resolves to?
function registryEventMatters(eventType, data) {
  const ignorable = IGNORABLE_BY_EVENT.get(eventType);
  if (!ignorable) return true;
  // create/remove always matter: a new entity can match a filter, a removed one must go.
  if (data?.action !== 'update') return true;
  const changed = data?.changes && typeof data.changes === 'object' ? Object.keys(data.changes) : null;
  if (!changed || !changed.length) return true;       // shape we don't understand -> rebuild
  if (changed.some((k) => !ignorable.has(k))) return true;
  logThrottled(`reg-noop:${eventType}`, `${eventType} ignored (only ${changed.join(', ')} changed)`);
  return false;
}

// What a registry event says happened, for the line that announces a rebuild. The rebuild used to
// be logged as a bare `entity_registry_updated:` — so a storm of them named no entity, no device
// and no field, and the only changed-field list ever printed was for events that were IGNORED.
function describeRegistryEvent(data) {
  const what = data?.entity_id ?? data?.device_id ?? data?.area_id ?? data?.label_id ?? null;
  const changed = data?.changes && typeof data.changes === 'object' ? Object.keys(data.changes) : [];
  return [data?.action, what, changed.length ? `(${changed.join(', ')} changed)` : null]
    .filter(Boolean).join(' ');
}

// Subscription id for the lovelace resource collection, or null when unavailable. Module scope
// because the control socket is rebuilt on reconnect and the id must not leak across sockets.
let resourceSubId = null;
const WATCH_EVENTS = ['lovelace_updated', 'entity_registry_updated', 'device_registry_updated', 'area_registry_updated', 'label_registry_updated'];

// Allowlist for one dashboard = entities used across ALL its views. Two passes unioned:
//  1) structured walk (explicit cards + auto-entities filter expansion)
//  2) every REAL entity id appearing anywhere in the config text (catches ids inside
//     button-card / mushroom-template / decluttering templates the walker can't parse).
// Over-including is harmless (still tiny vs the instance); under-including breaks cards.
// "21 entities (12 primary, 6 config, 3 diagnostic)" — the number next to the trade-off, so a
// person can decide whether excluding a bucket is worth it instead of guessing.
function describeDeviceSplit(rows = []) {
  const s = splitDeviceEntities(rows);
  return `(${s.primary.length} primary, ${s.config.length} config, ${s.diagnostic.length} diagnostic)`;
}

function allowlistFor(cfg, states, registries, renderedTemplates) {
  const real = new Set(states.map((s) => s.entity_id));
  // overInclude: forward every entity a card COULD show (don't shrink on volatile
  // state/attributes filters); registries resolve area/label/device/integration filters.
  const extracted = extractEntities(cfg, states, {
    registries, overInclude: true, renderedTemplates,
    excludeDeviceCategories: EXCLUDE_DEVICE_CATEGORIES,
  });
  const out = new Set(extracted.entities);
  // What the extractor could NOT resolve. It has always returned this list and nothing ever read
  // it, so an `or:` / `not:` / `floor:` filter — or a regex switched off for backtracking —
  // produced an empty card behind the proxy and not one line anywhere to say why.
  for (const u of extracted.unsupported || []) logThrottled(`unsupported:${u}`, `    not resolved: ${u}`);
  // Cards configured with a device are the single biggest source of entities nobody asked for,
  // so name them and show what each costs. Silence here would hide the whole trade-off.
  if (extracted.devices?.length) {
    const byDev = buildRegistryCtx(registries).byDevice;
    const names = new Map((registries?.devices || []).map((d) => [d.id, d.name_by_user || d.name || d.id]));
    for (const id of extracted.devices) {
      const rows = byDev.get(id) || [];
      report(`    card names device "${names.get(id) ?? id}": +${deviceEntityIds(rows, EXCLUDE_DEVICE_CATEGORIES).length} entities ${describeDeviceSplit(rows)}`);
    }
  }
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
  if (out.size) report(`  rendered ${out.size}/${tpls.length} auto-entities template filter(s)`);
  return out;
}

// Apply the always/never overrides to one dashboard's set. Done PER DASHBOARD, not just to
// the union: `always_forward` exists for entities no card names — the Assist pipeline and
// wake-word entities a Voice Satellite card drives, say — and those are needed on whichever
// dashboard the kiosk actually has open, not merely somewhere in the union.
// `dash` is the dashboard this set belongs to, or null for the union. Per-dashboard rules are
// applied ON TOP of the global ones, and the never list still wins last — a global `never` is
// a statement about the whole instance, so a per-dashboard `always` must not override it.
function applyOverrides(set, realIds, dash = null) {
  const extra = (dash && PER_DASH_RULES.get(dash)) || { always: [], never: [] };
  const out = new Set(set);
  [...ALWAYS, ...extra.always].forEach((r) => {
    if (r.literal) out.add(r.literal);
    else realIds.forEach((eid) => { if (r.re.test(eid)) out.add(eid); });
  });
  CLASS_IDS.forEach((eid) => out.add(eid));
  [...out].forEach((eid) => {
    if (matchesAny(NEVER, eid) || matchesAny(extra.never, eid)) out.delete(eid);
  });
  return out;
}

// Build the per-dashboard allowlists (and their union) using an authed rpc().
// ---- the rebuild report, and what a rebuild costs ------------------------------------------
//
// A rebuild used to write its whole working-out every time: each dashboard's count, each device a
// card or a rule expanded, the registry reach, the override totals. About forty lines — for a
// rebuild that changed nothing, which is most of them, since a registry event fires them. With a
// handful an hour that was the bulk of the log, and it pushed everything else out of Supervisor's
// buffer. The lines are collected instead and printed only when they differ from the last
// rebuild's, the way the resource report already is. The one-line "allowlist recomputed … (+a -r)"
// summary is still said every time: that line is the storm detector.
// How long after the first allowlist the event-loop metric starts counting. Env-only; a test
// sets it to milliseconds to see the reset without waiting a minute.
const LOOP_SETTLE_MS = parseInt(process.env.LOOP_SETTLE_MS || '60000', 10);
let BUILD_REPORT = null;        // lines collected during a build; null outside one
let LAST_BUILD_REPORT = null;   // the text last printed
const report = (line) => { if (BUILD_REPORT) BUILD_REPORT.push(line); else log(line); };
// What a rebuild costs, measured rather than guessed. The worst event-loop stall had climbed from
// 46ms to 120ms as the instance grew from 9,751 to 10,901 entities, while p99 stayed near 1ms —
// one long block, not a slow loop. The rebuild is the only thing here big enough to be it, but it
// already yields between dashboards (every config fetch is an await), so the suspect is a single
// huge JSON.parse on the control socket, which cannot be split. These say which.
let BUILD_FRAMES = null;        // [{ bytes, ms }] for large frames parsed during a build
let BUILD_DASH = null;          // { ms, slowest, slowestMs } — the allowlist computation itself

async function buildAllow(rpc, renderTemplate) {
  const t0 = performance.now();
  // A histogram of its own, so "worst block during this rebuild" is not confused with the
  // since-boot figure the console shows. The resolution is subtracted, as in stats.mjs, because
  // the histogram records the whole interval between ticks.
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  BUILD_REPORT = [];
  BUILD_FRAMES = [];
  BUILD_DASH = { ms: 0, slowest: null, slowestMs: 0 };
  let ok = false;
  // What the sets CONTAIN, not only how big they are. The detail lines are counts, so an edit
  // that swaps one entity for another leaves every line identical — and "unchanged since the
  // last rebuild" would then describe a rebuild that changed what a panel is served. Compared,
  // never printed.
  let sig = '';
  try {
    const out = await buildAllowOnce(rpc, renderTemplate);
    ok = true;
    const h = crypto.createHash('sha1');
    for (const [dash, set] of [...out.perDash].sort(([a], [b]) => a.localeCompare(b))) {
      h.update(`${dash}:${[...set].sort().join(',')}\n`);
    }
    h.update(`union:${[...out.union].sort().join(',')}`);
    sig = h.digest('hex');
    return out;
  } finally {
    loop.disable();
    const lines = BUILD_REPORT;
    BUILD_REPORT = null;
    const text = lines.join('\n') + '\n' + sig;
    // A failed build always prints everything it got as far as: that is the one worth reading.
    if (!ok || text !== LAST_BUILD_REPORT) {
      for (const l of lines) log(l);
      if (ok) LAST_BUILD_REPORT = text;
    } else {
      log(`  rebuild detail unchanged since the last rebuild (${lines.length} lines) — not repeated`);
    }
    const big = BUILD_FRAMES.reduce((a, f) => (f.bytes > (a?.bytes ?? 0) ? f : a), null);
    const worst = Math.max(0, Math.round(loop.max / 1e6 - 10));
    log(`  rebuild took ${Math.round(performance.now() - t0)}ms: worst event-loop block ${worst}ms`
      + (big ? `, largest frame ${(big.bytes / 1048576).toFixed(1)}MB parsed in ${Math.round(big.ms)}ms` : '')
      + `, dashboards ${Math.round(BUILD_DASH.ms)}ms`
      + (BUILD_DASH.slowest ? ` (slowest ${BUILD_DASH.slowest} ${Math.round(BUILD_DASH.slowestMs)}ms)` : ''));
    BUILD_FRAMES = null;
    BUILD_DASH = null;
  }
}

async function buildAllowOnce(rpc, renderTemplate) {
  // Counted where the cost is paid — a rebuild that later fails still pulled the instance from
  // Home Assistant. This was declared, published as a sensor and never incremented, so the one
  // sensor built to show a rebuild storm read 0 straight through one.
  REBUILD_COUNT++;
  const states = await rpc({ type: 'get_states' });
  const realIds = states.map((s) => s.entity_id);
  REAL_IDS = realIds;
  CLASS_IDS = deviceClassIds(states);
  if (CLASS_RULES.length) report(`  device_class rules forward ${CLASS_IDS.size} entities`);
  // The control connection asks for every state by definition, so this is the instance size.
  // Do NOT learn it from a browser's get_states instead: the modern frontend subscribes
  // rather than polling, so that path can go a whole uptime without ever firing.
  INSTANCE_ENTITIES = states.length;
  // Every entity on the instance, with its friendly name, so the panel can search for one that
  // was dropped. Held because the alternative is asking HA again on every keystroke, and because
  // the interesting question — "why is this entity not on my dashboard" — is asked about
  // entities the allowlist does NOT contain, which by definition appear nowhere else in here.
  // ~9,600 short strings; the entity registry it sits beside is 10MB.
  ALL_ENTITIES = states.map((e) => [e.entity_id, e.attributes?.friendly_name ?? null]);
  const byId = new Map(states.map((st) => [st.entity_id, st]));
  const registries = await fetchRegistries(rpc);
  // The device list the console's picker searches. `entities` is what naming this device in a
  // rule would actually pull in — the number that decides whether the rule is a good idea.
  ALL_DEVICES = (() => {
    const byDev = buildRegistryCtx(registries).byDevice;
    const rows = (registries?.devices || [])
      .map((d) => {
        const name = String(d.name_by_user || d.name || '').trim();
        return name ? { name, id: d.id, entities: (byDev.get(d.id) || []).length } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    // Collapse devices that share a name into one row: the rule names a NAME, and naming it
    // expands all of them, so one row carrying the combined total is what the rule will do.
    const byName = new Map();
    for (const d of rows) {
      const cur = byName.get(d.name);
      if (cur) { cur.entities += d.entities; cur.devices += 1; }
      else byName.set(d.name, { name: d.name, entities: d.entities, devices: 1 });
    }
    return [...byName.values()];
  })();
  // Resolve client-pinned rules here: the device registry has just been fetched, and doing it
  // on every rebuild means a renamed device or a moved DHCP lease is picked up without a restart.
  await resolveConnRules(registries);
  // And the entity -> its device's entities map that self-identifying clients resolve through.
  REG_CACHE_BY_ENTITY = (() => {
    const byDev = buildRegistryCtx(registries).byDevice;
    const out = new Map();
    const perDevice = new Map(); // one filtered array per device, shared by all its entities
    for (const e of (registries?.entities || [])) {
      if (!e.entity_id || !e.device_id) continue;
      const rows = byDev.get(e.device_id);
      if (!rows) continue;
      if (!perDevice.has(e.device_id)) perDevice.set(e.device_id, deviceEntityIds(rows, EXCLUDE_DEVICE_CATEGORIES));
      out.set(e.entity_id, perDevice.get(e.device_id));
    }
    return out;
  })();
  // entity_id -> the INTEGRATION that provides it. Needed for translations and nothing else: a
  // Tuya sensor's state strings live under `component.tuya_local`, while its entity_id says
  // `sensor.`. Filtering translations on entity domains alone would drop exactly the tree that
  // names its states, and the dashboard would render raw keys instead.
  PLATFORM_BY_ENTITY = new Map();
  for (const e of (registries?.entities || [])) {
    if (e?.entity_id && e?.platform) PLATFORM_BY_ENTITY.set(e.entity_id, e.platform);
  }
  // Built into locals and swapped in at the end. This used to reset THEMES_USED first and refill
  // it across the dashboard loop — which awaits between dashboards — so a get_themes reply that
  // landed mid-rebuild was trimmed against a half-filled set and a panel lost its theme until it
  // reloaded. The resource maps already swap atomically for the same reason.
  const themesUsed = new Set();
  const union = new Set();
  const perDash = new Map();
  const keysByDash = new Map();
  // Dashboard configs and the themes each names, kept for the resource-key pass below, which
  // has to run AFTER the overrides are applied.
  const cfgByDash = new Map();
  const themesByDash = new Map();
  // Theme definitions, once, so a font set BY A THEME is not invisible to the resource trim.
  // Each theme collapses to a lowercase blob of its own values; matching a font family against
  // that is enough, and avoids caring which of the dozen font-related theme variables was used.
  //
  // Failure here must not cost a dashboard its fonts, so an empty map means "unknown", and the
  // keep rule treats unknown the way it treats every other unreadable thing: keep.
  const themeBlobs = new Map();
  try {
    const th = await rpc({ type: 'frontend/get_themes' });
    for (const [name, def] of Object.entries(th?.themes || {})) {
      themeBlobs.set(name, JSON.stringify(def).toLowerCase());
    }
    const defs = [th?.default_theme, th?.default_dark_theme].filter(Boolean);
    if (defs.length) {
      themeBlobs.set('__defaults__', defs.map((d) => themeBlobs.get(d) || '').join(' '));
    }
  } catch (e) {
    log(`  themes: could not read them for the font check (${e.message}) — font stylesheets will be kept`);
  }
  let failed = 0;
  for (const p of DASH_PATHS) {
    try {
      const cfg = await rpc({ type: 'lovelace/config', url_path: p });
      const tpls = await renderTemplates(cfg, renderTemplate);
      const c0 = performance.now();
      const set = allowlistFor(cfg, states, registries, tpls);
      const cMs = performance.now() - c0;
      DASH_CONFIGS.set(p, cfg);
      if (BUILD_DASH) {
        BUILD_DASH.ms += cMs;
        if (cMs > BUILD_DASH.slowestMs) { BUILD_DASH.slowestMs = cMs; BUILD_DASH.slowest = p; }
      }
      report(`  ${p}: ${set.size} entities`);
      perDash.set(p, set);
      cfgByDash.set(p, cfg);
      // Theme names this dashboard asks for. A `theme:` can sit on the dashboard, on a view or
      // on a card, so the whole config tree is walked rather than a fixed set of places.
      const dashThemes = new Set();
      (function collectThemes(n) {
        if (!n || typeof n !== 'object') return;
        if (Array.isArray(n)) { n.forEach(collectThemes); return; }
        if (typeof n.theme === 'string' && n.theme) { themesUsed.add(n.theme); dashThemes.add(n.theme); }
        for (const v of Object.values(n)) collectThemes(v);
      })(cfg);
      themesByDash.set(p, dashThemes);
      set.forEach((e) => union.add(e));
    } catch (e) { failed++; DASH_CONFIGS.delete(p); log(`  ${p}: FAILED ${e.message}`); }
  }
  THEMES_USED = themesUsed;
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
  for (const [p, set] of perDash) perDash.set(p, applyOverrides(set, realIds, p));
  // Resource keys come from the dashboard config AND from the icons of the entities this
  // dashboard is served. The second half matters: an entity's icon usually lives in the entity
  // registry, not in any dashboard's YAML, so a config-only scan misses it and drops the icon
  // pack that renders it. Measured here: 20 entities carry `phu:` icons set in the registry, and
  // the string "phu" appears in no dashboard config.
  //
  // Computed AFTER the overrides, against the set the dashboard is actually served. It used to
  // run inside the loop above, on the pre-override set, so an entity that reached a dashboard
  // only through always_forward contributed no icon namespace — and the icon pack it needed was
  // dropped for that dashboard while the entity itself was sent.
  for (const [p, set] of perDash) {
    const cfg = cfgByDash.get(p);
    const keys = resourceKeys(cfg, set, byId);
    // Where this dashboard could name a font: its own config, the themes it asks for, and the
    // instance defaults, which apply wherever a dashboard names none. Empty when themes could
    // not be read, which the keep rule reads as "do not drop a font stylesheet".
    keys.fontText = themeBlobs.size ? fontTextFor(cfg, themesByDash.get(p) || new Set(), themeBlobs) : null;
    keysByDash.set(p, keys);
  }
  // The union takes every per-dashboard set after ITS own overrides, so an unattributed
  // connection is never served less than the dashboard it might actually be showing.
  for (const set of perDash.values()) set.forEach((e) => union.add(e));
  const withOverrides = applyOverrides(union, realIds);
  // Registry reachability is computed against the UNION deliberately: a connection served a
  // single dashboard's entities may still legitimately name a device or area belonging to
  // another, and a device row wrongly dropped costs a name with no bandwidth saving worth it.
  if (TRIM_REGISTRIES) {
    rebuildRegCache(registries, withOverrides);
    report(`  registry reach: ${REG_CACHE.devices.size} device(s), ${REG_CACHE.areas.size} area(s)`);
  }
  await buildResources(rpc, keysByDash);
  const afterAlways = new Set([...union, ...withOverrides]).size;
  report(`overrides: base ${baseN}, +always ${afterAlways - baseN}, -never ${afterAlways - withOverrides.size}`);
  if (PER_DASH) report(`  per-dashboard: ${[...perDash].map(([p, s]) => `${p}=${s.size}`).join(', ')} (union ${withOverrides.size})`);
  // Here as well as in runRecompute: the boot and reconnect builds do not go through it, and a
  // registry event arriving seconds after either is exactly what the floor is for.
  LAST_REBUILD_AT = Date.now();
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
  // Which DASHBOARDS gained an entity, judged per dashboard rather than from the union. The
  // union can stay put while a dashboard grows — an entity moving from one dashboard to another
  // — and a panel on the receiving dashboard still needs to re-subscribe to see it.
  const grown = new Set();
  for (const [p, s] of nextByDash) {
    const old = ALLOW_BY_DASH.get(p);
    if (!old || [...s].some((e) => !old.has(e))) grown.add(p);
  }
  ALLOW = next;
  ALLOW_BY_DASH = nextByDash;
  // Retire the cached registry answers whenever the allowlist actually moved. Without this
  // the cache key (which embeds ALLOW_VERSION) is unchanged by a recompute, so a dashboard
  // edit keeps being answered from registries trimmed to the PREVIOUS allowlist. The growth
  // case is the damaging one: refreshOpenConnections() below recycles every open kiosk
  // precisely so it picks up the new entities, and a stale cache would then hand those
  // reconnections registry rows that omit them — names and areas silently failing to resolve
  // on exactly the entities that were just added. Only the reconnect path used to bump this.
  // Cleared on EVERY rebuild, not only when membership moved: a rename or an area move changes rows
  // for entities that stay allowed, and the cache has no TTL. Rebuilds are rare (registry events are
  // filtered by changed field and floored in time), so this costs little hit rate.
  ALLOW_VERSION++; REG_RESPONSE_CACHE.clear();
  const fmt = (a) => (a.length > 25 ? `${a.slice(0, 25).join(', ')} …(+${a.length - 25} more)` : a.join(', '));
  log(`allowlist ${why}: ${ALLOW.size} entities (+${added.length} -${removed.length})`);
  if (added.length) log(`  +added: ${fmt(added)}`);
  if (removed.length) log(`  -removed: ${fmt(removed)}`);
  if (!added.length && !removed.length) log('  (no change)');
  if (added.length || grown.size) refreshOpenConnections(grown, added.length > 0);
}

// `subscribe_entities` is sent ONCE per connection and HA has no way to amend a live
// subscription, so a recompute only ever affected NEW connections — an already-open kiosk
// kept streaming its original entity list until someone reloaded the tab (issue #7).
// Dropping the browser socket fixes that: the HA frontend treats it as an ordinary
// disconnect, reconnects on its own, and re-subscribes against the current allowlist.
// Only on GROWTH. A shrink means the open page is carrying entities it no longer needs,
// which is harmless — and churning every kiosk over a removal would be a bad trade.
//
// And only the connections that GREW. This used to drop every open bridge whenever the union
// gained anything, so pinning one entity for the admin dashboard bounced every wall panel in
// the house — each reconnecting to be served exactly what it already had. A bridge serving one
// dashboard is recycled when THAT dashboard's set grew; a bridge on the union (unattributed)
// when the union did. A connection widened by a rule or by self-identification sits on top of
// one of those two sets, so the same test holds for it.
//
// The log names the connections it RECYCLED, by address and the set each was on — not the
// dashboards that grew. It used to end with the grown dashboards in brackets, so
// "reconnecting 1 of 6 … (basement-stairs-panel)" read as "the basement panel reconnected"
// when the one connection dropped was a different client on the union, and the panel itself,
// attributed to no connection on that dashboard, was never touched — an investigation started
// from exactly that misreading on 2026-09-21. A grown dashboard with nobody on it is now said
// outright, because that is the fact that ends such an investigation.
function refreshOpenConnections(grown, unionGrew) {
  if (!STRIP || !openBridges.size) return;
  const bridges = [...openBridges];
  const onDash = new Set(bridges.map(([, b]) => b.dash));
  const nobody = [...grown].filter((d) => !onDash.has(d));
  if (nobody.length) {
    log(`  no open connection is attributed to ${nobody.join(', ')} — a panel showing `
      + `${nobody.length > 1 ? 'one of them' : 'it'} is on another set or not connected through this app, `
      + 'and will not pick up the new entities until it reloads');
  }
  const victims = bridges.filter(([, b]) => (b.dash === null ? unionGrew : grown.has(b.dash)));
  if (!victims.length) return;
  const who = victims.map(([, b]) => `${b.ip ?? '?'} (${b.dash ?? 'union'})`);
  const shown = who.length > 10 ? `${who.slice(0, 10).join(', ')} …(+${who.length - 10} more)` : who.join(', ');
  log(`  reconnecting ${victims.length} of ${openBridges.size} open dashboard connection(s) to pick up `
    + `the new entities: ${shown}`);
  for (const [close] of victims) { try { close(); } catch {} }
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
// The control connection's rpc while it is authenticated, for the few requests outside a rebuild
// that have to ask Home Assistant something (today: whether a console user is an administrator).
// Null whenever the socket is down, so a caller fails closed instead of queueing on a dead one.
let CONTROL_RPC = null;

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
      // handshakeTimeout ends at the upgrade. An HA that upgrades and then never speaks auth would
      // leave the controller waiting, with no rebuilds, for ever.
      const authTimer = setTimeout(() => { try { ws.terminate(); } catch {} }, 15000);
      authTimer.unref?.();
      ws.on('close', () => clearTimeout(authTimer));
      let id = 1; const pending = {}; let gone = false;
      // Every command is bounded — see CONTROL_RPC_TIMEOUT_MS. Expiry drops the socket rather
      // than merely rejecting: the socket is evidently not answering, and onGone() is the one
      // path that already knows how to wait for a healthy HA and rebuild.
      const rpc = (o) => {
        // A socket that is already gone gets an immediate, honest answer. Sending anyway threw
        // inside the executor AFTER the timeout was armed, so the entry sat in `pending` and, a
        // minute later, logged "unanswered … dropping the connection" about a connection that had
        // been replaced long before — a line that reads like a wedged Home Assistant.
        if (gone || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('control ws closed'));
        o.id = id++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            if (!pending[o.id]) return;
            delete pending[o.id];
            rej(new Error(`${o.type} timed out after ${CONTROL_RPC_TIMEOUT_MS}ms`));
            logThrottled('ctrl-rpc-timeout', `control ws: ${o.type} unanswered for ${CONTROL_RPC_TIMEOUT_MS}ms — dropping the connection to rebuild on a fresh one`);
            try { ws.close(); } catch {}
          }, CONTROL_RPC_TIMEOUT_MS);
          timer.unref?.();
          pending[o.id] = [(v) => { clearTimeout(timer); res(v); }, (e) => { clearTimeout(timer); rej(e); }];
          ws.send(JSON.stringify(o));
        });
      };

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
      //
      // The debounce alone is not enough. It guards SCHEDULING, not execution: once the timer
      // fires, buildAllow() is awaited, and any event arriving during that await schedules a
      // fresh timer that fires while the first rebuild is still running. Measured on a live
      // instance, three rebuilds completed inside one second. So a rebuild in flight sets a
      // flag instead, and exactly one follow-up runs when it finishes.
      let rebuilding = false;
      let rebuildAgain = null;                 // { why, floorMs } of the follow-up, if one is owed
      const runRecompute = async (why) => {
        if (rebuilding) return;
        rebuilding = true;
        try {
          const next = await buildAllow(rpc, renderTemplate);
          // The socket dropped while resources were being fetched, which are not tied to it; a newer
          // connection is rebuilding already, and publishing this older result over it would regress it.
          if (!gone) applyAllow(next, `recomputed (${why})`);
        }
        catch (e) { log('recompute failed:', e.message); }
        finally {
          rebuilding = false;
          LAST_REBUILD_AT = Date.now();
          const next = rebuildAgain;
          rebuildAgain = null;
          if (next !== null && !gone) scheduleRecompute(next.why, next.floorMs);
        }
      };
      // Published so a panel pin can trigger the same rebuild a dashboard edit does.
      //
      // `floorMs` is the least time since the LAST rebuild this one may run at — 0 for anything a
      // person did, REGISTRY_REBUILD_MIN_MS for registry events. The lowest floor among the
      // requests being debounced together wins, so a dashboard edit is never made to wait behind
      // a registry event that happened to arrive beside it.
      let pendingFloor = Infinity;
      const scheduleRecompute = (why, floorMs = 0) => {
        if (rebuilding) {
          rebuildAgain = { why, floorMs: Math.min(floorMs, rebuildAgain?.floorMs ?? Infinity) };
          return;
        }
        clearTimeout(recomputeTimer);
        pendingFloor = Math.min(pendingFloor, floorMs);
        const wait = Math.max(1500, LAST_REBUILD_AT + pendingFloor - Date.now());
        if (wait > 1500) {
          logThrottled('rebuild-held', `  rebuild held ${Math.ceil(wait / 1000)}s — registry events `
            + `rebuild at most once per ${REGISTRY_REBUILD_MIN_MS / 1000}s`);
        }
        recomputeTimer = setTimeout(() => { pendingFloor = Infinity; runRecompute(why); }, wait);
      };
      // Cleared when this socket goes away, so a pin during an HA outage reports honestly that
      // it needs a restart rather than silently doing nothing.
      requestRecompute = scheduleRecompute;
      ws.on('close', () => { if (requestRecompute === scheduleRecompute) requestRecompute = null; });

      ws.on('message', async (raw) => {
        // Guarded: this handler is async, so a throw here becomes an unhandled rejection —
        // i.e. a process-level crash — and a restarting HA/supervisor can answer with
        // something that isn't JSON.
        const pt0 = performance.now();
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        // Timed only during a build and only when large: a parse is one synchronous call, so a
        // multi-megabyte registry frame is a block nothing else can run beside.
        if (BUILD_FRAMES && raw.length > 256 * 1024) BUILD_FRAMES.push({ bytes: raw.length, ms: performance.now() - pt0 });
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
          clearTimeout(authTimer);
          try {
            backoff = 1000; attempts = 0;
            CONTROL_RPC = rpc;
            const next = await buildAllow(rpc, renderTemplate);
            if (gone) return;   // superseded while building; see runRecompute
            if (!settled) {
              ALLOW = next.union; ALLOW_BY_DASH = next.perDash; ALLOW_VERSION++; REG_RESPONSE_CACHE.clear();
              settled = true; ALLOW_READY = true; resolve(ALLOW);
              // Stop counting startup as operation: the first allowlist is in, and a minute is
              // long enough for every panel's reconnect burst to have passed. See
              // settleLoopDelay() for why the since-boot figure misled.
              setTimeout(() => stats.settleLoopDelay(), LOOP_SETTLE_MS).unref?.();
              // Publish now rather than at the next sampling tick. The ESPHome publisher starts
              // before any allowlist exists and rightly refuses to publish zeros until one does —
              // so every restart left the sensors `unknown` for up to a minute, a blip in every
              // history graph. MQTT's retained state used to hide that gap; the native API has no
              // retained state, so the first real values have to go out the moment they exist.
              esphomeSensors.push();
            }
            else applyAllow(next, 'recomputed (reconnect)', { merge: true });
            // lovelace_updated -> a dashboard's cards changed. The *_registry_updated
            // events -> a device moved area, a label was (un)assigned, etc., which can
            // change what an area/label/device/integration auto-entities filter resolves
            // to (issue #4). Rebuild (debounced) on any of them.
            for (const ev of WATCH_EVENTS) await rpc({ type: 'subscribe_events', event_type: ev });
            log(`watching ${WATCH_EVENTS.join(', ')} for live allowlist updates`);

            // Lovelace RESOURCES are not on the event bus. Home Assistant's storage collections
            // notify in-process listeners and over a per-collection websocket subscription —
            // `hass.bus.async_fire` is never called for them — so no `subscribe_events` topic
            // exists to watch, and a resource added, removed or re-versioned was invisible here
            // until the next restart. Verified against helpers/collection.py before relying on
            // it: the mechanism is DictStorageCollectionWebsocket's `_ws_subscribe`.
            //
            // Best-effort on purpose. It is not part of the documented websocket API and could
            // be renamed, so a failure is logged once and everything else carries on — with the
            // path-based identity above, the case this still covers is a resource genuinely
            // being ADDED or REMOVED, not merely re-versioned.
            if (TRIM_RESOURCES) {
              try {
                resourceSubId = await rpc({ type: 'lovelace/resources/subscribe' });
                log('watching lovelace/resources for added or removed custom cards');
              } catch (e) {
                resourceSubId = null;
                log(`  note: lovelace/resources/subscribe unavailable (${e.message}) — a resource `
                  + 'added or removed while running needs a restart to be seen');
              }
            }
          } catch (e) {
            // A BUG here can never succeed on retry, and retrying it hides it completely.
            //
            // This catch exists for the operational case: Home Assistant answered the handshake
            // and then died mid-build, which a reconnect genuinely fixes. A ReferenceError or
            // TypeError is a different animal — the code is wrong, every retry fails the same
            // way, and the add-on sits up with NO allowlist logging "reconnecting" once a second.
            // That is a silent outage that reads like a slow Home Assistant.
            //
            // Measured twice in one afternoon: `id is not defined` and, nearly, `path is not
            // defined`. Both left a running process serving nothing. The process-level handler
            // above already draws this line — only network errnos are survivable — so this local
            // catch just has to stop being more forgiving than the global one.
            if (e instanceof ReferenceError || e instanceof TypeError || e instanceof SyntaxError) {
              console.error('fatal: post-auth setup hit a code error, which retrying cannot fix:', e);
              process.exit(1);
            }
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
        // A resource collection change set. Shape is the collection's own, not a bus event, so
        // it is matched by subscription id rather than by event_type.
        if (m.type === 'event' && resourceSubId !== null && m.id === resourceSubId) {
          log('lovelace resources changed — rebuilding');
          scheduleRecompute('resources');
          return;
        }
        if (m.type === 'event' && WATCH_EVENTS.includes(m.event?.event_type)) {
          const ev = m.event.event_type;
          if (!registryEventMatters(ev, m.event.data)) return;
          const why = ev === 'lovelace_updated' ? (m.event.data?.url_path ?? '(default)') : ev;
          log(`${ev}: ${ev === 'lovelace_updated' ? why : describeRegistryEvent(m.event.data)}`.trim());
          scheduleRecompute(why, ev === 'lovelace_updated' ? 0 : REGISTRY_REBUILD_MIN_MS);
          return;
        }
        if (m.type === 'result' && pending[m.id]) { const p = pending[m.id]; m.success ? p[0](m.result) : p[1](new Error(JSON.stringify(m.error))); delete pending[m.id]; }
      });

      const onGone = (e) => {
        if (gone) return; gone = true;
        if (CONTROL_RPC === rpc) CONTROL_RPC = null;
        // `recomputeTimer` outlives this socket (it is shared across reconnects), so a rebuild
        // debounced just before the drop would fire against the dead socket and log "recompute
        // failed". Nothing is lost by cancelling it: the reconnect rebuilds from scratch, and that
        // build reads the same ALWAYS / RES_ALWAYS lists a pending pin had already appended to.
        clearTimeout(recomputeTimer);
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
// proxyTimeout bounds how long we wait on HOME ASSISTANT, which nothing else did. Node's
// defaults leave that open-ended: `server.timeout` is 0, and `requestTimeout` only covers
// RECEIVING a request, not waiting for the upstream answer. So an HA that stalls rather than
// dies — a long GC pause, a wedged integration — left the request hanging and the socket held,
// and the error handler below never fired, because nothing errored. It just went quiet.
//
// Two properties make 120s safe rather than a new way to break camera streams:
//
//   * It is an INACTIVITY timer, not a total duration (`proxyReq.setTimeout` sets the socket
//     idle timeout). A long-lived HTTP stream — MJPEG camera, HLS — keeps resetting it as
//     frames flow, and only trips when the upstream actually goes silent.
//   * It applies to proxy.web() ONLY. httpxy wires it in webIncomingMiddleware; the ws path has
//     no timeout handling, so camera-signalling and Assist-pipeline upgrades are untouched.
//
// On fire httpxy calls proxyReq.destroy(), which reaches the 'error' handler below as an
// ordinary proxy error and answers 502 — turning an indefinite hang into a bounded failure the
// browser can retry.
const proxy = createProxyServer({
  target: HA_BASE, changeOrigin: true, ws: false, xfwd: true,
  proxyTimeout: PROXY_TIMEOUT_MS,
});

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

// What the CLIENT sent in X-Forwarded-For / -Proto, captured at the front door — before httpxy
// fills the headers in. httpxy's HTTP path sets each x-forwarded-* header ONLY WHEN ABSENT, so by
// the time `proxyReq` fires the header is always present and nothing says who wrote it.
const XFF_IN = Symbol('x-forwarded-for as received');
const XFP_IN = Symbol('x-forwarded-proto as received');
const captureForwarded = (req) => {
  req[XFF_IN] = req.headers['x-forwarded-for'] ?? null;
  req[XFP_IN] = req.headers['x-forwarded-proto'] ?? null;
};

// Our peer goes on the RIGHT of any chain the client supplied. Not optional, and not the same
// thing as keeping the chain intact:
//
// Home Assistant's forwarded middleware walks X-Forwarded-For from the right and takes the first
// address that is NOT in `trusted_proxies` as the client. This add-on runs with host networking,
// so DOCS tell people to trust 127.0.0.1. A LAN host that can reach the proxy port and sends
// `X-Forwarded-For: <kiosk-subnet ip>` on its own would, with the header merely preserved,
// arrive at HA as that kiosk — and `trusted_networks` would log it in without a password. With
// our peer appended, HA walks right-to-left, meets the forger's real address first, and stops
// there. node-http-proxy always appended; httpxy does not; this restores it on the one path
// where it was lost. (httpxy's ws() path still appends on its own — see proxyReqWs.)
//
// Proto has to stay in step: HA raises 400 unless len(proto) is 1 or equals len(for). A single
// scheme is left alone (it describes the whole chain); a chain gets our hop appended too.
function forwardedChain(req, incomingFor, incomingProto, scheme) {
  const peer = normalizeIp(req.socket?.remoteAddress);
  const out = {};
  if (!incomingFor) return out;
  const chain = normalizeXff(incomingFor);
  out.for = peer && chain ? `${chain}, ${peer}` : (chain || peer);
  const protos = String(incomingProto || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (protos.length > 1) out.proto = `${protos.join(', ')}, ${scheme}`;
  return out;
}
// Stamp the dashboard onto the browser itself.
//
// The IP hint below is coarse by construction: every device behind one NAT shares it, so a
// phone and a laptop on the same WAN address overwrite each other's attribution and the
// loser is served another dashboard's allowlist until it reloads. A cookie is per-browser,
// which is the granularity actually wanted.
//
// The VALUE is the dashboard path, not an opaque id, so attribution stays stateless: there
// is no server-side map to lose on restart, and the proxy can be restarted mid-session
// without any client losing its scope. A tampered value can only name another configured
// dashboard, which is a set the client could already reach, so it grants nothing.
proxy.on('proxyRes', (proxyRes, req) => {
  if (!PER_DASH) return;
  const dash = dashFromUrl(req.url);
  if (!dash) return;
  const existing = proxyRes.headers['set-cookie'];
  const prior = Array.isArray(existing) ? existing : existing ? [existing] : [];
  proxyRes.headers['set-cookie'] = [...prior, dashCookieHeader(dash)];
});

proxy.on('proxyReq', (proxyReq, req) => {
  const chain = forwardedChain(req, req[XFF_IN], req[XFP_IN], req.socket?.encrypted ? 'https' : 'http');
  if (chain.for) {
    proxyReq.setHeader('x-forwarded-for', chain.for);
    if (chain.proto) proxyReq.setHeader('x-forwarded-proto', chain.proto);
    return;
  }
  // No chain from the client: httpxy filled in our peer, which only needs normalising.
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
// A trimmed registry answer, reusable across connections.
//
// The registries are per-INSTANCE, not per-connection: for a given allowlist every client
// gets byte-identical rows. Without this, each connection that asks makes Home Assistant
// serialise the whole registry again — 16k rows and ~10MB for the entity registry here —
// and makes this proxy parse it again. A single kiosk load opens several websockets, and a
// handful of panels multiplies that into real CPU on the HA host for no new information.
//
// Keyed by allowlist VERSION as well as kind and dashboard, so a rebuild retires every
// entry rather than needing them hunted down; the rebuild also clears the map outright so
// stale generations cannot accumulate.
let ALLOW_VERSION = 0;
const REG_RESPONSE_CACHE = new Map();
// Keyed by the connection's ACTUAL allowlist, not by its dashboard.
//
// Keying on the dashboard alone is wrong whenever a connection carries more than its dashboard
// does — a `client_overrides` pin, a self-identified satellite, `user_overrides` — because two
// connections on one dashboard can then hold different sets and would share an entry built from
// the wrong one. The first fix for that was to make widened connections skip the cache, on the
// assumption they were a rare minority.
//
// That assumption was measured and found false: on a live instance MOST connections were
// widened (voice-satellite panels self-identify, and the admin user matches a user rule), and
// the hit rate fell from 97.9% to 9.1%. Correct, and nearly useless.
//
// So identity goes IN the key instead. Connections sharing an identical allowlist share an
// entry — including the same panel across its many reconnects, which is where the hits
// actually come from — and connections with different sets can never collide by construction.
const allowSignature = (allow) => {
  // FNV-1a over the sorted ids. Sorting is what makes it order-independent, and it runs ONCE
  // per connection (see allowSig in bridge), against re-serialising a ~10MB registry per
  // connection if it misses — so the cost is not close to mattering.
  let h = 0x811c9dc5;
  for (const id of [...allow].sort()) {
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2c; h = Math.imul(h, 0x01000193);      // separator, so ["ab","c"] != ["a","bc"]
  }
  return `${allow.size}:${(h >>> 0).toString(36)}`;
};
const regCacheKey = (kind, dash, sig) => `${kind}|${dash ?? '(union)'}|${ALLOW_VERSION}|${sig}`;
// Distinct allowlists are few in practice (one per dashboard, plus one per widened client), and
// every entry is retired on an allowlist rebuild. The cap is purely a stop against an
// unforeseen key explosion quietly turning a cache into a memory leak.
const REG_CACHE_MAX = 200;
function regCacheSet(key, value) {
  if (REG_RESPONSE_CACHE.size >= REG_CACHE_MAX && !REG_RESPONSE_CACHE.has(key)) {
    logThrottled('regcache-full', `registry cache hit ${REG_CACHE_MAX} entries — clearing`);
    REG_RESPONSE_CACHE.clear();
  }
  REG_RESPONSE_CACHE.set(key, value);
}

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
  // Per-connection where possible, falling back to the union set when the lookups are not built
  // yet — passing everything through rather than blanking names is the existing safety rule.
  const reach = reachFor(allow);
  const keep = reach
    ? (kind === 'device' ? reach.devices : reach.areas)
    : (kind === 'device' ? REG_CACHE.devices : REG_CACHE.areas);
  if (!keep.size) return rows;
  const idOf = (r) => (kind === 'device' ? r?.id : (r?.area_id ?? r?.id));
  return rows.filter((r) => keep.has(idOf(r)));
}

// Which devices/areas the current allowlist still reaches. Built from the control
// connection's own registry fetch, so a browser asking for devices before entities still
// gets a correct answer. Areas come from the entities directly AND from the devices those
// entities belong to, because an entity with no area_id of its own inherits its device's.
const REG_CACHE = { devices: new Set(), areas: new Set() };
// entity -> its device / its own area, and device -> its area. Lookups, so the device and area
// registries can be cut to what ONE CONNECTION reaches instead of what every dashboard reaches.
//
// REG_CACHE below is built from the UNION allowlist, and using it to trim meant a panel with 48
// entities received every device and area reachable by all 418 union entities. That is why the
// device registry trimmed to 87% while the entity registry — which has always used the
// per-connection set — managed 99.3% on the same principle.
const REG_BY_ENTITY = { device: new Map(), area: new Map() };
const AREA_BY_DEVICE = new Map();
// Reachable devices/areas for one connection's allowlist. O(|allow|), run a few times per page
// load, against a registry answer that is measured in hundreds of kilobytes.
function reachFor(allow) {
  if (!REG_BY_ENTITY.device.size && !REG_BY_ENTITY.area.size) return null;   // not built yet
  const devices = new Set(); const areas = new Set();
  for (const id of allow) {
    const d = REG_BY_ENTITY.device.get(id); if (d) devices.add(d);
    const a = REG_BY_ENTITY.area.get(id); if (a) areas.add(a);
  }
  // An entity with no area of its own inherits its device's — the same rule rebuildRegCache uses.
  for (const d of devices) { const a = AREA_BY_DEVICE.get(d); if (a) areas.add(a); }
  return { devices, areas };
}
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

  REG_BY_ENTITY.device = new Map();
  REG_BY_ENTITY.area = new Map();
  AREA_BY_DEVICE.clear();
  for (const r of registries?.entities ?? []) {
    if (r.device_id) REG_BY_ENTITY.device.set(r.entity_id, r.device_id);
    if (r.area_id) REG_BY_ENTITY.area.set(r.entity_id, r.area_id);
  }
  for (const d of registries?.devices ?? []) if (d.area_id) AREA_BY_DEVICE.set(d.id, d.area_id);
}

// ---- per-dashboard Lovelace resources ----
// Namespaces the frontend resolves itself; an `mdi:` icon needs no custom resource.
const BUILTIN_ICON_NS = new Set(['mdi', 'hass', 'hassio', 'homeassistant', 'custom']);

const RESOURCE_CACHE = new Map();     // url -> { tested:Set, present:Set|null, bytes }
let RESOURCES_BY_DASH = new Map();    // dash -> Set(url) to keep
let LAST_RESOURCE_REPORT = null;      // the text of the last report printed — see buildResources
let RESOURCE_ALL_PATHS = new Set();   // every resource path HA has registered
// Per-dashboard resource figures for the stats panel. Populated by buildResources().
let RESOURCE_STATS = new Map();       // dash -> { kept, dropped, keptKB, droppedKB }
// The URLs behind those counts. Held so the panel can show WHICH resources were dropped and how
// big they were — the log has always said this, but reading it means SSH and a scroll, which is
// why the tuning loop is the part of this add-on people get wrong.
let RESOURCE_DROPPED_ALL = [];        // [{ url, kb }] dropped by every dashboard
let RESOURCE_DROPPED_BY_DASH = new Map();   // dash -> [{ url, kb }]
// dash -> [card type]. Card types the dashboard renders that a DROPPED resource demonstrably
// defines and no kept one does. See buildResources for why this uses literal evidence only.
let RESOURCE_UNMET_BY_DASH = new Map();
// { checkable, unknowable } — how much of the answer is knowable at all, reported alongside it
// so the silence is legible rather than mistaken for a clean bill of health.
let RESOURCE_UNMET_COVERAGE = { checkable: 0, unknowable: 0 };
// How big the instance actually is, taken from the control connection's own get_states —
// which asks for everything by definition. Lets the panel say "104 of 9,751", not just "104".
let INSTANCE_ENTITIES = 0;
// [[entity_id, friendly_name]] for the whole instance. See buildAllow.
let ALL_ENTITIES = [];
// Every device, by the name a rule would name it and with the size of what it expands to. Kept
// for the same reason as ALL_ENTITIES: the console offers a device picker, and asking Home
// Assistant again on every keystroke to answer "which devices are there" is absurd when the
// registry has just been read. Names only — no areas, no identifiers, nothing the picker cannot
// render. The entity registry this is derived from is ~10MB; this is a few hundred short strings.
let ALL_DEVICES = [];

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

// The top-level keys Home Assistant itself defines on a dashboard config. Anything else at that
// level was put there by a frontend MODULE to configure itself — that is the established
// convention, and it is how kiosk-mode, swipe-navigation and their kind are set up.
const KNOWN_DASH_KEYS = new Set([
  'title', 'views', 'background', 'strategy', 'template', 'config', 'theme', 'max_columns',
]);

// Font families a stylesheet declares, from its @font-face blocks.
//
// A CSS resource names no custom element, so the card matcher has nothing to match on and every
// stylesheet was dropped for every dashboard. That is right by accident when nothing uses the
// font and WRONG SILENTLY when something does: a missing font throws no error and logs nothing,
// the dashboard simply renders in the fallback face. This gives stylesheets something to be
// matched on.
//
// The body is already fetched for the card scan, so this costs no extra request.
function fontsDeclaredIn(body) {
  const out = new Set();
  // Only inside @font-face: a `font-family: Quicksand` in an ordinary rule means the file USES
  // the font, not that it provides it, and keeping a stylesheet because it mentions a font it
  // does not carry would keep almost everything.
  for (const m of String(body).matchAll(/@font-face\s*\{([^}]*)\}/gi)) {
    const fam = m[1].match(/font-family\s*:\s*(['"]?)([^;'"]+)\1/i);
    if (fam && fam[2]) out.add(fam[2].trim().toLowerCase());
  }
  return out;
}

// Everywhere a dashboard could ask for a font — but ONLY what is actually named as a font.
//
// Two sources, and the second is the one that matters: a font is far more often set by a THEME
// than by a card. Scanning only the dashboard config would drop the stylesheet a theme depends
// on — silently, which is the failure this exists to prevent.
//
// The values are extracted from `font-family` declarations rather than searched for in the raw
// config, and that is not fussiness. Card bundles declare fonts with names like `inter`, and a
// substring search finds that inside "printer", "interval" and "winter" — so a dashboard that
// mentions a printer would have kept a 663KB bundle. Matching only what follows `font-family`
// (in CSS, in card_mod, and in theme variables like `primary-font-family`) removes the entire
// class of false positive without weakening the real match.
function fontTextFor(cfg, themeNames, themeBlobs) {
  let raw = '';
  try { raw = JSON.stringify(cfg) || ''; } catch { raw = ''; }
  for (const t of themeNames) raw += ' ' + (themeBlobs.get(t) || '');
  // The default themes apply wherever a dashboard names none, so they always count.
  const defaults = themeBlobs.get('__defaults__');
  if (defaults) raw += ' ' + defaults;
  raw = raw.toLowerCase();

  const parts = [];
  // Skips the punctuation between the property and its value, which differs between CSS
  // (`font-family: x`) and a theme's JSON (`"primary-font-family":"x"`).
  for (const m of raw.matchAll(/font-family["'\s:=]*([^;"',}\\]+)/g)) parts.push(m[1].trim());
  return parts.join(' | ');
}

function resourceKeys(cfg, allowed = null, byId = null) {
  const cards = new Set();      // custom card/row/badge/feature types
  const icons = new Set();      // non-builtin icon namespaces
  // Resident modules named by their own config block — see collectModules below.
  const modules = new Set();
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

  // Modules that render no card, found by the config block they read.
  //
  // The walk above only ever looks at VALUES, and only at ones shaped like `custom:x` — which is
  // right for cards, and blind to everything that runs on page load instead of rendering. A
  // dashboard with `kiosk_mode:` at its top level is unambiguously asking for kiosk-mode.js, but
  // `kiosk_mode` is a KEY, and its values are booleans, so nothing in the walk ever sees it. That
  // is why such modules had to be listed in `resources_always_forward` by hand: not because the
  // evidence was missing from the config, but because it was in a place nothing looked.
  //
  // TOP LEVEL ONLY, and only keys Home Assistant does not define itself. Walking every key at
  // every depth would be the obvious generalisation and it is the one that breaks this: `type`,
  // `entity`, `title` and `cards` occur in every config and as substrings in every bundle, so
  // everything would match everything and the trim would quietly stop trimming — the same failure
  // the MIN_KEY and fragment-frequency rules above exist to prevent.
  //
  // Both spellings are recorded. A module reads its own config key with an underscore
  // (`kiosk_mode`) and names its files and elements with a hyphen (`kiosk-mode`); measured
  // against the real bundles, both literals are present in each, but which one a given module
  // writes is not something to assume.
  if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
    for (const key of Object.keys(cfg)) {
      if (KNOWN_DASH_KEYS.has(key)) continue;
      const raw = key.toLowerCase();
      if (raw.length < MIN_KEY || !/^[a-z][a-z0-9_-]*$/.test(raw)) continue;
      modules.add(raw);
      const hyphen = raw.replace(/_/g, '-');
      if (hyphen !== raw) modules.add(hyphen);
    }
  }
  return { cards, icons, modules };
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
// because the evidence is much stronger: "mushroom" appears in 2 files out of 48, so a bundle
// containing it is almost certainly the Mushroom bundle, whereas "cover" tells you nothing.
let FRAG_RARE_MAX = 2;
const isRare = (f) => (FRAG_DF.get(f) || 0) <= FRAG_RARE_MAX;

// Does this bundle look like it provides `type`?
//
// The literal name is the strong signal. The fragment fallback exists for bundles that BUILD
// their element names at runtime: `ha-bambulab-cards.js` is 3.2MB, a dashboard renders
// `ha-bambulab-print_status-card`, and that string appears nowhere in the file — only
// `bambulab` and `print_status` separately.
//
// The literal check is the reliable one, but plenty of card packs never write their own card
// names down: Mushroom registers elements from template literals, so "mushroom-cover-card"
// appears nowhere in mushroom.js. That is not an edge case — it silently dropped the entire
// Mushroom family, which is one of the most widely installed card sets there is.
//
// Two rules used to make that unavoidable, and both are gone:
//   - requiring EVERY fragment to be present, so one missing generic word ("cover") discarded
//     the bundle even when a near-unique one ("mushroom") was right there;
//   - requiring TWO distinctive fragments, which no `<oneword>-<generic>-card` name can ever
//     satisfy.
//
// Now: one RARE fragment is enough on its own, otherwise fall back to two merely distinctive
// ones. Erring toward keeping is the right bias — a resource kept needlessly costs bytes, a
// resource wrongly dropped breaks a card.
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

// A resource's IDENTITY is its path. The query string is a cache-buster, not part of what the
// resource IS: HACS appends `?hacstag=<id><version>` and bumps it on every single update, and
// other setups use `?v=`. Keying the keep-set on the full URL therefore guaranteed a silent
// breakage on EVERY card update — the path never moved, the file never moved, but the URL the
// frontend asked for no longer matched the one we had decided to keep, so the resource was
// dropped and the card rendered as an error with no message anywhere.
//
// Reported by the lovelace-navbar-card author, found on a HACS bump from ...62 to ...63.
//
// Note the body cache (RESOURCE_CACHE) is still keyed by FULL url, and correctly so: a new
// version tag means genuinely different bytes to fetch and re-scan. Only identity is path-based.
const resourcePath = (url) => String(url ?? '').split('?')[0];

// Which resources actually PROVIDE a card type, judged by their own path.
//
// The literal test below is described as the strong signal, and for deciding "could this bundle
// define this card" it is. It is not evidence of the reverse: a bundle that merely MENTIONS
// another card's name matches it just as well. Measured on a real instance, that kept four
// bundles a dashboard never used — bubble-card and simple-swipe-card both contain the string
// `grid-layout`, utility-cards and swipe-navigation both contain `navbar-card`, because each
// integrates with them. On a px30 wall panel those four cost 1,326 ms of parsing on every load,
// 10% of a 13.3-second cold start, for cards that were never on the page.
//
// A card's provider almost always says so in its FILE NAME: `navbar-card` lives in
// navbar-card.js, `whisker-card` in whisker.js, `grid-layout` in layout-card.js. So when some
// resource's path identifies it as the provider, only those resources satisfy that card type,
// and a bundle that merely name-drops it no longer counts.
//
// The frequency test uses PATH frequency, not body frequency, and the distinction matters: on
// that instance `layout` appears in 24 of 42 bundle bodies — far too common to identify anything
// — while naming exactly one file. Judged by bodies it is noise; judged by paths it is the answer.
//
// When nothing identifies a provider this returns null and the old body test runs unchanged, so
// the failure mode is the behaviour that shipped before, never a resource dropped on a guess.
const PATH_FRAG_MAX = 3;
function pathProviders(type, rows, pathFragDf, sharedFrags, sharedMax) {
  const t = String(type).toLowerCase();
  const pathOf = (u) => resourcePath(u).toLowerCase();
  const base = (u) => pathOf(u).split('/').pop().replace(/\.js$/, '');
  // Strongest: the path spells the card type out, or the file is named exactly for it.
  const exact = rows.filter((r) => pathOf(r.url).includes(t) || base(r.url) === t);
  if (exact.length) return new Set(exact.map((r) => resourcePath(r.url)));
  // Otherwise a fragment that names very few files is enough to point at the provider — but only
  // if the fragment belongs to THIS card type alone. `card` names a file in almost every install
  // and is a fragment of half the card types on a dashboard, so it identifies nothing; the test
  // that catches it is scale-free, unlike a frequency threshold, which a small install defeats by
  // making every fragment look rare.
  const frs = cardFragments(type).filter((f) => (pathFragDf.get(f) ?? Infinity) <= PATH_FRAG_MAX
    && (sharedFrags.get(f) ?? 0) <= sharedMax);
  if (!frs.length) return null;
  const hits = rows.filter((r) => frs.some((f) => pathOf(r.url).includes(f)));
  return hits.length ? new Set(hits.map((r) => resourcePath(r.url))) : null;
}

// The per-CONNECTION answer, layered on the per-dashboard one. A rule that names this client (or
// this user) is the most specific statement available about what it needs, so its own lists come
// first: never, then always, then whatever its dashboard decided. `keep` is null for a connection
// that could not be attributed, which is sent everything, as before.
function keepResourceFor(url, keep, rr) {
  const u = String(url ?? '');
  if (rr && matchesUrl(rr.never, u)) return false;
  if (rr && matchesUrl(rr.always, u)) return true;
  return !keep?.size || keep.has(resourcePath(u));
}

function keepResource(url, keys, providers = null) {
  if (matchesUrl(RES_NEVER, url)) return false;
  if (matchesUrl(RES_ALWAYS, url)) return true;
  const c = RESOURCE_CACHE.get(url);
  if (!c || c.unreadable) return true;            // cannot check, so keep
  for (const k of keys.icons) if (c.icons.has(k)) return true;
  // A stylesheet that declares a font this dashboard asks for, in its config or in a theme it
  // uses. Kept deliberately ahead of the card tests: a font resource has no card names to match,
  // so without this it can only ever be dropped.
  if (c.fonts?.size) {
    // null means the themes could not be read, so we genuinely do not know — keep, the same rule
    // an unreadable resource already follows. An EMPTY STRING is a different answer: we looked and
    // this dashboard names no font at all, which is the common case and must drop.
    //
    // Conflating the two cost 1,940KB per dashboard on a live instance — every bundle that
    // happens to carry an @font-face, kept on every dashboard that simply does not style fonts.
    if (keys.fontText == null) return true;
    for (const f of c.fonts) if (keys.fontText.includes(f)) return true;
  }
  for (const k of keys.cards) {
    const prov = providers?.get(k);
    // A provider is known for this card type, so only the provider counts for it.
    if (prov) { if (prov.has(resourcePath(url))) return true; continue; }
    if (cardMatchesBody(k, c)) return true;
  }
  // Same body test as a card, but kept in its own set so these never reach the "card will not
  // render" report — a config block is not a card, and warning that `kiosk_mode` failed to
  // render would be a warning about something that was never going to.
  for (const k of (keys.modules ?? [])) if (cardMatchesBody(k, c)) return true;
  return false;
}

// Modules Home Assistant injects into the page itself, via `frontend.add_extra_js_url`.
//
// These never appear in `lovelace/resources`, so `trim_resources` cannot see them — an
// integration simply adds a <script> import to every page and every dashboard pays for it. On the
// instance this was written against that is 814KB, of which 669KB is a card
// (`voice-satellite-card.js`) that the resource trim had ALREADY decided a given dashboard does
// not need. It was dropped from the resource list and loaded anyway, through the other door.
//
// The rule is deliberately narrow: a module is removed only when it is ALSO a registered Lovelace
// resource AND the resource trim dropped it for this dashboard. That is not a new inference — it
// is the existing decision, applied to the channel it was leaking through. Icon packs, frontend
// patchers and anything else injected but never registered as a resource are left alone, because
// nothing here knows what they do. `resources_never_forward` / `resources_always_forward` still
// win, in that order, so there is a manual override in both directions.
//
// HA renders each injected module as one self-contained block:
//
//     import("/x/y.js?v=1").catch(function (err) {
//       console.error("Failed to load extra module /x/y.js?v=1", err);
//     });
//
// so removing a module means removing exactly that block. The pattern is anchored on both ends
// and cannot span two blocks, and if it matches nothing the page is returned untouched.
const EXTRA_MODULE_RE = /\bimport\("([^"]+)"\)\.catch\(function \(err\) \{\s*console\.error\("Failed to load extra module [^"]*", err\);\s*\}\);/g;

// What the last served page for each dashboard removed, and what it left behind. Recorded rather
// than merely logged, because this trim edits a page that is then cached by the browser: a person
// debugging a missing behaviour days later needs to see what was taken out without having to
// catch a log line at the moment it happened.
const EXTRA_MODULES_BY_DASH = new Map();   // dash -> { removed: [...], kept: [...] }

function stripExtraModules(html, dash, rr = null) {
  const keep = RESOURCES_BY_DASH.get(dash);
  const dropped = [];
  const survived = [];
  const out = html.replace(EXTRA_MODULE_RE, (block, url) => {
    const path = resourcePath(url);
    // The requesting client's own rules first, same order as keepResourceFor. Only rules decided
    // at connection time can reach here — a page load carries no auth token, so a rule keyed to a
    // user cannot be evaluated for it. That rule still keeps the resource in lovelace/resources,
    // and the frontend imports every resource in that list, so the bundle loads either way.
    if (rr && matchesUrl(rr.never, url)) { dropped.push(path); return ''; }
    if (rr && matchesUrl(rr.always, url)) { survived.push(path); return block; }
    if (matchesUrl(RES_ALWAYS, url)) return block;
    const isDroppedResource = RESOURCE_ALL_PATHS.has(path) && keep?.size && !keep.has(path);
    if (!isDroppedResource && !matchesUrl(RES_NEVER, url)) { survived.push(path); return block; }
    dropped.push(path);
    return '';
  });
  if (dropped.length || survived.length) {
    EXTRA_MODULES_BY_DASH.set(dash, { removed: dropped.slice(0, 40), kept: survived.slice(0, 40) });
  }
  return { html: out, dropped };
}

async function buildResources(rpc, keysByDash) {
  if (!TRIM_RESOURCES) return;
  let rows;
  try { rows = await rpc({ type: 'lovelace/resources' }); }
  catch (e) { log(`  resources: FAILED (${e.message}) — forwarding all resources`); RESOURCES_BY_DASH = new Map(); RESOURCE_STATS = new Map(); return; }
  if (!Array.isArray(rows)) { RESOURCES_BY_DASH = new Map(); RESOURCE_STATS = new Map(); return; }

  // The report is collected, then printed only if it differs from the last one printed. Every
  // rebuild used to reprint all of it — some sixty lines on the instance this was measured on,
  // identical each time — so a run of no-change rebuilds pushed everything else out of the log.
  // Problems still go out immediately through warn(); this only quietens the routine half.
  const report = [];
  const say = (line) => report.push(line);

  // Every token any dashboard could match on, tagged by kind so a card type and an icon
  // namespace that happen to share a name can never be confused for one another.
  const unionCards = new Set(), unionIcons = new Set(), unionModules = new Set();
  for (const ks of keysByDash.values()) {
    ks.cards.forEach((k) => unionCards.add(k));
    ks.icons.forEach((k) => unionIcons.add(k));
    (ks.modules ?? []).forEach((k) => unionModules.add(k));
  }
  // Module names are matched by exactly the same machinery as card types — literal first,
  // fragments as the fallback — so they go into the same two body-scan sets.
  const literalNames = new Set([...unionCards, ...unionModules]);
  const unionFrags = new Set();
  for (const c of literalNames) for (const f of cardFragments(c)) unionFrags.add(f);
  const unionKeys = new Set([...[...unionCards].map((k) => 'card:' + k),
                             ...[...unionModules].map((k) => 'mod:' + k),
                             ...[...unionIcons].map((k) => 'icon:' + k),
                             ...[...unionFrags].map((k) => 'frag:' + k)]);
  // One fetch per resource, tested against every dashboard's keys at once. Bodies are read
  // and discarded one at a time — the whole set is ~21MB on a large install and must not be
  // held in memory. The cache is keyed by URL, which carries HACS's version tag, so an
  // updated card re-fetches on its own.
  for (const r of rows) {
    const c = RESOURCE_CACHE.get(r.url);
    // A failed read is retried after 5 minutes rather than being final: a bundle that answered 503 once
    // must not stay unscanned (and its cards dropped) until its URL changes.
    if (c && (!c.unreadable || Date.now() - c.at < 300000) && [...unionKeys].every((k) => c.tested.has(k))) continue;
    try {
      const abs = /^https?:/i.test(r.url) ? r.url : HA_BASE + r.url;
      const res = await fetch(abs, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      RESOURCE_CACHE.set(r.url, {
        tested: new Set(unionKeys),
        literal: new Set([...literalNames].filter((k) => body.includes(k))),
        icons: new Set([...unionIcons].filter((k) => bodyHasIcon(body, k))),
        frags: new Set([...unionFrags].filter((f) => body.includes(f))),
        fonts: fontsDeclaredIn(body),
        unreadable: false,
        bytes: body.length,
      });
    } catch (e) {
      RESOURCE_CACHE.set(r.url, { tested: new Set(unionKeys), literal: new Set(), icons: new Set(), frags: new Set(), fonts: new Set(), unreadable: true, bytes: 0, at: Date.now() });
      logThrottled(`res:${r.url}`, `  resources: could not read ${r.url} (${e.message}) — always forwarding it`);
    }
  }

  // Forget resources that are no longer configured (a HACS update changes the versioned URL).
  const liveUrls = new Set(rows.map((r) => r.url));
  for (const u of RESOURCE_CACHE.keys()) if (!liveUrls.has(u)) RESOURCE_CACHE.delete(u);

  // Document frequency across the resources we could actually read. A fragment in more than
  // a quarter of them identifies nothing, so it cannot carry a fragment match on its own.
  const readable = rows.filter((r) => !RESOURCE_CACHE.get(r.url)?.unreadable);
  FRAG_DF = new Map();
  for (const f of unionFrags) {
    FRAG_DF.set(f, readable.filter((r) => RESOURCE_CACHE.get(r.url).frags.has(f)).length);
  }
  // Path-frequency of every fragment, the denominator the provider test needs.
  const PATH_FRAG_DF = new Map();
  for (const f of unionFrags) {
    PATH_FRAG_DF.set(f, rows.filter((r) => resourcePath(r.url).toLowerCase().includes(f)).length);
  }
  // How many distinct card types each fragment belongs to, as a PROPORTION of the types in play.
  // A flat "more than one type disqualifies it" was tried and is too blunt: `layout` belongs to
  // grid-layout, vertical-layout, horizontal-layout and layout-card — four names out of some
  // thirty-five — yet names exactly one file, and disqualifying it left a 1 MB bundle in place on
  // a wall panel. `card` belongs to nearly every type, which is what makes it meaningless. The
  // quarter threshold separates the two and scales with the instance instead of the fixture.
  const SHARED_FRAGS = new Map();
  for (const t of unionCards) {
    for (const f of new Set(cardFragments(t))) SHARED_FRAGS.set(f, (SHARED_FRAGS.get(f) || 0) + 1);
  }
  const SHARED_MAX = Math.max(1, Math.floor(unionCards.size * 0.25));
  const PROVIDERS = new Map();
  for (const t of unionCards) {
    const p = pathProviders(t, rows, PATH_FRAG_DF, SHARED_FRAGS, SHARED_MAX);
    if (p) PROVIDERS.set(t, p);
  }
  if (PROVIDERS.size) {
    say(`  resources: ${PROVIDERS.size} of ${unionCards.size} card type(s) have an identifiable `
      + 'provider file; for those, bundles that only mention the name are not kept');
  }

  FRAG_DF_MAX = Math.max(1, Math.floor(readable.length * 0.25));
  FRAG_RARE_MAX = Math.max(2, Math.floor(readable.length * 0.05));
  const common = [...unionFrags].filter((f) => !isDistinctive(f));
  if (common.length) {
    say(`  resources: ${common.length} fragment(s) too common to identify a card (>${FRAG_DF_MAX} of ${readable.length}): ${common.sort().join(', ')}`);
  }

  const byDash = new Map();
  RESOURCE_STATS = new Map();
  RESOURCE_DROPPED_BY_DASH = new Map();
  RESOURCE_UNMET_BY_DASH = new Map();

  // Which resources LITERALLY name each card type. This is the only definitive card -> file
  // link available, and knowing its limits is the whole point.
  //
  // Static analysis of `customElements.define()` does not work: every bundle is minified, and
  // they register as `customElements.define(t, ...)` with the name in a variable. Measured on
  // real installs — navbar-card, button-card and bubble-card all do exactly that.
  //
  // But the name still has to exist as a string somewhere in a file that registers it, so a
  // literal occurrence IS evidence. Also measured: `navbar-card` appears 38 times in
  // navbar-card.js, `bubble-card` 20 times in bubble-card.js — while `mushroom-cover-card`
  // appears NOWHERE in mushroom.js and `ha-bambulab-print_status-card` nowhere in
  // ha-bambulab-cards.js, because both build their element names at runtime from a prefix.
  //
  // So this is precise where the evidence exists and SILENT where it does not. It is the
  // opposite of the previous attempt, which reused the lenient keep-matcher and therefore could
  // never fire. Fragments are deliberately not consulted here: they are right for deciding what
  // to KEEP (over-including is free) and wrong for deciding what to WARN about (over-warning
  // trains you to ignore it).
  const literalProviders = new Map();
  for (const r of rows) {
    const c = RESOURCE_CACHE.get(r.url);
    if (!c || c.unreadable) continue;
    for (const k of c.literal) {
      if (!literalProviders.has(k)) literalProviders.set(k, new Set());
      literalProviders.get(k).add(resourcePath(r.url));
    }
  }
  const checkable = new Set(), unknowable = new Set();
  for (const [dash, keys] of keysByDash) {
    const keep = new Set();
    let keptB = 0, dropB = 0;
    for (const r of rows) {
      const bytes = RESOURCE_CACHE.get(r.url)?.bytes || 0;
      if (keepResource(r.url, keys, PROVIDERS)) { keep.add(resourcePath(r.url)); keptB += bytes; }
      else dropB += bytes;
    }
    byDash.set(dash, keep);
    RESOURCE_DROPPED_BY_DASH.set(dash, rows
      .filter((r) => !keep.has(resourcePath(r.url)))
      // `fonts` is reported for a dropped stylesheet because that drop is the silent one: a
      // missing card says "Custom element doesn't exist", a missing font says nothing at all.
      // Seeing "provides quicksand, and this dashboard never asks for it" is the difference
      // between a five-minute answer and a typeface nobody can explain.
      .map((r) => {
        const c = RESOURCE_CACHE.get(r.url);
        const row = { url: r.url.split('?')[0], kb: Math.round((c?.bytes || 0) / 1024) };
        if (c?.fonts?.size) row.fonts = [...c.fonts];
        return row;
      })
      .sort((a, b) => b.kb - a.kb));
    RESOURCE_STATS.set(dash, {
      kept: keep.size, dropped: rows.length - keep.size,
      keptKB: Math.round(keptB / 1024), droppedKB: Math.round(dropB / 1024),
    });
    // A card this dashboard renders whose ONLY literal definer was dropped. That is a real
    // broken card: it will render as an error card with no message, no console error and no
    // network request, which is exactly how the navbar-card report took a hand diff to
    // diagnose. Cards with no literal definer anywhere are not reported — not because they are
    // fine, but because nothing here can tell.
    const unmet = [];
    for (const c of keys.cards) {
      const provs = literalProviders.get(c);
      if (!provs || !provs.size) { unknowable.add(c); continue; }
      checkable.add(c);
      // A file NAMED for this card, and kept, is enough to suppress the warning — but not enough
      // to claim the card verified, which is why this sits after the unknowable test rather than
      // before it. A filename is evidence about intent, not proof of what the bundle defines.
      // Without this, dropping a bundle that merely name-drops the card would report it as
      // unrenderable while the file that actually provides it sits in the keep set.
      const byPath = PROVIDERS.get(c);
      if (byPath && [...byPath].some((path) => keep.has(path))) continue;
      if (![...provs].some((path) => keep.has(path))) unmet.push(c);
    }
    if (unmet.length) {
      RESOURCE_UNMET_BY_DASH.set(dash, unmet.sort());
      warn(`  !! resources ${dash}: ${unmet.length} card type(s) will NOT render — `
        + `${unmet.join(', ')}. The file that defines each was dropped. `
        + `Add a matching fragment to resources_always_forward, or set trim_resources: false.`);
    }
    const needs = [...[...keys.cards].sort(), ...[...keys.icons].sort().map((i) => i + ':')];
    say(`  resources ${dash} needs: ${needs.join(', ') || '(none)'}`);
    say(`  resources ${dash}: ${keep.size}/${rows.length} kept (${(keptB / 1024).toFixed(0)}KB), ${rows.length - keep.size} dropped (${(dropB / 1024).toFixed(0)}KB)`);
  }
  RESOURCE_UNMET_COVERAGE = { checkable: checkable.size, unknowable: unknowable.size };
  if (unknowable.size) {
    say(`  resources: ${checkable.size} of ${checkable.size + unknowable.size} card type(s) can be `
      + `checked for a missing definition; ${unknowable.size} build their element name at runtime `
      + `(${[...unknowable].sort().slice(0, 6).join(', ')}${unknowable.size > 6 ? ', …' : ''}) `
      + `and cannot be verified from here.`);
  }
  RESOURCES_BY_DASH = byDash;
  // Every resource path Home Assistant knows about. An injected module is only ever removed when
  // it appears here — i.e. when it is ALSO a Lovelace resource, and therefore something the
  // resource trim has already formed a tested opinion about.
  RESOURCE_ALL_PATHS = new Set(rows.map((r) => resourcePath(r.url)));

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
  // `servedAnywhere` holds resourcePath() values, so the lookup must normalise too. Comparing
  // the raw `r.url` matched nothing the moment a URL carried a query string — which is EVERY
  // HACS resource, since they all arrive as `?hacstag=…`. The effect was that this warning
  // listed the entire resource list as "dropped by ALL dashboards", including bundles that were
  // being served perfectly well, and told the reader to add them to resources_always_forward —
  // i.e. it argued for undoing the trim. Reported against the live instance on 2026-09-15:
  // 42 of 42 resources named, on an install where one dashboard alone keeps 21.
  const droppedByAll = rows.filter((r) => !servedAnywhere.has(resourcePath(r.url)));
  RESOURCE_DROPPED_ALL = droppedByAll
    .map((r) => {
      const c = RESOURCE_CACHE.get(r.url);
      const row = { url: r.url.split('?')[0], kb: Math.round((c?.bytes || 0) / 1024) };
      if (c?.fonts?.size) row.fonts = [...c.fonts];
      return row;
    })
    .sort((a, b) => b.kb - a.kb);

  // Check the report against itself before printing it. See resource_invariants.mjs for why:
  // this list is the one diagnostic a reader cannot verify by looking at a dashboard, and acting
  // on a wrong one means undoing the trim. The warning goes ABOVE the list deliberately, so a
  // reader meets "these numbers are inconsistent" before they meet the numbers.
  const invariantProblems = resourceInvariantProblems({
    total: rows.length,
    keptByDash: new Map([...byDash].map(([d, keep]) => [d, keep.size])),
    droppedByAll: RESOURCE_DROPPED_ALL.map((r) => r.url),
    droppedByDash: new Map([...RESOURCE_DROPPED_BY_DASH]
      .map(([d, list]) => [d, new Set(list.map((r) => r.url))])),
  });
  for (const p of invariantProblems) {
    warn(`  resources: DIAGNOSTIC BUG — ${p}. Trimming itself is unaffected; this is the report `
      + `being wrong, so do not act on the list below.`);
  }

  if (droppedByAll.length) {
    const kb = droppedByAll.reduce((t, r) => t + (RESOURCE_CACHE.get(r.url)?.bytes || 0), 0) / 1024;
    say(`  resources: ${droppedByAll.length} dropped by ALL dashboards (no dashboard references them), ${kb.toFixed(0)}KB.`);
    say('    If any of these run on load rather than rendering a card — an idle timer, a');
    say('    pop-up, a heartbeat — add them to resources_always_forward. Dropping one of');
    say('    those is INVISIBLE: the dashboard renders normally and only the behaviour stops.');
    for (const r of droppedByAll) {
      const b = ((RESOURCE_CACHE.get(r.url)?.bytes || 0) / 1024).toFixed(0);
      say(`      drop ${String(b).padStart(6)}KB ${r.url.split('?')[0]}`);
    }
  }

  const text = report.join('\n');
  if (text === LAST_RESOURCE_REPORT) {
    log(`  resources: unchanged since the last report (${rows.length} registered) — not repeated`);
  } else {
    LAST_RESOURCE_REPORT = text;
    for (const line of report) log(line);
  }
}

// ---- which USER is this connection? ----
// The browser's first websocket message carries its access token, and that token IS the
// identity — so the proxy can ask Home Assistant who it belongs to instead of guessing from
// an address. Done on a SEPARATE short-lived connection on purpose: HA enforces strictly
// increasing message ids per connection, so injecting a lookup into the browser's own socket
// risks colliding with an id the frontend uses later.
//
// Cached by a hash of the token, never the token itself, and only long enough to cover a
// session's reconnects.
const USER_CACHE = new Map();                 // sha256(token) -> { user, at }
const USER_TTL_MS = 10 * 60 * 1000;
// Kept across restarts, in /data, so a restart does not make every session pay the lookup again.
//
// THE TTL IS NOT EXTENDED, and that is the point. "Users rarely change" argues for caching for
// hours, but a long window is exactly what makes a revoked token or a renamed user keep applying
// rules after Home Assistant has stopped agreeing. A rebuild takes about twelve seconds, so the
// existing ten minutes already spans a restart — persistence buys the restart case with no
// increase in staleness at all. Entries older than the TTL are dropped on load, so a file left
// from last week is simply ignored.
//
// What is written: sha256(token) -> { id, name }. Never the token, and nothing from the user
// object beyond what the rules match on. It is still a token VERIFIER and it is in /data, which
// Home Assistant backups include — that is the cost of this, and the reason it stores as little
// as it can get away with.
const USER_CACHE_FILE = CONFIG_DIR ? `${CONFIG_DIR}/users.json` : null;

function loadUserCache() {
  if (!USER_CACHE_FILE || !fs.existsSync(USER_CACHE_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(USER_CACHE_FILE, 'utf8'));
    const now = Date.now();
    let kept = 0, expired = 0;
    for (const [key, v] of Object.entries(raw?.users || {})) {
      // is_admin must be present: an entry written before the role matcher existed would make a
      // `role: admin` rule silently fail to match for the rest of its TTL. Dropping it costs one
      // lookup and gets the right answer immediately.
      if (!v?.user?.id || typeof v.at !== 'number') continue;
      if (typeof v.user.is_admin !== 'boolean') { expired++; continue; }
      // Same reasoning as is_admin: an entry written before auth_provider existed would make such
      // a rule silently fail to match for the rest of its TTL.
      if (!Array.isArray(v.user.providers)) { expired++; continue; }
      if (now - v.at >= USER_TTL_MS) { expired++; continue; }
      USER_CACHE.set(key, { user: v.user, at: v.at });
      kept++;
    }
    if (kept || expired) log(`user cache: ${kept} still valid, ${expired} expired`);
  } catch (e) {
    // A corrupt cache must never cost the add-on its boot: the worst case without it is that
    // the next lookup is slow, which is the state this file exists to improve, not to require.
    warn(`could not read ${USER_CACHE_FILE} (${e.message}) — starting with an empty user cache`);
  }
}

// Written through a temp file and renamed, like every other file this add-on owns, so a crash
// mid-write cannot leave one that fails to parse on the next boot.
function saveUserCache() {
  if (!USER_CACHE_FILE) return;
  try {
    const users = {};
    for (const [k, v] of USER_CACHE) users[k] = v;
    const tmp = `${USER_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, users }));
    fs.renameSync(tmp, USER_CACHE_FILE);
  } catch (e) {
    logThrottled('usercache-write', `could not write the user cache (${e.message})`);
  }
}
// Generous, because the cost of timing out is silently serving the wrong allowlist, while the
// cost of waiting is a one-off delay on a connection that is already waiting on Home Assistant
// anyway. Only ever paid once per token per TTL, and never when HA is healthy.
const USER_LOOKUP_TIMEOUT_MS = 8000;

function tokenKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Lookups in flight, by token hash. A kiosk load opens several websockets within a few
// milliseconds of each other, all carrying the same token, and each one used to open its own
// probe socket to Home Assistant before the first had answered — N identical questions for one
// answer, on the busiest moment of a page load. The second and later callers now wait on the
// first's promise. The result is cached the moment it lands, so nothing after that pays either.
const USER_INFLIGHT = new Map();                // sha256(token) -> Promise<user|null>

// `fwd` is the X-Forwarded-* set of the request this lookup is on behalf of (forwardHeadersFor).
// Without it Home Assistant attributes the probe to THIS PROXY's address, and a rejected token is
// a failed login: with `ip_ban_enabled`, one panel retrying a stale token — or anything on the LAN
// posting junk Bearer tokens at the panel status endpoint — walks the proxy's own address to the
// ban threshold and takes every panel down with it. Failures are deliberately not cached (see
// finish), so every retry is another probe. The bridge socket was fixed for exactly this; the
// probe beside it was not. A deduplicated caller rides on the first caller's headers, which is
// the same client in every case that matters: one page load, one token, several sockets.
function resolveUser(token, fwd = null) {
  const key = tokenKey(token);
  const hit = USER_CACHE.get(key);
  if (hit && Date.now() - hit.at < USER_TTL_MS) return Promise.resolve(hit.user);
  const inflight = USER_INFLIGHT.get(key);
  if (inflight) return inflight;

  const lookup = new Promise((resolve) => {
    let settled = false;
    const finish = (user) => {
      if (settled) return;
      settled = true;
      // Only cache a REAL answer. Caching a failure meant one slow moment from Home Assistant
      // disabled a user's rules for the full TTL — the rules silently stopped applying long
      // after HA recovered, which is exactly how "my updates disappeared" happened.
      if (user) {
        // Only what the rules match on, so the file on disk carries no more identity than it
        // must — see the note on USER_CACHE_FILE.
        // is_admin joins id and name because a rule can now match on it. Still only what the
        // rules read — the rest of Home Assistant's user object stays out of the file.
        // Deleted first so the entry moves to the END of the Map: eviction below takes the first
        // key, and Map.set on an existing key keeps its old place, so a user refreshed every few
        // minutes stayed first in line to be evicted.
        USER_CACHE.delete(key);
        USER_CACHE.set(key, {
          user: {
            id: user.id,
            name: user.name,
            is_admin: Boolean(user.is_admin),
            // Just the provider TYPES, not the credential records: a rule asks "how did they sign
            // in", never "which credential".
            providers: (user.credentials || []).map((c) => String(c?.type || '').toLowerCase()),
          },
          at: Date.now(),
        });
      }
      if (USER_CACHE.size > 200) USER_CACHE.delete(USER_CACHE.keys().next().value);
      if (user) saveUserCache();
      try { ws.close(); } catch {}
      resolve(user);
    };
    const timer = setTimeout(() => finish(null), USER_LOOKUP_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    let ws;
    try { ws = new WebSocket(HA_WS, { perMessageDeflate: false, headers: fwd || {} }); }
    catch { clearTimeout(timer); return resolve(null); }

    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'auth_required') return ws.send(JSON.stringify({ type: 'auth', access_token: token }));
      if (m.type === 'auth_ok') return ws.send(JSON.stringify({ id: 1, type: 'auth/current_user' }));
      if (m.type === 'auth_invalid') { clearTimeout(timer); return finish(null); }
      if (m.type === 'result' && m.id === 1) {
        clearTimeout(timer);
        return finish(m.success ? (m.result ?? null) : null);
      }
    });
    // A failed lookup must never break the connection it was asked about: no user, no rules.
    ws.on('error', () => { clearTimeout(timer); finish(null); });
    ws.on('close', () => { clearTimeout(timer); finish(null); });
  });
  USER_INFLIGHT.set(key, lookup);
  // Never rejects (finish() resolves null on every failure), so a bare then() is safe here.
  lookup.then(() => USER_INFLIGHT.delete(key));
  return lookup;
}

// ---- client-pinned rules ----

// Parse "10.2.4.0/24" into a test. IPv4 only on purpose: a CIDR here exists to name a VLAN of
// wall panels, and anything needing IPv6 subtleties is better served by listing addresses.
function parseCidr(s) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(s);
  if (!m) return null;
  const bits = Number(m[2]);
  if (bits > 32) return null;
  const toInt = (ip) => ip.split('.').reduce((a, o) => (a << 8 >>> 0) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (toInt(m[1]) & mask) >>> 0;
  return (ip) => {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return false;
    return ((toInt(ip) & mask) >>> 0) === net;
  };
}

// Resolve each rule's `client` to addresses and each `devices` entry to entity ids.
//
// Run at allowlist-build time rather than at connect time: a DNS lookup on the hot path would
// put a network round trip in front of every websocket upgrade, and a failure there would be a
// failure to serve rather than a logged warning.
async function resolveConnRules(registries) {
  if (!CONN_RULES.length) return;
  const devices = registries?.devices || [];
  const entities = registries?.entities || [];
  const byId = new Map(devices.map((d) => [d.id, d]));
  // Name -> every device with that name, not just one.
  //
  // This was a Map of name -> id, so two devices sharing a name collapsed to whichever came last
  // in the registry and a rule naming it silently expanded the wrong one. Duplicate names are
  // ordinary — an integration re-adds a device, or two panels are set up the same way — and
  // nothing anywhere said which had been chosen.
  //
  // All of them are expanded now. That follows the asymmetry this codebase uses everywhere else:
  // a needless entity costs bytes, a missing one blanks part of a card with no error. The log
  // says when a name matched more than one, so an over-broad rule can be narrowed deliberately.
  const idsByName = new Map();
  for (const d of devices) {
    const n = String(d.name_by_user || d.name || '').trim().toLowerCase();
    if (!n) continue;
    if (!idsByName.has(n)) idsByName.set(n, []);
    idsByName.get(n).push(d.id);
  }
  const entsFor = buildRegistryCtx(registries ?? {}).byDevice;      // memoised — see buildRegistryCtx

  // Addresses first, for every rule AT ONCE. These were resolved one rule at a time, so a
  // hostname that did not answer — a panel that is powered off — held the rules after it for
  // the length of its DNS timeout, on every rebuild. They are independent lookups.
  await Promise.all(CONN_RULES.map(async (r) => {
    // A rule may match on something other than an address; there is nothing to resolve then.
    r.cidr = r.client ? parseCidr(r.client) : null;
    r.ips = new Set();
    if (!r.client || r.cidr) return;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(r.client) || r.client.includes(':')) {
      r.ips.add(normalizeIp(r.client));
      return;
    }
    // mDNS first for a `.local` name: the OS resolver inside the container has none, so
    // node:dns cannot answer those at all. Falls through to DNS for everything else.
    const viaMdns = discovery.resolve(r.client);
    if (viaMdns) {
      r.ips.add(normalizeIp(viaMdns));
      report(`  client rule ${r.client} -> ${viaMdns} (via mDNS)`);
      return;
    }
    // A hostname. Resolving it is best-effort by design: a panel that is powered off has no
    // lease, and that must not stop the other rules — or the whole allowlist — from building.
    try {
      const { lookup } = await import('node:dns/promises');
      const hits = await lookup(r.client, { all: true });
      hits.forEach((h) => r.ips.add(normalizeIp(h.address)));
      report(`  client rule ${r.client} -> ${[...r.ips].join(', ')}`);
    } catch (e) {
      logThrottled(`client-dns:${r.client}`,
        `  client rule ${r.client}: DNS lookup failed (${e.code || e.message}) — rule inactive until it resolves. `
        + 'mDNS/.local names usually do not resolve from a container; a real DNS record does.');
    }
  }));

  for (const r of CONN_RULES) {
    r.deviceEntities = [];
    for (const want of r.devices) {
      const ids = byId.has(want) ? [want] : (idsByName.get(want.trim().toLowerCase()) || []);
      if (!ids.length) {
        const msg = `  ${ruleLabel(r)}: no device named "${want}"`;
        if (onceOnly(`no-device:${want}`)) warn(msg); else debug(msg);
        continue;
      }
      if (ids.length > 1) {
        // Advice, not news: said once per name, then at debug. It was repeated on every rebuild,
        // and a rebuild runs on every registry event. Often it is not even a mistake — one
        // tablet can be a voice satellite AND a Kiosk Satellite device under the same name.
        const msg = `  ${ids.length} devices are named "${want}" — the rule expands all of them;`
          + ' name one by its device id to pick just that one';
        if (onceOnly(`dupe-device:${want}:${ids.length}`)) warn(msg); else debug(msg);
      }
      const rows = ids.flatMap((id) => entsFor.get(id) || []);
      const kept = deviceEntityIds(rows, EXCLUDE_DEVICE_CATEGORIES);
      r.deviceEntities.push(...kept);
      // Named by the rule's own wording rather than by a device id: `want` is what someone
      // wrote, and when it matched several devices there is no single id to name here.
      report(`  ${ruleLabel(r)}: device "${want}"`
        + (ids.length > 1 ? ` (${ids.length} devices)` : '')
        + ` -> ${kept.length} entities ${describeDeviceSplit(rows)}`);
    }
  }
}

// How a rule is named in the log. A rule used to be addressed as `client rule ${r.client}`, which
// reads `client rule null` for every rule matched on anything else — a user, a role, an mDNS kind.
function ruleLabel(r) {
  if (r.client) return `client rule ${r.client}`;
  const by = [['user', r.user], ['role', r.role], ['auth_provider', r.authProvider],
    ['mdns_kind', r.mdnsKind], ['entrypoint', r.entrypoint], ['dashboard', r.dashboard],
    ['user_agent', r.userAgent ? (r.userAgent.literal ?? String(r.userAgent.re)) : null]]
    .filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
  return `rule ${by.join(' ') || '(no matcher)'}`;
}

// Every client rule matching this connection's address, merged. Cheap: a handful of set lookups
// on a list a user hand-wrote, evaluated once per websocket upgrade.
function rulesForConnection(ctx) {
  if (!CONN_RULES.length) return null;
  // Rules that need an IDENTITY are held back for the auth gate; everything they also match on
  // is re-checked there, so nothing is lost by skipping them here.
  //
  // A role counts as identity just as much as a name does. Testing only for `user` let a
  // role-only rule through here, where no user is known yet — so `role: admin` was applied to
  // every connection, including non-admins, which is the exact opposite of what it says.
  const hits = CONN_RULES.filter((r) => !r.user && !r.role && !r.authProvider
    && matchesConnection(r, ctx));
  if (!hits.length) return null;
  return {
    always: hits.flatMap((r) => r.always),
    never: hits.flatMap((r) => r.never),
    entities: hits.flatMap((r) => r.deviceEntities),
    resAlways: hits.flatMap((r) => r.resAlways ?? []),
    resNever: hits.flatMap((r) => r.resNever ?? []),
  };
}

// The resource half of a rule hit, in the shape the bridge and the page rewrite both consume.
const resRulesOf = (hit) => ({ always: hit?.resAlways ?? [], never: hit?.resNever ?? [] });

// Widen/narrow one connection's allowlist by its client rules. Returns the SAME set when nothing
// changed, so the common case allocates nothing and the caller can tell whether a rule applied.
function applyClientRules(set, extra) {
  if (!extra) return set;
  const out = new Set(set);
  extra.entities.forEach((eid) => out.add(eid));
  extra.always.forEach((r) => {
    if (r.literal) out.add(r.literal);
    else REAL_IDS.forEach((eid) => { if (r.re.test(eid)) out.add(eid); });
  });
  // never wins last here too, matching every other override block.
  [...out].forEach((eid) => { if (matchesAny(extra.never, eid)) out.delete(eid); });
  return out.size === set.size && [...out].every((eid) => set.has(eid)) ? set : out;
}

// Could ANY per-user rule apply to this connection at all?
//
// Resolving the user costs a round trip to Home Assistant, and the connection is held for its
// duration — every message after `auth` waits. That is worth paying when a rule might change the
// allowlist, and pure loss when none can.
//
// A rule scoped to a dashboard cannot apply to a connection serving a different one. Measured on
// a live instance, every per-user rule was scoped to `lovelace`, so every wall-panel connection
// paid the lookup to reach a foregone conclusion.
//
// An unattributed connection (dash === null) still gates: we do not know which dashboard it is
// showing, so we cannot rule anything out. Same asymmetry as everywhere else — a needless gate
// costs milliseconds, a skipped one serves the wrong allowlist.
function userRulesCouldApply(dash) {
  // A role rule needs the user resolved just as much as a named-user rule does, so it has to open
  // the same gate. Missing this would leave role rules never applying, silently.
  const withUser = CONN_RULES.filter((r) => r.user || r.role || r.authProvider);
  if (!withUser.length) return false;
  if (dash === null || dash === undefined) return true;
  return withUser.some((r) => r.dashboard === null || r.dashboard === dash);
}

// The rules for a resolved user, matched on name (case-insensitive) or id.
// Every rule matching this user AND this dashboard, merged. Scoping to a dashboard is the
// point: "David sees update.* on lovelace" should not put 252 entities on a wall panel just
// because David happens to walk past it.
function rulesForUser(user, ctx) {
  if (!user || !CONN_RULES.length) return null;
  const names = [String(user.name ?? '').toLowerCase(), String(user.id ?? '').toLowerCase()];
  // Every OTHER matcher on the rule is checked here too, which is what lets a rule combine a user
  // with a dashboard, a device or a client app: the user is simply the last thing to resolve, so
  // this is the first moment the whole rule can be decided.
  const isAdmin = Boolean(user.is_admin);
  // Providers come from the cached shape when this is a cache hit and from Home Assistant's own
  // reply when it is not, so both paths have to be read.
  const providers = (user.providers
    ?? (user.credentials || []).map((c) => String(c?.type || '').toLowerCase()))
    .map((x) => String(x).toLowerCase());
  const hits = CONN_RULES.filter((r) => (r.user || r.role || r.authProvider)
    // A named user must match by name or id; a rule with only a role matches any user in it.
    && (!r.user || names.includes(r.user))
    && (!r.role || (r.role === 'admin' ? isAdmin : !isAdmin))
    && (!r.authProvider || providers.includes(r.authProvider))
    && matchesConnection(r, ctx));
  if (!hits.length) return null;
  return {
    always: hits.flatMap((r) => r.always),
    never: hits.flatMap((r) => r.never),
    entities: hits.flatMap((r) => r.deviceEntities),
    resAlways: hits.flatMap((r) => r.resAlways ?? []),
    resNever: hits.flatMap((r) => r.resNever ?? []),
  };
}

// Widen (or narrow) one connection's allowlist by its user's rules. Never mutates the shared
// set the dashboard build produced — that is reused by every other connection.
function applyUserRules(set, extra) {
  const out = new Set(set);
  // A user rule can now also name whole devices, because it is the same rule type as every other
  // — so it has to expand them the way the connect-time path does.
  (extra.entities || []).forEach((eid) => out.add(eid));
  extra.always.forEach((r) => {
    if (r.literal) out.add(r.literal);
    else REAL_IDS.forEach((eid) => { if (r.re.test(eid)) out.add(eid); });
  });
  [...out].forEach((eid) => { if (matchesAny(extra.never, eid)) out.delete(eid); });
  return out;
}

// ---- which dashboard is this client looking at? ----
// The websocket upgrade itself carries nothing that identifies the dashboard: the frontend
// opens ONE /api/websocket for the whole SPA and only asks for `lovelace/config` later —
// after `subscribe_entities`, which is the message we have to rewrite. So the dashboard has
// to be known BEFORE the socket opens.
//
// What does arrive first is the ordinary HTTP GET for the dashboard page itself
// (`GET /basement-stairs-panel/basement`), milliseconds earlier on the same connection's
// client IP. Remembering that gives the upgrade a reliable hint without touching the
// frontend or HA. When the hint is missing or stale we fall back to the union, so the worst
// case is exactly the old behaviour.
//
// Keyed by IP, which is right for wall panels (one device, one dashboard, static address)
// and deliberately coarse: two browsers behind one NAT share a hint, so the one that loaded
// second wins and the other may see entities its dashboard doesn't cover as unavailable
// until it reloads. Per-IP because a kiosk has no cookies we can rely on and no session we
// can see; a cookie would be finer-grained but needs a response rewrite on every page load.
//
// The page GET is the ONLY signal used. `lovelace/config` looks like a better one — it names
// the dashboard explicitly — but requesting a dashboard's config does not mean displaying
// it: Kiosk Satellite enumerates every dashboard's views at startup. See the note in
// bridge() for what happened when this code tried to act on it.
const CLIENT_DASH_TTL_MS = 10 * 60 * 1000;
// ip -> { ids:Set<entity_id>, at } learned from the client's OWN traffic.
//
// A browser-based voice satellite announces which satellite it is, on the very websocket this
// add-on is proxying:
//
//   { type: 'voice_satellite/subscribe_events', entity_id: 'assist_satellite.office_panel' }
//
// That is a better identity signal than anything we could infer. It needs no mDNS (a web page
// cannot advertise it), no DHCP reservation, and no configuration: the panel says who it is, and
// if its address ever changes the new address simply learns on its first connection.
//
// `client_overrides` remains for everything this cannot cover — a device that announces nothing.
const clientLearned = new Map();
const CLIENT_LEARNED_MAX = 500;
const CLIENT_LEARNED_TTL_MS = 86400000;
// entity_id -> every entity id on that entity's device, honouring exclude_device_categories.
// Rebuilt with the allowlist, so a renamed or re-added device is picked up without a restart.
let REG_CACHE_BY_ENTITY = null;
// entity_id -> integration domain, built alongside the allowlist. See buildAllow.
let PLATFORM_BY_ENTITY = new Map();
// Theme names referenced anywhere in the served dashboards' configs. Home Assistant sends EVERY
// installed theme on every page load — 10 themes, 28,138 bytes here — and a panel renders one.
let THEMES_USED = new Set();

// Entities a client has told us it needs, by naming itself. Strictly additive: it can only ever
// widen an allowlist, never narrow one.
// Entity ids a panel NAMED in a request that the allowlist did not forward, per dashboard:
// history, statistics and service calls carry ids to HA untouched, so this is the one place a card
// reading something the allowlist missed shows up. Bounded: 50 dashboards x 200 ids.
const ASKED_NOT_FORWARDED = new Map();   // dash -> Map(entity_id -> count)
const ENTITY_ID_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;
function noteAsked(dash, m, allow) {
  const raw = [m.entity_ids, m.entity_id, m.statistic_ids, m.target?.entity_id, m.service_data?.entity_id].flat(2);
  for (const id of raw) {
    if (typeof id !== 'string' || id.length > 255 || !ENTITY_ID_RE.test(id) || allow.has(id)) continue;
    const key = dash ?? '(union)';
    let per = ASKED_NOT_FORWARDED.get(key);
    if (!per) {
      if (ASKED_NOT_FORWARDED.size >= 50) return;
      per = new Map(); ASKED_NOT_FORWARDED.set(key, per);
    }
    if (per.has(id) || per.size < 200) per.set(id, (per.get(id) || 0) + 1);
  }
}
// The dashboard configs the last build read, kept for the diagnostics bundle.
const DASH_CONFIGS = new Map();
// Credentials a config or option can carry. Matched on the KEY, so a new card's `api_key:` is covered.
const SECRET_KEY_RE = /token|password|passwd|secret|api[_-]?key|authorization|webhook|(^|_)key$/i;
// Credentials also ride inside ordinary values: a URL's userinfo, a `?token=` in an image address.
function redactString(v) {
  return v.replace(/(\/\/)[^/\s@]*@/g, '$1[redacted]@')
    .replace(/([?&;](?:[^=&\s]*(?:token|password|passwd|secret|api[_-]?key|authorization|key|sig|signature))=)[^&\s"']*/gi, '$1[redacted]');
}
// Past the depth cap the subtree is replaced, never passed through: it could hold a credential.
function redactDeep(v, depth = 0) {
  if (typeof v === 'string') return redactString(v);
  if (v == null || typeof v !== 'object') return v;
  if (depth > 40) return '[truncated]';
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, depth + 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_KEY_RE.test(k) ? '[redacted]' : redactDeep(x, depth + 1)]));
}

function learnedFor(ip) {
  const hit = ip ? clientLearned.get(ip) : null;
  // Entries are refreshed by every announce (satellites repeat every 30s), so one that has gone a
  // day quiet is a retired device, and its address may belong to another by now.
  if (hit && Date.now() - hit.at > CLIENT_LEARNED_TTL_MS) { clientLearned.delete(ip); return null; }
  return hit ? hit.ids : null;
}

// Record "this client IS this satellite" and expand it to the device's entities. Returns the ids
// that were NEW for this client, so the caller can tell whether anything actually changed.
function learnClientEntity(ip, entityId) {
  if (!ip || !REG_CACHE_BY_ENTITY) return null;
  const rows = REG_CACHE_BY_ENTITY.get(entityId);
  if (!rows || !rows.length) return null;
  let hit = clientLearned.get(ip);
  if (!hit) {
    if (clientLearned.size >= CLIENT_LEARNED_MAX) boundByAge(clientLearned, 86400000, CLIENT_LEARNED_MAX);
    hit = { ids: new Set(), at: Date.now() };
    clientLearned.set(ip, hit);
  }
  hit.at = Date.now();
  const added = rows.filter((id) => !hit.ids.has(id));
  added.forEach((id) => hit.ids.add(id));
  return added.length ? added : null;
}

const clientDash = new Map();                 // ip -> { path, at }

// Kept across restarts, in /data, for the same reason the user cache is.
//
// This map is what per-dashboard attribution rests on: a panel's dashboard page request records
// "this address is looking at office-tablet", and the websocket that follows is served that
// dashboard's entities rather than the union of every one. It lived only in memory, so EVERY
// RESTART THREW IT AWAY — and a panel whose websocket reconnects without re-fetching its page
// then has no hint at all. Measured on a live instance after a rebuild: a panel served 488
// entities where it should have had 108, and it stayed that way until something made it reload.
//
// That is the add-on quietly not doing its job, triggered by the most ordinary event there is.
//
// THE TTL IS UNCHANGED, exactly as with the user cache. A restart takes about twelve seconds, so
// the existing ten minutes already spans one; persisting buys the restart case with no increase
// in staleness. An entry older than the TTL is dropped on load.
//
// What is written: address -> { dashboard url_path, when }. No identity, no token, nothing about
// what the panel was served — but it is still a list of addresses on the network, and /data is
// included in Home Assistant backups.
const CLIENT_DASH_FILE = CONFIG_DIR ? `${CONFIG_DIR}/client-dash.json` : null;
let clientDashDirty = false;
let clientDashTimer = null;

function loadClientDash() {
  if (!CLIENT_DASH_FILE || !fs.existsSync(CLIENT_DASH_FILE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(CLIENT_DASH_FILE, 'utf8'));
    const now = Date.now();
    let kept = 0, expired = 0, stale = 0;
    for (const [ip, v] of Object.entries(raw?.hints || {})) {
      if (typeof v?.path !== 'string' || typeof v?.at !== 'number') continue;
      if (now - v.at >= CLIENT_DASH_TTL_MS) { expired++; continue; }
      // A dashboard that is no longer configured must not be resurrected from disk: it would
      // attribute a panel to something this app does not serve, and allowFor would fall back to
      // the union anyway — with a misleading label on the panel in the meantime.
      if (!DASH_PATHS.includes(v.path)) { stale++; continue; }
      clientDash.set(ip, { path: v.path, at: v.at });
      kept++;
    }
    if (kept || expired || stale) {
      log(`client hints: ${kept} still valid, ${expired} expired`
        + (stale ? `, ${stale} for dashboards no longer served` : ''));
    }
  } catch (e) {
    // Losing these costs one reload's worth of attribution, never the boot.
    warn(`could not read ${CLIENT_DASH_FILE} (${e.message}) — starting with no client hints`);
  }
}

// Write the hints now, whatever the debounce was waiting for. Returns whether anything was
// written, which is only of interest to the tests.
function flushClientDash() {
  if (!CLIENT_DASH_FILE || !clientDashDirty) return false;
  clientDashDirty = false;
  try {
    const hints = {};
    for (const [ip, v] of clientDash) hints[ip] = v;
    const tmp = `${CLIENT_DASH_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, hints }));
    fs.renameSync(tmp, CLIENT_DASH_FILE);
    return true;
  } catch (e) {
    logThrottled('clientdash-write', `could not write the client hints (${e.message})`);
    return false;
  }
}

// Debounced: a page request writes a hint, and a wall panel reloading its dashboard would
// otherwise rewrite this file several times a second for no benefit. The five seconds that the
// debounce is holding are flushed on the way out (see the shutdown handler), because the restart
// that would lose them is the exact event these hints exist to survive.
function saveClientDashSoon() {
  if (!CLIENT_DASH_FILE) return;
  clientDashDirty = true;
  if (clientDashTimer) return;
  clientDashTimer = setTimeout(() => {
    clientDashTimer = null;
    flushClientDash();
  }, 5000);
  if (typeof clientDashTimer.unref === 'function') clientDashTimer.unref();
}

// One implementation of "who is this", shared with the route classifier, so the IP a client
// is attributed by and the IP the panel reports about it can never disagree.
const clientIp = (req) => classify(req).ip;

// A dashboard URL is `/<url_path>` or `/<url_path>/<view>`. Match only configured
// dashboards, so ordinary frontend traffic (/api/…, /static/…, /hacsfiles/…) is ignored.
function dashFromUrl(url) {
  const first = String(url || '').split('?')[0].split('/').filter(Boolean)[0];
  if (!first) return null;
  return DASH_PATHS.includes(first) ? first : null;
}

function noteClientDash(req) {
  if (!PER_DASH) return;
  const path = dashFromUrl(req.url);
  if (!path) return;
  const ip = clientIp(req);
  if (!ip) return;
  const prev = clientDash.get(ip);
  clientDash.set(ip, { path, at: Date.now() });
  saveClientDashSoon();
  if (prev?.path !== path) log(`client ${ip} -> dashboard ${path}`);
  // Bounded: a busy instance must not accumulate an entry per client forever.
  if (clientDash.size > 500) boundByAge(clientDash, CLIENT_DASH_TTL_MS, 500);
}

// Keep a per-address map under `max` entries. Expired entries go first; if that is not enough —
// more live clients than the cap — the oldest go next, so the map is genuinely bounded rather
// than bounded only while fewer than `max` clients are active. Both maps this serves record
// `at` on every touch, so "oldest" is "least recently seen".
function boundByAge(map, ttlMs, max) {
  const cutoff = Date.now() - ttlMs;
  for (const [k, v] of map) if (v.at < cutoff) map.delete(k);
  if (map.size <= max) return;
  const byAge = [...map].sort((a, b) => a[1].at - b[1].at);
  for (const [k] of byAge.slice(0, map.size - max)) map.delete(k);
}

// The allowlist this connection should get: its own dashboard's if we know it and it is
// non-empty, else the union. Never returns an empty set when the union has entries — an
// empty entity_ids means "no filter" to HA, i.e. the whole firehose.
const DASH_COOKIE = 'ws_dash';

// One definition, because there are TWO places that answer a dashboard page: the proxy's
// `proxyRes` hook, and serveDashboardPage() when trim_extra_modules rewrites the page itself.
// They must set the same cookie with the same lifetime or a browser's attribution depends on
// which path happened to serve it.
const dashCookieHeader = (dash) =>
  `${DASH_COOKIE}=${encodeURIComponent(dash)}; Path=/; Max-Age=31536000; SameSite=Lax`;

// Append to whatever cookies the response already carries, rather than replacing them.
function addDashCookie(res, dash) {
  const prior = res.getHeader('set-cookie');
  const cookies = Array.isArray(prior) ? [...prior] : (prior ? [prior] : []);
  cookies.push(dashCookieHeader(dash));
  res.setHeader('set-cookie', cookies);
}

/// The dashboard this browser was last served, from its own cookie. Per-browser, so it
/// survives NAT — unlike the IP hint, which every device behind one address shares.
function dashFromCookie(req) {
  const raw = req.headers?.cookie;
  if (!raw) return null;
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== DASH_COOKIE) continue;
    let v; try { v = decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    return DASH_PATHS.includes(v) ? v : null;   // only ever a dashboard we actually serve
  }
  return null;
}

// Cookie first, then the IP hint, then the union. Never returns an empty set when the union
// has entries — an empty entity_ids means "no filter" to HA, i.e. the whole firehose.
function allowFor(req) {
  if (!PER_DASH) return { set: ALLOW, dash: null, via: null };
  for (const [path, via] of [
    [dashFromCookie(req), 'cookie'],
    [ipHint(req), 'ip'],
    [dashFromUA(req), 'user-agent'],
  ]) {
    if (!path) continue;
    const set = ALLOW_BY_DASH.get(path);
    if (set?.size) return { set, dash: path, via };
  }
  return { set: ALLOW, dash: null, via: null };
}

// Last-resort attribution from the User-Agent. Only ever returns a dashboard the add-on is
// configured to serve, so a spoofed UA can at worst select another of your own dashboards.
function dashFromUA(req) {
  const ua = req.headers?.['user-agent'];
  if (!ua || !UA_DASHBOARDS.length) return null;
  for (const r of UA_DASHBOARDS) {
    const hit = r.re ? r.re.test(ua) : ua.includes(r.literal);
    if (hit && DASH_PATHS.includes(r.dashboard)) return r.dashboard;
  }
  return null;
}

function ipHint(req) {
  const hit = clientDash.get(clientIp(req));
  if (!hit || Date.now() - hit.at > CLIENT_DASH_TTL_MS) return null;
  return hit.path;
}

// Serve one dashboard page ourselves so its injected-module list can be rewritten.
//
// This is the ONLY request the add-on does not stream straight through, and it is handled apart
// from the proxy rather than inside it because the body has to be read whole before it can be
// edited. `Accept-Encoding` is dropped on the way up so Home Assistant answers in plain text:
// the page is about 10KB, so re-compressing it would save a few KB of LAN traffic in exchange for
// a Brotli round trip on every load and a second way to corrupt the one response that must not be
// corrupted.
//
// FAILS OPEN, everywhere. A bad page here is not a blank card, it is a panel that never boots, so
// every error path — fetch failure, non-HTML answer, a page the pattern does not match, anything
// thrown — hands the request back to the ordinary proxy with nothing written to the socket yet.
async function serveDashboardPage(req, res, dash) {
  // The host comes from HA_BASE and ONLY from there; the request supplies a path and a query.
  // This used to be `new URL(req.url, HA_BASE)`, and req.url is the raw request target, so
  // `GET //basement-panel/x` passed dashFromUrl (its first segment names a dashboard) and then
  // resolved as a protocol-relative URL: the proxy fetched http://basement-panel/x, not Home
  // Assistant. Found by CodeQL (js/request-forgery) on 2026-10-02.
  if (!String(req.url).startsWith('/')) return false;
  const upstream = new URL(HA_BASE);
  const q = req.url.indexOf('?');
  upstream.pathname = q < 0 ? req.url : req.url.slice(0, q);
  upstream.search = q < 0 ? '' : req.url.slice(q);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (key === 'host' || key === 'connection' || key === 'accept-encoding') continue;
    // Replaced below, never relayed. This is the third way a request reaches Home Assistant —
    // after httpxy and the bridge socket — and it was the one that skipped the forwarded-header
    // rule: a client-supplied X-Forwarded-For went up exactly as sent, without our peer on the
    // right. The page is public, so nothing was exposed, but "our peer is always rightmost" is
    // only an invariant if there is no path around it.
    if (key.startsWith('x-forwarded-')) continue;
    headers[k] = v;
  }
  Object.assign(headers, forwardHeadersFor(req));
  const r = await fetch(upstream, { headers, redirect: 'manual',
    signal: AbortSignal.timeout(20000) });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !/text\/html/i.test(type)) return false;   // not ours to touch
  const body = await r.text();
  const rt = classify(req);
  const rr = resRulesOf(rulesForConnection({ ip: rt.ip, ua: req.headers['user-agent'] || null, dash, host: rt.host }));
  const { html, dropped } = stripExtraModules(body, dash, rr);
  // Served from here even when nothing was removed. It used to hand the request back to the proxy
  // in that case, which asked Home Assistant for the same page a second time — on every load of
  // every dashboard that had nothing to strip, i.e. the common one. The body in hand is the page
  // HA just sent; `html === body` when nothing matched, so this is the untouched document.
  const out = Buffer.from(html, 'utf8');
  for (const [k, v] of r.headers) {
    const key = k.toLowerCase();
    if (key === 'content-length' || key === 'content-encoding' || key === 'transfer-encoding') continue;
    // Iterating yields one entry PER cookie, and setHeader replaces — so only the last survived.
    if (key === 'set-cookie') continue;
    res.setHeader(k, v);
  }
  const upstreamCookies = r.headers.getSetCookie?.() ?? [];
  if (upstreamCookies.length) res.setHeader('set-cookie', upstreamCookies);
  res.setHeader('content-length', String(out.length));
  // Attribute this browser to this dashboard — the same cookie the proxyRes hook sets.
  //
  // It has to be repeated here because this function writes the response ITSELF, so that hook
  // never runs for a page it handles. The effect was a browser pinned to whichever dashboard it
  // happened to be served BEFORE trim_extra_modules started rewriting pages: the cookie is first
  // in allowFor()'s precedence and lives for a year, so it never got corrected, and every later
  // load of a different dashboard was served the wrong one's entities and resources.
  //
  // Wall panels never showed it — each loads one dashboard, and a browser with no cookie at all
  // falls through to the IP hint, which is updated on every request. It only bites a browser
  // that moves between dashboards, which is why it looked like a phantom.
  addDashCookie(res, dash);
  res.writeHead(r.status);
  res.end(out);
  if (dropped.length) {
    logThrottled(`extramod:${dash}`, `  extra modules trimmed for ${dash}: removed ${dropped.length} `
      + `(${dropped.join(', ')})`);
  }
  return true;
}

// ---- what a panel may know about itself ----
//
// Panels (ha-paneld, Kiosk Satellite) want an admin screen saying "the trimmer is in front of me,
// here is what it is cutting, here is what that is doing for me". Three constraints shaped this:
//
//   * NO COST ON A NORMAL PAGE LOAD. This is an admin screen, read occasionally, so it is a pull:
//     nothing is added to the dashboard responses that every panel fetches on every boot.
//   * REACHING IT IS THE PROOF. A panel cannot tell from a page alone whether the trimmer served
//     it or whether it is talking straight to Home Assistant. It does not need a header to find
//     out — this path exists only on the proxy, so a 200 here means the proxy is in the path and
//     a 404 means it is not. That is the whole "is it running" question, answered by arriving.
//   * A PANEL SEES ITSELF, NOT THE ESTATE. The reply describes the caller and nothing else. There
//     is deliberately no way to ask about another address: this port is reachable by anything on
//     the network, so every field here has to be something that network may read. That rules out
//     the override rules, the allowlist contents, entity ids, Home Assistant user identities and
//     any other client's address — none of which a panel needs to render its own status.
function clientReport(ip) {
  const snap = stats.snapshot(statsExtras());
  const mine = (snap.clients?.list || []).filter((c) => c.ip === ip);

  // Summed across this address's live connections: a panel may hold more than one (a reload
  // overlaps briefly), and reporting only the newest would make its numbers jump backwards.
  const sum = (f) => mine.reduce((n, c) => n + (Number(c[f]) || 0), 0);
  const fromHA = sum('fromHA');
  const toBrowser = sum('toBrowser');
  // The newest connection answers the "what am I being served" questions, because that is the one
  // the panel is actually looking at right now.
  const newest = mine.slice().sort((a, b) => (a.connectedSec ?? 0) - (b.connectedSec ?? 0))[0] || null;

  return {
    strimmer: {
      running: true,
      version: VERSION,
      uptime_sec: snap.uptimeSec,
    },
    // The same object under its pre-rename name, for panels that read `stripper.running`. Same
    // reasoning as CLIENT_INFO_PATH_LEGACY: cheap here, and a broken status screen there.
    stripper: {
      running: true,
      version: VERSION,
      uptime_sec: snap.uptimeSec,
    },
    // Booleans only, and only the ones that describe what is being cut. No lists, no rules, no
    // names — see the note above on what this port may say.
    trimming: {
      entities: STRIP,
      by_dashboard: PER_DASH,
      registries: TRIM_REGISTRIES,
      resources: TRIM_RESOURCES,
      extra_modules: TRIM_EXTRA_MODULES,
      services: TRIM_SERVICES,
      repairs: TRIM_REPAIRS,
      themes: TRIM_THEMES,
      translations: TRIM_TRANSLATIONS,
      compress_websocket: COMPRESS_WS,
    },
    client: {
      ip: ip ?? null,
      // Zero is a real answer and worth rendering: the panel has reached the proxy over HTTP but
      // has no open websocket, which is a different state from "not behind the trimmer at all".
      connections: mine.length,
      dashboard: newest?.dashboard ?? null,
      attributed_via: newest?.attributedVia ?? null,
      entities_served: newest?.allowSize ?? null,
      first_payload: newest ? {
        entities: newest.initialEntityCount ?? null,
        bytes: newest.initialPayloadBytes ?? null,
        ms_to_data: newest.msToEntityData ?? null,
        drain_ms: newest.initialDrainMs ?? null,
      } : null,
      traffic: mine.length ? {
        from_ha_bytes: fromHA,
        to_browser_bytes: toBrowser,
        // What this connection was spared. Stated as a difference between two measured totals
        // rather than as a global "savings" figure, which means something narrower elsewhere in
        // this codebase and must not be conflated with it.
        not_sent_bytes: Math.max(0, fromHA - toBrowser),
        not_sent_pct: fromHA > 0 ? Math.round(((fromHA - toBrowser) / fromHA) * 100) : null,
        // Throughput, never a saving: the untrimmed volume of the event stream does not exist to
        // be measured, because Home Assistant filters it server-side.
        update_bytes_per_min: newest?.eventBytesPerMin ?? null,
      } : null,
      connected_sec: newest?.connectedSec ?? null,
    },
  };
}

const server = http.createServer((req, res) => {
  captureForwarded(req);
  // Request logging goes to its own ring, not to stdout — see http_log.mjs on why a request log
  // and a service log do not belong in the same stream.
  httpLog.observe(req, res, clientIp);
  noteClientDash(req);
  // Answered here rather than forwarded: this path exists only on the proxy, which is what makes
  // reaching it meaningful. CORS is open because a panel's admin page may be served from its own
  // origin rather than Home Assistant's, and the reply is already limited to what this network
  // may read.
  // The preflight. An Authorization header makes this a non-simple cross-origin request, so a
  // panel admin page served from its own origin asks permission first — and never sends the real
  // request if nobody answers. Adding the header without this would have quietly broken exactly
  // the callers the endpoint exists for.
  if (req.method === 'OPTIONS' && isClientInfoPath(req.url)) {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    });
    return res.end();
  }
  if (req.method === 'GET' && isClientInfoPath(req.url)) {
    // Authenticated with the caller's OWN Home Assistant token, validated against Home Assistant.
    //
    // This started unauthenticated on the reasoning that it says little: booleans and the
    // caller's own figures. That reasoning does not survive the company it keeps — the same
    // network can reach it, and "little" is still the dashboard a panel is on, how many entities
    // it is served and how much it moves. There is no good reason for a device that cannot log
    // into Home Assistant to learn any of it.
    //
    // A token rather than a shared secret, because a panel already has one and a second secret to
    // distribute and rotate is a worse answer than the one the platform already provides. The
    // result is cached exactly like the per-user lookup — same map, same ten-minute TTL — so an
    // admin screen polling this does not open a websocket to Home Assistant every time.
    // Where it came from, BEFORE who it is. A caller this add-on will not answer should not be
    // able to make it open a websocket to Home Assistant to check a token.
    const refusal = clientApiRefusal(req, classify(req));
    if (refusal) {
      // Same reasoning as requireIngress: a panel polls this, so the line is said once per
      // caller and then only at debug.
      const blocked = `refused ${CLIENT_INFO_PATH} from ${clientIp(req) ?? '?'} — ${refusal}`;
      if (onceOnly(`client-api-blocked:${clientIp(req) ?? '?'}`)) log(blocked); else debug(blocked);
      // 403, deliberately not 404. A panel uses 404 to mean "the trimmer is not in front of me",
      // and answering a blocked-but-local panel with 404 would tell it the opposite of the truth.
      res.writeHead(403, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      return res.end(JSON.stringify({ error: refusal }));
    }
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (!token) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'www-authenticate': 'Bearer',
        'access-control-allow-origin': '*',
      });
      return res.end(JSON.stringify({
        error: 'send your Home Assistant access token as Authorization: Bearer <token>',
      }));
    }
    resolveUser(token, forwardHeadersFor(req)).then((user) => {
      if (!user) {
        // Same answer for an absent token and a rejected one: this must not become an oracle for
        // testing whether a token is valid any faster than asking Home Assistant directly.
        res.writeHead(401, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        });
        return res.end(JSON.stringify({ error: 'Home Assistant did not accept that token' }));
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(JSON.stringify(clientReport(clientIp(req)), null, 2));
    }).catch(() => {
      res.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'could not check that token with Home Assistant' }));
    });
    return;
  }
  const dash = TRIM_EXTRA_MODULES && req.method === 'GET' ? dashFromUrl(req.url) : null;
  if (dash && /text\/html/i.test(String(req.headers.accept || ''))) {
    serveDashboardPage(req, res, dash)
      .then((handled) => { if (!handled) proxy.web(req, res).catch(() => {}); })
      .catch((e) => {
        logThrottled('extramod-fail', `  extra-module trim failed (${e.message}) — serving the page untouched`);
        if (!res.headersSent) proxy.web(req, res).catch(() => {});
      });
    return;
  }
  // httpxy returns a promise. The 'error' listener below already handles failures and resolves
  // them, but an unhandled rejection would still be a process-level crash, so swallow here too.
  proxy.web(req, res).catch(() => {});
});

// ---- websocket upgrades ----
// We intercept ONLY /api/websocket (the entity firehose) to trim it. EVERY other ws
// upgrade passes straight through to HA — notably /api/webrtc/ws (go2rtc / WebRTC & MSE
// camera-stream signaling) and Assist-pipeline sockets. Destroying them (the old default
// branch) broke camera streams with ws close code 1006.
// threshold: don't spend CPU deflating the small control chatter; the payloads that matter
// here (registries, get_states, get_services) are hundreds of KB and compress ~10x.
// concurrencyLimit caps simultaneous zlib jobs so a burst of kiosks reconnecting at once
// can't saturate the host. Context takeover is left at the default (on) because this add-on
// serves a handful of long-lived kiosk connections, where the better ratio is worth the
// per-connection zlib memory.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: COMPRESS_WS ? { threshold: 1024, concurrencyLimit: 10 } : false,
  maxPayload: BROWSER_MAX_PAYLOAD,
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
    const { set: dashSet, dash, via } = allowFor(req);
    // Classified once here rather than per-field: the request object is gone by the time the
    // bridge reports anything, so the path has to be captured at the only moment it exists.
    const rt = classify(req);
    // Client-pinned rules apply on top of whichever dashboard set was chosen, and regardless of
    // whether the dashboard could be attributed at all — the point of pinning to a device is
    // that it holds even when the page changes.
    const ruleCtx = { ip: rt.ip, ua: req.headers?.['user-agent'] || null, dash, host: rt.host };
    const connRules = rulesForConnection(ruleCtx);
    let set = applyClientRules(dashSet, connRules);
    const pinned = set !== dashSet;
    const afterRules = set.size;
    // Entities this client previously told us it needs, by naming itself (see learnClientEntity).
    // Applied after the configured rules and never instead of them: `client_overrides` stays the
    // escape hatch for devices that announce nothing.
    const learned = learnedFor(rt.ip);
    let selfIdentified = 0;
    if (learned?.size) {
      const before = set.size;
      const widened = new Set(set);
      learned.forEach((id) => widened.add(id));
      if (widened.size !== before) { set = widened; selfIdentified = widened.size - before; }
    }
    if (dash || pinned || selfIdentified) {
      debug(`/api/websocket for ${rt.ip} (${rt.origin}, via ${rt.route}${rt.host ? ` @ ${rt.host}` : ''}): `
        + `serving ${dash ?? 'union'}${dash ? ` via ${via}` : ''}`
        + `${pinned ? ` +client rules (${dashSet.size} -> ${afterRules})` : ''}`
        + `${selfIdentified ? ` +${selfIdentified} self-identified` : ''} `
        + `(${set.size} entities, union is ${ALLOW.size})`);
    }
    const device = discovery.lookup(rt.ip);
    wss.handleUpgrade(req, socket, head, (browserWs) => bridge(browserWs, set, dash, {
      ip: rt.ip, via, ua: req.headers['user-agent'], clientPinned: pinned, fwd: forwardHeadersFor(req),
      resRules: resRulesOf(connRules),
      device: device ? { kind: device[0].kind, name: device[0].name, version: device[0].version } : null,
      origin: rt.origin, route: rt.route, host: rt.host, hop: rt.hop, hops: rt.hops,
    }));
  } else {
    // Keyed on the path, not req.url: camera stream URLs carry a per-request signature, so
    // keying on the whole thing would defeat the throttle (and grow the map) during a retry storm.
    // Name the client. Without this a passthrough that repeats forever — an add-on ingress
    // panel reconnecting on a timer, say — is unattributable: you can see it happening and
    // have no way to tell which device is doing it.
    const pt = classify(req);
    logThrottled(`passthrough:${req.url.split('?')[0]}`,
      `ws upgrade passthrough -> HA: ${req.url} (from ${pt.ip ?? '?'}${pt.origin ? `, ${pt.origin}` : ''}`
      + `${pt.route ? ` via ${pt.route}` : ''})`, LEVELS.debug);
    // NOTE the argument order: httpxy is `ws(req, socket, options, head)` where node-http-proxy
    // was `ws(req, socket, head)`. Passing `head` third would spread a Buffer into the request
    // options and break the upgrade — silently, since the socket simply never completes.
    proxy.ws(req, socket, { upgradeTimeout: 30000 }, head).catch(() => {});
  }
});

// The headers the HA-side bridge socket carries, so Home Assistant sees the BROWSER rather
// than this proxy.
//
// The intercepted websocket is the one connection this add-on opens itself instead of through
// httpxy, so nothing set X-Forwarded-* on it: every trimmed panel reached Home Assistant as
// 127.0.0.1 (or the container's address). Two things that cost. HA's failed-login handling keys
// on the client address, so with `ip_ban_enabled` one panel holding a stale token could get the
// proxy's OWN address banned — and with it every panel at once. And HA's log named the proxy for
// every connection, so "which device keeps failing auth" had no answer on the HA side.
//
// Same rule as the HTTP path: each header is set only when absent, and For is normalised in
// place, so the For and Proto chains agree in length — the invariant HA's forwarded middleware
// enforces (see the X-Forwarded-For notes in CLAUDE.md). The User-Agent comes along because HA
// logs it beside the address.
function forwardHeadersFor(req) {
  const h = req.headers || {};
  const out = {};
  // Same contract as the HTTP path: a supplied chain gets our peer appended on the right,
  // an absent one becomes our peer. This socket is opened without httpxy, so it is done here.
  const scheme = req.socket?.encrypted ? 'https' : 'http';
  const chain = forwardedChain(req, h['x-forwarded-for'], h['x-forwarded-proto'], scheme);
  const xff = chain.for || normalizeIp(req.socket?.remoteAddress);
  if (xff) out['x-forwarded-for'] = xff;
  out['x-forwarded-proto'] = chain.proto || String(h['x-forwarded-proto'] || scheme);
  const host = h['x-forwarded-host'] || h.host;
  if (host) out['x-forwarded-host'] = String(host);
  if (h['user-agent']) out['user-agent'] = String(h['user-agent']);
  return out;
}

// `allow` is THIS connection's allowlist — one dashboard's, or the union when the client
// couldn't be attributed. Captured per bridge rather than read from the global, so two
// kiosks on different dashboards get genuinely different subscriptions.
function bridge(browserWs, baseAllow = ALLOW, dash = null, meta = {}) {
  // When this connection was accepted, i.e. the moment the client started waiting. Everything
  // the timing report says is relative to this.
  const tOpen = Date.now();
  // Does THIS connection get trimmed? Starts as the global setting and is turned off for the
  // life of the connection when the user behind the token has an active pause (see pause.mjs).
  // Per connection rather than global because a pause is one person troubleshooting, and the
  // wall panels have no part in it — they keep their trim and are never disturbed.
  //
  // Every trim below reads this instead of STRIP, so "paused" means the entity stream, the
  // registries, services, translations, themes and repairs all pass through whole. A partial
  // pause would be the worst of both: still missing what you came to look for, and slow.
  let trimming = STRIP;
  // What openBridges holds for this connection: which set it is on, who is behind it, and where
  // it came from. A live object rather than a snapshot, because the user is not known until the
  // token resolves and a pause arriving later has to be able to find it.
  const bridgeInfo = { dash, ip: meta.ip ?? null, user: null, isAdmin: false };
  let timedInitial = false;
  const haWs = new WebSocket(HA_WS, { perMessageDeflate: true, maxPayload: 0, headers: meta.fwd || {}, handshakeTimeout: 15000 });
  const connId = stats.connOpen({
    ip: meta.ip, dash, via: meta.via, allowSize: baseAllow.size, ua: meta.ua,
    origin: meta.origin, route: meta.route, host: meta.host, hop: meta.hop, hops: meta.hops,
  });
  let userChecked = false;
  let learnedKick = false;   // only ever drop a connection once for a newly-learned identity
  // Resource rules for THIS connection: the client-matched ones from the upgrade, joined by the
  // user-matched ones once identity resolves. Consulted when its lovelace/resources reply is
  // trimmed, which the frontend asks for after auth — so both halves are known by then.
  const resRules = { always: [...(meta.resRules?.always ?? [])], never: [...(meta.resRules?.never ?? [])] };
  // This connection's cache identity: a signature of the allowlist it actually ended up with.
  //
  // Computed lazily and memoised, because `allow` is still moving when the connection opens —
  // `user_overrides` can widen it once the user resolves, and the gate below holds every
  // message until that has happened. Taking the signature at the first cacheable REQUEST means
  // it is always taken after the set has settled. It is invalidated on the one in-connection
  // event that can change the set (see allowSigReset).
  let allowSig = null;
  const cacheSig = () => (allowSig ??= allowSignature(allow));
  const allowSigReset = () => { allowSig = null; };
  const getStatesIds = new Set();
  const subEntityIds = new Set();   // subscribe_entities subs we injected the allowlist into
  const registryIds = new Map();    // request id -> { kind, ver }: which registry, and the allowlist version it was asked under
  const resourceIds = new Set();    // lovelace/resources requests, to trim their result
  const serviceIds = new Map();     // get_services request id -> allowlist version it was asked under
  const repairIds = new Set();      // repairs/list_issues requests, to empty their result
  const translationIds = new Set(); // frontend/get_translations, for the size analysis below
  const shapeIds = new Map();       // id -> type, for the one-shot shape capture below
  const themeIds = new Set();       // frontend/get_themes requests, to cut to the themes in use
  // `subscribe_events` subscriptions that will deliver state_changed. These bypass the
  // allowlist entirely: the egress filter below only ever covered subscribe_entities, so a
  // card using the older subscribe_events path received the WHOLE firehose — the exact thing
  // this add-on exists to prevent. Measured at ~700MB/h to a single wall panel.
  const stateChangedSubs = new Set();
  // subscribe_events subscriptions for entity_registry_updated. Separate from the set above
  // because an ALL-events subscription already lands there and is already filtered; a
  // subscription aimed specifically at the registry was not filtered by anything.
  const registrySubs = new Set();
  // id -> the command the browser sent, so a `result` can be attributed to what asked for it.
  // Bounded: a client that never gets answers must not grow this without limit.
  const pendingTypes = new Map();
  const queue = []; let haOpen = false;
  // Set when HA says auth_ok. A cache hit never reaches HA, so without this an unauthenticated
  // socket could read another client's cached registry rows by simply skipping `auth`.
  let haAuthed = false;
  // Binary frames go out uncompressed, in both directions. The HA-side socket negotiates
  // permessage-deflate for the JSON traffic, but a binary frame here is a voice satellite's PCM
  // audio chunk on the way up or a camera/media frame on the way down — already-compressed or
  // incompressible bytes that deflate can only make later and warmer. Measured in the voice
  // path, where every 20-100ms audio chunk crossing this hop is one more thing between the
  // wake word and the reply.
  const BIN = { binary: true, compress: false };
  // Bytes the browser has sent that are waiting on HA's handshake or the user lookup. Unbounded, a
  // client could flood frames (each under the per-frame cap) while HA stalls and exhaust memory.
  let heldBytes = 0;
  const drained = () => { if (haOpen && !gateQueue) heldBytes = 0; };
  const dropClient = (why) => {
    logThrottled(`held:${meta.ip}`, `${meta.ip ?? '?'} ${why} — closing; it will reconnect fresh`);
    try { browserWs.terminate(); } catch {}
    close();
  };
  const overflow = (n) => {
    heldBytes += n;
    if (heldBytes <= BP_HIGH_BYTES) return false;
    dropClient(`sent ${(heldBytes / 1024).toFixed(0)}KB while HA was not ready for it`);
    return true;
  };
  const toHA = (s) => {
    if (!haOpen) return queue.push(s);
    if (Buffer.isBuffer(s)) haWs.send(s, BIN); else haWs.send(s);
    // HA is not reading: the write backlog is the same unbounded growth, in the other direction.
    if (haWs.bufferedAmount > BP_HIGH_BYTES) dropClient(`has ${(haWs.bufferedAmount / 1024).toFixed(0)}KB waiting for HA to read`);
  };

  // ---- backpressure (see BP_HIGH_BYTES) ----
  // `bufferedAmount` is what `ws` has accepted for this browser and not yet handed to the
  // kernel — the exact quantity that grows without bound when a client stops reading. Checked
  // after every send rather than on a timer, so a single oversized frame trips it immediately.
  let bpPaused = false;
  let bpTimer = null;
  const bpResume = (why) => {
    if (!bpPaused) return;
    bpPaused = false;
    clearInterval(bpTimer); bpTimer = null;
    try { haWs.resume(); } catch {}
    debug(`${meta.ip ?? '?'} ${why} — resuming its HA stream`);
  };
  const bpCheck = () => {
    if (bpPaused) return;
    const queued = browserWs.bufferedAmount;
    if (queued <= BP_HIGH_BYTES) return;
    bpPaused = true;
    stats.recordBackpressure('pause');
    logThrottled(`bp:${meta.ip}`, `${meta.ip ?? '?'} is not keeping up (${(queued / 1024).toFixed(0)}KB queued`
      + `${dash ? `, ${dash}` : ''}) — pausing its HA stream until it drains`);
    try { haWs.pause(); } catch {}
    // Progress is "the queue got smaller", not "it is below the mark": a client draining a
    // large backlog slowly is alive and must not be cut off for being slow.
    let lowest = queued;
    let lastProgress = Date.now();
    bpTimer = setInterval(() => {
      const now = browserWs.bufferedAmount;
      if (now < lowest) { lowest = now; lastProgress = Date.now(); }
      if (now <= BP_LOW_BYTES) return bpResume(`drained to ${(now / 1024).toFixed(0)}KB`);
      if (Date.now() - lastProgress > BP_STALL_MS) {
        stats.recordBackpressure('stall');
        log(`${meta.ip ?? '?'} read nothing for ${BP_STALL_MS / 1000}s with ${(now / 1024).toFixed(0)}KB queued — closing; it will reconnect fresh`);
        // terminate(), not close(): a close frame would queue BEHIND the backlog the client is
        // not reading, and ws then holds the socket — and the backlog — for another 30s before
        // giving up. The client was not reading; there is nobody to be graceful to.
        try { browserWs.terminate(); } catch {}
        close();
      }
    }, 100);
    bpTimer.unref?.();
  };

  // This connection's allowlist. Starts as the dashboard's shared set and may be replaced once
  // the user behind the token is known. Never mutated in place — other connections share it.
  let allow = baseAllow;
  // While a user lookup is in flight, browser->HA messages are held and flushed in order.
  // Order matters: Home Assistant requires strictly increasing message ids per connection, so
  // letting a later message overtake an earlier one while we wait would break the socket.
  // The gate opens after the auth message, which is the first thing the frontend sends, so in
  // practice it holds a handful of messages for one local round trip.
  //
  // Held messages are THUNKS, not finished strings. A message serialized at queue time
  // carries the allowlist as it was when the gate CLOSED — but the gate exists precisely
  // because user rules are about to change that allowlist. Stamping early therefore sent the
  // pre-rules entity list and silently discarded the rule that was being waited for, so a
  // per-user always_forward applied only when the lookup happened to win the race against the
  // frontend's first subscribe_entities. It usually did, which is what made the failure
  // intermittent: the same client, same config, and the extra entities present or missing
  // depending on how fast HA answered. Resolving the payload at FLUSH time is what makes the
  // rule apply to the first subscribe_entities, which is the only one that matters.
  let gateQueue = null;
  const flush = (thunk) => { const v = thunk(); if (v != null) toHA(v); };
  const sendOrQueue = (thunk) => { if (gateQueue) gateQueue.push(thunk); else flush(thunk); };
  const openGate = () => {
    const held = gateQueue || [];
    gateQueue = null;
    held.forEach(flush);
    drained();
  };

  haWs.on('open', () => {
    haOpen = true;
    queue.forEach((s) => (Buffer.isBuffer(s) ? haWs.send(s, BIN) : haWs.send(s)));
    queue.length = 0;
    drained();
  });

  browserWs.on('message', (raw, isBinary) => {
    if ((!haOpen || gateQueue) && overflow(raw.length)) return;
    // Binary frames are forwarded byte-for-byte. They are not JSON, and running toString()
    // over them UTF-8-decodes arbitrary bytes — lossy — and then re-sends them as a TEXT
    // frame. Home Assistant uses binary frames for media, so this path carries camera data.
    if (isBinary) return toHA(raw);
    let s = raw.toString(); let m;
    try { m = JSON.parse(s); } catch { return toHA(s); }
    // The auth message carries the identity. Forward it immediately (HA is waiting for it),
    // then hold everything after it until the user is known.
    if ((userRulesCouldApply(dash) || anyPauseActive(PAUSES)) && m && m.type === 'auth' && m.access_token && gateQueue === null && !userChecked) {
      userChecked = true;
      toHA(s);
      gateQueue = [];
      resolveUser(m.access_token, meta.fwd).then((user) => {
        // Rebuilt from what bridge() was handed rather than captured in the upgrade handler:
        // the two are different functions, and reaching across cost a silent ReferenceError
        // inside this promise chain — the widening simply never happened and nothing said so.
        const extra = rulesForUser(user, { ip: meta.ip, ua: meta.ua ?? null, dash, host: meta.host ?? null });
        // Log the miss too. A rule that matches nothing is indistinguishable from no rule at
        // all otherwise — and the usual cause is that HA's user NAME ("David Coulson") is not
        // the first name people write in config.
        // Once per user-and-dashboard, then debug: a companion app reconnecting every five
        // minutes repeated this line for the life of the process, and it is advice, not news.
        if (!extra && user) {
          const msg = `no user rule matched ${JSON.stringify(user.name)} `
            + `(id ${user.id})${dash ? ` on ${dash}` : ''} — match on that exact name or the id`;
          if (onceOnly(`user-nomatch:${user.id}:${dash ?? ''}`)) log(msg); else debug(msg);
        }
        if (extra) {
          allow = applyUserRules(allow, extra);
          resRules.always.push(...(extra.resAlways ?? []));
          resRules.never.push(...(extra.resNever ?? []));
          // The set changed, so any signature taken before now is stale. The gate holds every
          // message until this resolves, and the cache lookups run inside the held thunks
          // (cachedOrForward), so none should have been taken — but that was once untrue, and
          // silently, so reset rather than depend on the ordering.
          allowSigReset();
          // Once per user, dashboard and size, then at debug. A phone on cellular reconnects every
          // few minutes, and this line — the same answer each time — was about 500 a day.
          const msg = `user rules applied for ${user.name ?? user.id}: ${allow.size} entities`
            + `${dash ? ` on ${dash}` : ''} (was ${baseAllow.size})`;
          if (onceOnly(`user-rules:${user.id}:${dash ?? ''}:${allow.size}`)) log(msg); else debug(msg);
        }
        // The pause, if this user has one. Checked HERE rather than at the upgrade because the
        // token is the only thing that names the person, and it is not read until now. The gate
        // holds every later message, so the first subscribe_entities is still stamped correctly —
        // the same ordering the user rules above depend on.
        if (user) {
          bridgeInfo.user = user.id ?? user.name ?? null;
          bridgeInfo.isAdmin = Boolean(user.is_admin);
          const until = pausedForUser(PAUSES, user);
          if (until) {
            trimming = false;
            log(`trim PAUSED for ${user.name ?? user.id} on this connection `
              + `(${meta.ip ?? '?'}${dash ? `, ${dash}` : ''}) — serving everything until `
              + `${new Date(until).toISOString()}`);
          }
        }
        // Tell the panel who this is and what it ended up with, so a widened connection stops
        // reporting the size it had before the rules ran.
        if (user) stats.connIdentity(connId, { allowSize: allow.size, user: user.name ?? user.id, paused: !trimming });
      }).catch(() => {}).finally(openGate);
      return;
    }
    // No user rule could apply to this dashboard, so nothing about what gets SERVED depends on
    // who this is — but the panel still has a "user" column, and leaving it blank made every
    // wall panel look like an anonymous connection when the identity was simply never asked for.
    // Resolve it for reporting only: no gate, no queue, nothing waits. The answer arrives when it
    // arrives and updates the row in place, so this cannot add a millisecond to a page load.
    // Cached per token like the gated path, so a panel that reconnects hourly asks HA once.
    if (!userChecked && m && m.type === 'auth' && m.access_token && !userRulesCouldApply(dash) && !anyPauseActive(PAUSES)) {
      userChecked = true;
      resolveUser(m.access_token, meta.fwd)
        .then((user) => {
          if (!user) return;
          bridgeInfo.user = user.id ?? user.name ?? null;
          bridgeInfo.isAdmin = Boolean(user.is_admin);
          stats.connIdentity(connId, { user: user.name ?? user.id });
        })
        .catch(() => {});
      // Deliberately falls through: the auth message still has to reach HA the normal way.
    }
    if (m && m.id != null && m.type) {
      if (pendingTypes.size > 500) pendingTypes.clear();
      pendingTypes.set(m.id, m.type);
    }
    if (trimming && m && m.type === 'get_states') getStatesIds.add(m.id);
    // A request the shared cache may be able to answer. The lookup itself is deferred to the
    // thunk below — see cachedOrForward — so it runs at FLUSH time, after any user rule has
    // settled the allowlist. Only what to look up is decided here.
    let cacheKind = null;
    if (trimming && TRIM_REGISTRIES && m && REGISTRY_TYPES.has(m.type)) cacheKind = REGISTRY_TYPES.get(m.type);
    if (trimming && TRIM_RESOURCES && m && m.type === 'lovelace/resources') resourceIds.add(m.id);
    // get_services is every service of every integration, sent on every page load, and — like
    // the registries — identical for every client on a given allowlist. It was the last of the
    // big instance-wide payloads still being rebuilt by HA and re-parsed here once per
    // connection, while the registries beside it were being served from memory.
    // Observed, never trimmed. get_translations is the largest untrimmed payload in the boot
    // path — ~247KB per call, 21.6% of all websocket traffic on the instance this was built
    // against — and trimming it is risky in a way the other payloads are not: a missing
    // translation renders its raw key ON the dashboard. So measure first, in the product,
    // rather than reason from HA's key conventions and hope.
    if (m && m.type === 'frontend/get_translations') translationIds.add(m.id);
    // Shape capture for payloads that are candidates for trimming but have not been seen yet.
    // Measuring before designing has changed the design twice — translations would have shipped
    // a filter keyed on entity domain, which renders raw keys — so nothing else gets trimmed on
    // the strength of what its API "probably" returns.
    if (m && SHAPE_TYPES.has(m.type)) shapeIds.set(m.id, m.type);
    if (trimming && TRIM_THEMES && m && m.type === 'frontend/get_themes') themeIds.add(m.id);
    if (trimming && TRIM_REPAIRS && m && m.type === 'repairs/list_issues') repairIds.add(m.id);
    if (trimming && TRIM_SERVICES && m && m.type === 'get_services') cacheKind = 'services';
    // No event_type means "every event", which includes state_changed.
    if (trimming && m && m.type === 'subscribe_events'
        && (!m.event_type || m.event_type === 'state_changed')) {
      stateChangedSubs.add(m.id);
      debug(`subscribe_events(${m.event_type ?? 'ALL EVENTS'}) id=${m.id} from ${meta.ip ?? '?'} dash=${dash ?? '(union)'}`);
    }
    // Registry CHANGE events, which nothing filtered per connection. `registryEventMatters`
    // gates only the control connection's rebuild decision; the egress filter below covered
    // subscribe_entities and nothing else. So a panel subscribed here received a change event
    // for every one of the instance's entities — measured at 91,873 bytes per frame and 14.3%
    // of all websocket traffic, for entities that connection cannot see and has no row for,
    // because the registry it was given was already trimmed to its allowlist.
    if (trimming && TRIM_REGISTRIES && m && m.type === 'subscribe_events'
        && m.event_type === 'entity_registry_updated') {
      registrySubs.add(m.id);
      debug(`subscribe_events(entity_registry_updated) id=${m.id} from ${meta.ip ?? '?'}`);
    }
    // A client naming itself. A browser voice satellite sends its own entity_id on this socket
    // (voice_satellite/subscribe_events, and a keepalive check every 30s), which is a far better
    // identity signal than an IP: it needs no mDNS — a web page cannot advertise it — no DHCP
    // reservation, and no configuration.
    //
    // Strictly additive. It can only widen this client's allowlist, never narrow it.
    if (trimming && m && typeof m.type === 'string' && m.type.startsWith('voice_satellite/')
        && typeof m.entity_id === 'string' && m.entity_id.startsWith('assist_satellite.')) {
      const added = learnClientEntity(meta.ip, m.entity_id);
      // Log the announcement itself, not only the case where it changed something. A panel whose
      // entities are already supplied by a client_overrides rule adds nothing — so without this
      // the mechanism is invisible, and there is no way to tell "working, nothing to do" apart
      // from "not working".
      //
      // ONCE per address-and-satellite, then at debug. The satellite re-announces every 30
      // seconds and the throttle window is 10, so the throttle never collapsed anything: three
      // panels wrote ~8,600 identical lines a day, which with the rebuild reports beside them left
      // the Supervisor's log buffer holding about ten minutes of history.
      const announceMsg = `${meta.ip ?? '?'} announces ${m.entity_id}${added ? '' : ' (already covered)'}`;
      // Keyed on the ADDRESS only, and still throttled underneath. This block runs before the auth
      // gate — only `type: 'auth'` is intercepted above — so `m.entity_id` is unauthenticated
      // client input. With it in the key, a socket sending a fresh id per frame got one unthrottled
      // line per frame and, once SAID filled, defeated the cap as well. An address is bounded by
      // the network; a string off the wire is not.
      if (added || onceOnly(`selfid:${meta.ip}`)) log(announceMsg);
      else logThrottled(`selfid:${meta.ip}`, announceMsg, LEVELS.debug);
      if (added && !added.every((id) => allow.has(id))) {
        log(`${meta.ip ?? '?'} identified itself as ${m.entity_id}: +${added.length} entities on its next connection`);
        // The allowlist for THIS connection was already sent; the frontend has to re-subscribe
        // to benefit. Dropping the socket makes it reconnect immediately, and the learned set is
        // cached by address so the reconnect picks it up. Once per connection, so a satellite
        // that re-announces cannot put the panel in a reconnect loop.
        if (!learnedKick) { learnedKick = true; setTimeout(() => { try { browserWs.close(); } catch {} }, 250); }
      }
    }
    // Deferred to send time rather than done here — see the gate note above for why stamping
    // at this point silently dropped per-user rules.
    let stampAllow = false;
    if (trimming && m && m.type === 'subscribe_entities' && !m.entity_ids) {
      subEntityIds.add(m.id);              // remember it, to defensively re-filter its events
      stampAllow = true;
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
    // reloads; set `by_dashboard: false` if that matters more than the trimming does.
    if (m && m.type === 'unsubscribe_events' && m.subscription != null) {
      subEntityIds.delete(m.subscription);
      stateChangedSubs.delete(m.subscription);
      registrySubs.delete(m.subscription);
    }
    // Answer a registry or get_services request from the shared cache, or mark it so HA's reply
    // is trimmed and cached. Returns null on a hit (nothing goes to HA at all — safe against
    // HA's increasing-id rule, and the browser still sees replies in the order it asked).
    //
    // A THUNK, like the subscribe_entities stamp above, and for the same reason. The cache key
    // carries the signature of this connection's allowlist, and that allowlist is still moving
    // while the user-rule gate is closed. Looking the key up at receive time — which is what
    // this did — took the signature of the PRE-rule set, found the entry another connection on
    // the same dashboard had left there, and answered a widened user with rows missing exactly
    // the entities the rule adds. The gate never saw it: a hit returned before reaching the
    // queue. Reproduced with a slow auth/current_user in test/proxy.perdash.test.mjs.
    const cachedOrForward = (kind) => () => {
      if (!haAuthed) return s;   // HA will refuse it; never answer from cache before auth_ok
      if (!trimming) return s;   // a pause landed while this was held
      const hit = REG_RESPONSE_CACHE.get(regCacheKey(kind, dash, cacheSig()));
      if (hit !== undefined) {
        logThrottled(`regcache:${kind}`, `${kind === 'services' ? 'get_services' : `${kind} registry`} served from cache${dash ? ` (${dash})` : ''}`, LEVELS.debug);
        stats.recordCacheHit(hit.length);
        safeSend(`{"id":${m.id},"type":"result","success":true,"result":${hit}}`);
        return null;
      }
      // A miss: this goes to HA to be built. Counted so the hit RATE has a denominator.
      stats.recordCacheMiss();
      if (kind === 'services') serviceIds.set(m.id, ALLOW_VERSION); else registryIds.set(m.id, { kind, ver: ALLOW_VERSION });
      return s;
    };
    // Noted when the thunk RUNS, not on receipt: a held message is judged against the allowlist
    // the user rules have settled, and a paused connection is not judged at all.
    const noted = (thunk) => () => { if (trimming && m && typeof m === 'object') noteAsked(dash, m, allow); return thunk(); };
    sendOrQueue(noted(stampAllow
      ? () => {
        if (!trimming) { subEntityIds.delete(m.id); return s; }   // a pause landed while this was held
        // Belt-and-braces to the upgrade gate: an empty entity_ids is NOT "subscribe to
        // nothing", it's "no filter" (HA: `set(msg["entity_ids"]) or None`). Sending one
        // would invert the add-on's entire purpose, so drop the connection instead.
        // Re-checked here rather than at queue time because a never_forward user rule can
        // narrow the allowlist while this message is held.
        if (!allow.size) {
          logThrottled('empty-allow', 'ERROR: refusing subscribe_entities — the allowlist is empty, and forwarding that would stream EVERY entity. Check the `dashboards` option.');
          close();
          return null;
        }
        m.entity_ids = [...allow];         // HA now streams only this connection's allowlist
        return JSON.stringify(m);
      }
      : cacheKind ? cachedOrForward(cacheKind)
      : () => s));
  });

  // ---- per-connection helpers for the HA -> browser path ----
  //
  // These were defined INSIDE the message handler, so every frame — including each of the
  // thousands-per-hour entity diffs — allocated six closures before doing anything. None of them
  // depends on the frame: they read this connection's subscription sets and its `allow`, which is
  // a `let` and so is seen at its current value from here exactly as it was from there.
  const sized = (v) => { try { return Buffer.byteLength(JSON.stringify(v)); } catch { return 0; } };
  // Does this frame carry the connection's initial entity state?
  //
  // `a` is HA's "added" block — the full state of every subscribed entity, sent once when a
  // subscribe_entities subscription opens. `c` ("changed") is every diff after it. Checked
  // through batched arrays too: HA packs messages together, and the initial payload is
  // routinely bundled with other replies, so testing only the top-level object would miss it
  // on exactly the connections that are busiest at startup.
  const isInitialState = (x) => Boolean(
    x && x.type === 'event' && subEntityIds.has(x.id)
    && x.event && x.event.a && Object.keys(x.event.a).length,
  );
  const carriesInitialState = (msg) => (Array.isArray(msg) ? msg.some(isInitialState) : isInitialState(msg));
  // Measure the `a` BLOCK, not the frame it arrived in.
  //
  // This used to be `Buffer.byteLength(s)` — the whole frame. HA batches messages into an
  // array, so that number silently included whatever else was bundled alongside: sometimes
  // lovelace/config and the registries, sometimes nothing. Measured live it varied by 164x
  // between two clients on the SAME dashboard with the SAME 149-entity allowlist (246KB vs
  // 1.5KB), which makes it useless as a payload figure and actively misleading next to a
  // column header that says "Payload".
  //
  // The entity count is reported beside it deliberately. Bytes alone cannot be sanity-checked
  // by a reader, but "447 bytes / 3 entities" against a 104-entity allowlist is visibly a
  // partial first block rather than a mystery, and the panel stops being able to imply a
  // cold-start payload it did not actually observe.
  const initialStateSize = (msg) => {
    let bytes = 0, entities = 0;
    for (const x of (Array.isArray(msg) ? msg : [msg])) {
      if (!isInitialState(x)) continue;
      bytes += Buffer.byteLength(JSON.stringify(x.event.a));
      entities += Object.keys(x.event.a).length;
    }
    return { bytes, entities };
  };

  // Home Assistant BATCHES messages into a JSON array. Every `m.type` check below sees
  // undefined on those, so an array frame fell through every branch untouched and
  // unlabelled — which is how an unfiltered firehose hid in plain sight. Handle the array
  // by filtering its elements, then fall through with the rest of the logic intact.
  // A registry change for an entity this connection cannot see. Dropped whole: the browser
  // holds no row for it, so the update has nothing to apply to. Entities that are ADDED and
  // later become relevant are not lost — a new entity changes the allowlist, which triggers
  // a recompute and reconnects open dashboards.
  const dropRegistryEvent = (x) => trimming && TRIM_REGISTRIES
    && x && x.type === 'event'
    && registrySubs.has(x.id)
    && typeof x.event?.data?.entity_id === 'string'
    && !allow.has(x.event.data.entity_id);

  const dropStateChanged = (x) => trimming
    && x && x.type === 'event'
    && stateChangedSubs.has(x.id)
    && typeof x.event?.data?.entity_id === 'string'
    && !allow.has(x.event.data.entity_id);

  haWs.on('message', (raw, isBinary) => {
    // Same on the way back, and this is the direction that carries the volume: on the
    // instance this was built against, binary frames were 90% of everything a wall panel
    // received — 12MB in 68 seconds — while being silently corrupted in transit.
    if (isBinary) {
      const n = raw.length;
      stats.recordTraffic('binary (media/camera)', n);
      stats.connTraffic(connId, n, n, false);
      return safeSend(raw);
    }
    let s = raw.toString(); let m;
    // Sizes are measured on the decoded JSON, i.e. what the browser has to parse. The wire is
    // smaller when permessage-deflate is on, and deliberately not what the panel reports.
    // `raw` IS that UTF-8, so its length is the answer without walking the string again.
    const inBytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(s);
    const received = s;
    let cat = null;
    // Set for a BATCHED (array) frame, so done() labels it once, after trimming. Home Assistant
    // packs messages into arrays; `m.type` is undefined on those, so without this they fall
    // through every branch in done() and land in the "(no type field)" bucket — on top of the
    // label the array branch already recorded. Measured live: 165 batched frames produced 165
    // phantom "(no type field)" entries carrying 2.78MB that was never a separate payload.
    let batchedKinds = null;
    let eventCount = 0;        // entity events in THIS frame; bytes are attributed in done()
    // Per-MESSAGE trim accounting. done() only knows the whole frame's size, and HA batches —
    // so a 9KB area registry sharing a frame with the 10MB entity registry was billed for the
    // entire frame. Measured on a live instance the area registry reported 2,762KB against 30
    // real areas, an overstatement of roughly 300x. Same family as the batched double-count
    // fixed in .14, which corrected recordTraffic and left recordTrim on the frame total.
    //
    // Serialising per message is affordable HERE and nowhere else: these are registries,
    // services and resources — a handful per page load — not the thousands-per-second event
    // stream, where exactly this pattern was removed for being wasteful.
    const frameTrims = [];
    let isEvent = false;
    const done = () => {
      // Most frames go out exactly as they came in; only a re-serialised one needs measuring.
      const outBytes = s === received ? inBytes : Buffer.byteLength(s);
      // Per-message where we measured it; the frame total is only right for a lone message.
      if (frameTrims.length) for (const t of frameTrims) stats.recordTrim(t.cat, t.before, t.after);
      else if (cat) stats.recordTrim(cat, inBytes, outBytes);
      // One call per FRAME, carrying however many events it held — see eventCount above.
      if (eventCount) stats.recordEvent(outBytes, eventCount);
      // Strictly `type === "event"`. This used to be `cat === null`, i.e. "not one of the
      // four trimmed categories", which swept up lovelace/config and every other untrimmed
      // reply and reported the lot as live update traffic.
      stats.connTraffic(connId, inBytes, outBytes, isEvent);
      // Label by kind so nothing can flow unexplained. Events carry their event_type;
      // results are attributed to the command that asked for them.
      if (batchedKinds !== null) {
        // One row per frame, sized like every other row: what actually went to the browser.
        stats.recordTraffic(`batched ${batchedKinds}`, outBytes);
      } else if (m && m.type === 'event') {
        stats.recordTraffic(`event:${m.event?.event_type ?? 'entity-diff'}`, outBytes);
      } else if (m && m.type === 'result') {
        stats.recordTraffic(`result:${pendingTypes.get(m.id) ?? 'unknown'}`, outBytes);
        pendingTypes.delete(m.id);
      } else if (m && m.type) {
        stats.recordTraffic(m.type, outBytes);
      } else {
        // Valid JSON with no `type`. This is where the volume actually is, and the shape is
        // unknown — so dump the keys and a sample rather than filing it under a label that
        // says nothing. Throttled to one line.
        stats.recordTraffic('(no type field)', outBytes);
      }
      // The first full entity payload is the one a dashboard cannot render without, so it is
      // the honest "time to useful". HA sends the initial state as an `a` (added) block on the
      // subscribe_entities subscription; every later one is `c` (changed) and is not this.
      // Measured once per connection — see stats.connTiming.
      if (!timedInitial && carriesInitialState(m)) {
        timedInitial = true;
        const queuedAt = Date.now();
        const { bytes, entities } = initialStateSize(m);
        return safeSend(s, () => {
          const sentAt = Date.now();
          stats.connTiming(connId, {
            msToEntityData: sentAt - tOpen,
            initialPayloadBytes: bytes,
            initialEntityCount: entities,
            initialDrainMs: sentAt - queuedAt,
          });
          // Which signal won the attribution — cookie, ip or user-agent. Read off `meta`, which
          // bridge() already receives it in; the bare `via` from the caller's scope is NOT
          // visible here, and writing it that way took the add-on down on a live instance.
          // `meta` defaults to {}, so a future plumbing slip renders "undefined" rather than
          // throwing inside a write callback.
          log(`entity payload delivered to ${meta.ip ?? '?'}`
            + `${dash ? ` (${dash} via ${meta.via})` : ' (union — no dashboard attributed)'}: `
            + `${(bytes / 1024).toFixed(1)}KB / ${entities} entities in ${sentAt - tOpen}ms from connect `
            + `(${sentAt - queuedAt}ms to the network stack)`);
        });
      }
      return safeSend(s);
    };
    try { m = JSON.parse(s); } catch (e) {
      logThrottled('unparsed-frame', `frame that is neither binary nor JSON (${raw?.length ?? '?'} bytes): ${e.message}`);
      return done();
    }
    if (m && m.type === 'auth_ok') haAuthed = true;

    // Apply the trims to ONE message.
    //
    // All of this used to be written against the top-level object, so a BATCHED frame — Home
    // Assistant packs several messages into a single JSON array — bypassed every trim. That is
    // not a small leak: ~13.5MB of untrimmed registry rode inside batched frames on every
    // connection while `trim_registries` was on and logging success for the unbatched ones.
    // Returns null to drop the message entirely.
    let changed = false;
    const transform = (msg) => {
      if (!msg || typeof msg !== 'object') return msg;
      if (dropStateChanged(msg)) return null;
      if (dropRegistryEvent(msg)) return null;
      // A refused request never reaches the shape checks below that retire its id, so it would
      // sit in these collections for the life of the connection.
      if (msg.type === 'result' && msg.success === false) {
        getStatesIds.delete(msg.id); registryIds.delete(msg.id); resourceIds.delete(msg.id);
        serviceIds.delete(msg.id); repairIds.delete(msg.id); translationIds.delete(msg.id);
        themeIds.delete(msg.id); stateChangedSubs.delete(msg.id);
      }

      if (trimming && msg.type === 'result' && getStatesIds.has(msg.id) && Array.isArray(msg.result)) {
        const beforeB = sized(msg.result);
        const before = msg.result.length;
        msg.result = msg.result.filter((e) => allow.has(e.entity_id));
        getStatesIds.delete(msg.id);
        changed = true;
        cat = 'states';
        frameTrims.push({ cat, before: beforeB, after: sized(msg.result) });
        if (before > INSTANCE_ENTITIES) INSTANCE_ENTITIES = before;
        log(`get_states trimmed ${before} -> ${msg.result.length}${dash ? ` (${dash})` : ''}`);
      }
    if (trimming && TRIM_REGISTRIES && msg && msg.type === 'result' && registryIds.has(msg.id) && msg.result && typeof msg.result === 'object') {
      const { kind, ver } = registryIds.get(msg.id);
      registryIds.delete(msg.id);
      const rowsOf = (r) => (Array.isArray(r) ? r.length : (Array.isArray(r?.entities) ? r.entities.length : -1));
      const beforeB = sized(msg.result);
      const before = rowsOf(msg.result);
      msg.result = trimRegistry(kind, msg.result, allow);
      const after = rowsOf(msg.result);
      if (after !== before) {
        changed = true;
        logThrottled(`reg:${kind}`, `${kind} registry trimmed ${before} -> ${after}${dash ? ` (${dash})` : ''}`);
      }
      cat = `registry:${kind}`;
      frameTrims.push({ cat, before: beforeB, after: sized(msg.result) });
      // Keep the trimmed rows for the next connection on this allowlist. Stored as a JSON
      // STRING, not an object: it is only ever spliced back into a reply, so serialising it
      // once here saves doing it per hit, and nothing downstream can mutate a string.
      // Only if no rebuild landed while HA was answering: that reply was built from rows the rebuild
      // retired, and keying it under the NEW version would serve them as current.
      if (ver === ALLOW_VERSION) regCacheSet(regCacheKey(kind, dash, cacheSig()), JSON.stringify(msg.result));
    }
    if (trimming && TRIM_THEMES && msg && msg.type === 'result' && themeIds.has(msg.id)
        && msg.result && typeof msg.result.themes === 'object') {
      themeIds.delete(msg.id);
      // The two defaults are read from the REPLY, not from config: they are whatever HA says
      // they are right now, including a dark default that no dashboard names anywhere.
      const keep = new Set([msg.result.default_theme, msg.result.default_dark_theme, ...THEMES_USED]
        .filter((t) => typeof t === 'string' && t));
      const beforeB = sized(msg.result);
      const beforeN = Object.keys(msg.result.themes).length;
      const next = {};
      for (const [name, def] of Object.entries(msg.result.themes)) if (keep.has(name)) next[name] = def;
      const afterN = Object.keys(next).length;
      // Keeping nothing would leave every dashboard unthemed, which is worse than sending all
      // of them — so an empty result forwards the original, same as the services trim.
      if (afterN && afterN !== beforeN) {
        msg.result = { ...msg.result, themes: next };
        changed = true;
        logThrottled('themes', `get_themes trimmed ${beforeN} -> ${afterN} themes${dash ? ` (${dash})` : ''}`);
      }
      cat = 'themes';
      frameTrims.push({ cat, before: beforeB, after: sized(msg.result) });
    }
    if (msg && msg.type === 'result' && shapeIds.has(msg.id)) {
      const kind = shapeIds.get(msg.id);
      shapeIds.delete(msg.id);
      const r = msg.result;
      const describe = (v, d = 0) => {
        if (v === null || typeof v !== 'object') return typeof v;
        if (Array.isArray(v)) return `array[${v.length}]` + (v.length && d < 2 ? ` of ${describe(v[0], d + 1)}` : '');
        const keys = Object.keys(v);
        return d >= 2 ? `object{${keys.length} keys}`
          : `object{${keys.length}: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}}`;
      };
      stats.recordShape(kind, { bytes: sized(r), shape: describe(r), topKeys: (r && typeof r === 'object' && !Array.isArray(r)) ? Object.keys(r).slice(0, 25) : null });
    }
    if (msg && msg.type === 'result' && translationIds.has(msg.id)) {
      translationIds.delete(msg.id);
      // Key COUNTS per prefix, not bytes: byte-accurate subtree sizes would mean serialising
      // each one, and this payload is a quarter of a megabyte. Counts answer the question that
      // matters — how much of it is `component.<domain>` and therefore filterable at all.
      const res = msg.result?.resources;
      // Sized BEFORE any trimming below. `res` holds the original resources object, so the key
      // count already describes the untrimmed payload — reading the byte count off the mutated
      // `msg.result` afterwards paired an untrimmed count with a trimmed size, which reads as
      // "5,359 keys in 108KB" and understates the payload this diagnostic exists to measure.
      const originalBytes = sized(msg.result);
      if (res && typeof res === 'object' && TRIM_TRANSLATIONS) {
        // Keep a `component.<x>` tree when x is either an entity DOMAIN this connection can see
        // (`light`, `sensor` — the generic UI strings) or the INTEGRATION providing one of its
        // entities (`tuya_local` — where that integration's own state names live). Both are
        // required; either alone renders raw keys.
        const keep = new Set(['homeassistant']);
        for (const id of allow) {
          keep.add(String(id).split('.')[0]);
          const plat = PLATFORM_BY_ENTITY.get(id);
          if (plat) keep.add(plat);
        }
        const beforeB = sized(msg.result);
        const beforeN = Object.keys(res).length;
        const next = {};
        for (const [k, v] of Object.entries(res)) {
          const parts = String(k).split('.');
          // Anything not shaped `component.<x>.…` is passed through untouched. Measured at 0%%
          // of a real payload, but a category that does not match must never be silently lost.
          if (parts[0] !== 'component' || parts.length < 2 || keep.has(parts[1])) next[k] = v;
        }
        const afterN = Object.keys(next).length;
        if (afterN && afterN !== beforeN) {
          msg.result = { ...msg.result, resources: next };
          changed = true;
          logThrottled('translations',
            `get_translations trimmed ${beforeN} -> ${afterN} keys${dash ? ` (${dash})` : ''}`);
        }
        cat = 'translations';
        frameTrims.push({ cat, before: beforeB, after: sized(msg.result) });
      }
      if (res && typeof res === 'object') {
        const byPrefix = {};
        let total = 0;
        for (const k of Object.keys(res)) {
          total++;
          const parts = String(k).split('.');
          const pre = parts[0] === 'component' && parts.length > 1 ? `component.${parts[1]}` : parts[0];
          byPrefix[pre] = (byPrefix[pre] || 0) + 1;
        }
        stats.recordTranslations({ keys: total, bytes: originalBytes, byPrefix });
      }
    }
    // Emptied rather than dropped. The frontend asks for this and waits; a missing reply would
    // leave that request pending forever, while an empty issue list is a perfectly valid answer
    // meaning "nothing to report".
    if (trimming && TRIM_REPAIRS && msg && msg.type === 'result' && repairIds.has(msg.id)
        && msg.result && typeof msg.result === 'object') {
      repairIds.delete(msg.id);
      const beforeB = sized(msg.result);
      const n = Array.isArray(msg.result?.issues) ? msg.result.issues.length : -1;
      if (n > 0) {
        msg.result = { ...msg.result, issues: [] };
        changed = true;
        logThrottled('repairs', `repairs/list_issues trimmed ${n} -> 0 issues${dash ? ` (${dash})` : ''}`);
      }
      cat = 'repairs';
      frameTrims.push({ cat, before: beforeB, after: sized(msg.result) });
    }
    if (trimming && TRIM_SERVICES && msg && msg.type === 'result' && serviceIds.has(msg.id)
        && msg.result && typeof msg.result === 'object' && !Array.isArray(msg.result)) {
      const ver = serviceIds.get(msg.id);
      serviceIds.delete(msg.id);
      const keep = new Set(['homeassistant']);
      for (const id of allow) keep.add(String(id).split('.')[0]);
      const beforeB = sized(msg.result);
      const before = Object.keys(msg.result).length;
      const next = {};
      for (const [domain, svcs] of Object.entries(msg.result)) if (keep.has(domain)) next[domain] = svcs;
      const after = Object.keys(next).length;
      if (after && after !== before) {
        msg.result = next;
        changed = true;
        logThrottled('services', `get_services trimmed ${before} -> ${after} domains${dash ? ` (${dash})` : ''}`);
      }
      cat = 'services';
      frameTrims.push({ cat, before: beforeB, after: sized(msg.result) });
      // Cache whatever is actually being SENT, not `next` — when the trim keeps nothing
      // (`after === 0`) the block above deliberately forwards the untrimmed result rather than
      // handing the frontend an empty service list, and the cache has to agree with that
      // decision or the first connection would see the safe answer and every later one the
      // empty one.
      if (ver === ALLOW_VERSION) regCacheSet(regCacheKey('services', dash, cacheSig()), JSON.stringify(msg.result));
    }
    if (trimming && TRIM_RESOURCES && msg && msg.type === 'result' && resourceIds.has(msg.id) && Array.isArray(msg.result)) {
      resourceIds.delete(msg.id);
      const keep = dash ? RESOURCES_BY_DASH.get(dash) : null;
      if (keep?.size || resRules.always.length || resRules.never.length) {
        const beforeB = sized(msg.result);
        const before = msg.result.length;
        msg.result = msg.result.filter((r) => keepResourceFor(r?.url, keep, resRules));
        if (msg.result.length !== before) {
          changed = true;
          logThrottled('resources', `lovelace resources trimmed ${before} -> ${msg.result.length} (${dash ?? 'unattributed'})`);
        }
        cat = 'resources';
        frameTrims.push({ cat, before: beforeB, after: sized(msg.result) });
      }
    }
    if (trimming && msg && msg.type === 'event' && subEntityIds.has(msg.id) && msg.event) {
      // NB: sets the OUTER `changed`. A local one here would shadow it, the frame would
      // never be re-serialised, and this filter would silently do nothing.
      const ev = msg.event;
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
      // Counted here, WEIGHED in done(). This used to be
      // `recordEvent(Buffer.byteLength(JSON.stringify(msg)))`, which re-serialised the message
      // purely to measure it — and transform() runs per message, so a batched frame carrying
      // fifty entity diffs paid for fifty extra full serialisations of the largest objects on
      // the hottest path, on top of the one done() already performs to send them. It also
      // measured a RECONSTRUCTION rather than the bytes that actually went out. done() already
      // knows the real outgoing size; the only thing it cannot know is how many events the
      // frame held, so that is all this tracks.
      eventCount += 1;
      isEvent = true;
    }
      return msg;
    };

    if (Array.isArray(m)) {
      const kinds = [...new Set(m.map((x) => (x?.type === 'event'
        ? `event:${x.event?.event_type ?? 'entity-diff'}`
        : (x?.type ?? '?'))))].sort().join('+');
      const before = m.length;
      const kept = [];
      for (const x of m) { const t = transform(x); if (t !== null) kept.push(t); }
      // Recorded in done() instead, against the TRIMMED size. This used to record inBytes here,
      // which reported batched frames at their pre-trim size while every other row reported what
      // was actually sent — making the biggest row in the table both double-counted and inflated.
      batchedKinds = kinds;
      if (!kept.length) return;                        // nothing survived: forward nothing
      if (changed || kept.length !== before) {
        s = JSON.stringify(kept);
        cat = cat ?? 'batched';
        logThrottled('batch-trim', `batched frame: ${before} -> ${kept.length} msgs, `
          + `${inBytes} -> ${Buffer.byteLength(s)} bytes${dash ? ` (${dash})` : ''}`);
      }
      return done();
    }

    const single = transform(m);
    if (single === null) return;
    if (changed) s = JSON.stringify(single);
    return done();
  });

  // The callback is what makes drain time measurable: ws invokes it once the frame has been
  // handed to the socket, so the gap between calling send() and the callback firing IS the
  // time the payload spent going out. On a LAN that is ~0; on a phone over cellular it is the
  // link, which is exactly the number worth reporting.
  function safeSend(s, cb) {
    try {
      if (browserWs.readyState !== 1) return;
      if (Buffer.isBuffer(s)) browserWs.send(s, BIN, cb); else browserWs.send(s, cb);
      bpCheck();
    } catch {}
  }
  // Liveness for both legs. A peer that vanished without a FIN (a phone leaving wifi, a wedged HA)
  // sends nothing, so it never trips the backpressure stall either; without a ping the pair of
  // sockets and everything the bridge holds would stay until the OS gave up, hours later.
  let browserAlive = true, haAlive = true;
  browserWs.on('pong', () => { browserAlive = true; });
  haWs.on('pong', () => { haAlive = true; });
  const liveTimer = setInterval(() => {
    if (!browserAlive || !haAlive) { try { browserWs.terminate(); } catch {} try { haWs.terminate(); } catch {} return; }
    browserAlive = haAlive = false;
    try { browserWs.ping(); } catch {} try { haWs.ping(); } catch {}
  }, BRIDGE_PING_MS);
  liveTimer.unref?.();
  const close = () => {
    clearInterval(liveTimer);
    openBridges.delete(close); stats.connClose(connId);
    if (bpTimer) { clearInterval(bpTimer); bpTimer = null; }
    try { browserWs.close(); } catch {} try { haWs.close(); } catch {}
  };
  openBridges.set(close, bridgeInfo);   // so a grown allowlist — or a pause — can recycle this connection (#7)
  browserWs.on('close', (code) => {
    // 1009 is `ws` refusing a frame bigger than maxPayload. Worth a line: from the panel's side it
    // is an unexplained disconnect, and the cause is a limit this proxy chose.
    if (code === 1009) {
      logThrottled(`toobig:${meta.ip}`, `${meta.ip ?? '?'} sent a frame over the `
        + `${(BROWSER_MAX_PAYLOAD / 1048576).toFixed(0)}MB limit and was disconnected `
        + '(BROWSER_MAX_PAYLOAD_BYTES)');
    }
    close();
  });
  browserWs.on('error', close);
  haWs.on('close', close);
  haWs.on('error', (e) => { logThrottled(`haws:${e.code || e.message}`, `HA ws error ${e.message}`); close(); });
}

// ---- stats panel + JSON API ----
// Served on STATS_PORT, which config.yaml declares as the add-on's `ingress_port`, so HA
// renders the panel in the sidebar with no extra configuration. The same JSON is reachable
// directly at http://<host>:8100/stats.json for a `rest` sensor, a scrape, or curl.
//
// Read-only by design: it exposes what the proxy already logs, nothing more, and offers no
// way to change anything. That matters because Ingress hands the page to any logged-in HA
// user — if this could mutate options, it would need a permission model it has no business
// owning.
const PANEL_HTML = (() => {
  try { return fs.readFileSync(new URL('./panel.html', import.meta.url)); }
  catch (e) { log(`stats: panel.html unreadable (${e.message}) — the JSON API still works`); return null; }
})();

// What the machine in front of us is called.
//
// "proxy" as a label is ambiguous in this add-on of all places, because the add-on IS a proxy —
// a row reading `lan · proxy` invites the reading "went through this app", which every row
// did. The honest generic is "reverse proxy", and that is the fallback. But the hop is a real
// address and usually has a real name, so it is worth asking.
//
// Reverse DNS rather than the Supervisor API deliberately: Supervisor's resolver answers PTR for
// the add-on network (172.30.33.5 -> a0d7b954-nginxproxymanager.local.hass.io), so a reverse
// proxy running as an add-on names itself with no API call, no token and no role — and the same
// lookup names a proxy on the LAN if the network's own DNS knows it. An /addons call would cover
// only the first case and would need a Supervisor role this add-on has no other use for.
const HOP_NAMES = new Map();          // ip -> { name, at } — name null means "asked, nothing there"
const HOP_TTL_MS = 10 * 60 * 1000;

// Add-on hostnames carry a repository prefix that is noise to a reader: `a0d7b954-` for a
// community repo, `local-` for a local one, `core-` for a bundled one. The name after it is the
// part anyone recognises.
function tidyHostname(host) {
  const first = String(host || '').split('.')[0];
  return first.replace(/^(?:[0-9a-f]{8}|local|core|addon)[-_]/i, '') || null;
}

function hopNameFor(ip) {
  if (!ip) return null;
  const hit = HOP_NAMES.get(ip);
  if (hit && Date.now() - hit.at < HOP_TTL_MS) return hit.name;
  if (hit) HOP_NAMES.delete(ip);
  // Mark it in flight before awaiting, so a burst of connections asks once.
  if (HOP_NAMES.size >= 500) HOP_NAMES.delete(HOP_NAMES.keys().next().value);   // oldest first
  HOP_NAMES.set(ip, { name: hit?.name ?? null, at: Date.now() });
  dns.promises.reverse(ip)
    .then((names) => HOP_NAMES.set(ip, { name: tidyHostname(names[0]), at: Date.now() }))
    // No PTR record is the normal case on most networks; it is not worth a log line.
    .catch(() => HOP_NAMES.set(ip, { name: null, at: Date.now() }));
  return hit?.name ?? null;
}

function statsExtras() {
  return {
    version: VERSION,
    // Who is currently untrimmed, and until when. In the snapshot rather than an endpoint of its
    // own so the console's ordinary poll carries it: a pause has to be visible on the page you
    // are already looking at, or it is a state nobody notices is still on.
    pauses: listPauses(PAUSES),
    // Same reasoning as deviceFor: resolved per snapshot, because the first lookup is still in
    // flight when the connection that triggered it is recorded.
    hopNameFor,
    // Resolved per snapshot rather than captured at connect: discovery is asynchronous, so a
    // client that connects in the first second of uptime is seen before any mDNS answer arrives.
    // A label frozen then would stay empty for the life of that connection.
    deviceFor: (ip) => {
      const rows = discovery.lookup(ip);
      // Most-specific announcement wins — see preferredRow. A panel advertising as both
      // Kiosk Satellite and ESPHome should not be labelled by whichever answer was faster.
      const best = preferredRow(rows);
      return best ? { kind: best.kind, name: best.name, version: best.version } : null;
    },
    mdns: MDNS_ENABLED ? discovery.snapshot() : { available: false, error: 'disabled', services: [], devices: [] },
    options: {
      trim_entities: STRIP,
      by_dashboard: PER_DASH,
      trim_registries: TRIM_REGISTRIES,
      compress_websocket: COMPRESS_WS,
      trim_resources: TRIM_RESOURCES,
      trim_extra_modules: TRIM_EXTRA_MODULES,
      trim_services: TRIM_SERVICES,
      // Every option belongs here. This list was hand-maintained and silently fell behind:
      // log_level, trim_repairs and trim_translations were all added without it, so the panel
      // reported them as absent when they were merely unlisted — which is indistinguishable
      // from "Supervisor never passed it", the exact question this block exists to answer.
      trim_repairs: TRIM_REPAIRS,
      trim_themes: TRIM_THEMES,
      trim_translations: TRIM_TRANSLATIONS,
      log_level: Object.keys(LEVELS).find((k) => LEVELS[k] === LOG_LEVEL) ?? 'info',
      // Found by the guard test the moment it was written: these two had been missing since they
      // shipped, so the panel never showed whether a given feature was actually on.
      esphome_api: ESPHOME_API,
      mdns_discovery: MDNS_ENABLED,
      client_api_access: CLIENT_API_ACCESS,
      proxy_port: PORT,
      mgmt_port: STATS_PORT,
    },
    // Which section each option belongs to, so the pill row groups exactly the way the Config tab
    // does. The pills used to key off the `trim_` prefix instead, which filed by_dashboard under
    // Trimming on one screen and on its own on the other — the same setting, two answers.
    optionSections: Object.fromEntries(
      Object.entries(OPTIONS).map(([k, o]) => [k, o.section]),
    ),
    allowlist: {
      ready: ALLOW_READY,
      union: ALLOW.size,
      instanceEntities: INSTANCE_ENTITIES,
      version: ALLOW_VERSION,
      // How many times the instance has been pulled to (re)build this. `version` only moves when
      // the result CHANGED, so a storm of no-op rebuilds is invisible in it; this is not.
      rebuilds: REBUILD_COUNT,
      byDashboard: Object.fromEntries([...ALLOW_BY_DASH].map(([d, s]) => [d, s.size])),
    },
    resources: {
      byDashboard: Object.fromEntries(RESOURCE_STATS),
      // Dropped by EVERY dashboard: either genuinely unused (uninstall it) or a resident module
      // about to go quietly inert (pin it). The add-on cannot tell those apart; a person can.
      droppedByAll: RESOURCE_DROPPED_ALL,
      droppedByDashboard: Object.fromEntries(RESOURCE_DROPPED_BY_DASH),
      // Card types that will NOT render, proven rather than guessed — the file that literally
      // defines them was dropped. `unmetCoverage` says how much of the question is answerable:
      // cards whose bundle builds the element name at runtime cannot be checked at all.
      // Modules Home Assistant injects into the page itself. `kept` is the important half: those
      // are the ones this add-on deliberately will not judge, so if a panel has lost a behaviour
      // the answer is either in `removed` or nowhere in this add-on at all.
      extraModulesByDashboard: Object.fromEntries(EXTRA_MODULES_BY_DASH),
      unmetByDashboard: Object.fromEntries(RESOURCE_UNMET_BY_DASH),
      unmetCoverage: RESOURCE_UNMET_COVERAGE,
      alwaysForward: RES_ALWAYS.map((r) => r.literal ?? String(r.re)),
    },
  };
}

// Is this request arriving through Home Assistant's Ingress, rather than straight at the port?
//
// This is a security boundary, not a convenience. The stats server binds every interface — that is
// how `http://<host>:8100/stats.json` works from a laptop — and it has always been READ-ONLY, so
// an unauthenticated reader could learn only what the panel shows. A write endpoint on the same
// server would let anyone on the LAN change this add-on's configuration.
//
// Ingress requests are proxied by Supervisor, which authenticates the Home Assistant user first
// and stamps `X-Ingress-Path`. Requiring both that header and the Supervisor source address means
// a write can only originate from someone Home Assistant already logged in.
// Refuse a read that did not come through Ingress, and say why.
//
// The management server binds every interface, so these are reachable by anything on the network
// — including the IoT VLAN the panels live on. Writes were gated from the start; reads were not,
// on the reasoning that statistics are harmless. They are not:
//
//   * /access.json is a request log, and Home Assistant puts credentials in PATHS as well as in
//     query strings. Measured on a live instance: 2 webhook ids, 37 HLS stream tokens and 4
//     signed camera-proxy paths sitting in the ring. A webhook id is a bearer credential — anyone
//     who knows one can POST to it with no authentication and fire whatever it drives.
//   * /entities.json and /devices.json are a complete inventory of the house, by name.
//   * /config.json carries the override rules, which name Home Assistant users.
//   * /stats.json names every connected client: address, resolved user, User-Agent, internal
//     hostname and mDNS device name.
//
// Query strings were already stripped from the log, which is why the JWT in ?authSig= never
// reached it. Paths were not, and that is the half that mattered.
// Everything in a snapshot that names a person, a machine or a network, removed.
//
// Counts and byte totals are kept, because that is what a health check and a dashboard card are
// actually for. The per-client list becomes a number: "6 connected" is the useful part, and
// "10.2.4.129, Kiosk Satellite, Office Test Panel, home-iot.coulson.io" is the part that has no
// business being readable by the network the panels sit on.
function redactForNetwork(snap) {
  const out = { ...snap, redacted: true };
  out.clients = {
    open: snap.clients?.open ?? 0,
    total: snap.clients?.total ?? 0,
    list: [],
    recent: [],
  };
  // Active pauses name a Home Assistant user, so they follow the same rule as every other
  // identity here. That trimming is paused at all is NOT hidden — a health check should be able
  // to see it, and it is the whole point of the reminder — only who it is for.
  if (Array.isArray(snap.pauses)) out.pauses = snap.pauses.map((p) => ({ until: p.until, msLeft: p.msLeft }));
  // Discovered devices are names and addresses of things on the network, by definition.
  if (out.mdns) out.mdns = { available: snap.mdns.available, services: [], devices: [] };
  // Hop names resolve to internal hostnames.
  if (out.routeNames) delete out.routeNames;
  // The routing breakdown behind the Sankey: every flow carries the hostname a client reached the
  // proxy on, and byHost is keyed BY those names. Found by grepping the live payload for known
  // internal names rather than by reasoning about the field list — which is the only way this
  // kind of miss gets caught, and why the test does the same.
  if (out.paths) delete out.paths;
  // The translations breakdown is keyed by integration — `component.tuya_local`, `component.hue`
  // — which is a list of what is installed in the house. The counts and size stay, since that is
  // what the diagnostic is for; the per-integration keys do not.
  if (out.translations && typeof out.translations === 'object') {
    const { byPrefix, ...rest } = out.translations;
    out.translations = rest;
  }
  // Dashboard names and installed-card paths are deliberately KEPT. They are configuration, not
  // identity: no person, machine or credential is named by them, and anyone who can load a
  // dashboard already sees both. Stripping them bought nothing and cost the health sensor the
  // detail it reports.
  return out;
}

// What each option RESOLVED to, for the console to show when no source has set it.
//
// The console reported the raw option value, which is undefined for anything unset — so on a
// standalone container, where everything comes from the environment, every switch rendered off
// while `trim_entities` was plainly on. Add-on installs are only partly spared: Supervisor fills
// in defaults for required keys but omits the optional ones (`bool?` in the schema), so
// `mdns_discovery` and its kind showed off on every install that had never touched them.
// These are the same constants the proxy runs on, so what the console shows is what is true.
function effectiveFallback() {
  const envJson = (name) => { try { return process.env[name] ? JSON.parse(process.env[name]) : []; } catch { return []; } };
  return {
    trim_entities: STRIP, by_dashboard: PER_DASH, trim_registries: TRIM_REGISTRIES,
    compress_websocket: COMPRESS_WS, trim_resources: TRIM_RESOURCES,
    trim_extra_modules: TRIM_EXTRA_MODULES, trim_services: TRIM_SERVICES, trim_repairs: TRIM_REPAIRS,
    trim_themes: TRIM_THEMES, trim_translations: TRIM_TRANSLATIONS,
    mdns_discovery: MDNS_ENABLED, esphome_api: ESPHOME_API, client_api_access: CLIENT_API_ACCESS,
    dashboards: DASH_PATHS,
    always_forward: toList(process.env.ALWAYS_FORWARD),
    never_forward: toList(process.env.NEVER_FORWARD),
    always_forward_device_class: toList(process.env.ALWAYS_FORWARD_DEVICE_CLASS),
    exclude_device_categories: EXCLUDE_DEVICE_CATEGORIES,
    resources_always_forward: toList(process.env.RESOURCES_ALWAYS_FORWARD),
    resources_never_forward: toList(process.env.RESOURCES_NEVER_FORWARD),
    // Raw, not the resolved default set: an empty list here means "the built-in set", which is
    // what the row's emptyMeans text explains.
    mdns_services: toList(process.env.MDNS_SERVICES),
    cert_monitor_host: CERT_HOST,
    client_api_allow: toList(process.env.CLIENT_API_ALLOW),
    overrides: envJson('OVERRIDES'),
    dashboard_overrides: envJson('DASHBOARD_OVERRIDES'),
    user_overrides: envJson('USER_OVERRIDES'),
    client_overrides: envJson('CLIENT_OVERRIDES'),
    user_agent_dashboards: envJson('UA_DASHBOARDS'),
  };
}

// Whether a Home Assistant user is an administrator. Ingress says WHO is asking (the
// X-Remote-User-* headers) but not their role, and `panel_admin: false` lets every user open this
// console, so a request that acts on more than its own caller has to ask. Admin is the
// `system-admin` group (or the owner), which is Home Assistant's own definition and the one
// behind `is_admin` in auth/current_user. Cached briefly: one console click should not cost a
// websocket round trip per request, and a demotion still reaches here within a minute.
// Fails CLOSED: no control connection, or a failed lookup, is "not shown to be an admin".
const ADMIN_LOOKUP_TTL_MS = 60 * 1000;
let ADMIN_LOOKUP = { at: 0, admins: null };
// One lookup at a time, shared, as resolveUser does with USER_INFLIGHT: the console fires several
// requests at once when it loads, and each one asked Home Assistant separately.
let ADMIN_INFLIGHT = null;
function adminIds() {
  if (ADMIN_LOOKUP.admins && Date.now() - ADMIN_LOOKUP.at <= ADMIN_LOOKUP_TTL_MS) return Promise.resolve(ADMIN_LOOKUP.admins);
  if (!CONTROL_RPC) return Promise.resolve(null);
  ADMIN_INFLIGHT ??= CONTROL_RPC({ type: 'config/auth/list' })
    .then((users) => {
      const admins = new Set();
      for (const u of Array.isArray(users) ? users : []) {
        const groups = Array.isArray(u?.group_ids) ? u.group_ids : [];
        if (u?.id && (u.is_owner === true || groups.includes('system-admin'))) admins.add(String(u.id).toLowerCase());
      }
      ADMIN_LOOKUP = { at: Date.now(), admins };
      return admins;
    })
    .catch((e) => {
      logThrottled('admin-lookup', `could not check who is an administrator (${e.message}) — refusing requests that need it`);
      return null;
    })
    .finally(() => { ADMIN_INFLIGHT = null; });
  return ADMIN_INFLIGHT;
}
async function userIsAdmin(userId) {
  const id = String(userId || '').trim().toLowerCase();
  if (!id) return false;
  return Boolean((await adminIds())?.has(id));
}

// For console requests that act on everyone or read what only an administrator should see: the
// request log, configuration writes, pins. As an add-on Supervisor always names the caller, and
// only an administrator passes. A standalone run has no Ingress and no identity: what reaches the
// gate there is loopback (see INGRESS_PEERS), the operator's own machine, so there is no one to
// check. A NAMED caller is always checked, whichever mode this is.
async function callerMayAdminister(req) {
  const id = String(req.headers['x-remote-user-id'] || '').trim();
  if (!id) return !inAddon;
  return userIsAdmin(id);
}

const refuseNotAdmin = (res, what) => {
  res.writeHead(403, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: `only a Home Assistant administrator can ${what}` }));
};

function requireIngress(req, res, what) {
  if (viaIngress(req)) return false;
  // Once per caller and endpoint, then debug. The console polls these every 60 seconds, and the
  // throttle window is 10 — so a single page left open on the direct port wrote two lines a
  // minute for as long as it stayed open, which is the noise class the rest of this file was just
  // cleaned of. The refusal itself is unchanged; only the repetition is.
  const denial = `refused ${what} from ${clientIp(req) ?? '?'} — open it from the Home Assistant sidebar`;
  if (onceOnly(`read-denied:${what}:${clientIp(req) ?? '?'}`)) log(denial); else debug(denial);
  res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({
    error: 'this endpoint is only readable through Home Assistant Ingress',
    hint: 'open the panel from the Home Assistant sidebar',
  }));
  return true;
}

// Who may speak for Ingress. The header is the client's to write, so the PEER is the whole check.
//
// As an add-on that is Supervisor and nothing else: 172.30.32.2, fixed by Supervisor's own network
// layout. This used to accept all of 172.30.32.0/24 plus loopback, and under host_network loopback
// is every host-network process on the machine — Home Assistant, Node-RED, the SSH add-on, a dozen
// others on a typical install. Any of them could send `X-Ingress-Path` to 127.0.0.1:9122 and pause
// trimming for anyone or rewrite the console's configuration (found in a review on 2026-10-02).
// Loopback stays for a standalone run, where it is the developer's own machine and the tests'.
const INGRESS_PEERS = new Set(
  (process.env.INGRESS_PEERS ? process.env.INGRESS_PEERS.split(',') : inAddon ? ['172.30.32.2'] : ['127.0.0.1', '::1'])
    .map((s) => s.trim()).filter(Boolean));

function viaIngress(req) {
  if (!req.headers['x-ingress-path']) return false;
  return INGRESS_PEERS.has(normalizeIp(req.socket?.remoteAddress) || '');
}

// Append one value to a list option, writing to WHICHEVER SOURCE CURRENTLY OWNS IT.
//
// There are two places an option can live — Supervisor's options.json and the console's
// config store in /data — and effectiveOptions() lets the store win. This used to write to
// Supervisor unconditionally, so once `always_forward` had been taken over in the console a pin
// landed in the source that was being shadowed: it applied for the rest of the process's life,
// then vanished at the next restart, with both the log and the panel having said "pinned".
//
//   * managed by the console  -> the store, whatever mode this is running in
//   * an add-on, not managed  -> Supervisor, so the Configuration tab stays authoritative
//   * standalone, not managed -> the store, seeded from what is in effect right now. That makes
//                                the key console-managed from here on, which is honest: there is
//                                no other writable source, and the env var still seeds it.
//
// Supervisor writes are read-modify-write rather than a blind set: the options object holds
// every setting the user has, and writing only this field would silently discard the rest.
// One at a time: two pins in flight would each read the same options and the second write would drop the first.
let pinChain = Promise.resolve();
function appendToListOption(...args) {
  const run = pinChain.then(() => appendToListOptionNow(...args));
  pinChain = run.catch(() => {});
  return run;
}
async function appendToListOptionNow(key, value, envName) {
  const managed = ownership(YAML_OPT, CONFIG_STORE).managed.includes(key);
  if (inAddon && !managed) {
    const headers = { Authorization: `Bearer ${process.env.SUPERVISOR_TOKEN}`, 'content-type': 'application/json' };
    const cur = await (await fetch('http://supervisor/addons/self/info', { headers, signal: AbortSignal.timeout(8000) })).json();
    const options = { ...(cur?.data?.options ?? {}) };
    const list = Array.isArray(options[key]) ? [...options[key]] : [];
    if (list.includes(value)) return { already: true, list, source: 'addon' };
    list.push(value);
    options[key] = list;
    const res = await fetch('http://supervisor/addons/self/options', {
      method: 'POST', headers, body: JSON.stringify({ options }), signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`supervisor returned ${res.status}`);
    return { already: false, list, source: 'addon' };
  }
  if (!CONFIG_DIR) throw new Error('nowhere to save this: not running as an add-on and no /data volume is mounted');
  // The live store first — OPT is a boot-time snapshot and does not see a pin made a moment
  // ago — then the option as booted, then the env var, exactly as the boot-time parse reads it.
  const current = toList(CONFIG_STORE.managed[key] ?? OPT[key] ?? process.env[envName]);
  if (current.includes(value)) return { already: true, list: current, source: 'console' };
  const list = [...current, value];
  const next = adopt(CONFIG_STORE, key, list, YAML_OPT);
  writeStore(CONFIG_DIR, next);
  CONFIG_STORE = next;
  return { already: false, list, source: 'console' };
}

// Append a URL fragment to `resources_always_forward`.
const pinResource = (fragment) => appendToListOption('resources_always_forward', fragment, 'RESOURCES_ALWAYS_FORWARD');

// The entity equivalent of pinResource. A literal entity_id, not a pattern: the panel offers
// this from a search result, so the exact id is already known and a regex would be a way to get
// it wrong. `never_forward` still wins afterwards, as it does over everything.
const pinEntity = (entityId) => appendToListOption('always_forward', entityId, 'ALWAYS_FORWARD');

const statsServer = http.createServer(async (req, res) => {
  // Ingress rewrites the path prefix, so match on the tail rather than the whole URL.
  const path = String(req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
  // Pin a resource so every dashboard receives it. Ingress only — see viaIngress().
  if (path.endsWith('/pin-resource') && req.method === 'POST') {
    if (!viaIngress(req)) {
      logThrottled('pin-denied', `refused a resource pin from ${clientIp(req) ?? '?'} — writes are Ingress-only`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'writes are only accepted through Home Assistant Ingress' }));
    }
    if (!(await callerMayAdminister(req))) return refuseNotAdmin(res, 'pin a resource for every dashboard');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { fragment } = JSON.parse(body || '{}');
        // A fragment is matched as a substring against resource URLs, so an empty or
        // near-empty one would pin everything and quietly undo the whole feature.
        if (typeof fragment !== 'string' || fragment.trim().length < 3) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'fragment must be at least 3 characters' }));
        }
        const out = await pinResource(fragment.trim());
        let live = false;
        if (!out.already) {
          RES_ALWAYS.push({ literal: fragment.trim() });
          if (requestRecompute) { requestRecompute(`pinned resource ${fragment.trim()}`); live = true; }
        }
        log(`resource pinned via panel: ${fragment.trim()}${out.already ? ' (already present)' : ''}`
          + `${live ? ' — rebuilding now' : ' — restart to apply'}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...out, applied: live, restartRequired: !out.already && !live }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  // Search devices by name, for the console's picker. Read-only like /entities.json, and it
  // carries the entity COUNT rather than the entity ids: naming a device in a rule is a decision
  // about how much it pulls in, and the ids themselves are what the picker exists to avoid
  // making anyone type.
  if (path.endsWith('/devices.json')) {
    if (requireIngress(req, res, '/devices.json')) return;
    const u = new URL(req.url, 'http://x');
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
    const matches = [];
    for (const d of ALL_DEVICES) {
      if (q && !d.name.toLowerCase().includes(q)) continue;
      matches.push(d);
      if (matches.length >= limit) break;
    }
    const body = JSON.stringify({ query: q, total: ALL_DEVICES.length, shown: matches.length, matches });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  // Search every entity on the instance, flagging which the union allowlist already carries.
  // Read-only, so it is not behind the Ingress gate that writes are.
  if (path.endsWith('/entities.json')) {
    if (requireIngress(req, res, '/entities.json')) return;
    const u = new URL(req.url, 'http://x');
    const q = (u.searchParams.get('q') || '').trim().toLowerCase();
    const limit = Math.min(Number(u.searchParams.get('limit')) || 50, 200);
    const matches = [];
    for (const [id, name] of ALL_ENTITIES) {
      if (q && !id.toLowerCase().includes(q) && !(name || '').toLowerCase().includes(q)) continue;
      matches.push({ entity_id: id, name, kept: ALLOW.has(id) });
      if (matches.length >= limit) break;
    }
    const body = JSON.stringify({
      query: q, total: ALL_ENTITIES.length, shown: matches.length, matches,
      // So the panel can say "already pinned" rather than offering the button twice.
      pinned: ALWAYS.map((r) => r.literal).filter(Boolean),
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  // Always-forward one entity. Ingress only, exactly like /pin-resource.
  // What each option is set to, and which source is answering for it.
  if (path.endsWith('/config.json')) {
    if (requireIngress(req, res, '/config.json')) return;
    const own = ownership(YAML_OPT, CONFIG_STORE);
    const eff = effectiveOptions(YAML_OPT, CONFIG_STORE);
    // The declared catalogue first, so an option nobody has set yet is still offered — that is
    // the one someone came here to set. Anything else already present is appended, so a key this
    // build does not know about is still visible rather than silently dropped.
    const keys = [...new Set([
      ...Object.keys(EDITABLE_KEYS), ...Object.keys(eff), ...own.managed,
    ])]
      // Setup options live in the add-on configuration and nowhere else. Listing them here, even
      // greyed out, put the same setting in two places and invited the question of which one is
      // real — and the answer would have been "the one you are not looking at".
      .filter((k) => !BOOTSTRAP_KEYS.has(k))
      // A renamed option keeps working but does not get a row: listing both spellings showed two
      // rows for one setting, with the value on whichever one the config happened to use.
      .filter((k) => !LEGACY_KEYS.has(k))
      // Declared order, not alphabetical. Within a section the order is editorial: the core
      // switch first and the lossy ones last, which alphabetical actively destroys -- it opened
      // the trim list with "Only the dashboard being viewed" and buried "Entity websocket".
      // Anything not in the catalogue keeps a stable place at the end.
      .sort((a, b) => {
        const order = Object.keys(OPTIONS);
        const ia = order.indexOf(a), ib = order.indexOf(b);
        if (ia === -1 && ib === -1) return a < b ? -1 : a > b ? 1 : 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    const fallback = effectiveFallback();
    const body = JSON.stringify({
      // Writable only when the store has somewhere to live. Without /data every save would be
      // lost on restart, and a console that silently forgets is worse than one that says it is
      // read-only.
      writable: Boolean(CONFIG_DIR),
      // Whether THIS request could write, as opposed to whether the add-on can write at all.
      // Writes are Ingress-only, and the panel is also served on its own port — where every
      // control would otherwise render as editable and then fail with a 403 on click. The page
      // is told, so it can say "open this through Home Assistant" instead of setting a trap.
      editableHere: viaIngress(req) && await callerMayAdminister(req),
      // Why not, when it is not: through Ingress but not an administrator is a different message
      // from "you are on the app's own port".
      ingress: viaIngress(req),
      storePath: CONFIG_DIR ? `${CONFIG_DIR}/config.json` : null,
      // Named, though not listed as rows, so the console can explain where they DO live if
      // someone comes looking for one.
      bootstrap: [...BOOTSTRAP_KEYS],
      sections: SECTIONS,
      options: keys.map((k) => ({
        key: k,
        // Read through the old spelling too, or a config that predates a rename leaves the
        // canonical row blank while the setting is plainly in effect — and when neither source
        // has set it, what the proxy actually resolved it to (see effectiveFallback).
        value: eff[k] !== undefined ? eff[k]
          : eff[legacyNameFor(k)] !== undefined ? eff[legacyNameFor(k)]
          : fallback[k],
        type: isKnownOption(k) ? EDITABLE_KEYS[k] : null,
        section: OPTIONS[k]?.section || null,
        // What an empty value means, when that is not simply "empty".
        choices: OPTIONS[k]?.choices || null,
        emptyMeans: OPTIONS[k]?.emptyMeans
          ? (k === 'mdns_services' ? `the built-in set (${DEFAULT_SERVICES.join(', ')})` : OPTIONS[k].emptyMeans)
          : null,
        label: OPTIONS[k]?.label || k,
        // The console draws booleans as tiles; these are the caption and the glyph for one.
        short: OPTIONS[k]?.short || null,
        icon: OPTIONS[k]?.icon || null,
        source: own.managed.includes(k) ? 'console' : 'addon',
        editable: isKnownOption(k) && !BOOTSTRAP_KEYS.has(k),
      })),
    }, null, 2);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }

  // Take over an option, change one already taken over, or hand it back. Ingress only, exactly
  // like the pins below: this writes configuration.
  // ---- pause / resume the trim, for the Home Assistant user asking ----
  //
  // WHO is taken from Supervisor's Ingress headers, never from the request body. Supervisor
  // authenticates the Home Assistant user and stamps `X-Remote-User-Id` before this add-on sees
  // anything, so a person can only ever pause their OWN trim — there is no field to put someone
  // else's id in. The one group target, `scope: 'admins'`, and resuming anyone but yourself both
  // need an administrator (userIsAdmin): this console is open to every user, and either one acts
  // on other people's sessions.
  //
  // The id, not the display name: the bridge resolves identity through `auth/current_user`,
  // which returns the same id, and a display name is editable and can collide.
  if (path.endsWith('/pause') && req.method === 'POST') {
    if (!viaIngress(req)) {
      logThrottled('pause-denied', `refused a pause from ${clientIp(req) ?? '?'} — writes are Ingress-only`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'writes are only accepted through Home Assistant Ingress' }));
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', async () => {
      try {
        const id = String(req.headers['x-remote-user-id'] || '').trim();
        const name = String(req.headers['x-remote-user-display-name'] || req.headers['x-remote-user-name'] || '').trim() || null;
        if (!id) {
          // Supervisor supplies these; their absence means this did not arrive the way it looks
          // like it did. Refuse rather than guess an identity.
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Home Assistant did not say who you are — open the panel from the sidebar' }));
        }
        const { preset, tzOffset, scope } = JSON.parse(body || '{}');
        const ms = preset === 'day' ? msUntilEndOfDay(tzOffset) : 3600000;
        // `scope: 'admins'` pauses the role instead of the person — the same thing the Home
        // Assistant switch does (setAdminPause), and it tells the switch at once, below. What it grants
        // is what Home Assistant would already hand those tokens, minus this app's filtering, so
        // it exposes no data. But it acts on every administrator's session, and this console is
        // open to every user (panel_admin: false), so only an administrator may ask for it.
        // Anyone may pause their own. (Codex review, 2026-10-10.)
        if (scope === 'admins' && !(await callerMayAdminister(req))) return refuseNotAdmin(res, 'pause trimming for every administrator');
        const target = scope === 'admins' ? ADMINS : id;
        PAUSES = pauseUser(PAUSES, target, ms, {
          name: scope === 'admins' ? 'administrators' : name,
          by: name || id,
        });
        try { writePauses(CONFIG_DIR, PAUSES); } catch (e) { warn(`pause: could not persist (${e.message}) — it will not survive a restart`); }
        const until = pausedUntil(PAUSES, target);
        // Said at info, with an end time, because this is the add-on being asked to stop doing
        // the thing it exists for. Anyone reading the log later should find out why a panel was
        // slow for an hour without having to reason about it.
        log(`trim PAUSED for ${scope === 'admins' ? 'ADMIN users' : (name || id)} `
          + `until ${new Date(until).toISOString()} `
          + `(${Math.round(ms / 60000)} min, requested from the console by ${name || id})`);
        // Their open connections are still on a trimmed subscription, and HA cannot amend one.
        // Dropping them is what makes the pause take effect on the page they are looking at.
        const dropped = recycleUser(pauseKey(target), 'trim paused');
        // As setAdminPause does: the admin switch, and trim_paused_for, should agree with the
        // console the moment it answers, not at the next sampling tick.
        esphomeSensors.push();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, user: target, name, until, msLeft: until - Date.now(), reconnected: dropped }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (path.endsWith('/resume') && req.method === 'POST') {
    if (!viaIngress(req)) {
      logThrottled('resume-denied', `refused a resume from ${clientIp(req) ?? '?'} — writes are Ingress-only`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'writes are only accepted through Home Assistant Ingress' }));
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', async () => {
      try {
        const asked = JSON.parse(body || '{}');
        const caller = String(req.headers['x-remote-user-id'] || '').trim();
        const id = String(asked.user || caller).trim();
        if (!id) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Home Assistant did not say who you are — open the panel from the sidebar' }));
        }
        // Ending your own pause is yours to do. Ending anyone else's, the administrators' pause
        // included, is the mirror image of pausing them, and is held to the same rule (the same
        // gate as configuration, so the two cannot disagree about who passes).
        if (id.toLowerCase() !== caller.toLowerCase() && !(await callerMayAdminister(req))) {
          return refuseNotAdmin(res, "end someone else's pause");
        }
        const had = pausedUntil(PAUSES, id);
        PAUSES = resumeUser(PAUSES, id);
        try { writePauses(CONFIG_DIR, PAUSES); } catch (e) { warn(`pause: could not persist resume (${e.message})`); }
        let dropped = 0;
        if (had) {
          log(`trim resumed for ${id} (ended early from the console)`);
          dropped = recycleUser(pauseKey(id), 'pause ended');
          esphomeSensors.push();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, user: id, wasPaused: Boolean(had), reconnected: dropped }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (path.endsWith('/config') && req.method === 'POST') {
    if (!viaIngress(req)) {
      logThrottled('config-denied', `refused a config write from ${clientIp(req) ?? '?'} — writes are Ingress-only`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'writes are only accepted through Home Assistant Ingress' }));
    }
    if (!(await callerMayAdminister(req))) return refuseNotAdmin(res, 'change the configuration');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try {
        if (!CONFIG_DIR) {
          res.writeHead(409, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'no /data to write to — configuration is read-only here' }));
        }
        const { key, action, value } = JSON.parse(body || '{}');
        if (typeof key !== 'string' || !key) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'key is required' }));
        }
        if (BOOTSTRAP_KEYS.has(key)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({
            error: `"${key}" decides how the app starts and reaches Home Assistant, so it is always read from the add-on configuration — it has to stay fixable when this console is what is broken`,
          }));
        }
        // Only options this build knows about. Without this the store would happily accept a
        // typo'd key, write it, and report it back as managed — a setting that looks saved and
        // does nothing, which is the exact failure this whole ownership scheme exists to avoid.
        if (!isKnownOption(key)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: `"${key}" is not an option this version knows about` }));
        }
        // Checked here, where the console can say so, rather than at the next boot, after it had
        // already reported success: `!!"false"` is true, so a string where a boolean belongs
        // silently turned on the very thing it was meant to turn off.
        const bad = action === 'release' ? null : valueError(key, value);
        if (bad) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: `"${key}" ${bad}` }));
        }
        const next = action === 'release'
          ? release(CONFIG_STORE, key)
          : adopt(CONFIG_STORE, key, value, YAML_OPT);
        writeStore(CONFIG_DIR, next);
        CONFIG_STORE = next;
        warn(`config: ${action === 'release' ? 'released' : 'set'} "${key}" via the console`
          + ' — restart the app to apply it');
        res.writeHead(200, { 'content-type': 'application/json' });
        // Honest about when it takes effect: every option is read once at startup, so a save here
        // changes the file and nothing else until the add-on restarts.
        return res.end(JSON.stringify({
          ok: true, key, source: action === 'release' ? 'addon' : 'console',
          note: 'saved — restart the app for it to take effect',
        }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (path.endsWith('/pin-entity') && req.method === 'POST') {
    if (!viaIngress(req)) {
      logThrottled('pin-denied', `refused an entity pin from ${clientIp(req) ?? '?'} — writes are Ingress-only`);
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'writes are only accepted through Home Assistant Ingress' }));
    }
    if (!(await callerMayAdminister(req))) return refuseNotAdmin(res, 'pin an entity for every dashboard');
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const { entity_id: id } = JSON.parse(body || '{}');
        // Must be a real entity_id, and one that actually exists: pinning a typo would sit in
        // the config forever matching nothing, which is indistinguishable from it not working.
        if (typeof id !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(id)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: 'not a valid entity_id' }));
        }
        if (ALL_ENTITIES.length && !ALL_ENTITIES.some(([e]) => e === id)) {
          res.writeHead(404, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: `no such entity on this instance: ${id}` }));
        }
        const out = await pinEntity(id);
        // Apply it now rather than at the next restart. The rule list is read on every rebuild,
        // so appending and asking for a recompute is the whole mechanism — and the rebuild path
        // already drops open dashboard connections when entities are ADDED, so panels pick the
        // entity up on their own reconnect without anyone touching them.
        let live = false;
        if (!out.already) {
          ALWAYS.push({ literal: id });
          if (requestRecompute) { requestRecompute(`pinned ${id}`); live = true; }
        }
        log(`entity pinned via panel: ${id}${out.already ? ' (already present)' : ''}`
          + `${live ? ' — rebuilding now' : ' — restart to apply'}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...out, applied: live, restartRequired: !out.already && !live }));
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  if (path.endsWith('/access.json')) {
    // The worst of them: this one carries webhook ids and stream tokens.
    if (requireIngress(req, res, '/access.json')) return;
    // Ingress is not enough: every user can open this console (panel_admin: false), and webhook
    // ids are bearer secrets that a non-admin cannot otherwise see.
    if (!(await callerMayAdminister(req))) return refuseNotAdmin(res, 'read the request log');
    const limit = Math.min(Number(new URL(req.url, 'http://x').searchParams.get('limit')) || 100, 500);
    const body = JSON.stringify(httpLog.snapshot({ limit }), null, 2);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (path.endsWith('/diagnostics.json')) {
    // One file a user can attach to a bug report. Admin-only because it carries dashboard configs
    // and entity ids; credentials are stripped by key, but the note below says to look anyway.
    if (requireIngress(req, res, '/diagnostics.json')) return;
    if (!(await callerMayAdminister(req))) return refuseNotAdmin(res, 'download diagnostics');
    const body = JSON.stringify({
      note: 'Generated by Strimmer. Credentials are removed by key name; read this before you post it.',
      generated: new Date().toISOString(),
      version: VERSION,
      node: process.version,
      options: redactDeep({ ...effectiveFallback(), ...OPT }),
      allowlist: {
        union: ALLOW.size,
        byDashboard: Object.fromEntries([...ALLOW_BY_DASH].map(([d, set]) => [d, [...set].sort()])),
      },
      askedButNotForwarded: Object.fromEntries([...ASKED_NOT_FORWARDED].map(([d, per]) => [d, Object.fromEntries(per)])),
      dashboards: redactDeep(Object.fromEntries(DASH_CONFIGS)),
      stats: redactForNetwork(stats.snapshot(statsExtras())),
    }, null, 2);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="strimmer-diagnostics.json"',
    });
    return res.end(body);
  }
  if (path.endsWith('/history.json')) {
    if (requireIngress(req, res, '/history.json')) return;
    const body = JSON.stringify(history.history());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  if (path.endsWith('/stats.json')) {
    // Deliberately NOT Ingress-only, unlike the reads above: monitoring polls this for a health
    // signal (the container's own HEALTHCHECK, Uptime Kuma, a `rest:` sensor someone set up), and
    // those fetches do not come through Ingress. Gating it wholesale would silently take them down,
    // which is exactly the failure this add-on caused once already by moving its port.
    //
    // So the aggregates stay public and the IDENTITIES do not. What a health check needs is
    // "is it up and is the allowlist built"; what it does not need is every client's address,
    // Home Assistant user, User-Agent, internal hostname and device name.
    // Identities need an ADMINISTRATOR on Ingress, not just Ingress: panel_admin is false, so every
    // household user reaches this console, and the clients list names everyone else, their
    // phones' addresses and User-Agents.
    const snap = stats.snapshot(statsExtras());
    const ingress = viaIngress(req);
    const admin = ingress && await callerMayAdminister(req);
    const out = admin ? snap : redactForNetwork(snap);
    // So the page can stop offering what this viewer would be refused (the admin pause, someone
    // else's resume, pins).
    out.viewer = { ingress, admin };
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(out, null, 2));
  }
  if (path === '/' || path.endsWith('/index.html')) {
    if (!PANEL_HTML) { res.writeHead(500, { 'content-type': 'text/plain' }); return res.end('panel.html missing'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(PANEL_HTML);
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});
// A stats port that will not bind is an inconvenience, NOT a reason to take the proxy down
// with it — the add-on's actual job is unaffected. Log it and carry on, unlike PORT below.
// Worth being explicit that Ingress goes with it: under host_network the panel is reached
// THROUGH this same listener, so a bind failure costs the panel and the JSON API both.
statsServer.on('error', (e) => {
  // The healthcheck probes this server. Without a word from here it fails, Docker marks the
  // container unhealthy, and the Supervisor watchdog restarts it in a loop — taking the proxy
  // down after all. "unbound" tells the probe there is nothing to probe and the process chose to
  // keep proxying; a dead process exits the container, which the watchdog sees on its own.
  if (!statsServer.listening) {
    try { fs.writeFileSync(STATS_PORT_FILE, 'unbound'); } catch {}
  }
  warn(`stats server could not start on :${STATS_PORT} (${e.message})`
  + ' — the panel and JSON API are unavailable, including over Ingress. Proxying is unaffected;'
  + ' set STATS_PORT (and ingress_port) to move it.');
});
// /tmp survives `docker restart`, so a port written by an earlier run would otherwise still be
// there for the healthcheck to probe if this run's server never starts. Cleared first; the
// listen callback writes the real port, and the error handler writes "unbound".
try { fs.rmSync(STATS_PORT_FILE, { force: true }); } catch {}
statsServer.listen(STATS_PORT, () => {
  // Publish the port the healthcheck should probe. Best-effort: a container whose /tmp is not
  // writable still proxies and still serves the panel, and failing the probe over that would be
  // a worse outcome than the unhealthy state it reports.
  try { fs.writeFileSync(STATS_PORT_FILE, String(STATS_PORT)); }
  catch (e) { warn(`could not write ${STATS_PORT_FILE} (${e.message}) — the container healthcheck will fail`); }
  const viaIngress = STATS_PORT === INGRESS_PORT;
  log(`stats panel on :${STATS_PORT}${viaIngress ? ' (ingress)' : ''} — JSON at :${STATS_PORT}/stats.json`);
  // Moving the port off the default is allowed and sometimes necessary, but Supervisor still
  // routes Ingress to `ingress_port`. Saying so here is the difference between a deliberate
  // choice and a sidebar panel that mysteriously stopped working.
  if (!viaIngress) {
    warn(`stats_port is ${STATS_PORT} but Ingress routes to ${INGRESS_PORT} — the sidebar panel`
      + ` will NOT work. Reach it directly at http://<host>:${STATS_PORT}/, or set stats_port back`
      + ` to ${INGRESS_PORT}.`);
  }
});

// 24h history. /data is the add-on's persistent volume, so a restart costs one 5-minute
// bucket rather than the whole day — which matters because the counters themselves reset.
// In dev there is no /data; the sampler still runs, it just keeps the window in memory.
const HISTORY_DIR = fs.existsSync('/data') ? '/data' : (process.env.HISTORY_DIR || null);
history.start(() => stats.snapshot(statsExtras()), HISTORY_DIR);
log(`history: sampling every ${history.INTERVAL_MS / 60000}min, keeping ${history.KEEP} buckets${HISTORY_DIR ? ` in ${HISTORY_DIR}` : ' (memory only)'}`);

// ---- boot ----
warn(`Strimmer v${VERSION} starting`);
// Anything the store had to say, now that logging exists.
for (const m of CONFIG_WARNINGS) warn(`  config: ${m}`);
// Which source answers for what. Without this, an option edited in the Configuration tab that
// the panel has taken over appears to do nothing, with no way to find out why.
{
  const own = ownership(YAML_OPT, CONFIG_STORE);
  if (own.managed.length) {
    log(`config: ${own.managed.length} option(s) managed in the panel (${own.managed.join(', ')});`
      + ' the rest come from add-on options. Editing a managed option in the Configuration tab'
      + ' has no effect until it is released back.');
  }
}
log(`mode: ${inAddon ? 'add-on' : 'dev'} | target ${HA_BASE} | allowlist via ${ALLOW_WS_URL}`);
// One line for the whole rule set, because 'my override does nothing' is the commonest
// complaint and the first thing worth knowing is whether it was parsed at all.
// Before anything can ask for a user: a restart should not make every session pay again.
loadUserCache();
// Same reason: a restart must not cost every panel its dashboard attribution.
loadClientDash();
log(`overrides: ${CONN_RULES.length} rule(s)`
  + (CONN_RULES.length ? ` — ${CONN_RULES.filter((r) => r.user).length} keyed to a user, `
      + `${CONN_RULES.filter((r) => r.role).length} to a role, `
      + `${CONN_RULES.filter((r) => r.client).length} to a device, `
      + `${CONN_RULES.filter((r) => r.dashboard).length} to a dashboard, `
      + `${CONN_RULES.filter((r) => r.userAgent).length} to a client app, `
      + `${CONN_RULES.filter((r) => r.mdnsKind).length} to a device kind, `
      + `${CONN_RULES.filter((r) => r.entrypoint).length} to an entry point, `
      + `${CONN_RULES.filter((r) => r.authProvider).length} to a sign-in method` : ''));
log(`options: by_dashboard=${PER_DASH} trim_registries=${TRIM_REGISTRIES} compress_websocket=${COMPRESS_WS} trim_resources=${TRIM_RESOURCES} trim_services=${TRIM_SERVICES}`);
// Listen FIRST, before HA is known to be reachable. The add-on and HA core restart together
// (host boot, a core update), and core can take minutes to answer — the proxy's job is to
// wait for it, not to exit. HTTP proxies through immediately (502 while HA is down, like any
// reverse proxy); /api/websocket is refused until the first allowlist lands, above.
// Keep-alive timeouts, because this normally sits behind a reverse proxy.
//
// Node closes an idle keep-alive connection after 5 seconds. nginx (and Nginx Proxy Manager,
// which is what fronts this on the instance it was built against) holds upstream keep-alives for
// 60. In that 55-second gap nginx can pick a socket Node has just closed and hand back a 502 —
// sporadic, unreproducible, and blamed on everything except the timeout that caused it.
//
// The rule is that the upstream's idle timeout must EXCEED the proxy's, and headersTimeout must
// exceed keepAliveTimeout or Node cuts the request off while still reading its headers.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
statsServer.keepAliveTimeout = 65000;
statsServer.headersTimeout = 66000;

server.listen(PORT, () => {
  warn(`HA trim-proxy listening on :${PORT}  ->  ${HA_BASE}`);
  DASH_PATHS.forEach((p) => log(`  open: http://<host>:${PORT}/${p}`));
  // Started after listen, never awaited: discovery is beside the request path, so a network
  // that filters multicast costs us a label and nothing else.
  if (MDNS_ENABLED) { discovery.start(); log(`  mDNS discovery on for ${MDNS_SERVICES.length} service type(s)`); }
  // Say which way this is set, either way. With the option off the add-on said NOTHING about
  // ESPHome, so "I turned it on, where is it?" had no answer in the log — and the answer that
  // time was that the console owned the option and was shadowing the add-on's own toggle.
  if (!ESPHOME_API) log('  ESPHome API: off (esphome_api) — no long-term metrics are published');
  if (ESPHOME_API) {
    // Failure here must never touch the proxy. The commonest one is the port already being held
    // — the add-on runs with host networking, so 6053 is the HOST's 6053 — and a panel that
    // stops loading dashboards because a metrics transport could not bind would be an absurd
    // trade. Say what happened, keep serving.
    esphomeSensors.start({
      snapshot: () => stats.snapshot(statsExtras()),
      extras: () => ({ rebuilds: REBUILD_COUNT, certDaysLeft: CERT_DAYS, trimming: STRIP }),
      onCommand: (on) => setAdminPause(!on, ADMIN_PAUSE_MS, 'the ESPHome switch'),
      port: ESPHOME_PORT,
      noiseKey: ESPHOME_KEY,
      // Advertised, because the add-on shares the host's network segment with Home Assistant, so
      // multicast reaches it and the device is offered rather than typed in.
      mdns: true,
    }).catch((e) => {
      log(`  ESPHome API: not started (${e.message})`
        + (/EADDRINUSE/.test(String(e.message)) ? ` — something else holds port ${ESPHOME_PORT}; set esphome_port` : ''));
    });
  }
  if (CERT_HOST) {
    // Hourly is plenty for a number measured in days, and it keeps a TLS handshake off the
    // per-minute publish path.
    const checkCert = () => certDaysLeft(CERT_HOST).then((d) => {
      if (d !== CERT_DAYS) log(`  certificate for ${CERT_HOST}: ${d === null ? 'unreadable' : `${d} days left`}`);
      CERT_DAYS = d;
    }).catch(() => {});
    checkCert();
    setInterval(checkCert, 3600000).unref?.();
  }
});
// A port we can't bind is a real config error (another add-on on :9123 — see issue #6) and
// worth exiting for; anything else the server surfaces is not worth dying over.
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
    console.error(`fatal: cannot listen on :${PORT} (${e.code}) — set the add-on's \`proxy_port\` option to a free port`);
    process.exit(2);
  }
  logThrottled(`server:${e.code || e.message}`, `server error ${e.message}`);
});

// ALLOW / ALLOW_READY are already set at the point the first allowlist is built, so this only
// logs. The catch is not dead code: connect() runs synchronously inside the promise executor,
// so a malformed `allow_ws_url` throws `Invalid URL` right here — a config error worth dying
// on, but with a message rather than a raw stack.
startController()
  .then(() => warn(`union allowlist for [${DASH_PATHS.join(', ')}]: ${ALLOW.size} entities (strip_entities=${STRIP})`))
  .catch((e) => { console.error('fatal: cannot start the control connection:', e.message); process.exit(2); });

// ---- shutdown ----
//
// The Supervisor stops an add-on with SIGTERM, and Node's default response is to die on the spot:
// no exit handlers, no pending writes. Everything below exists because a restart is the one event
// this app has to be good at — it is restarted by every config change and every rebuild, and each
// restart is a window in which a panel that reconnects before it re-fetches its page falls back to
// the union allowlist.
//
// Two things were being lost to that abrupt exit, and neither announced itself:
//
//   * the debounced client hints — up to five seconds of "this panel is on that dashboard",
//     dropped precisely when the restart that needs them is under way;
//   * the compile cache — Node writes it from an exit hook, and an unhandled signal runs no exit
//     hooks, so the cache was never written at all and every boot recompiled from source.
//
// Note what fixes the second one: handling the signal and calling process.exit(0), which runs the
// exit hooks. An explicit module.flushCompileCache() here would be redundant — measured, both
// ways write the same two files — and worse, it would suggest the flush is what matters rather
// than the clean exit.
let shuttingDown = false;
function shutdown(sig) {
  // A second signal means the operator is not waiting any longer.
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  warn(`${sig}: shutting down`);

  if (flushClientDash()) log('  client hints written');

  // Stop taking new work. Open websockets are long-lived by design, so waiting for connections to
  // drain would just mean waiting for the Supervisor's SIGKILL — the listeners close, the sockets
  // go with the process.
  try { server.close(); statsServer.close(); } catch { /* already down */ }
  if (MDNS_ENABLED) { try { discovery.stop(); } catch { /* already down */ } }

  // Unref'd: if the event loop empties first, exit then instead of sitting out the delay.
  setTimeout(() => process.exit(0), 250).unref?.();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
