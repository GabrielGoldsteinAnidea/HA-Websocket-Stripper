// Registry-backed auto-entities resolution — the #4 fix (area/label/device/integration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEntities } from '../lovelace_extract.mjs';
import { STATES, REGISTRIES } from './fixtures.mjs';

const view = (cards) => ({ views: [{ path: 'main', cards }] });
const auto = (filter) => view([{ type: 'custom:auto-entities', card: { type: 'entities' }, filter }]);
const setOf = (filter) => new Set(extractEntities(auto(filter), STATES, { registries: REGISTRIES, overInclude: true }).entities);

test('label filter (the #4 repro: visual-editor object form) resolves to labeled entities', () => {
  // {label: {label: "1st_floor", active_choice: "label"}} — living_room + bedroom carry it.
  const got = setOf({ include: [{ options: {}, label: { label: '1st_floor', active_choice: 'label' } }] });
  assert.deepEqual(got, new Set(['light.living_room', 'light.bedroom']));
});

test('label filter accepts a plain string value and the label id', () => {
  assert.deepEqual(setOf({ include: [{ label: '1st_floor' }] }), new Set(['light.living_room', 'light.bedroom']));
  assert.deepEqual(setOf({ include: [{ label: 'lbl_1st' }] }), new Set(['light.living_room', 'light.bedroom']));
});

test('area filter resolves by area name and area id', () => {
  // living_room area: light.living_room (explicit) + sensor.temperature (via its device).
  assert.deepEqual(setOf({ include: [{ area: 'Living Room' }] }), new Set(['light.living_room', 'sensor.temperature']));
  assert.deepEqual(setOf({ include: [{ area: 'living_room' }] }), new Set(['light.living_room', 'sensor.temperature']));
});

test('area is inherited from the entity device when the entity has no explicit area', () => {
  // light.kitchen has no area_id but its device dev_kitchen_light is in the kitchen area.
  assert.deepEqual(setOf({ include: [{ area: 'kitchen' }] }), new Set(['light.kitchen']));
});

test('integration filter resolves by platform', () => {
  assert.deepEqual(setOf({ include: [{ integration: 'esphome' }] }), new Set(['switch.fan']));
  assert.deepEqual(setOf({ include: [{ integration: 'hue' }] }), new Set(['light.living_room', 'light.kitchen', 'light.bedroom']));
});

test('device filter resolves by device id', () => {
  assert.deepEqual(setOf({ include: [{ device: 'dev_thermo' }] }), new Set(['sensor.temperature']));
});

test('exclude by area removes structural matches', () => {
  const got = setOf({ include: [{ integration: 'hue' }], exclude: [{ area: 'kitchen' }] });
  assert.ok(got.has('light.living_room'));
  assert.ok(!got.has('light.kitchen'));   // excluded by area
});

test('label + state together: overInclude keeps the label set regardless of state', () => {
  // include entities labeled 1st_floor AND currently on -> overInclude drops the state test.
  const got = setOf({ include: [{ label: '1st_floor', state: 'on' }] });
  assert.deepEqual(got, new Set(['light.living_room', 'light.bedroom']));   // bedroom on, living_room on; state ignored anyway
});

test('unresolvable filters (no registry) yield nothing but do not throw', () => {
  const res = extractEntities(auto({ include: [{ area: 'Living Room' }] }), STATES, { overInclude: true });
  assert.deepEqual(res.entities, []);
});

// A card configured with a DEVICE rather than with entities.
//
// Found on a live instance: `custom:ha-bambulab-print_status-card` carries
// `printer: <device id>` and looks up that device's entities itself, in the browser. Nothing in
// the card config is an entity_id, so the structural walk found none and the dashboard resolved
// to just its two lights — the printer's 57 entities were stripped and the card rendered empty.
// That reads as a broken card, not as a trimming problem, which is what makes it worth a test.
const DEV = '43f1e9fddd670256ced58c9fe7971e41';
const DEV_REGS = {
  areas: [], labels: [],
  devices: [{ id: DEV, name: 'H2S_0938AC572400463' }],
  entities: [
    { entity_id: 'sensor.printer_print_status', device_id: DEV, platform: 'bambu_lab' },
    { entity_id: 'sensor.printer_print_progress', device_id: DEV, platform: 'bambu_lab' },
    { entity_id: 'camera.printer_camera', device_id: DEV, platform: 'bambu_lab' },
    { entity_id: 'light.unrelated', device_id: 'a'.repeat(32), platform: 'hue' },
    // Disabled in the registry: HA never streams it, so a device expansion must skip it.
    { entity_id: 'sensor.printer_disabled_diag', device_id: DEV, platform: 'bambu_lab', disabled_by: 'user' },
  ],
};
const devSetOf = (cards) => new Set(
  extractEntities(view(cards), [], { registries: DEV_REGS }).entities,
);

test('a card naming a device pulls in that device entities', () => {
  const got = devSetOf([{ type: 'custom:ha-bambulab-print_status-card', printer: DEV, style: 'simple' }]);
  assert.deepEqual(got, new Set([
    'sensor.printer_print_status', 'sensor.printer_print_progress', 'camera.printer_camera',
  ]));
});

test('the device key name is not assumed — any key holding a real device id counts', () => {
  // `printer` here, `device` elsewhere, something else in the next card. Matching on the VALUE
  // being a registered device is what makes this work for cards nobody has seen yet.
  for (const key of ['printer', 'device', 'device_id', 'target_device']) {
    assert.ok(devSetOf([{ type: 'custom:whatever', [key]: DEV }]).has('sensor.printer_print_status'),
      `key ${key} should resolve`);
  }
});

test('a list of device ids resolves too', () => {
  const got = devSetOf([{ type: 'custom:multi', devices: [DEV] }]);
  assert.ok(got.has('camera.printer_camera'));
});

test('a device id nested in a stack resolves via the normal walk', () => {
  const got = devSetOf([{ type: 'vertical-stack', cards: [{ type: 'custom:x', printer: DEV }] }]);
  assert.ok(got.has('sensor.printer_print_status'));
});

test('a disabled entity is not pulled in through its device', () => {
  const got = devSetOf([{ type: 'custom:ha-bambulab-print_status-card', printer: DEV }]);
  assert.ok(!got.has('sensor.printer_disabled_diag'), 'disabled entities can never be streamed');
  assert.ok(got.has('sensor.printer_print_status'), 'the enabled ones still are');
});

test('a 32-hex string that is NOT a registered device adds nothing', () => {
  // Shape alone must never be enough — it has to exist in the registry.
  const got = devSetOf([{ type: 'custom:x', printer: 'f'.repeat(32) }]);
  assert.deepEqual(got, new Set());
});

test('device resolution does not drag in entities of other devices', () => {
  const got = devSetOf([{ type: 'custom:x', printer: DEV }]);
  assert.ok(!got.has('light.unrelated'), 'only the named device expands');
});
