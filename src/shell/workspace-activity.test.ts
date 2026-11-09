import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceSessionActivity, isHostActivityBlocked, isWorkspaceFullscreen } from './workspace-activity.ts';

const focused = {focused: true, overview: false, busy: false, interactive: true, checkingClose: false,
  blocked: false, hostActivityBlocked: false};

test('a trusted CVM review blocks guest input without pausing the committed source', () => {
  const review = workspaceSessionActivity({...focused, blocked: true});
  assert.deepEqual(review, {active: true, inputBlocked: true});
  assert.deepEqual(workspaceSessionActivity(focused), {active: true, inputBlocked: false});
  // Native active must not toggle while the review opens/closes. Funclet schedules
  // metadata on every paused -> playing transition, so that toggle caused a loop.
  assert.equal(review.active, workspaceSessionActivity(focused).active);
});

for (const [reason, change] of Object.entries({
  identity: {blocked: true, hostActivityBlocked: true}, settings: {hostActivityBlocked: true},
  overview: {overview: true}, animation: {busy: true}, drag: {interactive: false},
  otherSource: {focused: false}, close: {checkingClose: true},
})) test(`${reason} still deactivates media and guest input even during a review`, () => {
  assert.deepEqual(workspaceSessionActivity({...focused, blocked: true, ...change}),
    {active: false, inputBlocked: true});
});

test('real shell blockers obscure the host independently of review input occlusion', () => {
  assert.equal(isHostActivityBlocked(false, false), false);
  assert.equal(isHostActivityBlocked(true, false), true);
  assert.equal(isHostActivityBlocked(false, true), true);
});

test('fullscreen follows the native window only while a napplet is focused outside overview', () => {
  const portrait = {width: 390, height: 844};
  const landscape = {width: 844, height: 390};
  const focused = {focusedId: 'discover', overview: false};
  assert.equal(isWorkspaceFullscreen(focused, portrait), false);
  assert.equal(isWorkspaceFullscreen(focused, landscape), true);
  assert.equal(isWorkspaceFullscreen({...focused, overview: true}, landscape), false);
  assert.equal(isWorkspaceFullscreen({focusedId: null, overview: false}, landscape), false);
  assert.equal(isWorkspaceFullscreen(focused, {width: 844, height: 0}), false);
  assert.equal(isWorkspaceFullscreen(focused, {width: 390, height: 390}), false);
});
