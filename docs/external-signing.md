# External signing

Hypergolic is an outgoing signer client: NIP-46 on Android/iOS and a selected
NIP-55 Activity profile on Android. It exposes no incoming signer Activity,
ContentProvider, NIP-46 service or third-party forwarding endpoint. Current
integration does not close real-signer interoperability, protected-device or
full Phase 2/3 acceptance; see [testing](testing.md).

## One account, explicit method

The Nostr public key identifies an account. Connecting the same key adds a method
without changing account-scoped napplet data. Method changes flush the workspace,
require native confirmation, advance the vault revision and restart sessions.
Old replies cannot authorize later publication.

Methods are `local`, `nip46` and Android-only `nip55`. Selection is explicit and
has no fallback to another signer or key. Disconnecting the selected external
method leaves no selected method while retaining account/data. Saved connection
metadata does not mean the signer is online. A second NIP-46 method requires
disconnecting the first; it cannot silently replace a connection.

A local key may remain while an external method is selected; Settings discloses
it. Local-key removal requires separate native confirmation and OS authentication,
retaining account/connections/data. Whole inactive-account deletion removes its
saved methods through authenticated deletion. Neither operation erases the
pre-release JavaScript vault namespace. See [identity storage](identity-storage.md).

## Native connection contract

Native UI accepts the selected `bunker:` link. Transport client key, signer peer
and returned user key are distinct. Native code validates the user as an x-only
secp256k1 point, verifies the peer's outer event and recipient, then authenticates
and decrypts NIP-44 content. JavaScript receives only public metadata and an opaque
expiring candidate; link secrets and transport keys remain native.

Connection confirmation displays account, peer, signer relays and whether a local
key remains. Connecting/selecting is one explicit durable mutation, bound to
native owner, vault ID/revision and candidate lifetime. The authenticated record
stores method metadata. Android HGV4 also binds installed package and complete
certificate set; HGV3 remains readable without passive rewriting.

Every mutation distinguishes known cancellation before a durable effect from
uncertain acknowledgement after write. Uncertainty closes cached account state
and requires recovery; it cannot restore old workspace authority. Native import
and connection candidates are bounded by their original two-minute deadline.
Fatal preparation errors revoke only the captured account session, including
after cancellation when its vault cache is no longer valid; late failures cannot
overwrite a newer healthy session.

## Request and transport limits

Signer relays are separate from publication relays. At most three unique WSS
destinations pass native public DNS/TLS policy. IDs, deadlines and aggregate
connection traffic are bounded. NIP-46 follows [revision a79e21d](https://github.com/nostr-protocol/nips/blob/a79e21d90fce5465b50ef385dd368bba99ec4a0b/46.md),
also selected for NIP-44; native cryptography is documented in
[the signing core](signing-core.md#native-remote-encryption).

Signing stops when preflight reports changed relays. Explicit Settings refresh
validates proposed destinations and requires flush/confirmation, retaining the
client key, peer, account and selected method. On iOS, preflight relay equality
is checked before a paused handoff can be authenticated: `SIGNER_RELAYS_CHANGED`
cannot temporarily release a source, even after an earlier Resume.

Each signing request retains its native host source, immutable event, account and
vault revision. Native review is per event. Returned fields, canonical ID and
Schnorr signature must match; shared verification checks them again before
publication. Upload authorization and fixture lanes retain their own exact-byte
and destination authority. Signature success is separate from relay acceptance.

Canonical events are at most 2 MiB. NIP-44 plaintext is at most 4,202,496 bytes;
encoded payload at most 6,990,604 bytes. RPC escaping and relay framing have their
own bounds. Reject unsupported/oversized requests before dispatch. Never
automatically retry a request that may have reached the peer; a new attempt needs
new review.

The operation shares a sticky budget across its RPCs, relays and address attempts:
32 MiB total wire, 64 frames and 32 text messages. Android text/RPC parsing is
bounded at 8 MiB; iOS text is at most 6,992,652 bytes. iOS preflights a complete
network read and rejects malformed trailing frames before delivering an earlier
valid response. Budget failure cannot be reset by switching destinations.

## Authentication continuation and cancellation

External authentication uses a separate one-use native continuation. Read-only
pending queries retain the admitted request while pausing or asking origin
consent; execution stays denied. Android requests native consent before handing
the URL to the chosen browser. iOS uses a visible native Safari view. Neither
browser navigation nor a return URL proves authentication.

Resume is explicit and a verified response to the original request is required
before authority returns. The original deadline remains; challenged requests are
not resent. iOS background/external-browser hops cancel. Android's intentional
hop requires the exact bounded handoff ticket. Lock, account/method changes,
cancellation, protected-data loss and expiry revoke work independently.

Each native preparation/signing operation owns its panel, task, callback and timer.
Late callbacks cannot consume or cancel a replacement request. Android handoff
cancellation is notified at most once. Prepared resources not delivered because
prompt cancellation wins must be closed.

After possible dispatch or a confirmed external result, loss of authority at the
final guard, Resume, completion or ticket validation remains uncertain: it cannot
claim nothing was signed. Wrong/duplicate IDs, refusal and invalid event results
remain distinct failures. Preserve actionable storage/readback/recovery errors on
local/result-completion paths. Completed source captures remain revocable;
protected actions revoke them independently of JavaScript. New requests cannot
cancel unrelated approved uploads.

## Android signer-app profile

The profile follows [NIP-55 a79e21d](https://github.com/nostr-protocol/nips/blob/a79e21d90fce5465b50ef385dd368bba99ec4a0b/55.md).
One explicit Activity request is active at a time. Native selection chooses an
installed signer; JavaScript cannot supply arbitrary packages. Save the package
and complete signing-certificate SHA-256 set. Any set change, including legitimate
rotation, requires reconnection. A returned package string is not caller identity.

Bind result to actual Activity/controller, captured owner, package/certificate set,
request ID, account, original deadline and reviewed event. Recheck certificates
before exact-source Resume and consume results once. iOS prepare/commit require
a valid vault lease then fail `SIGNER_UNSUPPORTED`; cancellation is a no-op.
iOS cannot select/disconnect a NIP-55 method.

Complete Android Intent parcels are at most 512 KiB and must contain no file
descriptors. This may reject an event below the local/NIP-46 2 MiB canonical
limit; there is no silent transport fallback. The Activity operation retains its
original lifetime of at most two minutes.

For [Amber's redundant Activity-result fields](https://github.com/greenart7c3/Amber/blob/fc2e0de5ddcc6f25ac1ae08f43a0073440a70355/app/src/main/java/com/greenart7c3/nostrsigner/service/IntentUtils.kt#L943),
public-key `signature`/`event`, when present, must be Strings exactly equal to
required `result`. Optional signing `signature` must equal `result` and the
verified event signature. Aliases never replace required fields. Reject conflicts,
null/non-String values, unknown extras and malformed signatures. This compatibility
rule adds no ContentProvider, batch, web callback or incoming-provider authority.

## Validation status

```sh
pnpm run test:signer
python3 tests/native/signer-core/run.py --platform android --suite nip46 --serial EMULATOR_SERIAL
python3 tests/native/signer-core/run.py --platform ios --suite nip46 --udid SIMULATOR_UUID
```

Use explicit disposable targets and fresh evidence destinations as required by
the [central runner](../tests/native/signer-core/README.md). Android `nip55`/`all`
also needs a reviewed provider build; follow the [NIP-55 harness](../tests/native/signer-core/nip55/README.md).
The [NIP-46 harness](../tests/native/signer-core/nip46/README.md),
[relay ordering](../tests/native/signer-core/relay-ordering/README.md) and
[remote operation](../tests/native/signer-core/remote-operation/README.md) describe
protocol and lifetime checks. Native fixtures, ordinary application routes and
real-signer/physical acceptance have distinct scopes; none implies Amber parity
or an independent security audit. See [testing](testing.md).
