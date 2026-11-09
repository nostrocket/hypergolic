# Public event verification

One-shot Outbox data reads use an app-only SignerCore batch for BIP340 verification.
Other callers of the same trusted Outbox data service, including Common reads,
use that same path. This changes public verification computation, not their
permissions, destinations, event/result limits or signing authority.

JavaScript still captures fresh exact fields, checks the existing escaped JSON
byte/tag bounds and filter, independently checks the canonical event hash, and
freezes every row before awaiting native work. A private weak brand prevents an
uncaptured object from entering the production adapter. Raw Relay streams,
Lookup discovery and route-cache validation retain synchronous JS verification.
No verification-cache symbol is trusted. Any false signature or malformed native
response rejects the entire peer batch; no unchecked subset or permissive
fallback is returned. Native signer-specific event parsers are not substituted
for the existing JS canonicalization and Unicode behavior.

The native API receives only 1–200 exact public-key/digest/signature tuples. Their
compact ASCII JSON is at most 53,401 bytes, with a 64 KiB ingress ceiling. It uses
the existing public `hypergolic_signer_verify_digest` primitive, without creating
keys, touching a vault, obtaining entropy, signing or opening network access.
There are two process-wide jobs, no pending queue, and no slot is released while
its worker can still run. Cancellation, backgrounding, module destruction,
expiry and owner checks fence execution and results. Each job also captures an
owner lifecycle revision, so backgrounding followed by resume invalidates even
a completed result that has not yet been delivered. An abandoned dispatch may
release an unstarted job atomically; a delayed worker then cannot claim it.
Pre-admission cancellation uses at most 64 expiring UUID tombstones; saturation
fails closed for 15 seconds.

The original JS monotonic query deadline includes bridge scheduling and native
verification; completion rechecks both that lifetime and the caller's active
binding before aggregation. Native's relative budget starts at native admission.
It is not an absolute cross-clock original deadline. An extremely delayed bridge
invocation after the 15-second cancellation tombstone expires could perform a
bounded obsolete public batch, but its result cannot reenter the closed query.
There is no new retry, signature relaxation or resumed caller lifetime.

The host-only `tests/native/signer-core/public-verification/run.py` checks actual
JNI/C and Swift/C ownership, fixed-digest BIP340 vectors and controlled timing.
It requires an existing Android ABI and never builds/installs an app. Those
results do not measure Expo bridge or device/Hermes performance. Ordinary native
query diagnostics on the integrated artifact must establish the practical gain.
