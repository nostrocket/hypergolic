import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoutingTargets } from '../../src/routing/routing-targets.ts';
import { openNapplet, emptyWorkspace } from '../../src/shell/workspace.ts';
import type { NappletDescriptor } from '../../src/shell/workspace.ts';
import type { IdentityTransition } from '../../src/security/identity-transition.ts';
import type { RuntimeOwner } from '../../src/runtime/runtime-owner.ts';
import { setup } from './harness.ts';
import { modernHandler } from './fixtures.ts';

test('unfocused modern dispatch rejects a cold pin without preparing it and reuses a ready exact instance', async t => {
  const h = await setup(t, await modernHandler(), ['intent']);
  const {handlers: [handler]} = await h.catalog.list({user: h.source.user, assertActive() {}});
  const first: NappletDescriptor = {...handler!, id: 'cold', source: 'published'};
  const ready = {...first, id: 'ready'};
  let workspace = emptyWorkspace();
  const identity = { getSnapshot: () => ({
    phase: 'ready', session: {epoch: h.source.epoch, vault: {selectedPubkey: h.source.user}, workspace: {
      getSnapshot: () => ({workspace, error: null}),
      change: () => assert.fail('focus:false must not change the workspace'),
      flush: async () => {},
    }},
  }) } as unknown as Pick<IdentityTransition, 'getSnapshot'>;
  const runtime = {publishedReadyGeneration: (session: NappletDescriptor) => session.id === ready.id ? 'ready-generation' : null,
    prepareInstalled: async () => assert.fail('cold focus:false must not prepare a session'),
  } as unknown as RuntimeOwner;
  const targets = createRoutingTargets(identity, () => runtime, h.reviews, h.native);
  const activate = () => targets.activate(handler!, {archetype: 'napptest', action: 'open', behavior: {focus: false}},
    new AbortController().signal, () => {}, h.source, h.native.state().revision);
  assert.equal(await activate(), null);
  workspace = openNapplet(workspace, first);
  assert.equal(await activate(), null);
  workspace = openNapplet(workspace, {...ready, eventId: '1'.repeat(64)});
  assert.equal(await activate(), null);
  workspace = openNapplet(openNapplet(emptyWorkspace(), first), ready);
  assert.equal(await activate(), ready.id);
});
