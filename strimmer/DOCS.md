# Strimmer

Serves your real Home Assistant dashboards but only forwards the entities each dashboard
uses, so kiosk/wall-panel pages load fast on large instances — with no loss of fidelity
(it's the real frontend and real cards).

## Configuration

Options can be set here or, for most of them, from the **Config** tab in the app's own
sidebar panel — see [The Config tab](#the-config-tab).

**Upgrading?** Nothing is required: every old option name and every older override list is
still read. See [docs/MIGRATING.md](../docs/MIGRATING.md) for what was renamed and why.

| Option | Type | Description |
|--------|------|-------------|
| `dashboards` | list of strings | Dashboard `url_path`s to serve (e.g. `fridge-status`). The forwarded entity set is the **union** of all of them, so you can navigate between them. Find a dashboard's `url_path` in Settings → Dashboards. |
| `always_forward` | list | Entities to forward even if no listed dashboard uses them. Each item is a literal `entity_id` or a `/regex/` (matched against all entities). |
| `never_forward` | list | Entities to never forward. Applied last — **wins** over `always_forward` and dashboard detection. Literal or `/regex/`. |
| `trim_entities` | bool | `true` (default) trims the websocket to the allowlist. `false` = full passthrough (for A/B comparison). *(Was `strip_entities`, still accepted.)* |
| `by_dashboard` | bool | `true` (default) serves each connection only the dashboard it is actually viewing, instead of the union of every dashboard in `dashboards`. A panel showing one dashboard stops paying for the others. The dashboard is inferred from the page request that immediately precedes the websocket; a connection that can't be attributed falls back to the union, so nothing is ever served *less* than it was before this option existed. **Limit:** navigating to another dashboard *without* a page reload keeps the allowlist the connection opened with, so that dashboard's own entities show as unavailable until reload — see below. `false` = always serve the union (pre-2026.09 behaviour). *(Was `per_dashboard`, still accepted.)* |
| `trim_registries` | bool | `true` (default) also trims the entity/device/area registries to what the connection can see, **including `config/entity_registry/list_for_display`**, which is typically the single largest payload the frontend fetches (1.44MB of a 2.46MB load on a 9,553-entity instance). Once states are trimmed this is the largest remaining payload on a big instance — it is one row per entity for the *whole* install. Devices and areas are kept wherever a surviving entity still reaches them, so names and area assignments keep resolving. Turn this **off first** if names, areas or device links render oddly. |
| `trim_services` | bool | `false` (default). Cuts `get_services` to the domains the connection can see. It carries every service of every integration and is sent on every page load — **193KB across 115 domains** on the instance this was built against, where only **45 domains** had any entity. `homeassistant` is always kept, since its services are domain-agnostic. Off by default because the frontend uses this for service pickers and the automation editor. |
| `trim_themes` | bool | `false` (default). Home Assistant sends **every installed theme** to every client on every page load — 10 themes and 28,138 bytes measured, of which a panel renders one. Keeps the themes your dashboards name (the whole config tree is walked, since a `theme:` can sit on a dashboard, a view or a card) plus HA's current default and dark default, read from the reply itself so a dark default nothing mentions still survives. If the trim would keep nothing, the full list is sent — an unthemed dashboard is worse than a large one. |
| `trim_repairs` | bool | `false` (default). Empties `repairs/list_issues`, the admin Repairs panel's backlog — **26,894 bytes on every page load**, measured live, and a kiosk never renders it. The list is *emptied*, not withheld: the frontend asks and waits, so a missing reply would leave that request pending forever while an empty list is a valid "nothing to report". Off by default because an admin browsing a trimmed dashboard stops seeing repair notifications there. |
| `trim_translations` | bool | `false` (default), and **the most lossy option here**. Cuts `frontend/get_translations` to the integrations a connection can see — the largest untrimmed payload in a page load, measured at **5,359 keys / 432 KB across 69 integrations**, of which `tuya_local` alone carried 823 keys to panels showing none of it. Typically **~190 KB saved per load**. A tree is kept when it matches *either* an entity domain the connection can see *or* the integration providing one of its entities — both are needed, because a Tuya sensor's state names live under `component.tuya_local` while its entity_id says `sensor`. Anything not shaped `component.<x>.…` passes through untouched. **Unlike every other trim here, failure is visible**: a missing translation renders its raw key on the dashboard, e.g. `component.light.entity_component._.state.on` where "On" should be. Turn it on, load every panel, and look. |
| `log_level` | enum | `warn` / `info` (default) / `debug`. `info` is exactly what this always wrote, so upgrading changes nothing. `warn` keeps problems plus the startup summary — worth having because a busy instance turns over ~22 websocket connections a minute and each one wrote a line. `debug` adds per-connection and per-decision detail written at no other level: which dashboard a connection was attributed to, which resource matched which card, and cache hits. Noisy on purpose; turn it back down afterwards. |
| `compress_websocket` | bool | `true` (default) negotiates `permessage-deflate` with the browser, as HA's own websocket does. The `ws` library does not enable this server-side by default, so without it this app *removes* compression that HA would have provided — kiosks receive plaintext JSON. Deflate runs on libuv's threadpool, not the main loop. Set `false` only on very weak hardware where the CPU costs more than the bytes saved. |
| `trim_resources` | bool | `false` (default). Trims **Lovelace resources** (custom cards) per dashboard. Resources are instance-wide in HA, so every kiosk downloads and parses every custom card you have installed — 21MB of JavaScript for a 4-card wall panel on the instance this was built against. A resource is kept when the dashboard's card types (or non-builtin icon prefixes) appear in its file. **Off by default**, and see the tuning section below before turning it on — some resources fail *silently* when dropped. Every drop is logged with its size. |
| `dashboard_overrides` | list | Per-**dashboard** always/never lists. The global lists above are right for something every dashboard needs and wrong for something only one needs, because every panel then pays for it. Each entry takes a `dashboard` (its `url_path`) plus its own `always_forward` / `never_forward`, same syntax as the global lists. The global `never_forward` still wins last. |
| `user_overrides` | list | Per-**user** always/never lists — the one thing per-dashboard rules cannot express: two people opening the *same* dashboard who should not be served the same entities. Give the user's name as shown in Settings → People (or their user id). Add `dashboard` to scope a rule to one dashboard, so "David sees `update.*` on lovelace" does not follow him onto a wall panel. Identity comes from the browser's own access token, resolved once per session against `auth/current_user`. **Cost:** a connection that a rule *could* match is held until the user resolves. Connections whose dashboard no rule is scoped to skip the lookup entirely, so scoping your rules is also a speed optimisation. Leave this empty and no lookup ever happens. |
| `client_overrides` | list | Per-**device** always/never lists, pinned to a physical client rather than to a dashboard or a user. Some entities belong to the machine in front of you, not to the page it happens to be showing — a browser-based voice satellite is the clearest case, where the satellite's entities are only ever useful to the one panel that *is* that satellite. A dashboard rule gets that wrong both ways: the panel loses them when it navigates elsewhere, and every other client opening that dashboard pays for them. Each entry takes a `client` — an IP, an IPv4 CIDR (`10.2.4.0/24`), or a hostname — plus `devices` and/or `always_forward` / `never_forward`. `devices` names whole **devices** by registry name or id and pulls in every entity that device owns, which keeps working when an integration adds entities in a later release. Hostnames resolve when the allowlist is built, so a moved DHCP lease is picked up on the next rebuild; note mDNS/`.local` names generally do **not** resolve from inside a container, so use a real DNS record. |
| `always_forward_device_class` | list | Empty by default. Forward every entity whose `device_class` matches, for cards that scan all states at runtime (a battery list, a window-rose) and so name nothing a config walk can find. Write `battery`, or `sensor:battery` to limit it to one domain. Matched against live state at every rebuild, so a new battery sensor joins on the next one. Over-includes by design; settable in the console's Config tab too. |
| `exclude_device_categories` | list | Empty by default. When a **device** is expanded — by a card configured with a device rather than entities, or by a `client_overrides` rule — drop entities Home Assistant labels `config` (controls that configure the device: panel brightness, a reset button, a firmware update) or `diagnostic` (readings about its health: last seen, signal, status code). A litter robot carries 21 entities and a card rendering a fill level needs a handful. **Empty on purpose:** whether a given card renders a diagnostic sensor is not knowable from here, and a wrongly dropped entity blanks part of a card with no error anywhere. Every device expansion logs its split — `+21 entities (8 primary, 7 config, 6 diagnostic)` — so decide with the real numbers for *your* devices in front of you. Note a browser voice satellite measured 18 of 21 entities as `config`, because its pipeline and wake-word selects are configuration controls that the page's JavaScript nonetheless reads to work. |
| `resources_always_forward` | list | URL patterns (literal substring, or `/regex/`) always sent. Needed for plugins that patch the frontend instead of registering a card — they contain none of the dashboard's card names, so the content match cannot tell they're used. In practice: icon packs, and anything that restyles core cards. A module with its own top-level config block on the dashboard (`kiosk_mode:`, `swipe_nav:`) is detected from that block and does not need listing. |
| `resources_never_forward` | list | URL patterns never sent to any dashboard. Wins over `resources_always_forward`. |
| `overrides` | list | **One list for every override rule.** Each rule may match on a dashboard, a Home Assistant user, a role, how they signed in, the device kind announced over mDNS, the entry point they arrived through, a device address, and a client app — and the matchers you set must **all** hold. See *Override rules* below. The four older lists (`dashboard_overrides`, `user_overrides`, `client_overrides`, `user_agent_dashboards`) still work and are read into this same list at startup, so nothing needs changing. |
| `client_api_access` | enum | `lan` (default) / `any` / `off`. Who may reach `/strimmer/client.json` (and `/stripper/client.json`, the pre-rename path, which still answers), the endpoint a wall panel uses to show whether this app is in front of it. `lan` refuses internet and Cloudflare requests **before** the token is checked. A Home Assistant token is required either way — this narrows who may try, it does not replace authentication. See [Client status API](../docs/CLIENT-API.md). |
| `client_api_allow` | list | Addresses or CIDRs allowed to reach that endpoint whatever `client_api_access` says — for a panel on a subnet this app does not consider local. |
| `proxy_port` | int | Port browsers and wall panels connect to (default `9123`). The older name `port` is still accepted. Because it runs with `host_network: true`, this option is how you move it off `9123` — the **Network** tab can't remap a host-network port. Change it if `9123` collides with another app (e.g. Zigbee2MQTT). |
| `mgmt_port` | int | Where the console and its JSON API listen (default `9122`). The older name `stats_port` is still accepted. **Only the default is reachable from the sidebar** — Home Assistant routes the Ingress panel to `ingress_port`, fixed at install time. Move this and the console is still served directly at `http://<host>:<port>/`, and the app says so in its log when the two differ. |
| `ha_base` | string | Optional. Override the Home Assistant base URL the app proxies to (default `http://homeassistant:8123`). Set this if `host_network` is on and the internal `homeassistant` hostname doesn't resolve — e.g. `http://192.168.4.2:8123`. |
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
trim_entities: true
```

Regex entries are slash-wrapped with optional flags, e.g. `"/_motion$/i"`. In YAML,
backslashes must be escaped (`"\\."`).

### Override rules

One list, `overrides`, holds every rule. A rule is **matchers** plus **effects**: set as many
matchers as you like and they must all hold, then the effects apply.

| Matcher | Matches |
|---------|---------|
| `dashboard` | A dashboard's `url_path`. |
| `user` | A Home Assistant user, by the name in Settings → People, or by user id. |
| `role` | `admin` or `user`. Home Assistant has exactly these two. Attaches entities to *whoever* is an administrator rather than to a named person — which is usually what a per-user rule is approximating. |
| `auth_provider` | `homeassistant` (password) or `trusted_networks`. "Anything logged in through trusted networks" is the kiosk pattern without naming a device: addresses move, the login method does not. |
| `mdns_kind` | What the device announces itself as over mDNS — `Kiosk Satellite`, `ESPHome`, `ha-paneld`, `Cast`. Matches **any** record for that address: a panel commonly advertises more than once, with a different version on each. |
| `entrypoint` | The hostname the client arrived on, since one instance is reachable by several names. *(Was `host`, still accepted.)* |
| `client` | An IP, an IPv4 CIDR (`10.2.4.0/24`), or a hostname. Hostnames resolve when the allowlist is built, so a moved DHCP lease is picked up on the next rebuild; note mDNS/`.local` names generally do **not** resolve from inside a container. |
| `user_agent` | Part of the client's User-Agent, literal or `/regex/`. |

| Effect | Does |
|--------|------|
| `always_forward` | Entities to send, literal or `/regex/`. |
| `never_forward` | Entities to withhold. The global `never_forward` still wins last. |
| `devices` | Whole **devices** by registry name or id, pulling in every entity that device owns — which keeps working when an integration adds entities in a later release. |
| `resources_always_forward` | Lovelace resources to send this connection whatever its dashboard references — URL fragments, literal or `/regex/`, like the global list. This is how one panel gets a bundle that runs on load without a card: a browser voice satellite's engine is injected into every page *and* registered as a resource, no dashboard places the card, so the trim rightly drops it everywhere, and the one panel that *is* the satellite needs it back. The global list would hand that bundle to every other panel too. Reaches both the resource list and, with `trim_extra_modules`, the page. |
| `resources_never_forward` | Resources to withhold from this connection. Wins over the rule's own always list. |

```yaml
overrides:
  # "this dashboard needs an entity none of its cards name"
  - dashboard: hallway-kiosk
    always_forward: ["input_boolean.hallway_night_mode"]

  # "administrators see update.*, whoever they are"
  - role: admin
    always_forward: ["/^update\\./"]

  # "this panel IS a voice satellite, wherever it navigates" — its entities, and the engine
  # that runs it, which no dashboard names and no other panel needs
  - client: 10.2.4.109
    devices: ["Basement Stairs Panel"]
    resources_always_forward: ["voice-satellite-card"]

  # "every Kiosk Satellite panel arriving through the IoT entry point"
  - mdns_kind: Kiosk Satellite
    entrypoint: home-iot.example.org
    always_forward: ["/^assist_satellite\\./"]
```

**When each rule is decided.** A rule is evaluated at the latest moment its matchers can all be
known. `dashboard`, `client`, `entrypoint`, `mdns_kind` and `user_agent` are known when the socket
opens. `user`, `role` and `auth_provider` are **identity**, which only resolves once the browser's
auth token has been checked — so a rule naming any of them holds the connection's messages until
that lookup returns. One consequence for the resource effects: a page load carries no token, so an
identity-keyed rule cannot be applied to the page's injected-module list. It still applies to the
resource list, and the frontend imports every resource in that list, so the bundle loads either way. Connections whose dashboard no such rule is scoped to skip the lookup
entirely, so scoping your rules is also a speed optimisation.

**A rule with no matcher is ignored** and logged. That is what the global `always_forward` /
`never_forward` lists already are, and silently applying an "override" to every connection is not a
reasonable reading of a rule someone thought they were scoping.

**mDNS is not a credential.** An mDNS name is a label a device chose for itself, unverified and
trivially spoofable by anything on your network. It is fine for "serve this panel more entities"
and is **not** a security boundary.

The startup log counts the rules by matcher, so "my override does nothing" has a first answer:

```
overrides: 4 rule(s) — 2 keyed to a user, 0 to a role, 2 to a device, 2 to a dashboard,
           0 to a client app, 0 to a device kind, 0 to an entry point, 0 to a sign-in method
```

## Usage

After starting, browse to `http://<ha-host>:9123/<dashboard-url-path>`, e.g.
`http://homeassistant.local:9123/fridge-status`. Point your kiosk browser at that URL.

> **Port:** because this app runs with `host_network: true` (see the tradeoff below),
> it binds directly on the host and the **Network** tab cannot remap it. If `9123` collides
> with another app (e.g. Zigbee2MQTT), set the `proxy_port` option instead.

The first visit prompts a normal HA login (it's a different origin); after that it's your
real dashboard.

### Trusted-network (password-less) kiosk login

To let a kiosk skip the password via HA's `trusted_networks` auth provider, the app
must run with `host_network: true` (the default in this app). Without it, Docker
rewrites every client to the gateway IP (`172.30.32.1`) before the proxy sees it, so the
kiosk's real LAN IP never reaches HA and `trusted_networks` can't match it.

On the HA side (`configuration.yaml`), the request now arrives from the **host itself**:

```yaml
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - ::1
    # add the host's own LAN IP too if the app reaches HA via it, e.g. 192.168.4.2
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

This app ships with `host_network: true` on purpose. That single flag is a tradeoff, so
here is exactly what you get and what you give up.

**What it buys you.** The app shares the host's network stack instead of Docker's
bridged network, so HA sees the **browser's real LAN IP**. That is the *only* clean way to
make the trusted-network (password-less) kiosk login above work: in bridged mode Docker
NATs every client to the gateway `172.30.32.1` before the proxy sees it, so the kiosk's
real IP never reaches HA and `trusted_networks` can't match it.

**What it costs.**

- **The port is rigid.** It binds `:9123` on the host directly; the **Network** tab can't
  remap it, so a clash with another app on `9123` can't be fixed there (see #6 above).
- **Internal DNS can break.** The `homeassistant` and `supervisor` hostnames may not
  resolve in host-network mode. If startup fails, pin them to IPs with the `ha_base` and
  `allow_ws_url` options (e.g. `ha_base: http://192.168.4.2:8123`).
- **HA sees the request from the host itself**, so `trusted_proxies` must list
  `127.0.0.1`/`::1` (and optionally the host LAN IP) — not the Docker gateway subnet.
- **A reverse proxy in front of the app must be in `trusted_proxies` too.** The app appends
  its own peer to any `X-Forwarded-For` chain it receives, so HA sees `client, <your proxy>`
  and only reaches the client if it trusts the proxy. That append is deliberate: without it,
  any LAN host could send a forged `X-Forwarded-For` naming a kiosk address and log in
  password-less through `trusted_networks`.

**If you don't need password-less-by-IP login**, none of the above helps you and bridged
mode is simpler (free port remapping, working DNS). Some users run a locally-modified copy
with `host_network: false` for exactly that reason. It is not exposed as an option because
`host_network` is a build-time app setting, not a runtime one — changing it means
editing `config.yaml` and rebuilding. If you log in normally (or with a token) and don't
rely on trusted-network auto-login, that's a reasonable local change; you then trim the
port via the Network tab as usual. The default stays `true` so the documented kiosk login
keeps working out of the box.

## The console

The app registers an Ingress panel, so there is a **Strimmer** entry in the Home Assistant
sidebar. (If it is missing, turn on *Show in sidebar* on the app's own page — Supervisor
stores that flag per install and leaves it off for apps that gained Ingress in an update.)

It has five tabs:

- **Overview** — whether anything needs attention, four measured numbers (payload not sent,
  entities sent, clients open, registry cache hits), what is not being sent, the **pause** card, and
  the last 24 hours as charts;
- **Dashboards** — each dashboard's entity count against the instance, an **entity search** that
  says whether an entity is sent and lets you pin it, and resource kept/dropped figures;
- **Clients** — who is connected now or in the last 24 hours (open a row for its detail), and a flow
  diagram from where each client was, through how it arrived, to the hostname it dialled;
- **Settings** — every option, as switches and lists (below);
- **Diagnostics** — the diagnostics download, what the trim saved, what is flowing, HTTP, runtime.

"Payload not sent" is measured on the answers the app knows how to shrink (before and after
bytes). It is not a comparison with an untrimmed run: the entity stream is cut at the source, so its
untrimmed size is never seen and no such figure is shown.

It follows Home Assistant's settings look. Ingress passes none of HA's theme into the frame, so the
page follows the operating system; the header button cycles **Auto / Light / Dark** and is
remembered per browser. Anything the console changes reports the outcome in a snackbar.

Two JSON endpoints back it, both read-only:

| URL | What |
|---|---|
| `http://<host>:9122/stats.json` | Current snapshot |
| `http://<host>:9122/history.json` | Rolling 24h, 5-minute buckets |

Point a `rest` sensor at either to graph it in Home Assistant itself:

```yaml
sensor:
  - platform: rest
    name: Strimmer entities served
    resource: http://homeassistant.local:9122/stats.json
    value_template: "{{ value_json.allowlist.union }}"
    json_attributes_path: "$.savings"
    json_attributes: [before, after, savedPct]
```

### The Config tab

Options can be changed from the console instead of the add-on's Configuration tab.

**Everything that is on or off is a switch**, in three groups (what to trim, extra trimming, discovery
and network), each with a line saying what it does. Lists (dashboards, always/never forward, resources)
are chips you add and remove under **What to send**. **Advanced** holds the override rules and the
remaining value options.

An option whose change needs a restart says so after you save it. There is no restart button here:
restart the app from its page under Settings → Apps.

**Ownership is per option.** An option is read from the console only when someone has deliberately
changed it there; everything else still comes from the add-on's Configuration tab and still works
exactly as before. A switch or row marked **set here** is owned by the console, and the Configuration tab no
longer applies to it. Taking a setting over never changes it — it is seeded from whatever is
already in effect — and **Use add-on setting** hands it back.

Options are read once at startup, so a change takes effect on the next restart.

**Setup options are deliberately not editable here**: `proxy_port`, `mgmt_port`, `ha_base`,
`allow_ws_url` and `log_level` stay in the add-on's Configuration tab. How the process binds and
finds Home Assistant has to stay fixable from Home Assistant when the console is the thing that is
broken.

#### Adding an override

**Add override** asks what to match on, then what the rule should do. Entity and device fields
search as you type — and still accept anything typed, because an `always_forward` entry is
routinely a `/regex/`, which no list of entity ids can suggest. Deleting a rule takes two clicks,
since the rows look alike and the deletion cannot be undone from the console.

### Download diagnostics

The ⋮ menu has **Download diagnostics** (administrators only). It saves `strimmer-diagnostics.json`: the
version, your options, the allowlist per dashboard, the dashboard configs, entity ids a panel asked
for that were not forwarded, and the stats. Credentials are removed by key name, but read the file
before you post it.

**Editing cards through Strimmer:** the editor's entity pickers only list entities that were
forwarded, so edit dashboards on the untrimmed Home Assistant address.

### Pausing the trim while you troubleshoot

The add-on serves a panel only the entities its dashboard names, which is exactly wrong when you
are trying to find out why something is broken: an entity no card mentions is not there to look
at. **Pause trimming** on the console's Overview tab turns it off for **one hour** or for the
**rest of the day**, and it ends by itself.

It pauses for a **Home Assistant user**, not a browser or an address:

- It follows you from phone to laptop, and through Cloudflare, a VPN or a changed DHCP lease. A
  phone on cellular has no stable address to pin a pause to.
- **Everyone else keeps their trim.** The wall panels are not disturbed and do not reload.
- Who is asking comes from Supervisor's Ingress headers, which are stamped after Home Assistant
  has authenticated the user — there is no field to put somebody else's name in, so you can only
  pause your own.

While it runs, that user's connections are served **everything**: states, registries, services,
translations, themes and repairs all pass through whole. Your open connections are dropped when it
starts and again when it ends, because Home Assistant cannot amend a live `subscribe_entities` —
the page reconnects on its own, so in practice you reload the dashboard you are looking at.

A pause is **not** an access control. It does not hand out anything Home Assistant would refuse
that same token; it stops this add-on filtering what HA is already willing to send. The cost is
performance, which is why it expires.

The console shows a banner for as long as one is running, with **Resume now**. Two sensors report
it as well, so it is visible from outside the console (see below).

#### The switch in Home Assistant

`switch.strimmer_trimming_admins` turns the trim off **for every administrator, for an hour**, from
anywhere you can reach Home Assistant — the app, a dashboard button, an automation, or a voice
command. It is the one-tap path for the case where you are away and stuck; the console is where you
go when you want to choose the duration.

It pauses a **role**, not a person, because the API delivers a command and not an identity — a
switch cannot know who flipped it. Administrators is the scope that matches the purpose: they are who
troubleshoots, and **every kiosk and wall panel keeps its trim** and is never disturbed. The switch
returns to `on` by itself when the hour is up. `ADMIN_PAUSE_MINUTES` (env) changes the span.

The console offers the same thing under **Pause trimming → All administrators**, so the two paths
are one feature.

### Publishing the metrics to Home Assistant

`esphome_api` publishes them over **ESPHome's native API**: Home Assistant's own ESPHome
integration connects to this add-on, and the device appears with its sensors, the trimming binary
sensor and the admin switch — no broker, no custom integration, no YAML.

It is **off by default**. MQTT discovery did this job until 2026.09.25.3 and needed Mosquitto to do
it; the two ran side by side long enough to compare, and MQTT was removed. An existing
`mqtt_sensors` setting is still accepted so a configuration stays valid, but it does nothing.

| Option | What |
|---|---|
| `esphome_api` | Off by default. On, the add-on listens for Home Assistant's ESPHome integration |
| `esphome_port` | Default `6053`. The add-on runs with host networking, so this is the **host's** port — move it if something else there already listens |
| `esphome_key` | Noise pre-shared key, base64 and 32 bytes, the same format as `api: encryption: key:` in an ESPHome device. Make one with `openssl rand -base64 32`. Empty means an unencrypted connection, which is acceptable only on a network you trust |

Add it in **Settings → Devices & services → Add integration → ESPHome** with this host and port, or
accept the discovered device — the add-on advertises `_esphomelib._tcp` over mDNS. Entity ids are
`sensor.strimmer_*`, `binary_sensor.strimmer_trimming` and `switch.strimmer_trim_pause`.

Two things worth knowing. Home Assistant identifies the device by a MAC derived from the node name
`strimmer`, so entity history survives restarts and upgrades — but it would not survive that name
changing. And a failure here never touches the proxy: if the port is held, the add-on logs it and
carries on serving dashboards.

### Knowing whether it is on, from anywhere

With `esphome_api` on, these answer "is this thing trimming right now":

| Entity | What |
|---|---|
| `binary_sensor.strimmer_trimming` | `on` while trimming, `off` while **anything** is paused — or if `trim_entities` is off entirely |
| `switch.strimmer_trimming_admins` | `off` while **administrators** are paused; flip it to pause or resume them |
| `sensor.strimmer_trim_paused_for` | Minutes until the longest pause ends, `0` when nothing is paused |

The sensor and the switch answer different questions on purpose: a pause for one person turns the
binary sensor off but leaves the switch on, so flipping the switch cannot look like a no-op.

That makes a paused trim visible without opening this panel — in
[custom-sidebar](https://github.com/elchininet/custom-sidebar), a conditional card, or an
automation that tells you at bedtime that you left it off. As the Strimmer item's status line in
custom-sidebar:

```yaml
order:
  - item: Strimmer
    info: >-
      {% set t = states('binary_sensor.strimmer_trimming') %}{% set m = states('sensor.strimmer_trim_paused_for') | int(0) %}{{ 'Offline' if t in ['unavailable', 'unknown'] else ('Paused · ' ~ m ~ 'm' if m > 0 else ('Trimming' if t == 'on' else 'Off')) }}
```

It reads **Trimming**, **Paused · 42m**, **Off** or **Offline**. Two details that matter:

- **Jinja, not a `[[[ JavaScript ]]]` template.** custom-sidebar renders Jinja through Home
  Assistant, which re-renders only when the two entities named here change. A JavaScript template
  runs in the browser, so custom-sidebar subscribes to *every* state change to keep it fresh — the
  whole-house firehose this add-on exists to cut, delivered to every page for one line of text.
- **One line.** A Jinja block spread over several lines emits each newline between its tags, and
  the sidebar renders them as blank lines above the value.

### What the console will and will not serve

The console's port is reachable by anything on your network and has no authentication in front of
it. Home Assistant Ingress does, so that is where the boundary is drawn:

| Path | Off Ingress |
|------|-------------|
| `/stats.json` | **Served, with identities removed.** Counts, savings and allowlist sizes stay, so a `rest:` health sensor keeps working. The per-client list, discovered devices, resolved hostnames and the routing breakdown do not. |
| `/access.json`, `/entities.json`, `/devices.json`, `/config.json`, `/history.json` | **Refused.** |
| Writes (pin, config) | **Refused**, as they always were. |

`/access.json` is the one that matters most: Home Assistant puts credentials in request **paths**
as well as in query strings, so a request log holds webhook ids and signed camera-stream tokens.
Query strings were always stripped; paths were not, which is why this is now Ingress-only.

Opening the console on the app's own port therefore shows statistics but not identities, and the
Config tab says so rather than rendering blank.

### How the 24h history works

Sampled every five minutes into 288 buckets and persisted to `/data`, so an app restart
costs one bucket rather than the whole day.

Buckets hold **deltas**, not cumulative counters. The counters themselves reset when the
process restarts, so a cumulative series goes backwards and a naive difference would emit a
large negative bucket. A counter that decreased is treated as the first sample of a new
process, where the reading is its own delta. Gaps in the charts are periods the app was not
running.

The window total reports the span it actually covers, so an app that has been up for twenty
minutes says twenty minutes rather than implying a full day.

### What the numbers mean

Sizes are **uncompressed payload** — the bytes the browser has to parse. Fewer than that cross
the wire, because the websocket negotiates compression.

The trimmed payloads report a genuine before/after: the proxy holds Home Assistant's full
answer and its own trimmed answer in the same function, so the saving is a subtraction rather
than an estimate.

**Live update traffic is throughput, not a saving.** Home Assistant filters the event stream
server-side from the `entity_ids` this app injects, so the untrimmed volume never exists
anywhere and cannot be measured. Reporting a saving there would mean inventing a
counterfactual. For that comparison, run once with `trim_entities: false` and compare the two
throughput figures.

A connection younger than a minute reports no rate at all rather than extrapolating its
opening burst — the panel shows "—" until there is a full minute to divide by.

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
- **Restarting Home Assistant is safe.** The app keeps running and waits: HTTP returns
  502 and `/api/websocket` is refused while core is down, then it reconnects, rebuilds the
  allowlist, and open dashboards recover on their own. The same applies at host boot, when
  the app starts before core is listening.
- Navigating (via the HA sidebar) to a dashboard **not** in `dashboards` will show its
  entities as unavailable; add it to the list if you want it served too.

### Tuning `trim_resources`

Turn it on, load each kiosk once, and read the app log — it prints what each dashboard
needs and every resource it dropped, with sizes:

```
resources basement-stairs-panel needs: entity-progress-multi-feature, grid-layout, navbar-card, whisker-card
resources basement-stairs-panel: 8/45 kept (2536KB), 37 dropped (18471KB)
    drop   4570KB /hacsfiles/custom-brand-icons/custom-brand-icons.js
    drop   3159KB /bambu_lab/ha-bambulab-cards.js
```

Then look at the dashboard. Anything that looks wrong goes in `resources_always_forward`.
Three classes of plugin reliably need it, because none registers a card the config names.
The first two announce themselves; **the third does not**:

- **Frontend patchers** — `kiosk-mode` (without it the HA header and sidebar reappear),
  `custom-sidebar`, and anything that restyles core cards. Loud when missing. **A patcher
  configured by its own top-level block on the dashboard is detected automatically** — a
  dashboard carrying `kiosk_mode:` keeps `kiosk-mode.js` without being told to. Only
  patchers configured elsewhere (`custom-sidebar` reads its own YAML file) still need
  listing.
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

### Cross-dashboard navigation with `by_dashboard` on

A connection is attributed to a dashboard by the page GET that precedes it, and keeps that
allowlist for its whole life. Navigating to a **different** dashboard client-side — the HA
sidebar, a `navigate` tap action, a navbar card — does not reopen the websocket, so entities
unique to the new dashboard render as unavailable until the page reloads.

This is deliberate. The obvious fix is to watch for `lovelace/config` and re-attribute the
connection, but requesting a dashboard's config does not mean displaying it: Kiosk Satellite,
for one, enumerates every dashboard's views at startup. Acting on that signal caused a
reconnect storm and served panels the wrong allowlist (see `2026.09.11.02` in the changelog).

If your panels navigate between dashboards, either set `by_dashboard: false` to serve the
union, or make the navigation a full page load.
