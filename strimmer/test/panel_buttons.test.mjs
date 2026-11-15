// Every button in the console says what it does, in words, and has an accessible name.
//
// Source-level on purpose. The console was icon-only until the 2026.11 rework; the failure this
// guards against now is the reverse: a glyph-only button with no name, which renders fine and is
// announced as just "button". Buttons are built in btn() (text) and iconBtn() (glyph + aria-label).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const panel = fs.readFileSync(path.join(DIR, '..', 'panel.html'), 'utf8');
const script = panel.slice(panel.indexOf('<script>'), panel.lastIndexOf('</script>'));
const markup = panel.slice(panel.indexOf('<body'), panel.indexOf('<script>'));

describe('buttons carry text and an accessible name', () => {
  it('has no tooltip machinery left to rot', () => {
    assert.doesNotMatch(script, /data-tip|tipFor|setTip\(/, 'the JS tooltip was removed in the rework');
  });

  it('builds <button> only in btn(), iconBtn() and the accordion/status rows', () => {
    const sites = [...script.matchAll(/h\('button'|createElement\('button'\)/g)].map((m) => {
      const before = script.slice(0, m.index);
      const fn = [...before.matchAll(/function\s+(\w+)/g)].pop();
      return fn ? fn[1] : '?';
    });
    assert.deepEqual(sites.sort(), ['accRow', 'btn', 'iconBtn', 'renderLook'].sort(),
      `a button is being built elsewhere: ${sites.join(', ')} — use btn() or iconBtn()`);
  });

  it('gives iconBtn() an aria-label, and btn() text', () => {
    const icon = script.slice(script.indexOf('function iconBtn('), script.indexOf('function btn('));
    assert.match(icon, /'aria-label': label/);
    const text = script.slice(script.indexOf('function btn('), script.indexOf('// ---- theme'));
    assert.match(text, /b\.append\(label\)/);
  });

  it('never writes text into a button after the fact', () => {
    // The old failure: progress text ("pinning…") assigned over a button's label. It also drops
    // any glyph the button carries.
    const offenders = [...script.matchAll(/\b(btn|b|yes|no|del|add)\.textContent\s*=\s*['`][^'`]/g)]
      .map((m) => script.slice(m.index, script.indexOf('\n', m.index)).trim());
    assert.deepEqual(offenders, [], `text written into a button:\n  ${offenders.join('\n  ')}`);
  });

  it('names every static button: visible text or aria-label', () => {
    const buttons = [...markup.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
    assert.ok(buttons.length >= 10, `expected the header and card buttons, found ${buttons.length}`);
    for (const [, attrs, inner] of buttons) {
      if (/id="status-btn"/.test(attrs)) continue; // empty until renderStatus() sets its label
      const text = inner.replace(/<[^>]+>/g, '').trim();
      assert.ok(text || /aria-label="[^"]+"/.test(attrs), `an unnamed button: <button${attrs}>`);
    }
  });
});
