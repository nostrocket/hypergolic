import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const base = new URL('.', import.meta.url);
const [template, css, notices, regular, semibold, bundle] = await Promise.all([
  readFile(new URL('index.template.html', base), 'utf8'),
  readFile(new URL('src/style.css', base), 'utf8'),
  readFile(new URL('THIRD_PARTY_NOTICES.txt', base), 'utf8'),
  readFile(new URL('fonts/Barlow-Regular.woff2', base)),
  readFile(new URL('fonts/Barlow-SemiBold.woff2', base)),
  build({
    absWorkingDir: fileURLToPath(base),
    entryPoints: ['src/main.ts'],
    bundle: true,
    format: 'iife',
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false,
    target: ['es2022', 'safari16', 'chrome108'],
    write: false,
    legalComments: 'inline',
  }),
]);

if (notices.includes('-->')) throw new Error('Third-party notices contain an HTML comment terminator.');
const face = (weight, font) => `@font-face { font-family: Barlow; font-weight: ${weight}; font-display: swap; src: url(data:font/woff2;base64,${font.toString('base64')}) format("woff2"); }`;
const artifact = template.replace('/* CSS */', () => [face(400, regular), face(600, semibold), css].join('\n'))
  .replace('<!-- THIRD_PARTY_NOTICES -->', () => `<!--
${notices.trimEnd()}
-->`)
  .replace('/* JS */', () => bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'));
const bytes = Buffer.from(artifact);
if (bytes.length > 2 * 1024 * 1024) throw new Error('Catalog exceeds the 2 MiB artifact limit.');
await mkdir(new URL('dist/', base), { recursive: true });
await writeFile(new URL('dist/index.html', base), bytes);
process.stdout.write(`dist/index.html  ${bytes.length} bytes  SHA256 ${createHash('sha256').update(bytes).digest('hex')}\n`);
