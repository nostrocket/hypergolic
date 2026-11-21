import assert from 'node:assert/strict';
import test from 'node:test';
import { bundledUXDescriptor } from './fixtures.ts';
import { MAX_LOADED_VIEWS } from './workspace-activity.ts';
import { WorkspaceViews } from './workspace-views.ts';
import { emptyWorkspace, focusNapplet, openNapplet, showOverview } from './workspace.ts';

function fullWorkspace() {
  let workspace = emptyWorkspace();
  const views = new WorkspaceViews(workspace);
  for (let i = 1; i <= MAX_LOADED_VIEWS; ++i) {
    workspace = openNapplet(workspace, bundledUXDescriptor(i));
    views.update(workspace);
  }
  return {workspace, views};
}

test('the ninth open releases the least recently visited eligible view and preserves its card and version', () => {
  const {workspace, views} = fullWorkspace();
  const [first, second, third] = workspace.sessions;
  const saved = new Set([first.id, second.id, third.id]);
  const reclaimed: string[] = [];
  views.bind({canSuspend: session => saved.has(session.id), trySuspend: session => {
    if (!saved.delete(session.id)) return false;
    reclaimed.push(session.id);
    return true;
  }});
  const refocused = focusNapplet(workspace, first.id);
  views.update(refocused);
  const ninth = bundledUXDescriptor(9);
  assert.equal(views.canLoadView([]), true);
  assert.deepEqual(reclaimed, []);
  assert.equal(views.admitView(ninth.id), true);
  const next = openNapplet(refocused, ninth);
  views.update(next);
  assert.deepEqual(reclaimed, [second.id]);
  assert.equal(next.sessions[1], second);
  assert.equal(next.sessions.length, 9);
  assert.equal(views.getSnapshot().size, MAX_LOADED_VIEWS);
  assert.equal(views.getSnapshot().has(second.id), false);
  views.update(focusNapplet(next, second.id));
  assert.deepEqual(reclaimed, [second.id, third.id]);
  assert.equal(views.getSnapshot().has(second.id), true);
  assert.equal(views.getSnapshot().size, MAX_LOADED_VIEWS);
});

test('a new host operation can invalidate a preflight without discarding a view', () => {
  const {workspace, views} = fullWorkspace();
  const original = views.getSnapshot();
  const background = workspace.sessions[0].id;
  views.bind({canSuspend: session => session.id === background, trySuspend: () => false});
  assert.equal(views.canLoadView([]), true);
  assert.equal(views.admitView('new-card'), false);
  assert.equal(views.getSnapshot(), original);
  assert.equal(views.admitView(workspace.focusedId!), true);
  assert.equal(views.getSnapshot(), original);
});

test('memory pressure preserves the selected source and unknown work, including in overview', () => {
  const {workspace, views} = fullWorkspace();
  const [first, second] = workspace.sessions;
  const selected = workspace.focusedId!;
  const saved = new Set([first.id, second.id, selected]);
  const inspected: string[] = [];
  views.bind({canSuspend: session => saved.has(session.id), trySuspend: session => {
    inspected.push(session.id);
    return saved.delete(session.id);
  }});
  views.update(showOverview(workspace));
  views.trimBackground();
  assert.equal(inspected.includes(selected), false);
  assert.deepEqual([...views.getSnapshot()], workspace.sessions.slice(2).map(session => session.id));
  assert.equal(workspace.sessions.length, 8);
  views.update(focusNapplet(workspace, first.id));
  assert.equal(views.getSnapshot().has(first.id), true);
  assert.equal(views.getSnapshot().has(second.id), false);
});
