# Shared native signing primitive

The shared native signing core uses bitcoin-core/secp256k1 v0.8.0 at
`6e2c8bc4ecdc6e71dbe7a368f360d8d453ce435d`. The unmodified source archive,
MIT license and per-file hashes live under `../vendor/`. The compile manifest
selects extrakeys, Schnorr and ECDH; recovery, MuSig, ElligatorSwift and
Silent Payments are not enabled. No cryptographic primitive is implemented here.

`include/hypergolic_signer.h` exposes an opaque native key handle, generation,
x-only public key lookup, fixed 32-byte digest signing, verification, public-point validation and destruction.
Native-only import accepts exactly a valid 32-byte scalar. Native-only serialization
uses `secp256k1_keypair_sec` to derive that scalar, passes a temporary buffer to one
synchronous native sink and clears it before returning, including on sink failure.
It never persists the opaque upstream keypair representation.
Native NIP-44 encrypt/decrypt additionally use opaque handles, OS HMAC-SHA256
callbacks, Monocypher 4.0.3 and bounded native output sinks. Neither scalar nor
shared-secret getters are exposed; see the [NIP-44 contract](../tests/nip44/README.md). The native caller
must protect and clear any sink-owned copy, clear its import input, and never cross
a JavaScript boundary with either operation. The caller must serialize use and destruction;
handles cannot be used after destruction. The platform adapter supplies native OS
CSPRNG entropy and must enforce immutable event review and native one-use approval
before calling signing. These C functions must never be registered as Expo exports.

Generation rejects invalid sampled keys with a 128-attempt bound. Import rejects
zero, out-of-range and wrong-length input before creating a key. Both creation
paths require OS entropy to randomize their context. Signing requires
fresh context randomization and BIP-340 auxiliary randomness and fails closed on
entropy failure. Temporary secret buffers are cleared. Destruction clears the full
owned keypair and preallocated context before freeing them. This bounds owned
memory; it is not hardware-contained signing, process isolation or protection
against a compromised app process. The primitive itself keeps keys in memory;
protected persistence and import UI are the native platform authority's responsibility.
The C API creates no storage or JavaScript bridge surface.

Android can `add_subdirectory` this directory and link `hypergolic_signer`. iOS must
compile the shared C file and the three upstream C files with the definitions in
`../vendor/secp256k1-manifest.json`, including hidden visibility. The configuration
uses upstream default precomputation sizes and portable C without assembly. Native
wrappers must enforce input buffer lengths before calling the fixed-size C API.

From the repository root:

```
python3 modules/signer-core/tests/run-host.py
python3 modules/signer-core/tests/run-host.py --sanitize
python3 modules/signer-core/tests/nip44/run.py --sanitize
```

The host runner verifies the vendored file set and hashes before compiling. It
runs every official BIP-340 verification vector; the production wrapper covers the
15 fixed-digest vectors and four exact signing vectors. The other four message
lengths are verified directly by upstream and are not exposed by this wrapper.
Allocator interposition in this host test checks owned buffers immediately before
free, allocation failures, and leak-free cleanup. A host-only cleanup observer
checks temporary scalar bytes while their stack lifetime is still active. The suite
also round-trips all four fixed-digest signing vectors through import/serialization,
rejects invalid lengths and curve-order boundaries, and tests callback and entropy
failure cleanup. Deterministic test entropy is
confined to the host test. Mobile authority, UI, OS entropy, protected storage and
physical-device acceptance require separate evidence.

[Upstream release](https://github.com/bitcoin-core/secp256k1/releases/tag/v0.8.0)
was checked against GitHub's live latest-release metadata and the peeled tag commit.
GitHub displays a verified tag signature with an expired key. Independent local GPG
verification was not performed because GPG is unavailable; the manifest records
this limitation. Source review, pins and vector tests do not constitute a security
audit or comparative security with another signer.
