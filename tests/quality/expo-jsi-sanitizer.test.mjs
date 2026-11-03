import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const root = createRequire(new URL('../../package.json', import.meta.url));
const expo = createRequire(root.resolve('expo/package.json'));
const core = createRequire(expo.resolve('expo-modules-core/package.json'));
const file = path.join(path.dirname(core.resolve('expo-modules-jsi/package.json')), 'apple/scripts/build-xcframework.sh');
const script = readFileSync(file, 'utf8').match(/sed -E '([^']+)' "\$swiftinterface"/);
assert(script, 'Reviewed upstream JSI sanitizer command must exist');
function sanitize(input) {
  const result = spawnSync('sed', ['-E', script[1]], { input, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
for (const spelling of ['__ObjC.Internal', '__ObjC::Internal']) {
  test(`upstream sanitizer removes internal ${spelling} extension while preserving public APIs`, () => {
    assert.equal(sanitize(`public struct Public {}\nextension ${spelling} {\n  public func hidden()\n}\npublic func remaining()\n`), 'public struct Public {}\npublic func remaining()\n');
  });
}
test('upstream sanitizer removes unusable constraint attributes without dropping adjacent public API', () => {
  const input = '@usableFromInline\ninternal typealias _ConstraintThatIsNotPartOfTheAPIOfThisLibrary = Int\n@available(*, unavailable)\nextension _ConstraintThatIsNotPartOfTheAPIOfThisLibrary {}\npublic struct Public {}\n';
  assert.equal(sanitize(input), 'public struct Public {}\n');
});
