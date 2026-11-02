# Android identity action regressions

Run with the pinned JDK on PATH:

```sh
python3 scripts/test-android-identity-actions.py --output /private/tmp/hypergolic-deletion-proof
```

The output directory must be new. The runner compiles the owning production
`DeletionAuthority.java` directly with its test harness, checks source hashes before
and after execution, and retains compiler output and a JSON receipt. No native
authority implementation is copied into the test harness.

The deletion suite has 126 assertions covering missing admission, exact target/session/context, immutable
inventory, busy requests, one-use consumption, authentication denial, stale and
cross-owner callbacks, settings replacement, background/retirement, expiry at
authentication and actual erase, changed inventory, entropy failure, uncertain
erase, late opening and concurrent revocation. Inventory, authentication result,
clock and erase ports are explicit doubles. This is neither an Android OS prompt
nor Android Keystore/SharedPreferences proof.

The authority is connected to the exact native main AppContext and system prompt.
Runtime ownership, duplicate claims and exact-attempt cleanup have JVM regressions;
the actual record adapter and OS-authenticated UI journey have separate proof below.


## Native protected-record probe

`RecordsInstrumentation.java` runs only in a separate instrumentation APK targeting
the isolated identity fixture. It first reads the two existing identities written
by the actual Expo SecureStore SDK. It then exercises malformed ciphertext and
payloads, cancelled/revoked approvals, and one-use native deletion against separate
disposable preferences encrypted with the existing Android Keystore wrapping key.
The wrapping key is never exported or replaced. Existing identity records must be
byte-identical before and after; disposable preferences are removed in `finally`.
No raw exception or secret is included in the result. OS-authentication completion
is an explicit double: this is a record and erase proof, not a system prompt test.

The current probe passes 99 assertions on the API 36 emulator, including exact
scalar-2 backup encoding, digest/target rejection, one-use reads and revoked leases. The reader accepts only the
reviewed SecureStore 57.0.3 canonical AES-GCM envelope, fixed service and alias,
128-bit tag, 12-byte IV, bounded HGI1/HGK1 payloads and valid nonzero scalars. Legacy
formats, missing keys, unfinished staging and unknown formats fail without repair.
This reader creates no wrapping key and has no secret-write operation. Mutable
plaintext bytes are cleared; Java/JSON String zeroization is not claimed.

The host runner requires the exact installed standalone app/test APK digests, the
expected selected public key, a fresh output directory, and the exact reviewed SDK
sources in `secure-store-source.json`. It records source hashes and installed bytes
before and after execution. Build preparation must separately attest that these
owning sources produced the supplied APKs. Only the isolated fixture package is
accepted; the normal application is not an instrumentation target.

```sh
python3 scripts/test-android-identity-records.py --serial emulator-5554 \
  --expected-apk-sha256 APP_SHA256 --expected-test-apk-sha256 TEST_APK_SHA256 \
  --selected FIXTURE_PUBLIC_KEY --output /private/tmp/hypergolic-records-proof
```

To build the private test APK, compile the owning modules in the isolated fixture,
copy the instrumentation source into its Android app's `src/androidTest/java` at
the matching package path, and set `testBuildType "release"` plus
`testInstrumentationRunner "org.nostrocket.hypergolic.identityowner.RecordsInstrumentation"`.
Build `assembleRelease assembleReleaseAndroidTest`, attest the source/artifacts,
and install both APKs with the same local test certificate. This setup is confined
to the isolated fixture; it adds no production test receiver or diagnostic API.


## Actual system-PIN deletion journey

`tests/native/identity_deletion.py` runs only against the standalone isolated
identity fixture on the explicitly named `Hypergolic_Auth_API_36` emulator. Prepare
that disposable API 36 image with the public test PIN `123456`, the current attested
APK, its generated disposable identity selected and its three initial UX Lab
napplets. Do not configure a real credential or use a normal application. The
runner imports only the public scalar-2 test identity, clears/restores the public
emulator PIN for the no-lock case, and deletes that imported identity. It never
clears app data. Existing app artifacts and emulator setup are separate steps.

```sh
python3 tests/native/identity_deletion.py --source "$PWD" --serial emulator-5556 \
  --package org.nostrocket.hypergolic.identityfixture \
  --activity org.nostrocket.hypergolic.dev.MainActivity \
  --expected-apk-sha256 APP_SHA256 --output /private/tmp/hypergolic-system-deletion \
  identity-deletion
```

Eight checks pass: no-lock denial/selected-key exclusion; exact-review cancellation;
system cancellation; background revocation; wrong-PIN denial; the 60-second native
timeout; successful PIN deletion with three actual loaded DOM drafts retained;
and the removed inventory/current workspace after a process restart. The runner
validates the native system dialog's title and foreground owner. System credential
screenshots are intentionally blank under Android capture protection; UI hierarchy
and actual authentication/effect results are the evidence for the prompt itself.
Review the ordinary Settings/draft screenshots separately.

This is API 36 emulator evidence, not physical-device or biometric-enrollment proof.
API 26–29 action compatibility, iOS physical authentication, backup/reveal, signing
and remote loading remain outside this journey. The production module adds no test
credential, test-mode switch, authentication-result setter or reset interface.

## Actual system-fingerprint deletion journey

`tests/native/identity_biometric.py` uses the same isolated API 36 fixture and
public scalar-2 import key. Enroll virtual fingerprint 1 through Android Settings
on the named disposable emulator before running; leave virtual fingerprint 2
unenrolled. The driver changes neither enrollment nor device credentials. Do not
run the PIN-only journey concurrently: its no-lock setup removes enrollment.

```sh
python3 tests/native/identity_biometric.py --source "$PWD" --serial emulator-5556 \
  --package org.nostrocket.hypergolic.identityfixture \
  --activity org.nostrocket.hypergolic.dev.MainActivity \
  --expected-apk-sha256 APP_SHA256 --output /private/tmp/hypergolic-fingerprint-deletion \
  identity-biometric
```

Four checks exercise the real Android BiometricPrompt: an unrecognised fingerprint
and system cancellation preserve the identity; leaving the app revokes the request
even when a matching sensor event follows; a fresh matched fingerprint deletes
only the inactive identity with all three live napplet drafts retained; and the
result/selected workspace survive restart. These are real OS callbacks from an
emulated sensor, not physical biometric hardware or iOS authentication proof.
The runner checks installed bytes and source/harness snapshots before and after.
System-protected screenshots remain blank; the native hierarchy and actual effect
checks supply that evidence. Keep failed/disconnected runs alongside successful
reruns; never relabel an interrupted run as passed.

## Manual backup

The owning JVM runner also compiles `BackupAuthorityProof.java` and
`BackupNsecProof.java` against production sources. Their 88 authority assertions
and 13 encoding assertions cover action confusion, selected identity/session
binding, stale inventory, authentication/reveal expiry, repeated reads and wiping
denied output. These use explicit authentication/storage doubles.

The actual system-fingerprint backup journey uses the same isolated API 36 fixture
with its public PIN and virtual fingerprint 1 already enrolled. It imports/selects
only public scalar 2 and preserves existing identities. The protected native panel
is excluded from screenshots and private-key accessibility. The runner requires
its screenshot pixels to be redacted before retaining the capture; it never stores
a revealed nsec.

```sh
python3 tests/native/identity_backup.py --source "$PWD" --serial emulator-5556 \
  --package org.nostrocket.hypergolic.identityfixture \
  --activity org.nostrocket.hypergolic.dev.MainActivity \
  --expected-apk-sha256 APP_SHA256 --output /private/tmp/hypergolic-system-backup \
  identity-backup
```

It exercises exact review/cancellation, OS cancellation, an unrecognised
fingerprint, background revocation during authentication, successful native reveal
and hide, screenshot redaction/accessibility exclusion, then background clearing
and fresh authentication on return. It seals owning source, driver and installed
APK bytes. Physical sensor, OEM capture and older-Android behavior remain separate
acceptance gates.
