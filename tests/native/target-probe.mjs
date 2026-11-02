import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://appassets.androidplatform.net';
export function admitTargets(rows, port) {
  assert(Array.isArray(rows), 'DevTools target inventory must be an array');
  const ids = new Set(), generations = new Set();
  return rows.map(row => {
    assert(row.type === 'page', 'Unexpected executable target type in app socket');
    assert(typeof row.id === 'string' && /^[A-Za-z0-9_-]+$/.test(row.id), 'Invalid DevTools target ID');
    const url = new URL(row.url);
    assert.equal(url.origin, ORIGIN);
    assert.equal(url.pathname, '/assets/runtime/index.html');
    assert.equal(url.hash, '');
    const keys = [...url.searchParams.keys()];
    assert.deepEqual(keys, url.searchParams.has('fixture') ? ['sessionId', 'fixture'] : ['sessionId']);
    if (url.searchParams.has('fixture')) assert.equal(url.searchParams.get('fixture'), 'ux-lab', 'Only the UX fixture is observable');
    const generation = url.searchParams.get('sessionId');
    assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(generation),
      'Target URL lacks a native generation UUID');
    assert(!ids.has(row.id) && !generations.has(generation), 'Duplicate target or generation');
    ids.add(row.id); generations.add(generation);
    const debuggerUrl = new URL(row.webSocketDebuggerUrl);
    assert.equal(debuggerUrl.protocol, 'ws:');
    assert.equal(debuggerUrl.pathname, `/devtools/page/${row.id}`);
    assert.equal(debuggerUrl.search + debuggerUrl.hash, '');
    // Use only our caller-owned localhost ADB forwarding, never an inventory-supplied host.
    return { id: row.id, generation, url: url.href,
      ws: `ws://127.0.0.1:${port}${debuggerUrl.pathname}`, description: row.description ?? '' };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.contexts = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Runtime.executionContextCreated') this.contexts.set(message.params.context.id, message.params.context);
      if (message.method === 'Runtime.executionContextDestroyed') this.contexts.delete(message.params.executionContextId);
      if (message.method === 'Runtime.executionContextsCleared') this.contexts.clear();
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Observed CDP target closed')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    return new Cdp(socket);
  }
  send(method, params = {}) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, 5000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.socket.close(); }
}

function readFixture() {
  const get = id => document.getElementById(id);
  const rect = element => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  const controls = Object.fromEntries(['increment', 'draft', 'rail'].map(id => [id, rect(get(id))]));
  for (const element of document.querySelectorAll('[data-testid^="marker-"], [data-testid^="edge-"]')) {
    controls[element.dataset.testid] = rect(element);
  }
  return { ready: get('ready')?.textContent, theme: get('theme-status')?.textContent,
    counter: get('counter')?.textContent, draft: get('draft')?.value,
    mirror: get('draft-mirror')?.textContent, selected: get('selected')?.textContent,
    edge: get('edge')?.textContent, viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY, rail: get('rail')?.scrollLeft }, controls,
    runtimeDomains: Object.keys(window.napplet ?? {}).sort(), nativeBridge: typeof window.HypergolicHost };
}

export async function observeTarget(target) {
  const cdp = await Cdp.connect(target.ws);
  try {
    await cdp.send('Runtime.enable');
    const { frameTree } = await cdp.send('Page.getFrameTree');
    assert.equal(frameTree.frame.url, target.url, 'Target navigated before observation');
    const children = frameTree.childFrames ?? [];
    assert.equal(children.length, 1, 'Expected exactly one existing napplet child frame');
    const child = children[0].frame;
    assert.equal(child.url, 'about:srcdoc');
    assert(!(children[0].childFrames?.length), 'Unexpected nested fixture frame');
    const contexts = [...cdp.contexts.values()].filter(context =>
      context.auxData?.frameId === child.id && context.auxData?.isDefault === true);
    assert.equal(contexts.length, 1, 'No unique existing default child context; cannot inspect safely');
    const context = contexts[0];
    assert.equal(typeof context.uniqueId, 'string', 'Runtime context identity unavailable');
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(${readFixture.toString()})()`, uniqueContextId: context.uniqueId,
      returnByValue: true, userGesture: false, awaitPromise: false,
    });
    assert.equal(cdp.contexts.get(context.id)?.uniqueId, context.uniqueId,
      'Existing child execution context changed during observation');
    assert(!result.exceptionDetails, 'Read-only child observation failed');
    const snapshot = result.result.value;
    assert(snapshot.ready?.startsWith('Ready ·') && snapshot.theme === 'Host colors', 'Actual fixture handshake/theme not ready');
    assert.deepEqual(snapshot.runtimeDomains, ['shell', 'theme']);
    assert.equal(snapshot.nativeBridge, 'undefined');
    assert(/^\d+$/.test(snapshot.counter), 'Counter is not numeric');
    return { id: target.id, generation: target.generation, frameId: child.id,
      contextUniqueId: context.uniqueId, snapshot, description: target.description };
  } finally { cdp.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  assert(args.length % 2 === 0, 'Arguments require explicit values');
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]));
  assert(Object.keys(options).every(key => ['--port', '--target-id', '--generation', '--output', '--mode'].includes(key)), 'Unknown option');
  const port = Number(options['--port']);
  assert(Number.isInteger(port) && port > 0 && port < 65536, 'Explicit allocated localhost port required');
  assert(Boolean(options['--target-id']) === Boolean(options['--generation']), 'Target ID and generation must be supplied together');
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  assert(response.ok, 'App DevTools inventory unavailable');
  const targets = admitTargets(await response.json(), port);
  const selected = options['--target-id'] ? targets.filter(target => target.id === options['--target-id'] && target.generation === options['--generation']) : targets;
  if (options['--target-id']) assert.equal(selected.length, 1, 'Exact generation/target no longer exists');
  const mode = options['--mode'] ?? 'snapshot';
  assert(['snapshot', 'inventory'].includes(mode), 'Unsupported target probe mode');
  const output = { schemaVersion: 1, mode, status: 'passed',
    scope: 'Existing app-owned target inventory; read-only evaluation only in exact existing untrusted child contexts',
    targets: mode === 'snapshot' ? await Promise.all(selected.map(observeTarget)) : selected.map(({ ws, ...target }) => target) };
  if (options['--output']) await writeFile(options['--output'], `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
