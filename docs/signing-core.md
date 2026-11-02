# Native signing core

Production identity operations and signing use a public-only native vault
interface. Native owners perform secret generation/import, persistence, review,
backup and cryptography. JavaScript receives public snapshots, opaque candidates
or signed public events. No incoming signer-provider interface is implemented.
Full Phase 2/3 and protected-device acceptance remain open; see [testing](testing.md).

## Authority and key boundary

The trusted shell claims its native identity-owner context before activating the
signer. AppContext/runtime identity, epoch, vault ID/revision, request source and
lifecycle are checked natively. JavaScript cannot supply a consent decision,
entropy source, secret, arbitrary owner or private cryptographic handle.

Local keys live in opaque C allocations. OS entropy supplies generation, context
randomization and per-signature auxiliary randomness. Wrappers serialize access
and clear owned buffers before release. This is an app-process boundary, not
process isolation or hardware-contained secp256k1 signing.

Native input accepts exactly `pubkey`, `created_at`, `kind`, `tags`, `content`.
Reject duplicate/extra fields, malformed Unicode/escapes, ambiguous integers,
wrong public keys and oversized input. Canonical event limit is 2 MiB UTF-8 plus
256 bytes for the input wrapper. Timestamps are nonnegative safe integers; kinds
are 0–65,535; tag rows contain at least one string. Native NIP-01 canonicalization
determines the digest. Independently verify signature, ID and every approved field.

## Production Expo interface and future provider boundary

The authoritative declarations are
[`NativeVaultModule`](../src/security/native-vault-contract.ts), Android
[`SignerCoreModule`](../modules/signer-core/android/src/main/java/org/nostrocket/hypergolic/signercore/SignerCoreModule.kt)
and iOS [`HypergolicSignerCoreModule`](../modules/signer-core/ios/HypergolicSignerCoreModule.swift).

| Group | Exports |
| --- | --- |
| Entry | `activateNativeVault`, `isNativeVaultAvailableAsync`, `openNativeVaultAsync` |
| Import/selection | `prepareNativeImportAsync`, `cancelNativeImport`, `commitNativeImportAsync`, `selectNativeIdentityAsync` |
| Methods | `getNativeSigningMethodsAsync`, `selectNativeSigningMethodAsync`, `disconnectNativeSigningMethodAsync`, `deleteNativeLocalKeyAsync` |
| NIP-46 | `prepareNativeRemoteConnectionAsync`, `cancelNativeRemoteConnection`, `commitNativeRemoteConnectionAsync` |
| Relay refresh | `prepareNativeRemoteRefreshAsync`, `cancelNativeRemoteRefresh`, `commitNativeRemoteRefreshAsync` |
| Android connection | `prepareNativeAndroidSignerAsync`, `cancelNativeAndroidSigner`, `commitNativeAndroidSignerAsync` |
| Protected actions | `isNativeVaultAuthenticationAvailableAsync`, `showNativeBackupAsync`, `deleteNativeIdentityAsync`, `cancelNativeVaultAction` |
| Source-bound signing | `reviewAndSignNativeEventAsync`, `cancelNativeSigning`, `nativeSigningHandoffState`, `nativeRemotePreparationHandoffState` |

These trusted-shell interfaces are not guest APIs. iOS supports local/NIP-46;
Android-signer prepare/commit require a valid lease then fail `SIGNER_UNSUPPORTED`.
A future provider needs separate caller authentication, permissions/storage,
revocation and lifecycle decisions. No outgoing grant authorizes incoming callers.

## Production vault and lifecycle

The separate native namespace distinguishes an absent store from missing/corrupt
established state; only genuinely absent state may initialize. Mutations require
durable write and decrypted readback under current native ownership. Do not
automatically migrate or erase the pre-release JavaScript account namespace.
See [storage](identity-storage.md) and [transitions](identity-switching.md).

Native UI accepts `nsec`. Two-minute candidates bind owner, vault revision and
original deadline; cancellation/ownership loss clears them. Import, selection and
method changes require workspace flush and exact native confirmation. Backup and
deletion require OS authentication. iOS carries one absolute 60-second monotonic
deadline through authentication, backup read/reveal and both deletion permits;
delayed timers do not extend it. Cleanup can clear only its own auth attempt.
Opening on iOS may wait once for activation, then recheck original owner/epoch,
protected data and deadline; other operations remain blocked during opening.

Ordinary approval, Outbox, Blossom authorization and fixture publication pass a
captured native source, frozen public event and expected vault revision. Native
review checks source and destination; a shared approval flag is insufficient.
Ordinary signing denies relay-authentication and upload-authorization kinds;
dedicated lanes preserve their exact-byte/destination policy.

iOS assigns each preparation/sign request an operation ID: panels, tasks, timers
and callbacks must still own it. Late success/failure cannot consume or clear
replacement work. Android closes undelivered prepared resources when prompt
cancellation wins and notifies each captured handoff of cancellation at most once.
Stale callbacks cannot cancel a replacement request.

Post-write loss of authority closes cached state as uncertain. After possible
external dispatch/result, final guards, Resume, completion and handoff validation
must not imply nothing was signed. Wrong/duplicate IDs, explicit refusal and
invalid events remain distinct failures. Local/result-completion mapping retains
readback, recovery and storage errors. Source captures remain independently
revocable, with bounded capacity for concurrent approved uploads. See
[external signing](external-signing.md).

Generic SecureStore is restricted by a tracked configuration-only native patch:
all five data exports require the exact configuration service, scope format and
protection options. Both platforms build it from source. Legacy account records
and aliases are preserved, not silently exposed or deleted through that bridge.

## Cryptography and provenance

The primitive uses unmodified [secp256k1 v0.8.0](https://github.com/bitcoin-core/secp256k1/releases/tag/v0.8.0),
commit `6e2c8bc4ecdc6e71dbe7a368f360d8d453ce435d`, with extrakeys, Schnorr and
ECDH. The source manifest pins hashes/definitions/license; both products package
the MIT original. BIP-340 vectors are pinned at bitcoin/bips
`927b6de9915c9262615a6399de51b200f81e5aa4`. Pins/vectors are not an audit.
See the [primitive contract](../modules/signer-core/shared/README.md).

## Native remote encryption

NIP-44 v2 follows [a79e21d](https://github.com/nostr-protocol/nips/blob/a79e21d90fce5465b50ef385dd368bba99ec4a0b/44.md),
including extended length prefixes. Opaque keys, upstream ECDH, unmodified
Monocypher 4.0.3 ChaCha20 and platform HMAC-SHA256/OS entropy remain native.
Bound before allocation, authenticate MAC before decryption and clear owned
temporaries. The caller verifies outer signature, peer and recipient before
decrypting. No encryption/shared-secret Expo API exists.

Plaintext limit is 4,202,496 bytes; encoded payload 6,990,604 bytes. Enforce strict
UTF-8, canonical padded base64, exact padding/prefix bounds and zero padding.
The [NIP-44 contract](../modules/signer-core/tests/nip44/README.md) owns complete
allocation/framing limits, vectors and upstream provenance.

## Native handoff response validation

Validate preflight relay equality before releasing a paused source. Changed relays
produce `SIGNER_RELAYS_CHANGED`; an earlier Resume cannot override that. Only
explicit connection/refresh may propose new relays for confirmation. Every result
retains request/account/event binding and native signature validation. NIP-55
alias compatibility never replaces required result fields. See the
[external-method profile](external-signing.md).

## Disposable trace

`activateEphemeralSigner`, `generateDisposableIdentityAsync`,
`reviewAndSignDisposableEventAsync`, `cancelDisposableReviewAsync` form a separate
developer trace, never forwarded to napplets. It imports/exports/persists no key
and publishes nothing. Native review alone consumes an operation. The ephemeral
key expires within ten foreground minutes; regeneration cannot extend its
deadline. Background/runtime destruction destroys it; later explicit activation
may start a new disposable session.

## Reproducing checks

With pinned toolchains available:

```sh
python3 modules/signer-core/tests/run-host.py --sanitize
python3 modules/signer-core/tests/nip44/run.py --sanitize
pnpm run test:signer
python3 tests/native/signer-core/run.py --platform android --suite core --serial EMULATOR_SERIAL
python3 tests/native/signer-core/run.py --platform ios --suite core --udid SIMULATOR_UUID
```

The [central runner](../tests/native/signer-core/README.md) documents `migration`,
`nip46`, Android `nip55` and applicable `all` suites. `migration` tests the new
vault, not legacy-account migration. iOS fixture storage ports are explicit
doubles; production protected storage stays unavailable on Simulator. Unknown
suites, unavailable targets and zero cases must fail.

Keep `index.signer.fixture.tsx` and integrated bridge proofs under separate
disposable IDs; never install them over retained apps. Use fresh outputs and
the [Android](../tests/native/signer-core/android/bridge.py)/
[iOS](../tests/native/signer-core/ios/build-bridge.py) driver contracts. Focused
regressions cover [durability](../tests/native/signer-core/vault-durability/README.md),
[action timeout](../tests/native/signer-core/action-timeout/README.md),
[operation completion](../tests/native/signer-core/operation-completion/README.md),
[panel cancellation](../tests/native/signer-core/panel-cancellation/README.md),
[relay ordering](../tests/native/signer-core/relay-ordering/README.md) and
[remote uncertainty](../tests/native/signer-core/remote-operation/README.md).
These checks have distinct host/fixture/ordinary-app scopes; full acceptance
remains open in [testing](testing.md).
