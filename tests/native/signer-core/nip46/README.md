# Controlled NIP-46 peer

This test-only peer uses the pinned `nostr-tools` implementation for NIP-44 and
Nostr signatures. Its connection key and user key are distinct. It implements
`connect`, `get_public_key`, `switch_relays`, `sign_event`, `ping` and `logout`.
It never publishes the returned user event. Native clients must enforce their own
event, peer, recipient, request ID and lifetime checks.

Run from the source root with the pinned local tools:

```sh
node --test tests/native/signer-core/nip46/peer.test.mjs tests/native/signer-core/nip46/server.test.mjs
node tests/native/signer-core/nip46/server.mjs --output /tmp/fresh-nip46-fixture
```

The output directory must not exist. `ready.json` contains the public peer/user
keys, DNS-label WSS URL, disposable TLS trust certificate, loopback address and a
fixture bunker URL. It also contains a test-only connection token and control
nonce: keep this file private and out of portable receipts. No real account or
credentials belong in this fixture. By default fresh signing scalars stay in the
server process; the disposable TLS private key is removed on normal shutdown.

For same-account native import tests, `--fixture-keys public-vectors` explicitly
uses the publicly known disposable scalars 7 (peer) and 9 (user). This mode is only
for isolated fixtures; it is never a source of real account credentials. The
normal server mode still generates fresh keys.

Controlled native transport tests may inject a loopback resolver, fixture trust
anchor and test clock through their owning test ports. These are separate from
production destination policy and must be labeled in their receipts. The WSS
server accepts `/signer` and `/changed`; it delivers deliberate invalid frames to
the active subscription so the client, rather than the test relay, rejects them.

POST JSON to `controlURL` with header `x-fixture-control` set to `nonce`:

```json
{"fault":"wrong-user","method":"sign_event"}
```

Use `fault: "none"` to restore ordinary behavior. `peer.mjs` exports the complete
fault list. A relay-change control has `relays` (array or null) and optional
`stringRelays: true`; both wire forms are intentional because the selected NIP-46
methods table says array/null while its general response description says string.

`receipt.json` records exact approved and returned public test events, per-method
request counts and signatures produced. It omits scalars, bunker tokens and
decrypted connection parameters. A lost response may still increment signatures;
this is the uncertainty the client must retain. Replaying an identical RPC ID
returns its existing result without producing another signature; a changed request
under the same ID is rejected.

For direct native host-port tests, import `createPeer()` and call
`processEvent(publicOuterEvent)`. Its result is `{events, accepted, close}`.
Such a test proves native protocol handling against independent crypto, not WSS,
device storage, native review, app lifecycle or publication.


Two transport faults, `valid-plus-invalid-suffix` and
`valid-plus-close-trailing`, write a valid correlated reply and a malformed frame
suffix in one TLS write. A TLS write can still arrive in multiple reads. The
owning decoder tests establish rejection when both are in the same read; the
network trace is additional transport evidence, not a guarantee about future
bytes after a completed read.


Authentication tests use `auth-url` with `method` set to the challenged method.
The default URL is `https://auth.example.org/fixture`; an optional `authURL` control
sets another HTTPS destination for a separately scoped native browser test.
The peer retains the original request in memory and produces no result until an
authenticated control completes that exact request:

```json
{"completeAuth":{"clientPubkey":"64-character client public key","id":"original-rpc-id","decision":"approve"}}
```

`decision: "refuse"` returns a terminal refusal. Setting another fault before
completion applies it to the final reply, so native tests can reject a changed
event, wrong peer/ID or duplicate/absent completion. Unknown and already completed
requests fail without a new signature. Completion delivers the final encrypted
reply on the existing subscription with the original RPC ID; it requires no
resend. Receipts report `authCompletions`, `pendingAuth`, per-method counts and
signatures. Replaying an identical completed request returns its cached final
reply. Neither a control completion nor opening a fixture URL proves a real
provider login, native browser isolation or production handoff acceptance.

`wrong-public-key` on `get_public_key` returns another valid curve point, encrypted
and signed by the expected peer, to exercise account binding during relay refresh.


For an ordinary app trace through its production DNS/TLS policy, run the public
relay peer with one or two relays already listed in `src/config/fixture-release.json`:

```sh
node tests/native/signer-core/nip46/public-relay.mjs --output /tmp/fresh-public-nip46-fixture --relay wss://nos.lol --relay wss://relay.damus.io --seconds 900
```

This uses normal certificate verification and fresh disposable scalars held in
memory. It publishes only the controlled peer's encrypted kind-24133 responses,
never the user events returned by `sign_event`. The same private `ready.json` and
public receipt boundary applies. The local authenticated control accepts relay
changes, `authURL`, an `auth` boolean and exact `completeAuth` results; it does not
expose arbitrary peer faults over public relays. Traffic and duration are bounded.
Stop this exact process after the trace and keep its final receipt. A controlled
public-relay exchange does not establish real-provider login, Amber compatibility
or event-publication acceptance.
