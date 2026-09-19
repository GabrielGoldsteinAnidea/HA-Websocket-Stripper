# HA WebSocket Stripper — project context

## What this is / why it exists

Home Assistant Lovelace dashboards on a large instance (here ~3,600 entities) load
slowly because, at startup, the frontend pulls **every** entity over the websocket
(`get_states` + a full `subscribe_entities`) plus the entity/device/area registries, on
top of the frontend JS bundles and every HACS custom-card module.

For wall-panel / kiosk dashboards (a fridge screen, etc.) that only show a handful of
entities, that firehose is pure waste. This project makes those dashboards load fast
**without changing how they look**, by serving the *real* HA frontend through a reverse
proxy that trims the entity websocket to just the entities each dashboard uses.

### Why this approach (history — don't re-litigate)

We first tried a lighter path: a long-poll backend + a hand-written **approximated**
renderer that redrew cards in plain HTML. It loaded fast but the owner wants
**pixel-perfect** fidelity, and re-implementing Mushroom/button-card/clock-weather/etc. is
a losing battle. So we pivoted to: **run HA's real frontend, just strip the websocket.**
That approximation approach was abandoned; this repo is the chosen direction.

A pure "reuse only the card-rendering JS" idea isn't viable: HA's core cards live inside
the compiled frontend bundle and can't be loaded standalone. The realistic way to get the
real cards + a trimmed subscription is this reverse proxy.

## Mechanism

HTTP: everything proxies straight to HA untouched (frontend bundles, `/auth/*`,
registries, `lovelace/config`, `/hacsfiles/*`, camera proxy, …).

WebSocket (`/api/websocket`): the proxy terminates the browser socket, opens its own
socket to HA, and relays both ways, modifying only:
- `subscribe_entities` with no filter → inject `entity_ids = <allowlist>` so HA streams
  only those entities (trims at the source);
- the `get_states` **result** → filtered to the allowlist.
- `subscribe_events` with `event_type: state_changed` (or no event_type) → events for
  non-allowlisted entities dropped (0.2.5, #19). HA **coalesces** queued messages into a JSON
  array frame once the client sends `supported_features`; array frames are filtered element by
  element for this path. Known gap: the `get_states`-result trim and the `subscribe_entities`
  re-filter still check `m.type` on the top-level frame only — a coalesced `get_states` result
  skips the trim. Fix = one per-message transform applied to each array element (planned before
  #13/#15 land).
- the browser leg negotiates `permessage-deflate` (`compress_websocket`, default on, 0.2.5 #14);
  `ws` disables it server-side by default, so before 0.2.5 the proxy *removed* compression HA
  would have provided.

Everything else (auth handshake, registry calls, config, events) passes through, so the
real frontend renders your real cards — just without the all-entities firehose. The
browser relays its own user token in the ws auth; the proxy doesn't touch auth.

**Only `/api/websocket` is intercepted.** Every *other* websocket upgrade is proxied
straight through to HA — notably `/api/webrtc/ws` (go2rtc / WebRTC + MSE camera-stream
signaling) and Assist-pipeline sockets. The original code `socket.destroy()`'d all
non-`/api/websocket` upgrades, which broke camera streams with ws close code 1006; the
upgrade handler now forwards them via `proxy.ws()`.

## Allowlist computation

Union, across all configured dashboards, of:
1. `extractEntities()` (`lovelace_extract.mjs`) — walks the card tree for entities in the
   standard keys (`entity`, `entities`, `entity_id`, `camera_image`, …) across **all
   views**, and expands `auto-entities` filter cards against live states + registries.
2. every **real** entity id that appears anywhere in the dashboard config text — catches
   ids referenced inside `button-card` / `mushroom-template` / `decluttering-card`
   templates that a structural walk can't parse.

Then `+ always_forward`, then `- never_forward` (never wins), then **group members**
(`expandGroupMembers`, transitive via `attributes.entity_id`). Members must exist in `get_states`
(0.2.5, #12 — disabled members otherwise inflate the count by a third on Hue-heavy instances).
Also: any string value on a card that is a **registered device id** expands to that device's
enabled entities (`resolveDeviceIds`, 0.2.5, #20) — cards like `ha-bambulab-*` / `whisker-card`
are configured with a device, not entities. Over-inclusion is harmless
(still tiny vs the instance); under-inclusion makes a card show "unavailable".

### auto-entities filter resolution (`condTests` / `toMatcher`)

`toMatcher()` is a deliberate port of auto-entities' own `src/match.ts` — keep it that way
rather than inventing semantics. A `/regex/` is used **unanchored** (the author supplies
`^`/`$`); a `*` glob is anchored; otherwise exact equality; regex is OR'd with exact match.
It applies to **every** filter key, which is what upstream does — that was issue #10.

Supported keys: `entity_id`, `domain`, `area`, `label`, `device`, `integration`, `name`
(vs `friendly_name`), `group`, `template`, `state`/`attributes` (volatile → over-included).
Values may also arrive in HA's selector object form `{ custom: …, active_choice: 'custom' }`;
`coerceVal` uses `active_choice` to pick the real key. Still unsupported: `not`/`and`/`or`,
`floor`, `device_manufacturer`, `device_model`, `last_changed`.

`filter: template:` is rendered over the control ws (`collectTemplates` → `render_template`
→ real ids scraped from the output). Note `render_template` is a **subscription**: HA answers
`result: null` then pushes events, so `renderTemplate()` takes the first event and
unsubscribes. Don't route it through `rpc()`, which resolves on `result`.

## Files

- `websocket-stripper/ha_ws_trim_proxy.mjs` — the proxy (HTTP passthrough + ws intercept + allowlist precompute).
- `websocket-stripper/lovelace_extract.mjs` — the card-tree entity extractor.
- `websocket-stripper/config.yaml` / `Dockerfile` / `package.json` — HA add-on packaging.
  Dockerfile copies the lockfile and runs `npm ci` (0.2.5, #23) — a dependency change needs
  `npm install` locally to update `package-lock.json` or the image build fails.
- `websocket-stripper/DOCS.md` — add-on Documentation tab (option reference).
- `repository.yaml` — lets HA add this GitHub URL as an add-on repository.
- `README.md` — install + dev-run.

## Run modes (auto-detected)

- **Add-on** (`SUPERVISOR_TOKEN` present): reads `/data/options.json`; precomputes the
  allowlist via the supervisor proxy `ws://supervisor/core/websocket` using
  `SUPERVISOR_TOKEN` (no long-lived token needed); proxies to `http://homeassistant:8123`.
- **Dev/CLI**: reads env (`HA_TOKEN`, `HA_BASE`, `DASH_PATHS`, `ALWAYS_FORWARD`,
  `NEVER_FORWARD`, `TRIM`, `PORT`). Verified working against the live HA from a dev box.

Dev run:
```bash
cd websocket-stripper && npm install
HA_TOKEN="<token>" HA_BASE="http://homeassistant.mgmt:8123" \
  DASH_PATHS="fridge-status,home-status,dashboard-deck" node ha_ws_trim_proxy.mjs
# open http://localhost:8099/fridge-status
```

## Environment specifics

- HA instance: `http://homeassistant.mgmt:8123` (also `192.168.4.2` = the HA host itself).
  The HA host is the only always-on machine, so production = this add-on running on it.
- This ships as its **own standalone add-on with its own port** (8099), independent of any
  other add-on on the host.
- Target dashboards (storage mode): `fridge-status` (views: fridge-main, weather, audio),
  `home-status` (views: Home, Home Std, Front Door Camera, Kids Cam — note: its Home view
  has malformed `auto-entities` keys like `"domain 1"` from the visual editor),
  `dashboard-deck`.
- Validated numbers: full instance ≈ 3,630 entities; union allowlist for the three
  dashboards ≈ 58. `get_states` confirmed trimmed 3630 → 58 through the proxy.

## Known caveats / open items

- **Frontend JS bundles still load** (cached after first visit). This targets the entity
  firehose, which is what scales with instance size — not first-ever bundle load.
- **Allowlist recomputes live on dashboard edits.** A persistent control ws (`startController`
  in `ha_ws_trim_proxy.mjs`) builds the allowlist at boot, then subscribes to HA's
  `lovelace_updated` event and rebuilds (debounced 1.5 s) on every dashboard save, with
  reconnect-on-drop. So editing a dashboard's cards no longer needs an add-on restart. A
  recompute still only affects **new** ws connections (HA can't amend a live
  `subscribe_entities`), so since 0.2.3 a rebuild that **adds** entities drops the open
  bridges — the frontend reconnects itself and re-subscribes, no manual kiosk reload.
  Removals deliberately don't churn connections. Adding a whole new dashboard to the
  `dashboards` option still needs a restart (options are read at boot). If the control ws
  can't reconnect, the proxy keeps serving the last-known allowlist.
- **Registries (entity/device/area) are not trimmed** yet — they pass through full. If
  load is still heavy after entity trimming, trimming/caching these is the next lever.
- **Reachability:** the add-on must resolve `http://homeassistant:8123`. `host_network: true`
  is now set (for trusted-network login, below), which can break the internal
  `homeassistant`/`supervisor` DNS names — the `ha_base` / `allow_ws_url` options pin them
  to IPs if startup fails (e.g. `ha_base: http://192.168.4.2:8123`).
- **armv7**: base image is `node:20-alpine` (multi-arch). Verify the build on the target
  arch; drop `armv7` from `config.yaml` `arch` if it doesn't build.
- **Auth through the proxy:** first load does a normal HA login against the proxy origin.
  If login loops/400s, the HA `http:` integration may need `use_x_forwarded_for` +
  `trusted_proxies` for the add-on's IP.
- **Trusted-network (password-less) kiosk login — CONFIRMED 2026-06-18:** for HA's
  `trusted_networks` provider to match the kiosk's real LAN IP, the add-on must run with
  `host_network: true`. Diagnosed live: with a *mapped* port, Docker rewrites every client
  to the gateway `172.30.32.1` before the proxy sees it, so `X-Forwarded-For` carries the
  gateway, not the browser. Proven by injecting XFF through `:8099` — only a hand-fed
  already-trusted IP produced a trusted login. Fix = `host_network: true` (now in
  `config.yaml`); HA then sees the proxied request from the **host itself**, so
  `trusted_proxies` needs `127.0.0.1`/`::1` (+ optionally the host LAN IP) and
  `trusted_networks` lists the kiosk subnet (kiosk observed on `192.168.5.0/24`). Keep a
  `type: homeassistant` provider alongside or you lose password login. Alternative without
  host_network: add `172.30.32.1/32` to `trusted_networks` (trusts ALL proxy traffic —
  acceptable only for a kiosk on a trusted LAN).
- **IPv4-mapped IPv6 in X-Forwarded-For — CONFIRMED FIXED 2026-06-18:** even with
  `host_network` correct and `trusted_proxies` loaded, trusted login still failed because
  Node reports dual-stack client IPs as IPv4-mapped IPv6 (`::ffff:192.168.5.247`), and HA's
  `trusted_networks` matches plain IPv4 subnets — a mapped address never matches an IPv4
  network, so it silently fell through to the password prompt. The proxy now normalizes
  `X-Forwarded-For` to bare IPv4 in a `proxyReq` handler (strips the `::ffff:` prefix) in
  `ha_ws_trim_proxy.mjs`. Diagnosed with a temporary `/__whoami` echo endpoint, since
  add-on logs aren't readable with a long-lived token (Supervisor returns 401). NOTE: a
  local add-on bakes code into the image at build time (`COPY` in the Dockerfile), so code
  changes need a **Rebuild**, not a Restart; config.yaml `host_network` also needs Rebuild,
  and `http:`/`auth_providers` need a full **Core restart** (not a YAML quick-reload).
- **Never flatten the X-Forwarded-For chain — CONFIRMED FIXED 0.2.3, verified live by a user
  behind Caddy.** The normalization above was originally written as
  `proxyReq.setHeader('x-forwarded-for', ip)`, which *replaced* the whole chain with our
  immediate peer. `http-proxy`'s `xfwd` **appends** our hop to XFF, XFP and X-Forwarded-Port,
  so with any upstream reverse proxy HA received XFF=1 entry and XFP=2, and
  `forwarded.py` raises `HTTPBadRequest` on
  `len(forwarded_proto) not in (1, len(forwarded_for))` → a hard **400 on every request**
  (issue #9). Normalize each entry **in place**; never rebuild the header from a single IP.
  Also note `proxy.ws()` does NOT fire `proxyReq` — the ws path needs its own `proxyReqWs`
  handler or upgrades silently keep the `::ffff:` form.
- **Redirects are rewritten by hand; `autoRewrite` is OFF — 0.2.4 (#9, #8).** `changeOrigin`
  makes HA emit absolute redirects naming `ha_base`; http-proxy's `autoRewrite` fixed the host
  but never the scheme, so behind a TLS terminator (Caddy/NPM/DuckDNS) the browser looped
  `https://host` -> `http://host` -> Caddy -> HA -> same redirect (`:8123./:8123./…`). A
  `proxyRes` handler (`rewriteLocation`) now rewrites scheme+host from the *first* entry of
  `X-Forwarded-Proto`/`X-Forwarded-Host` (xfwd appends our hop to Proto, so first wins), and
  also rewrites the absolute URL inside `redirect_uri` / `hass_url` query params — that one is
  what broke the companion app (#8), whose `homeassistant://` custom-scheme `redirect_uri` must
  pass through untouched. Only redirects pointing at HA or at the browser's host on the wrong
  scheme are touched; relative and third-party ones are left alone. Gotcha: `url.host = x`
  keeps the old port when `x` has none — set `hostname` and `port` separately (`setOrigin`).
  Tests: `test/proxy.redirect.test.mjs`.

## Security

A long-lived HA token was used during dev testing from the dev box; the add-on does not
need it (uses `SUPERVISOR_TOKEN`). Rotate any dev token when done.
