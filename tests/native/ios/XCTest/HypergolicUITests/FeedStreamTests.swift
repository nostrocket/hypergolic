import XCTest

final class FeedStreamTests: XCTestCase {
  func testLiveLifecycle() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.feedstreamfixture")
    app.terminate(); app.launch()
    XCTAssertTrue(app.buttons["Start live feed"].waitForExistence(timeout: 30), app.debugDescription)
    var receipts = [[Int]]()
    var eventIds = [String:[String]]()
    func capture(_ name: String) {
      let snapshot = app.debugDescription
      let pattern = try! NSRegularExpression(pattern: "label: '([0-9a-f]{64})'")
      let range = NSRange(snapshot.startIndex..., in:snapshot)
      eventIds[name] = pattern.matches(in:snapshot, range:range).compactMap { Range($0.range(at:1), in:snapshot).map { String(snapshot[$0]) } }
      let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
    }
    func input(_ index: Int, _ value: String) {
      let field = app.textViews.element(boundBy: index)
      XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
      field.tap()
      if let current = field.value as? String, !current.isEmpty, current != "Write here while reading…" {
        field.press(forDuration: 1.2)
        let select = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Select All")).firstMatch
        XCTAssertTrue(select.waitForExistence(timeout: 3), app.debugDescription); select.tap()
      }
      field.typeText(value)
      XCTAssertEqual(field.value as? String, value, "Exact native input was not retained")
      if app.buttons["Done"].exists { app.buttons["Done"].tap() }
    }
    func draft(_ value: String) {
      XCTAssertEqual(app.textViews.element(boundBy: 1).value as? String, value, "Draft lost")
    }
    func count(_ minimum: Int = 1) -> Int {
      let live = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Live · ", "history loaded")).firstMatch
      let deadline = Date().addingTimeInterval(35)
      repeat {
        if live.exists, let number = Int(live.label.split(separator: " ")[2]), number >= minimum { return number }
        Thread.sleep(forTimeInterval: 0.3)
      } while Date() < deadline
      XCTFail("No fresh signed live event/history completion: " + app.debugDescription); return 0
    }
    func counters() -> [Int] {
      app.buttons["Read stream counters"].tap()
      let row = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Streams opened ")).firstMatch
      XCTAssertTrue(row.waitForExistence(timeout: 10), app.debugDescription)
      let numbers = row.label.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
      XCTAssertEqual(numbers.count, 6); receipts.append(numbers); return numbers
    }
    input(0, "[{\"kinds\":[1],\"limit\":4}]"); input(1, "draft-A-retained")
    app.buttons["Start live feed"].tap(); let first = count(); capture("stream-history")
    Thread.sleep(forTimeInterval: 28)
    let later = count(first + 1); capture("stream-live")
    let before = counters()
    app.buttons["Switch feed"].tap()
    XCTAssertTrue(app.staticTexts["Feed B foreground · owner 0"].waitForExistence(timeout: 10))
    input(0, "[{\"kinds\":[1],\"limit\":4}]"); input(1, "draft-B-retained")
    app.buttons["Start live feed"].tap(); _ = count()
    app.buttons["Switch feed"].tap()
    XCTAssertTrue(app.staticTexts["Feed A foreground · owner 0"].waitForExistence(timeout: 10))
    draft("draft-A-retained"); _ = count(later)
    let switched = counters()
    XCTAssertEqual(switched[0], before[0]+1); XCTAssertEqual(switched[1], before[1]); capture("stream-switched")
    let retained = count()
    XCUIDevice.shared.press(.home); Thread.sleep(forTimeInterval: 3); app.activate()
    XCTAssertTrue(app.buttons["Close live feed"].waitForExistence(timeout: 20))
    draft("draft-A-retained"); _ = count(retained)
    let returned = counters()
    XCTAssertGreaterThanOrEqual(returned[0], switched[0]+2); XCTAssertGreaterThanOrEqual(returned[1], switched[1]+2); XCTAssertGreaterThan(returned[4], switched[4]); capture("stream-returned")
    app.buttons["Close live feed"].tap()
    XCTAssertTrue(app.staticTexts["Live feed closed."].waitForExistence(timeout: 10))
    let closed = counters(); XCTAssertGreaterThan(closed[1], returned[1])
    Thread.sleep(forTimeInterval: 3); XCTAssertTrue(app.staticTexts["Live feed closed."].exists); draft("draft-A-retained"); capture("stream-closed")
    app.buttons["Start live feed"].tap(); _ = count(); let reopened = counters(); XCTAssertGreaterThan(reopened[0], closed[0])
    app.buttons["Close feed A"].tap(); XCTAssertTrue(app.buttons["Open feed A"].waitForExistence(timeout: 10))
    let removed = counters(); XCTAssertGreaterThan(removed[1], reopened[1]); capture("stream-view-removed")
    app.buttons["Change public owner"].tap(); XCTAssertTrue(app.staticTexts["Feed A foreground · owner 1"].waitForExistence(timeout: 10))
    let revoked = counters(); XCTAssertEqual(revoked[0], revoked[1])
    XCUIDevice.shared.press(.home); Thread.sleep(forTimeInterval: 2); app.activate(); XCTAssertEqual(counters()[0], revoked[0])
    app.terminate(); app.launch(); XCTAssertTrue(app.buttons["Start live feed"].waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["Live feed closed."].exists); XCTAssertEqual(counters()[0], 0); capture("stream-cold-restart")
    let report: [String: Any] = ["kind":"hypergolic-ios-relay-stream-v1", "allChecksPassed":true, "counters":receipts, "eventIds":eventIds,
      "checks":["signed-history-and-eose","live-after-eose-and-ordinary-lease","switch-retains-live-connections-and-drafts","background-retains-view-and-refreshes-connections","explicit-close-revokes-live-delivery","view-removal-revokes-stream","public-owner-revocation-no-reconnect","cold-restart-no-old-intent"],
      "scope":"Actual isolated public-only Simulator SDK/native WSS lifecycle. Public-owner fixture revocation is not protected identity UI acceptance."]
    let data = try JSONSerialization.data(withJSONObject:report, options:[.sortedKeys])
    let attachment = XCTAttachment(data:data, uniformTypeIdentifier:"public.json"); attachment.name="feed-stream-report"; attachment.lifetime = .keepAlways; add(attachment)
  }
  func testStreamFaultMatrix() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.feedstreamfixture")
    app.terminate(); app.launch()
    XCTAssertTrue(app.buttons["Controlled stream faults"].waitForExistence(timeout: 30))
    app.buttons["Controlled stream faults"].tap()
    let cases = ["signed-live","duplicate","bad-signature","wrong-filter","foreign-sub","frame-flood","oversized-frame","view-revoke","paused-owner-revoke"]
    for name in cases {
      XCTAssertTrue(app.staticTexts["Controlled stream · " + name].waitForExistence(timeout: 20))
      XCTAssertTrue(app.buttons["Start live feed"].waitForExistence(timeout: 20)); app.buttons["Start live feed"].tap()
      let positive = ["signed-live","duplicate"].contains(name), revoked = ["view-revoke","paused-owner-revoke"].contains(name)
      let receipt = "PASS " + name + ": calls 1, cancel " + (positive ? "0" : "1") + ", late " + (revoked ? "1" : "0") + ", events " + (name == "signed-live" ? "2" : name == "duplicate" ? "1" : "0") + ", EOSE " + (positive ? "1" : "0") + ", closed " + (positive || revoked ? "0" : "1")
      XCTAssertTrue(app.staticTexts[receipt].waitForExistence(timeout: 10), app.debugDescription)
      if positive { XCTAssertTrue(app.staticTexts["Live · " + (name == "signed-live" ? "2 signed notes" : "1 signed note") + " · history loaded."].exists, app.debugDescription) }
      else if !revoked { XCTAssertTrue(app.staticTexts["Live feed closed: invalid or excessive relay stream"].exists, app.debugDescription) }
      if name == "view-revoke" { XCTAssertFalse(app.webViews.firstMatch.exists) }
      if !positive { XCTAssertFalse(app.staticTexts["Native query acceptance fixture"].exists) }
      let image = XCTAttachment(screenshot:app.screenshot()); image.name="stream-matrix-" + name; image.lifetime = .keepAlways; add(image)
      if name != cases.last { app.buttons["Next stream case"].tap() }
    }
    let report: [String: Any] = ["kind":"hypergolic-ios-stream-fault-matrix-v1","checks":cases,"allChecksPassed":true,
      "scope":"Genuine SDK/Kehto/native immutable admission and captured delivery, production validators; diagnostic frames and public owner revocation. No real WSS fault or protected identity UI claim."]
    let data = try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys])
    let attachment=XCTAttachment(data:data,uniformTypeIdentifier:"public.json");attachment.name="feed-stream-matrix-report";attachment.lifetime = .keepAlways;add(attachment)
  }

}
