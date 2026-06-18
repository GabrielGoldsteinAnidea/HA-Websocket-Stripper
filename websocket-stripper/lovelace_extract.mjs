// lovelace_extract.mjs — extract the entity-id allowlist from a Lovelace config.
//
// Walks the card tree collecting entities from the standard keys, and expands
// `auto-entities` filter cards against the live entity list.
//
// extractEntities(config, allStates, {viewPath}) -> { entities:[...], unsupported:[...] }
//   config    : the lovelace dashboard config (from `lovelace/config`)
//   allStates : array of HA state objects [{entity_id, state, attributes}, ...]
//   viewPath  : optional view `path` to restrict extraction to a single view

const ID_RE = /^[a-z_][a-z0-9_]*\.[a-z0-9_]+$/;
export const isEntityId = (s) => typeof s === 'string' && ID_RE.test(s);

function globToRe(glob) {
  // HA auto-entities globs: * matches any run of chars.
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

// One auto-entities filter condition -> predicate over a state object.
function condMatcher(cond, unsupported) {
  const tests = [];
  if (cond.domain != null) {
    const doms = Array.isArray(cond.domain) ? cond.domain : [cond.domain];
    tests.push((s) => doms.includes(s.entity_id.split('.')[0]));
  }
  if (cond.entity_id != null) {
    const re = globToRe(String(cond.entity_id));
    tests.push((s) => re.test(s.entity_id));
  }
  if (cond.state != null) tests.push((s) => s.state === cond.state);
  if (cond.attributes && typeof cond.attributes === 'object') {
    for (const [k, v] of Object.entries(cond.attributes)) {
      tests.push((s) => s.attributes && s.attributes[k] === v);
    }
  }
  // Flag conditions we don't evaluate (area/device/integration/label/etc.)
  for (const k of Object.keys(cond)) {
    if (!['domain', 'entity_id', 'state', 'attributes', 'options', 'type'].includes(k)) {
      unsupported.push('auto-entities filter key: ' + k);
    }
  }
  if (!tests.length) return () => false;
  return (s) => tests.every((t) => t(s));
}

function expandAutoEntities(node, allStates, add, unsupported) {
  const f = node.filter || {};
  const inc = Array.isArray(f.include) ? f.include : [];
  const exc = Array.isArray(f.exclude) ? f.exclude : [];
  const excMatchers = exc.map((c) => condMatcher(c, unsupported));
  for (const cond of inc) {
    // An include entry can be an explicit entity rather than a filter.
    if (cond && isEntityId(cond.entity_id) && !String(cond.entity_id).includes('*')) {
      if (!excMatchers.some((m) => m({ entity_id: cond.entity_id, state: '', attributes: {} }))) add(cond.entity_id);
      continue;
    }
    const match = condMatcher(cond, unsupported);
    for (const s of allStates) {
      if (match(s) && !excMatchers.some((m) => m(s))) add(s.entity_id);
    }
  }
}

export function extractEntities(config, allStates = [], opts = {}) {
  const found = new Set();
  const unsupported = [];
  const add = (id) => { if (isEntityId(id)) found.add(id); };

  function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;

    // auto-entities (and similar filter cards) need live expansion.
    if (typeof node.type === 'string' && node.type.includes('auto-entities') && node.filter) {
      expandAutoEntities(node, allStates, add, unsupported);
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
