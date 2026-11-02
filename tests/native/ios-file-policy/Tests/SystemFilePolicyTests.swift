import Darwin
import Foundation
import XCTest

/// The production SystemFilePolicy and ExcludedAtomicFiles are compiled into this test target.
/// Every byte below is a public test fixture; this target has no Keychain or identity-store owner.
final class SystemFilePolicyTests: XCTestCase {
  #if targetEnvironment(simulator)
  func testSimulatorRejectsUnavailableProtectionBeforeWritingAnyPayload() throws {
    try withFixture { fixture in
      expectUnavailable { try fixture.files.prepare() }
      let attributes = try FileManager.default.attributesOfItem(atPath: fixture.root.path)
      XCTAssertNil(attributes[.protectionKey], "Selected Simulator cannot attest an iOS protection class")
      try assertMetadata(fixture.root, directory: true, requireProtection: false)
      expectUnavailable { try SystemFilePolicy().verify(fixture.root, directory: true) }
      expectUnavailable { try fixture.files.writeAtomically(.stage, data: Data("NONSECRET simulator fixture".utf8)) }
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.root.path), [],
                     "Unsupported storage must leave zero sealed files or pending payloads")
    }
  }
  #else
  func testPhysicalDeviceRetainsProtectionAcrossAtomicRenameAndRead() throws {
    try withFixture { fixture in
      try fixture.files.prepare()
      try assertMetadata(fixture.root, directory: true, requireProtection: true)
      let first = Data("NONSECRET file-policy fixture one".utf8)
      let replacement = Data("NONSECRET file-policy fixture two".utf8)
      try fixture.files.writeAtomically(.stage, data: first)
      XCTAssertEqual(try fixture.files.read(.stage), first)
      try fixture.files.writeAtomically(.stage, data: replacement)
      XCTAssertEqual(try fixture.files.read(.stage), replacement)
      try SystemFilePolicy().verify(fixture.stage, directory: false)
      try assertMetadata(fixture.stage, directory: false, requireProtection: true)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.root.path), ["stage.sealed"])
      try fixture.files.remove(.stage)
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.root.path), [])
    }
  }

  func testPhysicalDeviceRejectsDowngradedFileProtection() throws {
    try withFixture { fixture in
      try fixture.files.prepare()
      try fixture.files.writeAtomically(.stage, data: Data("NONSECRET downgrade fixture".utf8))
      try downgrade(fixture.stage)
      expectUnavailable { try SystemFilePolicy().verify(fixture.stage, directory: false) }
      expectUnavailable { _ = try fixture.files.read(.stage) }
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.root.path), ["stage.sealed"])
    }
  }

  func testPhysicalDeviceRejectsDowngradedDirectoryBeforeWritingPayload() throws {
    try withFixture { fixture in
      try fixture.files.prepare()
      try downgrade(fixture.root)
      expectUnavailable { try fixture.files.prepare() }
      expectUnavailable { try fixture.files.writeAtomically(.stage, data: Data("NONSECRET blocked fixture".utf8)) }
      XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: fixture.root.path), [])
    }
  }

  private func downgrade(_ url: URL) throws {
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                         ofItemAtPath: url.path)
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    let protection = try XCTUnwrap(attributes[.protectionKey] as? FileProtectionType)
    XCTAssertEqual(protection, .completeUntilFirstUserAuthentication,
                   "The negative test must establish an actual weaker class first")
  }
  #endif

  private func expectUnavailable(_ operation: () throws -> Void, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertThrowsError(try operation(), file: file, line: line) { error in
      XCTAssertEqual(error as? StoreFailure, .unavailable, file: file, line: line)
    }
  }

  private func assertMetadata(_ url: URL, directory: Bool, requireProtection: Bool) throws {
    let fresh = URL(fileURLWithPath: url.path, isDirectory: directory)
    let values = try fresh.resourceValues(forKeys: [.isExcludedFromBackupKey, .isSymbolicLinkKey])
    let attributes = try FileManager.default.attributesOfItem(atPath: fresh.path)
    XCTAssertEqual(values.isExcludedFromBackup, true)
    XCTAssertEqual(values.isSymbolicLink, false)
    XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, directory ? 0o700 : 0o600)
    if requireProtection {
      XCTAssertEqual(try XCTUnwrap(attributes[.protectionKey] as? FileProtectionType), .complete)
    }
  }

  private func withFixture(_ operation: (Fixture) throws -> Void) throws {
    let fixture = try Fixture()
    defer {
      do { try fixture.removeOwnedFixture() }
      catch { XCTFail("Could not remove the isolated nonsecret fixture") }
    }
    try operation(fixture)
  }
}

private struct Fixture {
  let base: URL
  let root: URL
  let files: ExcludedAtomicFiles
  var stage: URL { root.appendingPathComponent("stage.sealed", isDirectory: false) }

  init() throws {
    let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL
    let base = temporary.appendingPathComponent("HypergolicFilePolicyTest-" + UUID().uuidString, isDirectory: true)
    // Exclusive unique base: no existing application path, user input or prior test fixture is reused.
    guard Darwin.mkdir(base.path, 0o700) == 0 else { throw StoreFailure.unavailable }
    let root = base.appendingPathComponent("IdentitySecrets-v1", isDirectory: true)
    do {
      self.files = try ExcludedAtomicFiles(root: root, policy: SystemFilePolicy(), entropy: SystemEntropy())
      self.base = base
      self.root = root
    } catch {
      try FileManager.default.removeItem(at: base)
      throw error
    }
  }

  func removeOwnedFixture() throws {
    let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath().standardizedFileURL
    guard base.deletingLastPathComponent().standardizedFileURL.path == temporary.path,
      base.lastPathComponent.hasPrefix("HypergolicFilePolicyTest-"),
      UUID(uuidString: String(base.lastPathComponent.dropFirst("HypergolicFilePolicyTest-".count))) != nil,
      root.deletingLastPathComponent() == base, root.lastPathComponent == "IdentitySecrets-v1"
      else { throw StoreFailure.invalidInput }
    try FileManager.default.removeItem(at: base)
  }
}
