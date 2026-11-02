# Optional close check

`hypergolic.close-check.v1` is a versioned Hypergolic-specific extension. It supplies the retained clean/dirty/unknown close
behavior without claiming a new standardized NAP operation.

The selected [NAP-SHELL revision](https://github.com/napplet/naps/blob/5ac0490461ca6fec2f0d2e45b4835cf9bc08de24/naps/NAP-SHELL.md)
and [checked revision](https://github.com/napplet/naps/blob/e5308ac92cfd49e4fb026812c60886571515e219/naps/NAP-SHELL.md)
have no close-state operation. The newer discovery semantics are not selected.
Any future standard requires a separate specification review and migration decision.

## Guest contract

Discover the optional service through the existing `shell.services()` surface. It
is available to admitted bundled and verified-published sessions. It adds no NAP
domain, permission, signing grant or network authority.

Host to the captured live guest:

```js
{type: 'hypergolic.closeCheck', id: 'fresh-host-correlation'}
```

Guest to its parent, with exactly these fields:

```js
{type: 'hypergolic.closeCheck.result', id: 'fresh-host-correlation', state: 'clean'}
```

`state` is `clean`, `dirty` or `unknown`. IDs contain 1–80 ASCII letters, digits,
underscores or hyphens. Respond promptly: the shell has a **500 ms** deadline,
measured from its request. Forwarding/native scheduling consumes part of that
budget. Missing, unsupported, malformed, oversized, late, replayed and wrong-source
replies never establish clean state. They retain the ordinary warning.

```js
addEventListener('message', event => {
  const value = event.data;
  if (!event.isTrusted || event.source !== parent || !value ||
      Object.keys(value).length !== 2 || value.type !== 'hypergolic.closeCheck' ||
      typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.id)) return;
  parent.postMessage({type: 'hypergolic.closeCheck.result', id: value.id,
    state: hasUnsavedWork() ? 'dirty' : 'clean'}, '*');
});
```

The guest iframe has an opaque origin. `'*'` targets its captured parent or guest
WindowProxy; it does not replace exact source checks. See
[MDN postMessage security guidance](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage).
Use `unknown` when the guest cannot determine whether its own work is saved.

## Host behavior and safeguards

An upward overview-card close gesture starts one ephemeral check. The shell binds
it to its actual descriptor, identity and native generation. The runtime accepts
only its fixed native control message and a response from the captured live guest;
the native host accepts only its existing main-frame diagnostic lane and generation.
The guest supplies no authoritative identity, publisher, session or generation.

Clean closes through the existing teardown path once, provided host work is safe.
Dirty or unknown opens the existing trusted warning with **Keep open** as the
default. Keep open preserves the loaded guest and draft. Close anyway uses the
existing approval cancellation, capability revocation and workspace removal path.
Background/inactive, identity changes, destruction and content replacement invalidate
pending checks; no clean declaration is saved or reused after restoration.

Pending approvals/preparation, active uploads and outstanding native replies block
immediate clean close. Each native host tracks up to 64 pending replies and uses
its existing maximum publication lifetime (660 seconds) as a conservative bound;
overflow also retains the warning for that bound. Uncertain publication outcomes
remain an in-memory per-session advisory risk until explicit close or identity revision, even
when the status UI is dismissed. Uncertain upload outcomes also survive dismissal.
Saved native upload recovery metadata is checked for the same publisher/application;
unavailable or invalid evidence retains the warning. These reads grant no retry or
network check authority. Closing a session does not erase the native upload journal.

A guest may lie about its own unsaved state. This advisory extension cannot promise
honest guest retention; keys, side effects and other sessions retain their independent
native authority. It does not publish or otherwise commit a guest's work.

## Development verification and remaining acceptance

Close Lab is a theme-only bundled fixture with pinned HTML/aggregate hashes. Its
text draft and Auto/Unknown/No reply modes exercise close behavior without a
signer or upload/publication authority. Open it from Developer Settings. The
normal app entry remains unchanged.

```sh
pnpm run test:shell
pnpm run test:capabilities
pnpm run runtime:test
```

Shared/native checks cover single use, source/correlation/generation, deadline,
lifecycle cancellation, pending work, dismissed uncertainty and saved upload
recovery. Runtime checks include legacy silent guests, bundled/verified published
artifacts and forged sibling/control/replay messages. Browser artifact sinks and
Simulator fixtures do not prove ordinary native published admission or complete
security. Full standalone bundled/published close, surviving data, cold restore
and Phase 2/3 acceptance remain open; see [testing](testing.md).
