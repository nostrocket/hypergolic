import { build } from 'vite';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const output = new URL('.test-fixtures/mesh-native/', root);
// Test-only bundles exercise the real adapter and published loader, without a
// native host, signing key, paired peer or bundled development publication.
for (const [entry, filename] of [['tests/fixtures/mesh-native.ts', 'adapter.js'], ['src/main.ts', 'main.js']]) {
  await build({
    configFile: false, root: fileURLToPath(root),
    define: { __BUNDLED_FIXTURES__: '{}', __UX_HTML__: '""', __UX_SHA256__: '""', __UX_AGGREGATE__: '""' },
    build: {
      outDir: fileURLToPath(output), emptyOutDir: filename === 'adapter.js', target: 'es2022',
      minify: false, modulePreload: false,
      lib: { entry: fileURLToPath(new URL(entry, root)), name: 'OwnedMeshBundle', formats: ['iife'], fileName: () => filename },
    },
  });
}
await writeFile(new URL('parent.html', output),
  '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="./adapter.js"></script></body></html>');
await writeFile(new URL('main.html', output),
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; frame-src 'self'; child-src 'self'; media-src blob:; object-src 'none'; base-uri 'none'"><script src="./main.js" defer></script></head><body></body></html>`);
