import Foundation
import Synchronization
import Testing
@testable import IdentitySecretStore

/// Uses macOS's actual backup-exclusion property and permissions; does not pretend macOS proves iOS Data Protection.
final class TestFilePolicy: FilePolicy, Sendable {
  struct State: Sendable { var protected: [String] = []; var failTemporary = false; var failFinal = false }
  let state = Mutex(State())
  func protectNew(_ url: URL, directory: Bool) throws {
    if !directory {
      #expect((try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue == 0)
      if state.withLock({ $0.failTemporary }) { throw StoreFailure.unavailable }
    }
    var fresh = URL(fileURLWithPath: url.path, isDirectory: directory)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try fresh.setResourceValues(values)
    state.withLock { $0.protected.append(url.lastPathComponent) }
    try verify(url, directory: directory)
  }
  func verify(_ url: URL, directory: Bool) throws {
    if url.lastPathComponent.hasSuffix(".sealed"), state.withLock({ $0.failFinal }) { throw StoreFailure.unavailable }
    var fresh = URL(fileURLWithPath: url.path, isDirectory: directory)
    fresh.removeAllCachedResourceValues()
    let values = try fresh.resourceValues(forKeys: [.isExcludedFromBackupKey, .isSymbolicLinkKey])
    let mode = (try FileManager.default.attributesOfItem(atPath: fresh.path)[.posixPermissions] as? NSNumber)?.intValue
    guard values.isExcludedFromBackup == true, values.isSymbolicLink == false, mode == (directory ? 0o700 : 0o600) else { throw StoreFailure.unavailable }
  }
}

struct FileHarness {
  let base: URL, root: URL
  let policy = TestFilePolicy(), entropy = TestEntropy()
  let files: ExcludedAtomicFiles
  init() throws {
    base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("identity-files-test-" + UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: base, withIntermediateDirectories: false)
    root = base.appendingPathComponent("IdentitySecrets-v1", isDirectory: true)
    files = try ExcludedAtomicFiles(root: root, policy: policy, entropy: entropy)
  }
  func cleanup() throws { try FileManager.default.removeItem(at: base) }
}

@Test func realFileAtomicWriteKeepsRootTemporaryAndFinalExcluded() throws {
  let h = try FileHarness(); defer { try? h.cleanup() }
  #expect(try !h.files.hasArtifacts())
  try h.files.prepare()
  let slot = SecretSlot.secret(key(1)), first = Data("ciphertext fixture one".utf8), second = Data("ciphertext fixture two".utf8)
  try h.files.writeAtomically(slot, data: first)
  #expect(try h.files.read(slot) == first)
  try h.files.writeAtomically(slot, data: second)
  #expect(try h.files.read(slot) == second)
  let names = try FileManager.default.contentsOfDirectory(atPath: h.root.path)
  #expect(names == [slot.name + ".sealed"])
  #expect(h.policy.state.withLock { $0.protected.first } == "IdentitySecrets-v1")
  #expect(h.policy.state.withLock { $0.protected.filter { $0.hasPrefix(".pending-") }.count } == 2)
  try h.files.remove(slot)
  #expect(try h.files.read(slot) == nil)
  #expect(try !h.files.hasArtifacts())
}

@Test func exclusionFailureBeforeBytesPreservesOldFileAndLeavesNoTemporaryPayload() throws {
  let h = try FileHarness(); defer { try? h.cleanup() }; try h.files.prepare()
  try h.files.writeAtomically(.stage, data: Data("old ciphertext".utf8))
  h.policy.state.withLock { $0.failTemporary = true }
  #expect(throws: StoreFailure.unavailable) { try h.files.writeAtomically(.stage, data: Data("new ciphertext".utf8)) }
  #expect(try h.files.read(.stage) == Data("old ciphertext".utf8))
  #expect(try FileManager.default.contentsOfDirectory(atPath: h.root.path) == ["stage.sealed"])
}

@Test func uncertainFailureAfterRenameReadbackFindsWholeNewFile() throws {
  let h = try FileHarness(); defer { try? h.cleanup() }; try h.files.prepare()
  h.policy.state.withLock { $0.failFinal = true }
  #expect(throws: StoreFailure.unavailable) { try h.files.writeAtomically(.stage, data: Data("new ciphertext".utf8)) }
  h.policy.state.withLock { $0.failFinal = false }
  #expect(try h.files.read(.stage) == Data("new ciphertext".utf8))
  #expect(try FileManager.default.contentsOfDirectory(atPath: h.root.path) == ["stage.sealed"])
}

@Test func rootOrFileLostExclusionFailsWithoutAutomaticRepair() throws {
  let h = try FileHarness(); defer { try? h.cleanup() }; try h.files.prepare()
  try h.files.writeAtomically(.stage, data: Data("ciphertext".utf8))
  var url = h.root.appendingPathComponent("stage.sealed")
  var values = URLResourceValues(); values.isExcludedFromBackup = false
  try url.setResourceValues(values)
  // The OS reports effective inherited exclusion: the protected parent still excludes this child.
  #expect(try h.files.read(.stage) == Data("ciphertext".utf8))
  url = h.root; try url.setResourceValues(values)
  // Establish effective removal before testing refusal; inherited metadata can settle asynchronously.
  var excluded = true
  for _ in 0..<50 {
    var fresh = URL(fileURLWithPath: h.root.path, isDirectory: true)
    fresh.removeAllCachedResourceValues()
    excluded = try fresh.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup == true
    if !excluded { break }
    Thread.sleep(forTimeInterval: 0.01)
  }
  try #require(!excluded, "The fixture must actually lose effective backup exclusion")
  #expect(throws: StoreFailure.unavailable) { try h.files.prepare() }
  #expect(throws: StoreFailure.unavailable) { try h.files.hasArtifacts() }
  #expect(throws: StoreFailure.unavailable) { try h.files.read(.stage) }
  #expect(throws: StoreFailure.unavailable) { try h.files.remove(.stage) }
}

@Test func symlinksOversizeAndInvalidSlotCannotEscapeOrBecomeAbsent() throws {
  let h = try FileHarness(); defer { try? h.cleanup() }; try h.files.prepare()
  let outside = h.base.appendingPathComponent("outside")
  try Data("must remain".utf8).write(to: outside)
  let slot = h.root.appendingPathComponent("stage.sealed")
  try FileManager.default.createSymbolicLink(at: slot, withDestinationURL: outside)
  #expect(throws: StoreFailure.unavailable) { try h.files.read(.stage) }
  #expect(throws: StoreFailure.corruptState) { try h.files.remove(.stage) }
  #expect(try Data(contentsOf: outside) == Data("must remain".utf8))
  #expect(throws: StoreFailure.invalidInput) { try h.files.read(.secret("../../outside")) }
  #expect(throws: StoreFailure.unavailable) { try h.files.writeAtomically(.stage, data: Data(count: 2082)) }
}

@Test func orphanTemporaryCountsAsEvidenceAndProductionFilePolicyHasNoMacFallback() throws {
  let h = try FileHarness(); defer { try? h.cleanup() }; try h.files.prepare()
  try Data("encrypted pending fixture".utf8).write(to: h.root.appendingPathComponent(".pending-orphan"))
  #expect(try h.files.hasArtifacts())
  #if !os(iOS)
  #expect(throws: StoreFailure.unavailable) { try ExcludedAtomicFiles.applicationStore() }
  #expect(throws: StoreFailure.unavailable) { try SystemFilePolicy().protectNew(h.root, directory: true) }
  #endif
}
