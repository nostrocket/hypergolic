import { build } from 'vite';
import { writeFile } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
// Separate test artifact: never part of the native host delivery directory.
await build({
  configFile: false, root: root.pathname,
  build: {
    outDir: '.test-fixtures/capabilities', emptyOutDir: true, target: 'es2022',
    minify: false, modulePreload: false,
    lib: { entry: new URL('tests/fixtures/capabilities.ts', root).pathname,
      name: 'CapabilityAdapterTest', formats: ['iife'], fileName: () => 'host.js' },
  },
});
await writeFile(new URL('.test-fixtures/capabilities/index.html', root),
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; frame-src 'self' about:; connect-src 'none'"></head><body><script src="./host.js"></script></body></html>`);
