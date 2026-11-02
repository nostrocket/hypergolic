# Staged native NIP-44 v2

This native implementation implements the NIP-44 framing selected by the pinned specification
revision `a79e21d90fce5465b50ef385dd368bba99ec4a0b`. The shared C and build definitions are integrated; the
native relay connection, signer transport and platform adapters require their own evidence.

The native C API takes an opaque signer key, a checked 32-byte x-only peer key,
length-bounded UTF-8/base64 bytes, an OS HMAC-SHA256 callback and a synchronous
native output sink. Encryption also requires a native OS entropy callback for its
32-byte nonce. There is no public scalar, shared-secret or conversation-key getter.
The private ECDH helper derives a temporary scalar with `secp256k1_keypair_sec`,
validates the peer point with its even-y compressed representation, uses upstream
ECDH's raw-x callback and clears the scalar. Context creation retains the core's
OS entropy/randomization requirement. This remains an app-process boundary.

Before calling decrypt, the native NIP-46 owner **must validate the outer NIP-01
signature/event and exact remote peer**. C cannot establish event/request authority
from an encrypted string alone. No encrypt/decrypt method belongs on the Expo
bridge. Decrypted RPC content remains in the native request-correlating authority;
only checked public results may return to the shell. Output/HMAC/entropy callbacks
must return normally, protect and clear any copies, and never cross JavaScript.

The shared code implements bounded HKDF orchestration, padding and base64 framing,
not a SHA256, HMAC, ChaCha or EC primitive. HMAC-SHA256 belongs to Android's `Mac`
provider and iOS's CommonCrypto/CryptoKit provider. Monocypher's unmodified
`crypto_chacha20_ietf` supplies RFC-8439 ChaCha20 with counter zero;
`crypto_verify32` supplies the MAC comparison and `crypto_wipe` supplies cleanup.
Decrypt authenticates before decrypting or handing plaintext to the sink.

The selected RPC UTF-8 limit is **4,202,496 bytes** (4 MiB plus 8,192). The maximum
padding bucket is 5,242,880 bytes, the extended prefix is six bytes, the maximum
raw frame is 5,242,951 bytes and the maximum base64 payload is 6,990,604 bytes.
Encoding bounds are checked before base64 allocation; plaintext length is checked
before padding allocation. C reuses one frame for in-place encryption/decryption.
Callbacks may create additional native memory and must respect the same limits.
The RPC owner embeds an already-canonical event JSON string, whose escaped form
fits the selected doubling allowance; an oversized RPC fails before transmission.
All arithmetic is bounded below `size_t` overflow on a 32-bit native target.

Decoding accepts canonical padded RFC-4648 base64 only, strict UTF-8, canonical
u16/u32 prefixes, the exact expected padding bucket and zero padding bytes. It
rejects unsupported versions distinctly, including the leading `#` marker. Empty,
oversized, malformed, unauthenticated or invalidly padded input cannot reach a sink.

## Owning sources

- [Pinned NIP-44](https://github.com/nostr-protocol/nips/blob/a79e21d90fce5465b50ef385dd368bba99ec4a0b/44.md): exact SHA256
  `b5f89374e4e1dbdee7881e8573b4313b6a89430a9c8d518471599ae0660cf0e2`.
- [Official NIP-44 vectors](https://github.com/paulmillr/nip44/blob/main/nip44.vectors.json): verified SHA256
  `269ed0f69e4c192512cc779e78c555090cebc7c785b609e338a62afc3ce25040`.
  The checksum is authoritative even though its retrieval URL uses `main`.
- Existing pinned bitcoin-core/secp256k1 v0.8.0, commit
  `6e2c8bc4ecdc6e71dbe7a368f360d8d453ce435d`; all existing source hashes verified.
  Integration enables upstream's optional ECDH module; vendor source is unchanged.
- [Monocypher official download](https://monocypher.org/download/) identifies 4.0.3
  as current. Its [GitHub tag](https://github.com/LoupVaillant/Monocypher/tree/ab2b16dd619ad5f6979a4fbe69cfa324a6fcc35f)
  points directly to commit `ab2b16dd619ad5f6979a4fbe69cfa324a6fcc35f`.
  The official archive matches its published SHA512. The manifest records the
  archive, selected original C/header/license and exact checksums. No independent
  signature verification or comparative security audit is claimed.

The official checksum-pinned vector file predates extended prefixes: its invalid
length list contains 65,536 and 100,000. The owning pinned NIP-44 explicitly permits
those lengths. The suite retains and exercises both as accepted extension cases;
zero and ten million remain denied under this selected resource profile. It also
checks the pinned spec's exact payload hashes for 65,535/65,536/65,537.

## Host verification

From the repository root, run `python3 modules/signer-core/tests/nip44/run.py`,
optionally adding `--sanitize`. Generated fixtures and payloads stay in a temporary directory. The owning build uses the pinned secp256k1 files, unmodified Monocypher,
and CommonCrypto's HMAC/SHA256 primitives. All official conversation/message-key,
padding, encryption, long-message and negative vectors execute. Tests observe
allocation bytes before free and temporary buffers while still alive, exercise
entropy/HMAC/allocation/sink faults, wrong peers, authenticated invalid UTF-8/padding,
source bounds, and compare full C payloads with the already-installed nostr-tools
implementation at all three prefix boundaries and the selected maximum.

The intermediate-key/test helper exports and deterministic test entropy compile
only under host test definitions. Production builds expose only the native
opaque-handle API and compile no test hook. Host results do not prove Android/iOS
HMAC adapters, native OS entropy, NIP-01 prevalidation, peer/request binding, relay
operation, protected storage, lifecycle or installed bridge behavior.

## Owning integration surface

`shared/include/hypergolic_nip44.h`, `shared/hypergolic_nip44.c` and the private
`shared/hypergolic_signer_internal.h` implement the API. The private ECDH helper
lives in `shared/hypergolic_signer.c`. Public-point metadata validation uses
`hypergolic_signer_public_key_valid` and requires an exact 32-byte native input.

Vendor the unmodified Monocypher C/header/license with its provenance manifest.
Add the C source/include path and `ENABLE_MODULE_ECDH=1` to both shared CMake and
iOS compile definitions. Android uses the shared CMake product; iOS must compile
both new owning C sources and Monocypher with hidden visibility. Keep other
secp256k1 optional modules disabled. Preserve all upstream required licenses in
both packaged mobile notice bundles. Add the native HMAC/OS entropy/output adapters
inside the NIP-46 owner, and test actual request/signature boundaries before claiming
transport acceptance. The shared CMake and podspec compile definitions include ECDH and Monocypher.
The isolated native fixture builds use those same sources. Host checks do not
claim installed platform crypto or transport acceptance.
