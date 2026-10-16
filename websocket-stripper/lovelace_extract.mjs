// lovelace_extract.mjs — extract the entity-id allowlist from a Lovelace config.
//
// Walks the card tree collecting entities from the standard keys, and expands
// `auto-entities` filter cards against the live entity list (and, when provided, the
// area/device/entity/label registries so `area`/`label`/`device`/`integration` filters
// resolve too — see issue #4).
//
// extractEntities(config, allStates, opts) -> { entities:[...], unsupported:[...] }
//   config     : the lovelace dashboard config (from `lovelace/config`)
//   allStates  : array of HA state objects [{entity_id, state, attributes}, ...]
//   opts.viewPath    : optional view `path` to restrict extraction to a single view
//   opts.registries  : { areas, devices, entities, labels } from HA's config/*_registry/list
//   opts.overInclude : when true (allowlist mode), don't let volatile conditions
//                      (state/attributes) shrink the set — an entity that doesn't match a
//                      `state:` filter right now must still be forwarded so the card can
//                      show it when it later does.
//   opts.renderedTemplates : Map<templateString, renderedText> for `filter.template` cards.
//                      Collect the templates with collectTemplates(), render them through
//                      HA, and pass the results back in (this module can't render itself).

const ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;
export const isEntityId = (s) => typeof s === 'string' && ID_RE.test(s);

// Port of auto-entities' own `matcher()` (src/match.ts). EVERY filter key upstream runs its
// value through this — not just entity_id — so globs and regexes work on domain/area/label/
// device/integration/name alike. The two forms differ in anchoring, which matters:
//   "/^sensor\.pv_.*_power$/"  -> RegExp("^sensor\.pv_.*_power$")   UNanchored by us; the
//                                 user supplies their own anchors inside the slashes.
//   "sensor.pv_*"              -> RegExp("^sensor\.pv_.*$")         globs are anchored.
//   "sensor.foo"               -> exact string equality.
// Previously only the glob form existed, and a /regex/ was escaped as literal text — so
// `/^sensor\.pv_.*_power$/` compiled to `^/\^sensor\\\.pv_.*_power\$/$` and matched nothing
// (issue #10). Upstream ORs the regex against exact equality, so we do too.
export function toMatcher(pattern) {
  if (typeof pattern !== 'string') return (v) => v === pattern;
  const tests = [];
  if ((pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 1) || pattern.includes('*')) {
    let p = pattern;
    // Glob -> anchored regex. Escape regex metacharacters EXCEPT `*`, which becomes `.*`.
    // (Upstream's own glob branch forgets to escape `.`; we escape it, which is stricter but
    // only ever in the safe direction for an allowlist.)
    if (!p.startsWith('/')) p = `/^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$/`;
    try {
      const re = new RegExp(p.slice(1, -1));
      tests.push((v) => typeof v === 'string' && re.test(v));
    } catch { /* an unparseable regex simply contributes no matches */ }
  }
  tests.push((v) => v === pattern);
  return (v) => tests.some((t) => t(v));
}

const asArray = (v) => (Array.isArray(v) ? v : [v]);

// A filter value may be a plain string, an array, or — from HA's selector UI — an object
// that records which input mode was used, e.g. `{ label: "1st_floor", active_choice: "label" }`
// or `{ custom: "input_boolean.bypass_*", active_choice: "custom" }`. `active_choice` names
// the key holding the real value, so prefer it; fall back to the filter key itself.
// Without this an object stringifies to "[object Object]" and matches nothing.
function coerceVal(v, key) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap((x) => coerceVal(x, key));
  if (typeof v === 'object') {
    const pick = typeof v.active_choice === 'string' && v.active_choice in v ? v.active_choice
      : key in v ? key : null;
    return pick ? coerceVal(v[pick], key) : [];
  }
  return [v];
}

// Build a predicate for filter key `key` from its (possibly editor-wrapped) value: the value
// matches if ANY of its alternatives matches, via the auto-entities matcher.
function valMatcher(v, key) {
  const ms = coerceVal(v, key).map((x) => toMatcher(typeof x === 'string' ? x : String(x)));
  return (s) => ms.some((m) => m(s));
}

// Build entity -> {area, labels, device, integration} lookups from the registries.
// area is inherited from the entity's device when the entity has no explicit area.
export function buildRegistryCtx(registries = {}) {
  const areas = registries.areas || [];
  const labels = registries.labels || [];
  const devices = registries.devices || [];
  const entities = registries.entities || [];
  const areaName = new Map(areas.map((a) => [a.area_id, a.name]));
  const labelName = new Map(labels.map((l) => [l.label_id, l.name]));
  const deviceArea = new Map(devices.map((d) => [d.id, d.area_id]));
  const deviceName = new Map(devices.map((d) => [d.id, d.name_by_user || d.name]));
  const ent = new Map();
  for (const e of entities) {
    const areaId = e.area_id || (e.device_id ? deviceArea.get(e.device_id) : null) || null;
    const labelIds = e.labels || [];
    ent.set(e.entity_id, {
      areaId,
      areaName: areaId ? areaName.get(areaId) ?? null : null,
      labelIds,
      labelNames: labelIds.map((id) => labelName.get(id)).filter(Boolean),
      deviceId: e.device_id || null,
      deviceName: e.device_id ? deviceName.get(e.device_id) ?? null : null,
      platform: e.platform || null,
    });
  }
  return { ent };
}

// Split one auto-entities condition into structural tests (domain/entity_id/area/label/
// device/integration — stable identity) and volatile tests (state/attributes — change at
// runtime). Callers decide which to apply. Registry-backed keys need `ctx`; without it
// they simply match nothing (degrades to pre-#4 behavior).
function condTests(cond, unsupported, ctx) {
  const structural = [];
  const volatile = [];
  const reg = (s) => ctx.ent && ctx.ent.get(s.entity_id);

  // Each key matches via the auto-entities matcher, so globs and regexes work everywhere
  // (issue #10). Registry-backed keys match against BOTH the id and the human name, the way
  // upstream does — `area: Kitchen` and `area: kitchen_area_id` both resolve.
  if (cond.domain != null) {
    const m = valMatcher(cond.domain, 'domain');
    structural.push((s) => m(s.entity_id.split('.')[0]));
  }
  if (cond.entity_id != null) {
    const m = valMatcher(cond.entity_id, 'entity_id');
    structural.push((s) => m(s.entity_id));
  }
  if (cond.area != null) {
    const m = valMatcher(cond.area, 'area');
    structural.push((s) => { const r = reg(s); return !!r && (m(r.areaId) || m(r.areaName)); });
  }
  if (cond.label != null) {
    const m = valMatcher(cond.label, 'label');
    structural.push((s) => { const r = reg(s); return !!r && (r.labelIds.some(m) || r.labelNames.some(m)); });
  }
  if (cond.device != null) {
    const m = valMatcher(cond.device, 'device');
    structural.push((s) => { const r = reg(s); return !!r && (m(r.deviceId) || m(r.deviceName)); });
  }
  if (cond.integration != null) {
    const m = valMatcher(cond.integration, 'integration');
    structural.push((s) => { const r = reg(s); return !!r && m(r.platform); });
  }
  // Upstream matches `name` against friendly_name. Structural, not volatile: a friendly name
  // is stable identity, unlike state — treating it as volatile would forward the whole
  // instance for any card whose only filter is a name.
  if (cond.name != null) {
    const m = valMatcher(cond.name, 'name');
    structural.push((s) => m(s.attributes?.friendly_name));
  }
  // `group: group.foo` -> the members listed in that group's entity_id attribute.
  if (cond.group != null) {
    const want = coerceVal(cond.group, 'group').map(String);
    const members = new Set();
    for (const g of want) {
      const st = ctx.byId?.get(g);
      for (const e of asArray(st?.attributes?.entity_id ?? [])) if (isEntityId(e)) members.add(e);
    }
    structural.push((s) => members.has(s.entity_id));
  }
  if (cond.state != null) { const m = toMatcher(cond.state); volatile.push((s) => m(s.state)); }
  if (cond.attributes && typeof cond.attributes === 'object') {
    for (const [k, v] of Object.entries(cond.attributes)) {
      const m = toMatcher(v);
      volatile.push((s) => s.attributes && m(s.attributes[k]));
    }
  }

  // Flag conditions we don't evaluate (not/and/or/last_changed/floor/device_model/…).
  const known = ['domain', 'entity_id', 'area', 'label', 'device', 'integration', 'name',
    'group', 'state', 'attributes', 'options', 'type', 'active_choice', 'sort'];
  for (const k of Object.keys(cond)) {
    if (!known.includes(k)) unsupported.push('auto-entities filter key: ' + k);
  }
  return { structural, volatile };
}

// Turn a condition into a predicate. `role` + `overInclude` decide how volatile tests are
// treated (see extractEntities opts.overInclude):
//   include, overInclude : structural only (fall back to volatile if there are no
//                          structural tests, so a bare `state:` filter still matches).
//   exclude, overInclude : structural only, and never exclude on a volatile-only condition
//                          (dropping an entity we might need later is the harmful direction).
//   otherwise            : all tests (exact, current-state semantics).
function makeMatcher(cond, unsupported, ctx, role, overInclude) {
  const { structural, volatile } = condTests(cond, unsupported, ctx);
  let tests;
  if (overInclude && role === 'exclude') {
    if (!structural.length) return () => false;
    tests = structural;
  } else if (overInclude) {
    tests = structural.length ? structural : volatile;
  } else {
    tests = [...structural, ...volatile];
  }
  if (!tests.length) return () => false;
  return (s) => tests.every((t) => t(s));
}

// `filter.template` is a Jinja template that HA renders into the card list, so its entity
// ids only exist after rendering — a structural walk can never see them (issue #4). We can't
// render here (this module is sync and has no HA connection), so the caller pre-renders via
// HA's `render_template` and passes the results in as opts.renderedTemplates. We then scrape
// real entity ids out of the rendered text, which works whether the template returns a list
// of ids or a list of card objects.
export function collectTemplates(config) {
  const out = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.filter?.template === 'string') out.add(node.filter.template);
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v);
  };
  walk(Array.isArray(config?.views) ? config.views : []);
  return [...out];
}

// Groups (and group-expanding cards like enhanced-shutter-card's `show_group_members`) name
// only the group entity in the config; the members live in the group's `entity_id` attribute
// at runtime and appear nowhere in the dashboard (issue #4). Pull them in transitively so a
// group on the allowlist brings its members with it. Bounded in case a group cycles.
//
// A member must be IN THE STATE MACHINE. `isEntityId` is only a shape test, and a group's
// `entity_id` attribute lists members by id whether or not HA is currently serving them — most
// often because the member is DISABLED, and also if it has been removed or renamed. A disabled
// entity is a perfectly valid registry entry; it simply has no state, so HA will never stream
// it and allowlisting it can only ever be dead weight.
//
// Measured on one instance: 87 Hue room/zone groups listed 409 member ids that `get_states`
// does not return, putting 239 of them into a 772-entity allowlist — 31% of it. Checked rather
// than assumed: all 239 were present in the entity registry and all were disabled
// (`disabled_by: device`, the devices disabled by the user) — deliberate curation to control
// entity count, not stale data. Harmless to forward (an entry matching no entity forwards
// nothing), but it makes `allowlist: N entities` wrong by a third, and that is the number
// people tune the `dashboards` option against.
//
// Every other path into the allowlist is already gated on the id being real: the config-text
// scrape in ha_ws_trim_proxy.mjs checks `real.has()`, and the rendered-template scrape below
// checks `ctx.byId.has()`. This was the one that was not.
export function expandGroupMembers(ids, allStates = [], maxDepth = 5) {
  const byId = new Map(allStates.map((s) => [s.entity_id, s]));
  const out = new Set(ids);
  let frontier = [...out];
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const id of frontier) {
      const members = byId.get(id)?.attributes?.entity_id;
      if (!Array.isArray(members)) continue;
      for (const e of members) if (isEntityId(e) && byId.has(e) && !out.has(e)) { out.add(e); next.push(e); }
    }
    frontier = next;
  }
  return out;
}

function expandAutoEntities(node, allStates, add, unsupported, ctx, overInclude) {
  const f = node.filter || {};
  // A rendered template contributes every real entity id in its output.
  if (typeof f.template === 'string') {
    const rendered = ctx.templates?.get(f.template);
    if (rendered == null) unsupported.push('auto-entities filter key: template (not rendered)');
    // Only REAL ids: rendered output can contain incidental dotted words, and a template is
    // free-form text rather than a structured filter.
    else for (const m of String(rendered).matchAll(/[a-z_][a-z0-9_]*\.[a-z0-9_]+/g)) {
      if (ctx.byId.has(m[0])) add(m[0]);
    }
  }
  const inc = Array.isArray(f.include) ? f.include : [];
  const exc = Array.isArray(f.exclude) ? f.exclude : [];
  const excMatchers = exc.map((c) => makeMatcher(c, unsupported, ctx, 'exclude', overInclude));
  for (const cond of inc) {
    // An include entry can be an explicit entity rather than a filter.
    if (cond && isEntityId(cond.entity_id) && !String(cond.entity_id).includes('*')) {
      if (!excMatchers.some((m) => m({ entity_id: cond.entity_id, state: '', attributes: {} }))) add(cond.entity_id);
      continue;
    }
    const match = makeMatcher(cond, unsupported, ctx, 'include', overInclude);
    for (const s of allStates) {
      if (match(s) && !excMatchers.some((m) => m(s))) add(s.entity_id);
    }
  }
}

export function extractEntities(config, allStates = [], opts = {}) {
  const found = new Set();
  const unsupported = [];
  const add = (id) => { if (isEntityId(id)) found.add(id); };
  const ctx = buildRegistryCtx(opts.registries);
  // Live state by id: needed for `group:` membership and to validate ids scraped out of a
  // rendered template. Templates come pre-rendered from the caller (see collectTemplates).
  ctx.byId = new Map(allStates.map((s) => [s.entity_id, s]));
  ctx.templates = opts.renderedTemplates instanceof Map ? opts.renderedTemplates : new Map();
  const overInclude = !!opts.overInclude;

  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;

    // auto-entities (and similar filter cards) need live expansion.
    if (typeof node.type === 'string' && node.type.includes('auto-entities') && node.filter) {
      expandAutoEntities(node, allStates, add, unsupported, ctx, overInclude);
    }

    // Standard entity-bearing keys.
    if (typeof node.entity === 'string') add(node.entity);
    if (typeof node.camera_image === 'string') add(node.camera_image);
    if (typeof node.camera_entity === 'string') add(node.camera_entity);
    if (typeof node.entity_id === 'string') add(node.entity_id);
    else if (Array.isArray(node.entity_id)) node.entity_id.forEach(add);

    if (Array.isArray(node.entities)) {
      for (const it of node.entities) {
        if (typeof it === 'string') add(it);
        // objects fall through to generic recursion below (covers {entity:...},
        // fold-entity-row {head, entities:[...]}, etc.)
      }
    }

    // Generic recursion over every value (covers cards/card/elements/head/stack/badges/…).
    // Skip `filter`: it holds auto-entities match conditions (incl. `exclude`), not
    // entity widgets — recursing would re-add excluded entities.
    for (const [k, v] of Object.entries(node)) {
      if (k === 'filter') continue;
      if (v && typeof v === 'object') walk(v);
    }
  }

  let views = Array.isArray(config?.views) ? config.views : [];
  if (opts.viewPath) views = views.filter((v) => v.path === opts.viewPath);
  views.forEach(walk);

  return { entities: [...found].sort(), unsupported: [...new Set(unsupported)] };
}
