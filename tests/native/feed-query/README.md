# Native query fixture

An isolated, standalone `org.nostrocket.hypergolic.feedqueryfixture` app loads the
exact reviewed Feed Lab through the genuine Kehto/SDK and native capability lease.
It uses SQLite for broker composition and the existing app-only native WSS owner
against `wss://nos.lol`. Only a public test identity is configured; it never opens
the protected identity vault, signs or publishes. The normal application still
uses the current trusted Network settings.

Build the native Release app with `tests/native/feed-query/index.tsx` as its
entry file and the isolated package/bundle identifier. On Android retain the
existing `org.nostrocket.hypergolic.dev.MainActivity` class. Restore any temporary
changes to generated Gradle files afterward. On iOS pass `ENTRY_FILE` and
`PRODUCT_BUNDLE_IDENTIFIER` to the existing Hypergolic workspace scheme. Follow
[development prerequisites](../../../docs/development.md).

Capture a public kind-1 event independently from the relay using a NIP-01 REQ and
verify its hash and Schnorr signature with `nostr-tools/pure`. Save a private JSON
handoff `{relay,event,filter}`. Do not publish fixture content or credentials to
make this test pass. Public relay retention/availability can change; keep failed
runs and refresh the independent sample if necessary.

Run the Android journey on an explicitly selected, already-unlocked test device:

```sh
python3 tests/native/feed-query/android-query.py \
  --serial "$ANDROID_TEST_SERIAL" --apk "$QUERY_FIXTURE_APK" \
  --sample "$INDEPENDENT_PUBLIC_SAMPLE" --output "$NEW_EVIDENCE_DIRECTORY"
```

It checks installed APK equality, exact signed event ID/content, empty EOSE,
canonical invalid-filter denial, close/reopen and cold restart. It captures source
hashes before/after, compressed native accessibility, native inputs and PNGs.
Review the PNGs separately; automation does not mark visual review complete.

For iOS, build the owned XCTest project in `tests/native/ios/XCTest`, select only
`FeedQueryTests/testQuery`, and set `HG_QUERY_EVENT_ID` in the generated xctestrun
runner's `EnvironmentVariables`. The runner attaches five screenshots and a JSON
report only after all assertions pass. Verify installed app/build correspondence
and export attachments from the actual xcresult. Simulator query evidence does
not prove physical-iPhone protected identity or signing.

## Controlled SDK/native fault matrix

The trusted **Controlled query faults** button opens ten cases: signed result,
empty EOSE, invalid signature, valid wrong-kind event, missing EOSE, event/frame
flood, shortened timeout, close and owner-epoch revocation. Each uses the real
SDK/Kehto, actual native immutable lease, production broker and query validator.
Only the relay frame port is a diagnostic double; it never opens a socket. The
public signed fixtures contain no signing secret. The timeout is 120 ms for this
fixture; delayed frames arrive at 220 ms even after cancellation. Receipts count
actual dispatch, exact operation cancellation, late frames, broker responses and
null native denials. Automation also independently observes the SDK UI or removed
guest. Owner-epoch revocation tests the owner authority assertion; it is not a
full protected-identity settings journey.

```sh
python3 tests/native/feed-query/android-matrix.py \
  --serial "$ANDROID_TEST_SERIAL" --apk "$QUERY_FIXTURE_APK" \
  --output "$NEW_FAULT_EVIDENCE_DIRECTORY"
```

On iOS select `FeedQueryTests/testQueryFaultMatrix` in the generated xctestrun.
Both standalone native hosts pass all ten cases. The live public-relay journey
above separately proves the actual native WSS path. Production Java and Swift
lease proofs each pass 100 assertions; a normal runtime-owner regression also
confirms that a real identity transition cancels a pending query. Retain harness
failures separately from successful receipts, and compare installed products.

These are phase-2.1 query-profile acceptance, not full MVP acceptance. Full
normal-app and verified-published Feed Lab parity, selected real napplets, older
WebView queries and physical-device integration remain phase-2.11 evidence work.
See [relay query](../../../docs/relay-query.md).
