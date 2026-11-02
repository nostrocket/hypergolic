import XCTest
import Foundation
import Synchronization
import UIKit
@testable import SignerProbe

final class SignerCoreTests: XCTestCase {
  override func tearDown() {
    print("SIGNER_CORE_ASSERTIONS=\(signerAssertionCount.withLock { $0 })")
    super.tearDown()
  }
  private func json(_ pubkey: String, content: String = "Disposable trace") -> String {
    "{\"pubkey\":\"\(pubkey)\",\"created_at\":1,\"kind\":1,\"tags\":[[\"r\",\"wss://example.com\"]],\"content\":\(ExactSignerEvent.quote(content))}"
  }
  func testRealSignatureAndReplayDenied() throws {
    let owner = SignerOwner(), core = NativeSignerCore(owner: owner)
    let pubkey = try core.generate(owner: owner)
    signerAssertEqual(pubkey.count, 64)
    let review = try core.beginReview(owner: owner, unsignedJSON: json(pubkey))
    let signed = try core.approveAndSign(owner: owner, handle: review.handle)
    let event = try signerUnwrap(JSONSerialization.jsonObject(with: Data(signed.utf8)) as? [String: Any])
    signerAssertEqual(event["pubkey"] as? String, pubkey)
    signerAssertEqual(event["content"] as? String, "Disposable trace")
    signerAssertEqual((event["sig"] as? String)?.count, 128)
    signerAssertEqual(event["id"] as? String, review.event.digest.hex)
    signerAssertThrowsError(try core.approveAndSign(owner: owner, handle: review.handle))
  }
  func testWrongOwnerCannotGenerateReviewOrApprove() throws {
    let owner = SignerOwner(), other = SignerOwner(), core = NativeSignerCore(owner: owner)
    signerAssertThrowsError(try core.generate(owner: other))
    let pubkey = try core.generate(owner: owner)
    signerAssertThrowsError(try core.beginReview(owner: other, unsignedJSON: json(pubkey)))
    let review = try core.beginReview(owner: owner, unsignedJSON: json(pubkey))
    signerAssertThrowsError(try core.approveAndSign(owner: other, handle: review.handle))
    signerAssertNoThrow(try core.approveAndSign(owner: owner, handle: review.handle))
  }
  func testForeignHandleCannotApprove() throws {
    let owner = SignerOwner(), first = NativeSignerCore(owner: owner), second = NativeSignerCore(owner: owner)
    let pubkey1 = try first.generate(owner: owner), pubkey2 = try second.generate(owner: owner)
    let a = try first.beginReview(owner: owner, unsignedJSON: json(pubkey1))
    _ = try second.beginReview(owner: owner, unsignedJSON: json(pubkey2))
    signerAssertThrowsError(try second.approveAndSign(owner: owner, handle: a.handle))
  }
  func testRejectAndCancelDenySigning() throws {
    let owner = SignerOwner(), core = NativeSignerCore(owner: owner)
    let pubkey = try core.generate(owner: owner)
    let rejected = try core.beginReview(owner: owner, unsignedJSON: json(pubkey))
    try core.reject(owner: owner, handle: rejected.handle)
    signerAssertThrowsError(try core.approveAndSign(owner: owner, handle: rejected.handle))
    let cancelled = try core.beginReview(owner: owner, unsignedJSON: json(pubkey))
    core.cancelReview()
    signerAssertThrowsError(try core.approveAndSign(owner: owner, handle: cancelled.handle))
  }
  func testExpiredKeyCannotApproveOrSilentlyReplace() throws {
    let clock = Mutex(Duration.zero), owner = SignerOwner()
    let core = NativeSignerCore(owner: owner, testingClock: { clock.withLock { $0 } })
    let pubkey = try core.generate(owner: owner)
    clock.withLock { $0 = .seconds(300) }
    signerAssertEqual(try core.generate(owner: owner), pubkey)
    let review = try core.beginReview(owner: owner, unsignedJSON: json(pubkey))
    clock.withLock { $0 = .seconds(600) }
    signerAssertThrowsError(try core.approveAndSign(owner: owner, handle: review.handle))
    signerAssertThrowsError(try core.generate(owner: owner))
  }
  func testClockRollbackRevokesAuthority() throws {
    let clock = Mutex(Duration.seconds(10)), owner = SignerOwner()
    let core = NativeSignerCore(owner: owner, testingClock: { clock.withLock { $0 } })
    let pubkey = try core.generate(owner: owner)
    let review = try core.beginReview(owner: owner, unsignedJSON: json(pubkey))
    clock.withLock { $0 = .seconds(9) }
    signerAssertThrowsError(try core.approveAndSign(owner: owner, handle: review.handle))
  }
  func testRevocationDeniesPendingSignature() throws {
    let owner = SignerOwner(), core = NativeSignerCore(owner: owner)
    let pubkey = try core.generate(owner: owner)
    let review = try core.beginReview(owner: owner, unsignedJSON: json(pubkey))
    core.revoke()
    signerAssertThrowsError(try core.approveAndSign(owner: owner, handle: review.handle))
    signerAssertThrowsError(try core.beginReview(owner: owner, unsignedJSON: json(pubkey)))
  }
  func testSubstitutionAndBusyDenied() throws {
    let owner = SignerOwner(), core = NativeSignerCore(owner: owner)
    let pubkey = try core.generate(owner: owner)
    signerAssertThrowsError(try core.beginReview(owner: owner, unsignedJSON: json(String(repeating: "0", count: 64))))
    let review = try core.beginReview(owner: owner, unsignedJSON: json(pubkey, content: "Reviewed"))
    signerAssertThrowsError(try core.beginReview(owner: owner, unsignedJSON: json(pubkey, content: "Altered")))
    let signed = try core.approveAndSign(owner: owner, handle: review.handle)
    signerAssertTrue(signed.contains("Reviewed")); signerAssertFalse(signed.contains("Altered"))
  }
  func testAmbiguousJSONDenied() throws {
    let pubkey = String(repeating: "a", count: 64), valid = json(pubkey)
    for input in [valid + "x", valid.replacingOccurrences(of: "\"kind\":1", with: "\"kind\":1,\"kind\":2"),
      valid.replacingOccurrences(of: "\"kind\":1", with: "\"kind\":1.0"),
      valid.replacingOccurrences(of: "\"kind\":1", with: "\"kind\":1e0"),
      valid.replacingOccurrences(of: "\"created_at\":1", with: "\"created_at\":9007199254740992"),
      valid.replacingOccurrences(of: "\"kind\":1", with: "\"kind\":65536"),
      valid.replacingOccurrences(of: "\"kind\":1", with: "\"kind\":01"),
      valid.replacingOccurrences(of: "\"kind\":1", with: "\"approved\":true,\"kind\":1"),
      valid.replacingOccurrences(of: "[[\"r\",\"wss://example.com\"]]", with: "[[]]")] {
      signerAssertThrowsError(try ExactSignerEvent(json: input, expectedPubkey: pubkey), input)
    }
  }
  func testMalformedSurrogateAndOversizeDenied() throws {
    let pubkey = String(repeating: "a", count: 64), valid = json(pubkey)
    for content in ["\\ud800", "\\udc00", "\\ud800\\u0041"] {
      let input = valid.replacingOccurrences(of: "Disposable trace", with: content)
      signerAssertThrowsError(try ExactSignerEvent(json: input, expectedPubkey: pubkey))
    }
    signerAssertThrowsError(try ExactSignerEvent(json: json(pubkey, content: String(repeating: "a", count: ExactSignerEvent.maximumBytes)), expectedPubkey: pubkey))
  }
  @MainActor func testGenerationTimerWipesWithoutAnyReview() async throws {
    let owner = SignerOwner(), core = NativeSignerCore(owner: owner)
    let coordinator = NativeSignerReviewCoordinator(core: core, owner: owner, current: { true }, testingKeyLifetime: .milliseconds(30))
    _ = try coordinator.generate()
    try await Task.sleep(for: .milliseconds(15))
    _ = try coordinator.generate() // Repeated generation must not extend key lifetime.
    try await Task.sleep(for: .milliseconds(60))
    signerAssertTrue(core.isRevoked)
    signerAssertThrowsError(try coordinator.generate())
  }
  func testCanonicalUnicodeMatchesJSONStringify() throws {
    let pubkey = String(repeating: "a", count: 64)
    let content = "🛰️/\u{2028}\u{2029}\n\t\u{0001}\"\\"
    let event = try ExactSignerEvent(json: json(pubkey, content: content), expectedPubkey: pubkey)
    signerAssertEqual(event.content, content)
    signerAssertTrue(event.canonical.contains("🛰️/\u{2028}\u{2029}\\n\\t\\u0001\\\"\\\\"))
  }
}

private let signerAssertionCount = Mutex(0)
private func recordSignerAssertion() { signerAssertionCount.withLock { $0 += 1 } }
private func signerAssertTrue(_ expression: @autoclosure () throws -> Bool, file: StaticString = #filePath, line: UInt = #line) {
  recordSignerAssertion(); XCTAssertTrue(try expression(), file: file, line: line)
}
private func signerAssertFalse(_ expression: @autoclosure () throws -> Bool, file: StaticString = #filePath, line: UInt = #line) {
  recordSignerAssertion(); XCTAssertFalse(try expression(), file: file, line: line)
}
private func signerAssertEqual<T: Equatable>(_ a: @autoclosure () throws -> T, _ b: @autoclosure () throws -> T, file: StaticString = #filePath, line: UInt = #line) {
  recordSignerAssertion(); XCTAssertEqual(try a(), try b(), file: file, line: line)
}
private func signerAssertThrowsError<T>(_ expression: @autoclosure () throws -> T, _ message: @autoclosure () -> String = "", file: StaticString = #filePath, line: UInt = #line) {
  recordSignerAssertion(); XCTAssertThrowsError(try expression(), message(), file: file, line: line)
}
private func signerAssertNoThrow<T>(_ expression: @autoclosure () throws -> T, file: StaticString = #filePath, line: UInt = #line) {
  recordSignerAssertion(); XCTAssertNoThrow(try expression(), file: file, line: line)
}
private func signerUnwrap<T>(_ expression: @autoclosure () throws -> T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
  recordSignerAssertion(); return try XCTUnwrap(try expression(), file: file, line: line)
}
