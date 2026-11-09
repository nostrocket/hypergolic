# Native Mesh authority proof

This component implements native source and permit accounting for the selected Hypergolic Mesh profile. It does not install a bridge, signer, peer transport, store, grant UI or advertised Mesh support. The four-method contract remains [NAP-MESH bf9a472](https://github.com/napplet/naps/blob/bf9a4722244e29661c06d2fb4db7d3c7346d064a/naps/NAP-MESH.md).

Run from the repository root with the existing pinned JDK and Kotlin cache:

```sh
python3 -B tests/native/mesh-authority/run.py --output /tmp/mesh-authority-proof
```

The output directory must not exist. A private source export without `.tools` can pass `--java-home` and `--gradle-cache` pointing to an existing read-only pinned tool cache. No dependency installation is performed. The proof needs JDK17-compatible tooling, the repository's cached Kotlin2.2.21 compiler dependencies, and macOS Xcode `swiftc`/CryptoKit. It compiles the actual authority files and existing NativeCanonicalJSON helpers, with Java/Swift warnings treated as errors. It records source/tool hashes, commands and logs, then checks both implementations against independent Python JSON/UTF-8/SHA-256 and fixed-transcript vectors.

The source owner must be created once by the native host. The limits below are per authority instance, not process-wide merely because this class exists:

- Two reserved workers and four waiting jobs; publication deadline15s from admission, pairing deadline at most120s from admission and original invitation expiry. Promotion never renews either deadline.
- Twenty admitted publications/s per registered source, burst40; publication TTL cap2, subscription cap1 and incoming-forward cap2 are selected defaults. This component implements publication permits; the latter two are constants for later integration.
- Up to64 native source registrations/grant records and32 pending terminal delivery leases.

## Source and lifecycle boundary

`Source` construction is native-only. Its fields must come from the actual verified publication/native registration and semantic Mesh grant: endpoint, generation, selected user/epoch/vault/revision, publisher/app ID/version/instance, grant revision and circle revision. The setters are trusted native composition APIs, not proof that a string supplied by JavaScript is current. The future native facade must derive them from the owning registries and selected local vault. No guest Relay, Outbox or Identity grant is inferred or required. A selected nonlocal/unavailable signing method disables the authority; there is no fallback.

The semantic consent explicitly covers reading stored/live circle events and repeated signing as the account without per-event prompts. Only an open, granted source in the app foreground remains current. There is no focus bit: another card's focus does not revoke an open source. Background, close/replacement, account/epoch/vault/method change, semantic grant revision/revoke and circle/unpair invalidate old work. Fast resume or A→B→A cannot revive old registrations, permits or terminal deliveries. UTF-8 grant keys retain canonically distinct app IDs.

`startNext` reserves a worker before dispatch and `begin` is one-use. Logical cancellation never releases the reservation. The owning worker must call `drained` only from its actual finally/unwind after signing/IO has stopped. The future actor/transport must actively close cancelled IO and use `current` at its own boundaries; this proof does not demonstrate socket drain. One shared authority is required to make the selected two-worker limit host-wide.

## Exact publication boundary

`admitPublication` captures content/tags immediately, selects the native account and wall timestamp, clamps TTL and constructs the immutable canonical NIP01 bytes/hash. A guest-provided timestamp has no parameter in this API; the future typed bridge may accept it as provenance but must not forward it as authority. Existing dedicated authentication kinds22242/24242 are denied. The final signed `['EVENT',event]` UTF-8 frame must fit8192B; cumulative encoded tags are bounded before building the final event. No application JSON inside content is parsed.

NIP40 expiration tags must be unique, exact two-field decimal timestamps and future at capture. Wall expiration and the original monotonic deadline are checked again before signing, after the signer callback and before enqueue. Expired or malformed input is denied even though native `created_at` replaces the guest timestamp.

`signPublication` spends the signing claim before invoking a synchronous native `PublicationSigner` on the exact capture. It returns and retains a private-constructor `SignedPublication`, containing immutable event JSON, relay frame and signature. `performPublication` requires this exact permit-owned brand and byte-equal proposed frame before spending its one-use effect. Its typed callback receives only the stored signed capture. The native actor must enqueue/store bytes from that capture, never a mutable caller payload. Changed kind/content/timestamp/author/ID/signature, foreign or same-wire-other-permit captures cannot consume it. A throwing signer cannot be retried; a throwing enqueue remains attempted/uncertain and retains the worker slot until drain.

The callback is a native trust boundary. Integration must use the selected vault under the same current permit and verify actual BIP340 output. The proof deliberately uses inert signature-shaped strings and makes no authenticity claim about them. It does not grant arbitrary digest/event signing through JavaScript.

## Distinct pairing boundary

Pairing has a separate native request and explicit one-use native confirmation; a Mesh source grant is not pairing consent. Native invitation/UI state supplies the role and approved local record. Guest-supplied binding fields are never approval evidence.

The fixed transcript is276 bytes: ASCII `hypergolic.mesh.pairing.v1` plus NUL (27B), signer-role byte1 inviter/2 joiner, invite ID16B, secret SHA25632B, inviter user32B, joiner user32B, inviter SPKI pin32B, joiner SPKI pin32B, inviter nonce32B, joiner nonce32B, expiry uint64BE8B. Role order is fixed; no arbitrary digest parameter exists. A same-account pair is allowed, but device pins and fresh nonces must differ. Role separation prevents one signature from serving as both same-account participants.

`signPairing` retains a private `SignedPairing`; `performPairing` requires exact permit/brand and340B local binding (transcript plus64B signature). It authorizes sending that local proof only. It does not authorize completed membership persistence. A later integration must verify both account signatures against their own roles, exact approved device pins/invitation and both confirmations, then atomically store membership. Stored completed pairs may outlive invitation expiry; this component has no persistent pair store.

A circle store must distinguish device credentials from account members. Multiple approved remote devices of one user count once; another device of the selected same account contributes that user once. This authority permits that pairing but does not invent reachability/member counts.

## Proof coverage and limits

The focused Java/Swift tests cover immutable capture and native timestamp, TTL0/clamp, exact frame boundary and malformed Unicode, quota/queue deadline/rate bounds, semantic/account/vault/method/circle/source invalidation, completed→background→resume→delivery, foreign-owner no-effect controls, one-use/throwing/reentrant signer and enqueue, role-specific and same-account transcripts, pair expiry and NIP40 admission/queue/sign/enqueue expiry. Both implementations must match the same nine independent vectors. The inviter transcript also matches the separate C pairing encoder vector.

This is component evidence. Full source-registry/vault/signature binding, native pairing UI, secure credential persistence, mutual TLS, LAN permission/discovery, persistent non-ephemeral storage/backlog, ephemeral live handling, incoming verification/dedup, blob presence and all runtime methods remain separate required integration work. No Myco/FIPS interoperability or ordinary device acceptance is asserted.
