# Mesh plaintext framing checks

Run `python3 tests/native/mesh-framing/run.py --out /absolute/fresh/evidence-directory`.
The runner compiles the actual C source with AddressSanitizer and UndefinedBehaviorSanitizer.
It performs no network, signing, identity or device operation.

The private Hypergolic LAN profile uses a 12-byte plaintext header inside TLS:
`HGM1`, version byte 1, kind byte, two reserved zero bytes, and an unsigned
big-endian payload length. Payloads contain 1–32,768 bytes. A dedicated native
message parser must validate UTF-8, JSON, method schemas and the tighter event
limit before any effects. TLS and pairing owners must authenticate and authorize
each message; recognizing a frame kind grants no authority.

Checks cover every split of a small frame, bytewise input, coalesced frames,
truncated EOF, invalid headers, all kind values, exact maximum size, rejected
overflow, callback refusal/close/reentry, sticky termination and buffer erasure.
The callback borrows bytes synchronously; any copy it retains is its responsibility.
No result here establishes TLS security, pairing, Mesh conformance or device acceptance.

The runner also compiles the actual fixed pairing-transcript encoder. Its output
is checked against an independently constructed Python vector: the ASCII domain
`hypergolic.mesh.pairing.v1` followed by NUL, the native signer role byte
(1 = inviter, 2 = joiner), a 16-byte invite ID, seven 32-byte
fields (secret hash, inviter/joiner user keys, inviter/joiner SPKI pins,
inviter/joiner nonces), then the 8-byte big-endian expiry. The total is 276 bytes.
Both native consent owners must validate the fields, original deadline and
current account before signing SHA256 of this fixed transcript. The encoder
alone grants no authority and does not validate public keys or certificate pins.
Same-account pairing is allowed; identical device pins or nonces are rejected.
The signatures cover distinct role-bound transcripts even when both participants
use the same public key. Native consent must own the signer role.
