# Changelog

## Unreleased

- **Console rework.** Five tabs (Overview, Dashboards, Clients, Settings, Diagnostics) in Home Assistant's
  settings style: cards, list rows, switches, text buttons, a pause card with duration and scope, and
  advanced options collapsed. Every function of the old console is still there. Changed on purpose:
  buttons now say what they do instead of being icons with tooltips; the clients table and its column
  picker are replaced by expandable rows (the `stripper-clcols` browser setting is no longer used);
  the headline is **payload not sent (measured)** rather than an unverifiable percentage, with
  entities sent, clients and cache hits beside it; entity search now says why an entity is or is not
  sent. Settings that need a restart show a notice (there is still no restart button). The tab bar
  scrolls at phone width.
- **`always_forward_device_class`** (add-on options and the console's Config tab): forward every entity of a
  device class (`battery`, or `sensor:battery`), for cards that scan all states at runtime and so name
  nothing the allowlist can find. Matched against live state at each rebuild.

- **Download diagnostics** (Diagnostics tab, administrators only): one JSON file with the version, redacted
  options, the allowlist per dashboard, the dashboard configs (credentials removed by key name), the
  entity ids panels asked for that were not forwarded, and the stats. Attach it to a bug report.

## 2026.11.02.1 — 2026-11-02

Fixes from a performance and stability review, plus the extractor gaps found chasing issue #19:
- **A sensor list with an exclude that has a live state test** (`exclude: {domain: sensor, state: unavailable}`)
  no longer drops every sensor from the allowlist. **Area cards** now forward their area's entities.
- **Bridge sockets are bounded.** The Home Assistant side has a 15s handshake timeout, both legs get a
  30s ping (`BRIDGE_PING_MS`) and a silent one is closed, passthrough upgrades time out after 30s, and
  the control socket must authenticate within 15s.
- **A registry or services reply that was in flight during a rebuild is no longer cached as current.**
  Refused requests no longer leave their ids tracked for the life of the connection.
- **Regexes with three or more unbounded repeats** (`a+a+a+a+b`, many-star globs) now run under the
  50ms guard. Learned satellite entities expire after a day without an announce. The regex memo
  and the reverse-DNS cache are capped. A rebuild that finishes after its control connection dropped is
  discarded. The device index no longer builds one array per entity.
- Dependencies: httpxy 0.5.6, ws 8.22.1; Pillow 13.0.0 and puppeteer-core 25.16.0 (tooling only).

Nothing to do on upgrade.

## 2026.10.24.4 — 2026-10-24

The last two findings from the review:
- **A client can no longer make the proxy hold an unbounded backlog.** Frames sent while Home Assistant
  was still connecting, or while a user lookup was in flight, were queued without limit, and a backlog
  of writes to HA was never checked. Past the backpressure limit (8MB, `BACKPRESSURE_HIGH_BYTES`) the
  connection is closed and reconnects fresh.
- **Renaming a device or moving it to another area now reaches new connections.** The cached registry
  answers were only retired when the set of entities changed, so a rename left old names being served.
  Every rebuild now retires them.

Nothing to do on upgrade.

## 2026.10.24.3 — 2026-10-24

More fixes from the same review:
- **Nested regex groups are now guarded.** `/^((a)+)+$/` slipped past the catastrophic-backtracking
  check, so a filter like it could stall every panel instead of being cut off at 50ms.
- **A resource that answers with an error is no longer cached as scanned.** A bundle that returned 503
  once had its cards dropped until its URL changed; failed reads are now retried after five minutes.
- **The resource cache forgets resources that are no longer configured.**
- **A pause that lands while a connection is waiting on its user lookup now applies** to the
  subscribe and registry requests already held, instead of only to later ones.
- **Two pins at once no longer lose one** when the options live in Supervisor.

Nothing to do on upgrade.

## 2026.10.24.2 — 2026-10-24

Three fixes from a whole-codebase review:
- **A cached registry is no longer served before the socket has authenticated.** Cache hits never
  reach Home Assistant, so a socket that skipped `auth` could read another client's cached rows.
  Until HA says `auth_ok`, a registry request now goes on to HA, which refuses it.
- **Client overrides that swap one entity for another now apply.** A rule that added one entity and
  removed another left the set the same size, and the original set was returned unchanged.
- **Certificate-expiry monitoring works again.** `metrics.mjs` lost its `tls` import when MQTT was
  removed, so every check quietly returned nothing.

Nothing to do on upgrade.

## 2026.10.24.1 — 2026-10-24

**Node 26.12.1 base image,** the fix for Node2Shell (CVE-2026-111497), an out-of-bounds write in Node's
bundled Brotli decoder. Strimmer was not exposed: it never decompresses Brotli (HTTP is proxied as raw
bytes, upstream fetches ask Home Assistant for plain text, and the websockets use deflate only), so this
just keeps the image on a patched runtime.

Rebuild the app to pick it up. Nothing else to do on upgrade.

## 2026.10.10.4 — 2026-10-10

**`esphome-device` 0.3.1,** which includes the unpublished 0.3.0. For Strimmer that means:
- **Hardening it gets with no change here:** message sizes are bounded before anything is buffered,
  open connections are capped at 8, a handshake has to finish within 60 seconds, and a connection
  that goes quiet is dropped. A server error after startup is logged rather than ending the process.
- **The admin switch applies commands in order.** A quick on-then-off can no longer finish on.
- **mDNS checks the name isn't already taken before announcing,** and answers only the local
  network. Strimmer still advertises the one LAN address it picks.

Nothing to do on upgrade.

## 2026.10.10.3 — 2026-10-10

**Other people's details are for administrators too.** The console's Clients list names every
connection: who it belongs to, the phone's address and browser, and which dashboard it's on.
Through Home Assistant that was shown to any user who opened the console. Now only an administrator
sees it. Everyone else gets the same anonymised view the console's own port has always shown.

**The console stops offering what it would refuse.** 2026.10.10.2 said it did, but only the Config
tab did. For someone who isn't an administrator, it now:
- leaves "All admins, 1 hour" out of the pause menu,
- shows a single "End your own pause" instead of a resume for each person,
- shows pin buttons disabled, with a tooltip that says why.

The Config tab also now says "Only a Home Assistant administrator can change these settings". It
used to tell them they were on the app's own port and should open it from the sidebar, which is
where they already were.

**A port file from an earlier run can't mislead the healthcheck.** `/tmp` survives a container
restart, so a run whose console never started could leave the probe checking the previous run's
port, and the watchdog restarting a working proxy. The file is now cleared at boot, and any failure
to bind writes "unbound".

All found in a code review.

## 2026.10.10.2 — 2026-10-10

**The console's settings, pins and request log are for administrators.** Every Home Assistant user
can open this console (`panel_admin: false`). 2026.10.10.1 limited the group pause to
administrators. This release applies the same rule to the rest of what acts on everyone:
- changing configuration,
- pinning an entity or a resource,
- reading the request log, which holds webhook ids and camera stream tokens.

Webhook ids are secrets: whoever has one can trigger the automation behind it. A user who isn't an
administrator gets a refusal, and the console stops offering them controls that would refuse.

**A configuration value of the wrong type is refused when it's saved.** It used to be stored as
sent and read at the next restart, and a boolean was read by truthiness, so the text `"false"`
turned the option *on*. The console always sent the right type; this guards every other writer.

**A stats port that can't bind no longer gets the add-on restarted in a loop.** The proxy
deliberately keeps running when its console port is taken, but the container healthcheck probed
that port. It failed, and the Supervisor watchdog restarted a working proxy every couple of minutes.
The healthcheck now knows the console didn't start.

**The admin switch updates at once when the console pauses or resumes, and when a pause runs out.**
It used to wait up to a minute for the next sample, so it could disagree with the console.

All found in a code review.

## 2026.10.10.1 — 2026-10-10

**Only an administrator can pause trimming for every administrator.** This console is open to
every Home Assistant user (`panel_admin: false`), and Ingress tells the add-on who is asking but not
their role. So any user who could open the panel could pause trimming for all administrators for up
to a day, and recycle their connections. Nobody could see anything they couldn't already: a pause
only stops this add-on filtering what Home Assistant would send those sessions anyway. But it acted
on other people's sessions, and that is now checked. The add-on asks Home Assistant whether the
caller is an administrator, using its own definition (the `system-admin` group, or the owner), and
refuses when it can't find out. Ending someone else's pause, the administrators' one included, is
held to the same rule. Anyone can still pause and resume their own trim. Found by a Codex review.

**Standalone Compose installs from before the rename: your data volume needs copying.** The rename
to Strimmer changed the Compose file's volume (`stripper-data` to `strimmer-data`), image and
service name, and Compose carries none of them over. The new file starts on an empty volume, and the
old container keeps running as an orphan, holding the ports. The volume is not being renamed back:
installs have run on the new one for three weeks, and switching again would strand them instead.
[docs/MIGRATING.md](https://github.com/davidcoulson/HA-Strimmer/blob/main/docs/MIGRATING.md#standalone-compose-the-rename-to-strimmer)
now has the steps, tested on a throwaway project. Add-on installs are unaffected. Found by a Codex
review.

## 2026.10.06.1 — 2026-10-06

**`esphome-device` 0.2.1.** With `esphome_key` set, Home Assistant connecting without the key is
now told that one is needed. Its add flow asks for the encryption key, and an existing entry starts
a reauth. Before, it failed with "Unable to connect… make sure the YAML includes an api section",
which sent people looking for a YAML file this add-on doesn't have. Nothing changes for an
integration that already has the key.

## 2026.10.02.3 — 2026-10-02

**Security: other software on the same machine could act as an administrator in the console.** The
console's writes (pausing trimming, changing configuration, pinning entities and resources) are
meant to be reachable only through Home Assistant Ingress. The check trusted any request carrying
Ingress's `X-Ingress-Path` header from loopback or anywhere in `172.30.32.0/24`. The header is
the client's to write, and the add-on runs with host networking, so loopback includes every other
host-network process on the machine. That's Home Assistant itself and, on a typical install, a dozen
add-ons (Node-RED, the SSH add-on and so on). Any of them could pause trimming for any user or
rewrite the console's settings. None of this reached Home Assistant's own authentication, and
settings that decide where traffic goes (`ha_base`, the ports, the ESPHome key) were never writable
there. As an add-on, only Supervisor's own address, `172.30.32.2`, now counts as Ingress. Loopback
still works for a standalone run. Found in a security review.

**Pause records refuse anything that isn't plainly a user id.** The id becomes a key in a stored
object, and it reaches the store from a request, so `__proto__`, `constructor` and anything outside
an id's characters are now refused rather than stored. Found by CodeQL's extended queries. It was
only reachable through Ingress, by an administrator.

**The image no longer ships npm.** The app never runs it, and Trivy's three fixable HIGH findings
in the image (brace-expansion, undici) were all inside the copy the Node base image bundles. CI now
fails a build that has a fixable HIGH or CRITICAL CVE before anything is published.

## 2026.10.02.2 — 2026-10-02

**Security: a dashboard page could be fetched from a host other than Home Assistant.** Update if
`trim_extra_modules` is on. With it on, the add-on fetches each dashboard's page itself so it can
edit the module list, and it built that URL as `new URL(req.url, HA_BASE)`. The request target is
whatever the client sent, so `GET //basement-panel/x` passed the dashboard check (its first segment
names a dashboard) and was then read as protocol-relative: the add-on fetched
`http://basement-panel/x` and served the answer as the page. The reach was narrow: only hosts that
share a dashboard's name, port 80 unless the name carries one, and only with that option on. It was
still a way to make the proxy talk to something other than its one upstream. The host now comes
from `HA_BASE` alone, and the request supplies only the path and query. A test names a dashboard
after a canary server's address and fails if the proxy ever contacts it. Found by CodeQL, now
enabled on the repository.

**The "cannot listen" fatal message named the wrong option.** It said to set `port`, the old name;
the option is `proxy_port`.

The repository now runs CodeQL, ruff (over `tools/make_icon.py`) and CodeRabbit on pull requests.
None of that changes the add-on.

## 2026.10.02.1 — 2026-10-02

**`ws` 8.22.0** (from 8.21.3), the websocket library on both legs of every trimmed connection. A
minor release; the full suite passes on it and `npm audit` reports nothing. `puppeteer-core`, used
only by the browser tests and not shipped in the image, moves to 25.12.0.

**A correction to 2026.09.25.10.** It said Home Assistant would update the device's stored address on
its own once Strimmer advertised the LAN one. On the instance it was written for, it did not: the
config entry kept the Tailscale address until the ESPHome integration was reconfigured by hand. If
**Settings → Devices & services → ESPHome → Strimmer** shows a `100.x` host, reconfigure it to the
Home Assistant host's LAN address. The sensors keep their history, because the device is matched by
its MAC.

**Dependabot never ran.** It has been configured since 2026-09-13, but this repository is a fork, and
GitHub leaves Dependabot off on forks until it is enabled by hand, so it never opened a PR. Security
updates are now on. This changes nothing in the add-on; it is why these two bumps came from a person
rather than a bot.

## 2026.09.25.10 — 2026-09-25

**Home Assistant was reaching the add-on's sensors over Tailscale.** Its config entry for the device
stored `100.86.127.109`, the tailnet address. The library advertises every non-loopback IPv4 address
the machine has, which on a Home Assistant OS host includes the Supervisor and Docker bridges and,
with the Tailscale add-on running, the tailnet — and Home Assistant picked that one. So a connection
between two processes on the same machine ran through the tailnet interface, and the sensors and
the admin switch would have gone unavailable whenever Tailscale stopped.

Strimmer now chooses the address itself: a `10.x` or `192.168.x` LAN address first, then `172.16/12`,
never `100.64/10` (carrier-grade NAT, where Tailscale lives) or link-local. The boot line says which:
`advertised at 10.2.3.6`. Home Assistant updates the stored address on its own when it rediscovers a
device it already knows by MAC, so nothing needs re-adding.

## 2026.09.25.9 — 2026-09-25

**`esphome-device` 0.2.0.** A purely additive release of the library — nothing Strimmer uses
changed — verified here against `aioesphomeapi`, the client Home Assistant uses, over both Noise and
plaintext: the same MAC as before, so Home Assistant keeps the device and its history; all 21
entities with the right state classes; the admin switch round-trips.

The bump is explicit because it has to be: a caret on a 0.x version allows only patch releases, so
`^0.1.0` would never have resolved to 0.2.0 on its own.

**The ESPHome tests now run on the library's own `FakeDevice`**, which 0.2.0 exports, instead of a
stand-in written for them. It uses the library's real entity classes, so the tests assert what
actually goes over the wire — `state_class` as the protocol's enum, the unit, the decimals — rather
than echoing back the options passed in. A hand-written fake can agree with our code while both
disagree with the library. It also made one test stronger: several display names derive to a
different object id than the catalogue's (`Cold start (median)` would be `cold_start_median`, not
`cold_start_ms`), so dropping the explicit ids now fails the suite, where before it could not.


## 2026.09.25.8 — 2026-09-25

**The Home Assistant sensors no longer go `unknown` for a minute after every restart.** The ESPHome
publisher starts before any allowlist exists, rightly refuses to publish zeros until one does, and
then waited for its next sampling tick — so each restart put an `unknown` gap of up to a minute into
every history graph. MQTT's retained state had hidden that; the native API has none, so the first
real values now go out the moment the allowlist is ready.


## 2026.09.25.7 — 2026-09-25

**The worst-stall figure now measures running, not starting.** The first timed rebuild answered the
question `2026.09.25.6` was built to ask: its own worst event-loop block was **55ms** — the 10.9MB
registry frame parsed in 29ms, the dashboards took 23ms — while the console already showed a
worst of **114ms** fourteen seconds after boot. The histogram was enabled when the stats module
loaded, so "worst since boot" always included startup itself: compiling the proxy, the first
build, and every panel reconnecting in the same few seconds. The creep from 46ms to 120ms over a
week read like the proxy getting slower, and was only startup growing with the instance.

It now starts counting a minute after the first allowlist is in (`LOOP_SETTLE_MS`), and reports
the moment in `since`. So `sensor.strimmer_event_loop_delay_max` answers what it was put there to:
can one client hold up the others while the proxy runs. `docs/CLUSTERING.md`'s 100ms threshold is
about that, not about boot.

## 2026.09.25.6 — 2026-09-25

**A rebuild that changed nothing no longer writes forty lines about it.** Measured on a live
instance: every rebuild printed each dashboard's count, each device a card or a rule expanded,
the registry reach and the override totals — and a registry event triggers one, so with a handful
an hour they were most of the log. The detail is now printed only when it differs from the last
rebuild's, the way the resource report already was. The one-line `allowlist recomputed … (+a -r)`
summary is still said every time; that line is the storm detector.

"Differs" means what the sets **contain**, not just their sizes. The detail lines are counts, so an
edit that swaps one entity for another leaves every line identical — and the first version of this
said "unchanged since the last rebuild" about a rebuild that had changed what a panel is served.
A test that swaps an entity caught it.

**Every rebuild now says what it cost:** `rebuild took 812ms: worst event-loop block 97ms, largest
frame 11.8MB parsed in 94ms, dashboards 38ms (slowest lovelace 17ms)`. The console's since-boot worst
stall had crept from 46ms to 120ms as the instance grew, while p99 stayed near 1ms — one long
block, not a slow loop. The rebuild already yields between dashboards, so the suspect is a single
large `JSON.parse` on the control socket, which cannot be split. This line says which, so the fix
can follow the measurement.

Two more lines said once instead of every time:

- `user rules applied for …` — repeated on every reconnect, and a phone on cellular reconnects
  every few minutes: about 500 identical lines a day. Now once per user, dashboard and answer.
- `N devices are named "…"` — repeated on every rebuild. Often not even a mistake: one tablet is
  commonly a voice satellite *and* a Kiosk Satellite or ha-paneld device under the same name.


## 2026.09.25.5 — 2026-09-25

**The console now speaks Spatial Context's design language, which Sextant shares.** The rule at
its centre: **no button carries text.** Every one is an icon, and its name is in a tooltip — and in
`aria-label`, so a screen reader still announces it.

- **The header is neutral**, the page's own surface with a divider under it, instead of the blue
  bar. Identity on the left — the full-colour app icon, the name, and the version in the subtitle —
  tabs dead centre in Home Assistant's underline style, round icon buttons on the right.
- **Pause, theme and a ⋮ menu are popovers.** The pause control moved out of the status strip into
  the header, and its icon carries a dot while a pause is running, with the time left in its
  tooltip — visible from every tab without reading the banner. GitHub and the raw statistics
  moved into the ⋮ menu; Auto/Light/Dark is a menu instead of three words in the bar.
- **Twelve text buttons became icons**: pin an entity or a resource, resume, remove a value, delete
  an override and confirm it, add an override, the wizard's next/back/cancel, hand an option back
  to the add-on, and the range and column toggles in the card headings.
- One tooltip element for the whole page, placed by script, so the scrolling table wrappers — where
  most of these buttons live — cannot clip it the way a CSS tooltip on the button would be.
- Card headings are sentence case in the text colour, Home Assistant's own style, rather than
  Sextant's older small uppercase.
- A new test fails if a button is built anywhere except `iconBtn()`, a menu row or a config tile,
  or has text written into it.

**Fixed:** with nothing paused, the console showed an **empty amber strip** at the top of every tab.
The pause banner's `display: flex` overrode its `hidden` attribute — shipped in `2026.09.24.1` and
only visible to someone looking at the page with no pause running.

The config tiles keep their captions. They are labelled toggles rather than actions, and twelve
near-identical glyphs with no words would be guesswork.


## 2026.09.25.4 — 2026-09-25

**Fixes a crash loop in 2026.09.25.3 on any install that still had `mqtt_sensors` set.** The notice
telling you the option had been retired was written beside the option read at the top of the file,
where `warn` — a `const` declared fifty lines further down — is in its temporal dead zone. The
add-on died on boot with `ReferenceError: Cannot access 'warn' before initialization`, before it
could serve anything.

Two things let it through, and both are fixed:

- **The file already had the right mechanism and I did not use it.** `CONFIG_WARNINGS` exists
  precisely because logging is not configured yet that early; the notice goes through it now, with
  every other config warning.
- **No test could have caught it.** The suite configures the proxy through the ENVIRONMENT, so
  nothing in it ever set `mqtt_sensors`, and the one code path that reads an options *file* was
  reachable only on a real add-on. Options are now read from `CONFIG_DIR` (still `/data` wherever
  that exists), so a test can boot the add-on with a real options file — and one now does, with a
  retired option in it.


## 2026.09.25.3 — 2026-09-25

**MQTT is gone; the metrics go to Home Assistant over ESPHome's native API.** Both transports ran
side by side yesterday and reported the same numbers, which is what the comparison was for. Keeping
the pair cost two copies of every entity in Home Assistant — the second suffixed `_2` — and a
Mosquitto dependency for something that needs no broker.

- `mqtt_sensors` is **still accepted** so an existing configuration stays valid on update — an
  unknown key is an error to Supervisor, and an upgrade should not require editing the config
  first. It does nothing, the add-on says so once at boot, and the Configuration tab marks it
  removed.
- The `mqtt` package and the `mqtt:want` service declaration are gone with it.
- **`mqtt_sensors.mjs` is now `metrics.mjs`** and knows about no transport at all: it declares what
  exists and computes the values, and `esphome_api.mjs` is the one thing that puts them on a wire.
  That split is what kept the two honest while both were running.
- `REMOVED_KEYS` is a new idea in the config store, beside the existing renames: an option a past
  version had, still accepted by the schema, absent from the console. A switch that does nothing is
  worse than no switch.

**If you are upgrading:** the MQTT entities will go unavailable and their retained discovery topics
stay on the broker until they are cleared, which is a one-off cleanup — publish an empty retained
payload to each `homeassistant/*/strimmer/*/config` topic. The ESPHome entities are the ones to keep.


## 2026.09.25.2 — 2026-09-25

**A switch the console owns can be handed back again.** When the booleans moved into the tile grid
in `2026.09.20.4`, the **Use add-on config** button stayed behind in the row renderer — which
booleans no longer have. So a setting adopted by one click on a tile could never be released, and
from then on the add-on's own Configuration tab was shadowed for it, silently.

Found the hard way: `esphome_api` switched on in the add-on's Configuration tab did nothing,
because the console held it at off and there was no way in the UI to see that or undo it.

- A tile the console owns now carries a **dot**, and its tooltip says so. That is what the rows
  have said with their "set here" tag since ownership existed.
- Under the grid, one line lists what the console owns with a button per setting to hand it back.
- A test pins it: a boolean can be adopted with a click, so a release control has to exist in the
  same place.

**The log now says whether the ESPHome API is on.** With the option off the add-on said nothing
about it at all, so "I turned it on, where is it?" had no answer in the log — which is the state
this was found in.


## 2026.09.25.1 — 2026-09-25

**The metrics can go to Home Assistant over ESPHome's native API, with no broker.** `esphome_api`
makes this add-on look like an ESPHome device: Home Assistant's own integration connects to it, and
the 19 sensors, the trimming binary sensor and the admin switch appear on a device page with
long-term statistics and a working control. Off by default, and it runs **beside** the MQTT
publisher rather than instead of it — one catalogue feeds both, so they cannot drift, and running
both is how you compare them before dropping one.

Verified against `aioesphomeapi`, the client Home Assistant itself uses: 21 entities listed with
the right units, state classes and decimals, states streaming, and the switch pausing and resuming
the trim for administrators over both a plaintext and an encrypted connection.

- `esphome_port` (default 6053, the host's port under host networking) and `esphome_key` (a Noise
  pre-shared key — `openssl rand -base64 32`). Both stay in add-on options rather than the console,
  like the other listener settings: they have to be fixable from Home Assistant when the console is
  what is broken.
- The device is advertised over mDNS, so Home Assistant offers it rather than asking you to type an
  address.
- A failure here never reaches the proxy. The likeliest one is port 6053 already being held on the
  host; the add-on says so and carries on serving dashboards.
- Sensor values cross as float32, so the catalogue now carries the decimals each reading should be
  displayed to — `74.30000305175781` is what an untold `74.3` looks like on the other side.
- Entity ids are declared explicitly rather than derived from display names, so rewording a sensor
  cannot orphan its statistics.

Built on **[esphome-device](https://github.com/davidcoulson/esphome-device)**, which does the
protocol: Noise, framing, the entity messages and mDNS, with no dependencies of its own.


## 2026.09.24.2 — 2026-09-24

**A switch in Home Assistant turns the trim off for administrators.** `switch.strimmer_trimming_admins`
pauses it for an hour from wherever you already are — the app, a dashboard, an automation, a voice
command — which is the point: when a dashboard is missing the entity you need, you are holding a
phone, not sitting at the console.

It pauses a **role** rather than a person because MQTT delivers a payload and not an identity, so a
switch cannot know who flipped it. Administrators is the scope that matches the purpose — they are
who troubleshoots — and **every kiosk and wall panel keeps its trim** and is never reconnected.
`ADMIN_PAUSE_MINUTES` changes the hour. The console offers the same under **pause trimming → all
admins, 1 hour**, so there is one feature and not two.

`admin_trimming` is a separate field from `trimming` on purpose: a pause for one person turns the
binary sensor off but leaves the switch on, so flipping the switch can never look like a no-op.


## 2026.09.24.1 — 2026-09-24

**You can pause the trimming while you troubleshoot.** The add-on serves a panel only the entities
its dashboard names, which is exactly wrong when you are trying to find out why something is
broken: the entity you need to look at is the one no card mentions. Reported from the case that
makes it worst — away from home, on a phone through Cloudflare, unable to see anything the
dashboard does not already show, and no way to turn it off from there.

**Pause trimming** in the console's status strip now gives you everything for **an hour** or the
**rest of the day**, and it ends by itself.

- **It pauses for a Home Assistant USER, not a device.** A phone on cellular behind Cloudflare has
  no stable address to pin anything to — the leftmost `X-Forwarded-For` entry is supplied by the
  caller and `CF-Connecting-IP` moves with the tower. The user behind the token does not move, it
  is the identity `user_overrides` already matches on, and it follows you from phone to laptop.
- **Everyone else keeps their trim.** Only that user's connections are recycled; the wall panels
  are untouched and do not reload.
- **Who is asking comes from Supervisor's Ingress headers**, stamped after Home Assistant has
  authenticated the user, so there is no field to put somebody else's name in. Resume accepts one,
  because ending a pause early is the safe direction.
- **It expires.** A pause that has to be turned off by hand is one that gets left on, and a trim
  that is off is invisible — panels just load slowly again until somebody notices. One hour, the
  rest of your day (computed from the console's own timezone, since the container runs UTC), and a
  24-hour ceiling on anything hand-written into `/data/pauses.json`.
- It is applied **inside the auth gate**, which is the only moment the token has resolved and
  still before the first `subscribe_entities` — Home Assistant cannot amend a live subscription,
  so anything later would not work at all. Open connections are dropped when it starts and when it
  ends, which is what makes it reach the page in your hand.

A pause is **not** an access control. It does not hand out anything Home Assistant would refuse
that same token; it stops this app filtering what HA is already willing to send. The cost is
performance, which is why it has a clock on it.

**Two new entities say whether it is on, from anywhere.** `binary_sensor.strimmer_trimming` is
`off` while paused (or if `trim_entities` is off), and `sensor.strimmer_trim_paused_for` counts the
minutes down. That puts the state where it can be seen without opening this panel — a
[custom-sidebar](https://github.com/elchininet/custom-sidebar) badge on the Strimmer item, a
conditional card, or an automation that tells you at bedtime that you left it off. DOCS has the
sidebar snippet.

The console shows a banner with **Resume now** for as long as one is running, and the Clients table
marks a paused connection. Off Ingress, *who* is paused is redacted like every other identity;
*that* something is paused is not, so a health check can still see it.


## 2026.09.21.1 — 2026-09-21

**The recycle log now says which connections it recycled.** When a rebuild grows a dashboard,
the open connections on it are dropped so they re-subscribe. The log line for that ended with the
dashboards that *grew*, so `reconnecting 1 of 6 open dashboard connection(s) … (basement-stairs-panel)`
reads as "the basement panel reconnected".

On 2026-09-21 it wasn't. The basement stairs panel never received two newly added helpers,
`input_number.basement_accent_speed` and `…_intensity`, and that line was taken as proof the panel
had been handed them. The one connection dropped at both rebuilds was **a different client, on
the union**, and the panel (10.2.4.240) had no connection on that dashboard to drop. In the
retained log it has **no connection through this app at all**: not at those rebuilds, and not at
the two Core restarts at 11:06 and 11:11 UTC, when every other panel reconnected. Its `client_overrides`
rule names 10.2.4.109, an address the panel no longer has.

- The line now names each recycled connection by address and set:
  `reconnecting 1 of 6 … to pick up the new entities: 10.2.3.56 (union)`.
- A dashboard that grew with **no open connection on it** gets its own line:
  `no open connection is attributed to basement-stairs-panel — a panel showing it is on another set
  or not connected through this app, and will not pick up the new entities until it reloads`.
  That is the fact that would have ended the investigation on the first read.

The panel turned out to point at Home Assistant's own `:8123`, so it never touched Strimmer and
the missing helpers were not a trimming fault. This change is still right: it is the log line
that made it look otherwise.

---
## 2026.09.20.5 — 2026-09-20

**The switch grid is headed "Strimmers".** It was "What this app is doing", which was a sentence
doing a heading's job and sat oddly beside the plain noun phrases under it — Dashboards and
entities, Custom cards, Overrides. The grid's own line, *Every on/off setting. Blue is on.*, is
what actually explains it, so the heading is free to be the product's word for the thing.

Worth knowing: three of the twelve — mDNS, MQTT, compression — do not trim anything, so the
heading is a shade wider than it is literally true. Splitting them back out would undo the single
grid, which is the point of it, so they stay.

---
## 2026.09.20.4 — 2026-09-20

**All twelve switches are one grid at the top, under "What this app is doing".** Nine were under
Trimming and the other three were scattered — mDNS three headings down, MQTT four, compression
five — so answering "what is this app currently doing to my dashboards" meant scrolling and
reading. It is one question, and it now answers in one glance.

Everything that holds a **value** stays exactly where it was: dashboards, entity lists, resource
rules, the override wizard, ports, the certificate host. A tile is right for a thing that is on or
off and wrong for a thing that holds text, and moving those would have been rearrangement for its
own sake.

Two headings disappear as a consequence — **Trimming** and **Websocket** were entirely boolean, so
with their switches hoisted there is nothing left to put under them. A section with nothing to set
is skipped rather than drawn as a heading over empty space.

Declared order is kept inside the grid, which puts the trimming switches first because that is how
the catalogue reads; each tile's tooltip still carries its full sentence and its config key.

---
## 2026.09.20.3 — 2026-09-20

**The status pill and the Config tile now read the same word, because they read the same source.**
The tile said "Per dashboard" where the pill said "by dashboard" — and that was not the only one.
Checking the rest found **six of the twelve had already drifted**: "resources" against "Custom
cards", "extra modules" against "Injected JS", "compress" against "Compression", and so on.

Two hand-maintained lists that have to agree are a list that will disagree — this file records the
same shape of fault in `statsExtras`, where an options list silently fell behind the options. So
the fix is not to re-sync them: the pill now reads the catalogue's `short` caption, the same field
the tile renders, and one source cannot contradict itself.

The regex on the key stays as the fallback for a console served off Ingress, where `/config.json`
is refused and there is no catalogue to read. That is today's wording exactly, so nothing
regresses where the catalogue is unavailable.

Two tests come with it: every boolean carries a caption and an icon name, and every icon the
catalogue names has a path in the panel — a name with no geometry renders as a blank space where
the glyph should be, which reads as a rendering fault rather than a missing table entry.

---
## 2026.09.20.2 — 2026-09-20

**The Config tab's switches are a grid of icon tiles**, the shape Sextant's edit toolbar uses: a
bordered rounded cell with the glyph over its caption, and the active one filled in the accent.
Blue means on — the same language as the switches it replaces and as Sextant's selected tool.

Nine switch rows read as a form to work through. Nine tiles read as a state you can take in at a
glance, which is what a settings screen is for: the answer to "what is this thing currently doing
to my dashboards" is now one look rather than nine.

- Each boolean carries a `short` caption and an MDI `icon` in the option catalogue, so the tile
  has a word and a glyph. The full sentence and the config key stay in the tooltip, which is where
  the long form belongs once the grid carries the scanning.
- The catalogue names the glyph (`palette-outline`); the console owns the geometry. Same division
  Home Assistant uses when it passes `mdi:x` around rather than paths.
- Tiles are real buttons with `role="switch"` and `aria-checked`, so they are still operable from
  the keyboard and still announced as toggles. A styled `div` would not be.
- Options with a value to type — dashboards, entity lists, ports — keep their rows. A tile is
  right for a thing that is on or off and wrong for a thing that holds text.
- The standing explanation of how ownership works folds behind a link. The two facts that bite —
  what *set here* means, and that nothing applies until a restart — stay visible.

---
## 2026.09.20.1 — 2026-09-20

**`devices_discovered` sawtoothed between 12 and ~120 about once an hour.** Reported from the
sensor's own history, which is exactly what that sensor is for. Three faults, all introduced with
mDNS expiry the day before, and each one alone was enough to cause it.

- **The expiry window was 15 minutes** (three query intervals), chosen with no evidence. ESPHome
  and Avahi re-announce on a far longer cycle — the sawtooth's own period says ~55–60 minutes — so
  most of the estate aged out between announcements and returned in a rush when it next spoke.
  Expiry here is a **backstop** for a device that vanished without a word; a clean departure sends
  a goodbye record, which is handled directly. So it only has to be shorter than forever: now two
  hours.
- **Only the first 100 held hosts were re-queried.** Past a hundred hosts the tail was never asked
  again and aged out on a timer — guaranteed, and invisible except as a number going down. All
  held hosts are re-asked now, in chunks that fit a datagram.
- **A host expiring silently un-resolved a live instance.** Hosts are refreshed only by A records
  and instances only by PTR/SRV/TXT, and `index()` resolves an instance *through* its host — so a
  device answering a service query without repeating its address kept a fresh instance, lost its
  host, and disappeared from the view while demonstrably alive and talking to us. A host that a
  surviving instance still points at is no longer expired: hearing the service is hearing the
  device, and a withdrawal has its own record.

The snapshot now also carries the `instances` and `hosts` counts behind `devices`. A device row
needs both an instance and a resolvable host, and when those two diverge the count moves while the
network has not — which is the fault above, and would have named itself.

---
## 2026.09.19.8 — 2026-09-19

**Event-loop delay is now measured and published.** Everything this proxy does to a frame happens
on one event loop, so "can one client hold up the others" is a question about that loop — and it
was being answered with opinions. It now reads as a number: mean, p50, p99 and the worst stall
since boot, on the console beside the runtime facts and as two MQTT sensors, because the stall
worth catching is the one that happened at 3am a fortnight ago.

`monitorEventLoopDelay` is a libuv histogram sampled in C, not a JS timer, so it costs effectively
nothing and cannot add the lag it reports. Two details that make the reading honest: the histogram
records the WHOLE interval between ticks, so the sampling resolution is subtracted — otherwise an
idle process reports 20ms of "delay" that is not delay — and it is never reset between reads, so a
console polling every few seconds and a `rest:` sensor polling every minute cannot disagree about
the same process.

This is step 1 of `docs/CLUSTERING.md`, a written-up proposal for splitting Strimmer across
processes. The short version of that document: **don't, yet.** Two findings decide its shape, both
tested rather than assumed — a `SharedArrayBuffer` does not survive cluster IPC (it arrives as a
plain object, so real shared memory needs a native dependency this project will not take), and
`cluster` can pass sockets but not memory while `worker_threads` can share memory but not sockets.
The design that resolves it needs no shared memory at all: route each client consistently to one
worker and the caches that matter are already client-local. But at **0.12% CPU** there is nothing
to parallelise, so the recommendation is to measure first and let this number decide — which is
what this release adds.

---
## 2026.09.19.7 — 2026-09-19

**The console's brand mark is `mdi:grass`, the same glyph as the sidebar.** It was the app's own
full-colour icon tile, inlined as a data URI — which is right for the Apps list and wrong at the
left of a coloured header, where every other mark is a flat glyph in the bar's own colour.

Sextant uses `<ha-icon icon="mdi:compass-rose">` in exactly this spot. That is a Home Assistant web
component and only exists inside a **native** panel; this console is an Ingress iframe and has no
access to it. So the MDI path is inlined and filled with `currentColor`, which is what `<ha-icon>`
renders to anyway — same glyph, same 26px, same colour behaviour, no dependency on the frontend
bundle. `icon.png` is untouched: the Apps-list tile is a different context and stays full-colour.

---
## 2026.09.19.6 — 2026-09-19

**One client could block every other panel with a 109KB frame.** Found by asking the right
question rather than by reading the code: *"is there a way to improve the internal threading so
one bad client doesn't block the whole thing?"*, put about the regex guard below — where the
honest answer is that a deadline only bounds a stall. Asked of the proxy in general, it turned
over something exploitable that no test and no log line was ever going to surface.

`ws` defaults a server to a 100MB `maxPayload`, and every text frame a browser sends is
`JSON.parse`d on the one event loop
that relays every other connection. This leg negotiates permessage-deflate, and `ws` inflates up
to `maxPayload` before anything can inspect the result — so it is an amplification, not an upload:

| on the wire | inflated | JSON.parse |
| --- | --- | --- |
| 109 KB | 100 MB | ~130 ms |

About 1000:1, from anything that can open the socket, repeatable as fast as it likes.

Inbound browser frames are now capped at **4MB** (`BROWSER_MAX_PAYLOAD_BYTES`). Nothing legitimate
is near it: commands are bytes, a voice satellite's audio chunks are kilobytes, and the largest
real frame is a dashboard save at a few hundred KB. `ws` answers an oversized frame with close code
1009 and drops the connection, and the proxy logs which address hit the limit — otherwise it looks
like an unexplained disconnect from the panel's side.

The Home Assistant leg deliberately keeps `maxPayload: 0`. HA really does send 14MB registry
frames, and it is not an untrusted peer.

---
## 2026.09.19.5 — 2026-09-19

**The regex guard shipped this morning missed the worse half of the problem.** Found by a review
of the day's own changes, and proven rather than argued: `looksCatastrophic` flagged a quantified
group containing another quantifier — `(a+)+` — but not one containing an **alternation**.
`/^(a|a)+$/` against a 27-character string blocked the event loop for **5.4 seconds**, doubling
with every further character, and took the plain unguarded path because the detector said it was
fine. The guard existed for exactly this and let the commoner shape through.

The detector now flags either form. It is deliberately loose — `(ab|cd)+` cannot backtrack badly
and is flagged anyway — because a false positive costs only the guarded path (424ms across 10,000
first-pass calls, ~0 once memoised) while a false negative costs every panel. Flagging is not
rejecting: a flagged pattern still runs and still matches.

Four smaller things from the same review, all introduced earlier today:

- **A log flood that got past the auth gate.** The self-identify line keyed its once-only check on
  the client-supplied `entity_id`, and that block runs before the gate — so a socket sending a
  fresh id per frame produced one unthrottled line per frame. Keyed on the address now, with the
  throttle still underneath.
- **`onceOnly` cleared its whole set at the cap**, which inverts the guarantee: under key churn
  every key is forgotten as soon as the set fills, so "say it once" becomes "say it every time".
  It evicts the oldest entry instead, one at a time.
- A bare entity id in an `include` list was added to the allowlist and *also* reported as skipped,
  so the new "not resolved" line lied about the one case the same change had just handled.
- The console's option listing still indexed `EDITABLE_KEYS` directly, so a hand-edited store row
  named `constructor` would render as an editable option. It uses the own-property check now, like
  the write path.

---
## 2026.09.19.4 — 2026-09-19

**A console left open on the direct port wrote two log lines a minute, forever.** Found by reading
the log after the rename rather than by a test: `/history.json` and `/access.json` are
Ingress-only, the console polls them every 60 seconds, and `logThrottled`'s window is 10 — so the
throttle never collapsed anything. The same 60-versus-10 mismatch as the announce lines fixed
earlier in the day, in the one place that had not been looked at.

Both ends now:

- The refusal is said **once per caller and endpoint**, then at debug. The refusal itself is
  unchanged — only the repetition is.
- The console **stops asking** once an endpoint answers 403. It is also served on its own port,
  where asking again can only ever be refused again, so one 403 is the answer for the life of the
  page.

`/strimmer/client.json` refusals get the same treatment, for the same reason: panels poll it.

---
## 2026.09.19.3 — 2026-09-19

**Renamed to Strimmer.** A strimmer trims, and it reads as "stream trimmer" — which is the whole
app in one word. This fork is 183 commits ahead of the project it started from, which has none of
the console, config store, MQTT sensors, mDNS discovery or resource trimming, so sharing a name
with it had stopped describing what is installed. New tagline: *cuts what your panel never shows*.

The **slug** changes with it (`websocket_stripper` -> `strimmer`), so Supervisor sees a new app:
install Strimmer, copy your options across, then remove the old one. `/data` starts empty, which
costs the config store, the 24-hour history, the user cache and the client hints — all of which
rebuild on their own. MQTT sensors are republished under new unique_ids, so their long-term
statistics start fresh.

Three things deliberately keep their old names, because renaming them would break something real
rather than tidy it:

- **`/stripper/client.json` still answers**, beside the new `/strimmer/client.json`, and the reply
  carries a `stripper` key beside the new `strimmer` one. Panels were written against those.
- **The panel's `localStorage` keys** keep the `stripper-` prefix: they live in each viewer's
  browser, and renaming them would silently reset every panel's remembered tab, theme and columns.
- **Older entries in this file** keep the old name. They are a record of what it was called then.

The console's title, the sidebar entry, the boot line, the Docker image, the compose service and
the CI paths all move to the new name. The banner wordmark is one word in one colour now — the
two-tone treatment was a device for a two-part name.

---
## 2026.09.19.2 — 2026-09-19

**The console now looks like Sextant.** Two panels by the same person on the same Home Assistant
should not look like two different products. Sextant is a NATIVE panel, so it reads
`--card-background-color` and its siblings straight from the user's theme; this console is an
Ingress iframe, which inherits nothing and has to supply those names itself. It now does — the
token names are Home Assistant's own, with this panel's short spellings (`--fg`, `--line`, …)
aliased onto them, so a rule can be copied between the two unchanged and turning this into a
native panel later would mean deleting the token blocks and nothing else.

- **One 56px bar** carries the app icon, the name, the tabs and the theme switch, coloured with
  `--app-header-background-color` — the accent in light, `#1c1c1c` in dark, as HA's own themes do.
  Tabs are icon + label with a 3px underline on the active one; the brand returns to Overview.
  Below 860px the labels and the brand text go and the icons remain, which is why the tabs have
  icons at all.
- **Cards** carry a shadow instead of a border, at Sextant's radius, padding and spacing.
  Section headings are small uppercase secondary text. Pills are filled tints rather than
  outlines — at 11px an outline reads as an empty box before it reads as a state.
- **Tables** are 13px with tabular figures, so columns of numbers line up.
- **A wide table on a phone** keeps its first column — the row's identity — pinned while the rest
  scrolls under it, with a fading edge to say there is more. Straight from Sextant's `.wrap`.
- Buttons and inputs at Sextant's metrics; the toast is centred at the bottom as Sextant's is.
- Version, uptime and the option pills move from a line of body text into a slim strip under the
  bar, so the first card starts at the top of the page.

---
## 2026.09.19.1 — 2026-09-19

**A rebuild storm nobody could see, and nine other things a review of the code and the live logs
turned up.** Measured on the live instance: 33 full allowlist rebuilds in 8.5 minutes, 28 of them
from `device_registry_updated`, every one reporting `+0 -0`. Each pulls `get_states` and all four
registries from Home Assistant (~20MB), blocks the event loop every panel's websocket shares, and
writes ~60 log lines — enough that the Supervisor's log buffer held ten minutes of history.

- **`device_registry_updated` is filtered like `entity_registry_updated` already was.** A device
  row reaches an allowlist through five fields (`id`, `area_id`, `name`, `name_by_user`,
  `via_device_id`). An `update` touching only `sw_version`, `hw_version`, `configuration_url`,
  `serial_number`, `connections`, `manufacturer`, `model` or `model_id` no longer rebuilds.
  Anything unrecognised still does.
- **The rebuild counter counts.** `REBUILD_COUNT` was declared, published as the
  `rebuilds_total` MQTT sensor, and never incremented — so the sensor built to reveal a rebuild
  storm read 0 straight through one. Also in `stats.json` as `allowlist.rebuilds`.
- **A rebuild says what caused it**: `device_registry_updated: update <id> (name_by_user
  changed)` instead of a bare event name. Changed fields were only ever printed for events that
  were *ignored*.
- **The identity probe carries `X-Forwarded-*`.** The bridge socket was fixed for this in
  2026.09; the `auth/current_user` probe beside it was not, so Home Assistant attributed a
  rejected token to the PROXY. With `ip_ban_enabled`, one panel retrying a stale token — or any
  LAN host posting junk Bearer tokens at `/stripper/client.json` — could ban the proxy's own
  address, and with it every panel.
- **The dashboard page is fetched once, under the forwarded-header rule.** With
  `trim_extra_modules` on and nothing to remove, the page was fetched from HA, discarded, and
  fetched again through the proxy. It was also the one path to HA that relayed a client-supplied
  `X-Forwarded-For` without our peer on the right. Multiple upstream `Set-Cookie`s now survive.
- **An empty auto-entities list item no longer fails the dashboard.** A bare `-` in YAML arrives
  as `null`, which threw out of the extractor; the whole dashboard was marked FAILED, and with one
  dashboard configured every rebuild died as "HA not ready".
- **Comparison filters work** — `"< 20"`, `">= 5"`, `"== 12"`, `"$$…"`, `"… h ago"` — ported from
  the auto-entities card's own matcher. They used to fall through to string equality and match
  nothing. And when a condition has a descriptive attribute beside a live test
  (`device_class: battery` + `state: "< 20"`), the allowlist now takes every battery and lets the
  card compare: evaluated against current state, a battery that dropped below 20 tomorrow was
  never forwarded, because no state change rebuilds an allowlist.
- **What the extractor could not resolve is logged** (`not resolved: …`). It always returned that
  list; nothing read it, so `or:` / `not:` / `floor:` produced an empty card and silence.
- **A regex cannot stall every panel.** A `/regex/` with a nested quantifier now runs under a
  50ms deadline (`node:vm` can interrupt a regex mid-backtrack; measured 51ms against 12.3s). One
  that hits it is switched off for the life of the process and reported. Ordinary patterns take
  the plain path and pay nothing.
- **mDNS forgets.** Goodbye records (TTL 0) are honoured, hosts and instances not re-heard in
  three query rounds expire, the tables are capped and take `.local` names only, names join
  case-insensitively, and a packet that only confirms what is known no longer rebuilds the index.
  Held hosts are re-queried each round so a bare `<name>.local` a client rule depends on does not
  age out while it is up.
- Smaller: `client rule null:` log lines now name the rule's actual matcher; a rebuild debounced
  just before the control socket dropped no longer fires against the dead socket and logs a
  misleading "unanswered for 60000ms" a minute later.

- **The log holds more than ten minutes again.** The satellite announce line (every 30s per
  panel — ~8,600 lines a day for three) and "no user rule matched" (every 5 minutes) are said once
  and then go to debug; the 10-second throttle could never collapse either. The resource report —
  some sixty identical lines per rebuild — is printed only when it differs from the last one.
- **Registry events rebuild at most once per 30s** (`REGISTRY_REBUILD_MIN_MS`, env-only, `0` =
  off). The backstop behind the field filter, for a field that does matter being rewritten every
  few seconds. A dashboard edit, a resource change and a pin are never held, including when a held
  registry rebuild is already pending.
- **Stats caps fold into `(other)` instead of dropping.** The flow map keys on the request's
  `Host` header and is counted before anyone authenticates, so 64 junk upgrades froze the routing
  view until restart, with the marginals no longer summing to the total. Same for the by-message
  table, where a new large stream past 64 kinds simply never appeared. Keys are length-capped.
- **One panel is one row in recent sessions.** The key included the mDNS name, which depends on
  which announcement arrived first. At the cap, eviction now drops the least recently *seen*
  client rather than the earliest first-seen — typically the wall panel up since boot.
- **Config store**: options are recognised by own property (`constructor` and `__proto__` passed
  the "known option" check); a persisted `__proto__` key can no longer replace the prototype of
  `managed`; a `history` that is not a list no longer makes every later save fail.
- **History**: a host containing `|` keeps its name and its own total; samples read back from
  disk are coerced, so one damaged row cannot turn a day of totals into `"5x"` or NaN.
- Hot path: six closures were allocated per HA->browser frame and are now per connection; a frame
  that goes out unchanged is no longer measured twice. `buildRegistryCtx` is memoised on the
  registries object (it ran 3 + one-per-dashboard times per rebuild).
- Nits: the `config.yaml` comment that still said the panel serves on 8100; `package-lock.json`'s
  root version, stale since 2026.09.13.29.
- **New icon.** A blade of grass cut by a strimmer line, its tip falling away, with two shorter
  blades beside it that sit below the line and are left alone — only what stands above the line
  gets trimmed. It replaces the funnel in `icon.png` and on the README banner; `assets/icon.svg`
  is the vector. The sidebar `panel_icon` is `mdi:grass` to match (was `mdi:filter-variant`).
  Both are app metadata, so they need a Rebuild — and sometimes a browser refresh — to show.

31 new tests; 472 pass.

---
## 2026.09.17.1 — 2026-09-17

**Security: the proxy's own address is now appended to any `X-Forwarded-For` chain a client
supplies.** Found by the upstream maintainer reviewing the httpxy migration (upstream PR #21),
and it applied here unchanged.

Home Assistant walks `X-Forwarded-For` from the right and takes the first address not in
`trusted_proxies` as the client. With host networking, the documented `trusted_proxies` is
`127.0.0.1`. node-http-proxy appended our peer to the chain; httpxy's HTTP path sets the header
only when it is absent, and the migration kept a client-supplied chain intact without adding our
hop. So any host on the LAN that could reach the proxy port could send
`X-Forwarded-For: <kiosk address>` and arrive at HA as that kiosk — a password-less login
through `trusted_networks`, which is the exact mechanism `host_network: true` exists to serve.

- What the client sent is captured at the front door, before httpxy fills the header in, and
  our peer is appended on the right. HA now meets a forger's real address first.
- Proto stays in step, or HA answers 400: one scheme stays one (it describes the whole chain);
  a chain grows by one, matching For.
- The HA-side bridge socket, which is opened without httpxy, follows the same rule.
- A reverse proxy in front of the app must now be in `trusted_proxies` for HA to resolve the
  client behind it, which is the standard configuration anyway. Documented in DOCS and INSTALL.
- Tests: a forged single entry arrives as `forged, peer`; a two-entry For with a two-entry Proto
  becomes three and three; no header becomes exactly the peer, once. The old assertion that only
  pinned chain length is gone, and CLAUDE.md's note claiming the append did not matter is
  corrected.

---

## 2026.09.16.10 — 2026-09-16

**Binary frames cross the bridge uncompressed, in both directions.** Both websocket legs
negotiate permessage-deflate for the JSON traffic, and until now every frame went through it —
including a browser voice satellite's PCM audio chunks on the way to Home Assistant and camera or
media frames on the way back. Those bytes are incompressible or already compressed, so deflate
only added CPU on both ends and a little latency to every audio chunk between the wake word and
the reply. Found while breaking down voice-assist latency end to end: the proxy adds no parsing to
the audio path, and this was the one thing it still did to it. `compress: false` on binary sends,
text frames unchanged.

---

## 2026.09.16.9 — 2026-09-16

**An override rule can now send a resource to one client.** Two new effects on `overrides`
rules, `resources_always_forward` and `resources_never_forward`, take the same URL fragments as
the global lists and apply them to the connections the rule matches.

The case that needed it. The Voice Satellite integration registers its 669KB bundle twice: as a
Lovelace resource, so `custom:voice-satellite-card` can be placed on a dashboard, and injected
into every page through `frontend.add_extra_js_url`. On a kiosk it runs in the second mode — the
bundle's own startup code reads the panel's stored config and starts the engine — and no dashboard
places the card. So the resource trim dropped it for every dashboard, correctly, and from `.15.37`
`trim_extra_modules` applied that same verdict to the injected import. Every browser satellite went
silent, with the dashboard rendering perfectly. The global `resources_always_forward` brings it
back by handing the bundle to every other panel as well, which is most of what the trim saved on
a small dashboard. A rule keyed to the panel's address sends it to that panel alone:

```yaml
overrides:
  - client: 10.2.4.129
    devices: ["Test Panel"]
    resources_always_forward: ["voice-satellite-card"]
```

- Reaches both places a resource is decided: the `lovelace/resources` reply, and the page's
  injected-module list when `trim_extra_modules` is on. A rule's own lists come first — never,
  then always — then the dashboard's decision.
- A rule keyed to a user, role or sign-in method applies to the resource list only: a page load
  carries no token to evaluate it against. The frontend imports every resource in that list, so
  the bundle still loads.
- The console's rule wizard offers both fields, suggesting the resources the trim has dropped
  somewhere, and lists them on a saved rule.
- Tests cover the resource list and the page, positive and negative: the named client gets the
  resource, a client the rule does not name does not, and a never rule withholds one the dashboard
  keeps.

---

## 2026.09.16.8 — 2026-09-16

**The last of the housekeeping.**

- **The console shows what every option resolved to.** It reported the raw option value, which
  is undefined for anything unset — so on a standalone container, where everything comes from the
  environment, every switch rendered off while `trim_entities` was plainly on. Add-on installs were
  only partly spared: Supervisor fills in defaults for required keys but omits the optional ones,
  so `mqtt_sensors` and `mdns_discovery` showed off on any install that had never touched them.
  `/config.json` now falls back to the constants the proxy actually runs on. A test pins it.
- **`stats.json` off Ingress no longer lists installed integrations.** The translations
  diagnostic is broken down by `component.<integration>`, which on the open port was an inventory
  of what is in the house. The counts and size stay for the health sensor; the keys are only
  served through Ingress.
- **DOCS.md** describes the console's theme control, the Clients column toggle, the flow diagram
  and the snackbar, and no longer calls the switches checkboxes.

---

## 2026.09.16.7 — 2026-09-16

**Housekeeping.** Every stats snapshot also took a snapshot of the request log, sorted its
slowest requests and packaged a summary — which `snapshot()` then dropped on the way out, since
it builds its result field by field and the panel reads the request log from `access.json`
directly. The block is gone. Every consumer of `stats.json`, including the panel's five-second
poll and the MQTT publisher, does slightly less work per call. No behaviour change.

---

## 2026.09.16.6 — 2026-09-16

**Housekeeping.** The proxy imported `node:module` and never used it — the compile cache is
turned on by `NODE_COMPILE_CACHE` in the Dockerfile, deliberately, and the comment explaining why
still says so. The import is gone. No behaviour change.

---

## 2026.09.16.5 — 2026-09-16

**Four small correctness fixes from the review.**

- **An icon pack needed only by an `always_forward` entity is now kept.** Resource keys were
  computed on each dashboard's set *before* the overrides were applied, so an entity that reached
  a dashboard only through `always_forward` contributed no icon namespace — the entity was sent
  and the pack that renders its icon was dropped, a blank icon with no error anywhere. The keys
  are computed after the override pass, against the set the dashboard is actually served. A test
  pins it.
- **A rebuild can no longer trim a dashboard's theme away mid-flight.** The set of themes in use
  was emptied at the start of a rebuild and refilled across the dashboard loop, which awaits
  between dashboards; a `get_themes` reply landing in that window was trimmed against a
  half-filled set. It is built into a local and swapped in at the end, like the resource maps.
  Only `trim_themes` was affected.
- **Hostname rules resolve in parallel.** They resolved one at a time, so a panel that was
  powered off held every rule after it for the length of its DNS timeout, on every rebuild.
- **The client-hint and self-identification maps are genuinely bounded.** They pruned only
  expired entries at the cap, so more live clients than the cap grew without limit; the oldest
  now go too.

---

## 2026.09.16.4 — 2026-09-16

**The panel now looks like the frontend it sits inside.** No proxy behaviour changes.

- **Home Assistant's own colour tokens.** Light is HA's default theme (`#fafafa` ground, white
  cards, `#212121` text); dark is its built-in dark theme (`#111111`, `#1c1c1c`, `#e1e1e1`), with
  dividers at 12% alpha, 12px card corners and Roboto first in the font stack. The blue-tinted
  greys stood out against HA's neutral surfaces. Success, warning and error use HA's values too.
- **A Light / Dark / Auto toggle in the header.** Ingress passes none of HA's theme into the
  frame, so the page could only follow the OS — a dark HA on a light desktop got a light panel in
  a dark frame. The choice is remembered per browser.
- **Sentence case throughout.** Card headers are 16px medium in the text colour; table headers,
  labels and section titles are plain secondary text — no small caps, no letter spacing.
- **Switches, not checkboxes,** for every boolean option, in rows at HA's 48px settings-row
  height. The native checkbox stays underneath for keyboard and screen readers.
- **MDI icons** replace the trash-can emoji on override rows and the unicode sort arrows on
  table headers, and the search fields carry a leading magnifier. Inline SVG masks in the
  current colour, so they follow the theme.
- **Save feedback is a snackbar** at the bottom of the screen, where HA puts it; the note at the
  top of the Config card was off-screen for every edit made further down. Errors show in red.
- **"Remove" on an override is error-red,** so a destructive button no longer looks like Cancel.

---

## 2026.09.16.3 — 2026-09-16

**The connection-path diagram crossed its bands for no reason.** Every column was ordered by
size, so on the instance this was found on the entry point `10.2.4.6` (164 connections, fed by
`direct`) sat above `10-2-3-6.coulson.io` (126, fed by `nginxproxymanager`) — and the green band
from the lower route had to cross the blue band from the upper one to reach it. Each column
after the first is now ordered by where its traffic comes from: a node sits at the flow-weighted
height of its sources in the column to its left, biggest-first only as a tie-break. Bands are
also drawn in source-then-destination order rather than biggest-first, so two bands out of one
node cannot swap places between the columns. Checked against the live flows: seven bands, no
crossings.

---

## 2026.09.16.2 — 2026-09-16

**The panel, after a UX review.** No proxy behaviour changes; everything here is in the console
and its request log.

- **Pin feedback told the truth's opposite.** The Entities tab says a pin applies immediately, and
  the confirmation under it always said "Restart the app to apply it." The server has returned
  `restartRequired` since `.16`; the page now reads it, so an applied pin says so.
- **Favicon 404s no longer lead the error ring.** Every browser asks for `/favicon.ico`, Home
  Assistant answers 404, and the HTTP card opened with those ahead of anything that had actually
  failed. Only that 404 is skipped — a 500 on the same path is kept, and the totals still count it.
- **Sparkline peak labels were stretched.** The charts are drawn with `preserveAspectRatio="none"`
  and the SVG `<text>` stretched with them. The label is HTML beside the chart title now.
- **Tabs no longer wrap on a phone;** the bar scrolls sideways like Home Assistant's own.
- **Dashboard sizes are formatted** — "12.7 MB", not "13032" under a "KB" header — and resource
  counts read "21 of 43".
- **The Clients table has an Essentials / All columns toggle.** Six diagnostic columns are hidden
  by default on screens under 900px and the choice is remembered. It sorts by client from the
  start, and repeated Client/Device cells are dimmed so a panel's several connections read as one
  group.
- **Empty states explain themselves after a restart:** "collecting — needs a minute of traffic
  first" and "nothing asked for yet" instead of a dash and "0 B HA never rebuilt".
- **The paragraphs of caveats under the tables fold** behind a one-line summary.
- The trimming pill in the header shows it expands; node and OS versions moved to the footer.

---

## 2026.09.16.1 — 2026-09-16

**Four behaviours from the same review, all around a connection that stops behaving.**

- **A wedged control command is now bounded.** `handshakeTimeout` only covered the upgrade; a
  Home Assistant that answered it and then never replied to `get_states` left the rebuild
  awaiting forever — and with it the `rebuilding` flag, so no later dashboard edit could ever
  trigger another. The add-on sat up serving the last allowlist and logging nothing. Every
  command on the control connection now times out (`CONTROL_RPC_TIMEOUT_MS`, default 60s, env
  only like `PROXY_TIMEOUT_MS`) and drops the socket, so the ordinary reconnect path rebuilds.
- **The HA-side bridge socket carries `X-Forwarded-*` and the User-Agent.** It is the one
  connection the proxy opens itself rather than through httpxy, so nothing set those headers and
  Home Assistant saw every trimmed panel as the proxy's own address. HA's failed-login handling
  keys on that address: with `ip_ban_enabled`, one panel holding a stale token could have got the
  proxy banned — every panel at once. Same rule as HTTP: set only when absent, For normalised in
  place, so the For and Proto chains stay in step.
- **Backpressure on a browser that stops reading.** Nothing paused the HA side on a stalled
  client, so its backlog grew in this process without bound. Past a high mark
  (`BACKPRESSURE_HIGH_BYTES`, default 8MB) the HA stream is paused and resumed once the queue
  drains to a quarter of that; a client that makes no progress at all for `BACKPRESSURE_STALL_MS`
  (default 60s) is terminated — not closed, since a close frame would queue behind the very
  backlog it is not reading — and reconnects fresh. `stats.json` gains `backpressure: { pauses,
  stalls }`: pauses are a slow link, a climbing stall count is a broken panel.
- **One user lookup per token, not one per socket.** A kiosk load opens several websockets within
  milliseconds, all with the same token, and each opened its own probe to Home Assistant before
  the first had answered. Later callers now wait on the first's promise.

**The registry cache could answer a widened user with another connection's rows.** A real
correctness fix for anyone using `user_overrides` (or a `role:` / `auth_provider:` rule).

The cache key carries a signature of the connection's allowlist, and that allowlist is still
moving while the user-rule gate is closed — the whole reason the signature is taken lazily. But
the cache **lookup** ran at receive time, ahead of the gate: a registry request arriving while
`auth/current_user` was in flight took the signature of the *pre-rule* set, found the entry a
connection without the rule had left there, and answered with rows missing exactly the entities
the rule adds. A hit returned before ever reaching the queue, so the gate never saw it. The
existing two-users test only ran the order that happens to pass (widened user first, cache cold).
Reversing the order and slowing the lookup reproduces it every time; that test is now in the
suite, and the lookup runs inside the held thunk alongside the `subscribe_entities` stamp.

**Pins from the panel now write to the source that owns the option.** There are two —
Supervisor's options and the console's config store — and the store wins at boot. A pin was
written to Supervisor regardless, so once `always_forward` or `resources_always_forward` had
been taken over in the console the pin landed in the shadowed source: it applied until the next
restart and then silently vanished, with the panel having said "pinned". Standalone containers,
which have no Supervisor, got "not running as an add-on" and could not pin at all; they now
write to the store in `/data`, seeded from whatever is in effect so the env-configured entries
are carried along. The pin response carries `source: addon | console`.

**A rebuild that adds entities now reconnects only the panels whose dashboard grew.** It used
to drop every open bridge whenever the union gained anything, so pinning one entity for the
admin dashboard bounced every wall panel in the house — each reconnecting to be served exactly
what it already had. Growth is judged per dashboard, which also catches an entity *moving*
between dashboards, where the union is unchanged and the receiving panel was never recycled.
Unattributed connections still follow the union. The log line reads
`reconnecting 1 of 6 open dashboard connection(s) … (office-tablet)`.

---

## 2026.09.15.37 — 2026-09-15

**`trim_extra_modules` silently broke per-browser dashboard attribution.** If you run that option,
this is a real correctness fix.

A connection is attributed **cookie first**, then the IP hint, then the User-Agent. The `ws_dash`
cookie was only ever set by the proxy's `proxyRes` hook — but `serveDashboardPage()`, the one
request the app answers itself in order to rewrite a page's injected-module list, **writes its own
response, so that hook never runs**. The cookie lives for a year.

The result: a browser stayed pinned to whichever dashboard had served it last *before*
`trim_extra_modules` was switched on, and every later visit to a different dashboard was served
the wrong dashboard's entities and resources — permanently, surviving reloads and cache-busting.

Observed on the instance this was found on: a browser sitting on `/dashboard-test` receiving
`office-tablet`'s 88 entities and 7 resources, repeatedly. It cost most of an evening to corner,
and sent a dashboard investigation down entirely the wrong path.

**Wall panels never showed it**, which is why it hid: each loads exactly one dashboard, and a
browser with *no* cookie falls through to the IP hint, which is refreshed on every request. Only a
browser that moves between dashboards is affected.

Both answer paths now share one `dashCookieHeader()` definition, so they cannot drift — a test
asserts they produce byte-identical cookies, lifetime included, because a browser's attribution
must not depend on which code path happened to serve it.

**The log now names which signal won.** `entity payload delivered to 10.2.4.129 (dashboard-test
via cookie)` — or `(union — no dashboard attributed)`. Without it, a connection attributed to the
wrong dashboard is unreproducible once closed: the Clients tab shows it live, but the log is what
survives, and that is the gap that made this bug so expensive.

**That log line also had no test, and the first attempt at it crashed a live instance.** The
dashboard clause sits inside a ternary on `dash`, and every existing test connected
*unattributed* — so `dash` was null, the branch was never evaluated, and a `ReferenceError` in it
passed 421 tests before failing on the first real panel that had a dashboard. The suite now covers
both branches of that line, with a test that reproduces the crash exactly when the bug is
reintroduced.

Two things are worth taking from it. A log line is code, and an untested branch is untested
whether or not it looks trivial. And the `.34` decision to make a `ReferenceError` fatal rather
than retried is what turned it into an obvious outage instead of an add-on that stays up serving
nothing — the failure mode that previously took an afternoon to notice, twice.

---

## 2026.09.15.36 — 2026-09-15

**The resource diagnostics now check themselves.**

The previous release fixed a report that was lying — "dropped by ALL dashboards" named 42 of 42
resources on an install where one dashboard alone kept 21. What's notable is how it was caught: not
by a test, but by **arithmetic**. A resource dropped by every dashboard cannot be one some
dashboard keeps, so that set is bounded by what the most generous dashboard leaves out. 42 was
impossible against a ceiling of 21.

That reasoning now runs at startup, in [`resource_invariants.mjs`](resource_invariants.mjs). Two
checks, each derived **differently** from the values it checks, so a bug in one path cannot hide in
the other:

1. **Counting** — the dropped-by-all set cannot exceed `total − (largest keep set)`.
2. **Set membership** — computed from the per-dashboard drop lists rather than the union used to
   build the report: if a resource really is dropped everywhere, every dashboard's own list has it.

A violation logs `DIAGNOSTIC BUG` **above** the suspect list, saying the trim is unaffected and not
to act on what follows — because the remedy that report recommends is `resources_always_forward`,
and acting on a wrong one un-trims the resource list one bundle at a time.

Deliberately **not** checked: `kept + dropped == total`. That relation is true by construction
(`dropped` is defined as `total − kept`), so it can never fail — a check like that is decoration,
and there is a test asserting it is not what trips the checker.

Proven end to end rather than asserted: reintroducing the original bug makes both checks fire at
boot; restoring the fix silences them. 418 tests.

---

## 2026.09.15.35 — 2026-09-15

**The "dropped by ALL dashboards" warning was naming every resource you have.** Trimming itself
was never affected — no dashboard was ever served the wrong resources — but the diagnostic that
exists to catch the *one* failure you cannot see was reporting nonsense.

It compared each resource's **raw URL** against a set of **normalised paths**. Every HACS resource
arrives as `…/card.js?hacstag=NNN`, so the comparison matched nothing and the warning concluded
that nothing was served anywhere. On the instance this was found on it named **42 of 42**
resources as dropped by every dashboard — on an install where one dashboard alone keeps 21.

That is worse than a cosmetic bug, because of what the warning tells you to do next: pin the named
resources with `resources_always_forward`. Following it would have un-trimmed the entire resource
list, one bundle at a time, while every dashboard was in fact being served correctly. It is also
the one diagnostic that cannot be sanity-checked by loading a page — it covers resources that
render nothing and only act on load — so there was no way to notice from the dashboard that it was
lying.

The per-dashboard counts (`resources <dash>: 21/42 kept`) were always right, and the arithmetic
between the two is how it was caught: with 42 resources and 21 kept by one dashboard, at most 21
can be dropped by all of them.

Both regression tests use URLs carrying a `?hacstag=` cache-buster, because that is the entire
bug — **with clean URLs the test passes against the broken code.**

---

## 2026.09.15.34 — 2026-09-15

**Runtime hardening, now that this runs on Node 26. Nothing here changes what gets trimmed.**

**A restart is no longer an abrupt kill.** The Supervisor stops an add-on with SIGTERM, and this
app had no handler for it, so Node died where it stood — no exit hooks, no pending writes. Two
things were being lost that way, neither of which announced itself:

- **Up to five seconds of dashboard hints.** The file that lets a panel keep its dashboard across a
  restart is written on a debounce, and the pending write was dropped by exactly the restart those
  hints exist to survive. It is now flushed on the way out.
- **The compile cache** — see below.

Open websockets are not waited on: panels hold theirs for days, so draining them would just mean
waiting for the SIGKILL. The listeners close, a second signal exits immediately, and a bounded
timer ends it either way.

**Compiled bytecode is now cached between runs, and this time it is actually written.** The
previous build enabled it from inside `ha_ws_trim_proxy.mjs` — which does nothing at all: this is
an ES module, so every static import is compiled *before* the first statement of the body runs. It
is now set as `NODE_COMPILE_CACHE` in the Dockerfile, which is read before any of it is compiled,
and pointed at `/data` rather than Node's default under `/tmp` — a container discards `/tmp` on
precisely the restart the cache exists to speed up. Measured: in-body call 0 files cached, env var
2. Both halves are needed, and the test boots the real proxy, stops it with SIGTERM, and looks for
the files.

**A code error in post-auth setup is now fatal instead of retried forever.** A `ReferenceError`
there can never succeed on a retry, and retrying it hid it completely: the add-on stayed *up*,
logged "reconnecting" once a second, and served no allowlist. That reads like a slow Home
Assistant rather than a crash, which is how it went unnoticed twice in one afternoon. Operational
failures — Home Assistant restarting mid-build — still retry exactly as before.

**Keep-alive timeouts suit sitting behind a reverse proxy.** Node closes an idle keep-alive
connection after 5 seconds; nginx holds upstream keep-alives for 60. In that gap nginx can reuse a
socket Node has just closed and hand back a sporadic 502 that gets blamed on anything but the
timeout. Both servers now hold for 65s, with `headersTimeout` above that.

**Not done, because it was measured rather than assumed:** raising the V8 young generation
(`--max-semi-space-size`). On a 10MB registry payload it is a real win — 33 GC pauses and 62ms
down to 15 and 25ms. But the live payload mix is not that: over 1.7 hours this instance sent a
~10MB registry **twice**, against 132 translation payloads of ~200KB and 139 repairs payloads of
~25KB, where the flag does nothing. It would buy ~35ms twice an hour, at the cost of more resident
memory. Not shipped.

---

## 2026.09.15.32 — 2026-09-15

**Documentation caught up with the day's changes, and one gap it exposed was closed.**

`DOCS.md` now documents the unified `overrides` list with every matcher, the `client_api_*`
options, `mgmt_port`, and — new — **the Config tab**: per-option ownership, why setup options stay
in YAML, the override wizard, and exactly what the console's own port will and will not serve off
Ingress. The renamed options are corrected throughout, with the old name noted where a reader might
be carrying it.

**[docs/MIGRATING.md](../docs/MIGRATING.md) is new.** Its first line is that nothing is required —
every old option name and every older override list is still read. It covers the five renames and
why two of them need a moment's thought rather than a blind rename, shows the four override lists
becoming one line for line, and names the behaviour changes worth knowing about even if you rename
nothing.

**Writing it found a real gap.** The migration guide claimed a unified rule could do `user_agent` +
`assume_dashboard`. It could not: attribution was still read only from the old
`user_agent_dashboards` key, and unifying the wizard had dropped the "serve dashboard" effect
entirely — so **the wizard could no longer create the rule that key exists for**. The unified list
handles it now, and the wizard offers it when a client-app matcher is chosen.

---

## 2026.09.15.31 — 2026-09-15

**A device that announces itself several times gets a stable label.**

A panel commonly advertises more than once — as ha-paneld AND Kiosk Satellite AND ESPHome, each
with its own version. Three of twenty-four discovered addresses here do it. The label was whichever
record arrived first, so the same panel could show as ESPHome one boot and Kiosk Satellite the
next, purely on multicast timing.

The order is now **ha-paneld, then Kiosk Satellite, then ESPHome**, most-specific first: the first
two are the software actually running the panel, ESPHome is the firmware underneath — true of the
device, and the least useful answer to "what is this". An unrecognised kind sorts last rather than
being discarded, because an unknown label beats no label.

**This decides what is displayed and nothing else.** A rule matching `mdns_kind` still tests every
record for an address, so a panel remains matchable as ESPHome whatever it is shown as.

**`host` is now `entrypoint`.** "Host" is ambiguous in this codebase — it already means the Home
Assistant being proxied to, the machine this runs on, and the hop in front of it. `entrypoint` says
which door the client came through, matching the word the Clients tab already uses. `host` is still
accepted, and the new name wins when a config carries both.

---

## 2026.09.15.30 — 2026-09-15

**Three more things an override rule can match on**, all from data this app already had and none
of it newly collected.

**`mdns_kind`** — what a device announces itself as: `Kiosk Satellite`, `ESPHome`, `ha-paneld`,
`Google Cast`. "Every Kiosk Satellite panel" as one rule, with no addresses to maintain as DHCP
moves them. **It matches ANY record for an address, not the first**, because a panel commonly
announces itself more than once: measured here, three of twenty-four discovered addresses advertise
both `Kiosk Satellite` and `ESPHome` with different versions. Testing only the first record would
have made the rule depend on which multicast answer arrived first.

**`host`** — the hostname the client actually arrived on. One instance is reachable by several
names, and "anything coming in via the IoT entry point" is a rule that address lists approximate
badly.

**`auth_provider`** — `homeassistant` or `trusted_networks`. "Anything logged in through trusted
networks" is the kiosk pattern without naming a device: the addresses move, the login method does
not. Identity, so it waits for the auth gate exactly as `user` and `role` do.

**Unknown means no.** A device that announced nothing does not match an `mdns_kind` rule, and a
connection with no hostname does not match a `host` rule. These matchers WIDEN what a client is
served, so an unknown device silently matching would hand entities to anything on the network.

**An mDNS name is a label a device chose for itself** — unverified and trivially spoofable by
anything on the network. Fine for "serve this panel more entities"; not a security boundary. The
same reason discovery is observational everywhere else here.

The user cache gains `providers` (the credential TYPES, never the credential records) because a
rule reads it; entries written before this are dropped on load rather than left to make such a rule
silently fail to match.

---

## 2026.09.15.29 — 2026-09-15

**Override rules can match a ROLE instead of a person.**

`role: admin` (or `role: user`) attaches entities to whoever is an administrator rather than to a
named individual. Home Assistant has exactly two roles, so this is a two-value matcher; it is
called `role` rather than `admin: true` because that is how the question is asked, and because it
will not need rewriting if HA ever grows a third.

This is usually what a per-user rule is approximating. "Admins see `update.*`" written as
`user: David Coulson` silently stops covering anyone else who becomes an admin, and silently keeps
covering David if he stops being one.

It combines with every other matcher, so "an admin, on lovelace" is one rule. The wizard offers it
as a dropdown.

**Two bugs found by the tests while wiring it, both the silent kind:**

* A role-only rule has no `user`, and the check for "does this rule have any matcher at all"
  did not know `role` was one — so the rule was **discarded at startup** with a warning about
  matching everything.
* `rulesForConnection` holds back rules naming a user until the auth gate, because identity is
  not known when the socket opens. It tested only for `user`, so a role-only rule went through
  **at connect time, applied to everyone** — including non-admins. The precise opposite of what
  it says.

`is_admin` now joins `id` and `name` in the user cache, because a rule reads it. Nothing else from
Home Assistant's user object is written, and a cache entry from before this release is dropped on
load rather than left to make a `role` rule silently fail to match for the rest of its TTL.

---

## 2026.09.15.28 — 2026-09-15

**A restart no longer costs every panel its dashboard.**

Per-dashboard attribution rests on a hint: a panel's dashboard page request records "this address
is looking at office-tablet", and the websocket that follows is served that dashboard's entities
rather than the union of every one. The map lived only in memory, so **every restart threw it
away** — and a panel whose websocket reconnects without re-fetching its page then has no hint at
all.

Measured on a live instance after a rebuild: a panel served **488 entities where it should have had
108**, and it stayed that way until something made it reload. That is the app quietly not doing its
job, triggered by the most ordinary event there is.

The hints are kept in `/data` now. Verified by restarting with hints in place:
`client hints: 5 still valid, 0 expired`.

**The TTL is unchanged at ten minutes**, exactly as with the user cache. A restart takes about
twelve seconds, so ten minutes already spans one; persisting buys the restart case with no increase
in staleness. A hint older than the TTL is dropped on load, and so is one naming a dashboard this
app no longer serves — resurrecting that would label a panel with something it is not being served.

Writes are debounced and atomic: a wall panel reloading would otherwise rewrite the file several
times a second, and a crash mid-write must not leave one that fails to parse on the next boot.

What is written is an address and a dashboard `url_path` — no identity, no token, nothing about
what the panel was served. It is still a list of addresses, and `/data` is in Home Assistant
backups.

Note that a client attributed by COOKIE was never affected: the cookie lives in the browser and
survives a restart on its own. This is for the connections that have no cookie — a panel's first
connection, and clients that do not keep one.

---

## 2026.09.15.27 — 2026-09-15

**The resource trim can see fonts.**

A CSS resource names no custom element, so the card matcher had nothing to match on and **every
stylesheet was dropped for every dashboard**. That is right by accident when nothing uses the
font and wrong silently when something does: a missing `@font-face` throws nothing and logs
nothing — the dashboard just renders in the fallback face, and the first report is someone saying
"it looks different".

A stylesheet is now kept for a dashboard that asks for one of the families it declares. Families
are read from `@font-face` blocks in the body that is already fetched for the card scan, so this
costs no extra request.

**Themes are included, and that is the point.** A font is far more often set by a theme than by a
card, so the check covers the dashboard config, the themes that dashboard names, and the instance
default themes. Scanning only the config would have dropped the stylesheet a theme depends on.

**Two traps avoided, both found by measuring rather than reasoning:**

* Matching is against `font-family` declarations, not the raw config. Card bundles declare fonts
  with names like `inter`, and a substring search finds that inside "printer", "interval" and
  "winter" — a dashboard mentioning a printer would have kept a 663KB bundle.
* "Could not check" and "checked, no fonts named" are different answers. Conflating them (an empty
  string read as falsy) kept every bundle carrying an `@font-face` on every dashboard that simply
  does not style fonts: **1,940KB per dashboard** on a live instance. Verified fixed by comparing
  per-dashboard kept/dropped bytes against the pre-change baseline — all five identical.

Dropped stylesheets now report the families they declare, because that drop is the silent one: a
missing card says "Custom element doesn't exist", a missing font says nothing at all.

**Not covered, and cannot be:** a `@import url(...)` inside a card's own `card_mod` CSS is not a
Lovelace resource. The browser fetches it while rendering the card and this app never sees it —
localise the font and point the import at `/local/...` instead.

---

## 2026.09.15.26 — 2026-09-15

**An access list for the panel status API, checked before authentication.**

Almost every caller of `/stripper/client.json` is a wall panel a few metres away; almost none is
legitimately remote. `client_api_access` decides who may even try:

* **`lan`** (default) — answer only requests that arrived locally. Internet and Cloudflare
  requests are refused **before the token is looked at**, so a remote caller cannot make this
  add-on open a websocket to Home Assistant to validate one.
* **`any`** — no network check; the token alone decides.
* **`off`** — the endpoint answers nobody.

`client_api_allow` lists addresses or CIDRs that are allowed whatever the mode says, for a panel on
a subnet this add-on does not consider local. Both are editable from the Config tab; the mode is a
dropdown, which is a new control type the console did not have.

**What it is worth, stated honestly.** Three signals, in descending order of trust: Cloudflare's
own headers (set at the edge, a client cannot remove them), the peer address (the TCP source, not
forgeable), and the resolved client address — which comes from `X-Forwarded-For`, whose leftmost
entry is supplied by the caller. So a remote caller behind a proxy that appends rather than
replaces can still look local. **This narrows who may try; the token is still the boundary.**

A blocked request gets `403`, deliberately not `404`: a panel reads `404` as "the trimmer is not in
front of me", and telling a blocked local panel that would be the opposite of the truth.

---

## 2026.09.15.25 — 2026-09-15

**Security: the management port was serving credentials and a full inventory of the house to
anything on the network.**

Writes were gated from the start. Reads were not, on the reasoning that statistics are harmless.
They are not. The management server binds every interface, so all of this was readable without
authentication by anything on the LAN — including the IoT VLAN the panels sit on:

* **`/access.json` — the request log.** Home Assistant puts credentials in request PATHS as well
  as in query strings. Measured on a live instance: **2 webhook ids, 37 HLS stream tokens and 4
  signed camera-proxy paths** sitting in the ring. A webhook id is a bearer credential — anyone
  holding one can POST to it with no authentication and fire whatever automation it drives. Query
  strings were already stripped, which is why the JWT in `?authSig=` never reached the log. Paths
  were not, and that was the half that mattered.
* **`/entities.json` and `/devices.json`** — every entity and device on the instance, by name.
* **`/config.json`** — the override rules, which name Home Assistant users.
* **`/stats.json`** — every connected client: address, resolved Home Assistant user, User-Agent,
  internal hostname, mDNS device name, and the routing breakdown keyed by hostname.

All of the above now require Ingress, except `stats.json`.

**`stats.json` stays public, and is redacted instead.** A `rest:` sensor polls it for a health
signal, and that fetch comes from Home Assistant core rather than through Ingress — gating it
wholesale would have silently taken that sensor down, which this add-on already did once by moving
its port. So the aggregates stay and the identities go: counts instead of the client list, no
discovered devices, no resolved hostnames, no routing breakdown. Dashboard names and installed-card
paths are deliberately KEPT — they are configuration, not identity, and anyone who can load a
dashboard already sees both.

**`/stripper/client.json` now requires the caller's own Home Assistant token**, validated against
Home Assistant and cached on the same ten-minute schedule as the per-user lookup. There is no new
secret to provision. It started unauthenticated on the reasoning that it says little; that does not
survive the company it keeps, and there is no good reason for a device that cannot log into Home
Assistant to learn which dashboard a panel is on or how much traffic it moves. A `401` is still a
positive detection — the trimmer is in the path, the token is the problem. The endpoint answers the
CORS preflight the `Authorization` header forces, so a panel admin page on its own origin still
works.

The Config tab now explains the refusal instead of rendering blank when opened on the app's own
port.

**Not affected:** tokens are never logged or written anywhere, the panel is served from memory
rather than from a path (no traversal), and query strings were already stripped from the log.

---

## 2026.09.15.24 — 2026-09-15

**The user cache survives a restart.**

Resolving a user means opening a second websocket to Home Assistant to ask who a token belongs to,
and every message on that connection is held until it answers — measured at 195–324ms on a healthy
instance, and about 3.5s once under load. The cache already spared the repeat cost within a
process; it is now kept in `/data`, so a restart does not make every session pay again. Verified:
`user cache: 4 still valid, 0 expired`.

**The TTL is deliberately unchanged at ten minutes.** "Users rarely change" argues for caching for
hours, and that is the half worth refusing: the TTL is what bounds how long a revoked token or a
renamed user keeps applying rules after Home Assistant has stopped agreeing. A restart takes about
twelve seconds, so ten minutes already spans one — persistence buys the restart case with **no
increase in staleness at all**. An entry older than the TTL is dropped on load rather than trusted
because it was written down.

**What is on disk:** `sha256(token)` -> `{ id, name }`. Never the token, and nothing from the user
object beyond what the rules match on. It is still a token verifier and `/data` is included in
Home Assistant backups — which is why it stores as little as it can. A failed lookup is still
never cached, so one slow moment from Home Assistant cannot disable a user's rules.

Note that the lookup is skipped entirely for any dashboard no user rule targets, so this only ever
mattered for connections that were already paying for it.

---

## 2026.09.15.23 — 2026-09-15

**A searchable picker for entities and devices, and a device-name bug worth knowing about.**

**The override wizard stops asking people to type from memory.** Entity and device fields now
search as you type — entities against the instance's own list, devices against the registry the
proxy has already read, so a keystroke costs nothing upstream. The device picker shows what naming
each device would pull in, because that is the decision being made.

**It is search-assisted, not search-only.** Half the legitimate values here cannot be found by
searching: an `always_forward` entry is routinely a `/regex/`, which matches nothing in a list of
entity ids and is the whole point of the feature. Enter commits whatever is in the box whether or
not it matched a suggestion. A picker that only accepted what it could suggest would have looked
finished and been strictly less capable.

**`GET /devices.json`** joins `/entities.json` on the management port — names and entity counts,
nothing else.

**Fixed: a rule naming a device that shares its name with another device expanded the wrong one.**
The name lookup was a map of name to a single id, so two devices with the same name collapsed to
whichever came last in the registry, silently, with nothing anywhere saying which had been chosen.
Duplicate names are ordinary — an integration re-adds a device, or two panels are built the same
way. **Every device with that name is expanded now**, which follows the asymmetry used throughout
this codebase: a needless entity costs bytes, a missing one blanks part of a card with no error.
The log says when a name matched more than one, so an over-broad rule can be narrowed
deliberately. The picker shows one row per name, carrying the combined total.

**Test deadlines raised from 8s to 25s.** These wait on a freshly spawned proxy reaching a log
line, and the suite runs its files in parallel — a dozen node processes booting at once pushed two
of them past 8s and failed a green build twice. Nothing here measures boot time, so a generous
ceiling costs nothing while a genuine hang still fails.

---

## 2026.09.15.22 — 2026-09-15

**Documentation only. No behaviour changes.**

The field-by-field guide to `GET /stripper/client.json` now lives in the repo, where the projects
building against it can read it: [`docs/CLIENT-API.md`](docs/CLIENT-API.md), linked from the
README. It covers detection (`200` means in-path, `404` means talking to Home Assistant directly),
every field and what `null` means in each, the boundary of what the endpoint will never return,
and the rules of engagement for a client — do not poll from a dashboard, ignore unknown fields,
render `null` as "not known" rather than zero.

`docs/client-api.html` is the same content as a standalone styled page, for sending to someone who
is not working in this repo. Markdown is the in-repo format deliberately: GitHub renders it, while
an HTML file shows as source to anyone reading it there.

---

## 2026.09.15.21 — 2026-09-15

**A panel can ask what the trimmer is doing for it.**

`GET /stripper/client.json` on the proxy port. It exists so a panel — ha-paneld, Kiosk Satellite —
can render an admin screen saying whether the trimmer is in front of it, what it is cutting, and
what that is worth on its own connection.

**Reaching it is the detection.** The path is served by the proxy and never forwarded, so a `200`
means the Stripper is running *and in the path* for that client, and a `404` means the client is
talking to Home Assistant directly. Both halves of "is it running", answered by arriving.

**Nothing is added to dashboard loads.** A header was considered and rejected: it would put bytes
on the response every panel fetches on every boot, to carry a snapshot taken *before the websocket
exists*, for a screen that is read occasionally. This is a pull, so it costs nothing until someone
opens the screen — and it returns live numbers rather than boot-time ones.

**A panel sees itself, not the estate.** The proxy port is reachable by anything on the network
and has no authentication in front of it, so every field is something that network may read:
booleans for what is trimmed, and the caller's own figures — dashboard, entities served, first
payload timing, bytes not sent. It never returns override rules, allowlist contents, entity ids,
Home Assistant user identities, or any other client's data, and there is **no way to name a
different subject** — otherwise any device could enumerate every panel from an unauthenticated
port. Both leaks are covered by tests that fail if reintroduced.

Advisory only: render it, do not gate behaviour on it, and do not relay it off the local network.

`docs/CLIENT-API.md` documents the shape; a field-by-field integration guide is available for
client developers.

---

## 2026.09.15.20 — 2026-09-15

**Configuration moved into the app's own panel, and override rules became one thing.**

**A Config tab that is a control panel, not a reference.** The add-on's options outgrew what a
Supervisor schema can express: nested groups do not render in the Configuration tab at all,
sub-options cannot carry descriptions, and there is no validation beyond types. Options are now
grouped into sections — Trimming, Dashboards and entities, Custom cards, Overrides, Device
discovery, Monitoring, Websocket — each boolean is a checkbox with a sentence beside it, and each
list is its items with a remove button and an add box rather than a JSON array in a text field.
Order within a section is editorial, not alphabetical: alphabetical opened the trim list with
"Only the dashboard being viewed" and buried "Entity websocket", which decides whether any of the
rest matters.

Changes are **per-key**: an option is owned by the console only because someone deliberately
changed it there, and everything else still comes from the add-on's own Configuration tab. Taking
a setting over never changes it — it is seeded from whatever is already in effect. Setup options
(`proxy_port`, `mgmt_port`, `ha_base`, `allow_ws_url`, `log_level`) are deliberately **not**
editable here: how the process binds and finds Home Assistant has to stay fixable from Home
Assistant when this console is the thing that is broken.

**One override rule type, any combination of matchers.** `dashboard_overrides`, `user_overrides`,
`client_overrides` and `user_agent_dashboards` existed because rules are evaluated at four
different moments — not because they were four different kinds of thing. They are now compiled
into a single `overrides` list with one matcher, and **a rule may match on a dashboard, a user, a
device and a client app at once**: "David, on lovelace, from the office panel" is one rule. The
old keys still work and are read into the same list at startup, so no configuration needs
changing.

Timing is derived from the rule instead of the key it sat under: a rule naming a **user** waits
for the auth token to resolve, because that is the first moment the whole rule can be decided;
everything else applies when the socket opens. A rule with **no** matcher is dropped and logged
rather than applied everywhere — that is what the global always/never lists already are. Startup
logs the rule count broken down by matcher, because "my override does nothing" is the commonest
complaint and whether it parsed at all is the first thing worth knowing.

The panel shows every rule as one list, whichever key holds it, with a pill per matcher, its
effect in words, delete behind a confirmation, and a wizard that asks what to match on and then
what to do.

**A stored cross-site scripting hole in the panel, closed.** Request paths, methods and addresses
went from the HTTP log straight into `innerHTML`, so **anyone who could reach the listen port
could store markup that ran the next time an admin opened the console**. Every value is built as
text now, and a test refuses `innerHTML` anywhere in the panel unless a comment justifies it.

**Two renames**, both with the old name still honoured and read *second*, so a config carrying
both obeys the new one:

- `strip_entities` → **`trim_entities`**. The option doing the central trim was the one not called
  `trim_*`.
- `per_dashboard` → **`by_dashboard`**. The old name described the mechanism, not the effect.

`strip_entities: false` and `per_dashboard: false` are deliberate choices, so an inert key would
have silently reversed them for exactly the people who had set them.

**Also:** `panel.html` is parsed by the test suite — it is served as a blob and only runs in a
browser, so a syntax error previously survived a green suite and a clean deploy and showed up as a
blank console.

---

## 2026.09.15.1 — 2026-09-15

**`trim_extra_modules` — the JavaScript integrations inject into every page.**

Some integrations add frontend JavaScript through Home Assistant's `frontend.add_extra_js_url`
instead of registering a Lovelace resource. Those modules never appear in `lovelace/resources`, so
`trim_resources` cannot see them: they load on **every** dashboard, whatever it renders.

Measured on the instance this was built against — **814 KB injected this way, of which 669 KB is
`voice-satellite-card.js`**, a card the resource trim had *already dropped* for that dashboard. It
was removed from the resource list and loaded anyway, through the other door. On a px30 wall panel
that is 493 ms of parsing per load for a card that was never on the page.

**The rule adds no new guesswork.** A module is removed only when it is *also* a registered
Lovelace resource **and** the resource trim dropped it for this dashboard — the decision already
made, applied to the channel it was leaking through. Icon packs, frontend patchers and anything
else injected but never registered as a resource are left completely alone, because nothing here
knows what they do. `resources_never_forward` reaches them for manual removal, and
`resources_always_forward` overrules it, the same precedence the resource rules use.

Requires `trim_resources`, since that is where the decision comes from. **Off by default.**

**This is the one request the add-on does not stream through.** Editing the page means reading it
whole, so the dashboard page is served directly instead of proxied, with `Accept-Encoding` dropped
on the way up so Home Assistant answers in plain text — re-compressing 10 KB would buy a few KB of
LAN traffic in exchange for a Brotli round trip on every load and a second way to corrupt the one
response that must not be corrupted. **Every failure path falls back to serving Home Assistant's
own page untouched**: a fetch failure, a non-HTML answer, a page the pattern does not match, or
anything thrown. A broken card is a blank square; a broken page is a panel that never boots.

**Reporting, because a removed module fails silently.** `stats.json` gains
`resources.extraModulesByDashboard`, recording both halves per dashboard — and the panel shows
them. **Still loaded** is the half worth reading: those are the modules this add-on deliberately
refuses to judge, so a panel that has quietly lost a behaviour is either explained by *Removed* or
is not this add-on's doing at all.

---

291 tests. Five written here, each verified by reintroducing the bug it catches. Two were wrong
first time: the byte-identity check stripped indentation the rewrite deliberately leaves, and the
`resources_always_forward` test passed against a build with the override deleted, because the
module it used was already protected by the resource decision — it now tests the only case where
that line does any work, an always rule overruling a never rule.

## 2026.09.14.24 — 2026-09-14

**A bundle that merely mentions a card is no longer treated as providing it.**

The literal test answers "could this bundle define this card". It cannot answer the reverse, and a
bundle that only *mentions* another card's name matches it just as convincingly. Measured on a
real instance, that kept four bundles a dashboard never used:

| Bundle | Why it was kept | Cost on a px30 wall panel |
|---|---|---|
| `bubble-card.js` | contains the literal `grid-layout` | 607 ms |
| `swipe-navigation.js` | contains the literal `navbar-card` | 307 ms |
| `simple-swipe-card.js` | contains the literal `grid-layout` | 259 ms |
| `utility-cards.js` | contains the literal `navbar-card` | 153 ms |

Each mentions those names because it *integrates with* them. The dashboard in question renders
four card types and none of these was among them.

A card's provider almost always says so in its **file name** — `navbar-card` lives in
`navbar-card.js`, `whisker-card` in `whisker.js`, `grid-layout` in `layout-card.js`. So when a
resource's path identifies it as the provider, only that resource satisfies the card type, and a
bundle that name-drops it no longer counts. Where nothing identifies a provider — the
runtime-built-name case, like `mushroom.js` — the previous body test runs unchanged, so the
failure mode is the behaviour that already shipped, never a resource dropped on a guess.

**Two measurements shaped the rule, and both contradicted the obvious version.**

*Frequency must be counted over paths, not bodies.* The fragment `layout` appears in 24 of 42
bundle bodies — far too common to identify anything — while naming exactly one file. Judged by
bodies it is noise; judged by paths it is the answer.

*A fragment shared across card names identifies nothing, but "shared at all" is too blunt.*
`card` belongs to nearly every card type and names a file in almost every install. `layout`
belongs to four names out of thirty-five and names one file. A flat "more than one type
disqualifies it" was implemented first, shipped to a live instance, and left the 1 MB
`bubble-card.js` in place; a proportional quarter-of-all-types threshold separates the two and
scales with the instance rather than with the test fixture.

**Result on the instance this was found on**, with no card reported unrenderable on any dashboard:

| Dashboard | Resources kept | JavaScript kept |
|---|---|---|
| basement-stairs-panel | 9 → **5** | 2,319 KB → **871 KB** |
| lovelace | 23 → 21 | 8,965 KB → 8,502 KB |
| dashboard-test | 15 → 14 | 4,210 KB → 3,219 KB |

**What this does not do is make that panel measurably faster, and the honest report is that it
did not.** Warm load on the px30 panel measured 10.4 s before and 10.7 s after, inside a spread of
8.0–12.6 s across six runs. 1.4 MB less JavaScript is parsed, downloaded and held in memory, and
1,326 ms of attributed script work is genuinely gone from the trace — but the end-to-end time on
that device is dominated by Home Assistant's own frontend (5,696 ms of the 8,828 ms of script on a
cold load, 1,462 ms of it in `app.js` alone) and the run-to-run variance is larger than the saving.
The byte reduction is real and verifiable; a speed-up is not claimed, because it could not be
demonstrated.

---

286 tests. Four written here, each verified by reintroducing the bug it catches — and the
fallback test was vacuous on the first three attempts: an empty keep-set disables resource
trimming entirely, so a build that wrongly dropped everything forwarded everything instead and the
assertion passed on a bug.

## 2026.09.14.22 — 2026-09-14

**A card handed a device now gets that device's sub-devices too.**

Reported against the Bambu print-status card, which rendered nothing on a panel. The card is
configured with the printer's device id and then goes looking for the AMS units and spool — which
Home Assistant models as *separate devices*, linked back to the printer by `via_device_id`. The
card says so itself:

```js
Object.values(hass.devices).filter((d) => d.via_device_id === printerId)
```

Nothing in the dashboard config named those devices, so their entities were never in the allowlist
and their rows were trimmed out of the device registry the card was served. Both halves of what it
needed were missing, and nothing reported it on either side — the resource was kept, no card was
reported unmet, and the card simply drew nothing.

**`via_device_id` on its own is not a safe rule.** Home Assistant uses it for "routes through",
which covers hubs as much as sub-units. Measured on the 1,233-device registry this was found on,
it makes a Z-Wave controller the parent of **75 devices carrying 2,870 entities**, and a
Zigbee2MQTT bridge the parent of 62 more. Following it blindly would hand a wall panel an entire
Z-Wave network — precisely the opposite of what this app is for.

So the rule is `via_device_id` **and** a naming test: the child's name must begin with the
parent's, followed by a separator. That is the convention integrations use when a device is a PART
of another — `H2S_0938AC572400463_AMS_1` — and hubs never match it, because their children are
independent things with their own names. Measured across the same registry: **every hub scored
zero**, 65 parents qualified at all, and the largest addition to any single device was the
printer's own 22 entities. An entity cap backstops naming schemes this was not measured against,
so no device can silently become a network's worth of entities.

Folding happens once, when the registry context is built, so every caller that asks for a device's
entities gets the same answer — a card configured with a device, and a per-device client rule
alike. It is resolved against a snapshot, so one fold can never feed another and a badly-named
level cannot drag a whole subtree upward.

Verified live: `office-tablet` went from 52 to 74 entities, exactly the 20 AMS and 2 spool
entities, with no other dashboard changed.

---

282 tests. Five written here, each verified by reintroducing the bug it catches — the one-level
test needed its fixture reordered before it could fail at all, because the fold walks parents in
first-seen order and only a deepest-first arrangement exposes a cascading implementation.

## 2026.09.14.21 — 2026-09-14

**A module that renders nothing is now found by the config block it reads.**

`resources_always_forward` existed largely to paper over one blind spot. A dashboard carrying
`kiosk_mode:` at its top level is unambiguously asking for `kiosk-mode.js` — but the resource
matcher only ever inspected config **values**, and only ones shaped like `custom:x`. `kiosk_mode`
is a **key**, and its values are booleans. The evidence was in the config the whole time, in a
place nothing looked.

Unknown top-level keys on a dashboard config are now treated as module names and matched against
resource bodies exactly like card types are — literal first, fragments as fallback. Both spellings
are tried, because a module reads its own config key with an underscore (`kiosk_mode`) and names
its files with a hyphen (`kiosk-mode`); measured against the real bundles, both literals are
present in each, but which one a given module writes is not something to assume.

Verified on a live instance by **removing the pin**: with `resources_always_forward` emptied,
`kiosk-mode.js` is still kept for all five dashboards, each of which carries a `kiosk_mode:`
block. `swipe-navigation.js` is kept for the one dashboard with `swipe_nav:` and dropped for a
panel without it — which is correct, not a regression.

**Two guards, because the obvious generalisation is the one that breaks this.** Walking every key
at every depth would match `type`, `entity`, `title` and `cards` — which occur in every config and
as substrings in most bundles — so everything would match everything and the trim would quietly
stop trimming, the same failure the `MIN_KEY` and fragment-frequency rules already exist to
prevent. So: **top level only**, and **only keys Home Assistant does not define itself**.

Module names are also kept out of the card sets entirely, so a config block can never be reported
as a card type or warned about as one that will not render — that class of never-true warning has
already been shipped and withdrawn here once.

Both guards were added because the tests for them did not work first time. "Ignores Home
Assistant's own keys" passed against a build with the skip-list deleted, because no fixture
bundle happened to contain the word `title`; "not counted as a card" passed against a build that
folded modules into cards, because the unmet report only covers card types that some resource
literally defines. Both now use fixtures that make the difference observable.

---

277 tests.

## 2026.09.14.20 — 2026-09-14

**A route is named after the machine that served it, instead of being called "proxy".**

`proxy` was the one label in this panel that could mislead, and it did so in the worst possible
place: **this add-on is itself a proxy**, so a row reading `lan · proxy` invites the reading "came
through the stripper" — which every row did. The label said nothing and implied something false.

The generic fallback is now **"reverse proxy"**, which is true of every connection it describes.
But the hop is a real address and usually has a real name, so the add-on asks: a **reverse DNS
lookup** of the machine that opened the TCP connection. On a Home Assistant install, Supervisor's
own resolver answers PTR for the add-on network — `172.30.33.5` comes back as
`a0d7b954-nginxproxymanager.local.hass.io` — so a reverse proxy running as an add-on names itself
with **no Supervisor API call, no token and no role**. The same lookup names a proxy elsewhere on
the network whenever local DNS knows it. The repository prefix (`a0d7b954-`, `local-`, `core-`)
is stripped, because it is noise to a reader.

The name appears in the Sankey, its legend, and the clients table's **From** column.

**It abstains rather than guess, in two ways.** A name is only used when every machine serving
that route resolves to the *same* one — two reverse proxies have no single name, and a label
true of some traffic and false for the rest is worse than the generic wording. And only `proxy`
is ever named: for `direct` the hop is the **client**, so naming the route after it would put a
wall panel's own hostname in the Route column; for `ingress` it is Supervisor, and "ingress"
already says more than `hassio-supervisor` would; `cloudflare` names itself.

That second rule came out of a test that did not work. The first version of "keeps routes apart"
passed against a deliberately broken build, because the unresolvable hop it used was discarded
anyway. Making it resolve — to a client's hostname — exposed the real defect: naming every route
put `laundry-tablet` where a front door belongs.

---

274 tests.

## 2026.09.14.19 — 2026-09-14

**The stats panel answers "who is connected, from where" properly.**

### "How clients reach this" is a diagram, not three stacked lists

The old table put Origin, Route and Hostname in one column with a Category label. Three
independent distributions, each summing to 100% separately, which is why it read as three
unrelated lists bolted together — and it could not answer the obvious question, *"the traffic
from outside, which front door does it use?"*, because the pairing was thrown away at the point
of counting.

Connections are now counted as a **joint distribution** — one counter per
(origin, route, host) actually seen — and drawn as a Sankey, where the links *are* the pairings.
Bands are coloured by route with a legend, so a front door can be followed across the whole
diagram. **The three marginals are now summed from the joint rather than counted alongside it**,
so the diagram and the table under it cannot disagree; the table remains behind "Show as a table"
with one row per real path.

A **Last 24h** toggle sits next to it. The history file already samples every five minutes and
handles counters that reset; flows ride along in the same buckets, delta'd per key, so the 24h
view survives restarts the same way the charts do.

### Clients: 24 hours, sortable, filterable

"Connected now" could not help with a panel that had *gone* — the row worth looking at is exactly
the one that disappeared. The table now has a **Seen in 24h** range covering clients that have
disconnected, folded to **one row per client** with a session count and a last-seen time, because
a wall panel that reconnects every few minutes is one device, not three hundred rows.

Every column **sorts** (on the underlying value, so 1,024 sorts above 512 and addresses sort
numerically — 10.2.4.9 before 10.2.4.113), and a **filter box** matches on what a row displays.

### The user column was blank on every wall panel

Not a lookup that failed — a lookup that was never made. Identity was resolved only when a
`user_overrides` rule could apply to that dashboard, which is a deliberate optimisation: it was
added to fix a measured **1.6 second** per-page-load regression where every connection was held
while the add-on resolved a user to reach a conclusion that could not change anything. With rules
scoped to `lovelace`, every panel on another dashboard showed "—".

Identity is now resolved for **reporting** too, but **without the gate** — fire-and-forget,
cached per token, nothing waits on it. The test that pinned "no lookup at all" now pins the thing
that actually mattered: the connection must not be *delayed*. It asserts both halves, because
each alone is trivially satisfied — one by deleting the feature, the other by restoring the bug.

### Also

**A mock-HA bug that made the proxy look broken.** The harness pushed raw frames at whichever
socket connected last, which was only ever accidentally right: it assumed one HA socket per
browser. The moment a second socket existed, frames meant for the browser went to it — which
reads exactly like the proxy dropping an allowed entity. It now tracks client sockets and
excludes identity probes.

---

269 tests. Seven written this cycle, each verified by reintroducing the bug it was meant to catch.

## 2026.09.14.17 — 2026-09-14

**Fixes a restart loop introduced by the port move in `2026.09.14.16`.**

The container healthcheck carried its own copy of the stats port as a shell default,
`${STATS_PORT:-8100}`. As an add-on that copy is the **only one that ever runs**: Supervisor
passes configuration in `/data/options.json`, so `STATS_PORT` is never present in the container's
environment and the shell default is always what gets probed. The env branch only ever applied to
standalone `docker-compose` users.

So when the port moved to `9122`, the probe kept asking `8100`. Nothing was listening there.
Docker marked the container unhealthy, the Supervisor watchdog restarted it roughly every 85
seconds, and because the add-on never reached `started`, **Ingress served "The app is starting,
this can take some time…" indefinitely** — while the proxy itself was working perfectly the whole
time, trimming and serving every dashboard on 9123. Nothing in the add-on's own log said
otherwise, because from inside the process nothing was wrong.

The fix removes the duplicate rather than correcting it. The proxy writes the port it actually
bound to `/tmp/stats-port`, and the probe reads that file — the two can no longer disagree about
where the server is. A missing file means the stats server never bound, which is genuinely
unhealthy, so failing there is correct.

**Two guards, because a passing suite had already missed this once.** A unit test pins the probe
to the file the source writes and rejects any bare port literal in it. More to the point, the
container smoke test in CI now waits for Docker to report the container `healthy` — asserting that
`/stats.json` responds was never the same assertion, since `curl` is *told* which port to use
while the probe has to work it out. Nothing in CI had ever read container health.

Also corrected to `9122`: the `docker-compose.yml` example and the port mapping used by the CI
smoke test, which had been publishing a port the image no longer binds.

## 2026.09.14.16 — 2026-09-14

**The stats port is configurable, and moves from 8100 to 9122.**

`8100` is a popular enough port to collide with, and under `host_network` a collision is not
cosmetic: the server cannot bind, so the panel and the JSON API are both unavailable —
**including over Ingress**, because the sidebar panel is reached through that same listener.
Proxying is unaffected either way, which was already the case and is now said explicitly in the
log rather than left implied.

`9122` sits next to the proxy's own `9123`. New `stats_port` option, `STATS_PORT` env.

**Only the default is reachable from the sidebar**, and that is the part worth knowing.
`ingress_port` is add-on metadata Supervisor reads at install time; the running process cannot
see it. Move `stats_port` and the panel is still served, but only directly at
`http://<host>:<port>/` — so the app now says exactly that at startup when the two differ,
instead of leaving a sidebar panel that mysteriously stopped working.

Because those two values live in different files and cannot see each other, a test pins them
together: `ingress_port`, the `INGRESS_PORT` constant compiled into the proxy, and the
`stats_port` default must all agree. Verified by changing one and watching it fail.

An existing guard caught the missing `translations/en.yaml` entry for the new option before it
shipped — the second time this cycle a test has caught an option added in only half the places it
belongs.

## 2026.09.14.15 — 2026-09-14

**Pinning from the panel applies immediately. No restart.**

Clicking **Always send** and then being told to restart the app was the worst part of the feature
shipped in `.14` — a restart drops every panel's connection to deliver one entity.

The allowlist already rebuilds live on a dashboard edit or a registry change, and the rule lists
are read on every rebuild. So a pin now appends to the in-memory list and asks for the same
recompute a dashboard edit triggers. The rebuild path already drops open dashboard connections
when entities are **added**, so panels reconnect and pick the entity up on their own.

Applies to resource pins too, which had the same restart footnote.

**This is deliberately not the config hot-reload that was considered and rejected earlier.** That
would have meant mutable state for all seventeen options and half-applied configurations where
existing connections behave differently from new ones. This is two lists the panel itself writes,
applied through a rebuild path that already exists.

If the control connection is down — Home Assistant restarting — there is nothing to rebuild
through, so the response says `restartRequired` and the panel says so too, rather than claiming
success and silently doing nothing.

## 2026.09.14.14 — 2026-09-14

**Search the whole instance for a missing entity, and send it — from the panel.**

"This card is blank" has always ended the same way: work out which entity it needs, decide the
allowlist is not carrying it, then hand-edit `always_forward` and restart. The panel could not
help, because an entity outside the allowlist appears **nowhere in the stats** — by definition.

New card in the stats panel with a search box over every entity on the instance, showing whether
each is currently being sent, and an **Always send** button next to the ones that are not.

- `GET /entities.json?q=…` — searches entity_id and friendly name, flags what the allowlist
  already carries, and reports what is already pinned so the button is not offered twice.
  Read-only, so it is not behind the Ingress gate.
- `POST /pin-entity` — appends a **literal** entity_id to `always_forward`. Ingress-only, exactly
  like `/pin-resource`: it changes app configuration. A literal rather than a pattern because the
  panel offers it from a search result, so the exact id is already known and a regex is only a way
  to get it wrong. The id is checked against the instance first — pinning a typo would sit in the
  config matching nothing, which looks identical to the feature not working.

`never_forward` still wins over anything pinned this way, and a restart is still needed to apply
it — both stated in the panel rather than left to be discovered.

The search debounces at 200ms; ~9,600 entities are held as id and name alone, which is a rounding
error beside the 10MB entity registry sitting next to them.

## 2026.09.14.13 — 2026-09-14

**The device and area registries were trimmed to the union of every dashboard, not to the
connection.**

The entity registry has always used the per-connection allowlist and reaches **99.3%**. Devices
and areas used `REG_CACHE`, which `rebuildRegCache` builds from the **union** — so a panel showing
48 entities received every device and area reachable by all 418 union entities, and the device
registry managed only **87%** on the same principle. That gap is what prompted the look, and it
turned out to be the answer rather than a limit.

Both now derive their keep-set from the connection's own allowlist, via entity -> device and
entity -> area lookups built alongside it. An entity with no area of its own still inherits its
device's, exactly as before. The union set remains the fallback for the window before the lookups
exist, where passing everything through beats blanking names.

O(|allow|) per call — a few hundred iterations, a handful of times per page load, against a
registry answer measured in hundreds of kilobytes.

**The first test for this was vacuous**, which is worth recording because it is the third today.
It asserted that a device was absent, but chose one that *no* dashboard reached — so the union and
per-connection answers were identical and it passed with the fix removed. The fixtures now use two
dashboards that deliberately reach different devices, and both directions fail when the fix is
reverted.

## 2026.09.14.12 — 2026-09-14

**`trim_themes` — Home Assistant sends every installed theme to every client.**

Measured: **10 themes, 28,138 bytes**, on every page load, to panels that render exactly one.

Kept are the themes your dashboards actually name — the config tree is walked in full, since a
`theme:` can sit on a dashboard, a view or a card — plus whatever HA reports as its default and
dark default. Those two are read **from the reply itself** rather than from configuration, so a
dark default that no dashboard mentions anywhere is still kept.

If the trim would keep nothing the full list is forwarded, same safety valve as the services
trim: an unthemed dashboard is worse than a large one.

Off by default, and visibly lossy if it guesses wrong.

The guard test added in `.8` caught `trim_themes` missing from the stats options block before it
shipped — the first time that check has paid off on a new option rather than a historical one.

## 2026.09.14.11 — 2026-09-14

**Reports the shape of payloads being considered for trimming, before trimming them.**

The next candidates after translations were `frontend/get_themes` (~28KB per call),
`custom_icons/list` (~41KB) and `frontend/get_icons` (~16KB), none of which had been looked at.

Measuring first has changed the design twice — translations would otherwise have shipped a filter
keyed on entity domain, which renders raw keys on the dashboard — so nothing gets trimmed on the
strength of what its API *probably* returns. `stats.shapes` reports one shallow description per
message kind: total bytes, the top-level structure, and the first keys.

Observational, and temporary by nature: once a payload has a real trim, its before/after appears
in `savings` and the shape stops being the interesting thing about it.

## 2026.09.14.10 — 2026-09-14

**Registry change events were filtered by nothing, per connection.**

With translations trimmed, the largest remaining payload turned out to be
`entity_registry_updated` events: **91,873 bytes per frame, 14.3% of all websocket traffic**.

Two things looked like they covered this and neither did. `registryEventMatters` gates only the
**control** connection's decision about whether to rebuild the allowlist. The per-connection
egress filter covered `subscribe_entities` and nothing else. So a panel subscribed to
`entity_registry_updated` received a change event for **every entity on the instance** — 9,617 of
them — including entities it holds no registry row for, because the registry it was served had
already been trimmed to its allowlist. The update had nothing to apply to.

Now dropped whole when the entity is outside the connection's allowlist, under `trim_registries`
(already on by default): if you trim the registry, its change events follow.

Entities newly added are not lost. A new entity changes the allowlist, which triggers a recompute
and reconnects open dashboards.

**The first version of the test was vacuous** and is worth recording. It collected events via a
`c.onMessage?.()` that does not exist on the test client, so optional chaining silently no-opped,
the array stayed empty, and `assert.ok(!seen.includes(...))` passed regardless of what the proxy
did — confirmed by deleting the filter and watching it still pass. It now listens on the raw
socket, and fails when the filter is removed.

## 2026.09.14.9 — 2026-09-14

**Fixes the translations diagnostic pairing an untrimmed key count with a trimmed byte count.**

With `trim_translations` on, `stats.translations` reported `5,359 keys, 108,473 bytes`. Both
numbers were real and they described different payloads: the key count came from the original
`resources` object, the byte count from `msg.result` *after* the trim had replaced it.

Read together they say a quarter-megabyte payload is 108KB — understating the very thing the
diagnostic exists to measure, and doing it in the direction that makes the feature look
unnecessary.

Now sized before trimming, so both halves describe the untrimmed reply.

## 2026.09.14.8 — 2026-09-14

**The stats panel was under-reporting its own configuration, and had been for months.**

The `options` block in `stats.json` is a hand-maintained list, and it had fallen behind **five**
options: `mqtt_sensors` and `mdns_discovery` (missing since they shipped), then `log_level`,
`trim_repairs` and `trim_translations`.

The consequence is worse than a cosmetic gap. An option missing from that block reads as absent —
which is indistinguishable from "Supervisor never passed this", the exact question the block
exists to answer. Chasing whether a newly added option had survived the Supervisor store cache,
the panel said `None` for a setting that was working correctly.

All five are now reported, and a test pins the list to `config.yaml` so it cannot drift again: it
reads every simple toggle or choice out of the schema and fails if the stats block omits one.

That test found `mqtt_sensors` and `mdns_discovery` the moment it was written — two gaps nobody
had noticed, in the same commit that fixed the three that had been.

## 2026.09.14.7 — 2026-09-14

**`trim_translations` — the last big untrimmed payload in the boot path.**

Measured before designing, which changed the design. A real reply from this instance:

    5,359 keys      432,799 bytes      69 integrations
    100% of keys shaped `component.<domain>`     0% anything else

    component.tuya_local   823 keys      component.roborock   417
    component.lg_thinq     686           component.bambu_lab  322
    component.tuya         477           component.matter     289

A panel showing two lights and a printer was being sent state names for every Tuya device, every
LG appliance and every Roborock on the account, on **every page load**.

**The measurement overturned the obvious implementation.** Filtering by entity domain — the
`get_services` pattern — would have been wrong: `component.tuya_local` is an INTEGRATION, while
the entity it provides is `sensor.something`. Trimming on entity domains alone drops exactly the
tree that names that sensor's states, and the dashboard renders raw keys. So a tree is kept when
it matches **either** an entity domain the connection can see **or** the integration providing one
of its entities, which needs a new entity -> platform map built alongside the allowlist.

Anything not shaped `component.<x>.…` passes through untouched. That measured 0% of a real
payload, but a category nobody has seen must never be silently dropped.

**Off by default, and the most lossy option here.** A missing translation does not degrade
quietly like a missing service — it renders its raw key on the dashboard. Turn it on, load every
panel, and look.

Three tests, each verified by breaking it: dropping the integration half fails the first,
dropping the non-component passthrough fails the second.

## 2026.09.14.6 — 2026-09-14

**Reports what is actually inside a translations payload, before trimming it.**

`frontend/get_translations` is the largest untrimmed payload in the boot path — **~247KB per
call, 21.6% of all websocket traffic**. Trimming it by domain looks obvious, since the keys are
`component.<domain>.…` exactly like `get_services`. But the failure mode is worse than anything
else trimmed here: a missing translation renders its **raw key on the dashboard**, so
`component.light.entity_component._.state.on` appears where "On" should be.

That is not a thing to design from convention. `stats.json` now reports the most recent reply
broken down by key prefix, so the decision can be made from the actual payload: how much of it is
`component.<domain>` and therefore filterable, and how much is `ui.*` / `state.*` that every
dashboard needs whatever it shows.

Key counts rather than byte-accurate subtree sizes — weighing each subtree would mean serialising
a quarter-megabyte payload piece by piece, and counts answer the question being asked.

## 2026.09.14.5 — 2026-09-14

**`trim_repairs` — empties the admin Repairs backlog for trimmed connections.**

`repairs/list_issues` is the Repairs panel's list of outstanding issues. A kiosk never renders it,
and it costs about **27KB on every page load** — measured at 26,894 bytes per call on a live
instance.

**Off by default**, like the other lossy trims. It is genuinely lossy in one direction: an admin
browsing a trimmed dashboard stops seeing repair notifications there. That is a real thing to
lose, and not a decision to make on someone's behalf.

The list is **emptied, not withheld**. The frontend asks for this and waits for the answer, so
dropping the reply would leave that request pending forever; an empty issue list is a valid
answer meaning "nothing to report".

## 2026.09.14.4 — 2026-09-14

**The savings table was billing small payloads for frames they merely shared.**

`registry:area` reported **2,762 KB** trimmed to 552 KB. The instance has **30 areas**. At a few
hundred bytes a row the real registry is about **9 KB** — the figure was overstated roughly
**300x**, and the 80% "saving" next to the entity registry's 99.3% looked like a tuning
opportunity when it was an accounting error.

`done()` knows only the size of the whole websocket frame, and Home Assistant batches: a 9 KB area
registry arriving in the same frame as the 10 MB entity registry was charged for all of it,
under whichever category the last trimmed message in that frame happened to set.

This is the same family as the batched double-count fixed in `.14` — that one corrected
`recordTraffic` and left `recordTrim` sitting on the frame total.

Each trimmed payload is now measured on its own, before and after, and `done()` records those
instead of the frame's bytes. The frame total is still used when a message arrives alone, where
it is correct.

Serialising per message is affordable **here and nowhere else**: registries, services, resources
and `get_states` are a handful per page load. The same pattern was deliberately removed from the
event path in `.35`, where it ran thousands of times a second.

No synthetic test: reproducing it needs two pending request ids answered in one batched frame,
which the mock cannot currently construct. Verified on the live instance instead, which is where
the wrong number was found.

## 2026.09.14.3 — 2026-09-14

**`log_level` — the service log finally has a volume control, and a way to ask for more.**

There was none. `logThrottled` collapses *repeats of one key*, which does nothing about a hundred
distinct clients each logging once — and measured on a live instance this turns over **~22
websocket connections a minute**, each writing a line. That is tens of thousands of lines a day,
every one of them invaluable while diagnosing something and noise the rest of the time.

    warn    problems, plus the startup lines without which a log cannot be read at all
    info    normal operation — the DEFAULT, and exactly what was always written
    debug   per-connection and per-decision detail

**`info` is the default deliberately, so upgrading changes nothing about what you see.** The
point of this was never quieter defaults; it was having a way to *ask for more*. Diagnosing the
navbar-card bug meant hand-diffing the proxy's `lovelace/resources` reply against Home
Assistant's stored collection, because there was no level of detail available beyond what it
already printed.

Moved to `debug`: the per-connection attribution line, `subscribe_events`, websocket-upgrade
passthrough, and registry/services cache hits — the volume drivers. Moved to `warn`: the version
banner, the listening line, the allowlist summary, and the "card will not render" warning.

The version banner is deliberately **warn**, not info, even though it is not a problem: a log
that cannot tell you which build produced it is not worth keeping at any level.

Three tests that asserted per-connection lines now spawn with `LOG_LEVEL=debug`, which is correct
rather than a workaround — a test that checks diagnostic output should have to ask for
diagnostics. Four more pin that the levels actually filter, that `warn` never swallows the
version, and that an unrecognised value falls back to `info` rather than silencing the log.

Also fixes a stale option description that still said the default port was 8099; it has been 9123
since `.17`.

## 2026.09.14.2 — 2026-09-14

**Test suite: fixes the flake at its root rather than by raising timeouts again.**

Measured before touching anything: **one failure in six full runs**, always the same test —
`rebuilds the allowlist when a dashboard is edited`. It had already been "fixed" once today by
raising its wait from 6s to 15s, which did not work, because duration was never the problem.

The captured proxy output showed it: `lovelace_updated` **never arrived**. No recompute was
attempted, nothing was logged. The proxy writes two lines at startup, in this order:

```
union allowlist for [test-dash]: 6 entities        <- what the tests waited for
watching lovelace_updated, ... for live allowlist updates   <- what they needed
```

The suite treated "the allowlist is built" as readiness. But the control connection subscribes
**after** that, so a test could fire a mock event into a proxy that had not yet subscribed — the
event went nowhere, and the timeout that followed looked like slowness. No timeout value could
ever have fixed it.

Readiness now means *subscribed*: all **40** waits across the three integration test files use
`/for live allowlist updates/`. That line is written after the allowlist exists, so it is
strictly stronger than the old wait and safe everywhere, not only in the nine places that fire
events.

Verified by running the suite **8 more times: 240/240 every time.**

## 2026.09.14.1 — 2026-09-14

**A card that will not render is now reported — proven, not guessed.** This is the third attempt
at the warning `.37` shipped broken and `.38` withdrew, and the difference is that this one knows
what it cannot know.

Two dead ends were measured before landing on the answer, both worth recording so nobody spends
the afternoon again:

**Static analysis of `customElements.define()` does not work.** Every bundle is minified and
registers as `customElements.define(t, ...)` with the element name in a variable. Checked against
real installs: navbar-card, button-card and ha-bambulab-cards all do exactly that. Nothing useful
can be extracted.

**Reusing the keep-matcher cannot work** — that was `.37`'s bug. It asked "does a kept resource
provide this card?" with the same lenient matcher that decided to keep it, so the answer was
always yes.

What does work is the literal name, because a file that registers an element almost always
contains that element's name as a string even when it passes it through a variable. Measured:

    navbar-card                    appears 38x in navbar-card.js
    bubble-card                    appears 20x in bubble-card.js
    button-card                    appears  2x in button-card.js
    mushroom-cover-card            appears  0x in mushroom.js
    ha-bambulab-print_status-card  appears  0x in ha-bambulab-cards.js

The last two build their element names at runtime from a prefix, so no evidence exists — and
that is the point. A card is reported **only** when a resource literally names it and every such
resource was dropped. That is a proven broken card. A card nothing literally names is not
reported, because nothing here can tell whether it works, and a warning that cries wolf is worse
than no warning.

Fragments are deliberately not consulted. They are right for deciding what to KEEP, where
over-including is free, and wrong for deciding what to WARN about, where over-warning is the
whole failure.

The silence is declared rather than implied: `resources.unmetCoverage` reports how many card
types could be checked at all, and the log names the ones that could not. Roughly half the cards
on the instance this was built against are verifiable — so half now have a real safety net, and
the other half get honest silence instead of a false clean bill of health.

Both directions are tested, and both were verified by breaking them: making every file claim
every card fails the positive test, and reporting the unverifiable cards fails the silence test.

## 2026.09.13.38 — 2026-09-13

**Removes the "card needed but no resource provides it" warning added in `.37`. It could never
fire.**

The idea was sound and the need is real — that warning would have made the navbar-card episode a
ten-second diagnosis instead of a hand diff of the proxy's reply against Home Assistant's stored
collection. The implementation was not sound.

It asked "does any KEPT resource provide this card type?" using `cardMatchesBody` — **the same
lenient matcher that decided to keep the resource in the first place**. If that matcher says a
resource provides the card, the resource is kept; and because it was kept, the warning then
concludes the card is provided. It can only ever answer "all good". Measured with a dashboard
referencing `custom:totally-absent-card` against an instance that has no such card: two unrelated
resources were kept and **no warning fired**.

It cannot be fixed by tightening the match either. Fragment matching exists precisely because
real bundles never contain the literal element name — Mushroom builds
`` `${prefix}-${type}-card` `` at runtime, so the string `mushroom-cover-card` appears nowhere in
the file. A stricter test would start warning about cards that work perfectly well, and a warning
that cries wolf is worse than no warning at all.

So it is gone rather than shipped as decoration. The raw material for the same judgement is
already in the stats API and has been all along: `resources.byDashboard` (kept vs dropped per
dashboard) and `resources.droppedByDashboard` (exactly which URLs were dropped). What is missing
is a reliable automatic link between a card type and the file that defines it, and that is a
harder problem than a log line.

Everything else from `.37` — path-based resource identity, and watching the resource collection
— is unaffected and stays.

## 2026.09.13.37 — 2026-09-13

**A custom card disappeared whenever HACS updated it. Reported by the lovelace-navbar-card
author, and it was never specific to that card.**

`trim_resources` decided which Lovelace resources a dashboard needs and kept them **by full
URL**. HACS appends a cache-busting `?hacstag=<id><version>` and bumps it on *every* update, so
the moment a card was updated the URL the frontend asked for no longer matched the one the
allowlist had decided to keep — and the resource was silently dropped. Same path, same file,
same resource id; one digit of a query string.

The failure is completely silent. No console error, no network request, nothing in the Home
Assistant log: the custom element simply never registers and the dashboard renders
`hui-error-card` with empty text. Diagnosing one instance meant reading the proxy's own
`lovelace/resources` reply and diffing it against HA's stored collection.

Every installed module was queued up behind this, not just the one that happened to update.

Three fixes:

**A resource's identity is its path.** The query string is a cache-buster, not part of what the
resource *is*, so the keep-set and the serve-time filter both key on the path now. The query is
passed through to the browser **verbatim** — it is the cache-buster, and serving a stale one
would defeat the update. The body cache stays keyed by full URL, correctly: a new version tag
means genuinely different bytes to fetch and re-scan.

The same function was already calling `url.split('?')[0]` — but only to render the dropped-list
log for humans. It knew the query was not identity when showing a resource, and forgot when
matching one.

**The proxy now watches the resource collection.** This needed checking rather than assuming:
Lovelace resources are **not on the event bus**. `hass.bus.async_fire` is never called for
storage collections, so there is no `subscribe_events` topic — which is why `allowlist_rebuilds`
sat at `0` through the whole episode. They notify over a per-collection websocket subscription
instead (`DictStorageCollectionWebsocket._ws_subscribe`), so the control connection subscribes to
`lovelace/resources/subscribe` and rebuilds on a change. Best-effort: it is not part of the
documented websocket API, so a failure logs one line and everything else carries on.

**The silent failure is now loud.** When a dashboard needs a card type that no surviving resource
provides, that is logged at build time with the card named and what to do about it — both halves
are in hand there, so it costs nothing:

```
!! resources basement-stairs-panel: 1 card type(s) NEEDED but no kept resource provides them:
   navbar-card — these will render as an error card with no message.
```

The regression test bumps a resource's query string **without** telling the proxy, which is the
real sequence, and was verified to fail when the path-based identity is reverted.

## 2026.09.13.36 — 2026-09-13

**A stalled Home Assistant is now a 502 instead of a hang.**

Nothing bounded how long the proxy waited on HA. Node's defaults do not: `server.timeout` is
`0`, and `requestTimeout` only covers *receiving* a request, not waiting for the upstream answer.
So an HA that stalled rather than died — a long GC pause, a wedged integration — left the request
open and the socket held, and the error handler never fired, because nothing errored. It just
went quiet.

`proxyTimeout` is now set to **120s**, which httpxy already supported and the previous library's
option was never wired up. Two properties make that safe rather than a new way to break camera
streams, both checked in the library source before shipping:

- it is an **inactivity** timer (`proxyReq.setTimeout` sets the socket idle timeout), so a
  long-lived HTTP stream — MJPEG, HLS — keeps resetting it as frames flow and only trips when the
  upstream genuinely goes silent;
- it applies to `proxy.web()` **only**. httpxy wires it in `webIncomingMiddleware`; the websocket
  path has no timeout handling at all, so camera-signalling and Assist-pipeline upgrades are
  untouched.

On fire httpxy calls `proxyReq.destroy()`, which arrives at the existing `error` handler as an
ordinary proxy error and answers 502 — a bounded failure the browser retries, instead of a socket
that never comes back.

`PROXY_TIMEOUT_MS` overrides it, env-only and deliberately not a `config.yaml` option: adding a
schema key forces users through a Supervisor store refresh before it is even accepted, which is
real friction for a value almost nobody should change. `0` disables it.

The mock gained a `hangHttp` mode — it accepts the request and then never responds and never
closes, so the proxy sees no error at all, which is what makes it a hang rather than a failure.
Without `proxyTimeout` the new test does not fail, it **hangs**, which is precisely the bug.

## 2026.09.13.35 — 2026-09-13

**The proxy no longer re-serialises every entity event just to measure it.**

The event branch ended with:

```js
stats.recordEvent(Buffer.byteLength(JSON.stringify(msg)));
```

`transform()` runs **per message**, and Home Assistant batches — so a single frame carrying
forty entity diffs paid for **forty extra full `JSON.stringify` calls** over the largest objects
on the hottest path in the proxy, on top of the one `done()` already performs to send them. It
also measured a *reconstruction* of the message rather than the bytes that actually went out.

`done()` already computes the real outgoing size. The only thing it could not know was how many
events a frame held, so that is now all the event branch tracks: it counts, `done()` weighs.
`recordEvent(bytes, count = 1)` keeps "events seen" advancing per event while the bytes are
attributed once, from the frame. Exactly the reasoning behind the earlier batched-frame trim
accounting fix.

**And the instrument is now tested end to end.** Deleting the `recordEvent` call outright broke
**no test** before this release — the counters were only ever exercised as a unit, never through
the proxy. That is precisely the failure mode this project has already been bitten by, twice, in
its own instruments. A new integration test pushes a real batched frame through a spawned proxy
and reads the numbers back off the stats endpoint; it fails when the call is removed.

## 2026.09.13.34 — 2026-09-13

**`stats.json` now reports the OS too**, completing what `.33` started:

```json
{ "version": "2026.09.13.34", "node": "v26.8.2", "os": "Alpine 3.24.1", ... }
```

`node:26-alpine` is a **floating tag**, so both of those move without anything in this repo
changing — and they already have: the image shipped Node 26.8.2 while development happened on
26.8.1. Neither was observable from outside the container on a Home Assistant OS host, where
there is no Supervisor token over SSH and the docker socket is denied.

Establishing the Alpine version without this took reading the image config out of the registry,
after two more obvious approaches gave wrong answers: `node:26-alpine` is **not** an alias of
`26-alpine3.23` (it is its own index with a distinct digest), and its base layer matches **no**
stock `alpine:X.Y` image, because Node builds from the minirootfs tarball rather than
`FROM alpine`. That is a lot of work to answer "what is this running on", and it is now a field.

Read from `/etc/alpine-release`, falling back to `PRETTY_NAME` in `/etc/os-release` so a
Debian-based or plain-container user gets something useful, and `null` rather than a guess when
neither exists — a dev checkout on macOS, where there is no container at all. Resolved once at
boot, and like `node` it cannot be overridden by the caller: a value passed in is a value that
can be wrong.

## 2026.09.13.33 — 2026-09-13

**`stats.json` now reports the Node version the process is actually running on**, and the panel
shows it beside the app version.

Small, and it closes a real gap. The image is built `FROM` a base named in the Dockerfile, but on
a Home Assistant OS host there is no way to check what the running container actually holds — the
Supervisor token is not available over SSH and the docker socket is denied. So after the base
image moved 20 -> 24 -> 26 in a single day, "did that rebuild take?" was answerable only by
trusting that it had.

```json
{ "version": "2026.09.13.33", "node": "v26.8.1", ... }
```

Read from `process.version` rather than accepted as a parameter, so it cannot drift from reality
the way a hand-maintained constant would — and the tests pin that *source*, not merely the
presence of a string, because a later tidy-up that turned it into a passed-in value would
reintroduce exactly the drift it exists to prevent.

## 2026.09.13.32 — 2026-09-13

**The response cache is keyed by the connection's allowlist, not by its dashboard — which took
the live hit rate from 9.1% back to where it belongs.**

`.30` made widened connections skip the shared cache entirely. That was correct and nearly
useless. The reasoning behind it — "widened connections are the minority, a few pinned panels" —
was an assumption, and measuring it on a live instance proved it false:

    .29 (no correctness guard)   331 hits / 7 misses    97.9%
    .30 (widened skip the cache)   4 hits / 40 misses    9.1%

Most connections there ARE widened. Voice-satellite panels self-identify, so two panels on one
dashboard held 151 and 172 entities; the admin user matched a `user_overrides` rule. Nearly
everything was taking the bypass, so Home Assistant was re-serialising a ~10MB entity registry
per connection again.

The fix puts identity in the key rather than refusing to cache: `(kind, dashboard, allowlist
version, allowlist signature)`. Connections holding an identical allowlist share an entry —
including the same panel across its reconnects, which is where the hits actually come from — and
connections with different sets cannot collide by construction, because the signature is prefixed
with the set's size and hashed over its sorted ids. Taken once per connection, memoised, and
recomputed only if `user_overrides` widens the set mid-handshake.

**The test that should have caught the original bug did not exist.** Removing the signature from
the key passed all 229 tests, because every test client presents as `127.0.0.1` — so within one
proxy either every connection is pinned or none is, and the collision case never arose. The new
test uses two USERS instead: David matches a rule and gets `light.kitchen`, Michelle opens the
identical dashboard and must not inherit it. Verified by deliberately dropping the signature and
watching it fail. Its first draft would have passed vacuously (it probed an entity absent from
the registry fixture), which its own guard assertion caught.

## 2026.09.13.31 — 2026-09-13

**The image moves to Node 26, deliberately ahead of its LTS date.**

    v24   LTS 2025-10-28   maintenance 2026-10-20   EOL 2028-04-30
    v26   LTS 2026-10-28   maintenance 2027-10-20   EOL 2029-04-30

As of this release Node 26 is still on the **Current** line — where breaking changes land — and
becomes Active LTS on 2026-10-28, almost exactly when 24 drops into maintenance. Taking it now
buys the longer support window about six weeks early; the cost is those six weeks on Current.

Two things make that a cheap bet rather than a gamble. Nothing in this image compiles — every
dependency is pure JavaScript with no native bindings, so there is no ABI to rebuild and nothing
to break on a runtime change. And the test suite now runs on **22, 24 and 26**, so a regression
specific to the new line is caught in CI rather than on a wall panel. 24 stays in that matrix
precisely so the fallback is known to work.

`node:26-alpine` publishes `amd64` and `arm64/v8` — both architectures this project builds —
which was checked against the registry manifest rather than assumed. That check exists because
the Node 24 bump silently dropped `armv7`: `node:20-alpine` published it and `node:24-alpine`
does not, which would have made the Supervisor build fail outright on 32-bit ARM.

## 2026.09.13.30 — 2026-09-13

**`get_services` is now served from the same cache the registries use — and that cache stopped
being wrong for widened connections.**

`get_services` is every service of every integration, and the frontend asks for it on every page
load. Like the registries beside it, the answer is identical for every client on a given
allowlist — but it was the last of the big instance-wide payloads still being rebuilt by Home
Assistant and re-parsed here once per connection, while the registries were being answered from
memory. A kiosk load opens several websockets, and a handful of panels multiplied that into real
CPU on the HA host for no new information.

Fixing that first required fixing the cache it joins.

**The shared response cache was unsound for any connection wider than its dashboard.** It is
keyed by `(kind, dashboard, allowlist version)` — which is exactly what makes it shareable, and
exactly what makes it wrong when a single connection carries more than its dashboard does. Three
things do that: a `client_overrides` pin, entities a voice satellite self-identified, and
`user_overrides` applied once the user is known.

Both directions were broken:

- a widened connection could **read** an entry built from the narrow set, missing precisely the
  rows its extra entities needed — under-inclusion, which is the direction that actually breaks
  cards, leaving names and areas unresolved
- a widened connection could **write** its entry back, handing every ordinary connection on that
  dashboard another client's rows

Widened connections now skip the cache in both directions. They are the minority — a few pinned
panels — so the win is kept intact for the common case and correctness costs nothing. The
`user_overrides` flag is set before the gate that releases held requests, so it is always in
place before the first registry or `get_services` message is examined.

Two tests cover it: an ordinary second connection is served from cache without HA being asked
again, and a client-pinned connection goes to HA every time. Both were checked against
deliberately reintroduced regressions rather than merely passing.

**`url` in `config.yaml` now points at this fork.** It is what the Apps UI links to from the
app's page, so it has to point at the code actually installed — the version, changelog and docs
shown there should describe what is running. Upstream is credited in the README, which is the
right place for attribution and the wrong place for a "what am I running?" link.

## 2026.09.13.29 — 2026-09-13

**Replaced `http-proxy` with `httpxy`, and moved to Node 24.**

`http-proxy@1.18.1` was last modified in December 2024. `httpxy` is the unjs fork of
node-http-proxy and is what `http-proxy-middleware` v4 moved onto, so it has real downstream
exercise. Node 20 reached **end of life on 2026-03-24** — no security patches — and httpxy
requires Node >= 22, so these are one change rather than two.

Alpine stays. Both the official Home Assistant bases and the community hassio-addons bases are
Alpine, Node-RED runs Alpine with Node 24, and nothing here compiles — every dependency is pure
JavaScript with no native bindings. The base is now behind `ARG BUILD_FROM`, the add-on
convention, with `node:24-alpine` as the default so the plain container still builds unchanged.

### Three API differences, all of which mattered

- Named export `createProxyServer`, not a default export.
- **`ws()` is `(req, socket, options, head)`** where node-http-proxy was `(req, socket, head)`.
  Passing `head` third spreads a Buffer into the request options and breaks the upgrade —
  silently, because the socket simply never completes.
- `web()` and `ws()` return promises. The `error` listener already handles failures, but an
  unhandled rejection is still a process-level crash, so both call sites swallow.

### And one behavioural difference, in the most sensitive place

```
node-http-proxy   APPENDS our hop to x-forwarded-{for,port,proto}
httpxy            sets each only when ABSENT
```

The existing test asserted *"appends our hop"* — which was asserting the mechanism rather than the
requirement, and it failed. The real issue-#9 invariant is that the **For and Proto chains agree
in length**: the original bug was not a missing hop, it was `X-Forwarded-For` flattened to one
entry while `X-Forwarded-Proto` still carried two, which Home Assistant rejects with `Incorrect
number of elements in X-Forward-Proto`.

Appending to both satisfies that. Appending to neither also satisfies it, and is arguably safer
here — it leaves the add-on transparent to whatever the edge proxy set, so HA sees exactly Nginx
Proxy Manager's chain rather than a hop it may not have in `trusted_proxies`.

So the test now asserts the invariant rather than the mechanism, and keeps its meaning across a
library change — which is precisely what it had to do.

**Verified live** on a 9,610-entity instance: five websocket clients connected, real client
addresses preserved (`10.2.4.x`, not the Docker gateway), attribution by cookie and User-Agent
intact, 91.8% trim ratio, and a frontend asset served in 20ms.


## 2026.09.13.28 — 2026-09-13

**New sensor: registry cache hit rate.**

The cache-hits counter only ever rises, which makes it useless on its own — a big number could be
a healthy cache or simply a long uptime. A *rate* needs a denominator, so registry cache misses
are now counted too.

The ratio is the interesting number because of what makes it fall: an allowlist recompute retires
the cached registry answers, so a sagging hit rate is the long-term signature of **churn** — the
same condition that produced 24 no-op rebuilds in 14 minutes before that was fixed. A counter
cannot show that; a rate can.

Reported as `null` rather than `0` until something has actually been asked for. A 0% hit rate on
zero requests is a fiction, and publishing it would put a false trough in the statistics on every
restart — the same class of bug as the retained zero the MQTT publisher shipped with earlier
today.


## 2026.09.13.27 — 2026-09-13

**A voice satellite announcing itself is now logged even when it changes nothing.**

`.18` taught the add-on to learn a panel's identity from the panel's own traffic. But the log line
only fired when the announcement *added* entities — so on an instance where a `client_overrides`
rule already supplies them, the mechanism was completely invisible. There was no way to tell
"working, nothing to do" apart from "not working".

It now logs the announcement itself, throttled because a satellite re-announces every 30 seconds:

```
10.2.4.109 announces assist_satellite.basement_stairs_panel
```

That matters for deciding whether a manual rule is still needed. A satellite only announces while
it is **running** — so a panel whose satellite is `unavailable` says nothing, and its
`client_overrides` entry is what keeps its entities flowing until it comes back. The two
mechanisms are complementary rather than redundant, and this makes which one is carrying the load
visible.

## 2026.09.13.26 — 2026-09-13

**New: HTTP access and error logs, kept apart from the service log.**

The add-on stdout is a *service* log — what it decided, what it trimmed, why an allowlist moved.
That is the right stream for those and the wrong one for a request log: a busy panel makes
hundreds of requests a minute, and mixing them in buries the one line that explains why a
dashboard is behaving oddly.

Requests now go to their own ring buffers, readable at `access.json` and shown in the panel.
**No files** — an add-on writes to a container filesystem a rebuild discards, and rotation, size
caps and disk-full handling are a lot of moving parts for a log most people read twice.

**Two rings, deliberately.** A single combined log cannot serve both readers: size it to keep an
error from this morning and it holds twenty minutes of traffic; size it for traffic and the error
is gone before anyone looks.

- **access** — everything, so *what happened just now* is answerable
- **errors** — 4xx and 5xx only, so a failure at 09:14 is still there at 17:00

Counts are rolled up separately from the rings, because a total derived from a ring silently falls
as rows age out — which would make the numbers lie the longer the add-on ran. The slowest requests
are kept for the whole uptime for the same reason: a p99 from an hour ago is exactly what a
rolling window loses and a person wants.

The panel polling its own JSON is excluded from the access ring — otherwise reading the ring fills
the ring — but still counts toward the total, and a **failure** on one of those paths is always
kept, since a 500 on `stats.json` is the most interesting thing that could happen to it.


## 2026.09.13.25 — 2026-09-13

**The stats panel now helps you tune `trim_resources`, instead of only reporting on it.**

The documented way to tune this option has been "turn it on, load each kiosk, read the add-on log,
and see what looks wrong". That works, but it means SSH and a scroll — and the one failure the
loop cannot catch is exactly the one the log was trying to warn about.

The panel now shows the **dropped by ALL dashboards** list directly: every resource installed in
Home Assistant that no served dashboard references, with its size, largest first. Each row has an
**Always send** button that appends to `resources_always_forward`.

The text beside it states the judgement the add-on cannot make. A resource nothing references is
either **genuinely unused** — in which case the honest fix is to uninstall it rather than have a
proxy hide it on every page load — or a **resident module** that registers no card and is named by
no config but runs on load, where dropping it is invisible: the dashboard renders normally and
only the behaviour stops.

**The button pins a fragment, not a URL.** `resources_always_forward` matches substrings, and a
HACS URL carries a version tag that changes on every update — pinning the whole URL would stop
matching the next time the plugin updated. The panel derives the distinctive directory instead.

### Writes are Ingress-only, and that is a security boundary

The stats server binds every interface, which is how `http://<host>:8100/stats.json` works from a
laptop. It has always been **read-only**, so an unauthenticated reader could learn only what the
panel already shows. A configuration-write endpoint on that same server would let anyone on the
LAN change this add-on's settings.

So a write is accepted only when the request carries `X-Ingress-Path` **and** arrives from
Supervisor's address — meaning Home Assistant authenticated the user before proxying it. A refused
attempt is logged rather than silently dropped. Reads are unchanged.

Configuration is read-modify-written through Supervisor, never blind-set: the options object holds
every setting the user has, and writing one field alone would discard the rest.


## 2026.09.13.21 — 2026-09-13

**New: fifteen long-term metrics, published as real Home Assistant sensors.**

The stats panel answers *what is happening right now*. This answers *what has been happening for
six months*, which is a different question and needs a different mechanism — Home Assistant long-
term statistics, which only apply to real registered entities.

Hence MQTT discovery rather than `POST /api/states`. States pushed over the REST API are not
registered entities: they vanish on restart, never get a `unique_id`, and the recorder will not
summarise them. Discovery entities are real, survive restarts, and can be renamed and assigned to
an area like anything else.

Broker credentials come from **Supervisor automatically** when the Mosquitto add-on is installed.
Nothing to paste, nothing to keep in sync.

The set is deliberately small — fifteen metrics that reward a trend line beat fifty nobody opens.
Each was chosen because a *change* in it means something:

- a jump in **entities forwarded** means a dashboard picked up a broad `auto-entities` filter
- **allowlist rebuilds** climbing steadily is the rebuild storm this add-on has already had once,
  and it is invisible in any single snapshot
- **trim ratio** falling means the instance grew faster than the dashboards did
- **certificate days left** is the one here that will page you at 3am if nobody watches it

Counters are `total_increasing` so a restart cannot corrupt the long-term sum; gauges are
`measurement`. Every sensor declares a `state_class`, because one without it is stored and never
summarised — which would waste the point of publishing it.

**Certificate expiry is measured by connecting, not by reading a file.** Whatever issues and
renews it, the question worth answering is what a browser is handed today: a renewal that
succeeded into the wrong directory looks perfect on disk and still takes the dashboards down. Set
`cert_monitor_host` to the hostname to watch; leave it empty to skip.

**Three things were wrong on the first deploy and are worth recording**, because each would have
produced bad data rather than no data:

- The first publish fired synchronously inside `start()`, before the socket had connected, so it
  was silently skipped and every sensor sat at `unknown` for a minute. It now publishes from the
  `connect` handler.
- The state was not retained, so a value published before Home Assistant had processed discovery
  was simply lost. Retained means HA gets the last known value the instant it subscribes.
- Publishing on connect then exposed the real problem: at that moment the allowlist does not exist
  yet, so every metric is zero — and a *retained zero* is both what HA displays and a genuine data
  point in long-term statistics. Every add-on restart would have put a spurious dip in every
  graph. Publishing is now gated on `allowlist.ready`, which costs at most one interval.

Best-effort throughout. No broker, bad credentials, or a broker that goes away must never affect
proxying — publishing runs on a timer beside the request path, availability uses an MQTT LWT so
the entities go *unavailable* rather than freezing on a stale value, and every failure is
swallowed after one log line.


## 2026.09.13.19 — 2026-09-13

**New: the add-on asks the network what each client actually is.**

`route.mjs` already classifies *how* a connection arrived — LAN or internet, and through which
front door. This answers the other half: *what* the device at that address is. Most panels
already say so over multicast DNS, unprompted:

| Service | What it is |
| --- | --- |
| `_kiosk-satellite._tcp` | A Kiosk Satellite panel — TXT carries its name and version |
| `_esphomelib._tcp` | An ESPHome device |
| `_ha-paneld._tcp` | A ha-paneld panel |
| `_googlecast._tcp` | A Cast display |

A stats row reading `10.2.4.129` is worse than one reading **`Office Test Panel · Kiosk Satellite
2026.9.46`**, and the difference costs a few multicast packets a minute.

It also resolves a **`.local` hostname in a `client_overrides` rule**, which the container's own
resolver cannot do — Alpine has no mDNS. So a per-device rule can be written against a name that
survives a DHCP lease moving, rather than an address that does not.

**What it deliberately does not do is decide what a client is served.** An mDNS instance name is a
label a device chose for itself; matching it against Home Assistant device names would be fuzzy
string matching, and a wrong match silently serves the wrong entities. Identity for that purpose
still comes from the client naming its own `entity_id`, or from an explicit rule.

Best-effort throughout. Multicast may be filtered, the socket may fail to bind, the network may
not carry it — each degrades to "we learned nothing", never to a failure to serve. Discovery runs
beside the request path and is never awaited by it. Disable with `mdns_discovery: false`; add
service types with `mdns_services`.

A full `_services._dns-sd._udp` sweep is deliberately not done: it would return printers and
speakers too, for more traffic and no benefit.


## 2026.09.13.18 — 2026-09-13

**A client that names itself now gets its own device's entities, with no configuration.**

A browser-based voice satellite announces which satellite it is, on the very websocket this
add-on already proxies:

```json
{ "type": "voice_satellite/subscribe_events",
  "entity_id": "assist_satellite.office_panel" }
```

That is a better identity signal than anything the add-on could infer, and it beats every
alternative that was considered:

- **mDNS cannot work.** Kiosk Satellite is browser-side JavaScript, and a web page has no API to
  advertise an mDNS name. Android does not advertise a hostname by default either, so there is
  nothing to resolve. And even if there were, mDNS gives hostname-to-address — not identity.
- **An IP works but must be kept true.** It needs a DHCP reservation, and if the lease ever moves
  the rule stops matching silently: the panel loses its satellite entities with no error anywhere.

Self-identification has neither problem. Nothing to advertise, nothing to reserve, nothing to
write down — and if a panel's address changes, the new address simply learns on its first
connection.

The entity is expanded to its whole **device**, because a satellite card resolves its siblings
itself (mute, screensaver, the pipeline and wake-word selects), and `exclude_device_categories`
still applies.

**Mechanics.** The announcement arrives after `subscribe_entities`, so the connection that made it
cannot benefit — the add-on learns, logs, and drops that socket so the frontend reconnects with
the wider list. Once per connection, so a satellite that re-announces cannot cause a reconnect
loop. The learned set is cached per client address.

**The trigger is deliberately narrow:** only an `assist_satellite.*` entity_id on a
`voice_satellite/*` command. Anything broader would let a client widen its own allowlist by naming
an entity.

**`client_overrides` is unchanged and still the right tool** for anything that announces nothing —
a device with no self-identifying traffic, or a rule that is about the client rather than about a
device it hosts.


## 2026.09.13.17 — 2026-09-13

**Connections that no per-user rule could match no longer wait for a user lookup.**

Resolving the connecting user costs a round trip to Home Assistant, and the connection is **held**
for its duration — every message after `auth` queues behind it. That is worth paying when a rule
might widen the allowlist, and pure loss when none can.

A per-user rule scoped to a dashboard cannot apply to a connection serving a different one.
Measured on a live instance, *every* per-user rule was scoped to `lovelace` — so every wall-panel
connection paid the lookup to reach a foregone conclusion.

The gate now fires only when some rule could actually match this connection's dashboard. In a
test where the lookup is artificially slowed to 400 ms, an unmatchable connection went from
**408 ms to 17 ms**.

**The real-world effect is larger than that suggests.** Measured end-to-end in a browser on an
unthrottled LAN — full page load, timed to the first rendered card, median of five runs — the same
dashboard went from **2,043 ms to 429 ms**, a 4.8× improvement. It also flipped the verdict on
that link: the add-on had measured 2.2× *slower* than going straight to Home Assistant, and now
measures 1.5× faster. A per-user rule scoped to a dashboard the client never opens was costing
roughly a second and a half on every connection.

An **unattributed** connection still gates, deliberately. Without knowing which dashboard it is
showing we cannot rule anything out, and the asymmetry runs the usual way: a needless gate costs
milliseconds, a skipped one serves the wrong allowlist.

There is no way to pre-resolve this ahead of time, which is the obvious alternative. The lookup
maps *this browser's access token* to a user; the token is issued per browser session, and Home
Assistant's access tokens carry the refresh-token id rather than the user, so only HA can resolve
it. Skipping the lookup when it cannot matter is the win that is actually available.


## 2026.09.13.16 — 2026-09-13

**The websocket passthrough log now names the client.**

Non-`/api/websocket` upgrades are proxied straight through and logged, but the line carried only
the URL:

```
ws upgrade passthrough -> HA: /api/hassio_ingress/LyiEpUdy.../ws
```

Which is useless the moment it repeats. A live instance showed that exact line every ~31 seconds,
248 times — an add-on's Ingress panel reconnecting on a timer — and there was no way to tell which
device was doing it. The line now carries the client, its origin and its route, the same way the
`/api/websocket` line already did:

```
ws upgrade passthrough -> HA: /api/hassio_ingress/... (from 10.2.3.42, lan via proxy)
```


## 2026.09.13.15 — 2026-09-13

**Fixed: the add-on rebuilt its entire allowlist for registry changes that could not possibly
affect it — 24 times in 14 minutes, every one a no-op.**

`entity_registry_updated` fires for far more than an allowlist depends on, and the handler never
looked at the payload. Measured on a live instance:

```
allowlist recomputed (entity_registry_updated): 418 entities (+0 -0)
allowlist recomputed (entity_registry_updated): 418 entities (+0 -0)
allowlist recomputed (entity_registry_updated): 418 entities (+0 -0)
```

Twenty-four of those in fourteen minutes, **every single one reporting `+0 -0`**. Each rebuild is
a full `get_states` over 9,592 entities plus all four registries — roughly **20 MB pulled from
Home Assistant per rebuild**, and the serialisation cost on HA's side to produce it, to change
nothing at all.

Registry events are now filtered: `create` and `remove` always rebuild, and an `update` rebuilds
unless *every* changed field is one an allowlist cannot depend on (`options`, `capabilities`,
`supported_features`, `unit_of_measurement`, `previous_unique_id`, `suggested_object_id`). An
unrecognised payload shape still rebuilds — the asymmetry runs the usual way here, since a wasted
rebuild costs bandwidth while a skipped one serves a dashboard entities it no longer has.

**Second defect, in the same place: rebuilds could overlap.** The 1500 ms debounce guarded
*scheduling*, not execution — once the timer fired, `buildAllow()` was awaited, and any event
arriving during that await scheduled a fresh timer that fired while the first rebuild was still
running. Three rebuilds completed inside one second on the live instance. A rebuild in flight now
sets a flag, and exactly one follow-up runs when it finishes.

Nothing about what the add-on serves changes. This is purely work it was doing for no reason,
against a Home Assistant that had to produce a full instance dump each time.


## 2026.09.13.14 — 2026-09-13

**Fixed: the traffic panel double-counted every batched frame, and sized it wrong.**

Home Assistant packs messages into a JSON array. `m.type` is `undefined` on an array, so a
batched frame was labelled once in the array branch and then fell through **every** branch of the
labelling chain into the catch-all `(no type field)` bucket — producing two rows for one frame.

The live panel proved it arithmetically:

```
batched event:entity-diff+result   n=15
batched event:entity-diff          n=140
batched result                     n=10
                                   ---
                                   165
(no type field)                    n=165     <- exact match
```

`(no type field)` was never unexplained traffic. It was the same 165 frames counted again,
carrying **2.78MB** that was not a distinct payload. That bucket exists to surface genuinely
typeless objects — the thing you actually want to know about — and it was drowned in phantoms.

**Second defect in the same place:** the array branch recorded `inBytes` while every other path
records `outBytes`. Batched frames were therefore reported at their **pre-trim** size, so the
largest row in the table was measuring something different from every row beside it. On the live
instance that read as **17.30MB across 15 messages** — 1.15MB per frame, against a measured
cold-start entity payload of about 50KB.

Both are fixed: a batched frame is now recorded exactly once, in `done()`, at the size that
actually went to the browser. The regression test was verified to fail without the fix.

Nothing about what the add-on *sends* changes — this is purely what it reports about itself. But
a panel that exists to explain where the bytes go should not invent 2.78MB and misreport its
biggest row by an order of magnitude.


## 2026.09.13.13 — 2026-09-13

Version bump only, to force Supervisor to re-read `config.yaml`.

Supervisor caches an add-on's **options schema** separately from its code. A `rebuild` picks up
new code but leaves the cached schema in place, so a newly added option is silently dropped from
any write — `ignored_fields` in the response, no error. A version transition is what makes it
re-read the schema, so `exclude_device_categories` (added in `.12`) needs this to be settable.

No functional change.


## 2026.09.13.12 — 2026-09-13

**New: `exclude_device_categories`, and every device expansion now reports its own split.**

Expanding a device pulls in everything it owns, and a device owns far more than a card renders.
A Litter-Robot 4 measured here carries **21 entities** — the vacuum, waste drawer, litter level
and pet weight, but also panel brightness, globe brightness, a reset button, a firmware update,
last-seen, status code and power status. A card rendering a fill percentage needs a handful.

Home Assistant already labels the difference. `config` marks controls that configure the device;
`diagnostic` marks readings about its health. `exclude_device_categories` drops either or both
whenever a device is expanded — by a card configured with a device, or by a `client_overrides`
rule.

**It is empty by default, and that is deliberate.** Whether a given card renders `status_code` is
not knowable from outside the card, and a wrongly dropped entity blanks part of it with no error
anywhere — the same silent failure mode this add-on has had to fix three times already.

So instead of guessing, every device expansion now **logs its own breakdown**:

```
card names device "Robot 1": +21 entities (12 primary, 6 config, 3 diagnostic)
client rule 10.2.4.109: device "Basement Stairs Panel" -> 21 entities (14 primary, 7 config, 0 diagnostic)
```

Read the real numbers for your own devices, then decide. A saving you can see before you take it
is worth more than a default that quietly breaks a card.

Also considered and rejected: inferring the entities from the card's own JavaScript bundle. The
add-on already reads bundles for `trim_resources`, but that works because a *card type name* is a
literal string. Which entities a card renders is resolved at runtime from a device id, by
`unique_id` suffix or translation key, and may be built dynamically — so a miss is silent and
invisible. Entity categories come from Home Assistant and require no inference at all.


## 2026.09.13.11 — 2026-09-13

**New: `client_overrides` — entity rules pinned to a physical device, not to a dashboard.**

Some entities belong to the machine in front of you rather than to whatever page it is showing.
A **browser-based voice satellite** is the clearest case: `assist_satellite.office_panel` and its
twenty siblings are only ever useful to the one panel that *is* that satellite. Scoping them to a
dashboard is wrong in both directions — the panel loses them the moment it navigates somewhere
else, and every other client opening that dashboard pays for entities it can never use.

```yaml
client_overrides:
  - client: 10.2.4.109          # an IP, a CIDR, or a hostname
    devices: ["Office Panel"]   # the whole device, by registry name or id
    always_forward: []          # patterns, same syntax as everywhere else
    never_forward: []
```

`devices` names whole **devices** rather than listing entity ids, deliberately: a voice satellite
integration adds entities between releases, and a rule that must be re-edited to keep working is
a rule that silently stops working. The measured device here owns 21 entities across six domains.

`client` accepts an IP, an IPv4 CIDR (`10.2.4.0/24`) for a whole VLAN of panels, or a hostname.
Hostnames are resolved when the allowlist is built — not per connection, which would put a DNS
round trip in front of every websocket upgrade — so a moved DHCP lease is picked up on the next
rebuild. A lookup that fails logs and leaves that one rule inactive rather than failing the
build. Note that mDNS/`.local` names generally do **not** resolve from inside the container; use
a real DNS record, which a UniFi client reservation can supply.

Rules apply on top of whichever dashboard set was chosen, **and whether or not the dashboard
could be attributed at all** — that is the point of pinning to a device. `never_forward` still
wins last, consistent with every other override block. The widening is logged
(`+client rules (149 -> 170)`) so a pin is visible rather than mysterious.


## 2026.09.13.10 — 2026-09-13

**Fixed: a card configured with a *device* instead of entities had all of them stripped.**

Some custom cards are configured by pointing at a device and look up that device's entities
themselves, in the browser. `custom:ha-bambulab-print_status-card` is configured as
`printer: 43f1e9fddd670256ced58c9fe7971e41` — a device id. Nothing anywhere in that card config
is an `entity_id`, so the structural walk found none.

Measured on the instance this was found on: the dashboard carrying it resolved to **2 entities**
(its two lights), and the printer's **57 entities were all stripped**. The card then renders with
nothing in it — which reads as a broken card, not as a trimming problem, and that is what makes
this worth fixing rather than documenting.

Device ids were already understood as an auto-entities *filter key* (`device:`). They were not
understood as a value sitting on an ordinary card.

The fix matches on the **value**, not the key. The key name cannot be predicted — `printer`
here, something else on the next card — so any string that is a **registered device id** expands
to that device's entities, wherever it appears in the card tree, including inside lists and
nested stacks. Shape alone is never enough: a 32-hex string that is not in the device registry
adds nothing, which makes a false positive essentially impossible.

This deliberately admits the device's whole entity set rather than guessing which subset the
card renders, because the card's internals are not knowable from here and the failure modes are
not symmetric — a few entities too many costs bandwidth, while one missing silently empties a
card on a wall panel with no error anywhere.

## 2026.09.13.09 — 2026-09-13

**Fixed: the connection-timing panel was reporting a payload size it had not measured.**

`initialPayloadBytes` sized the whole websocket *frame* the initial entity block arrived in.
Home Assistant batches messages into a JSON array, so that number silently absorbed whatever
else was bundled alongside — sometimes `lovelace/config` and the registries, sometimes nothing
at all.

Caught by reading the live panel rather than the code: two clients on the **same dashboard**
with the **same 149-entity allowlist** reported **246 KB** and **1.5 KB**, a 164× spread. A
third reported a 447-byte "full entity payload" for a 104-entity dashboard, which is not
physically possible. The measurement now sizes the `a` block itself and ignores the batch.

**`initialEntityCount` is new, and is reported beside the bytes on purpose.** A byte count on
its own cannot be checked by the person reading it. "447 B / 3 entities" next to a 104-entity
allowlist is visibly a partial first block; "447 B" alone just looks like a very fast dashboard.

**The panel also stops overstating what these numbers mean.** It previously called *Ready in*
"most of what a person experiences as the dashboard coming up" and *On the wire* "the dominant
term on a phone over cellular". Neither survives measurement:

- *Ready in* is dominated by how long the **frontend** takes to get around to subscribing — auth
  handshake, JavaScript parse — not by moving the payload. A LAN wall panel took **671 ms for
  1.5 KB** while a phone on 5G took **207 ms for 215 KB**.
- *On the wire* measures handoff to the kernel socket buffer, not receipt by the device. A
  215 KB payload "drained" in **6 ms** over cellular — far quicker than that link can physically
  carry it. The buffer simply swallowed it.

Both are now labelled as diagnostics, in the panel and in the code, with the caution that
neither should be quoted as a speed. They are still worth having: they are the only view of a
native companion-app socket, which no browser tooling can see at all. They are just not a
benchmark, and the panel no longer implies they are.

## 2026.09.13.08 — 2026-09-13

**Fixed: an infinite redirect loop behind your own HTTPS reverse proxy.**

If you put Caddy, nginx or Traefik in front of the add-on to terminate TLS, pages never
loaded and the URL degenerated into `.../:8123./:8123./:8123./...`. Two separate defects, both
caused by `http-proxy`'s `autoRewrite`:

1. It rewrites a redirect's **host** but never its **scheme**. `changeOrigin` makes Home
   Assistant see the request as arriving at its own address, so its absolute redirects name
   that address. `autoRewrite` corrected the host and left the scheme alone — so the browser
   was sent from `https://your.host/…` to `http://your.host/…`, the edge proxy bounced it
   straight back to HTTPS, HA reissued the same redirect, and round it went.
2. Absolute URLs **inside query parameters** were never touched, so the auth flow's
   `redirect_uri` still pointed at HA's internal LAN address — unreachable from outside.
   That is the half that broke logging in remotely.

`autoRewrite` is now off, and the rewrite is done properly in a `proxyRes` handler: scheme
and host together, plus `redirect_uri` and `hass_url`. Relative redirects stay relative,
genuinely third-party redirects are left alone, and a **custom-scheme `redirect_uri` — which
is how the iOS and Android companion apps complete authentication — is explicitly preserved**
rather than mangled into an https URL the app cannot follow.

The scheme and host are read from the **first** entry of `x-forwarded-proto`/`-host`, because
`xfwd` appends our own hop (Caddy's `https` arrives as `https,http`).

Credit where it is due: this was root-caused and fixed by the upstream maintainer
(GabrielGoldsteinAnidea) on a branch that was never merged, so this fork carried the bug
despite being well ahead of upstream otherwise. Cherry-picked here with authorship intact;
the only change was the version number, upstream having called it `0.2.4-rc1`.

Reported in upstream issues #9 (genik70, dimatx) and #8 (companion app).

## 2026.09.13.07 — 2026-09-13

**Every connection now reports how long it took to become useful.** Three numbers per client,
in `stats.json` and on the panel:

- `initialPayloadBytes` — the first full entity dump, i.e. the payload a dashboard cannot
  render without, and the part this add-on shrinks.
- `msToEntityData` — websocket upgrade to that payload written out. Most of what a person
  experiences as the dashboard coming up.
- `initialDrainMs` — how much of that was the link itself. Near zero on a LAN; the dominant
  term on a phone over cellular.

This exists so "is it actually faster" has an answer that is not an opinion, and so it can be
answered for clients that cannot be instrumented from outside at all — the iOS and Android
companion apps open a native websocket and never load a page, so no browser tooling can see
them. The add-on already sits in the middle of that socket, so it measures it directly.

Recorded once per connection, on the cold-start payload only: a later re-subscribe is a
different event, and averaging them together would destroy the number this exists to report.

First measurement from a live instance, same dashboard and the same ~44KB payload over two
different paths: **28ms on the LAN, 134ms arriving over the internet through Cloudflare.** The
payload is identical, so the difference is entirely the link — which is the whole argument for
trimming it before it goes out.

One honest limitation, also stated on the panel: "on the wire" means handed to the network
stack, not acknowledged by the device. It tracks link speed and backpressure well, and it is
not a round-trip measurement.

## 2026.09.13.06 — 2026-09-13

**Fixed: a per-user rule was applied to an allowlist that was never sent.**

The proxy holds a connection's messages until the user is resolved, so that per-user rules can
widen the allowlist before the frontend subscribes. But `subscribe_entities` was rewritten
with the allowlist at the moment it was *queued* and then flushed verbatim — so whenever the
user lookup was slower than the frontend's first subscribe, Home Assistant received the
**pre-rules** entity list and the rule was silently discarded. The gate preserved ordering and
lost content.

Nothing logged a problem: the add-on still reported `user rules applied`, because it had
applied them — to an allowlist nobody used. From outside, a rule simply worked on some
connections and not others, with no way to tell which. Entities granted by a per-user rule
would be present after one reconnect and missing after the next.

The held payload is now built when the message is sent rather than when it is queued. The
empty-allowlist refusal moved with it, so a `never_forward` rule that narrows the list while
the message is held is still caught.

**New: connections record how they reached the add-on.** Each client now reports an `origin`
(`lan` / `internet`), a `route` (`direct`, `proxy`, `cloudflare`, `ingress`), the hostname it
dialled, and the immediate peer address — with lifetime tallies under `paths` in `stats.json`
and a "How clients reach this" table on the panel. This answers "is anyone actually using the
remote path, and through which front door" without touching a reverse-proxy log.

It is **reporting only**. Every signal except the peer address is a request header, so none of
it is trustworthy enough to make access decisions with; making it trustworthy would need a
configured list of trusted hops, which does not exist here. See the header of `route.mjs`.

Also fixed a latent attribution bug found on the way: a reverse proxy that sets only
`X-Real-IP` and no `X-Forwarded-For` had all of its clients attributed to the proxy's own
address — one bucket, every device — which silently degraded per-dashboard attribution to
whichever client loaded last.

## 2026.09.13.02 — 2026-09-13

**Per-user `always_forward` / `never_forward`,** via a new `user_overrides` option — the one
thing per-dashboard rules cannot express: two people opening the *same* dashboard who should
not be served the same entities.

Identity comes from the browser's own access token, which is already the first thing it sends,
resolved against HA's `auth/current_user`. The lookup runs on a separate short-lived
connection because Home Assistant enforces strictly increasing message ids per connection, so
injecting it into the browser's own socket could collide with an id the frontend uses later.
Results are cached by a hash of the token — never the token — for ten minutes.

Messages after `auth` are held in order until the lookup returns, because letting a later
message overtake an earlier one would break that same id rule. A failed or slow lookup applies
no rules rather than failing the connection, and with `user_overrides` empty no lookup is ever
made.

## 2026.09.13.01 — 2026-09-13

**Per-dashboard `always_forward` / `never_forward`,** via a new `dashboard_overrides` option.

`always_forward` is global, which is the right shape for something every dashboard needs — a
clock, an Assist pipeline — and the wrong shape for something one dashboard needs. Forcing
`update.*` in globally so an admin dashboard could show a pending-updates count added **252
entities to a wall panel showing four lights**, giving back most of the trimming.

Per-dashboard rules layer on top of the global ones. The global `never` list still wins last:
it is a statement about the whole instance, so a per-dashboard `always` must not override it.

## 2026.09.12.22 — 2026-09-12

**Fixed: every trim was bypassed for batched frames.** Home Assistant packs several messages
into a single JSON array, and all the trimming was written against the top-level object — so a
batched frame skipped `get_states`, all four registries, `get_services`, resources and the
egress event filter alike.

Measured: **13.5MB of untrimmed registry on every connection** to a panel trimmed to 104
entities, while `trim_registries` was on and logging success for the unbatched ones. The logs
said it was working because, for the messages it could see, it was.

The trims now run per message. Batched frames are rebuilt from the surviving, trimmed messages.

## 2026.09.12.21 — 2026-09-12

Removes the investigation-time logging added while tracking the `subscribe_events` leak: it
dumped entity ids and payload samples, which is right for a hunt and wrong to ship. The
throttled "batched state_changed trimmed N -> M" line stays, since that one reports the fix
doing its job.

## 2026.09.12.20 — 2026-09-12

**Fixed: `subscribe_events("state_changed")` bypassed the allowlist completely.**

The egress filter only ever covered `subscribe_entities`. A card using the older
`subscribe_events` path received **every entity on the instance** — the entire firehose, through
the add-on built to stop it. Measured at ~700MB/h to a single wall panel trimmed to 104
entities, in the verbose legacy format that carries full `old_state` *and* `new_state` with
every attribute.

It hid because **Home Assistant batches messages into a JSON array**. Every `m.type` check sees
`undefined` on an array, so batched frames fell through every branch untouched — and landed in
a stats bucket labelled "(unparsed)", which asserted something untrue and sent two
investigations in the wrong direction.

Array frames are now filtered element by element, single frames from the same subscription get
the same treatment, and a frame whose entire contents were disallowed is dropped rather than
forwarded empty.

## 2026.09.12.19 — 2026-09-12

Diagnostic, corrected. The previous one instrumented the JSON-parse failure path, but these
frames parse fine — they are valid JSON with no `type` field, which fell into a catch-all
bucket labelled "(unparsed)" that was actively misleading. Now labelled "(no type field)" and
dumped once with its keys and a sample.

## 2026.09.12.18 — 2026-09-12

Diagnostic: log one sample of any frame that is neither binary nor parseable JSON, throttled,
with its ws binary flag and leading bytes. Such frames are 89% of what a wall panel receives
here and two hypotheses about their origin have already been wrong.

## 2026.09.12.17 — 2026-09-12

**Fixed: binary websocket frames were being corrupted.** Every frame from Home Assistant was
run through `raw.toString()` and forwarded as a string. That is correct for the JSON control
protocol and wrong for binary frames — it UTF-8-decodes arbitrary bytes, which is lossy, and
then re-sends them as a TEXT frame rather than a binary one.

Home Assistant uses binary frames for media. On the instance this was found on, they were
**90% of everything a wall panel received** — 12MB in 68 seconds — passing through mangled.

Binary frames now pass through byte-for-byte in both directions, and are labelled in the
panel rather than falling into an "unparsed" bucket.

## 2026.09.12.16 — 2026-09-12

**The panel now labels every message, not just the ones it trims.** A wall panel trimmed to 104
entities was receiving ~98MB/h, and nothing in the panel could say what it was: the trim
categories only cover payloads this add-on knows how to shrink, so everything else landed in a
total with no breakdown. Results are attributed to the command that asked for them, events to
their event_type.

## 2026.09.12.15 — 2026-09-12

**The history now samples at startup, not only on the interval.** The first bucket used to land
five minutes after boot and the first chart five minutes after that, so a freshly restarted
add-on showed an empty card for ten minutes — a panel that looks broken while working, which is
the precise thing this panel exists to eliminate.

## 2026.09.12.14 — 2026-09-12

**A 24-hour history behind the panel, with charts.** The counters were cumulative since
process start, which answered "what has it done since I last restarted it" and nothing else —
and a restart silently erased the evidence. The panel now shows data not sent, clients
connected, and update traffic over the last day.

Sampled every five minutes into 288 buckets and persisted to `/data`, so a restart costs one
bucket rather than the whole day. Stored as per-bucket **deltas**: a cumulative series goes
backwards across a restart, and a naive difference would emit a large negative bucket. A
counter that decreased is treated as the first sample of a new process, where the reading is
its own delta.

Charts are inline SVG — three sparklines do not justify a dependency, and the page has to stay
self-contained for Ingress. New endpoint: `/history.json`.

The window total reports the span it actually covers, so a panel that has been up for twenty
minutes says so instead of implying a full day.

## 2026.09.12.13 — 2026-09-12

**Default listen port moves from 8099 to 9123** (upstream PR #17). 8099 is the Zigbee2MQTT
add-on's frontend port, so the old default collided with one of the most widely installed
add-ons and the proxy exited on start with `EADDRINUSE` — the worst possible first run. 9123
is self-describing: Home Assistant is 8123, and this sits in front of it.

Only the *default* changes. An install with an explicit `port` option is unaffected.

## 2026.09.12.12 — 2026-09-12

Three corrections to the new panel, all found by deploying it and reading its own output.

**Update traffic counted far more than updates.** A message was filed as event traffic when
it matched none of the four trimmed categories, which swept in `lovelace/config` and every
other untrimmed reply. It now requires `type === "event"`.

**A per-minute rate from a four-second-old connection is not a measurement.** Dividing an
opening burst by a fraction of a minute produced rates in the megabytes. The rate is null
until a connection has a full minute behind it, and the panel renders that as "—".

**The instance size was always zero.** It was learned from a browser's `get_states`, but the
modern frontend subscribes instead of polling and may never send one. Taken from the control
connection's own fetch instead, which asks for every state by definition.

## 2026.09.12.11 — 2026-09-12

**A statistics panel in the Home Assistant sidebar, and a JSON API behind it.** Until now the
only evidence the add-on was doing anything was the log — which you read once something
already looks wrong. The panel shows clients connected and which dashboard each was
attributed to, measured before/after for every trimmed payload, per-dashboard entity and
resource figures, registry cache hits, and live update throughput. Served over Ingress on its
own port (8100), so it needs no configuration and no extra exposed port; the same data is at
`http://<host>:8100/stats.json` for a `rest` sensor or a scrape.

It reports only what it can honestly measure. The trimmed payloads have a real before/after —
the proxy holds HA's full answer and its own trimmed answer in the same function, so "saved"
is a subtraction. The event stream does not: HA filters it server-side from the entity list
the add-on injects, so the untrimmed volume never exists anywhere and cannot be measured. It
is reported as throughput and never folded into the savings total.

**Fixed: a dashboard edit left stale trimmed registries in the cache.** The response cache
added in `.10` is keyed by allowlist version, but only the reconnect path bumped it — a
`lovelace_updated` recompute did not. So after any dashboard edit, connections kept being
answered from registries trimmed to the *previous* allowlist. The growth case was the
damaging one: `applyAllow` recycles every open kiosk precisely so it picks up new entities,
and those reconnections came back to registry rows that omitted them, leaving names and areas
quietly unresolved on exactly the entities just added.

## 2026.09.12.10 — 2026-09-12

**Trimmed registry answers are now cached across connections.** The registries are
per-*instance*: for a given allowlist every client gets byte-identical rows. Each connection
that asked was making Home Assistant serialise the whole thing again — 16k rows and ~10MB of
entity registry here — and this proxy parse it again. A single kiosk load opens several
websockets, so that multiplied into real CPU on the HA host for no new information. A cached
answer is now served locally and never forwarded. Keyed by allowlist version, so a rebuild
retires every entry.

**`trim_services` (default off)** cuts `get_services` to the domains a connection can see.
It is sent on every page load and carries every service of every integration: **193KB across
115 domains**, where only **45 domains** had any entity at all. `homeassistant` is always
kept — its services are domain-agnostic, so dropping it breaks more than it saves. Off by
default for the same reason as `trim_resources`: fine for a kiosk, visibly lossy in the
admin UI.


## 2026.09.12.09 — 2026-09-12

**Per-browser dashboard attribution via a cookie, so NAT stops collapsing clients together.**

The IP hint is shared by every device behind one address. A phone and a laptop on the same
WAN address overwrite each other's attribution, and the loser is served another dashboard's
allowlist until it reloads. That is not an edge case when access goes through a tunnel, where
every remote client arrives from one address.

A dashboard page response now stamps `ws_dash=<url_path>` on the browser, and the websocket
upgrade reads it back. Precedence is **cookie, then IP hint, then the union** — so nothing
regresses for a client that sends no cookie, and the log now names which signal was used
(`serving basement-stairs-panel via cookie`) so a wrong allowlist is diagnosable rather than
mysterious.

The cookie holds the dashboard path itself, not an opaque id, which keeps attribution
**stateless**: there is no server-side map to lose, so the add-on can restart mid-session
without any client losing its scope. A tampered value can only name a dashboard already in
the configured list — a set that client could reach anyway — and an unrecognised one falls
through to the next signal.

Note this solves a different problem from user-based scoping: a user identifies an *account*,
so two devices signed in as the same person still collide. A cookie identifies a *browser*.


## 2026.09.12.07 — 2026-09-12

**The Configuration tab now explains itself.** Added `translations/en.yaml`, so every option
renders with a proper name and description in Home Assistant instead of a bare key like
`resources_always_forward`. The warnings that matter are in the UI now — that
`trim_resources` can fail silently, that `compress_websocket` should be left on, and that
an entity read by panel-side JavaScript needs `always_forward` while one only written does
not. Two tests keep the file in step with the schema in both directions.

**Documentation corrected.** The README and DOCS both still claimed registries and
custom-card resources "pass through untouched", which stopped being true when registry
trimming landed. Both now describe what is actually trimmed, and the README's example config
shows the current options rather than only the original four.


## 2026.09.12.06 — 2026-09-12

An icon namespace is matched **both** as `ns:` (how a user writes it) and as a registration
key, `customIconsets["ns"]` (how the pack that serves it writes it — a provider never writes
the colon form at all). Matching only the colon form dropped `custom-icons.js`, the provider
of `cil:`, from every dashboard.

Fragment distinctiveness is **measured**, not a stop-word list: document frequency across the
resources actually read, with anything in more than a quarter of them disqualified. The first
attempt used a hand-written list, and `grid`, `layout`, `entity` and `progress` slipped
through it and matched nearly every bundle — taking one panel from 2,998KB to 11,876KB, four
times worse than the bug being fixed.

**Icon namespaces are matched with their colon, and card types can match by fragments.**
Two bugs in the resource matcher, found by breaking down what one dashboard was actually
keeping.

*False positives.* A namespace was matched as a bare substring, so the 3-character `cbi`
kept **4,818KB** of bundles that merely contained those letters — inside base64 blobs,
minified identifiers, and one `cbid:`. `cbi:` appeared in none of them. An icon reference
always carries its colon, so that is what is matched now.

*False negatives, hidden by those false positives.* `ha-bambulab-cards.js` is 3.2MB and a
dashboard renders `ha-bambulab-print_status-card` — a string that appears **nowhere** in the
bundle, which builds its element names at runtime. It was being kept only by the accidental
`cbi` hit. Tightening the icon match alone would therefore have broken those cards.

So a card type now matches on its literal name *or*, failing that, on every one of its
distinctive fragments (`bambulab` **and** `print_status`), requiring at least two so a single
generic word can never carry a match on its own.


## 2026.09.12.05 — 2026-09-12

**Resource matching now reads the icons of the entities a dashboard shows, not just its
config text.** An entity's icon normally lives in the entity registry, so a config-only scan
never sees it and drops the icon pack that renders it. Measured here: 20 entities carry
`phu:` icons set in the registry, and the string `phu` appears in no dashboard's YAML.

Without this, keeping those icons working meant pinning the pack in
`resources_always_forward` for every dashboard — 4,571KB on a panel that shows none of
those 20 entities, 60% of its entire resource payload. With it, the pack is kept for the
dashboards that show `phu:` entities and dropped for the ones that don't, automatically.


## 2026.09.12.04 — 2026-09-12

**Resources dropped by *every* dashboard are now called out separately in the log**, with
guidance. That set is the signature of the one failure the documented tuning loop cannot
catch: "load the dashboard and see what looks wrong" finds a card that won't render or an
icon that goes blank, but not a resource that registers no element and is named by no
dashboard, yet runs on load and subscribes to state — an idle timer, a camera pop-up, a
heartbeat. Drop one of those and the dashboard is pixel-identical; only the behaviour stops.

`DOCS.md` names that as a third class needing `resources_always_forward`, alongside frontend
patchers and icon packs, and marks which are loud and which is silent.

Raised by @ajguerre1 reviewing the upstream PR, from production: they lost a doorbell pop-up
on 28 panels for three days to the same failure one level down, where entity scoping stripped
the helpers a resident module read. Home Assistant's half kept working and the chime still
played, so the house sounded normal while the screens did nothing.

The per-dashboard drop detail moved out of the per-dashboard loop into this one block —
previously it printed every dropped URL once per dashboard, which on a six-dashboard instance
was most of the startup log.

**`per_dashboard` is retained here**, unlike on the upstream PR branch where it was withdrawn
in favour of upstream #13. This fork is what the add-on is built from, and #13 is not merged,
so removing it would serve every connection the union instead of its own dashboard.


## 2026.09.12.02 — 2026-09-12

**Per-dashboard Lovelace resource trimming (`trim_resources`, default off).** Resources are
instance-wide in HA: every kiosk downloads, parses and compiles every custom card in the
install. Measured here: **45 resources, 21MB of JavaScript, for a wall panel that renders four
custom card types**. Trimming took that panel to 8 resources / 2.5MB.

Resources are matched by testing each dashboard's custom card types (and non-builtin icon
prefixes) as substrings of the resource body. Scanning for `customElements.define()` is the
obvious approach and the wrong one — large bundles build element names at runtime, so
`mushroom.js` (639KB) exposes almost nothing that way and would be dropped from a dashboard
that needs it.

Off by default, because unlike a dropped entity a dropped resource is *visible*. Every drop is
logged with its size, and `resources_always_forward` rescues frontend patchers and icon packs,
which register no card and so cannot be detected by content. On the panel this was built
against, `kiosk-mode` and the icon packs needed it; with those four restored the dashboard was
pixel-identical to before, with 33 of 45 resources still dropped.

**Honest note on the payoff:** removing 13-18MB of the 21MB did *not* reliably speed the panel
up — 29.1s mean against 31.5s, inside the run-to-run spread. The CPU profile that motivated
this (73% of main-thread busy time unattributed to script, style or layout) does not appear to
have been module parsing after all. The feature is worth having for bandwidth, memory and
sanity on a large install; do not expect it to transform load time.


## 2026.09.11.03 — 2026-09-11

Both of these came out of a byte census of one real kiosk load (2,457.9KB over 72 frames).

**`config/entity_registry/list_for_display` is now trimmed — it is the largest payload the
frontend fetches.** It was passing through whole: 1,437.9KB, 58% of the entire websocket
load, more than everything else combined. The trim missed it because `list_for_display`, in
spite of the name, does not answer with a list — it answers with an object,
`{entity_categories, entities}`, whose rows use two-letter keys (`ei` for entity_id, `di`
device, `ai` area). The result guard tested `Array.isArray(m.result)` and skipped it in
silence. Now 9,533 rows -> 100 on the panel this was found on.

**Websocket compression restored (`compress_websocket`, default on).** HA's own websocket
negotiates `permessage-deflate`; the `ws` library does **not** enable it server-side by
default. So putting this proxy in front of HA silently *removed* compression from the browser
leg — kiosks went from deflated frames to plaintext JSON over wifi. Verified by comparing the
negotiated `Sec-WebSocket-Extensions` on HA directly (`permessage-deflate`) against the proxy
(nothing). Deflate runs on libuv's threadpool rather than the main loop, and is capped with
`concurrencyLimit`; turn it off on very weak hardware.

Measured on the NSPanel Pro these were found on: 33.2/31.7/33.9s before, 31.2/30.7/32.7s
after. The payload fell by roughly an order of magnitude but wall-clock barely moved, which
is itself the useful result — what remains of that ~31s is not websocket bytes.

## 2026.09.11.02 — 2026-09-11

**Fix: reconnect storm when a client enumerates dashboards.** `2026.09.11.01` treated a
`lovelace/config` request as the client announcing which dashboard it was about to render,
correcting the stored hint and recycling the socket to follow it. That is wrong: requesting a
dashboard's config does not mean displaying it. Kiosk Satellite enumerates *every* dashboard's
views at startup, so a panel showing one dashboard requests the config of all five. The hint
flipped to whichever was enumerated last, the socket recycled, the reconnect enumerated again —
four `/api/websocket` connections in four seconds, and the panel then served the wrong
dashboard's allowlist. One measured load never completed inside 70s.

The page GET is now the only signal used to attribute a connection, because it is the only one
that actually means "this client is displaying this dashboard".

The cost is that a client-side navigation to a *different* dashboard keeps the allowlist it
connected with until the page reloads, so entities unique to the new dashboard render as
unavailable. Set `per_dashboard: false` to serve every connection the union if that matters
more than the trimming does.

## 2026.09.11.01 — 2026-09-11

Versioning moves to `yyyy.mm.dd.xx`.

**Per-dashboard allowlists (`per_dashboard`, default on).** Every connection used to get the
*union* of all configured dashboards. On the instance this was developed against that union
was 388 entities while the kiosk's own dashboard needed 60 — so a small wall panel paid for
five dashboards to display one. Each connection is now served only its own dashboard's
entities.

The dashboard has to be known *before* the socket opens, because `subscribe_entities` is the
message being rewritten and the frontend only asks for `lovelace/config` afterwards. What
does arrive first is the ordinary page GET (`/basement-stairs-panel/basement`) on the same
client IP, so that is what attributes the connection. A client that can't be attributed falls
back to the union, i.e. exactly the previous behaviour — this option can only ever serve a
connection *less*, never *less than it needs*.

The SPA can also navigate between dashboards without reopening the websocket. When a
connection asks for a `lovelace/config` belonging to a dashboard its allowlist doesn't cover,
the hint is corrected and the socket recycled; the frontend reconnects itself and
re-subscribes, the same mechanism an allowlist growth already used.

`always_forward` / `never_forward` are now applied **per dashboard** rather than only to the
union — `always_forward` exists for entities no card names (Assist pipeline and wake-word
entities behind a Voice Satellite card, say), and those are needed on whichever dashboard the
kiosk actually has open.

**Registry trimming (`trim_registries`, default on).** The entity registry is one row per
entity for the entire instance and, once states are trimmed, the largest thing left that
scales with instance size rather than with what the dashboard shows. It is now cut to the
entities the connection can see, with devices and areas kept wherever a surviving entity
still reaches them so names and area assignments still resolve. Unrecognised registry shapes
pass through untouched rather than being guessed at.

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
