import XCTest
import Synchronization

@MainActor final class SignerUITests: XCTestCase {
  override func tearDown() {
    print("SIGNER_UI_ASSERTIONS=\(signerAssertionCount.withLock { $0 })")
    super.tearDown()
  }
  private func ready() -> XCUIApplication {
    let app = XCUIApplication(); app.launch()
    app.buttons["probe.generate"].tap()
    signerAssertTrue(app.staticTexts["Disposable identity ready"].waitForExistence(timeout: 5))
    app.buttons["probe.review"].tap()
    signerAssertTrue(app.buttons["signer.approve"].waitForExistence(timeout: 5))
    return app
  }
  func testApprovalSignsExactNativeReview() {
    let app = ready()
    signerAssertTrue(app.staticTexts["Review disposable signature"].exists)
    signerAssertTrue(app.textViews["signer.exactEvent"].exists)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "native-exact-event-review"; screenshot.lifetime = .keepAlways; add(screenshot)
    app.buttons["signer.approve"].tap()
    signerAssertTrue(app.staticTexts["Signed exact event once"].waitForExistence(timeout: 5))
    signerAssertFalse(app.buttons["signer.approve"].exists)
    app.buttons["probe.review"].tap()
    signerAssertTrue(app.buttons["signer.approve"].waitForExistence(timeout: 5))
    app.buttons["signer.approve"].tap()
    signerAssertTrue(app.staticTexts["Signed exact event once"].waitForExistence(timeout: 5))
  }
  func testRejectReturnsNoSignature() {
    let app = ready(); app.buttons["signer.reject"].tap()
    signerAssertTrue(app.staticTexts["Review denied"].waitForExistence(timeout: 5))
    signerAssertFalse(app.buttons["signer.approve"].exists)
    app.buttons["probe.review"].tap()
    signerAssertTrue(app.buttons["signer.approve"].waitForExistence(timeout: 5))
    app.buttons["signer.reject"].tap()
    signerAssertTrue(app.staticTexts["Review denied"].waitForExistence(timeout: 5))
  }
  func testBackgroundRevokesReviewAndKey() {
    let app = ready()
    XCUIDevice.shared.press(.home); app.activate()
    signerAssertTrue(app.staticTexts["Review denied"].waitForExistence(timeout: 5))
    signerAssertFalse(app.buttons["signer.approve"].exists)
    app.buttons["probe.generate"].tap()
    signerAssertTrue(app.staticTexts["Generate failed"].exists)
    app.buttons["probe.activate"].tap()
    app.buttons["probe.generate"].tap()
    signerAssertTrue(app.staticTexts["Disposable identity ready"].waitForExistence(timeout: 5))
    app.buttons["probe.review"].tap()
    signerAssertTrue(app.buttons["signer.approve"].waitForExistence(timeout: 5))
    app.buttons["signer.reject"].tap()
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
