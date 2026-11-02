# Live published-update QA

This test harness prepares a disposable, public-only named napplet with two
separately signed kind-35129 revisions. Each manifest names one `/index.html`
blob, its NIP-5A aggregate hash, `theme` access and a Blossom server. The v1 and
v2 HTML documents expose distinct `update-v1` and `update-v2` markers. The
publisher secret exists only in the preparation process; the handoff file contains
public events and HTML, never an nsec. This fixture is separate from the project's
release publisher and the user's identities.

The app already passes native live first opening and embedded update checks. This
harness bridges those two proofs: upload both exact HTML blobs to a public Blossom
server, publish only v1 to a Lookup relay, open v1 in the isolated public-only
native app, then publish v2 and check the ordinary update review. Public test data
may remain on the server and relay after a run.

First run the no-network plan and the focused verifier/wire checks:

```sh
# Configure the pinned tools described in docs/development.md.
node tests/native/live-update-publication/cli.mjs plan
node --experimental-strip-types --test tests/native/live-update-publication/*.test.mjs
PYTHONPATH=tests/native python3 -B -m unittest tests/native/test_live_update_driver.py
```

Once a disposable QA publisher is approved, prepare the two blobs and save the
printed `bundlePath`. Preparation requires BUD-11 upload authorization and a
direct, exact-byte readback; it does not publish either manifest event:

```sh
node tests/native/live-update-publication/cli.mjs prepare
node tests/native/live-update-publication/cli.mjs inspect --bundle /path/to/bundle.json
node tests/native/live-update-publication/cli.mjs publish --bundle /path/to/bundle.json --revision v1
```

The default destination is `https://blossom.ditto.pub/`; `prepare --server
https://another-public-blossom.example/` selects a different public HTTPS root.
The relay is `wss://relay.damus.io`, which the isolated fixture's normal native
Lookup list includes. The commands fail if the server rejects the upload, its
response or readback differs from the expected hash, or the relay does not
acknowledge the exact signed event and return it in a fresh, bounded coordinate
lookup using the app's unpinned filter. An `OK` alone is not a native lookup
pass. The upload path verifies that its in-memory
key matches the signed handoff publisher before making any request. It bounds
the Blossom descriptor to 4 KiB and the direct HTML readback to the exact
expected byte count. `publish` rechecks both public blobs before releasing the
selected revision. Keep the private temporary bundle path out of
source commits even though it contains no secret.

Build and install the isolated `live-published-fixture` Release app according to
[its guide](../live-published-fixture/README.md); never clear or install over the
normal app. After v1 is published, use the bundle and exact APK/source digests
with `tests/native/live_update_driver.py`. That driver opens v1, publishes v2
through the command above, checks exact old/new event review, declines while v1
stays connected, then approves v2 and checks cold restoration. It records the
installed APK, frozen source hashes, UI hierarchy and screenshots. Publication
alone is not a native pass; inspect the driver receipt and images.

For iOS, build and install the same isolated `live-published-fixture` entry on
an explicitly named Simulator. If that disposable package contains an earlier
QA workspace, uninstall only that package and reinstall it before the v1 run.
Run the two public-only UI scenarios against the same installed app container,
with the v2 relay publication between them:

```sh
python3 -B tests/native/ios-driver.py --udid EXPLICIT_SIMULATOR_UUID \
  --bundle-id org.nostrocket.hypergolic.livepublishedfixture \
  --repo "$PWD" --live-update-bundle /path/to/bundle.json \
  --output /private/tmp/hypergolic-ios-live-v1 live-update-v1
node tests/native/live-update-publication/cli.mjs publish \
  --bundle /path/to/bundle.json --revision v2
python3 -B tests/native/ios-driver.py --udid EXPLICIT_SIMULATOR_UUID \
  --bundle-id org.nostrocket.hypergolic.livepublishedfixture \
  --repo "$PWD" --live-update-bundle /path/to/bundle.json \
  --output /private/tmp/hypergolic-ios-live-v2 live-update-v2
```

Use fresh evidence directories and inspect each `result.json`, XCTest report and
screenshots. Do not reinstall or clear the fixture between the two iOS runs.
Neither platform's public-only fixture can sign or publish as a guest. A passing
Simulator result would still leave physical-iPhone protected identity, backup,
signing and capture checks open. This test depends on public relay and Blossom
availability and must report outages as inconclusive, not as verified behavior.

The checked protocol basis is the draft [NIP-5A manifest/hash format](https://github.com/nostr-protocol/nips/blob/a2494f4f81d46684e5814a9bf35e2b1df978f955/5A.md),
the selected [NIP-5D named napplet proposal](https://github.com/dskvr/nips/blob/24711d9c47bbdd07908bf1d52bf677d9cbc530f0/5D.md),
[Blossom BUD-02 upload](https://github.com/hzrd149/blossom/blob/b5bd2801d1763aa635fc8fea7a76597e0eb18990/buds/02.md)
and [BUD-11 signed authorization](https://github.com/hzrd149/blossom/blob/b5bd2801d1763aa635fc8fea7a76597e0eb18990/buds/11.md)
(as read 28 September 2026). The app still verifies signatures, hashes and access
independently of this test publisher.
