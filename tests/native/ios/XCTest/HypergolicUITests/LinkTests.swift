import XCTest

final class LinkTests: XCTestCase {
  func testTracer() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.linkfixture")
    let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Native link host connected"].waitForExistence(timeout: 30), app.debugDescription)
    func capture(_ name: String, _ target: XCUIApplication) {
      let image = XCTAttachment(screenshot: target.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let ax = XCTAttachment(string: target.debugDescription); ax.name = name + "-AX"; ax.lifetime = .keepAlways; add(ax)
    }
    func sdk(_ expected: String) {
      let receipt = app.staticTexts[expected]
      XCTAssertTrue(receipt.waitForExistence(timeout: 15), app.debugDescription)
      print("LINK_SDK_RESULT:" + receipt.label)
    }
    app.buttons["Open external link"].tap()
    XCTAssertTrue(app.alerts["Open external link?"].waitForExistence(timeout: 10), app.debugDescription)
    let review = app.alerts["Open external link?"].staticTexts.allElementsBoundByIndex.map {$0.label}.joined(separator: "\n")
    XCTAssertTrue(review.contains("Napplet: resource-lab")); XCTAssertTrue(review.contains("Unsigned embedded test napplet"))
    XCTAssertTrue(review.contains("https://example.com/?hypergolic=link-tracer")); XCTAssertFalse(review.contains("Read external page"))
    capture("link-trusted-review", app)
    app.alerts.buttons["Open once"].tap()
    XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 15), safari.debugDescription)
    capture("link-os-handler", safari)
    print("LINK_OS_AX:" + safari.debugDescription)
    let address = safari.textFields.firstMatch
    if address.exists {address.tap(); print("LINK_OS_ADDRESS:" + String(describing: address.value))}
    app.activate()
    XCTAssertTrue(app.staticTexts["Link handed to your device."].waitForExistence(timeout: 15), app.debugDescription)
    sdk("{\"status\":\"opened\"}"); capture("link-return-original-sdk", app); print("LINK_CHECK:actual-os-handoff-return")
    app.buttons["Open external link"].tap()
    XCTAssertTrue(app.alerts["Open external link?"].waitForExistence(timeout: 10), app.debugDescription)
    app.alerts.buttons["Cancel"].tap()
    XCTAssertTrue(app.staticTexts["Link opening denied."].waitForExistence(timeout: 10), app.debugDescription)
    sdk("{\"status\":\"denied\"}"); capture("link-cancel-original-sdk", app); print("LINK_CHECK:native-cancel")
    app.buttons["Close Resource Lab"].tap(); XCTAssertFalse(app.webViews.firstMatch.exists)
    app.buttons["Open Resource Lab"].tap(); XCTAssertTrue(app.staticTexts["Native link host connected"].waitForExistence(timeout: 20))
    let field = app.textFields["External HTTPS URL"]; XCTAssertTrue(field.exists, app.debugDescription); field.tap(); field.press(forDuration: 1.2)
    let all = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
    XCTAssertTrue(all.waitForExistence(timeout: 5), app.debugDescription); all.tap(); field.typeText("http://example.com")
    if app.buttons["Done"].exists {app.buttons["Done"].tap()}
    XCTAssertEqual(field.value as? String, "http://example.com", app.debugDescription)
    app.buttons["Open external link"].tap()
    XCTAssertTrue(app.staticTexts["Link opening denied."].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertFalse(app.alerts["Open external link?"].exists)
    sdk("{\"status\":\"denied\"}"); capture("link-http-denied", app); print("LINK_CHECK:unsupported-http")
  }
  func testFull() throws {
    try testTracer()
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.linkfixture")
    func capture(_ name: String) {
      let image=XCTAttachment(screenshot:app.screenshot());image.name=name;image.lifetime = .keepAlways;add(image)
      let ax=XCTAttachment(string:app.debugDescription);ax.name=name+"-AX";ax.lifetime = .keepAlways;add(ax)
    }
    func fresh() {
      if app.buttons["Close Resource Lab"].exists {app.buttons["Close Resource Lab"].tap()}
      XCTAssertTrue(app.buttons["Open Resource Lab"].waitForExistence(timeout:10));app.buttons["Open Resource Lab"].tap()
      XCTAssertTrue(app.staticTexts["Native link host connected"].waitForExistence(timeout:20),app.debugDescription)
    }
    func opening() {
      app.buttons["Open external link"].tap();XCTAssertTrue(app.alerts["Open external link?"].waitForExistence(timeout:10),app.debugDescription)
    }
    func absent() {XCTAssertFalse(app.alerts["Open external link?"].exists,app.debugDescription)}
    func sdk(_ expected:String) {
      XCTAssertTrue(app.staticTexts[expected].waitForExistence(timeout:15),app.debugDescription)
      print("LINK_MATRIX_SDK_RESULT:"+app.staticTexts[expected].label)
    }
    func denied() {
      XCTAssertTrue(app.staticTexts["Link opening denied."].waitForExistence(timeout:15),app.debugDescription)
      sdk("{\"status\":\"denied\"}");absent()
    }
    fresh();app.buttons["Hide in six seconds"].tap();opening();capture("matrix-before-blur")
    XCTAssertTrue(app.staticTexts["Link fixture hidden"].waitForExistence(timeout:12));absent();app.buttons["Show Resource Lab"].tap();denied();capture("matrix-blur-denied");print("LINK_CHECK:pending-blur-revoked")
    fresh();opening();capture("matrix-before-background");XCUIDevice.shared.press(.home);app.activate();denied();capture("matrix-background-denied");print("LINK_CHECK:pending-background-revoked")
    fresh();app.buttons["Close in six seconds"].tap();opening();XCTAssertTrue(app.staticTexts["Link fixture closed"].waitForExistence(timeout:12));absent();XCTAssertFalse(app.webViews.firstMatch.exists)
    app.buttons["Open Resource Lab"].tap();XCTAssertTrue(app.staticTexts["Native link host connected"].waitForExistence(timeout:20));capture("matrix-close-new-recipient");XCTAssertFalse(app.staticTexts["Link opening denied."].exists);XCTAssertFalse(app.staticTexts["Link handed to your device."].exists);print("LINK_CHECK:pending-close-revoked")
    for (control,status,name) in [("Change identity in six seconds","Link identity changed","pending-identity-revoked"),("Pause owner in six seconds","Link owner paused","pending-owner-pause-revoked")] {
      fresh();app.buttons[control].tap();opening();XCTAssertTrue(app.staticTexts[status].waitForExistence(timeout:12));absent();capture("matrix-"+name);XCTAssertFalse(app.staticTexts["Link opening denied."].exists);XCTAssertFalse(app.staticTexts["Link handed to your device."].exists);print("LINK_CHECK:"+name)
      fresh();opening();app.alerts.buttons["Cancel"].tap();denied()
    }
    fresh();opening();let started=Date();capture("matrix-timeout-review");XCTAssertTrue(app.staticTexts["Link opening denied."].waitForExistence(timeout:35));XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started),23);denied();capture("matrix-timeout-denied");print("LINK_CHECK:pending-timeout-revoked")
    fresh();app.buttons["Request four links"].tap();XCTAssertTrue(app.alerts["Open external link?"].waitForExistence(timeout:10));XCTAssertEqual(app.alerts.count,1);app.alerts.buttons["Cancel"].tap();XCTAssertTrue(app.staticTexts["Four link requests settled."].waitForExistence(timeout:15));sdk("["+Array(repeating:"{\"status\":\"denied\"}",count:4).joined(separator:",")+"]");absent();capture("matrix-single-review-flood");print("LINK_CHECK:global-single-review-flood")
    fresh();for _ in 0..<3 {opening();app.alerts.buttons["Cancel"].tap();denied()}
    app.buttons["Open external link"].tap();denied();capture("matrix-generation-rate-limit");print("LINK_CHECK:generation-review-rate-limit")
    for raw in ["https://user@example.com/","nostr:npub1fixture","https://example.com:0"] {
      fresh();let field=app.textFields["External HTTPS URL"];field.tap();field.press(forDuration:1.2)
      let all=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@","Select All")).firstMatch;XCTAssertTrue(all.waitForExistence(timeout:5));all.tap();field.typeText(raw)
      if app.buttons["Done"].exists {app.buttons["Done"].tap()};XCTAssertEqual(field.value as? String,raw);app.buttons["Open external link"].tap();denied()
    }
    capture("matrix-invalid-url-denied");print("LINK_CHECK:native-invalid-url-profile")
  }

}
