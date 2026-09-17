# WebSocket Stripper

Serves your real Home Assistant dashboards but only forwards the entities each dashboard
uses, so kiosk/wall-panel pages load fast on large instances — with no loss of fidelity
(it's the real frontend and real cards).

## Configuration

| Option | Type | Description |
|--------|------|-------------|
| `dashboards` | list of strings | Dashboard `url_path`s to serve (e.g. `fridge-status`). The forwarded entity set is the **union** of all of them, so you can navigate between them. Find a dashboard's `url_path` in Settings → Dashboards. |
| `always_forward` | list | Entities to forward even if no listed dashboard uses them. Each item is a literal `entity_id` or a `/regex/` (matched against all entities). |
| `never_forward` | list | Entities to never forward. Applied last — **wins** over `always_forward` and dashboard detection. Literal or `/regex/`. |
| `strip_entities` | bool | `true` (default) strips the websocket to the allowlist. `false` = full passthrough (for A/B comparison). |
| `trim_registries` | bool | `true` (default) also trims the entity/device/area registries to what the connection can see, **including `config/entity_registry/list_for_display`**, which is typically the single largest payload the frontend fetches (1.44MB of a 2.46MB load on a 9,553-entity instance). Once states are trimmed this is the largest remaining payload on a big instance — it is one row per entity for the *whole* install. Devices and areas are kept wherever a surviving entity still reaches them, so names and area assignments keep resolving. Turn this **off first** if names, areas or device links render oddly. |
| `compress_websocket` | bool | `true` (default) negotiates `permessage-deflate` with the browser, as Home Assistant's own websocket does. The `ws` library does not enable this server-side by default, so without it this add-on *removes* compression HA would otherwise have provided and kiosks receive plaintext JSON. Deflate runs on libuv's threadpool, not the main loop. Set `false` only on very weak hardware where the CPU costs more than the bytes saved. Memory: with context takeover on (the default), each connection holds a zlib window, about 300 KB at `windowBits` 15 — negligible for a handful of kiosks, but a 50-panel fleet holds ~15 MB in windows alone. |
| `trim_resources` | bool | `false` (default). Trims **Lovelace resources** (custom cards) per dashboard. Resources are instance-wide in HA, so every kiosk downloads and parses every custom card you have installed — 21MB of JavaScript for a 4-card wall panel on the instance this was built against. A resource is kept when the dashboard's card types (or non-builtin icon prefixes) appear in its file. **Off by default.** Most mistakes are loud — a missing card renders as "Custom element doesn't exist", a missing icon pack shows blank icons — so the tuning loop of "turn it on, load the dashboard, see what broke" works. The exception, and the reason for the default, is a resource that renders nothing but runs on load (idle timer, pop-up, heartbeat): dropping one is *invisible*. See the tuning section below. Every drop is logged with its size. |
| `resources_always_forward` | list | URL patterns (literal substring, e.g. `kiosk-mode`, or `/regex/`) always sent. Needed for plugins that patch the frontend instead of registering a card — they contain none of the dashboard's card names, so the content match cannot tell they're used. In practice: `kiosk-mode`, icon packs, and anything that restyles core cards. |
| `resources_never_forward` | list | URL patterns never sent to any dashboard. Wins over `resources_always_forward`. |
| `port` | int | Port the add-on listens on (default `8099`). Because it runs with `host_network: true`, this option is how you move it off `8099` — the **Network** tab can't remap a host-network port. Change it if `8099` collides with another add-on (e.g. Zigbee2MQTT). |
| `ha_base` | string | Optional. Override the Home Assistant base URL the add-on proxies to (default `http://homeassistant:8123`). Set this if `host_network` is on and the internal `homeassistant` hostname doesn't resolve — e.g. `http://192.168.4.2:8123`. |
| `allow_ws_url` | string | Optional. Override the websocket URL used once at startup to precompute the allowlist (default `ws://supervisor/core/websocket`). Set if `supervisor` doesn't resolve under `host_network` — e.g. `ws://192.168.4.2:8123/api/websocket` (also requires a token via `ALLOW_TOKEN`). |

### Example

```yaml
dashboards:
  - fridge-status
  - home-status
  - dashboard-deck
always_forward:
  - "/^sun\\./"
  - person.gabriel
never_forward:
  - "/_battery$/"
strip_entities: true
```

Regex entries are slash-wrapped with optional flags, e.g. `"/_motion$/i"`. In YAML,
backslashes must be escaped (`"\\."`).

## Usage

After starting, browse to `http://<ha-host>:8099/<dashboard-url-path>`, e.g.
`http://homeassistant.local:8099/fridge-status`. Point your kiosk browser at that URL.

> **Port:** because this add-on runs with `host_network: true` (see the tradeoff below),
> it binds directly on the host and the **Network** tab cannot remap it. If `8099` collides
> with another add-on (e.g. Zigbee2MQTT), set the `port` option instead.

The first visit prompts a normal HA login (it's a different origin); after that it's your
real dashboard.

### Trusted-network (password-less) kiosk login

To let a kiosk skip the password via HA's `trusted_networks` auth provider, the add-on
must run with `host_network: true` (the default in this add-on). Without it, Docker
rewrites every client to the gateway IP (`172.30.32.1`) before the proxy sees it, so the
kiosk's real LAN IP never reaches HA and `trusted_networks` can't match it.

On the HA side (`configuration.yaml`), the request now arrives from the **host itself**:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
    # add the host's own LAN IP too if the add-on reaches HA via it, e.g. 192.168.4.2
homeassistant:
  auth_providers:
    - type: trusted_networks
      trusted_networks:
        - 192.168.5.0/24      # the kiosk's subnet
      allow_bypass_login: true
    - type: homeassistant     # keep this or you lose password login entirely
```

Then `ha core restart` (a full restart — `http:` changes need it).

### Why `host_network` is on — and what it costs

This add-on ships with `host_network: true` on purpose. That single flag is a tradeoff, so
here is exactly what you get and what you give up.

**What it buys you.** The add-on shares the host's network stack instead of Docker's
bridged network, so HA sees the **browser's real LAN IP**. That is the *only* clean way to
make the trusted-network (password-less) kiosk login above work: in bridged mode Docker
NATs every client to the gateway `172.30.32.1` before the proxy sees it, so the kiosk's
real IP never reaches HA and `trusted_networks` can't match it.

**What it costs.**

- **The port is rigid.** It binds `:8099` on the host directly; the **Network** tab can't
  remap it, so a clash with another add-on on `8099` can't be fixed there (see #6 above).
- **Internal DNS can break.** The `homeassistant` and `supervisor` hostnames may not
  resolve in host-network mode. If startup fails, pin them to IPs with the `ha_base` and
  `allow_ws_url` options (e.g. `ha_base: http://192.168.4.2:8123`).
- **HA sees the request from the host itself**, so `trusted_proxies` must list
  `127.0.0.1`/`::1` (and optionally the host LAN IP) — not the Docker gateway subnet.

**If you don't need password-less-by-IP login**, none of the above helps you and bridged
mode is simpler (free port remapping, working DNS). Some users run a locally-modified copy
with `host_network: false` for exactly that reason. It is not exposed as an option because
`host_network` is a build-time add-on setting, not a runtime one — changing it means
editing `config.yaml` and rebuilding. If you log in normally (or with a token) and don't
rely on trusted-network auto-login, that's a reasonable local change; you then trim the
port via the Network tab as usual. The default stays `true` so the documented kiosk login
keeps working out of the box.

## Notes & limits

- Trimming affects the **entity** stream (`get_states` / `subscribe_entities`), the
  **entity/device/area registries** (`trim_registries`, on by default) and optionally the
  **Lovelace resource list** (`trim_resources`, off by default). Lovelace config,
  translations and the frontend JS bundles always pass through untouched.
- Cards referencing entities outside the allowlist will show "unavailable". The allowlist
  is computed generously (all views + template-referenced ids), but if something's
  missing add it via `always_forward`.
- The allowlist is computed at startup and **rebuilt live** when a dashboard is saved (or a
  registry changes) — no restart needed. When the rebuild **adds** entities, open dashboard
  connections are dropped so the frontend reconnects and picks them up on its own; no manual
  kiosk reload. (Removals don't churn open connections — carrying a few entities you no
  longer need is harmless.) Adding a whole new dashboard to `dashboards` still needs a
  restart, since options are read at boot.

### auto-entities filter support

Filter values accept the same forms auto-entities itself accepts — an exact id, a `*` glob
(anchored), or a `/regex/` (**not** auto-anchored; include your own `^`/`$`) — on every key
below, not just `entity_id`.

| Key | Resolved how |
|---|---|
| `entity_id`, `domain` | matched directly |
| `area`, `label`, `device`, `integration` | via the HA registries (matches id **or** name) |
| `name` | against `friendly_name` |
| `group` | expands to the group's members |
| `template` | rendered through HA, then real entity ids are taken from the output |
| `state`, `attributes` | deliberately **over-included** — an entity that doesn't match right now is still forwarded, so the card can show it when it later does |

Entities are also pulled in **transitively through groups**: if a card names a group (or
expands one client-side, e.g. `show_group_members`), its members are allowlisted even though
they appear nowhere in the dashboard config.

Still unsupported, and treated as matching nothing: `not`, `and`, `or`, `floor`,
`device_manufacturer`, `device_model`, `last_changed`. If you rely on one of these, list the
entities in `always_forward` and open an issue.
- **Restarting Home Assistant is safe.** The add-on keeps running and waits: HTTP returns
  502 and `/api/websocket` is refused while core is down, then it reconnects, rebuilds the
  allowlist, and open dashboards recover on their own. The same applies at host boot, when
  the add-on starts before core is listening.
- Navigating (via the HA sidebar) to a dashboard **not** in `dashboards` will show its
  entities as unavailable; add it to the list if you want it served too.

### Tuning `trim_resources`

Turn it on, load each kiosk once, and read the add-on log — it prints what each dashboard
needs and every resource it dropped, with sizes:

```
resources basement-stairs-panel needs: entity-progress-multi-feature, grid-layout, navbar-card, whisker-card
resources basement-stairs-panel: 8/45 kept (2536KB), 37 dropped (18471KB)
    drop   4570KB /hacsfiles/custom-brand-icons/custom-brand-icons.js
    drop   3159KB /bambu_lab/ha-bambulab-cards.js
```

#### How a resource is matched

The reliable signal is the card's element name written literally in the file. Plenty of card
packs never write their own names down, though — Mushroom assembles its elements from a
template literal, so `mushroom-cover-card` appears nowhere in `mushroom.js`. For those, the
card type is split on `-` and matched fragment by fragment, and how much weight a fragment
carries depends on how many resources contain it, measured on your instance rather than
guessed from a stop-word list:

- a **rare** fragment (in ≤5% of resources) identifies a bundle on its own — `mushroom` is in
  2 files out of 48, so a file containing it is almost certainly the Mushroom bundle;
- otherwise **two** merely uncommon fragments are needed;
- a fragment in more than a quarter of all resources identifies nothing, and is ignored. The
  log lists these, and `card`, `grid`, `layout` and `entity` are usually among them.

The bias is deliberately toward keeping: a resource kept needlessly costs bytes, a resource
wrongly dropped breaks a card and explains nothing.

Then look at the dashboard. Anything that looks wrong goes in `resources_always_forward`.
Three classes of plugin reliably need it, because none registers a card the config names.
The first two announce themselves; **the third does not**:

- **Frontend patchers** — `kiosk-mode` (without it the HA header and sidebar reappear),
  `custom-sidebar`, and anything that restyles core cards. Loud when missing.
- **Icon packs** — dropping them can blank icons across the dashboard. Loud when missing.
- **Resident behavioural modules** — resources that register no element and are named by no
  dashboard, but run on load and subscribe to state: an idle return-to-home timer, a camera
  pop-up, a heartbeat another system keys on. **Silent when missing.** The dashboard renders
  pixel-identically; only the behaviour stops, and nothing reports it on either side.

That third class is why "load it and see what looks wrong" is not sufficient on its own, and
why this option stays off by default. It is a real failure, not a hypothetical: it was
reported against this feature by someone who had already lost a doorbell pop-up on 28 panels
for three days to the same failure one level down, where entity scoping stripped the helpers
a resident module read. Home Assistant's half kept working, the chime still played, and the
screens simply never lit up.

**The log names this class for you.** Any resource dropped by *every* dashboard is either
genuinely unused or a resident module about to go quietly inert — the proxy can't tell, but
you can:

```
resources: 3 dropped by ALL dashboards (no dashboard references them), 78KB.
  If any of these run on load rather than rendering a card — an idle timer, a
  pop-up, a heartbeat — add them to resources_always_forward. Dropping one of
  those is INVISIBLE: the dashboard renders normally and only the behaviour stops.
    drop     30KB /local/panel-idle.js
```

Check that list before you decide the feature is working.

A note on judging the result: check that Home Assistant has **finished starting** before you
decide a card is broken. During startup HA serves entities as unavailable, and tile features
like `light-color-favorites` render empty — which looks exactly like a missing resource.

