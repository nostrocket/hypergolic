# Trusted test-fixture publisher

Settings contains **Publish test napplets**, owned by the shell and its selected
protected identity. It prepares only the sealed acceptance artifacts selected by
`scripts/build-fixture-release.mjs` from `runtime/fixtures` and `src/runtime/bundled-catalog.ts`. The NAP support
napplet has a separate publication project and is excluded. Routing peer keeps
its distinct manifest identifier and archetype with the exact Routing HTML.

`runtime:build` verifies raw UTF-8 bytes, SHA-256 and the selected single-path
aggregate hash before copying the generated bounded catalog into both native
resource bundles. The generated catalog is ignored; changing fixture code still
requires updating the reviewed source catalog pins. No caller-supplied HTML,
picker data, guest message or generic relay authorization enters this tool.

The first review captures the selected public author, exact server, HTML MIME,
length, SHA-256 and frozen relay destinations. Upload approval is one-use and
signs the existing factory-created kind24242 snapshot inside the protected vault.
The profile remains [Blossom b5bd280 BUD-02](https://github.com/hzrd149/blossom/blob/b5bd2801d1763aa635fc8fea7a76597e0eb18990/buds/02.md)
and [BUD-11](https://github.com/hzrd149/blossom/blob/b5bd2801d1763aa635fc8fea7a76597e0eb18990/buds/11.md):
exact hash, upload verb, hostname scope and 120-second expiration. The shared
recovery metadata codec accepts `text/html` for these trusted sealed fixtures; the guest byte classifier continues to reject HTML. The native
PUT uses the existing durable recovery ledger, public DNS/address restrictions,
TLS owner and descriptor validation. The private HTTPS owner claims the one-use
transfer exactly once; the fixture wrapper checks approval without consuming
that transport claim. A fresh native GET must match the entire
reviewed byte length and SHA-256 before a manifest review becomes available.

Manifest publication uses the existing guarded Applesauce/React Native relay
service. It checks the live native approval at socket creation and exact EVENT
frame dispatch; the independent stored-event lookup uses the native published
relay source. ACK relay names must match the canonical destinations in the frozen
event snapshot, including the root slash returned by the transport. An unapproved
host/path or a receipt for another event cannot count as acceptance.

The second review displays the complete kind35129 unsigned template and its ID.
Native approval claims that exact immutable template once. Protected signing
checks every signed field; publication requires a matching canonical relay ACK
and a separate fresh retrieval of the complete verified signed event. The result
contains the signed event, per-relay receipts, independently observed storage and
an naddr with the observed relays. Upload and manifest success are separate facts.

Foreground loss, identity transitions, expiry and cancellation revoke old native
handles. Returning to the foreground never revives approval. Uncertain uploads
remain in the existing durable recovery ledger and block the same identity,
server and hash until reconciled through the normal upload recovery controls.
Cancellation does not remove a public copy. Failed manifest verification may
follow a dispatched event; inspect the reviewed ID before a new release attempt.

The publisher changes neither the guest HTML classifier, signing exclusions, first-open consent nor NAP capability claims. Published Outbox admission follows [its own contract](outbox-routing.md#published-admission). Upload confirmation, stored manifest retrieval, provider retention and complete native acceptance are separate evidence.

Run `node --experimental-strip-types --test tests/outbox/fixture-publisher.test.ts`
and `python3 tests/native/fixture-release/run.py` for the owning contracts. Run
ordinary upload regressions, exports, prebuilds, native builds and quality gates
before installation. Keep the installed display name Hypergolic and existing
package/certificate identities so updates preserve private app data.


## Testing

Final Android/iOS acceptance remains open. See [testing](testing.md) for the unified requirement matrix, current quality gate, evidence limits and full standalone campaign.

Use the owning commands above and [upload](upload-access.md) recovery controls. Reconcile any possibly dispatched event by its exact reviewed ID before another release attempt.
