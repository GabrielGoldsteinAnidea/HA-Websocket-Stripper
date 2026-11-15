# Console rework — design note

A mockup only: `mock.html` is one static file with fake data; nothing under `strimmer/` changed.
`?theme=dark|light` pins a theme, `?open` expands the first row of each list.

## Information architecture

**Overview · Dashboards · Clients · Settings · Diagnostics**

- **Overview** answers "is it working?": a health line (*Trimming is on / paused*) with the one
  relevant action beside it, four headline numbers, one 24h chart with a metric toggle, and a short
  *Worth a look* list linking into the other tabs.
- **Dashboards** merges the old Dashboards table, Entities search and Resource tuning: all three are
  "what does each panel receive, and how do I fix a card showing unavailable". Each dashboard is a
  list row with a secondary line; bytes and views sit behind an expand.
- **Clients** is a row list (name, dashboard, address, Connected chip) instead of a 13-column table;
  the diagnostic columns become the expanded detail. The Sankey is a collapsed table.
- **Settings** replaces the tile grid with HA-style switches in three groups, plain-language labels
  (*Device and area lists*, not `trim_registries`), lossy options under *Extra trimming*, chip editors
  for always/never lists, and ports/addresses/log level/override rules collapsed under *Advanced*.
  A sticky save bar appears only when something changed.
- **Diagnostics** holds the new *Download diagnostics* action, pause with duration and scope, and the
  raw tables (message kinds, HTTP errors, stats.json) collapsed.

## Cut, merged, demoted

Cut: the paragraph under every card, the per-payload "What got trimmed"
table, "Modules injected" (folded into *Unused cards*), the 24h sub-stats, the ⋮ menu. Demoted:
Sankey, HTTP log, message-kind table. Merged: dashboards + entity search + resource tuning.

## Kept from CLAUDE.md

Local tokens aliased to HA names; no HA web components; glyphs inlined as SVG symbols; sentence-case
16px/500 headings; neutral header with identity block and 1px divider; works at 390px.

## Deliberately changed

- **Text buttons.** Icon-only buttons needed a tooltip to decode. HA's Settings pages label actions
  (*Download*, *Pause*, *Keep sending*); so does the mock. `test/panel_buttons.test.mjs` would change.
- **Switches, not tiles.** A tile hides the sentence saying what it does; a list row with a switch
  shows state and meaning together.
- **Tabs left-aligned**, as HA's tab bars are, not centred in a three-column grid.
- **Pause is a card, not a header popover**, with duration and scope visible. Pause/Resume also sits
  on the Overview health line, the state it changes.
