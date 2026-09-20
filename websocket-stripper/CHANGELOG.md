# Changelog

## Unreleased

- **The stats port answers Ingress and loopback only, by source address.** With host networking
  the port is bound on the host, and it served client addresses, entity counts and uptime to the
  whole LAN unauthenticated. Supervisor (the hassio network) and loopback are accepted; anything
  else gets a 403 and one throttled log line. `stats_lan: true` opens it for a `rest` sensor.
- The "Served from cache" tile is gone: nothing produced cache hits yet, so it read `0 / 0 B`
  forever. It returns with whatever lands registry caching.

**A statistics panel in the Home Assistant sidebar, and a JSON API behind it.**

Until now the only evidence the add-on was doing anything was the log, which you read once
something already looks wrong — so a correctly working install was indistinguishable from a
broken one until a card went "unavailable". The panel shows connected clients, how big the
allowlist is against the size of the instance, measured before/after sizes for what it trims,
and live update throughput.

Served over Ingress on its own port (8100), so it needs no configuration and no extra exposed
port; the same data is at `http://<host>:8100/stats.json` for a `rest` sensor or a scrape. The
add-on binds whatever `ingress_port` Supervisor reports for it rather than assuming, so the two
cannot drift apart — and `ingress_port: 0` (dynamic allocation) would work unchanged.

It reports only what it can honestly measure. `get_states` has a real before/after — the proxy
holds HA's full answer and its own trimmed answer in the same function, so "saved" is a
subtraction. The event stream does not: HA filters it server-side from the `entity_ids` the
add-on injects, so the untrimmed volume never exists anywhere and cannot be measured. It is
reported as throughput and never folded into the savings total.

## 0.2.4 — 2026-09-17

Redirects behind an HTTPS terminator, and the companion app. Both from #9's second report.

**Redirect loop behind a TLS-terminating reverse proxy** (#9). `changeOrigin` makes HA see
every request as arriving at `ha_base`, so its absolute redirects (`/lovelace/0`, the auth
flow) come back naming HA's own address. `http-proxy`'s `autoRewrite` fixed the *host* of a
redirect but never its *scheme*, so behind Caddy/NPM/DuckDNS the browser was sent from
`https://host/...` to `http://host/...`, the edge proxy bounced it back to HTTPS, HA reissued
the same redirect, and the page never loaded — a URL that grew by `:8123./` on every bounce.
`autoRewrite` is now off and the proxy rewrites `Location` itself in a `proxyRes` handler:
scheme and host from `X-Forwarded-Proto`/`X-Forwarded-Host` (first entry, so the browser's
own origin wins over our hop), and only when the redirect points at HA or at the browser's
host on the wrong scheme. Third-party and relative redirects are left alone. Every rewrite
is logged (`rewrote redirect for https://host: ... -> ...`, throttled).

**`redirect_uri` / `hass_url` query parameters are rewritten too** (#9, #8). HA's login flow
carries an absolute URL in `redirect_uri`, which `autoRewrite` never touched, so login pointed
the browser at HA's LAN address — unreachable from outside, and for the companion app
(`homeassistant://` custom-scheme redirect) exactly the "can't resolve the Home Assistant
URL" failure in #8. Custom-scheme `redirect_uri` values survive the rewrite untouched.

Setting `url.host` in JS keeps the existing port when the new value has none, so the first
cut turned `http://10.0.0.5:8123/` into `https://example.org:8123/`; hostname and port are
set separately. Caught by the tests before it shipped.

## 0.2.3 — 2026-08-23

Filter resolution and reverse-proxy fixes, all from reported issues.

**auto-entities globs and regexes now work on every filter key** (#10). Only `*` globs were
ever understood, and a `/regex/` was escaped as literal text — so `/^sensor\.pv_.*_power$/`
compiled to `^/\^sensor\\\.pv_.*_power\$/$` and matched nothing, leaving those cards
"unavailable". The matcher is now a port of auto-entities' own (`src/match.ts`): a `/regex/`
is used as-is and deliberately **not** anchored, a glob is anchored, otherwise exact
equality. Crucially it now applies to **every** key — `domain`, `area`, `label`, `device`,
`integration`, `name` — not just `entity_id`, matching upstream.

**HA's selector object form is understood for `entity_id` and `domain`** (#4). The visual
editor stores values as `{ custom: "input_boolean.bypass_*", active_choice: "custom" }`.
That was handled for `area`/`label`/`device`/`integration` but not for `entity_id`/`domain`,
where it stringified to `"[object Object]"` and matched nothing.

**`filter: template:` cards resolve** (#4). Their entity list only exists after HA renders
the Jinja, so a structural walk could never see it. The proxy now renders those templates
over its existing control connection (`render_template`, taking the first result and
unsubscribing) and takes the real entity ids from the output. A template that errors or
times out contributes nothing and no longer affects the rest of the dashboard.

**Group members are pulled in transitively** (#4). A card naming only a group — or expanding
one client-side, like `enhanced-shutter-card`'s `show_group_members` — left every member
stripped, because the members appear nowhere in the dashboard config. Any allowlisted entity
now contributes its `entity_id` attribute members. The auto-entities `group:` and `name:`
filter keys are supported for the same reason.

**The X-Forwarded-For chain is preserved** (#9). The handler that normalizes IPv4-mapped IPv6
used `setHeader`, replacing the whole chain with our immediate peer. Since http-proxy
*appends* our hop to all three forwarded headers, anything running another reverse proxy in
front (Caddy, nginx, Traefik) sent HA `X-Forwarded-For` with 1 entry and `X-Forwarded-Proto`
with 2 — and HA's forwarded middleware raises `HTTPBadRequest` on
`len(forwarded_proto) not in (1, len(forwarded_for))`. Result: a hard **400 on every request**
through the add-on while `:8123` worked fine. Entries are now normalized in place, so the
counts stay in step and the real client IP survives the upstream hop (which also lets
`trusted_networks` see the browser rather than the proxy). The same normalization now applies
to websocket upgrades, which never fired the HTTP-only hook.

**Open dashboards pick up a grown allowlist by themselves** (#7). `subscribe_entities` is
sent once per connection and HA can't amend a live subscription, so a rebuild only ever
affected *new* connections — an already-open kiosk kept its original entity list until
someone reloaded the tab. When a rebuild **adds** entities, affected connections are now
dropped; the frontend treats that as an ordinary disconnect and reconnects against the
current allowlist. Removals deliberately don't churn open connections.

Tests: 44 → 75.

## 0.2.2 — 2026-07-29

**An empty allowlist is never forwarded as "no filter".** HA parses `subscribe_entities` as
`set(msg["entity_ids"]) or None`, so an *empty* `entity_ids` doesn't mean "subscribe to
nothing" — it means **no filter at all**. Any condition that produced an empty allowlist
therefore inverted this add-on's entire purpose: it relayed every entity on the instance.
Observed live on a ~3,600-entity instance, where it drove the process into the 2 GB heap
limit (`FATAL ERROR: Reached heap limit`) every 30–130 s in a Supervisor restart loop.

The condition that triggered it was a plain misconfiguration, made likely by this add-on's
own defaults:

- **`dashboards` no longer defaults to `fridge-status` / `home-status` / `dashboard-deck`.**
  Those are the author's own dashboards; on anyone else's instance every `lovelace/config`
  returns `config_not_found`, the union comes back empty, and the firehose follows. Since
  reinstalling an add-on resets options to their defaults, a fresh install landed straight in
  that state. The default is now `[]`.
- **`/api/websocket` is refused whenever the allowlist is empty**, not only before the first
  build, with the reason named in the log. A second guard in the relay drops the connection
  rather than ever sending an empty `entity_ids`.
- **A failed dashboard fetch now logs the dashboards that *do* exist**
  (`lovelace/dashboards/list`), so `config_not_found` answers its own question instead of
  repeating forever.
- **No dashboards configured no longer exits** — that only moved the restart loop into the
  Supervisor. The add-on stays up, refuses to strip, and says which option to set.

**Survive a Home Assistant restart.** Rebooting HA killed the add-on and left it in a
crash-restart loop that never recovered on its own. Three separate causes:

- **Unhandled socket error on an in-flight ws upgrade.** A raw upgrade socket arrives with
  no `'error'` listener, and `http-proxy` only attaches one after HA answers `101`. When HA
  goes down it resets every in-flight stream at once (camera / Assist sockets), and a reset
  in that window reached Node as an unhandled `'error'` event — `throw er` /
  `read ECONNRESET` — taking the whole process down. The upgrade handler now claims the
  socket's errors first, and network errnos anywhere else are caught process-wide instead of
  being fatal.
- **`process.exit(2)` when the first allowlist couldn't be built.** The add-on and HA core
  restart together, and core takes minutes to answer, so the restarted add-on exited within
  ~300 ms — over and over, until the Supervisor gave up. The control connection now retries
  with the same backoff it already used for later drops, and never exits for a transient
  failure. A bad token is reported loudly and retried rather than crash-looped.
- **The proxy now listens before HA is reachable**, so it is already serving the moment core
  comes up. Until the first allowlist exists, `/api/websocket` upgrades are refused with a
  `503` (the frontend retries on its own) rather than answered with an *empty* allowlist,
  which would have shown every card as "unavailable" until a manual kiosk reload.

A restarting HA also comes back in stages, which used to leave the allowlist wrong:

- **A rebuild after reconnect now merges instead of replacing.** Core answers `auth_ok` and
  `get_states` before lovelace serves configs and before the state machine has finished
  loading, so a rebuild in that window legitimately comes back short — and since no dashboard
  edit follows a restart, nothing would ever rebuild it. Cards would have stayed "unavailable"
  indefinitely. Over-including is harmless by design here; under-including breaks cards. An
  actual dashboard/registry edit still replaces, so removals still take effect.
- **`buildAllow()` bails when *every* dashboard config fails** — an HA that authenticates but
  isn't serving lovelace yet — so the caller retries instead of committing an empty allowlist.
  A *single* dashboard failing is still tolerated: that's a typo'd `url_path`, and it must not
  stop the others from being served.
- **A wedged HA is covered too**: the control connection has a handshake timeout, so a core
  that accepts the TCP connection but never completes the ws handshake still triggers a
  reconnect rather than hanging silently.

Two deliberate trade-offs, both of which swap a loud failure for a quiet one:

- A genuine misconfiguration now presents as "running" rather than "stopped". To keep it
  diagnosable, after six failed attempts the log names the `ha_base` / `allow_ws_url` options,
  DNS errnos are excluded from the process-level guard, and a malformed `allow_ws_url` still
  exits with a clear message.
- `auth_invalid` no longer exits (that just moved the restart loop into the Supervisor), but
  retries on a ≥60s floor — in dev/CLI mode the control connection authenticates against HA
  directly, and a faster loop would walk into `login_attempts_threshold` / `ip_ban`.

Also: repeated failures are collapsed in the log (one line, then a periodic count) instead of
flooding hundreds of identical `ECONNREFUSED` lines per second while HA is down.

## 0.2.1 — 2026-07-19

- Remove the inert `ports:` / `ports_description` mapping from `config.yaml`. Under
  `host_network` a Docker port map does nothing, so it only duplicated (and could drift
  from) the functional `port` option. The `port` option is now the single source of truth
  for the listen port. No behavior change — the add-on still binds `8099` by default.

## 0.2.0 — 2026-07-18

- **auto-entities `area` / `label` / `device` / `integration` filters now resolve** (#4).
  The proxy fetches the area/device/entity/label registries and expands these filters the
  way HA's frontend does, instead of silently forwarding nothing — so cards filtered by
  label/area no longer show entities as "unavailable" and you don't have to hand-list them
  in `always_forward`. Volatile filters (`state` / `attributes`) now over-include (an
  entity that doesn't match right now is still forwarded so the card can show it when it
  does). The allowlist also rebuilds on registry changes, not just dashboard edits.
- **Configurable `port` option** (#6) — move the add-on off `8099` when it collides with
  another add-on (e.g. Zigbee2MQTT). Needed because `host_network` makes the Network tab
  unable to remap the port.
- **Allowlist recompute now logs the added/removed entity diff** (#7), not just the total,
  so you can see exactly what a dashboard edit changed.
- **Defensive egress filter** (PR #1): `subscribe_entities` event payloads (`a`/`c`/`r`)
  are re-filtered to the allowlist on the way to the browser — a no-op today, but a
  guarantee the firehose can't leak if a future HA ignored the `entity_ids` subscription.
- Added a test suite (`npm test`, `node --test`): unit tests for the extractor + registry
  resolver, and integration tests that spawn the real proxy against a mock HA.

## 0.0.1 — 2026-06-19

Initial public release.

- Reverse proxy that serves the real Home Assistant frontend but trims the entity
  websocket (`subscribe_entities` / `get_states`) to each dashboard's allowlist, so
  kiosk / wall-panel dashboards load fast on large instances — with full fidelity.
- Runs with `host_network: true` so trusted-network (password-less) kiosk login works
  through the proxy; `X-Forwarded-For` is normalized to plain IPv4 (strips IPv4-mapped
  IPv6 `::ffff:` so it matches IPv4 `trusted_networks` subnets).
- Options: `dashboards`, `always_forward`, `never_forward`, `strip_entities`, plus
  `ha_base` / `allow_ws_url` to pin the HA / supervisor URLs to IPs if host networking
  breaks the internal DNS names.
