@testable import AtRestProbe
import CryptoKit
import Foundation
import Security
import Synchronization
import UIKit
import XCTest

private final class CountedSystemEntropy:EntropySource,Sendable {
 let count=Mutex(0)
 func bytes(count n:Int)throws->Data {if n==32{count.withLock{$0 += 1}};return try SystemEntropy().bytes(count:n)}
}
private enum ProbeFailure:Error {case check(String)}
@MainActor final class AtRestTests:XCTestCase {
 private let qaBundle="org.nostrocket.hypergolic.atrestprobe.20261007"
 private let pub="c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"
 private var files:ExcludedAtomicFiles!,store:IdentityFileStore!,root:URL!,entropy:CountedSystemEntropy!,owned=false
 private let keychain=SystemKeychain()
 private func require(_ value:Bool,_ reason:String)throws {if !value{throw ProbeFailure.check(reason)}}
 private func query(_ item:KeychainItem)->[String:Any] {[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:SystemKeychain.service,kSecAttrAccount as String:item.rawValue,kSecAttrGeneric as String:Data(item.rawValue.utf8),kSecAttrSynchronizable as String:false,kSecUseDataProtectionKeychain as String:true]}
 private func attributes(_ item:KeychainItem)throws->[String:Any]? {var q=query(item);q[kSecReturnAttributes as String]=true;q[kSecMatchLimit as String]=kSecMatchLimitOne;var result:CFTypeRef?;let status=SecItemCopyMatching(q as CFDictionary,&result);if status==errSecItemNotFound{return nil};try require(status==errSecSuccess,"Keychain attribute query failed");guard let value=result as? [String:Any] else{throw ProbeFailure.check("Keychain attributes unavailable")};try require((value[kSecAttrAccessGroup as String] as? String)?.hasSuffix("."+qaBundle)==true,"Unexpected Keychain access group");return value}
 private func prepareProbe()throws {
  continueAfterFailure=false;try require(Bundle.main.bundleIdentifier==qaBundle,"Probe bundle gate");try require(UIApplication.shared.isProtectedDataAvailable,"Actual protected data unavailable")
  try require(try attributes(.wrappingKey)==nil&&attributes(.receipt)==nil,"Probe has preexisting Keychain data; preserve it");try require(try !keychain.hasLegacyStage(),"Probe has preexisting legacy stage; preserve it")
  let support=try FileManager.default.url(for:.applicationSupportDirectory,in:.userDomainMask,appropriateFor:nil,create:true);root=support.appendingPathComponent("IdentitySecrets-v1",isDirectory:true);try require(!FileManager.default.fileExists(atPath:root.path),"Probe has preexisting files; preserve them")
  files=try ExcludedAtomicFiles.applicationStore();entropy=CountedSystemEntropy();store=IdentityFileStore(keychain:keychain,files:files,entropy:entropy,authorization:NativeIdentityDeletionAuthority.shared)
 }
 private func cleanupProbe()throws {
  guard owned else{return};try require(Bundle.main.bundleIdentifier==qaBundle,"Cleanup bundle gate")
  for item in [KeychainItem.wrappingKey,.receipt]{if try attributes(item) != nil{let status=SecItemDelete(query(item) as CFDictionary);try require(status==errSecSuccess,"Owned QA Keychain cleanup failed")}}
  if FileManager.default.fileExists(atPath:root.path){try FileManager.default.removeItem(at:root)}
 }
 private func runProbe(_ body:@MainActor ()async throws->Void)async throws {
  try prepareProbe()
  do{try await body();try cleanupProbe()}catch{try cleanupProbe();throw error}
 }
 private func json(_ value:[Any])throws->String {String(data:try JSONSerialization.data(withJSONObject:value,options:.sortedKeys),encoding:.utf8)!}
 private var scalar:String {String(repeating:"0",count:63)+"2"}
 private func initial()throws->String {try json(["HGI1","PhysicalQaVault20261007",0,0,NSNull(),[]])}
 private func payload()throws->String {try json(["HGK1",pub,scalar])}
 private func boot()async throws {
  let absent=try await store.getItem("inventory");try require(absent==nil,"Fresh probe absence");owned=true;try await store.setItem("inventory",value:initial());try await store.setItem("secret."+pub,value:payload());try await store.setItem("inventory",value:json(["HGI1","PhysicalQaVault20261007",1,1,pub,[[pub,0,0]]]))
 }
 private func denial(_ expected:StoreFailure,_ block:()async throws->Void)async throws {do{try await block();throw ProbeFailure.check("Fault unexpectedly succeeded")}catch let e as StoreFailure{try require(e==expected,"Wrong native denial")}}
 private func receipt(_ name:String,_ details:[String:Any])throws {
  let data=try JSONSerialization.data(withJSONObject:["kind":"hypergolic-physical-ios-atrest-core-v1","test":name,"passed":true,"details":details,"scope":"Separate physical app/default Keychain access group and private container. Actual production13 sources, real OS policy/Keychain/CryptoKit; no retained Hypergolic key/data access, no Expo/auth/backup transport proof."],options:[.prettyPrinted,.sortedKeys]);let a=XCTAttachment(data:data,uniformTypeIdentifier:"public.json");a.name=name+"-receipt";a.lifetime = .keepAlways;add(a)
 }
 func testActualKeychainFileProtectionCiphertextAndFreshReader()async throws {
  try await runProbe {

  try await boot();var filtered:[[String:Any]]=[]
  for item in [KeychainItem.wrappingKey,.receipt]{let a=try attributes(item)!;try require(a[kSecAttrAccessible as String] as? String==kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String,"Keychain accessibility mismatch");try require((a[kSecAttrSynchronizable as String] as? NSNumber)?.boolValue != true,"Unexpected synchronized item");filtered.append(["item":item.rawValue,"accessible":a[kSecAttrAccessible as String] as? String ?? "","accessGroupMatchesQa":true,"synchronizable":(a[kSecAttrSynchronizable as String] as? NSNumber)?.boolValue ?? false])}
  let path=root.appendingPathComponent("secret."+pub+".sealed"),policy=SystemFilePolicy();try policy.verify(root,directory:true);try policy.verify(path,directory:false)
  let ciphertext=try files.read(.secret(pub))!;try require(ciphertext.starts(with:Data("HGIF1".utf8))&&ciphertext.range(of:Data(scalar.utf8))==nil&&ciphertext.range(of:Data(try payload().utf8))==nil,"Ciphertext contained public test plaintext")
  let fresh=IdentityFileStore(keychain:SystemKeychain(),files:try ExcludedAtomicFiles.applicationStore(),entropy:SystemEntropy(),authorization:NativeIdentityDeletionAuthority.shared);let roundtrip=try await fresh.getItem("secret."+pub);try require(roundtrip==payload(),"Fresh native reader differs");let inventory=try await fresh.validatedInventory();try require(inventory.selectedPubkey==pub&&inventory.identityDigests.count==1,"Validated native inventory differs")
  try receipt("real-keychain-protection-encryption-roundtrip",["keychainAttributes":filtered,"directoryPermissions":448,"filePermissions":384,"completeFileProtectionReadback":true,"excludedFromBackupReadback":true,"ciphertextBytes":ciphertext.count,"publicFixturePlaintextAbsent":true,"freshReaderMatches":true,"nativeInventoryMatches":true])
 
  }
 }
 func testRealCryptoKitTamperTruncationAndSlotBindingDeny()async throws {
  try await runProbe {

  try await boot();let slot=SecretSlot.secret(pub),original=try files.read(slot)!;var changed=original;changed[changed.count-1] ^= 1
  for bad in [changed,Data(original.dropLast())]{try files.writeAtomically(slot,data:bad);try await denial(.corruptState){_ = try await self.store.getItem("secret."+self.pub)}}
  let wrong=String(repeating:"f",count:64);try files.writeAtomically(.secret(wrong),data:original);try await denial(.corruptState){_ = try await self.store.getItem("secret."+wrong)};try files.writeAtomically(slot,data:original);let restored=try await store.getItem("secret."+pub);try require(restored==payload(),"Tamper restoration differs")
  try receipt("real-aes-gcm-tamper-truncation-slot-binding",["bitFlipDenied":true,"truncationDenied":true,"wrongSlotDenied":true,"originalRestored":true])
 
  }
 }
 func testEstablishedMissingCiphertextNeverRegenerates()async throws {
  try await runProbe {

  try await boot();let old=try keychain.read(.wrappingKey);try files.remove(.secret(pub));try await denial(.recoveryRequired){try await self.store.setItem("secret."+self.pub,value:self.payload())};let absent=try files.read(.secret(pub));let current=try keychain.read(.wrappingKey);try require(absent==nil&&old==current&&entropy.count.withLock({$0})==1,"Missing ciphertext regenerated or wrapping key changed")
  try receipt("established-missing-ciphertext-denies-replacement",["denial":"recoveryRequired","ciphertextStillAbsent":true,"wrappingKeyUnchanged":true,"wrappingEntropyCalls":1])
 
  }
 }
 func testMissingWrappingKeyWithArtifactsNeverAllocatesReplacement()async throws {
  try await runProbe {

  try await boot();let original=try files.read(.secret(pub));_ = try attributes(.wrappingKey);try require(SecItemDelete(query(.wrappingKey) as CFDictionary)==errSecSuccess,"Owned wrapping key fault injection failed")
  try await denial(.recoveryRequired){_ = try await self.store.getItem("inventory")};try await denial(.recoveryRequired){try await self.store.setItem("inventory",value:self.initial())};let missing=try keychain.read(.wrappingKey),retained=try keychain.read(.receipt),cipher=try files.read(.secret(pub));try require(missing==nil&&retained != nil&&cipher==original&&entropy.count.withLock({$0})==1,"Missing wrapping key regenerated or artifacts changed")
  try receipt("missing-wrapping-key-denies-bootstrap-replacement",["readDenied":true,"writeDenied":true,"wrappingKeyStillAbsent":true,"receiptRetained":true,"ciphertextUnchanged":true,"wrappingEntropyCalls":1])
 
  }
 }
 func testRealPermissionAndSymlinkFaultsDenyWithoutOutsideEffects()async throws {
  try await runProbe {

  try await boot();let path=root.appendingPathComponent("secret."+pub+".sealed"),original=try files.read(.secret(pub))!;try FileManager.default.setAttributes([.posixPermissions:0o644],ofItemAtPath:path.path);try await denial(.unavailable){_ = try await self.store.getItem("secret."+self.pub)};try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:path.path)
  let outside=root.deletingLastPathComponent().appendingPathComponent("public-qa-outside-control");let marker=Data("public-qa-control".utf8);try marker.write(to:outside);defer{try? FileManager.default.removeItem(at:outside)};try FileManager.default.removeItem(at:path);try FileManager.default.createSymbolicLink(at:path,withDestinationURL:outside);try await denial(.unavailable){_ = try await self.store.getItem("secret."+self.pub)};try require(try Data(contentsOf:outside)==marker,"Outside QA control changed");try FileManager.default.removeItem(at:path);try files.writeAtomically(.secret(pub),data:original);let readback=try await store.getItem("secret."+pub);try require(readback==payload(),"Policy fault restoration differs")
  try receipt("real-permission-symlink-fault-denial",["wrongModeDenied":true,"symlinkDenied":true,"outsideQaControlUnchanged":true,"originalRestored":true])
 
  }
 }
 func testRealCorruptReceiptThroughNativeBridgeNeverRegenerates()async throws {
  try await runProbe {
   try await boot()
   let wrapping=try keychain.read(.wrappingKey),cipher=try files.read(.secret(pub)),originalReceipt=try keychain.read(.receipt)
   let actualFiles=try XCTUnwrap(files),actualEntropy=try XCTUnwrap(entropy),factoryCalls=Mutex(0)
   let bridge=IdentityBridgeOwner {factoryCalls.withLock{$0 += 1};return IdentityFileStore(keychain:SystemKeychain(),files:actualFiles,entropy:actualEntropy,authorization:NativeIdentityDeletionAuthority.shared)}
   let malformed=[Data("{}".utf8),Data(String(repeating:"x",count:2049).utf8),Data("[\"HGI1\",\"PhysicalQaVault20261007\",true,0,null,[]]".utf8)]
   for bad in malformed {
    try keychain.updateReceipt(bad)
    for _ in 0..<3 {
     try await denial(.corruptState){_ = try await bridge.readInventory()}
     try await denial(.corruptState){try await bridge.writeInventory(self.initial())}
     try await denial(.corruptState){_ = try await bridge.readSecret(self.pub)}
    }
    let retainedKey=try keychain.read(.wrappingKey),retainedReceipt=try keychain.read(.receipt),retainedCipher=try files.read(.secret(pub))
    try require(retainedKey==wrapping&&retainedReceipt==bad&&retainedCipher==cipher,"Corrupt native receipt replaced data")
   }
   try require(actualEntropy.count.withLock({$0})==1&&factoryCalls.withLock({$0})==1,"Corrupt read recreated native store or wrapping key")
   try keychain.updateReceipt(try XCTUnwrap(originalReceipt));let recovered=try await bridge.readSecret(pub);try require(recovered==payload(),"Original record did not recover after restoring receipt")
   try receipt("real-corrupt-receipt-native-bridge-blocks-reinitialization",["realKeychainFaults":3,"deniedReadWriteReadSecretCalls":27,"nativeStoreFactoryCalls":1,"wrappingEntropyCalls":1,"wrappingKeyUnchanged":true,"ciphertextUnchanged":true,"badReceiptPreservedUntilExplicitTestRestoration":true,"originalRecovered":true])
  }
 }
 func testRealMissingReceiptWithExistingWrappingKeyBlocksInitialization()async throws {
  try await runProbe {
   try await boot();let wrapping=try keychain.read(.wrappingKey),cipher=try files.read(.secret(pub)),originalReceipt=try keychain.read(.receipt)
   _ = try attributes(.receipt);try require(SecItemDelete(query(.receipt) as CFDictionary)==errSecSuccess,"Owned receipt removal fault failed")
   let actualFiles=try XCTUnwrap(files),actualEntropy=try XCTUnwrap(entropy)
   let bridge=IdentityBridgeOwner {IdentityFileStore(keychain:SystemKeychain(),files:actualFiles,entropy:actualEntropy,authorization:NativeIdentityDeletionAuthority.shared)}
   for _ in 0..<3 {
    try await denial(.recoveryRequired){_ = try await bridge.readInventory()}
    try await denial(.recoveryRequired){try await bridge.writeInventory(self.initial())}
   }
   let missing=try keychain.read(.receipt),retainedKey=try keychain.read(.wrappingKey),retainedCipher=try files.read(.secret(pub))
   try require(missing==nil&&wrapping==retainedKey&&cipher==retainedCipher&&actualEntropy.count.withLock({$0})==1,"Missing receipt regenerated or existing data changed")
   try keychain.add(.receipt,value:try XCTUnwrap(originalReceipt));let restored=try await bridge.readSecret(pub);try require(restored==payload(),"Restored receipt could not read original ciphertext")
   try receipt("real-missing-receipt-native-bridge-blocks-reinitialization",["deniedReadWriteCalls":6,"receiptStillAbsentUntilExplicitTestRestoration":true,"wrappingKeyUnchanged":true,"ciphertextUnchanged":true,"wrappingEntropyCalls":1,"originalRecovered":true])
  }
 }
 func testRealLegacyKeychainStageBlocksNativeInitializationWithoutMutation()async throws {
  try await runProbe {
   try await boot();let wrapping=try keychain.read(.wrappingKey),originalReceipt=try keychain.read(.receipt),cipher=try files.read(.secret(pub))
   var legacy=query(.receipt);legacy[kSecAttrAccount as String]=Data("stage".utf8);legacy[kSecAttrGeneric as String]=Data("stage".utf8)
   var addQuery=legacy;addQuery[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly;addQuery[kSecValueData as String]=Data("public-qa-legacy-marker".utf8)
   try require(SecItemAdd(addQuery as CFDictionary,nil)==errSecSuccess,"Owned legacy fault insertion failed")
   defer {let status=SecItemDelete(legacy as CFDictionary);XCTAssertEqual(status,errSecSuccess,"Remove only owned test-created legacy record")}
   let actualFiles=try XCTUnwrap(files),actualEntropy=try XCTUnwrap(entropy)
   let bridge=IdentityBridgeOwner {IdentityFileStore(keychain:SystemKeychain(),files:actualFiles,entropy:actualEntropy,authorization:NativeIdentityDeletionAuthority.shared)}
   for _ in 0..<3 {
    try await denial(.recoveryRequired){_ = try await bridge.readInventory()}
    try await denial(.recoveryRequired){try await bridge.writeInventory(self.initial())}
    try await denial(.recoveryRequired){_ = try await bridge.readSecret(self.pub)}
   }
   let retainedKey=try keychain.read(.wrappingKey),retainedReceipt=try keychain.read(.receipt),retainedCipher=try files.read(.secret(pub))
   try require(try keychain.hasLegacyStage()&&wrapping==retainedKey&&originalReceipt==retainedReceipt&&cipher==retainedCipher&&actualEntropy.count.withLock({$0})==1,"Legacy guard mutated records or regenerated wrapping key")
   try receipt("real-legacy-stage-native-bridge-blocks-reinitialization",["deniedReadWriteReadSecretCalls":9,"legacyStageStillPresent":true,"wrappingKeyUnchanged":true,"receiptUnchanged":true,"ciphertextUnchanged":true,"wrappingEntropyCalls":1])
  }
 }

}
