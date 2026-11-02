import { openShellDatabase } from '../../src/storage/database.ts';
import { DiskSQLite, registration } from './harness.ts';
const directory = process.argv[2], operation = process.argv[3];
if (!directory || (operation !== 'write' && operation !== 'read')) throw new Error('Invalid test worker arguments');
const adapter = new DiskSQLite(directory), database = await openShellDatabase(adapter, 'android');
const workspace = database.bindWorkspace(registration()).port, strings = database.bindStorage(registration()).port;
if (operation === 'write') {
  await strings.set('saved', 'persisted across actual Node processes');
  await workspace.save({ schema: 1, sessions: [], lastActiveId: null }, null);
} else process.stdout.write(JSON.stringify({ workspace: await workspace.load(), value: await strings.get('saved') }));
await database.close();
