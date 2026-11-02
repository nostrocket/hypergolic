# Identity storage

## Current native vault

Production account operations use the native signing vault. The trusted owner
activates `HypergolicSignerCore` before opening
[`NativeIdentityVault`](../src/security/native-identity-vault.ts). React Native
receives public snapshots and opaque handles; generation, secret entry,
persistence, backup and signing remain native. See [signing core](signing-core.md)
and [external methods](external-signing.md).

The native owner admits one identity bootstrap per OS process, preventing a
replacement React runtime from opening competing services. Vault/account/epoch
checks apply around asynchronous work and mutations. Only a completely absent
store may initialize. Missing established state, corrupt metadata, unavailable
keys and unknown writes require recovery without replacement identities.

### Android

[`NativeVaultFile`](../modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore/NativeVaultFile.java)
stores one AES-GCM authenticated record using `AtomicFile` in app no-backup
storage with an Android Keystore wrapping key. Writes check descriptor sync before
`finishWrite`, containing-directory and parent-directory sync after replacement,
then decrypted readback. Parent sync covers first directory creation. `AtomicFile`
owns stream/finish/fail lifecycle; its void/log-only finalization is not an
observable success result. Post-rename sync failure remains uncertain even if
proposed bytes can be read; never convert it to success or automatically retry.

The wrapping key requires unlocked state on API 28+. Matching filesystem,
Keystore, older-Android and power-loss behavior need device validation. The
[durability harness](../tests/native/signer-core/vault-durability/README.md) uses
actual file orchestration with explicit Android/Keystore/AtomicFile doubles; it
does not establish hardware protection or power-loss durability.

### iOS

[`NativeSignerVaultStorage`](../modules/identity-store/ios/NativeSignerVaultStorage.swift)
uses one AES-GCM authenticated file in a separate native namespace. The wrapping
key and guard receipt use `WhenUnlockedThisDeviceOnly` Keychain storage. Enforce
complete file protection, backup exclusion, permissions, fixed regular-file paths,
atomic replacement and decrypted readback. Inconsistent established state fails
closed.

## Simulator limitation

Simulator lacks required protected-file behavior and is rejected; production has
no alternate backend or bypass flag. Availability is an environment preflight,
not proof that subsequent storage operations will satisfy their guards. Public
fixture identities test shared UI without claiming protected persistence,
authentication or signing. The entry restriction and physical tests are separate
from those fixtures; see [testing](testing.md).

## Namespace transition and recovery

The new vault intentionally starts in its own namespace. Pre-release SQLite
identity journals and Expo SecureStore account records are not automatically
migrated or erased. Workspace and ordinary nonsecret SQLite stores remain
separate from the account commit boundary. Removing a native local method or
account does not claim deletion of legacy key copies.

A native mutation must durably write and verify readback before public success.
Known pre-effect cancellation differs from uncertain acknowledgement after a
possible commit. Uncertainty revokes cached authority and requires recovery;
old workspace authority cannot continue under an assumed account selection.
Keep existing corrupt/incomplete records intact. Never clear them based on logs
or silently initialize a replacement. Generic SecureStore's tracked patch limits
data exports to the exact native configuration service/scope/protection profile;
it is not a secret-vault compatibility bridge.

## Native authentication and Settings integration

Authentication binds the exact live native owner/session, action, account, vault
revision and deadline. No Expo method accepts an authentication outcome,
inventory, secret path or replacement runtime identity. Backup, local-key removal
and account deletion use separate exact-action permits. Cancellation, lock,
background/protected-data loss and replacement ownership revoke work. Late
callbacks/cleanup affect only their own attempt.

Android's current action adapter requires API 30+ and a device credential or
strong biometric; no-lock/unavailable devices cannot enable the action. API
26–29 action support remains a compatibility gap, not a new app minimum. Android
authentication and reveal each have a 60-second bound. iOS uses fresh
`deviceOwnerAuthentication` with passcode fallback and no biometric reuse window;
missing passcode or Face ID usage description leaves the action unavailable.

iOS carries one absolute 60-second monotonic deadline through authentication,
backup read/reveal and both deletion permits. Delayed timers cannot extend it.
Protected action denial keeps known unchanged state; a failed/uncertain durable
write requires recovery even if a later read returns expected bytes or absence.
See [account transitions](identity-switching.md) for inactive deletion and workspace
retention. Unsupported authentication leaves the action unavailable.

## Manual backup

Review names the selected local account's public key before explicit
authentication. Native UI alone renders `nsec`; shared code receives completion
only. No clipboard/share operation or secret bridge return is provided. Nsec
uses [NIP-19 01e707b](https://github.com/nostr-protocol/nips/blob/01e707bacdc87cf262db80545aecaa8f17ac2a4f/19.md):
ordinary Bech32, `nsec`, 32-byte nonzero secp256k1 scalar.

Android uses a `FLAG_SECURE` native panel and excludes secret content from
accessibility, autofill and content capture. Owned mutable buffers clear on hide,
focus loss, background, cancellation or expiry. This does not guarantee erasure
of immutable Java/JSON strings or platform rendering buffers.

iOS starts concealed, warns that screenshots cannot reliably be prevented,
remains concealed during recording/mirroring and clears before app-switcher
snapshots. Dismissal requires fresh authentication. No secure-text-field layer
workaround is part of the design. Native readiness/activation waits preserve the
original owner, protected-data and absolute auth deadline. After successful iOS
backup authentication, at most five seconds may be spent waiting for active UIKit
before reading material; background/protected-data loss cancels that wait. This
does not extend the absolute 60-second attempt. Authentication success
alone does not establish safe presentation readiness.

Keep independent backups for any imported key. Bulk application-data export and
migration are separate unfinished features. Local-key removal keeps the account,
connections and napplet data; inactive-account deletion removes its methods.
Neither operation guarantees deletion of independent backups or legacy namespaces.

## Verification

```sh
pnpm run test:signer
pnpm run test:security
pnpm run test:storage
```

Use [signer suites](../tests/native/signer-core/README.md),
[configuration bridge checks](../tests/native/securestore-config/README.md) and
[backup panel checks](../tests/native/identity-unit/ios-backup-panel/README.md)
for their explicit source/OS-double scopes. Earlier legacy-vault runtime results
do not establish acceptance of the new namespace. Physical at-rest protection,
authentication/capture, backup/deletion, recovery and full Phase 2/3 route
acceptance remain open; see [testing](testing.md).
