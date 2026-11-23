import type {TestContext} from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

export async function runtimeModule(context: TestContext, path: string) {
  const runtime = new URL('../../runtime/', import.meta.url);
  const vite = await import(createRequire(new URL('package.json', runtime)).resolve('vite'));
  const server = await vite.createServer({root: fileURLToPath(runtime), configFile: false, logLevel: 'error',
    server: {middlewareMode: true, ws: false, hmr: false, watch: null}, optimizeDeps: {noDiscovery: true}});
  context.after(() => server.close());
  return server.ssrLoadModule(path);
}
