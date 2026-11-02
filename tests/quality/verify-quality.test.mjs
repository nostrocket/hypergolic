import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { POLICY, commands, digest, snapshot, slopTestFiles, verifyBundle } from '../../scripts/verify-quality.mjs';

// Deliberately synthetic JSON fixtures exercise validation, never real score evidence.
function fixture() {
  const root = '/synthetic/hypergolic';
  const inputs = {
    source: { root, sha256: digest('synthetic source') },
    versions: { 'react-doctor': { version: '0.9.13', entrySha256: digest('doctor') },
      aislop: { version: '0.16.0', entrySha256: digest('aislop') } },
    doctorFiles: ['index.ts', 'src/App.tsx'],
    slopCoverage: { supportedFiles: 2, unsupportedFiles: 4, dominantUnsupported: 'Swift', scoreable: true },
    auditDirectories: ['.', 'napplets/ux-lab', 'runtime', 'tools/quality'],
  };
  const doctor = {
    schemaVersion: 3, version: '0.9.13', mode: 'full', reactDetected: true,
    ok: true, error: null, diff: null, directory: root,
    projects: [{ directory: root, packageRoot: root,
      project: { rootDirectory: root, hasReactNativeWorkspace: true },
      diagnostics: [], score: { score: 100, label: 'Great' }, skippedChecks: [],
      complete: true, analyzedFiles: inputs.doctorFiles, analyzedFileCount: 2, scannedFileCount: 2 }],
    diagnostics: [], summary: { errorCount: 0, warningCount: 0, affectedFileCount: 0,
      totalDiagnosticCount: 0, score: 100, scoreLabel: 'Great' },
  };
  const slop = {
    schemaVersion: '1', cliVersion: '0.16.0', version: '0.16.0', score: 100,
    scoreable: true, coverage: inputs.slopCoverage,
    engines: Object.fromEntries(POLICY.engines.map(engine => [engine, { issues: 0, skipped: false, elapsed: 1 }])),
    diagnostics: [], findingAssessment: { rows: [], byKind: { 'confirmed-defect': 0 }, byConfidence: { high: 0 } },
    summary: { errors: 0, warnings: 0, fixable: 0, files: 2 },
  };
  const audit = { actions: [], advisories: {}, metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
  } };
  const now = 1_000_000;
  const bundle = {
    schemaVersion: 1, policy: POLICY, root, inputSha256: inputs.source.sha256,
    outputSha256: inputs.source.sha256, versions: inputs.versions,
    doctorFiles: inputs.doctorFiles, slopCoverage: inputs.slopCoverage,
    startedAt: now - 100, finishedAt: now - 10,
    runs: commands(root, inputs.auditDirectories).map((command, index) => {
      const stdout = JSON.stringify(index === 0 ? doctor : index === 1 ? slop : audit);
      return { command, startedAt: now - 90, finishedAt: now - 20, exitCode: 0, signal: null,
        timedOut: false, stdout, stdoutSha256: digest(stdout), stderr: '' };
    }),
  };
  return { inputs: structuredClone(inputs), bundle: structuredClone(bundle), now };
}
function editReport(bundle, index, edit) {
  const report = JSON.parse(bundle.runs[index].stdout);
  edit(report);
  bundle.runs[index].stdout = JSON.stringify(report);
  bundle.runs[index].stdoutSha256 = digest(bundle.runs[index].stdout);
}

test('accepts complete synthetic RN full-scan receipts, without demanding Swift/architecture engines', () => {
  const { inputs, bundle, now } = fixture();
  assert.equal(verifyBundle(bundle, inputs, now).ok, true);
});

const doctorRejections = [
  ['missing project score', r => { delete r.projects[0].score; }],
  ['null project score with summary 100', r => { r.projects[0].score = null; }],
  ['score string', r => { r.projects[0].score.score = '100'; }],
  ['score below maximum', r => { r.projects[0].score.score = 99; }],
  ['score over maximum', r => { r.projects[0].score.score = 101; }],
  ['null summary score', r => { r.summary.score = null; }],
  ['scan error', r => { r.ok = false; r.error = { message: 'offline' }; }],
  ['changed scope', r => { r.mode = 'changed'; }],
  ['diff report', r => { r.diff = { base: 'HEAD' }; }],
  ['skipped project', r => { r.skippedProjects = [{ directory: '/synthetic/second', reason: 'max-duration' }]; }],
  ['partial project', r => { r.projects[0].complete = false; }],
  ['skipped check', r => { r.projects[0].skippedChecks = ['lint']; }],
  ['partial check reason', r => { r.projects[0].skippedCheckReasons = { 'lint:partial': 'timeout' }; }],
  ['missing scanned count', r => { delete r.projects[0].scannedFileCount; }],
  ['omitted source file with adjusted count', r => {
    r.projects[0].analyzedFiles = ['index.ts']; r.projects[0].analyzedFileCount = 1; r.projects[0].scannedFileCount = 1;
  }],
  ['duplicate source', r => { r.projects[0].analyzedFiles = ['index.ts', 'index.ts']; }],
  ['informational diagnostic despite perfect score', r => { r.diagnostics = [{ severity: 'info', message: 'skipped' }]; }],
  ['project-only diagnostic', r => { r.projects[0].diagnostics = [{ severity: 'warning' }]; }],
  ['wrong directory', r => { r.directory = '/synthetic/other'; }],
  ['undetected native project', r => { r.projects[0].project.hasReactNativeWorkspace = false; }],
  ['schema drift', r => { r.schemaVersion = 4; }],
];
for (const [name, mutate] of doctorRejections) test(`rejects React Doctor ${name}`, () => {
  const { inputs, bundle, now } = fixture();
  editReport(bundle, 0, mutate);
  assert.throws(() => verifyBundle(bundle, inputs, now));
});

const slopRejections = [
  ['missing score', r => { delete r.score; }],
  ['score below maximum', r => { r.score = 99; }],
  ['non-numeric score', r => { r.score = '100'; }],
  ['not scoreable', r => { r.scoreable = false; }],
  ['missing applicable engine', r => { delete r.engines.security; }],
  ['skipped applicable engine', r => { r.engines.lint.skipped = true; }],
  ['engine findings with no diagnostics', r => { r.engines.format.issues = 1; }],
  ['zero analyzed files', r => { r.coverage.supportedFiles = 0; }],
  ['smaller source inventory', r => { r.coverage.supportedFiles = 1; r.summary.files = 1; }],
  ['missing audit information', r => { r.diagnostics = [{ severity: 'info', rule: 'security/dependency-audit-skipped' }]; }],
  ['nonempty assessment', r => { r.findingAssessment.rows = [{ kind: 'style-policy' }]; }],
  ['warning despite score rounding', r => { r.summary.warnings = 1; }],
  ['schema drift', r => { r.schemaVersion = '2'; }],
];
for (const [name, mutate] of slopRejections) test(`rejects aislop ${name}`, () => {
  const { inputs, bundle, now } = fixture();
  editReport(bundle, 1, mutate);
  assert.throws(() => verifyBundle(bundle, inputs, now));
});

const receiptRejections = [
  ['missing fixture audit', b => { b.runs.splice(3, 1); }],
  ['changed command flag', b => { b.runs[0].command.args.push('--no-telemetry'); }],
  ['disabled lint command', b => { b.runs[0].command.args[2] = '--no-lint'; }],
  ['partial aislop command', b => { b.runs[1].command.args.push('--changes'); }],
  ['nonzero process', b => { b.runs[1].exitCode = 1; }],
  ['terminated process', b => { b.runs[0].signal = 'SIGKILL'; }],
  ['timed-out audit', b => { b.runs[2].timedOut = true; }],
  ['stale start', b => { b.startedAt = 0; }],
  ['future finish', b => { b.finishedAt = 1_000_001; }],
  ['source changed during scans', b => { b.outputSha256 = digest('new content'); }],
  ['source mismatch', b => { b.inputSha256 = digest('old content'); }],
  ['tool version mismatch', b => { b.versions.aislop.version = '0.15.0'; }],
  ['tampered JSON bytes', b => { b.runs[0].stdout += ' '; }],
  ['invalid JSON', b => { b.runs[0].stdout = '{'; b.runs[0].stdoutSha256 = digest('{'); }],
  ['different root', b => { b.root = '/synthetic/other'; }],
  ['missing audit JSON fields', b => { editReport(b, 2, r => { delete r.metadata; }); }],
  ['audit error object', b => { editReport(b, 2, r => { r.error = { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' }; }); }],
  ['audit low vulnerability', b => { editReport(b, 2, r => { r.metadata.vulnerabilities.low = 1; }); }],
  ['audit advisory with zero counters', b => { editReport(b, 2, r => { r.advisories = { 123: { severity: 'high' } }; }); }],
];
for (const [name, mutate] of receiptRejections) test(`rejects evidence ${name}`, () => {
  const { inputs, bundle, now } = fixture();
  mutate(bundle);
  assert.throws(() => verifyBundle(bundle, inputs, now));
});

test('source hash detects edits, new untracked files and tracked deletions; rejects symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quality-snapshot-'));
  try {
    execFileSync('git', ['init', '--quiet', root]);
    const source = path.join(root, 'source.ts');
    await writeFile(source, 'export const value = 1;\n');
    execFileSync('git', ['add', 'source.ts'], { cwd: root });
    const first = await snapshot(root);
    await writeFile(source, 'export const value = 2;\n');
    const edited = await snapshot(root);
    assert.notEqual(first.sha256, edited.sha256);
    await writeFile(path.join(root, 'second.ts'), 'export const second = true;\n');
    const added = await snapshot(root);
    assert.notEqual(edited.sha256, added.sha256);
    await rm(source);
    const deleted = await snapshot(root);
    assert.notEqual(added.sha256, deleted.sha256);
    assert.equal(deleted.files.find(file => file.path === 'source.ts').deleted, true);
    await symlink('second.ts', path.join(root, 'link.ts'));
    await assert.rejects(snapshot(root), /regular files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('aislop score coverage adds supported tests without counting fixtures, stories or generated native trees', () => {
  assert.deepEqual(slopTestFiles([
    'src/motion.test.ts', 'runtime/tests/runtime.spec.ts', 'tests/native/test_driver.py',
    'src/thing.ts', 'fixtures/thing.test.ts', 'stories/thing.stories.tsx', 'android/native.test.ts',
  ]), ['src/motion.test.ts', 'runtime/tests/runtime.spec.ts', 'tests/native/test_driver.py']);
});


test('aislop coverage includes native C test names and other supported language tests', () => {
  assert.deepEqual(slopTestFiles([
    'modules/signer-core/tests/primitive_test.c',
    'modules/signer-core/tests/nip44/nip44_test.c',
    'tests/test_parser.cpp', 'tests/parser_tests.cc', 'tests/parser_test.go',
    'tests/test_parser.java', 'tests/ParserTests.cs', 'tests/Parser.Tests.cs', 'Tests/Parser.cs',
    'tests/parser.spec.rs', 'tests/test_parser.rb', 'tests/parser_test.php',
    'vendor/primitive_test.c', 'tests/primitive.c', 'tests/primitive_test.kt',
  ]), [
    'modules/signer-core/tests/primitive_test.c',
    'modules/signer-core/tests/nip44/nip44_test.c',
    'tests/test_parser.cpp', 'tests/parser_tests.cc', 'tests/parser_test.go',
    'tests/test_parser.java', 'tests/ParserTests.cs', 'tests/Parser.Tests.cs', 'Tests/Parser.cs',
    'tests/parser.spec.rs', 'tests/test_parser.rb', 'tests/parser_test.php',
  ]);
});
