# Strimmer — project context

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
(`expandGroupMembers`, transitive via `attributes.entity_id`). Over-inclusion is harmless
(still tiny vs the instance); under-inclusion makes a card show "unavailable".

### auto-entities filter resolution (`condTests` / `toMatcher`)

`toMatcher()` is a deliberate port of **the auto-entities CARD's** `src/match.ts`
(thomasloven/lovelace-auto-entities — nothing to do with the upstream *proxy* repo, so forking
away from that changes nothing here). The card in the panel's browser uses that matcher to decide
what it shows, so what a pattern MEANS has to follow it, quirks included (`"! on"` parses NaN and
matches everything). What is ours to decide is which tests an ALLOWLIST applies — see
`makeMatcher`: structural keys first; else descriptive attribute tests alone (`device_class:
battery` beside `state: "< 20"` forwards every battery, because no state change ever rebuilds an
allowlist); only a purely live condition is resolved against current state. A `/regex/` is used **unanchored** (the author supplies
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

## The name

Renamed from **WebSocket Stripper** to **Strimmer** on 2026-09-19 — a strimmer trims, and it reads
as "stream trimmer". The fork had diverged far enough (183 commits ahead of
GabrielGoldsteinAnidea/HA-Websocket-Stripper, which has none of the console, config store, MQTT,
mDNS or resource-trimming code) that sharing a name misdescribed what is installed. Tagline: *cuts
what your panel never shows*.

Renamed with it: the add-on `slug` (`websocket_stripper` -> `strimmer`, so Supervisor treats it as
a new install with an empty `/data`), the folder, the MQTT node id and every sensor's unique_id
(long-term statistics start over — an accepted cost), the image name, and the panel.
The standalone Compose file renamed its volume (`stripper-data` -> `strimmer-data`), image and
service too, and Compose carries none of them over: the new volume starts empty and the old
container is left running as an orphan holding the ports. It is NOT being reverted, because by the
time that was noticed (2026-10-10, Codex review) installs had run three weeks on the new volume, and
reverting would strand them instead. `docs/MIGRATING.md` has the copy procedure, rehearsed on a
throwaway Compose project.

Deliberately NOT renamed, and each for a reason a rename would have cost something real:
- `/stripper/client.json` still answers beside `/strimmer/client.json`, and the status reply
  carries both a `strimmer` and a `stripper` key. ha-paneld and Kiosk Satellite were written
  against the old ones and must not break on an update they did not make.
- The panel's `localStorage` keys keep the `stripper-` prefix. They live in each viewer's browser;
  renaming them silently resets everyone's remembered tab, theme and columns for nothing.
- Old CHANGELOG entries keep the old name: they are a record of what it was called at the time.
- The GitHub repo was renamed too, `HA-Websocket-Stripper` -> **`HA-Strimmer`**, and every URL we
  own moved with it. GitHub redirects the old one, so the Supervisor store repository entry keeps
  resolving without being re-added. References to *GabrielGoldsteinAnidea*/HA-Websocket-Stripper
  are upstream's project and stay as they are, as does the LICENSE copyright.

## The console

The console (`strimmer/panel.html`) follows the look of Home Assistant's own settings pages: cards,
list rows with a secondary line, switches, text-labelled buttons. Five tabs — **Overview**
(health, four measured numbers, what is not being sent, the pause card, 24h history), **Dashboards**
(per-dashboard detail, entity search with pinning, resource tuning), **Clients** (accordion rows,
the Sankey of how clients arrive), **Settings** (the config editor), **Diagnostics** (the
diagnostics download, what the trim saved, what is flowing, HTTP, runtime).

**Reworked 2026-11-05.** Before this it copied Spatial Context's / Sextant's language (every button
an icon with a tooltip, a three-column header, a tile grid, popovers for pause and ⋮, a sortable
clients table). That was dropped on purpose and the reasons are the point of this section:
icon-only buttons were learnable only by hovering, which a phone cannot do; tiles hid what a setting
does behind a one-word caption; a popover hid the pause duration/scope choices; a 12-column table
does not fit a phone. The design mock and its rationale are in `docs/ui-rework/`. Do not put these
back without that argument being answered. **Spatial Context and Sextant are not the reference any
more; HA's settings UI is.**

What still holds, and is enforced:
- **Buttons carry text.** Build them ONLY with `btn(label, onclick, cls, icon)`. A glyph-only
  `iconBtn(icon, label, onclick)` is allowed for universal glyphs (theme switch, remove ×, delete) and
  must carry `aria-label` + `title`. `test/panel_buttons.test.mjs` fails on an unnamed button, on a
  button built elsewhere, and on text assigned into a button afterwards.
- **The constraint behind every decision: this console is an Ingress iframe.** It inherits no theme and
  has no HA web components. So HA's look is copied by reproducing VALUES: tokens are defined locally and
  aliased to HA's names (light = HA default, dark = HA dark, chosen by `prefers-color-scheme` or the
  header switch), glyphs are MDI paths masked in the element's colour (`ICONS`), the app icon is
  `assets/icon.svg` inlined as a data URI. Do not "fix" any of that to `<ha-icon>`; it renders nothing.
- **Honest numbers only.** The old "98.4% less data" headline cannot be computed: the entity event
  stream is cut at the source, so what it WOULD have been is never seen. Overview shows
  `savings.savedPct` labelled "Payload not sent (measured)" — before/after bytes on the answers the
  proxy actually trims — plus entities sent, clients open and the registry cache hit rate. Add a figure
  only if `/stats.json` measures it.
- **Viewer rules.** `VIEWER = { ingress, admin }` from `s.viewer`. `/config.json`, `/access.json`,
  `/history.json`, `/diagnostics.json` and `/entities.json` are Ingress-only (403 elsewhere; the
  `forbidden` set remembers it). Pause, pins, config and the diagnostics download need an administrator
  and are hidden, not shown-and-refused, for anyone else. Untrusted wire data goes in through
  `textContent` (`h()`), never `innerHTML`.
- **There is no restart button.** The proxy cannot restart its own app. A save whose note says
  "restart" shows a notice telling the person to do it from the app's page.
- **Settings shape:** every boolean is a switch row (caption from `OPTIONS[key].short`, one source),
  grouped What to trim / Extra trimming / Discovery & network; lists are chip editors under "What to
  send"; override rules and the remaining value options sit behind **Advanced**. A switch the console
  owns carries a dot and a "Use add-on setting" line hands it back (`configSwitch`, `handBack`).
  `config.test.mjs` still needs `s.optionSections` and the `inTrim` line in the panel.
- **`localStorage`:** keys keep the `stripper-` prefix (`stripper-theme`, `stripper-tab`). The old
  `stripper-clcols` (clients column picker) is no longer read or written.

**The `hidden` attribute loses to any author `display` rule.** Every element this page toggles
with `.hidden` needs a matching `[hidden] { display: none }` if its class sets `display` — the
pause banner shipped without one and showed an empty amber strip whenever nothing was paused.

## Files

- `strimmer/ha_ws_trim_proxy.mjs` — the proxy (HTTP passthrough + ws intercept + allowlist precompute).
- `strimmer/lovelace_extract.mjs` — the card-tree entity extractor.
- `strimmer/config.yaml` / `Dockerfile` / `package.json` — HA app packaging.
- `strimmer/DOCS.md` — app Documentation tab (option reference).
- `repository.yaml` — lets HA add this GitHub URL as an app repository.
- `README.md` — install + dev-run.
- `tools/make_icon.py` — regenerates the icon and README banner; its requirements (Pillow, and the
  ruff that CI lints with, configured in `ruff.toml`) are pinned in `tools/requirements.txt`.
- `.coderabbit.yaml` — PR review config; its path instructions restate this file's sharpest invariants.

## Run modes (auto-detected)

- **App** (`SUPERVISOR_TOKEN` present): reads `/data/options.json`; precomputes the
  allowlist via the supervisor proxy `ws://supervisor/core/websocket` using
  `SUPERVISOR_TOKEN` (no long-lived token needed); proxies to `http://homeassistant:8123`.
- **Dev/CLI**: reads env (`HA_TOKEN`, `HA_BASE`, `DASH_PATHS`, `ALWAYS_FORWARD`,
  `NEVER_FORWARD`, `TRIM`, `PORT`). Verified working against the live HA from a dev box.

Dev run:
```bash
cd strimmer && npm ci     # `ci`, not `install` — the image builds from the lockfile
HA_TOKEN="<token>" HA_BASE="http://homeassistant.mgmt:8123" \
  DASH_PATHS="fridge-status,home-status,dashboard-deck" node ha_ws_trim_proxy.mjs
# open http://localhost:9123/fridge-status
```

## Environment specifics

- HA instance: `http://homeassistant.mgmt:8123` (also `192.168.4.2` = the HA host itself).
  The HA host is the only always-on machine, so production = this app running on it.
- This ships as its **own standalone app with its own port** (8099), independent of any
  other app on the host.
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
  reconnect-on-drop. So editing a dashboard's cards no longer needs an app restart. A
  recompute still only affects **new** ws connections (HA can't amend a live
  `subscribe_entities`), so since 0.2.3 a rebuild that **adds** entities drops the open
  bridges — the frontend reconnects itself and re-subscribes, no manual kiosk reload.
  Removals deliberately don't churn connections. Adding a whole new dashboard to the
  `dashboards` option still needs a restart (options are read at boot). If the control ws
  can't reconnect, the proxy keeps serving the last-known allowlist.
- **Registries (entity/device/area) ARE trimmed and cached** (`trim_registries`, on by
  default), as is `get_services` (`trim_services`, off by default). The shared response cache
  is keyed by **`(kind, dashboard, allowlist version, allowlist SIGNATURE)`**. The signature is
  the load-bearing part: a connection's allowlist can be *wider* than its dashboard's — a
  `client_overrides` pin, a self-identified satellite, or `user_overrides` — and without it in
  the key, such a connection reads rows missing its extra entities and writes another client's
  rows back for everyone else.
  - **Do not "simplify" this to skipping the cache for widened connections.** That was tried
    (`.30`, an `allowDiverged` flag) on the assumption that widened connections are a rare
    minority. Measured on a live instance, they are the MAJORITY — voice-satellite panels
    self-identify and the admin user matches a user rule — and the hit rate fell from **97.9%
    to 9.1%**. Correct and useless. Identity belongs in the key, not in a bypass.
  - The signature is taken **lazily at the first cacheable request**, not at connection open,
    because `user_overrides` widens the set after the auth gate resolves. **And the cache lookup
    itself runs inside the gated thunk** (`cachedOrForward`), not at receive time. Looking it up
    on receipt bypassed the gate: a hit answered before reaching the queue, with the PRE-rule
    signature, so a widened user was served another connection's rows when the cache was already
    warm for that dashboard. The test with a slowed `auth/current_user` pins this.
  - **Pins from the panel write to whichever source owns the option** (`appendToListOption`):
    the console store if it has taken `always_forward`/`resources_always_forward` over, else
    Supervisor. Writing to Supervisor unconditionally put the pin in the shadowed source, so it
    vanished at the next restart.
  - **A rebuild recycles only the bridges whose own dashboard grew** (`openBridges` maps close
    → `{ dash, ip }`; unattributed bridges follow the union). It used to drop every open connection
    whenever the union gained anything. **Read "reconnecting N of M" by the addresses it names,
    not by which dashboard grew.** Before 2026.09.21.1 the line ended with the grown dashboards, and
    was taken as proof a panel had reconnected when the connection dropped was another client on
    the union. A grown dashboard with nobody attributed to it now logs `no open connection is
    attributed to <dash>`. And a panel with no `entity payload delivered to <its ip>` line after a
    Core restart is not on a trimmed connection at all, since that restart drops every bridge.
  - Note for testing it: every loopback test client is `127.0.0.1`, so a `client_overrides` pin
    widens all of them or none and the collision case never arises. Use two USERS instead —
    that is what `two users on one dashboard never share each other's cached registry` does,
    and dropping the signature from the key must make it fail.
- **Trimming can be PAUSED per Home Assistant user** (`pause.mjs`, `/data/pauses.json`, console
  status strip). Keyed on the USER, not the device: the case it exists for is troubleshooting from
  a phone on cellular behind Cloudflare, where no address is stable. Three properties to keep if
  this is touched. (1) It is applied **inside the auth gate**, beside the user rules, because that
  is the only moment the token has been resolved and still before the first `subscribe_entities` —
  applying it later cannot work, since HA will not amend a live subscription. (2) Any active pause
  forces the gate ON for every connection (`userRulesCouldApply(dash) || anyPauseActive`), or a
  connection that no user rule could match would sail past the lookup and stay trimmed. (3)
  Starting and ending one **recycles that user's bridges** (`recycleUser`), which is what makes it
  reach the page in their hand. Inside `bridge()` every trim reads the per-connection `trimming`
  flag, never `STRIP` — a partial pause is the worst outcome, still missing what you came to look
  at and slow as well. Pauses expire (1h / rest of day, 24h ceiling) because one left on is
  invisible: panels just load slowly. WHO is paused is redacted off-Ingress like every other
  identity; THAT something is paused is not, because a health check should see it.
  **Acting on anyone but yourself needs an admin** (`userIsAdmin`): `panel_admin: false` opens this
  console to every user, and Ingress names the caller but not their role, so `scope: 'admins'` and
  resuming someone else's pause look the role up with `config/auth/list` over the control ws
  (`CONTROL_RPC`; `system-admin` group or owner, cached 60s) and fail CLOSED when it cannot.
  Codex review 2026-10-10: before this, any household user could pause every administrator.
  The same gate (`callerMayAdminister`) covers `/config`, both pins and `/access.json` (webhook
  ids are bearer secrets). A NAMED caller is always checked; with no identity it passes only in a
  standalone run, where loopback is the operator's machine. `/config` also type-checks each value
  (`valueError`): stored unchecked, `"false"` read as true at the next boot.
  Identities follow the same rule: `/stats.json` is unredacted only for an ADMINISTRATOR on Ingress,
  not for Ingress alone, and it carries `viewer: { ingress, admin }` so the console hides what that
  viewer would be refused (the admin pause, other people's resumes, pins). Pause and resume use the
  same gate as configuration, so the two cannot disagree about who passes.
  **The reserved key `role:admin`** (`ADMINS`) pauses every administrator at once, which is what
  the switch `switch.strimmer_trimming_admins` does — the transport carries a command and not an
  identity, so an anonymous control can only scope to a role. `is_admin` comes from
  `auth/current_user`, the same field the `role: admin` override matcher uses; do not introduce a
  second definition. A colon cannot occur in an HA user id, so the key cannot collide. The switch's
  own state field is `admin_trimming`, separate from `trimming`: a pause for one PERSON must not
  make the switch read as off, or turning it on would appear to do nothing.
- **Metrics: one catalogue, one transport.** `metrics.mjs` declares WHAT exists (`SENSORS`,
  `BINARY_SENSORS`) and computes the values (`buildPayload`); `esphome_api.mjs` is the only thing
  that puts them on a wire, via the `esphome-device` package. Add a metric to the catalogue and it
  appears for free; never declare one in the transport. **MQTT discovery was removed in
  2026.09.25.3** after running beside ESPHome long enough to compare them — same numbers, and the
  cost of keeping both was two copies of every entity in Home Assistant (the second suffixed `_2`)
  plus a Mosquitto dependency. `mqtt_sensors` stays in the schema as a REMOVED_KEYS entry so an
  existing config is still valid; it does nothing and the boot log says so. Three things the
  ESPHome side must keep: entity `id`s are passed EXPLICITLY (the library derives one from the
  display name otherwise, so rewording a sensor would orphan its statistics); `dp` in the catalogue
  is the decimals a float32 reading is displayed to; and the node name `strimmer` is what the
  device's MAC — Home Assistant's unique id for it — is derived from, so changing it makes a new
  device with no history. The mDNS announcement carries ONE address, chosen by `pickAdvertiseAddress` (LAN before Docker bridges, never Tailscale's 100.64/10): the library advertises every address by default, and Home Assistant stored the tailnet one, so HA reached a device on its own machine through Tailscale. `esphome_port`/`esphome_key` are BOOTSTRAP_KEYS. Note the option test: a
  DEFAULT-OFF option cannot use the `(OPT.x ?? true) !== false` shape the default-on ones use —
  written that way it is false for everyone and the listener never starts.
- **Reachability:** the app must resolve `http://homeassistant:8123`. `host_network: true`
  is now set (for trusted-network login, below), which can break the internal
  `homeassistant`/`supervisor` DNS names — the `ha_base` / `allow_ws_url` options pin them
  to IPs if startup fails (e.g. `ha_base: http://192.168.4.2:8123`).
- **Architectures: amd64 and aarch64 only.** `armv7` was removed 2026-09-13 and should not be
  re-added: `node:24-alpine` onwards publishes **no `arm/v7` image** (`node:20-alpine` did), so
  the Supervisor build fails outright on 32-bit ARM — and Home Assistant itself deprecated
  32-bit ARM in 2025.6 and dropped it after 2025.12. **Check the registry manifest before any
  base-image bump**, because that regression was silent: the tag existed, the platform did not.
- **Base image is `node:26-alpine`, pinned by digest in a literal `FROM`** (not `ARG BUILD_FROM`,
  which Dependabot cannot see through; there is no build.yaml to inject one), taken deliberately ahead of its
  2026-10-28 LTS date (v24 LTS 2025-10-28 / EOL 2028-04-30; v26 LTS 2026-10-28 / EOL
  2029-04-30). Cheap because nothing here compiles — no native bindings, no ABI to rebuild.
  CI tests Node 22, 24 and 26; 24 stays in the matrix as the known-good fallback. Dependabot is
  configured to **ignore Node majors** on purpose: odd lines are never LTS, even ones only
  qualify the October after release, so that call is a person's, not a bot's.
- **Auth through the proxy:** first load does a normal HA login against the proxy origin.
  If login loops/400s, the HA `http:` integration may need `use_x_forwarded_for` +
  `trusted_proxies` for the app's IP.
- **Trusted-network (password-less) kiosk login — CONFIRMED 2026-06-18:** for HA's
  `trusted_networks` provider to match the kiosk's real LAN IP, the app must run with
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
  app logs aren't readable with a long-lived token (Supervisor returns 401). NOTE: a
  local app bakes code into the image at build time (`COPY` in the Dockerfile), so code
  changes need a **Rebuild**, not a Restart; config.yaml `host_network` also needs Rebuild,
  and `http:`/`auth_providers` need a full **Core restart** (not a YAML quick-reload).
- **Never flatten the X-Forwarded-For chain — CONFIRMED FIXED 0.2.3, verified live by a user
  behind Caddy.** The normalization above was originally written as
  `proxyReq.setHeader('x-forwarded-for', ip)`, which *replaced* the whole chain with our
  immediate peer, so with any upstream reverse proxy HA received XFF=1 entry and XFP=2, and
  `forwarded.py` raises `HTTPBadRequest` on
  `len(forwarded_proto) not in (1, len(forwarded_for))` → a hard **400 on every request**
  (issue #9). Normalize each entry **in place**; never rebuild the header from a single IP.
  Also note `proxy.ws()` does NOT fire `proxyReq` — the ws path needs its own `proxyReqWs`
  handler or upgrades silently keep the `::ffff:` form.

  **Two invariants, and the second is the security one — CORRECTED 2026-09-17 after upstream
  review.** (1) The For and Proto chains agree in LENGTH, or HA 400s. (2) **Our own peer is the
  RIGHTMOST entry whenever the client supplied a chain.** HA walks For from the right and takes
  the first address not in `trusted_proxies` as the client; DOCS tell people to trust 127.0.0.1.
  If a client-supplied chain is merely preserved, any LAN host can send `X-Forwarded-For:
  <kiosk ip>` and log in password-less through `trusted_networks`. node-http-proxy appended by
  default; **httpxy's HTTP path sets each header only when absent** (its ws path appends), and the
  migration lost the append until GabrielGoldsteinAnidea flagged it on upstream PR #21. Now:
  `captureForwarded()` records what the client sent before httpxy fills the header in, and
  `forwardedChain()` appends the peer (and keeps Proto in step: a single scheme stays single, a
  chain grows by one) on both `proxyReq` and the HA-side bridge socket. A consequence for docs:
  a reverse proxy in front of the app must itself be in `trusted_proxies`. The old note here said
  "not that our hop is appended" — that was wrong, and the test that pinned it has been replaced.
- **The proxy library is `httpxy`, not `http-proxy`.** Three API differences bite:
  `createProxyServer` is a **named** export; **`ws()` is `(req, socket, options, head)`** where
  node-http-proxy was `(req, socket, head)` — passing `head` third spreads a Buffer into the
  request options and the upgrade silently never completes; and `web()`/`ws()` return promises,
  so both call sites need a `.catch()` or a proxy error becomes an unhandled rejection and
  takes the process down.
- **`proxyTimeout` (120s, `PROXY_TIMEOUT_MS` to override) bounds the wait on HA.** Nothing did
  before: Node's `server.timeout` is `0` and `requestTimeout` only covers *receiving* a request,
  so an HA that stalled rather than died held the socket forever and never errored. Safe for
  camera streams for two reasons worth not re-deriving: it is an **inactivity** timer, so an
  MJPEG/HLS stream resets it as frames flow; and httpxy applies it in `webIncomingMiddleware`
  only, so `proxy.ws()` upgrades are untouched.
- **Registry events are filtered by changed field, for devices as well as entities**
  (`IGNORABLE_BY_EVENT`). Measured 2026-09-19: 33 rebuilds in 8.5 min, 28 from
  `device_registry_updated`, all `+0 -0`. A device row reaches an allowlist only via `id`,
  `area_id`, `name`, `name_by_user`, `via_device_id`. `manufacturer`/`model`/`model_id` are
  ignorable ONLY while auto-entities' `device_manufacturer`/`device_model` stay unsupported — take
  them out of the set if those filters are added. `allowlist.rebuilds` in stats.json (and the
  `rebuilds_total` sensor) is the storm detector; it was never incremented before 2026.09.19.1.
- **Every rebuild retires the cached registry answers** (`ALLOW_VERSION++; REG_RESPONSE_CACHE.clear()`),
  including a `+0 -0` one. It used to clear only when membership moved, so a device rename or area move
  (which rebuilds but changes no entity ids) kept being served from the old rows with no TTL to rescue it.
  Found in the 2026-10-24 Codex review. Cached answers are also withheld until HA's `auth_ok`: a hit never
  reaches HA, so serving one earlier let a socket that skipped `auth` read another client's rows.
- **Registry-triggered rebuilds also have a time floor** (`REGISTRY_REBUILD_MIN_MS`, 30s,
  env-only). Tests that fire registry events seconds apart and COUNT rebuilds must set it to `0`.
  `scheduleRecompute(why, floorMs)` takes the LOWEST floor among debounced requests, so an edit is
  never held behind a registry event — keep that property if this is touched.
- **Logging that recurs slower than the 10s throttle window uses `onceOnly(key)`**, not
  `logThrottled` (satellite announces every 30s; "no user rule matched" every 5 min; "user rules
  applied" on every phone reconnect; "N devices are named" on every rebuild). The resource report
  is buffered in `buildResources` and printed only when its text changed, and since 2026.09.25.6
  so is the whole rebuild's detail: inside a build, informational lines go through `report()`,
  not `log()`. The comparison includes a hash of what each set CONTAINS — the lines are counts,
  and a swapped entity leaves every count the same. Errors and warnings still use `log`/`warn`.
- **Every rebuild logs its cost** (`rebuild took …ms: worst event-loop block …ms, largest frame
  …MB parsed in …ms, dashboards …ms`). Read that line before optimising the rebuild: it already
  yields between dashboards (each config fetch is an await). Measured 2026-09-25 on 10,901
  entities: rebuild 962ms wall, worst block 55ms, the 10.9MB registry frame parsed in 29ms,
  dashboards 23ms. Not worth optimising at that size.
- **The event-loop "worst" counts from a minute after the first allowlist** (`settleLoopDelay`,
  `LOOP_SETTLE_MS`), not from import. Before 2026.09.25.7 it included startup — compile, first
  build, every panel reconnecting at once — and read 114ms at 14s uptime while the rebuild's own
  worst was 55ms. The week-long "creep" from 46ms to 120ms was startup growing with the instance,
  not the proxy slowing. Do not read a since-boot figure as an operational one.
- **Every socket the proxy opens to HA carries `X-Forwarded-*`** — bridge, identity probe
  (`resolveUser(token, fwd)`), and the `serveDashboardPage` fetch. HA's failed-login ban keys on
  the address it sees; a bare probe made a rejected token the PROXY's failed login.
- **Ingress is the PEER, never the header (`INGRESS_PEERS`).** As an add-on only Supervisor's
  `172.30.32.2` may speak for Ingress; loopback is accepted only in a standalone run. It used to
  accept 172.30.32.0/24 and loopback, and under host_network loopback is every host-network process
  (Home Assistant, Node-RED, the SSH add-on…): any of them could forge `X-Ingress-Path` and pause
  anyone or rewrite the console config. Found in review 2026-10-02. Note ha-mcp's "Ingress" proxy
  mode connects directly from the host, so it gets the redacted, read-only view now.
- **`serveDashboardPage` takes the HOST from `HA_BASE` only** and the request supplies path and
  query. `new URL(req.url, HA_BASE)` let `GET //<dashboard-name>/…` resolve as protocol-relative
  and fetch from a host named like a dashboard (CodeQL `js/request-forgery`, 2026-10-02). Any new
  upstream fetch built from `req.url` needs the same shape.
- **User-written regexes with nested quantifiers run under a 50ms `node:vm` deadline**
  (`guardedTest` in lovelace_extract.mjs). Don't "simplify" to rejecting them statically — a
  rejected filter matches nothing, which is the harmful direction — or to guarding every regex,
  which costs ~40µs a call across ~10k ids.
- **The control connection's commands are bounded too (`CONTROL_RPC_TIMEOUT_MS`, 60s).**
  `handshakeTimeout` covers only the upgrade; an HA that wedged on `get_states` left the rebuild
  awaiting forever and the `rebuilding` flag set, so no edit could ever trigger another. Expiry
  drops the socket so `onGone()` rebuilds on a fresh one. The mock's `hangTypes` exercises it.
- **The HA-side bridge socket carries `X-Forwarded-*` (`forwardHeadersFor`).** It is the one
  connection opened without httpxy, so HA saw every trimmed panel as the proxy's address — which
  is what `ip_ban` keys on. Same rule as HTTP: set only when absent, For normalised in place.
  The mock records every `/api/websocket` upgrade's headers in order; note the proxy opens TWO
  per browser (bridge, then the identity probe), so a test reads the first after its marker.
- **Backpressure (`BP_HIGH_BYTES` / `BP_STALL_MS`).** `safeSend` checks `bufferedAmount` after
  every write; past the high mark the HA socket is `pause()`d and polled back to a quarter of
  it. A client with no progress for the stall window is **`terminate()`d, not `close()`d** — a
  close frame queues behind the backlog it is not reading and ws holds it 30s more. Testing it
  needs an INCOMPRESSIBLE payload: the browser leg deflates, so 200KB of `x` leaves as 200 bytes.
- **`resolveUser` dedups in flight by token hash (`USER_INFLIGHT`).** A kiosk load opens several
  sockets with one token; they used to cost one probe each.
- **Node, not Rust or Go — settled 2026-09-19, see `docs/CLUSTERING.md` §6.** Both would thread
  better, and both would delete the whole catastrophic-regex apparatus outright (RE2 and Rust's
  `regex` are linear-time and cannot backtrack). But measured: 0.12–3.85% CPU, event-loop p99
  **6.8ms**, worst stall 46ms, 77MB RSS — threading is not the binding constraint. The asset here
  is this file's list of production-learned behaviours, not the code, and a rewrite risks
  re-learning it. Revisit only if p99 loop delay passes ~100ms under normal load.
- **Clustering: measure first, see `docs/CLUSTERING.md`.** A `SharedArrayBuffer` does NOT survive
  cluster IPC (tested — it arrives as a plain object), so real shared memory needs a native
  dependency this project does not take; `cluster` passes sockets but not memory, `worker_threads`
  the reverse. The design that resolves it needs no shared memory at all — route a client
  consistently to one worker and `clientDash`, `clientLearned`, `USER_CACHE` and the registry
  cache are all already client-local. `worker_threads` for `extractEntities` was measured a NET
  LOSS: 27ms of blocking structured-clone to move 22ms of work.
- **HTTP/2 and QUIC are settled: NO. Do not revisit without new facts.** httpxy has an `http2`
  option, but it only affects httpxy's own `listen()` helper (`http2.createSecureServer`) — we
  build our own server and call `proxy.web()`, so it is inert here, and it serves h2 rather than
  proxying to an h2 upstream. More fundamentally: WS over HTTP/2 needs RFC 8441 Extended
  CONNECT, which `ws` does not support server-side and HA's aiohttp does not serve at all, so
  the HA leg is HTTP/1.1 by necessity. Browsers already get h2/h3 from **NPM and Cloudflare,
  which sit in front** of this; the NPM→Strimmer hop is plain HTTP over the LAN, where
  multiplexing buys nothing. And NPM measured **3.6× faster** than hitting the proxy directly,
  which is what killed the direct-TLS proposal too. Let the edge own front-end transport.

## Security

A long-lived HA token was used during dev testing from the dev box; the app does not
need it (uses `SUPERVISOR_TOKEN`). Rotate any dev token when done.
