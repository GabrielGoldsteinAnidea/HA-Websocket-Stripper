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

The proxy passes all HTTP straight through to HA (frontend bundles, auth, registries,
lovelace config, custom-card resources — untouched). It intercepts only `/api/websocket`:

- rewrites `subscribe_entities` (no filter) to include `entity_ids = <allowlist>`, so HA
  streams only those entities;
- filters the `get_states` response to the allowlist.

Everything else passes through unchanged, so the real frontend renders normally.

The **allowlist** is the union of the entities used by each configured dashboard
(computed from its `lovelace/config`: card tree walk + `auto-entities` expansion + a
scan for entity ids referenced inside templates), plus your `always_forward` and minus
your `never_forward` overrides.

## Install as a Home Assistant add-on

1. HA → **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add:
   `https://github.com/GabrielGoldsteinAnidea/HA-Websocket-Stripper`
2. Install **WebSocket Stripper**, open **Configuration**, set your dashboards:
   ```yaml
   dashboards:
     - fridge-status
     - home-status
     - dashboard-deck
   always_forward: []          # e.g. ["/^sun\\./", "person.gabriel"]
   never_forward: []           # e.g. ["/_battery$/"]
   strip_entities: true
   ```
3. Start it. Browse `http://<ha-host>:8099/fridge-status` (the port is remappable under
   the add-on's **Network** tab). Point your kiosk/fridge browser there.

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
   won't match an IPv4 `trusted_networks` subnet; the add-on strips that prefix for you.

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

## Run locally (dev, no add-on)

```bash
cd websocket-stripper
npm install
HA_TOKEN="<long-lived-token>" \
  HA_BASE="http://homeassistant.mgmt:8123" \
  DASH_PATHS="fridge-status,home-status,dashboard-deck" \
  node ha_ws_trim_proxy.mjs
# then open http://localhost:8099/fridge-status
```

Set `STRIP_ENTITIES=0` to passthrough untrimmed for an A/B load comparison.

## Notes

- The frontend JS bundles still load (and are cached after first visit); this targets the
  per-load entity firehose, which is the part that scales with instance size.
- The allowlist is computed at **startup**. Restart the add-on after editing a dashboard's
  cards (auto-refresh on `lovelace_updated` is a planned improvement — see `CLAUDE.md`).
- See `CLAUDE.md` for architecture/decisions and `websocket-stripper/DOCS.md` for option
  details.
