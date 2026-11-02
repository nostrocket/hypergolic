import assert from 'node:assert/strict';
import test from 'node:test';
import { darkPalette, lightPalette, shellPalette } from './palette.ts';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}
function contrast(a: string, b: string) {
  const light = luminance(a), dark = luminance(b);
  return (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05);
}

for (const [name, palette] of Object.entries({ dark: darkPalette, light: lightPalette })) {
  test(`${name}: body, secondary and orange text meet normal-text contrast on opaque surfaces`, () => {
    for (const ink of [palette.text, palette.muted, palette.accent]) {
      for (const surface of [palette.background, palette.surface, palette.raised]) {
        assert.ok(contrast(ink, surface) >= 4.5, `${ink} on ${surface}: ${contrast(ink, surface)}`);
      }
    }
    assert.ok(contrast(palette.onPrimary, palette.primary) >= 4.5);
    assert.ok(contrast(palette.onAccent, palette.accent) >= 4.5);
  });
}
test('system light appearance uses the light palette, unknown appearances use dark', () => {
  assert.equal(shellPalette('light'), lightPalette);
  for (const scheme of ['dark', null, undefined, 'unspecified']) assert.equal(shellPalette(scheme), darkPalette);
});
