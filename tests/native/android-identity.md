# Android identity restart evidence

`identity_driver.py` uses the selected checkout's existing Android `Driver` and public ADB input. It records the real full npub from the native header, opens Settings, taps the full npub, compares the exact visible value, and closes Settings. It repeats this after a data-preserving process restart and requires the same identity.

This scenario deliberately force-stops and launches the installed app before both observation rounds. Stored app data remains intact; disposable in-memory napplet state may be lost. It never installs the app, clears data, imports a key, reads secret storage, changes a relay or calls a private app API. Coordinate exclusive device input and freeze relevant source files while it runs.

## Run

The app must already be installed, the explicitly selected device booted, and the installed APK hash known from build/install evidence. For a development app, arrange Metro connectivity first; the harness does not start Metro or change ADB forwarding. The selected checkout must have its locked `nostr-tools` dependency installed.

```sh
# Configure the pinned tools described in docs/development.md.
PYTHONDONTWRITEBYTECODE=1 python3 tests/native/identity_driver.py \
  --source "$PWD" \
  --serial "$HYPERGOLIC_ANDROID_SERIAL" \
  --expected-apk-sha256 "$HYPERGOLIC_ANDROID_APK_SHA256" \
  --output "$HYPERGOLIC_ANDROID_EVIDENCE" \
  identity-restart
```

Set the evidence variable to a new private directory. Screenshots and accessibility trees contain a full public identity. Existing output directories are refused. Optional `--adb` and `--node` select installed executables; `--package` defaults to `org.nostrocket.hypergolic.dev`. This scenario requires no diagnostic label or startup backdoor.

## Acceptance and limits

The run requires all of the following:

- Exactly one visible, enabled native identity control outside WebView, belonging to the selected package; the full header npub must equal the full Settings text before and after a native tap.
- A retired app PID after each force-stop, proven by pidof exit status 1 with empty stdout and stderr; successful Activity Manager launches; and distinct single PIDs across the two rounds. The final process must remain the second process.
- Four equal public npub observations, each independently decoded through the checkout's actual `nostr-tools/nip19`, with a valid checksum, 32-byte public key and canonical lowercase re-encoding.
- The exact expected installed APK before interaction and the same APK afterward, including recorded packaged runtime assets.
- Equal source and executable harness hashes before/after. Source snapshots cover shared application files, both native identity modules, bundled runtime assets, configuration and lockfiles. Snapshot failure makes the receipt fail and returns nonzero, even if preceding UI checks passed.

Three named native checks and the independent four-value decoder result appear in `result.json`. Every native tap records its observed bounds; process commands record their arguments. Failed runs preserve available screenshots and observations. PNG records start unreviewed and need independent visual inspection.

This proves public identity continuity across an ordinary process restart. It does not prove private-key usability, encrypted storage, device authentication, backup, import/switching, signing, app reinstallation, OS reboot, iOS, physical devices or standalone release behavior. Tapping the full value is interaction evidence; clipboard and text-selection behavior are not asserted. Source hashes describe filesystem correspondence, not the exact JavaScript bytes served by Metro.

The portable scenario passed on the Android emulator with diagnostic code removed: both shutdown queries reported no process, both launches were cold, and four complete public values matched. The installed APK and owning source snapshots remained unchanged. The preserved receipt and inspected Settings image are recorded in the identity implementation checkpoint.

## Offline verification

```sh
cd tests/native
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v test_identity_driver
HYPERGOLIC_NOSTR_REPO="$(git rev-parse --show-toplevel)" node --test identity-encoding.test.mjs
```

The Python tests cover native control admission, source changes, process retirement, launch failures, wrong identities, decoder receipts and nonzero failure outcomes. Their fake controls test harness decisions; they are not native execution evidence. The Node tests use the installed owning decoder and reject malformed/checksum-invalid or changed public identifiers.
