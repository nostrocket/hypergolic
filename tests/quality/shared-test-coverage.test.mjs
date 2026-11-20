import assert from 'node:assert/strict';
import {globSync, readFileSync} from 'node:fs';
import test from 'node:test';

test('every shared TypeScript test is run by a CI suite', () => {
  const {scripts} = JSON.parse(readFileSync('package.json', 'utf8'));
  const workflow = readFileSync('.github/workflows/check.yml', 'utf8');
  const covered = new Set();
  for (const [, name] of workflow.matchAll(/^\s*pnpm run (test:[\w:-]+)\s*$/gm)) {
    for (const pattern of scripts[name].split(/\s+/).filter(word => word.endsWith('.test.ts'))) {
      for (const file of globSync(pattern)) covered.add(file);
    }
  }
  const shared = globSync(['tests/**/*.test.ts', 'src/**/*.test.ts'], {exclude: ['tests/native/**']});
  assert.deepEqual(shared.filter(file => !covered.has(file)), []);
});
