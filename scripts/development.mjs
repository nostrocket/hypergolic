import {spawnSync} from 'node:child_process';

const [operation, ...args] = process.argv.slice(2);
if (!['start', 'run:ios', 'run:android'].includes(operation)) throw new Error('Unknown Expo development command');
const env = {...process.env, HYPERGOLIC_VARIANT: 'development'};
function run(command, args) {
  const child = spawnSync(command, args, {env, stdio: 'inherit', shell: process.platform === 'win32'});
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}
if (operation !== 'start') run('pnpm', ['run', 'runtime:build']);
run('pnpm', ['exec', 'expo', operation, ...args]);
