# HA WebSocket Stripper

A reverse proxy that serves your **real** Home Assistant dashboards (real frontend,
real cards — Mushroom, button-card, everything) but **trims the entity websocket** so a
kiosk page only subscribes to the entities that dashboard actually uses. On a big
instance (thousands of entities) this cuts the startup `get_states` / `subscribe_entities`
firehose down to a few dozen entities, so dashboards load fast — with **zero visual
approximation**, because it *is* the real frontend.

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
   trim: true
   ```
3. Start it. Browse `http://<ha-host>:8099/fridge-status` (the port is remappable under
   the add-on's **Network** tab). Point your kiosk/fridge browser there.

No long-lived token needed in the add-on — it uses the add-on's `SUPERVISOR_TOKEN` to
read the dashboard configs.

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

Set `TRIM=0` to passthrough untrimmed for an A/B load comparison.

## Notes

- The frontend JS bundles still load (and are cached after first visit); this targets the
  per-load entity firehose, which is the part that scales with instance size.
- The allowlist is computed at **startup**. Restart the add-on after editing a dashboard's
  cards (auto-refresh on `lovelace_updated` is a planned improvement — see `CLAUDE.md`).
- See `CLAUDE.md` for architecture/decisions and `websocket-stripper/DOCS.md` for option
  details.
