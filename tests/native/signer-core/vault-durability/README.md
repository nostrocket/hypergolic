# Native Android vault durability regression

The production file caller must not acknowledge a vault mutation after a required
sync fails. This offline test compiles the actual `NativeVaultFile.java` and
`NativeSecretBuffer.java`; it uses real host AES-GCM, fresh IVs and temporary files.
Android Context/Os, AtomicFile and the hardware Keystore are explicit fault doubles.
The AtomicFile double models the relevant pinned AOSP log-only finish failure,
rename and old/new-file behavior. It is not deployed vendor code or crash simulation.

Twelve cases / 34 assertions cover successful encrypted cold readback; checked file
sync before finish; initial and replacement sync denial; parent/directory failure
after rename despite readable new bytes; partial write abort; failed rename;
readback failure; and the real production constructor's directory sync, close and
type-validation paths. The original caller fails these same contract cases. A
post-commit error never rolls back/retries the new file, and a partial initial key
state must require recovery. Authenticated metadata/OS-auth/actual Android behavior
remain covered by their separate owning suites and physical acceptance.

```sh
python3 tests/native/signer-core/vault-durability/run.py \
  --output /tmp/native-vault-durability-UNIQUE \
  --android-jar .tools/android-sdk/platforms/android-36/android.jar
```

Use an existing JDK17+ (`.tools/jdk/Contents/Home` by default, or `--java-home`).
`--vault-file` selects an exact older source for a negative control. The supplied
file must be named NativeVaultFile.java and its unchanged helper must be in the
source checkout or beside it. Every output directory must be new. Inputs, commands,
exit codes and raw stdout/stderr are retained. No Gradle, package installation,
network, emulator/device, application build or source mutation is performed.

The AOSP implementation at commit `1cdfff555f4a21f71ccc978290e2e212e2f8b168`
[logs sync/close failures and still renames](https://android.googlesource.com/platform/frameworks/base/+/1cdfff555f4a21f71ccc978290e2e212e2f8b168/core/java/android/util/AtomicFile.java).
The checked file barrier precedes this void API; checked directory barriers follow
it. Internal redundant sync/close logging is still not observable through AtomicFile.
The test neither proves power-loss durability nor asserts that every vendor matches
this commit. Matching filesystem directory-sync support and the deployed platform
remain device gates; unsupported barriers fail closed.
