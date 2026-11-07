import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';

const require = createRequire(new URL('../../tools/quality/package.json', import.meta.url));
const entry = require.resolve('aislop');
for (const mode of ['cli', 'api']) test(`installed aislop ${mode} distinguishes C directives from comments`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hypergolic-aislop-preprocessor-'));
  try {
    await mkdir(path.join(root, '.aislop'));
    await writeFile(path.join(root, '.aislop/config.yml'), 'telemetry:\n  enabled: false\n');
    for (const extension of ['c', 'h', 'cpp', 'hpp']) {
      await writeFile(path.join(root, `limits.${extension}`), '#define HG_MESH_PAIRING_BYTES 276u\nint size(void);\n');
      await writeFile(path.join(root, `comments.${extension}`), '// Initialize counter\nint counter = 0;\n');
    }
    await writeFile(path.join(root, 'comments.py'), '# Define counter\ncounter = 0\n');
    await writeFile(path.join(root, 'comments.js'), '// Initialize counter\nconst counter = 0;\n');
    const args = mode === 'cli'
      ? [path.join(path.dirname(entry), 'cli.js'), 'scan', root, '--json']
      : ['--input-type=module', '-e', `import {scanCommand, loadConfig} from ${JSON.stringify(pathToFileURL(entry).href)}; await scanCommand(process.argv[1], loadConfig(process.argv[1]), {changes:false, staged:false, verbose:false, json:true});`, root];
    const result = spawnSync(process.execPath, args, {encoding:'utf8', timeout:30000, maxBuffer:4*1024*1024, env:{...process.env, CI:'true'}});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const comments = report.diagnostics.filter(row => row.rule === 'ai-slop/trivial-comment').map(row => row.filePath).sort();
    assert.deepEqual(comments, ['comments.c','comments.cpp','comments.h','comments.hpp','comments.js','comments.py']);
    assert.equal(report.engines['ai-slop'].skipped, false);
  } finally { await rm(root, {recursive:true, force:true}); }
});
