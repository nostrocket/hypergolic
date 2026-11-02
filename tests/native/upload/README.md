# Isolated native upload tracer

Activate the repository's pinned Android/Node and iOS toolchains. Start `python3 tests/native/upload/serve.py --output FRESH_OBSERVER_DIRECTORY` in a separate terminal. It creates a disposable TLS certificate for `files.example.com`, listens only on loopback port 19943, independently verifies complete Schnorr authorization and records exact stored PNG bytes. Keep its private key and generated credentials out of source and shared evidence. Stop the server after the journey.

Build the isolated application with `python3 tests/native/upload/build.py --platform android --anchor OBSERVER_DIRECTORY/anchor.b64 --output FRESH_ANDROID_BUILD_DIRECTORY` and the equivalent `--platform ios`. The script restores generated Android configuration and records matching source fingerprints before/after packaging. Its disposable certificate is admitted only by the compile-gated native proof seam; ordinary builds retain public DNS and platform trust. These products use an explicitly known public signing key, not the protected identity store.

For Android, reverse TCP port 19943 with ADB, install the isolated APK, and run:

```sh
python3 tests/native/upload/android-upload.py --serial DEVICE \
  --apk ANDROID_BUILD_DIRECTORY/uploadfixture.apk --build ANDROID_BUILD_DIRECTORY/build.json \
  --observer OBSERVER_DIRECTORY/observer.json --output FRESH_ANDROID_JOURNEY_DIRECTORY
```

For iOS, install `IOS_BUILD_DIRECTORY/derived/Build/Products/Release-iphonesimulator/Hypergolic.app` with simctl, then run:

```sh
python3 tests/native/upload/ios-upload.py --device SIMULATOR_UUID \
  --app IOS_BUILD_DIRECTORY/derived/Build/Products/Release-iphonesimulator/Hypergolic.app --build IOS_BUILD_DIRECTORY/build.json \
  --observer OBSERVER_DIRECTORY/observer.json --output FRESH_IOS_JOURNEY_DIRECTORY
```

Run the two journeys sequentially: each compares independent connection/request counts before review, immediately after native Reject, and after one approved PUT. Each requires actual SDK receipt and cold launch. Android records screenshots/accessibility XML and installed APK equality; iOS uses the existing XCTest project and checks installed app files. Export and inspect XCTest screenshots separately before claiming visual review. Avoid concurrent UIAutomator commands during the Android driver.

The initial tracer accepts only its bounded, independently checked metadata-free PNG. It establishes neither system picker nor arbitrary photo sanitation, attachments, protected physical-device identity, uncertainty reconciliation or published upload acceptance. Those remain subsequent phase slices.


## Selected PNG journeys in progress

`python3 tests/native/upload/create-selected-png.py --output <outside-source>/selected-photo.png`
creates a generated 302-byte photo with Exif orientation 1, camera, date, GPS
latitude fields and PNG text. Its independently known sanitized output is the
same 71-byte red/green tracer. Add the seed to the iOS Simulator using
`xcrun simctl addmedia <device> <seed>` before its photo-picker journey.

`android-picker.py` takes the same Android build/APK/observer/serial/output arguments
as the first tracer plus `--seed <generated-photo.png>`. It copies the seed to the
emulator's controlled Download/UploadLab directory and selects it through actual
DocumentsUI inputs. `ios-upload.py --picker` runs the native photo-picker case.
Both verify selected sanitized bytes, trusted review, zero network after rejection,
guest read after rejection and exactly one approved TLS upload. They require fresh
sealed products containing the current fixture and drivers; a successful compile
or exploratory picker probe alone is not their acceptance result. Broader formats,
ordinary document selection, revoked picker callbacks and protected signing remain
outside these selected-PNG journeys.


## Guest-original and picker recipient proofs

Add `--originals` to each upload journey for generated public JPEG/HEIC originals
sent directly through the genuine SDK. These bypass selection and independently
check native PNG preparation, rejected dispatch counts, approved output pixels,
metadata, signature and original SDK receipt. Rebuild the napplet artifact,
explicitly copy its generated HTML and unsigned manifest into `runtime/fixtures`,
repin the catalogue hashes, then build the runtime before sealing native products.

`android-picker-denials.py --recipient-faults` and
`ios-picker-denials.py --recipient-faults --fixtures PHOTO_FIXTURE_DIRECTORY`
exercise the isolated host's timed native close/reconfiguration/renderer faults.
Android also requires `--fixtures`. The iOS renderer termination uses a
Simulator-only, proof-gated WebKit private selector. Ordinary native builds exclude
that operation. Configuration rejection is not ordinary workspace identity-switch
acceptance. Run these drivers sequentially with all native UI journeys; preserve
failed attempts separately and inspect exported XCTest screenshots.
