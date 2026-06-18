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
`http://homeassistant.local:8099/fridge-status`. The host port is remappable on the
**Network** tab. Point your kiosk browser at that URL.

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

## Notes & limits

- Trimming only affects the **entity** stream (`get_states` / `subscribe_entities`).
  Registries, lovelace config, translations, and the frontend JS bundles pass through.
- Cards referencing entities outside the allowlist will show "unavailable". The allowlist
  is computed generously (all views + template-referenced ids), but if something's
  missing add it via `always_forward`.
- The allowlist is computed at **startup** — restart the add-on after changing a
  dashboard's cards.
- Navigating (via the HA sidebar) to a dashboard **not** in `dashboards` will show its
  entities as unavailable; add it to the list if you want it served too.
