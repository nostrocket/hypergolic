import XCTest
import Synchronization

private let handoffAssertions = Mutex(0)
private func check(_ value: Bool, file: StaticString = #filePath, line: UInt = #line) { handoffAssertions.withLock { $0 += 1 }; XCTAssertTrue(value, file: file, line: line) }
@MainActor final class SignerUITests: XCTestCase {
  override func tearDown() { print("HANDOFF_UI_ASSERTIONS=\(handoffAssertions.withLock { let total = $0; $0 = 0; return total })"); super.tearDown() }
  private func safari(_ scenario: String) async throws -> XCUIApplication {
    let app = XCUIApplication(); app.launchArguments = ["native-handoff-ui", scenario]; app.launch()
    check(app.staticTexts["Disposable native Safari trace"].waitForExistence(timeout: 10)); app.buttons["handoff.start"].tap()
    check(app.buttons["signer.approve"].waitForExistence(timeout: 15)); try await Task.sleep(for: .milliseconds(700))
    check(app.buttons["signer.approve"].isHittable)
    let review = XCTAttachment(screenshot: app.screenshot()); review.name = "handoff-native-event-review-" + scenario; review.lifetime = .keepAlways; add(review)
    app.buttons["signer.approve"].tap()
    check(app.alerts["Open signer authentication?"].waitForExistence(timeout: 15)); check(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "https://example.com")).firstMatch.exists)
    app.buttons["Open authentication"].tap(); check(app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "Close", "Done")).firstMatch.waitForExistence(timeout: 15)); try await Task.sleep(for: .seconds(1))
    let browser = XCTAttachment(screenshot: app.screenshot()); browser.name = "native-safari-full-modal-" + scenario; browser.lifetime = .keepAlways; add(browser)
    check(!app.buttons["handoff.start"].isHittable); check(!app.buttons["signer.approve"].exists)
    return app
  }
  func testMinimalSafariCloseDelegateDelivery() {
    let app = XCUIApplication(); app.launchArguments = ["native-handoff-ui", "minimal"]; app.launch()
    check(app.buttons["handoff.start"].waitForExistence(timeout: 10)); app.buttons["handoff.start"].tap()
    let close = app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "Close", "Done")).firstMatch
    check(close.waitForExistence(timeout: 15)); close.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5)).tap()
    check(app.staticTexts["Minimal Safari Close observed"].waitForExistence(timeout: 10))
  }
  func testActualSafariNativeResumeReturnsOneVerifiedSignature() async throws {
    let app = try await safari("approve"); app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "Close", "Done")).firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5)).tap()
    check(app.alerts["Resume the same signer request?"].waitForExistence(timeout: 10))
    let consent = XCTAttachment(screenshot: app.screenshot()); consent.name = "native-exact-request-resume"; consent.lifetime = .keepAlways; add(consent)
    app.buttons["Resume request"].tap(); check(app.staticTexts["Native handoff signature verified"].waitForExistence(timeout: 10))
    check(!app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "Close", "Done")).firstMatch.exists); check(!app.buttons["Resume request"].exists)
  }
  func testNativeResumeCancellationReturnsNoSignature() async throws {
    let app = try await safari("cancel"); app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "Close", "Done")).firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5)).tap()
    check(app.alerts["Resume the same signer request?"].waitForExistence(timeout: 10)); app.alerts["Resume the same signer request?"].buttons["Cancel"].tap()
    check(app.staticTexts["Native handoff denied: SIGNER_UNCERTAIN"].waitForExistence(timeout: 10)); check(!app.buttons["Resume request"].exists)
  }
  func testOrdinaryBackgroundCancelsSafariAndCannotResumeOldSource() async throws {
    let app = try await safari("background"); XCUIDevice.shared.press(.home); app.activate()
    check(app.staticTexts["Native handoff denied: SIGNER_UNCERTAIN"].waitForExistence(timeout: 10)); check(!app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "Close", "Done")).firstMatch.exists); check(!app.buttons["Resume request"].exists)
  }
}
