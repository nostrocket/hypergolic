import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { POLICY, commands, digest, inspectInputs, snapshot, verifyBundle } from './verify-quality.mjs';

function run(command) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const env = { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' };
    for (const [key, value] of Object.entries(command.env ?? {})) {
      if (value === null) delete env[key];
      else env[key] = value;
    }
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const terminate = () => {
      timedOut = true;
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(terminate, 180_000);
    child.stdout.on('data', bytes => {
      stdout += bytes.toString();
      if (stdout.length > 16 * 1024 * 1024) terminate();
    });
    child.stderr.on('data', bytes => {
      stderr += bytes.toString();
      if (stderr.length > 1024 * 1024) terminate();
    });
    child.on('error', error => { stderr += error.message; });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ command, startedAt, finishedAt: Date.now(), exitCode, signal,
        timedOut, stdout, stdoutSha256: digest(stdout), stderr });
    });
  });
}

try {
  assert(process.argv.length === 4, 'Usage: node run-quality.mjs ROOT EVIDENCE.json');
  const inputs = await inspectInputs(process.argv[2]);
  const destination = path.resolve(process.argv[3]);
  assert(destination !== inputs.source.root && !destination.startsWith(`${inputs.source.root}${path.sep}`),
    'Store evidence outside source tree so output cannot invalidate its own source fingerprint');
  const bundle = { schemaVersion: 1, policy: POLICY, root: inputs.source.root,
    inputSha256: inputs.source.sha256, versions: inputs.versions,
    doctorFiles: inputs.doctorFiles, slopCoverage: inputs.slopCoverage,
    startedAt: Date.now(), runs: [] };
  for (const command of commands(inputs.source.root, inputs.auditDirectories)) {
    process.stderr.write(`Running ${command.id}\n`);
    bundle.runs.push(await run(command));
  }
  bundle.finishedAt = Date.now();
  bundle.outputSha256 = (await snapshot(inputs.source.root)).sha256;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(bundle, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(verifyBundle(bundle, inputs), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Quality gate failed: ${error.message}\n`);
  process.exitCode = 1;
}
