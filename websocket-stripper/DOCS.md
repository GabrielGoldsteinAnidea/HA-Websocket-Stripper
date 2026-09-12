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
| `scope_per_connection` | bool | `false` (default). When `true`, a connection receives only the dashboards mapped to the HA user it signed in as, instead of the union of all of them. See [Per-connection scoping](#per-connection-scoping). |
| `scope_by_user` | list of `{user, dashboards}` | The map `scope_per_connection` reads. `user` is the HA user's **id**; `dashboards` is a subset of `dashboards` above. |
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

## Per-connection scoping

**The problem it solves.** The allowlist is the **union** of every dashboard in `dashboards`, and
every connection gets all of it. With two or three lean kiosks that is fine. It stops being fine as
the list grows, because adding a dashboard grows what *every other* kiosk receives — the trim you
measured on day one quietly erodes, and nothing tells you. On a 50-dashboard fleet, measured: a
panel held **535** entities where its own dashboard needed **148**, and adding three dashboards took
one panel from 149 to 187 **without that panel being touched**.

Tuning `dashboards` cannot fix it. On that fleet 183 entities appeared on exactly one dashboard and
only 125 on all 50, so even deleting every shared entity would leave hundreds.

**Why it keys on the user.** The websocket is a *separate connection* from the page load, so it
carries no dashboard path — the proxy cannot tell which dashboard you are about to open. It can tell
**who you are**: the browser's `auth` frame crosses the proxy, and one `auth/current_user` call
answers it. So the requirement is that **each kiosk signs in as its own HA user**. One shared login
cannot be told apart.

```yaml
dashboards:
  - kitchen-kiosk
  - hallway-kiosk
scope_per_connection: true
scope_by_user:
  - user: 3f2a...            # Settings → People → the user → the id in the URL
    dashboards: [kitchen-kiosk]
  - user: 8c1b...
    dashboards: [hallway-kiosk]
```

**Use the user *id*, not the display name.** The id survives a rename; a name does not — and a scope
that stops matching does not fail loudly, it falls back to the union, which looks like nothing
happening.

**Everything unrecognised falls back to the union**, i.e. to the behaviour you get with the option
off: a user with no scope, a lookup that fails or times out, a scope naming a dashboard that is not
in `dashboards`. That is deliberate — an *empty* allowlist means "no filter" to Home Assistant, so
falling back to nothing would relay the entire firehose. It does mean a misconfigured scope is
silent, so **check the log**: a scoped connection prints `scoped connection: user 3f2a… ->
kitchen-kiosk (148 entities, union is 535)`, and a scope naming an unserved dashboard warns at boot.

**A side effect worth knowing about.** When the allowlist grows, open connections are dropped so the
frontend reconnects and picks up the new entities. Under a union, *any* growth is growth for
everyone — so a registry event anywhere recycles every kiosk at once. On the fleet above that was 8
whole-fleet reconnect storms in 76 minutes, and only 1 of 20 recomputes came from anyone editing a
dashboard. With scoping on, a dashboard edit reaches the kiosks showing that dashboard and nobody
else.

## Notes & limits

- Trimming only affects the **entity** stream (`get_states` / `subscribe_entities`).
  Registries, lovelace config, translations, and the frontend JS bundles pass through.
- Cards referencing entities outside the allowlist will show "unavailable". The allowlist
  is computed generously (all views + template-referenced ids), but if something's
  missing add it via `always_forward`.
- **Panel-side JavaScript that *reads* an entity needs it in `always_forward`.** The bullet
  above is the *visible* failure: a card goes "unavailable" and you go looking for it. There
  is a silent one. A resource that runs on load and subscribes to state — an idle
  return-to-home timer, a camera pop-up, a heartbeat another system keys on — reads entities
  that appear on **no card**, so the allowlist never contains them. The module then sees
  nothing, does nothing, and reports nothing: the dashboard renders pixel-identically and
  Home Assistant's own side keeps working normally.

  **JavaScript that only *writes* an entity does not need forwarding**, because
  `callService` is resolved server-side — the write lands whether or not the entity is in
  that page's `states` map. The asymmetry is worth knowing before widening an allowlist: a
  per-panel helper that every kiosk *writes* on a heartbeat can stay out of it, while the
  one `input_text` the same module *reads* has to go in.

  Measured on a 49-panel fleet: four helpers driving a doorbell camera pop-up were missing
  from `always_forward`, so the module went inert on all of them. It took three days and a
  person noticing the screens hadn't lit up — the chime still played, because that is Home
  Assistant driving a media player rather than the panel.
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
