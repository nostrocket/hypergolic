# Android Approval Lab review driver

`tests/native/approval_review.py` runs the public rejection journey against the
already-installed isolated fixture package. It requires an explicit APK
SHA-256 and selected public `npub`; it never installs an APK, clears data,
imports an identity, approves a request, signs, or opens a relay.

The driver force-stops and relaunches the existing package so the run starts
from a known process boundary while preserving app data. It then observes the
selected public identity in Settings, opens Approval Lab through the observed
Settings control, observes the unchanged public note `Approval Lab test note` in the
SDK input, and submits it through the observed Send button. The approval sheet must show the
exact note, bundled public publisher, selected public identity, and all three
configured relay destinations. The driver rejects the request and requires the
SDK to expose its denial result.

It also submits three requests, dismisses the first, requires the native
review pause and pending queue, explicitly resumes, and rejects the remaining
requests one at a time. A final request is backgrounded, then the app is
relaunched; the driver requires a paused pending review with no automatic
prompt, resumes explicitly, and rejects it. All taps
come from the current UIAutomator hierarchy and observed bounds. Missing or
ambiguous controls fail the run instead of using coordinate guesses.

Run only on the prepared disposable fixture after the APK handoff:

```sh
python3 tests/native/approval_review.py \
  --source "$PWD" \
  --serial emulator-5556 \
  --package org.nostrocket.hypergolic.identityfixture \
  --activity org.nostrocket.hypergolic.dev.MainActivity \
  --expected-apk-sha256 APK_SHA256 \
  --selected-npub npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd \
  --output /private/tmp/hypergolic-approval-review \
  approval-review
```

The output directory must be new. `result.json` seals the source snapshot,
driver hash, installed APK hash, public device metadata, checks, and hashes of
public UIAutomator XML and screenshots. Screenshots are marked
`visuallyInspected: false` until separately reviewed. The journey is UI and
native lifecycle evidence only. It deliberately sends no approval input, so it
does not claim wire-level network observation, signing, network delivery,
release hardening, physical-device behavior, or Android API 26–29 support.

Focused portable checks:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest tests/native/test_approval_review.py -v
```
