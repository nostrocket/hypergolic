# Physical iOS identity storage tests

`Tests/AtRestTests.swift` compiles against the thirteen actual identity-store core
sources in an independent signed `AtRestProbe` app. It uses real SystemKeychain,
ExcludedAtomicFiles, SystemFilePolicy, SystemEntropy and CryptoKit. The known public
scalar2/public-key pair supplies disposable test data in the probe's own default
Keychain access group and app container. No retained Hypergolic identity is read.

Eight methods pass in one physical iPhone16/iOS26.5 run on 8 October2026. The five
historical methods cover real Keychain/file protection and backup-exclusion readback,
encrypted roundtrip, tamper/truncation/slot binding, established missing ciphertext,
missing wrapping key, permissions and symlinks. Three new methods pass real OS
corrupt-receipt, missing-receipt and legacy-record faults through IdentityBridgeOwner.
Their repeated read/initialization attempts preserve the existing wrapping key,
receipt/fault state and ciphertext; the counted real entropy port allocates no
replacement wrapping key. Explicit test restoration recovers the original data.

The native store factory is real and retained once across the corrupt-receipt
calls. The entropy counter delegates every request to SystemEntropy; it does not
supply deterministic cryptography. Faults modify only records created by this
probe. Preparation requires no preexisting Keychain items, legacy record or
secret directory. Cleanup removes only its owned test data and checks its exact
bundle and Keychain group. Receipts contain checks/counts, never wrapping keys or
secret payloads. Both normal Hypergolic apps/products and the primary process
remain unchanged; returning to the existing QA app reuses its process.

A prepared signed physical target includes this test file and seals all current
source/test/product bytes. Run its generated xctestrun from the original products
root against the explicit connected device, with parallel testing disabled. Keep
its input review, real XCTest summary and all eight native JSON attachments.
The existing historical source manifest remains unchanged; compilation alone is
not a device pass. This folder is separate from the macOS SwiftPM suite.

This proves the named native-core protection/failure cases. It does not establish
whole Expo bootstrap after a failed native read, device reboot/lock behavior,
authentication/export, real backup transport or full plaintext/log/crash absence.
ID01/02 remain partial; Android parity and full Phase2 acceptance remain open.
