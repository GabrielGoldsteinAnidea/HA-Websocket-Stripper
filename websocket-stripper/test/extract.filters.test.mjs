// Filter-form coverage for the allowlist extractor: the auto-entities matcher (globs,
// regexes, exact), HA's editor object form, name/group keys, rendered templates, and group
// membership. Each case here failed before 0.2.3 — see issues #4 and #10.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities, collectTemplates, expandGroupMembers, toMatcher, looksCatastrophic } from '../lovelace_extract.mjs';
import { STATES, REGISTRIES } from './fixtures.mjs';

// Allowlist mode: this is exactly how ha_ws_trim_proxy.mjs calls the extractor.
const run = (filter, opts = {}) => extractEntities(
  { views: [{ cards: [{ type: 'custom:auto-entities', filter }] }] },
  STATES,
  { registries: REGISTRIES, overInclude: true, ...opts },
).entities;

const inc = (...conds) => ({ include: conds });

describe('auto-entities matcher (issue #10)', () => {
  test('an anchored regex resolves, and stays anchored', () => {
    // The reported pattern. sensor.pv_total_energy must NOT match: it fails the _power anchor.
    assert.deepEqual(run(inc({ entity_id: '/^sensor\\.pv_.*_power$/' })),
      ['sensor.pv_roof_power', 'sensor.pv_shed_power']);
  });

  test('a regex is NOT auto-anchored — upstream leaves that to the author', () => {
    assert.deepEqual(run(inc({ entity_id: '/pv_/' })),
      ['sensor.pv_roof_power', 'sensor.pv_shed_power', 'sensor.pv_total_energy']);
  });

  test('globs keep their old anchored behaviour', () => {
    assert.deepEqual(run(inc({ entity_id: 'sensor.pv_*' })),
      ['sensor.pv_roof_power', 'sensor.pv_shed_power', 'sensor.pv_total_energy']);
    // A glob is anchored, so a bare infix must not match.
    assert.deepEqual(run(inc({ entity_id: 'pv_*' })), []);
  });

  test('an exact id is still an exact id', () => {
    assert.deepEqual(run(inc({ entity_id: 'switch.fan' })), ['switch.fan']);
  });

  test('an unparseable regex contributes nothing instead of throwing', () => {
    assert.deepEqual(run(inc({ entity_id: '/[unclosed/' })), []);
  });

  test('regexes work on registry-backed keys too, not just entity_id', () => {
    // Every filter key runs through the same matcher upstream.
    assert.deepEqual(run(inc({ label: '/^1st_/' })), ['light.bedroom', 'light.living_room']);
    assert.deepEqual(run(inc({ domain: '/^bin/' })), ['binary_sensor.back_door', 'binary_sensor.front_door']);
  });

  test('toMatcher ORs the regex against exact equality, as upstream does', () => {
    const m = toMatcher('/^a/');
    assert.equal(m('abc'), true);
    assert.equal(m('/^a/'), true);      // the literal pattern still matches itself
    assert.equal(m('zzz'), false);
    assert.equal(toMatcher('plain')(undefined), false);
  });
});

describe("HA selector's object form (issue #4)", () => {
  test('entity_id given as {custom, active_choice} resolves', () => {
    // Previously String({...}) === "[object Object]" and matched nothing.
    assert.deepEqual(
      run(inc({ entity_id: { custom: 'sensor.pv_*_power', active_choice: 'custom' } })),
      ['sensor.pv_roof_power', 'sensor.pv_shed_power'],
    );
  });

  test('domain given in the object form resolves', () => {
    assert.deepEqual(run(inc({ domain: { custom: 'camera', active_choice: 'custom' } })), ['camera.front']);
  });

  test('active_choice picks the right key when several are present', () => {
    assert.deepEqual(
      run(inc({ label: { label: '1st_floor', area: 'kitchen', active_choice: 'label' } })),
      ['light.bedroom', 'light.living_room'],
    );
  });
});

describe('name and group filter keys', () => {
  test('name matches friendly_name through the matcher', () => {
    assert.deepEqual(run(inc({ name: '/^PV .* Power$/' })),
      ['sensor.pv_roof_power', 'sensor.pv_shed_power']);
  });

  test('group resolves to the group members', () => {
    assert.deepEqual(run(inc({ group: 'cover.shade_group' })),
      ['cover.shade_left', 'cover.shade_right']);
  });

  test('a name filter does not degrade into forwarding the whole instance', () => {
    // `name` is structural, so over-include mode must not fall back to matching everything.
    assert.deepEqual(run(inc({ name: 'nothing matches this' })), []);
  });
});

describe('rendered template filters (issue #4)', () => {
  const cfg = { views: [{ cards: [{ type: 'custom:auto-entities', filter: { template: 'TPL' } }] }] };

  test('collectTemplates finds the template to render', () => {
    assert.deepEqual(collectTemplates(cfg), ['TPL']);
  });

  test('entity ids are scraped out of the rendered output', () => {
    const rendered = new Map([['TPL', "[{'entity': 'light.bedroom'}, {'entity': 'switch.fan'}]"]]);
    const got = extractEntities(cfg, STATES, { registries: REGISTRIES, overInclude: true, renderedTemplates: rendered });
    assert.deepEqual(got.entities, ['light.bedroom', 'switch.fan']);
  });

  test('only REAL ids are taken — rendered text is free-form', () => {
    const rendered = new Map([['TPL', "light.bedroom and not.a_real_entity and foo.bar"]]);
    const got = extractEntities(cfg, STATES, { registries: REGISTRIES, overInclude: true, renderedTemplates: rendered });
    assert.deepEqual(got.entities, ['light.bedroom']);
  });

  test('an unrendered template is reported as unsupported rather than silently empty', () => {
    const got = extractEntities(cfg, STATES, { registries: REGISTRIES, overInclude: true });
    assert.deepEqual(got.entities, []);
    assert.ok(got.unsupported.some((u) => u.includes('template')), got.unsupported);
  });
});

describe('group membership expansion (issue #4)', () => {
  test('a group brings its members with it', () => {
    assert.deepEqual([...expandGroupMembers(['cover.shade_group'], STATES)].sort(),
      ['cover.shade_group', 'cover.shade_left', 'cover.shade_right']);
  });

  test('non-group entities are untouched', () => {
    assert.deepEqual([...expandGroupMembers(['switch.fan'], STATES)], ['switch.fan']);
  });

  test('a cyclic group terminates instead of hanging', () => {
    const cyclic = [
      { entity_id: 'group.a', state: 'on', attributes: { entity_id: ['group.b'] } },
      { entity_id: 'group.b', state: 'on', attributes: { entity_id: ['group.a', 'light.kitchen'] } },
      { entity_id: 'light.kitchen', state: 'on', attributes: {} },
    ];
    assert.deepEqual([...expandGroupMembers(['group.a'], cyclic)].sort(),
      ['group.a', 'group.b', 'light.kitchen']);
  });
});

// A dashboard author's regex runs here against every entity on the instance, on the event loop
// every panel's websocket shares. In the card it would hang one browser tab; here, every panel.
describe('a dashboard regex cannot stall the event loop', () => {
  test('flags a nested quantifier and leaves ordinary patterns alone', () => {
    for (const bad of ['^(a+)+$', '^(\\w+\\s?)+$', '(x{2,})+']) assert.ok(looksCatastrophic(bad), bad);
    // An overlapping alternation under a quantifier is the worse class: /^(a|a)+$/ measured 5.4s
    // on 27 characters, against 12.3s for (a+)+ on 40.
    for (const bad of ['^(a|a)+$', '^(a|ab)*$', '^(\\d|\\d\\d)+$']) assert.ok(looksCatastrophic(bad), bad);
    for (const ok of ['^sensor\\.pv_.*_power$', '^[+*]+$', 'battery$', '^light\\.(kitchen|hall)$']) {
      assert.ok(!looksCatastrophic(ok), ok);
    }
    // (ab|cd)+ cannot backtrack badly but IS flagged: the detector is deliberately loose, and
    // flagging only costs the guarded path — it never costs a match.
    assert.ok(looksCatastrophic('(ab|cd)+'));
    assert.equal(toMatcher('/^(ab|cd)+$/')('abcdab'), true, 'and it still matches');
  });

  test('a catastrophic pattern is cut off, switched off, and reported — once', () => {
    const notes = [];
    const m = toMatcher('/^(b+)+$/', (n) => notes.push(n));
    let t = Date.now();
    assert.equal(m(`${'b'.repeat(40)}!`), false);
    assert.ok(Date.now() - t < 2000, 'bounded by the deadline, not by the backtracking');
    t = Date.now();
    assert.equal(m(`${'b'.repeat(41)}!`), false);
    assert.ok(Date.now() - t < 50, 'a disabled pattern costs nothing afterwards');
    assert.ok(notes.some((n) => /disabled/.test(n)), notes);
  });

  test('a nested quantifier that behaves is still honoured', () => {
    const m = toMatcher('/^(ab+)+$/');
    assert.equal(m('abbabb'), true);
    assert.equal(m('xyz'), false);
  });

  test('the guard reports through unsupported, so a blank card has an explanation', () => {
    const states = [{ entity_id: 'sensor.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_x', state: 'on', attributes: {} }];
    const got = extractEntities(
      { views: [{ cards: [{ type: 'custom:auto-entities', filter: { include: [{ entity_id: '/^sensor\\.(a+)+$/' }] } }] }] },
      states, { overInclude: true });
    assert.deepEqual(got.entities, []);
    assert.ok(got.unsupported.some((u) => /disabled/.test(u)), got.unsupported);
  });
});
