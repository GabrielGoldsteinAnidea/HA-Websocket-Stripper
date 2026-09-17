# HA WebSocket Stripper — make slow Home Assistant dashboards load fast

> **Speed up slow-loading Home Assistant dashboards on large instances.** A lightweight
> reverse-proxy add-on that serves your *real* Lovelace dashboards but strips the entity
> WebSocket down to only what each dashboard uses — so kiosks, wall panels, tablets, and
> Fully Kiosk Browser displays load in a fraction of the time, with zero loss of fidelity.

**Keywords:** Home Assistant slow dashboard, Lovelace performance, kiosk / wall-panel
load time, large instance with thousands of entities, `subscribe_entities` / `get_states`
firehose, WebSocket optimization, fast HA dashboard, Mushroom & custom-card kiosk.

A reverse proxy that serves your **real** Home Assistant dashboards (real frontend,
real cards — Mushroom, button-card, everything) but **strips the entity websocket** so a
kiosk page only subscribes to the entities that dashboard actually uses. On a big
instance (thousands of entities) this cuts the startup `get_states` / `subscribe_entities`
firehose down to a few dozen entities, so dashboards load fast — with **zero visual
approximation**, because it *is* the real frontend.

## Why this exists

Home Assistant's frontend subscribes to **every entity** in your instance at page load
(`get_states` + `subscribe_entities` with no filter), then streams every state change for
all of them over the WebSocket. On a small setup that's fine. On a large instance — a few
thousand entities, plus heavy custom cards (Mushroom, button-card, auto-entities,
mini-graph-card) — that startup firehose makes dashboards **slow to load and sluggish to
interact with**, which is especially painful on low-powered kiosks, wall tablets, and
fridge/door displays that just need to show a handful of entities.

HA has no built-in way to tell a single dashboard "only subscribe to the entities I
actually render." This add-on adds exactly that, **without** rebuilding your dashboards or
sacrificing fidelity: it's a transparent proxy in front of HA that auto-detects each
dashboard's entities and trims the subscription at the source. You keep your real cards
and themes; the page just stops downloading and tracking thousands of irrelevant entities.

## How it works

The proxy passes all HTTP straight through to HA (frontend bundles, auth, custom-card
files, lovelace config). It intercepts only `/api/websocket`, where it:

- rewrites `subscribe_entities` (no filter) to `entity_ids = <allowlist>`, so HA streams
  only those entities;
- filters the `get_states` response to the allowlist;
- trims the **entity, device and area registries** to what the connection can see —
  including `config/entity_registry/list_for_display`, which on a large instance is the
  single biggest payload the frontend fetches;
- optionally trims the **Lovelace resource list**, so a dashboard is sent only the custom
  cards it actually renders instead of every card installed (off by default);
- **compresses** the websocket, which Home Assistant's own does and the `ws` library
  does not do by default.

Everything else passes through unchanged, so the real frontend renders normally.

The **allowlist** is the union of the entities used by each configured dashboard
(computed from its `lovelace/config`: card tree walk + `auto-entities` expansion + a
scan for entity ids referenced inside templates), plus your `always_forward` and minus
your `never_forward` overrides.

`auto-entities` filter cards are expanded against your live entities **and registries**, the
same way HA's frontend resolves them:

| Filter key | Resolved how |
|---|---|
| `entity_id`, `domain` | matched directly |
| `area`, `label`, `device`, `integration` | via the HA registries (matches id **or** name) |
| `name` | against `friendly_name` |
| `group` | expands to the group's members |
| `template` | rendered through HA, then real entity ids are taken from the output |
| `state`, `attributes` | **over-included** — an entity that doesn't match right now is still forwarded, so the card shows it when it later does |

Every one of those accepts an exact id, a `*` glob (anchored), or a `/regex/` (**not**
auto-anchored — supply your own `^`/`$`), matching auto-entities' own behaviour. Entities are
also pulled in **transitively through groups**, so a card naming a group — or expanding one
client-side, like `enhanced-shutter-card`'s `show_group_members` — gets its members too, even
though they appear nowhere in the dashboard config.

The allowlist **recomputes live** when you edit a dashboard or change area/label/device
assignments — no add-on restart, and no kiosk reload either: when a rebuild *adds* entities,
open dashboard connections are dropped so the frontend reconnects and picks them up on its
own.

## Install as a Home Assistant add-on

1. HA → **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add:
   `https://github.com/GabrielGoldsteinAnidea/HA-Websocket-Stripper`
2. Install **WebSocket Stripper**, open **Configuration**, and set `dashboards` to your own
   dashboards' `url_path` values (Settings → Dashboards). It ships **empty** — until you set
   it, the add-on refuses `/api/websocket` and says so in the log, rather than silently
   serving the untrimmed firehose:
   ```yaml
   dashboards:
     - kitchen-panel           # <-- your dashboards' url_path values
     - hallway-kiosk
   always_forward: []          # e.g. ["/^sun\\./", "person.alex"]
   never_forward: []           # e.g. ["/_battery$/"]
   strip_entities: true
   trim_registries: true       # also cut the entity/device/area registries
   compress_websocket: true    # leave on: HA's own websocket compresses too
   trim_resources: false       # off by default — see DOCS.md before enabling
   ```
   Every option has a name and description in the **Configuration** tab, so you can read
   what each does without leaving Home Assistant.
3. Start it. Browse `http://<ha-host>:8099/<your-dashboard>`. Point your kiosk browser
   there. To move it off `8099` (e.g. it collides with Zigbee2MQTT), set the `port` option
   — because the add-on runs `host_network: true`, the **Network** tab can't remap it.

> **Tip — keep broad admin dashboards out of the `dashboards` list.** The allowlist is the
> *union* of every listed dashboard, so a big admin/overview dashboard built on wide
> `auto-entities` filters (`integration:`, whole-`area:`) can legitimately resolve to
> thousands of entities and erase most of the trimming benefit. List only the lean kiosk
> dashboards you actually serve; the trim is dramatic for those (dozens of entities) and
> pointless for a dashboard that shows most of the instance anyway.

No long-lived token needed in the add-on — it uses the add-on's `SUPERVISOR_TOKEN` to
read the dashboard configs.

## Passwordless kiosk login (trusted_networks)

For a wall panel / fridge kiosk you usually don't want a password prompt. HA's
[`trusted_networks`](https://www.home-assistant.io/docs/authentication/providers/#trusted-networks)
auth provider shows a "pick a user" screen (or auto-selects one) for clients on trusted
IPs. To make it work **through this proxy**, HA must see the real browser IP — and getting
that right has two subtle requirements, both handled by this add-on out of the box:

1. **The add-on runs with `host_network: true`** (built in). This is essential: with a
   *mapped* port, Docker rewrites every client to the gateway `172.30.32.1` before the
   proxy ever sees it, so the kiosk's real IP is lost and trusted login can never match.
   Host networking lets the add-on see the real browser IP.
2. **The add-on forwards that IP via `X-Forwarded-For`, normalized to plain IPv4** (built
   in). Node reports dual-stack clients as IPv4-mapped IPv6 (`::ffff:192.168.1.50`), which
   won't match an IPv4 `trusted_networks` subnet; the add-on strips that prefix for you, on
   both HTTP requests and websocket upgrades.

Because of `host_network`, HA sees the proxied request coming from the **host itself**, so
trust the host (not the add-on docker subnet) in your HA `configuration.yaml`:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
    # - 192.168.1.2          # also add the host's own LAN IP if the add-on reaches HA via it

homeassistant:
  auth_providers:
    - type: trusted_networks
      trusted_networks:
        - 192.168.1.0/24      # <-- your kiosk's LAN subnet
      allow_bypass_login: true # skip the form entirely where one user is unambiguous
      # optional: auto-select a user per IP instead of showing the picker
      # trusted_users:
      #   192.168.1.50: <user-id-from-Settings-People>
    - type: homeassistant      # keep this, or you lose password login entirely
```

Then **restart HA Core** (`use_x_forwarded_for` and `auth_providers` are core-config
changes, not a YAML quick-reload).

> ℹ️ **Note:** because the proxy presents requests to HA from the host, anyone who can
> reach the add-on's port effectively gets trusted-network login. That's the point for a
> kiosk on a trusted LAN, but it does mean the trimmed dashboards are reachable without a
> password by anything on that network — size your `trusted_networks` accordingly.

> 🛠️ **If `host_network` breaks startup** (the add-on can't resolve the internal
> `homeassistant`/`supervisor` hostnames), set the `ha_base` / `allow_ws_url` options to
> pin them to IPs, e.g. `ha_base: http://192.168.1.2:8123`.

## Behind another reverse proxy (Caddy / nginx / Traefik, HTTPS)

Putting your own reverse proxy in front of the add-on works — useful for TLS termination and
external access, and required for browser features that only work on a secure origin (mic
input for Assist, for instance).

The add-on **preserves the `X-Forwarded-For` chain** rather than replacing it, so HA sees the
real browser IP through both hops and `trusted_networks` still matches the kiosk, not your
edge proxy. Make sure HA trusts every hop:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1               # the stripper (reaches HA from the host, via host_network)
    - ::1
    - 192.168.1.5             # your Caddy / nginx host, if it's a different machine
```

> **Note:** versions before 0.2.3 flattened that chain, which made HA reject every proxied
> request with **400 Bad Request** (`Incorrect number of elements in X-Forward-Proto`) while
> a direct connection to `:8123` worked fine. If you hit that, update.
>
> **Also fixed in 0.2.4:** an infinite redirect loop behind an HTTPS terminator (the page
> URL growing `:8123./:8123./…`), and login sending the browser — or the companion app — to
> HA's LAN address. Redirects and the auth flow's `redirect_uri` are now rewritten to the
> origin the browser actually used.

## Run locally (dev, no add-on)

```bash
cd websocket-stripper
npm install
HA_TOKEN="<long-lived-token>" \
  HA_BASE="http://homeassistant.mgmt:8123" \
  DASH_PATHS="kitchen-panel,hallway-kiosk" \
  node ha_ws_trim_proxy.mjs
# then open http://localhost:8099/kitchen-panel
```

Run `npm test` for the suite (extractor + registry/filter resolution unit tests, plus
integration tests that drive the real proxy against a mock HA).

Set `STRIP_ENTITIES=0` to passthrough untrimmed for an A/B load comparison.

## Notes

- The frontend JS bundles still load (and are cached after first visit); this targets the
  per-load entity firehose, which is the part that scales with instance size. Custom-card
  bundles can additionally be trimmed per dashboard with `trim_resources`, which is off by
  default — read the tuning section in `DOCS.md` first, because a wrongly dropped resource
  can fail *silently*.
- The allowlist **recomputes live** on dashboard edits and registry changes, and open kiosk
  pages reconnect themselves when it grows. Adding a whole new dashboard to the `dashboards`
  option still needs an add-on restart (options are read at boot).
- Each recompute logs the exact `+added` / `-removed` entity diff, so you can see from the
  add-on log what a dashboard edit changed.
- **Restarting Home Assistant is safe.** The add-on stays up and waits: HTTP degrades to 502
  while core is down, then it reconnects, rebuilds, and open dashboards recover on their own.
  Same at host boot, when the add-on starts before core is listening.
- Cards can still show "unavailable" if a filter type isn't supported yet — currently `not`,
  `and`, `or`, `floor`, `device_manufacturer`, `device_model`, `last_changed`. List those
  entities in `always_forward` and open an issue.
- A **local** add-on bakes the code into its image at build time, so updates need a
  **Rebuild**, not a Restart.
- See `CLAUDE.md` for architecture/decisions and `websocket-stripper/DOCS.md` for option
  details.

## Support

If this saved you an evening of debugging, a coffee is appreciated.

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/gabrielgoldstein)

## What's new in 0.2.4

Full history in [`websocket-stripper/CHANGELOG.md`](websocket-stripper/CHANGELOG.md).

- **Fixed the redirect loop behind an HTTPS reverse proxy** (Caddy / NPM / DuckDNS) — the
  proxy now rewrites a redirect's scheme as well as its host, so `https://` pages no longer
  bounce to `http://` and back forever.
- **Login through the proxy works from outside the LAN**, and **the companion app works** —
  the auth flow's `redirect_uri` is rewritten to the origin you connected through instead of
  HA's internal address.

### 0.2.3


- **auto-entities globs and regexes work on every filter key** — `/^sensor\.pv_.*_power$/`
  and friends resolve instead of matching nothing, on `domain` / `area` / `label` / `device`
  / `integration` / `name`, not just `entity_id`.
- **`filter: template:` cards resolve** — rendered through HA rather than skipped.
- **Group members are pulled in transitively**, so cards that expand a group client-side
  (`show_group_members`) stop showing their members as "unavailable".
- **Fixed 400 Bad Request behind another reverse proxy** — the `X-Forwarded-For` chain is
  preserved, so Caddy / nginx / Traefik in front of the add-on works.
- **Open dashboards pick up new entities by themselves** — no more reloading every wall panel
  after a dashboard edit.

### 0.2.2 — important if you're upgrading from ≤ 0.2.1

- **An empty allowlist is never forwarded as "no filter" again.** HA reads
  `set(msg["entity_ids"]) or None`, so an empty `entity_ids` meant *no filter at all* — and
  because `dashboards` used to default to the author's own dashboards, a fresh install
  resolved nothing and relayed **every entity on the instance**, the exact opposite of the
  point. `dashboards` now defaults to `[]` and the websocket is refused (with the reason
  logged) rather than sending an empty filter.
- **Surviving an HA restart** — the add-on no longer crash-loops when core goes away.

### 0.2.0

- **auto-entities `area` / `label` / `device` / `integration` filters resolve** against the
  registries, so you don't have to hand-list them in `always_forward`.
- **Configurable `port` option** — coexist with other add-ons on busy hosts.
- **Recompute logs the `+added` / `-removed` entity diff**, not just the total.
- **Defensive egress filter** re-filters `subscribe_entities` event payloads to the
  allowlist on the way to the browser — a belt-and-suspenders guarantee the firehose can't
  leak even if a future HA ignored the subscription filter.
- Added a test suite (`cd websocket-stripper && npm test`): unit tests for the extractor +
  registry resolver, and integration tests that run the real proxy against a mock HA.
