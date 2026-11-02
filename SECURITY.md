# Security

Hypergolic is a development preview. Native signing, storage, external-signer
integration and capability isolation have focused checks; full Android/iOS
security and recovery acceptance remains open. No supported stable release is
declared yet.

## Report a vulnerability

Use **Report a vulnerability** in this repository's Security tab when private
reporting is enabled. If that option is unavailable, open an issue requesting a
private contact channel without including the exploit or sensitive details.

Include the affected revision/platform, a minimal reproduction with disposable
identities, expected and observed behavior, and the suspected trust boundary.
Never include private keys, live signer connection links, credentials or personal
device data. Coordinate disclosure after a private channel is established.

## Security boundaries

Napplet code is untrusted even when its publisher signature verifies. Native
owners control keys, approval and privileged effects. Signing methods are chosen
explicitly; an unavailable external signer must not trigger local-key fallback.
Cancellation after dispatch can leave the outcome uncertain and must not cause
automatic resubmission.

See the [architecture](docs/architecture.md), [signing core](docs/signing-core.md),
[capability contract](docs/capability-contract.md), [dependency patches](docs/dependency-patches.md)
and [test plan](docs/testing.md) for the selected boundaries and verification gaps.
