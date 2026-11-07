# Private Mesh TLS dependency

Mbed TLS 4.2.0 and its matching TF-PSA-Crypto 1.2.0 are selected under
Apache-2.0. Exact release, gitlinks and official source-archive SHA256 are in
UPSTREAM.json. Keep upstream LICENSE files and third-party notices. The retained
file ledger binds every unmodified upstream byte. Unused programs, tests and
framework data are omitted; the complete verified archive is private build
evidence, not a second source fork. Upstream symlinks within the pinned tree are materialized as regular
files with the same ledger-verified contents for portable source inventory.
Upstream guarded source groups and release
build support remain intact. No package manager or generated project is changed.

CMake builds static mbedtls, mbedx509 and tfpsacrypto with the same reviewed
configuration on both platforms. Upstream remains C99; the Hypergolic wrapper
and frame/pairing encoders use C11. Product builds exclude the local proof.
TLS1.3/AES128-GCM/SHA256, ECDHE P256, ECDSA P256, DER keys/certificates and OS RNG
are enabled. Both TLS signature algorithms and X.509 certificate profile are
restricted. TLS1.2, PSK, tickets, resumption, 0RTT, public CA roots, filesystem
secret persistence, PEM and other curves are disabled. No generic socket adapter
is compiled. TLS1.3 peer-certificate retention remains enabled.

The native host supplies OS CSPRNG, monotonic time, current-owner and bounded
nonblocking byte callbacks. The source of entropy must be the OS, never account
keys or a test PRNG. Each call is synchronous. The native owner serializes each
credential/session and retains callback context until destruction. Platform
secure storage uses the credential-store sink; no JS/Expo key getter exists.
Stored/imported private DER buffers remain the native storage owner's obligation
to erase. A generated key is retained through its last session and then destroyed.

Each device certificate is a self-signed private device trust anchor, not a
WebPKI CA or Nostr/circle identity. The private CA callback returns only a copy
of the one presented certificate after exact SPKI pin matching. The verify
callback also checks its DER hash, so the library's internal depth1 anchor clone
cannot authorize another certificate. Exactly one presented certificate, P256,
ECDSA/SHA256 self-signature, digitalSignature/keyCertSign, both role EKUs, and
valid time are mandatory. No verification flags are cleared. Extra presented
chains fail even if issued by a pinned device key. Pre-pair TLS is deliberately
absent until a separate native pairing gate is reviewed.

Handshake work has an original absolute deadline of at most30s and a64KiB
combined ciphertext budget. Each I/O callback is bounded, plaintext calls are
at most16KiB, and record buffers are16KiB each. The wrapper owns an immutable
pending-write copy: mismatched retry closes without flushing; read/handshake do
not advance pending output. Completion/cancel/destroy erase the pending copy.
The coordinator MUST retain the original frame/source permit through actual
transport drain and atomically recheck it with enqueue. Cancellation after a
partial ciphertext write is unknown delivery, never proof of zero delivery or
permission to resend. Raw receive buffering must progress independently of TLS
plaintext reads while a write is pending. This library opens no sockets and
provides no Mesh permission, pairing membership or capability advertisement.
