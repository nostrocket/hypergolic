import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const POLICY = Object.freeze({
  id: 'hypergolic-quality-v1',
  doctor: '0.9.13', aislop: '0.16.0', pnpm: '10.34.5',
  maxAgeMs: 15 * 60_000,
  engines: ['format', 'lint', 'code-quality', 'ai-slop', 'security'],
  socket: 'excluded: existing project opt-out; separate pnpm dependency audits required',
  architecture: 'not applicable: no project architecture rules configured',
});
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, message) => assert.deepEqual(actual, expected, message);
const empty = (value, message) => same(value, [], message);
const zero = (value, message) => same(value, 0, message);
const positive = value => Number.isSafeInteger(value) && value > 0;
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const sorted = values => [...values].sort();
const hashPattern = /^[a-f0-9]{64}$/;
export const SCORE_ENV = Object.freeze({ CI: 'true', GITHUB_ACTIONS: null,
  REACT_DOCTOR_NO_TELEMETRY: '1', REACT_DOCTOR_OTLP_ENDPOINT: null, REACT_DOCTOR_OTLP_AUTH_HEADER: null });

export function commands(root, auditDirectories) {
  return [
    { id: 'react-doctor', cwd: root, executable: process.execPath, env: SCORE_ENV, args: [
      path.join(root, 'node_modules/react-doctor/dist/cli.js'), '.', '--lint',
      '--no-supply-chain', '--scope', 'full', '--no-cache',
      '--no-respect-inline-disables', '--json', '--yes', '--blocking', 'warning',
    ] },
    { id: 'aislop', cwd: root, executable: process.execPath, args: [
      path.join(root, 'tools/quality/node_modules/aislop/dist/cli.js'), 'ci', '.',
    ] },
    ...auditDirectories.map(directory => ({
      id: `audit:${directory}`, cwd: path.resolve(root, directory),
      executable: 'pnpm', args: ['audit', '--json'],
    })),
  ];
}

export async function snapshot(root) {
  const canonicalRoot = await realpath(root);
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: canonicalRoot, maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  const files = [];
  for (const relative of sorted(new Set(output.split('\0').filter(Boolean)))) {
    const absolute = path.resolve(canonicalRoot, relative);
    assert(inside(canonicalRoot, absolute), 'Git inventory escaped source root');
    let stat;
    try { stat = await lstat(absolute); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      files.push({ path: relative, deleted: true });
      continue;
    }
    assert(stat.isFile(), `Inventory requires regular files: ${relative}`);
    files.push({ path: relative, mode: stat.mode & 0o777, sha256: digest(await readFile(absolute)) });
  }
  assert(files.length > 0, 'Empty source inventory');
  return { root: canonicalRoot, sha256: digest(JSON.stringify(files)), files };
}

export async function inspectInputs(root) {
  const source = await snapshot(root);
  root = source.root;
  const doctorConfig = JSON.parse(await readFile(path.join(root, 'doctor.config.json'), 'utf8'));
  same(doctorConfig, { ignore: { files: [
    '.codex/**', '.tools/**', 'android/**', 'ios/**', 'tools/quality/node_modules/**',
  ] } }, 'React Doctor configuration changed: review scope, do not suppress findings');
  const slopConfig = await readFile(path.join(root, '.aislop/config.yml'), 'utf8');
  same(slopConfig.trim(), 'exclude:\n  - .tools\n  - .codex\n  - android\n  - ios\nci:\n  failBelow: 100',
    'aislop configuration changed: review scope, engines and suppression policy');
  for (const relative of ['.aislopignore', '.aislop/rules.yml', '.aislop/rules.yaml']) {
    const present = await lstat(path.join(root, relative)).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    assert(!present, `Unreviewed suppression/rules file: ${relative}`);
  }
  for (const file of source.files.filter(file => !file.deleted)) {
    assert(!/(^|\/)\.aislopignore$|(^|\/)\.aislop\/rules\.ya?ml$/.test(file.path),
      `Unreviewed suppression/rules file: ${file.path}`);
    if (/\.(?:[cm]?[jt]sx?|py)$/.test(file.path) && !/^\.(codex|tools)\//.test(file.path)) {
      const text = await readFile(path.join(root, file.path), 'utf8');
      assert(!/^\s*(?:\/\/|\/\*+|\*|#)\s*aislop-ignore-(?:next-line|line|file)\b/m.test(text),
        `aislop inline suppression: ${file.path}`);
    }
  }
  const auditDirectories = sorted(source.files.filter(file => !file.deleted &&
    path.basename(file.path) === 'pnpm-lock.yaml').map(file => path.dirname(file.path)));
  assert(auditDirectories.includes('.'), 'Root dependency lockfile missing');
  const versions = {};
  for (const [id, directory, expected] of [
    ['react-doctor', 'node_modules/react-doctor', POLICY.doctor],
    ['aislop', 'tools/quality/node_modules/aislop', POLICY.aislop],
  ]) {
    const packageInfo = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    same(packageInfo.version, expected, `${id} version changed`);
    versions[id] = { version: expected, entrySha256: digest(await readFile(path.join(root, directory, 'dist/cli.js'))) };
  }
  same(execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(), POLICY.pnpm,
    'pnpm version changed');
  const doctor = await import(pathToFileURL(path.join(root,
    'node_modules/react-doctor/dist/record-metric-Cckscwg_.js')).href);
  const doctorFiles = doctor.en(root).filter(file =>
    !doctorConfig.ignore.files.some(pattern => path.matchesGlob(file, pattern))).sort();
  assert(doctorFiles.includes('src/App.tsx'), 'React Native app missing from analyzed input');
  const slop = await import(pathToFileURL(path.join(root, 'tools/quality/node_modules/aislop/dist/index.js')).href);
  const config = slop.loadConfig(root);
  const project = await slop.discoverProject(root, config.exclude, { includePatterns: config.include, installedTools: {} });
  assert(project.coverage.scoreable && positive(project.coverage.supportedFiles), 'aislop source inventory is not scoreable');
  // discoverProject excludes tests; the pinned CLI adds its separate test inventory for scored coverage.
  const testFiles = slopTestFiles(source.files.filter(file => !file.deleted).map(file => file.path));
  return { source, auditDirectories, versions, doctorFiles,
    slopCoverage: { ...project.coverage, supportedFiles: project.coverage.supportedFiles + testFiles.length } };
}

export function slopTestFiles(files) {
  // Mirrors test selection in pinned aislop 0.16.0 source-file-policy.ts.
  const excluded = new Set(['node_modules', 'dist', 'build', '.git', '.agents', '.tools', '.codex',
    'android', 'ios', '.pnpm-store', '.yarn', 'bower', 'bower_components', 'jspm_packages', 'schemaspy',
    'generated', '__generated__', 'auto-generated', 'vendor', 'vendors', '_vendor', 'vendored',
    'third_party', 'third-party', '3rdparty', 'examples', 'example', 'demos', 'demo', 'bench', 'benches',
    'benchmarks', 'fixtures', 'fixture', 'stories', 'story', 'storybook', '__stories__', 'samples',
    'sample', 'tutorials', 'tutorial', 'code_samples', 'code-samples', 'notebooks', 'testdata', '.next',
    '.nuxt', '.wasp', 'coverage', '.turbo', 'test-outputs', '.bundle']);
  const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs',
    '.rb', '.java', '.php', '.cs', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx']);
  return files.filter(file => {
    if (!extensions.has(path.extname(file)) ||
      file.split('/').slice(0, -1).some(segment => excluded.has(segment.toLowerCase()))) return false;
    return /(?:^|\/).*\.(?:test|spec|story|stories)\.[^/]+$/i.test(file) ||
      /(?:^|\/)test_[^/]+\.(?:py|rb|php|js|jsx|d\.ts|ts|tsx|java|c|cc|cpp|cxx)$/i.test(file) ||
      /(?:^|\/)[^/]+_test\.(?:py|go|rb|php|js|jsx|d\.ts|ts|tsx|java)$/i.test(file) ||
      /(?:^|\/)[^/]+_tests?\.(?:c|cc|cpp|cxx)$/i.test(file) ||
      /(?:^|\/)[^/]+Tests?\.cs$/i.test(file) ||
      /(?:^|\/)[^/]+\.Tests?\.cs$/i.test(file) ||
      /(?:^|\/)[^/]*Tests?\/.*\.cs$/i.test(file);
  });
}

export function verifyDoctor(report, inputs) {
  same(report.schemaVersion, 3, 'React Doctor JSON schema mismatch');
  same(report.version, POLICY.doctor, 'React Doctor version mismatch');
  same(report.ok, true, 'React Doctor scan failed');
  same(report.error, null, 'React Doctor reported an error');
  same(report.mode, 'full', 'React Doctor scan was partial');
  same(report.diff, null, 'React Doctor diff filtering is forbidden');
  same(report.directory, inputs.source.root, 'React Doctor source directory mismatch');
  same(report.reactDetected, true, 'React runtime was not detected');
  assert(!report.baseline && !report.baselineDegraded, 'Baseline reports are not full-source evidence');
  empty(report.skippedProjects ?? [], 'React Doctor skipped projects');
  empty(report.diagnostics, 'React Doctor diagnostics must be empty, including informational findings');
  assert(Array.isArray(report.projects) && report.projects.length > 0, 'React Doctor has no project results');
  const seen = new Set();
  let nativeRoot = false;
  const analyzed = [];
  for (const project of report.projects) {
    assert(inside(inputs.source.root, project.directory), 'React Doctor project escaped source root');
    assert(!seen.has(project.directory), 'Duplicate React Doctor project');
    seen.add(project.directory);
    same(project.packageRoot, project.directory, 'React Doctor package binding mismatch');
    same(project.project?.rootDirectory, project.directory, 'React Doctor project root mismatch');
    if (project.directory === inputs.source.root) nativeRoot = project.project.hasReactNativeWorkspace === true;
    same(project.score?.score, 100, 'Every React Doctor project needs an actual numeric score of 100');
    assert(typeof project.score.label === 'string' && project.score.label.length > 0, 'Missing React Doctor score label');
    same(project.complete, true, 'React Doctor project scan incomplete');
    empty(project.diagnostics, 'React Doctor project has diagnostics');
    empty(project.skippedChecks, 'React Doctor checks were skipped');
    same(project.skippedCheckReasons ?? {}, {}, 'React Doctor partial/failed check reasons exist');
    assert(Array.isArray(project.analyzedFiles) && positive(project.analyzedFileCount), 'Missing analyzed source inventory');
    same(project.analyzedFiles.length, project.analyzedFileCount, 'React Doctor inventory count mismatch');
    same(new Set(project.analyzedFiles).size, project.analyzedFileCount, 'Duplicate analyzed source paths');
    same(project.scannedFileCount, project.analyzedFileCount, 'React Doctor did not analyze all scanned files');
    for (const file of project.analyzedFiles) {
      assert(typeof file === 'string' && !path.isAbsolute(file), 'Invalid analyzed relative path');
      const absolute = path.resolve(project.directory, file);
      assert(inside(project.directory, absolute), 'Analyzed source path escaped project');
      analyzed.push(path.relative(inputs.source.root, absolute));
    }
  }
  assert(nativeRoot, 'Full root React Native project result required');
  same(sorted(new Set(analyzed)), inputs.doctorFiles, 'React Doctor analyzed source set differs from current full inventory');
  for (const field of ['errorCount', 'warningCount', 'affectedFileCount', 'totalDiagnosticCount']) {
    zero(report.summary?.[field], `React Doctor summary ${field} is not zero`);
  }
  same(report.summary.score, 100, 'React Doctor summary numeric score must be 100');
}

export function verifyAislop(report, inputs) {
  same(report.schemaVersion, '1', 'aislop JSON schema mismatch');
  same(report.cliVersion, POLICY.aislop, 'aislop CLI version mismatch');
  same(report.version, POLICY.aislop, 'aislop version mismatch');
  same(report.score, 100, 'aislop actual numeric score must be 100');
  same(report.scoreable, true, 'aislop scan is not scoreable');
  same(report.coverage?.scoreable, true, 'aislop coverage is not scoreable');
  assert(positive(report.coverage.supportedFiles), 'aislop analyzed no supported files');
  for (const field of ['supportedFiles', 'unsupportedFiles', 'dominantUnsupported']) {
    same(report.coverage[field], inputs.slopCoverage[field], `aislop ${field} source inventory mismatch`);
  }
  same(report.summary?.files, inputs.slopCoverage.supportedFiles, 'aislop file count differs from current full inventory');
  same(sorted(Object.keys(report.engines ?? {})), sorted(POLICY.engines), 'aislop applicable engine missing or unexpected');
  for (const engine of POLICY.engines) {
    same(report.engines[engine].skipped, false, `aislop ${engine} skipped`);
    zero(report.engines[engine].issues, `aislop ${engine} has findings`);
    assert(Number.isFinite(report.engines[engine].elapsed) && report.engines[engine].elapsed >= 0,
      `aislop ${engine} lacks completion timing`);
  }
  empty(report.diagnostics, 'aislop diagnostics must be empty, including audit-skipped info');
  empty(report.findingAssessment?.rows, 'aislop assessment has findings');
  for (const counts of [report.findingAssessment.byKind, report.findingAssessment.byConfidence]) {
    assert(counts && Object.keys(counts).length > 0, 'aislop assessment counts missing');
    for (const value of Object.values(counts)) zero(value, 'aislop assessment count is not zero');
  }
  for (const field of ['errors', 'warnings', 'fixable']) zero(report.summary[field], `aislop ${field} is not zero`);
}

export function verifyAudit(report) {
  assert(report && typeof report === 'object' && !Array.isArray(report), 'Audit JSON is not an object');
  assert(!report.error, 'Dependency audit returned an error');
  same(report.advisories, {}, 'Dependency advisories present or audit result missing');
  empty(report.actions, 'Dependency audit action list missing or nonempty');
  const vulnerabilities = report.metadata?.vulnerabilities;
  assert(vulnerabilities && typeof vulnerabilities === 'object', 'Dependency audit completion metadata missing');
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    zero(vulnerabilities[severity], `Dependency audit ${severity} vulnerabilities present or missing count`);
  }
  for (const value of Object.values(vulnerabilities)) zero(value, 'Unexpected nonzero audit severity');
}

export function verifyBundle(bundle, inputs, now = Date.now()) {
  same(bundle.schemaVersion, 1, 'Quality evidence schema mismatch');
  same(bundle.policy, POLICY, 'Quality scope/policy mismatch');
  same(bundle.root, inputs.source.root, 'Evidence belongs to another source directory');
  same(bundle.inputSha256, inputs.source.sha256, 'Quality evidence is stale: source changed');
  same(bundle.outputSha256, bundle.inputSha256, 'Source changed while scans were running');
  assert(hashPattern.test(bundle.inputSha256), 'Invalid source digest');
  same(bundle.versions, inputs.versions, 'Installed quality tool binding mismatch');
  same(bundle.doctorFiles, inputs.doctorFiles, 'Recorded React Doctor input coverage changed');
  same(bundle.slopCoverage, inputs.slopCoverage, 'Recorded aislop input coverage changed');
  assert(Number.isFinite(bundle.startedAt) && Number.isFinite(bundle.finishedAt) &&
    bundle.startedAt <= bundle.finishedAt && bundle.finishedAt <= now &&
    now - bundle.startedAt <= POLICY.maxAgeMs, 'Quality evidence is stale or has invalid timestamps');
  const expected = commands(inputs.source.root, inputs.auditDirectories);
  assert(Array.isArray(bundle.runs), 'Quality process receipts missing');
  same(bundle.runs.map(run => run.command.id), expected.map(command => command.id), 'Missing, reordered, or unexpected scans/audits');
  for (let index = 0; index < expected.length; index += 1) {
    const run = bundle.runs[index];
    same(run.command, expected[index], `Full scan invocation mismatch: ${expected[index].id}`);
    same(run.exitCode, 0, `${run.command.id} process failed`);
    same(run.signal, null, `${run.command.id} process was interrupted`);
    same(run.timedOut, false, `${run.command.id} process timed out`);
    assert(run.startedAt >= bundle.startedAt && run.finishedAt >= run.startedAt &&
      run.finishedAt <= bundle.finishedAt, 'Invalid scan timestamps');
    assert(typeof run.stdout === 'string' && run.stdout.length <= 16 * 1024 * 1024, 'Missing or oversized raw report');
    same(run.stdoutSha256, digest(run.stdout), 'Raw quality report was modified');
    const report = JSON.parse(run.stdout);
    if (run.command.id === 'react-doctor') verifyDoctor(report, inputs);
    else if (run.command.id === 'aislop') verifyAislop(report, inputs);
    else verifyAudit(report);
  }
  return { ok: true, reactDoctor: 100, aislop: 100, sourceSha256: inputs.source.sha256,
    audits: inputs.auditDirectories.length, socket: POLICY.socket };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv.length === 4, 'Usage: node verify-quality.mjs ROOT EVIDENCE.json');
    const inputs = await inspectInputs(process.argv[2]);
    const bundle = JSON.parse(await readFile(process.argv[3], 'utf8'));
    process.stdout.write(`${JSON.stringify(verifyBundle(bundle, inputs), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Quality gate failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
