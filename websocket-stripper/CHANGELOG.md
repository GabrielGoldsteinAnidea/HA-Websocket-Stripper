# Changelog

## 0.0.2 — 2026-06-19

- Defensive egress filter: in addition to injecting `entity_ids` (so HA streams only
  the allowlist) and trimming the `get_states` result, the proxy now re-filters the
  `subscribe_entities` event payloads (`a`/`c`/`r`) to the allowlist on the way out.
  Normally a no-op, but it guarantees the full entity firehose can never reach the
  browser even if a future HA ignored the `entity_ids` subscription filter.

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
