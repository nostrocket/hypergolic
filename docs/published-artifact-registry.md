# Published artifact native registry

The trusted loader verifies the signed kind-35129 manifest, exact publisher/`d` coordinate, original HTML hash and NIP-5A single-path aggregate. Native registries independently establish byte integrity and host ownership; they do not prove Nostr signature validity, publisher trust or user consent. Ordinary Settings loading and the workspace now use [published admission](published-network.md#published-admission-and-updates).

The Android and iOS registries implement the following core contract. The Expo
modules stage verified bytes through a bounded app-only transfer. Each native
host view can claim a staged handle once and own the bytes for that generation.

The registry accepts an app-only staging call with original UTF-8 bytes and
bounded claims: shell session ID, publisher public key, stable napplet `d`
identifier, signed event ID, aggregate version hash and HTML SHA-256. It checks
the 2 MiB byte limit, strict UTF-8 decoding, SHA-256 and NIP-5A single-path
aggregate over `<html hash> /index.html\n`. It copies the bytes privately,
enforces a small number of pending artifacts and short staging expiry, and
returns an unpredictable opaque token. It never accepts a caller-supplied
`verified` flag as proof.

The native host claims a token once, atomically matching the exact session and
artifact claims, then binds the bytes to its newly minted view generation.
Replay, changed claims, expiry, backgrounding or session revocation fail closed.
Claiming returns a private byte copy to the host only; React props and events
carry the token and bounded claims, never HTML, a path or an arbitrary URL.
The published host route remains separate from bundled fixtures; locally embedded signed QA artifacts do not prove remote retrieval.

The trusted owner must explicitly register a live shell session before staging and
revoke pending bytes on closure, identity change or backgrounding. A saved
session may be registered again after revocation. Claimed bytes have moved to
the host's ownership; the host must clear its copy on view teardown. The native
modules and host views revoke their bytes on backgrounding or teardown.

The Expo module transfer uses `registerPublishedSession`,
`beginPublishedArtifact`, `appendPublishedArtifact`, `finishPublishedArtifact`,
`cancelPublishedArtifact`, `revokePublishedSession`, and
`revokeAllPublishedArtifacts` on both platforms. A begin call binds the exact
claims and declared length (1 through 2 MiB) to a registered session. At most
four uploads can exist, with one per session and a 60-second lifetime. Each
zero-based sequential, canonical Base64 chunk decodes to 1 through 48 KiB.
Malformed or repeated chunks consume the partial upload. Finish consumes it
and independently checks exact length, strict UTF-8, original SHA-256 and the
single-path aggregate before returning a one-use handle. Backgrounding revokes
all pending bytes and registrations; the trusted owner must register again
before a later transfer. No claim function is exposed to JavaScript. A
verifier-branded JavaScript adapter chunks a private copy and rechecks live
ownership around every native call.

The host claims the handle internally and exposes ordered 48 KiB chunks only to its exact top-level packaged document and native generation. The runtime rechecks original bytes/aggregate, inserts leading CSP before publisher markup, and mounts an opaque sandboxed guest with only exact admitted grants. The verifier requires leading doctype, html and head so no publisher content precedes CSP. Each domain still needs its owning native operation policy. The theme-only signed host fixture is a narrower QA composition, not the current published-domain limit.

## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Run the owning proofs below. These exercise registry/transfer sources; normal first-open consent, protected identity, remote retrieval and full workspace lifecycle require their separate ordinary-app cases.

```sh
# Configure the pinned tools described in docs/development.md.
python3 tests/native/android-published-artifact-registry/runner.py --output /tmp/hypergolic-android-registry-proof
xcrun swiftc -warnings-as-errors modules/napplet-host/ios/PublishedArtifactRegistry.swift \
  tests/native/published-artifact-registry/PublishedArtifactRegistryProof.swift \
  -o /tmp/hypergolic-ios-registry-proof
/tmp/hypergolic-ios-registry-proof
xcrun swiftc -warnings-as-errors modules/napplet-host/ios/PublishedArtifactRegistry.swift \
  modules/napplet-host/ios/PublishedArtifactTransfer.swift \
  tests/native/published-artifact-transfer/PublishedArtifactTransferProof.swift \
  -o /tmp/hypergolic-ios-transfer-proof
/tmp/hypergolic-ios-transfer-proof
```
