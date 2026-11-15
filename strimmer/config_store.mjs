// Configuration the panel owns, kept beside Supervisor's own options.
//
// The add-on's options have outgrown what a Supervisor schema can express. Nested groups do not
// render in the Configuration tab at all (measured: Supervisor parses a documented depth-2 dict,
// registers its translation, and the frontend draws nothing), sub-options cannot carry
// descriptions, and there is no validation beyond types — no "this rule matches none of your
// dashboards", no preview, no conditional fields. Everything behavioural is heading for the
// panel, which has none of those limits and, unlike a YAML file, knows what is connected right
// now.
//
// PER-KEY OWNERSHIP, not a wholesale takeover. This file records only the keys the panel has
// actually been used to change. Everything else falls through to `/data/options.json` exactly as
// before. That matters for two reasons:
//
//   * Nothing is stranded. Ship this before the panel can edit a given option and that option
//     still comes from YAML, still renders in the Configuration tab, still works.
//   * Nothing is silently ignored. The failure mode of a wholesale switch is a user editing the
//     Configuration tab and watching it do nothing, with no indication why. Here, an option is
//     owned here only because someone deliberately changed it here.
//
// A key adopted here is SEEDED from its YAML value, so taking ownership never changes behaviour
// on its own — the first save writes what was already in effect.
//
// BOOTSTRAP KEYS ARE NEVER ADOPTED. How the process binds and finds Home Assistant has to be
// answerable before any of this is readable, and has to stay fixable from the Configuration tab
// when the panel is the thing that is broken.

import fs from 'node:fs';
import path from 'node:path';

export const STORE_VERSION = 1;

// Setup, not functionality. These stay in add-on options forever.
// Both spellings of each port, deliberately: the rename to proxy_port/mgmt_port would otherwise
// leave the canonical names adoptable while only the legacy aliases were protected — and adopting
// the port the console is served on is the one change that can make the console unreachable.
export const BOOTSTRAP_KEYS = new Set([
  'log_level', 'proxy_port', 'port', 'mgmt_port', 'stats_port', 'ha_base', 'allow_ws_url',
  // How the ESPHome listener binds and how Home Assistant authenticates to it. Same class as the
  // ports above: a listener's address and key belong where they can be fixed from Home Assistant
  // when this console is what is broken.
  'esphome_port', 'esphome_key',
]);

// Options a past version had and this one does not.
//
// They stay in config.yaml's schema so an existing configuration survives an update — Supervisor
// refuses a key its schema does not know, and an upgrade must not require editing the config
// first — but nothing reads them, and the console does not offer a switch that would do nothing.
// The add-on says so once at boot when one is still set.
export const REMOVED_KEYS = new Map([
  ['mqtt_sensors', 'metrics moved to the ESPHome API (esphome_api) in 2026.09.25.3'],
]);

// Old name -> the name that replaced it.
//
// Each old name is still READ, so an existing config keeps working, but none of them gets a row in
// the console: listing both spellings showed two rows for one setting, with the value on whichever
// row the config happened to use and nothing on the other. The mapping matters as well as the
// membership — a config still using the old spelling has nothing stored under the new one, so the
// canonical row reads through this to show the value actually in effect.
//
// They stay in the schema deliberately. Removing a key from the schema makes Supervisor discard
// it on upgrade, silently, which would cost someone a setting they had deliberately changed.
export const LEGACY_ALIASES = {
  port: 'proxy_port',
  stats_port: 'mgmt_port',
  strip_entities: 'trim_entities',
  per_dashboard: 'by_dashboard',
};

export const LEGACY_KEYS = new Set(Object.keys(LEGACY_ALIASES));

// The old spelling for a canonical key, if it has one.
export function legacyNameFor(key) {
  return Object.keys(LEGACY_ALIASES).find((old) => LEGACY_ALIASES[old] === key);
}

// Every option the console may take over, and what shape it is.
//
// This is declared rather than derived from whatever happens to be in /data/options.json, because
// an option nobody has set yet is exactly the one someone came to the console to set. Deriving
// the list from the options file shows only settings that already exist, so a default-valued
// option is invisible — the console would appear to be missing the very toggle being looked for.
//
// Kept honest by a test that compares it against config.yaml's schema, the same way the stats
// options block is pinned: a new option added to the schema and not listed here fails the suite.
//
// `objects` are the list-of-dicts options, which get a purpose-built editor rather than a text
// box — nobody should be hand-writing JSON into a form field to add an override.
//
// Each option also declares the section it belongs in and a short label. An alphabetical list of
// twenty-four raw option names is a reference, not a control panel: "is it trimming themes" meant
// scanning for `trim_themes` among `mdns_services` and `cert_monitor_host`. Grouped, the trim
// switches sit together and read as one decision with nine parts.
//
// The labels are deliberately NOT the add-on translations. Those carry several sentences of
// warning each, which is right for a page you read once while setting up and wrong for a row you
// scan. The long text stays in translations/en.yaml.
export const SECTIONS = [
  { id: 'trim', title: 'Trimming', blurb: 'What gets cut out of each connection. This is what the app is for.' },
  { id: 'entities', title: 'Dashboards and entities', blurb: 'Which dashboards are served, and entities to force in or out regardless of what a dashboard references.' },
  { id: 'resources', title: 'Custom cards', blurb: 'Lovelace resources to force in or out. Needed for anything that runs on load rather than rendering a card.' },
  { id: 'overrides', title: 'Overrides', blurb: 'Rules that apply to one dashboard, user or device instead of everywhere.' },
  { id: 'discovery', title: 'Device discovery', blurb: 'Ask the network what each connecting device is, so the Clients tab can name it.' },
  { id: 'monitoring', title: 'Monitoring', blurb: 'Long-term metrics and checks, published back into Home Assistant.' },
  { id: 'websocket', title: 'Websocket', blurb: 'How the browser connection itself is handled.' },
  { id: 'client_api', title: 'Panel status API', blurb: 'Who may ask this app what it is doing, at /strimmer/client.json on the proxy port.' },
];

// Every option this build knows about: its type, which section it belongs to, and how it is
// labelled.
//
// A boolean also carries `short` and `icon`, because the console draws booleans as a grid of
// tiles rather than a column of switches — nine switch rows read as a form to work through, nine
// tiles read as a state you can take in at a glance, which is what a settings screen is for. The
// tile caption has room for about one word, so `short` is that word and `label` stays the full
// sentence for the tooltip. `icon` is an MDI name; the panel owns the path, the way Home Assistant
// passes `mdi:x` around rather than geometry.
export const OPTIONS = {
  // Trimming
  trim_entities: { type: 'bool', section: 'trim', label: 'Entity websocket', short: 'Entities', icon: 'transit-connection-variant' },
  by_dashboard: { type: 'bool', section: 'trim', label: 'Only the dashboard being viewed', short: 'By dashboard', icon: 'view-dashboard-outline' },
  trim_registries: { type: 'bool', section: 'trim', label: 'Entity, device and area registries', short: 'Registries', icon: 'card-account-details-outline' },
  trim_resources: { type: 'bool', section: 'trim', label: 'Custom cards', short: 'Custom cards', icon: 'puzzle-outline' },
  trim_extra_modules: { type: 'bool', section: 'trim', label: 'Modules injected into the page', short: 'Injected JS', icon: 'script-text-outline' },
  trim_services: { type: 'bool', section: 'trim', label: 'Service list', short: 'Services', icon: 'cog-transfer-outline' },
  trim_repairs: { type: 'bool', section: 'trim', label: 'Repairs backlog', short: 'Repairs', icon: 'wrench-outline' },
  trim_themes: { type: 'bool', section: 'trim', label: 'Themes', short: 'Themes', icon: 'palette-outline' },
  trim_translations: { type: 'bool', section: 'trim', label: 'Frontend translations', short: 'Translations', icon: 'translate' },

  // Dashboards and entities
  dashboards: { type: 'list', section: 'entities', label: 'Dashboards to serve' },
  always_forward: { type: 'list', section: 'entities', label: 'Always forward these entities' },
  always_forward_device_class: { type: 'list', section: 'entities', label: 'Always forward these device classes' },
  never_forward: { type: 'list', section: 'entities', label: 'Never forward these entities' },
  exclude_device_categories: { type: 'list', section: 'entities', label: 'Drop these entity categories' },

  // Custom cards
  resources_always_forward: { type: 'list', section: 'resources', label: 'Always send these resources' },
  resources_never_forward: { type: 'list', section: 'resources', label: 'Never send these resources' },

  // Overrides
  overrides: { type: 'objects', section: 'overrides', label: 'Override rules' },
  dashboard_overrides: { type: 'objects', section: 'overrides', label: 'Per-dashboard rules' },
  user_overrides: { type: 'objects', section: 'overrides', label: 'Per-user rules' },
  client_overrides: { type: 'objects', section: 'overrides', label: 'Per-device rules' },
  user_agent_dashboards: { type: 'objects', section: 'overrides', label: 'Dashboard by client app' },

  // Discovery
  mdns_discovery: { type: 'bool', section: 'discovery', label: 'Identify devices via mDNS', short: 'mDNS', icon: 'access-point-network' },
  // `emptyMeans` is what an EMPTY list actually does. For most options empty means empty, but
  // here it means "use the built-in set" — and an empty row reads as "nothing is being looked
  // for", which is the opposite of the truth.
  mdns_services: { type: 'list', section: 'discovery', label: 'mDNS service types to look for',
    emptyMeans: 'the built-in set' },

  // Monitoring
  esphome_api: { type: 'bool', section: 'monitoring', label: 'Publish metrics over the ESPHome API', short: 'ESPHome', icon: 'chip' },
  cert_monitor_host: { type: 'str', section: 'monitoring', label: 'Certificate to watch' },

  // Websocket
  compress_websocket: { type: 'bool', section: 'websocket', label: 'Compress the websocket', short: 'Compression', icon: 'zip-box-outline' },

  // Panel status API
  client_api_access: {
    type: 'choice', section: 'client_api', label: 'Answer requests from',
    choices: [
      { value: 'lan', label: 'Local network only' },
      { value: 'any', label: 'Anywhere (token still required)' },
      { value: 'off', label: 'Nobody — endpoint disabled' },
    ],
  },
  client_api_allow: { type: 'list', section: 'client_api', label: 'Always allow these addresses',
    emptyMeans: 'no extra addresses' },
};

// The shape the rest of the code already expects: key -> type.
export const EDITABLE_KEYS = Object.fromEntries(
  Object.entries(OPTIONS).map(([k, o]) => [k, o.type]),
);

// Is `key` an option this build declares? An OWN-property test, deliberately: EDITABLE_KEYS is a
// plain object, so `EDITABLE_KEYS['constructor']` and `['toString']` are truthy, and the console's
// "is this a known option" guard waved them through.
export const isKnownOption = (key) => typeof key === 'string' && Object.hasOwn(EDITABLE_KEYS, key);

// Why `value` cannot be stored for `key`, or null when it can. Checked when the console writes, so
// a wrong type is refused with a reason instead of being reported saved and misread at the next
// boot. `undefined` is allowed: adopt() reads it as "take over the value already in effect".
export function valueError(key, value) {
  if (value === undefined) return null;
  const opt = OPTIONS[key];
  if (!opt || !Object.hasOwn(OPTIONS, key)) return 'is not an option this version knows about';
  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  switch (opt.type) {
    case 'bool': return typeof value === 'boolean' ? null : 'must be true or false';
    case 'str': return typeof value === 'string' ? null : 'must be text';
    case 'list': return Array.isArray(value) && value.every((v) => typeof v === 'string') ? null : 'must be a list of text';
    case 'objects': return Array.isArray(value) && value.every(isPlainObject) ? null : 'must be a list of rules';
    case 'choice': return (opt.choices || []).some((c) => c.value === value)
      ? null : `must be one of: ${(opt.choices || []).map((c) => c.value).join(', ')}`;
    default: return null;
  }
}

const emptyStore = () => ({ version: STORE_VERSION, managed: {}, history: [] });

export function storePath(dataDir) {
  return path.join(dataDir, 'config.json');
}

// Read the panel-owned config. A missing file is the normal first-run state, not an error; an
// unreadable or malformed one must NOT take the add-on down, because then a bad write here would
// cost you the proxy as well as the panel. Either way the answer is "own nothing", which falls
// through to the add-on options that were working before this file existed.
export function readStore(dataDir, onWarn = () => {}) {
  if (!dataDir) return emptyStore();
  const p = storePath(dataDir);
  try {
    if (!fs.existsSync(p)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || typeof raw.managed !== 'object' || raw.managed === null) {
      onWarn(`${p} is not a config store — ignoring it and using add-on options`);
      return emptyStore();
    }
    // A store written by a NEWER version may use keys this build does not understand. Ignoring it
    // wholesale is safer than half-applying it, and a downgrade is the one time that can happen.
    if (Number(raw.version) > STORE_VERSION) {
      onWarn(`${p} was written by a newer version (${raw.version} > ${STORE_VERSION}) — using add-on options instead`);
      return emptyStore();
    }
    const managed = {};
    for (const [k, v] of Object.entries(raw.managed)) {
      if (BOOTSTRAP_KEYS.has(k)) {
        onWarn(`ignoring managed "${k}": setup options are always read from add-on options`);
        continue;
      }
      // `managed[k] = v` with k === "__proto__" does not add a key, it REPLACES THE PROTOTYPE —
      // after which `'trim_entities' in managed` is true for a store that manages nothing. Only
      // that one name is refused: an option this build does not recognise is deliberately kept,
      // so a downgrade shows it in the console rather than silently dropping it.
      if (k === '__proto__') {
        onWarn('ignoring managed "__proto__": not an option');
        continue;
      }
      managed[k] = v;
    }
    // An array or nothing. `raw.history || []` accepted `{}`, and adopt() spreads it — so one odd
    // file made every later save from the console fail with "not iterable".
    return { version: Number(raw.version) || STORE_VERSION, managed,
      history: Array.isArray(raw.history) ? raw.history : [] };
  } catch (e) {
    onWarn(`could not read ${p} (${e.message}) — using add-on options`);
    return emptyStore();
  }
}

// Whole-file rewrite through a temp file and rename, so a crash mid-write cannot leave a
// half-written config that fails to parse on the next boot. Same approach as history.mjs, and for
// the same reason: this file is read once at startup and a corrupt one is expensive.
export function writeStore(dataDir, store) {
  const p = storePath(dataDir);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
  return p;
}

// Adopt one key, seeded from whatever is in effect today when no value is supplied. Seeding is
// what makes adoption safe: taking ownership of an option must not change what it does.
export function adopt(store, key, value, yamlOptions = {}) {
  if (BOOTSTRAP_KEYS.has(key)) {
    throw new Error(`"${key}" is a setup option and is always read from add-on options`);
  }
  const next = { ...store, managed: { ...store.managed, [key]: value !== undefined ? value : yamlOptions[key] } };
  next.history = [...(store.history || []), { at: new Date().toISOString(), key, action: 'adopt' }].slice(-50);
  return next;
}

// Hand a key back to add-on options. The escape hatch: whatever the panel did, the Configuration
// tab can always be made authoritative again.
export function release(store, key) {
  const managed = { ...store.managed };
  delete managed[key];
  return {
    ...store,
    managed,
    history: [...(store.history || []), { at: new Date().toISOString(), key, action: 'release' }].slice(-50),
  };
}

// What the rest of the add-on reads. Panel-owned keys win; everything else is the add-on option.
// Bootstrap keys can never be shadowed, which readStore already enforces — this is belt and
// braces for a store handed in directly by a test or a future caller.
export function effectiveOptions(yamlOptions = {}, store = emptyStore()) {
  const out = { ...yamlOptions };
  for (const [k, v] of Object.entries(store.managed || {})) {
    if (BOOTSTRAP_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

// Which keys each source is answering for, so the panel and the log can say so plainly rather
// than leaving someone to guess why the Configuration tab appears to do nothing.
export function ownership(yamlOptions = {}, store = emptyStore()) {
  const managed = Object.keys(store.managed || {}).filter((k) => !BOOTSTRAP_KEYS.has(k)).sort();
  const fromYaml = Object.keys(yamlOptions).filter((k) => !managed.includes(k)).sort();
  return { managed, fromYaml };
}
