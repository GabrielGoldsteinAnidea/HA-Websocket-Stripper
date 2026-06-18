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

We first tried a lighter path in the sister AppDaemon repo (`Q:\a0d7b954_appdaemon`):
a long-poll backend (`DashProxy`) + a hand-written **approximated** renderer that redrew
cards in plain HTML. It loaded fast but the owner wants **pixel-perfect** fidelity, and
re-implementing Mushroom/button-card/clock-weather/etc. is a losing battle. So we pivoted
to: **run HA's real frontend, just strip the websocket.** That approximation code is being
removed from the AppDaemon repo; this repo is the chosen direction.

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

## Allowlist computation

Union, across all configured dashboards, of:
1. `extractEntities()` (`lovelace_extract.mjs`) — walks the card tree for entities in the
   standard keys (`entity`, `entities`, `entity_id`, `camera_image`, …) across **all
   views**, and expands `auto-entities` filter cards against live states.
2. every **real** entity id that appears anywhere in the dashboard config text — catches
   ids referenced inside `button-card` / `mushroom-template` / `decluttering-card`
   templates that a structural walk can't parse.

Then `+ always_forward`, then `- never_forward` (never wins). Over-inclusion is harmless
(still tiny vs the instance); under-inclusion makes a card show "unavailable".

## Files

- `websocket-stripper/ha_ws_trim_proxy.mjs` — the proxy (HTTP passthrough + ws intercept + allowlist precompute).
- `websocket-stripper/lovelace_extract.mjs` — the card-tree entity extractor.
- `websocket-stripper/config.yaml` / `Dockerfile` / `package.json` — HA add-on packaging.
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

- HA instance: `http://homeassistant.mgmt:8123` (also `192.168.4.2` = the HA host itself,
  which also runs the Mosquitto broker and the AppDaemon add-on). The HA host is the only
  always-on machine, so production = this add-on running on it.
- The AppDaemon add-on only exposes port 5050 and the owner can't add ports to it / has no
  container access — which is exactly why this is a **separate add-on with its own port**,
  not folded into AppDaemon.
- Target dashboards (storage mode): `fridge-status` (views: fridge-main, weather, audio),
  `home-status` (views: Home, Home Std, Front Door Camera, Kids Cam — note: its Home view
  has malformed `auto-entities` keys like `"domain 1"` from the visual editor),
  `dashboard-deck`.
- Validated numbers: full instance ≈ 3,630 entities; union allowlist for the three
  dashboards ≈ 58. `get_states` confirmed trimmed 3630 → 58 through the proxy.

## Known caveats / open items

- **Frontend JS bundles still load** (cached after first visit). This targets the entity
  firehose, which is what scales with instance size — not first-ever bundle load.
- **Allowlist is startup-only.** Editing a dashboard's cards needs an add-on restart.
  *Planned:* subscribe to the `lovelace_updated` event and recompute live.
- **Registries (entity/device/area) are not trimmed** yet — they pass through full. If
  load is still heavy after entity trimming, trimming/caching these is the next lever.
- **Reachability:** the add-on must resolve `http://homeassistant:8123`. If it can't on
  the default add-on network, add `host_network: true` to `config.yaml`.
- **armv7**: base image is `node:20-alpine` (multi-arch). Verify the build on the target
  arch; drop `armv7` from `config.yaml` `arch` if it doesn't build.
- **Auth through the proxy:** first load does a normal HA login against the proxy origin.
  If login loops/400s, the HA `http:` integration may need `use_x_forwarded_for` +
  `trusted_proxies` for the add-on's IP.

## Security

A long-lived HA token was used during dev testing from the dev box; the add-on does not
need it (uses `SUPERVISOR_TOKEN`). Rotate any dev token when done.
