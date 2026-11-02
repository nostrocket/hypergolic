import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeStatus } from './runtime-status.ts';

test('old Android WebView failure gives a useful action without changing host state', () => {
  assert.equal(runtimeStatus({ type: 'error', code: 'webview-update-required' }),
    'Android System WebView needs an update before napplets can open.');
  assert.equal(runtimeStatus({ type: 'ready' }), 'Runtime connected');
  assert.equal(runtimeStatus({ type: 'error', code: 'backgrounded' }), 'Runtime unavailable: backgrounded');
});
