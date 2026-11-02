import XCTest

/// Controls the separately built Expo disposable entry, including its actual admitted AppContext.
@MainActor final class BridgeSignerUITests: XCTestCase {
  private func launch() -> XCUIApplication {
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.signercore.bridgeproof")
    app.launch()
    XCTAssertTrue(app.staticTexts["signer-fixture-owner"].waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["signer-fixture-owner"].label.contains("Native owner claimed"))
    return app
  }
  private func review(_ app: XCUIApplication) {
    app.buttons["settings-native-signer-check"].tap()
    XCTAssertTrue(app.buttons["signer.approve"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.textViews["signer.exactEvent"].exists)
    XCTAssertTrue(app.staticTexts["signer.account"].exists)
    // Existence can precede sheet animation completion. Prove complete action frames before capturing.
    let approve = app.buttons["signer.approve"], reject = app.buttons["signer.reject"]
    let settled = NSPredicate { _, _ in
      approve.isHittable && reject.isHittable && approve.frame.height >= 44 && reject.frame.height >= 44 &&
      approve.frame.maxY <= app.frame.maxY - 8 && reject.frame.maxY <= app.frame.maxY - 8
    }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: settled, object: nil)], timeout: 5), .completed)
    print("BRIDGE_ACTION_FRAMES approve=\(approve.frame) reject=\(reject.frame) app=\(app.frame)")
  }
  private func result(_ app: XCUIApplication, success: Bool) {
    let value = app.staticTexts["settings-native-signer-result"]
    XCTAssertTrue(value.waitForExistence(timeout: 10))
    XCTAssertTrue(value.label.contains(success ? "Signature verified. Nothing was published." : "Signer check cancelled or unavailable."))
  }
  func testActualBridgeApprovesAndRepeats() {
    let app = launch(); review(app)
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "actual-expo-native-review"; screenshot.lifetime = .keepAlways; add(screenshot)
    app.buttons["signer.approve"].tap(); result(app, success: true)
    let verified = XCTAttachment(screenshot: app.screenshot())
    verified.name = "actual-expo-independent-verified-signature"; verified.lifetime = .keepAlways; add(verified)
    review(app); app.buttons["signer.approve"].tap(); result(app, success: true)
  }
  func testActualBridgeRejectsAndRemounts() {
    let app = launch(); review(app)
    app.buttons["signer.reject"].tap(); result(app, success: false)
    app.buttons["signer-fixture-toggle"].tap()
    XCTAssertFalse(app.buttons["settings-native-signer-check"].exists)
    app.buttons["signer-fixture-toggle"].tap()
    review(app); app.buttons["signer.approve"].tap(); result(app, success: true)
  }
  func testActualBridgeBackgroundThenExplicitActivation() {
    let app = launch(); review(app)
    XCUIDevice.shared.press(.home); app.activate(); result(app, success: false)
    XCTAssertFalse(app.buttons["signer.approve"].exists)
    review(app); app.buttons["signer.approve"].tap(); result(app, success: true)
  }
  func testActualVaultPreflightAndRetiredSecureStoreBoundary() {
    let app = launch()
    let button = app.buttons["signer-fixture-boundary-check"]
    if !button.isHittable { app.swipeUp() }
    XCTAssertTrue(button.waitForExistence(timeout: 10)); XCTAssertTrue(button.isHittable); button.tap()
    let result = app.staticTexts["signer-fixture-boundary-result"]
    XCTAssertTrue(result.waitForExistence(timeout: 20))
    print("NATIVE_BOUNDARY_RESULT=\(result.label)")
    let completed = NSPredicate { _, _ in result.label.contains("Native boundary passed.") }
    XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: completed, object: nil)], timeout: 20), .completed)
    XCTAssertTrue(result.label.contains("Vault available: false. Vault was not opened."))
    XCTAssertTrue(result.label.contains("25 restricted calls denied across all five exports."))
    XCTAssertTrue(result.label.contains("Async and sync configuration round trips passed; fixture record removed."))
    let screenshot = XCTAttachment(screenshot: app.screenshot()); screenshot.name = "actual-native-vault-preflight-and-retired-secret-exports"
    screenshot.lifetime = .keepAlways; add(screenshot)
  }

}
