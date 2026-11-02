# Physical Android identity storage and ordinary-startup faults

This disposable Release target preserves the ordinary App/index entry, production
identity bootstrap, Expo SecureStore 57.0.3, native record reader and bundled SDK.
It uses `org.nostrocket.hypergolic.identitystorageprobe` and a separate `.test`
runner, both labelled **Hypergolic Storage Test**. It never targets the retained
Hypergolic app. No production receiver, diagnostic API, authentication double or
replacement storage implementation is added.

Build outside the source tree with the repository's local toolchain:

```sh
# Configure the pinned tools described in docs/development.md.
python3 tests/native/android-identity-atrest/build.py --output /tmp/storage-build
python3 -m unittest discover -s tests/native/android-identity-atrest -p 'test_driver.py'
python3 tests/native/android-identity-atrest/run.py --serial DEVICE_SERIAL \
  --build /tmp/storage-build --output /tmp/storage-physical
```

Each output directory must be fresh. The build locks reviewed owning source/SDK
hashes, retains the ordinary JavaScript bundle/runtime assets, checks the isolated
package IDs, distinct labels and nondebuggable ARM64 target, and seals matching
app/runner signing certificates. A build alone does not prove physical behavior.
The driver requires physical API31+ Android, refuses existing test targets, binds
compiled inputs and installed APK bytes, and checks the agreed retained APK hash.
The retained-app hash is an explicit current-product pin; review it before updating
that product. Ordinary installer approval is scoped to the observed exact test
label and enabled Install button. No installer policy or remembered choice changes.

## Physical workflow

1. Let normal first entry generate one disposable identity. Independently validate
   the rendered npub checksum and decoded public key. Open the original State Lab
   through native Settings, confirm its SDK public key and write a harmless value.
2. Read the actual protected inventory and encrypted records in the isolated native
   process. Check an AES256 nonexportable Keystore key, record its real KeyInfo
   security level and confirm the existing `requireAuthentication:false` storage
   profile. Authentication for manual backup/deletion is a separate workflow.
3. Inject corrupt inventory, corrupt secret, missing inventory, missing secret,
   legacy inventory and finally a missing wrapping key into this fresh app only.
   Launch the ordinary Expo Activity twice from verified stopped processes per
   fault. Require the exact recovery heading/detail, no ready identity header and
   no admitted WebView. Recheck native metadata and wrapping-key continuity.
4. Between nondestructive faults restore the original ciphertext in the private
   native process. Ordinary startup must recover the same identity and the exact
   value through the original SDK. Wrapping-key deletion is last and cannot be
   restored; its checkpoint requires no replacement alias or metadata identity.
5. Reconcile exact live jobs, uninstall both hash-matched temporary packages and
   verify their absence and the unchanged retained APK. Cleanup is part of the
   result, including incomplete runs. Preserve failures without replaying input.

The pinned SDK deletes the specific unreadable record on BadPaddingException or
missing wrapping key. The checkpoint allows only that exact disappearance; all
other records must remain byte-identical, with unchanged metadata and no new
wrapping alias. It does not weaken production policy or claim all ciphertext is
unchanged in those cases. The encrypted continuity challenge proves reuse of the
same unexportable key where that key remains, beyond alias-name comparisons.

## Evidence boundaries

Only public outcomes, assertion counts, hashes and original public UI leave the
native process. A ciphertext baseline and public continuity challenge remain in
that disposable app's no-backup directory. The generated development key is read
only inside that native process to scan bounded private files and own-UID logs for
raw bytes, both hex cases, nsec and Base64 encodings. It is never exported to the
host. Mutable byte/char buffers are cleared; Java/JSON Strings are not zeroized.
The scan covers observed files/cache/no_backup/shared_prefs/databases/code_cache/
app_webview folders, at most32MiB per file/128MiB total, and at most16MiB of
own-UID Logcat. It is neither an unlimited leak-absence proof nor a crash dump,
heap, all-logs, device-backup or adversarial guest-memory inspection.

Actual backup/device-transfer exclusion is inspected separately in packaged XML.
No actual cloud/device-transfer transport, lock/unlock or reboot is exercised by
this driver. No generator-call counter is added: checkpoints prove no persisted
replacement metadata identity/wrapping alias, not zero entropy function calls.
Full ID01/02, native security, both-platform parity and Phase2 remain open until
all required evidence is complete. Original screenshots need independent visual
review; structured receipts alone do not prove the rendered result.

Android's [KeyInfo](https://developer.android.com/reference/android/security/keystore/KeyInfo)
reports actual key attributes. Security level1 denotes a trusted execution
[environment](https://developer.android.com/reference/android/security/keystore/KeyProperties#SECURITY_LEVEL_TRUSTED_ENVIRONMENT),
not StrongBox or a remote-attestation proof.
