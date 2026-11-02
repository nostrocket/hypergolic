import XCTest
final class ResourceTests: XCTestCase {
  func testResource() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.resourcefixture")
    app.terminate();app.launch()
    XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout: 30),app.debugDescription)
    func capture(_ name: String) {
      let attachment = XCTAttachment(screenshot: app.screenshot());attachment.name=name;attachment.lifetime = .keepAlways;add(attachment)
    }
    func loaded() {
      app.buttons["Load resource"].tap()
      XCTAssertTrue(app.staticTexts["Resource loaded."].waitForExistence(timeout: 25),app.debugDescription)
      let receipt = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "SHA-256 590608bf256237f22d84bbab2a0a1afc0d4f20db6350bbac2c6841f1f3e13b01")).firstMatch
      XCTAssertTrue(receipt.exists,app.debugDescription);XCTAssertTrue(receipt.label.contains("1848 bytes"));XCTAssertTrue(receipt.label.contains("image/png"))
      XCTAssertTrue(app.images["Loaded resource"].exists,app.debugDescription)
    }
    loaded();capture("resource-exact-native-image")
    app.buttons["Release preview"].tap();XCTAssertFalse(app.images["Loaded resource"].exists)
    app.buttons["Check support"].tap()
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@","10485760")).firstMatch.waitForExistence(timeout:10),app.debugDescription)
    capture("resource-native-info")
    let field = app.textFields.firstMatch;XCTAssertTrue(field.exists)
    field.tap();field.press(forDuration:1.2)
    let all=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@","Select All")).firstMatch
    XCTAssertTrue(all.waitForExistence(timeout:3),app.debugDescription);all.tap();field.typeText("https://127.0.0.1/private")
    let done=app.buttons["Done"];if(done.exists){done.tap()}
    app.buttons["Load resource"].tap()
    XCTAssertTrue(app.staticTexts["Load failed: blocked-by-policy"].waitForExistence(timeout:10),app.debugDescription)
    XCTAssertFalse(app.images["Loaded resource"].exists);capture("resource-private-denial")
    app.buttons["Close Resource Lab"].tap();XCTAssertTrue(app.buttons["Open Resource Lab"].waitForExistence(timeout:10));XCTAssertFalse(app.webViews.firstMatch.exists)
    app.buttons["Open Resource Lab"].tap();XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout:20));loaded();capture("resource-reopened")
    app.terminate();app.launch();XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout:20));loaded();capture("resource-cold-restart")
    let report:[String:Any] = ["kind":"hypergolic-ios-resource-tracer-v1","allChecksPassed":true,
      "checks":["https-exact-image","info","private-denial","close-reopen","cold-restart"],
      "sha256":"590608bf256237f22d84bbab2a0a1afc0d4f20db6350bbac2c6841f1f3e13b01","bytes":1848,
      "scope":"Actual standalone SDK/Kehto/native HTTPS Simulator journey; no physical identity, published parity or media claim."]
    let attachment=XCTAttachment(data:try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),uniformTypeIdentifier:"public.json");attachment.name="resource-tracer-report";attachment.lifetime = .keepAlways;add(attachment)
  }
  func testMedia() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier:"org.nostrocket.hypergolic.resourcefixture")
    app.terminate();app.launch();XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout:30))
    let field = app.textFields.firstMatch;field.tap();field.press(forDuration:1.2)
    let all=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@","Select All")).firstMatch
    XCTAssertTrue(all.waitForExistence(timeout:3));all.tap();field.typeText("https://media.w3.org/2010/05/sintel/trailer.mp4")
    let done=app.buttons["Done"];if(done.exists){done.tap()};app.buttons["Load resource"].tap()
    XCTAssertTrue(app.staticTexts["Resource loaded."].waitForExistence(timeout:25),app.debugDescription)
    func capture(_ name:String) {let a=XCTAttachment(screenshot:app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)}
    let receipt=app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@","b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254")).firstMatch
    app.swipeUp();XCTAssertTrue(receipt.exists,app.debugDescription);XCTAssertTrue(receipt.label.contains("4372373 bytes"));XCTAssertTrue(receipt.label.contains("video/mp4"));capture("resource-native-video-exact-bytes")
    func state(_ paused:Bool) -> Double {
      let prefix = paused ? "Media paused at " : "Media playing at "
      let label=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@",prefix)).firstMatch
      XCTAssertTrue(label.waitForExistence(timeout:15),app.debugDescription)
      return Double(label.label.replacingOccurrences(of:prefix,with:"").replacingOccurrences(of:" s",with:"")) ?? -1
    }
    let play=app.buttons["Play resource"];play.tap()
    var started=state(false)
    let until=Date().addingTimeInterval(10)
    while started < 0.5 && Date() < until {Thread.sleep(forTimeInterval:0.2);started=state(false)}
    XCTAssertGreaterThan(started,0.5)
    app.buttons["Hide Resource Lab"].tap();app.buttons["Show Resource Lab"].tap()
    let paused=state(true);Thread.sleep(forTimeInterval:0.7);XCTAssertEqual(state(true),paused,accuracy:0.15);XCTAssertGreaterThan(paused,0);capture("resource-native-video-switch-paused")
    play.tap();let resumed=state(false);XCTAssertGreaterThanOrEqual(resumed,paused)
    XCUIDevice.shared.press(.home);Thread.sleep(forTimeInterval:0.7);app.activate()
    let background=state(true);Thread.sleep(forTimeInterval:0.7);XCTAssertEqual(state(true),background,accuracy:0.15);XCTAssertGreaterThanOrEqual(background,resumed);capture("resource-native-video-background-paused")
    play.tap();XCTAssertGreaterThanOrEqual(state(false),background);capture("resource-native-video-manual-play")
    let report:[String:Any] = ["kind":"hypergolic-ios-resource-media-v1","allChecksPassed":true,"bytes":4372373,"sha256":"b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254","switchPosition":paused,"backgroundPosition":background,"scope":"Actual SDK/native bounded MP4 Simulator playback, switch/background pause and manual Play; physical-device and hostile-media acceptance remain open."]
    let a=XCTAttachment(data:try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),uniformTypeIdentifier:"public.json");a.name="resource-media-report";a.lifetime = .keepAlways;add(a)
  }

  func testSchemesAndSettings() throws {
    continueAfterFailure = false
    let app=XCUIApplication(bundleIdentifier:"org.nostrocket.hypergolic.resourcefixture");app.terminate();app.launch()
    XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout:30))
    let blossom="blossom:sha256:3006f1743f2c3c725136d20d2da99820c80509b43e2687b7d5ddd33e098fe706"
    func url(_ value:String) {
      let field=app.textFields.firstMatch
      if !field.isHittable {app.swipeDown()}
      field.tap();field.press(forDuration:1.2)
      let all=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@","Select All")).firstMatch
      XCTAssertTrue(all.waitForExistence(timeout:3));all.tap();field.typeText(value)
      let done=app.buttons["Done"];if done.exists {done.tap()}
    }
    func capture(_ name:String) {let a=XCTAttachment(screenshot:app.screenshot());a.name=name;a.lifetime = .keepAlways;add(a)}
    func load(_ value:String,_ hash:String,_ count:Int,_ mime:String) {
      url(value);app.buttons["Load resource"].tap();XCTAssertTrue(app.staticTexts["Resource loaded."].waitForExistence(timeout:25),app.debugDescription)
      let receipt=app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@",hash)).firstMatch
      app.swipeUp();XCTAssertTrue(receipt.exists,app.debugDescription);XCTAssertTrue(receipt.label.contains("\(count) bytes"));XCTAssertTrue(receipt.label.contains(mime))
    }
    func settings(_ disabled:Bool) {
      app.buttons["Download settings"].tap()
      if disabled {
        let field=app.textViews["Blossom download servers"];XCTAssertTrue(field.exists);field.tap();field.press(forDuration:1.2)
        let all=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@","Select All")).firstMatch
        XCTAssertTrue(all.waitForExistence(timeout:3));all.tap();field.typeText(XCUIKeyboardKey.delete.rawValue)
        app.buttons["Save download servers"].tap()
      } else {app.buttons["Restore download defaults"].tap()}
      XCTAssertTrue(app.staticTexts["Download servers saved."].waitForExistence(timeout:10),app.debugDescription);capture(disabled ? "resource-settings-disabled" : "resource-settings-defaults")
      app.buttons["Return to Resource Lab"].tap()
    }
    settings(false);load(blossom,"3006f1743f2c3c725136d20d2da99820c80509b43e2687b7d5ddd33e098fe706",106828,"image/png");capture("resource-blossom-default-verified")
    settings(true);load(blossom,"3006f1743f2c3c725136d20d2da99820c80509b43e2687b7d5ddd33e098fe706",106828,"image/png")
    app.buttons["Close Resource Lab"].tap();app.buttons["Open Resource Lab"].tap();XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout:20))
    url(blossom);app.buttons["Load resource"].tap();XCTAssertTrue(app.staticTexts["Load failed: blocked-by-policy"].waitForExistence(timeout:15))
    app.terminate();app.launch();XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout:20));url(blossom);app.buttons["Load resource"].tap();XCTAssertTrue(app.staticTexts["Load failed: blocked-by-policy"].waitForExistence(timeout:15))
    settings(false)
    load("nostr:note17h73p7wd4zrrwxwldzvdj4gpm0803pygf3tk0gycvxn3r0cluttsw8czsg","69f4651f4a788e90a23b73cc1ca68d431bb06d2d2b3c41cb2d721e99163a0ec4",1382,"application/json");capture("resource-nostr-one-hop")
    load("data:application/json,%7B%22a%22%3A1%7D","015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",7,"application/json");capture("resource-host-data")
    url("https://localtest.me/private");app.buttons["Load resource"].tap();XCTAssertTrue(app.staticTexts["Load failed: blocked-by-policy"].waitForExistence(timeout:15));capture("resource-private-dns-denial")
    app.swipeUp();app.buttons["Load bulk"].tap();XCTAssertTrue(app.staticTexts["3 bulk results."].waitForExistence(timeout:25),app.debugDescription)
    let query=app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@ OR label CONTAINS %@","; SHA-256 ","htree:unsupported: unsupported-scheme"))
    XCTAssertEqual(query.count,3,app.debugDescription)
    let rows=(0..<3).map{query.element(boundBy:$0).label}
    XCTAssertEqual(rows.count,3,app.debugDescription);XCTAssertTrue(rows[0].contains("590608bf256237f22d84bbab2a0a1afc0d4f20db6350bbac2c6841f1f3e13b01"));XCTAssertTrue(rows[1].contains("unsupported-scheme"));XCTAssertTrue(rows[2].contains("data:,local-sample"));capture("resource-native-bulk-ordered")
    let report:[String:Any]=["kind":"hypergolic-ios-resource-schemes-v1","allChecksPassed":true,"checks":["blossom-default-redirect-and-hash","loaded-memory-cache-retention","close-revokes-cache","settings-persist-cold-launch","nostr-verified-json","host-mediated-data","private-dns-denial","ordered-bulk"],"bulkRows":rows,"scope":"Actual standalone SDK/native HTTPS/relay/SQLite Simulator journey; no protected identity or published parity claim."]
    let attachment=XCTAttachment(data:try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),uniformTypeIdentifier:"public.json");attachment.name="resource-schemes-report";attachment.lifetime = .keepAlways;add(attachment)
  }

  func testDiagnostics() throws {
    continueAfterFailure = false
    let app=XCUIApplication(bundleIdentifier:"org.nostrocket.hypergolic.resourcefixture");app.terminate();app.launch()
    XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout:30));app.buttons["Resource diagnostics"].tap()
    let cases=["cancel","owner-epoch","close","background","chunk-cancel","chunk-owner-epoch","chunk-close"]
    var receipts:[String]=[]
    for scenario in cases {
      XCTAssertTrue(app.staticTexts["Waiting for SDK resource"].waitForExistence(timeout:20),app.debugDescription)
      app.buttons["Load resource"].tap();XCTAssertTrue(app.staticTexts["Resource probe held"].waitForExistence(timeout:10),app.debugDescription)
      if scenario.hasSuffix("cancel") {
        app.buttons["Cancel"].tap();XCTAssertTrue(app.staticTexts["Load cancelled."].waitForExistence(timeout:10),app.debugDescription)
      } else if scenario == "background" {
        XCUIDevice.shared.press(.home);Thread.sleep(forTimeInterval:0.6);app.activate()
        XCTAssertTrue(app.wait(for:.runningForeground,timeout:10))
        let release=app.buttons["Release resource probe"]
        let ready=XCTNSPredicateExpectation(predicate:NSPredicate(format:"hittable == true"),object:release)
        XCTAssertEqual(XCTWaiter.wait(for:[ready],timeout:10),.completed,app.debugDescription)
      } else {
        app.buttons["Revoke resource owner"].tap();XCTAssertTrue(app.staticTexts["Resource owner revoked"].waitForExistence(timeout:10))
      }
      app.buttons["Release resource probe"].tap()
      let receipt=app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","PASS \(scenario):")).firstMatch
      XCTAssertTrue(receipt.waitForExistence(timeout:12),app.debugDescription);receipts.append(receipt.label)
      XCTAssertFalse(app.staticTexts.matching(NSPredicate(format:"label BEGINSWITH %@","Attachment:")).firstMatch.exists)
      if scenario.hasSuffix("cancel") {XCTAssertTrue(app.staticTexts["Load cancelled."].exists)}
      let screenshot=XCTAttachment(screenshot:app.screenshot());screenshot.name="resource-diagnostic-"+scenario;screenshot.lifetime = .keepAlways;add(screenshot)
      if scenario != cases.last! {app.buttons["Next resource case"].tap()}
    }
    let report:[String:Any]=["kind":"hypergolic-ios-resource-diagnostics-v1","allChecksPassed":true,"receipts":receipts,"scope":"Controlled held resolver/dispatch; actual SDK, WKWebView, native leases, broker and carrier. No DNS/TLS or protected-identity-switch claim."]
    let a=XCTAttachment(data:try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),uniformTypeIdentifier:"public.json");a.name="resource-diagnostics-report";a.lifetime = .keepAlways;add(a)
  }
  func testAudio() throws {
    continueAfterFailure = false
    let app=XCUIApplication(bundleIdentifier:"org.nostrocket.hypergolic.resourcefixture");app.terminate();app.launch()
    XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout:30))
    let field=app.textFields.firstMatch;field.tap();field.press(forDuration:1.2)
    let all=app.descendants(matching:.any).matching(NSPredicate(format:"label == %@","Select All")).firstMatch
    XCTAssertTrue(all.waitForExistence(timeout:3));all.tap();field.typeText("https://interactive-examples.mdn.mozilla.net/media/cc0-audio/t-rex-roar.mp3")
    let done=app.buttons["Done"];if done.exists {done.tap()};app.buttons["Load resource"].tap()
    XCTAssertTrue(app.staticTexts["Resource loaded."].waitForExistence(timeout:25),app.debugDescription);app.swipeUp()
    let receipt=app.staticTexts.matching(NSPredicate(format:"label CONTAINS %@","41191d0727073bf848bcc8f0bd851d71a0b0058e901abb1c1b236ad327bda52e")).firstMatch
    XCTAssertTrue(receipt.exists,app.debugDescription);XCTAssertTrue(receipt.label.contains("39868 bytes"));XCTAssertTrue(receipt.label.contains("audio/mpeg"))
    let play=app.buttons["Play resource"];if !play.isHittable {app.swipeDown()};play.tap()
    let state=app.staticTexts.matching(NSPredicate(format:"label MATCHES %@","Media (paused|playing) at [0-9.]+ s")).firstMatch
    let until=Date().addingTimeInterval(12);var position=0.0
    while Date()<until {
      if state.exists {position=Double(state.label.components(separatedBy:" at ").last!.replacingOccurrences(of:" s",with:"")) ?? 0;if position>0.1 {break}}
      Thread.sleep(forTimeInterval:0.2)
    }
    XCTAssertGreaterThan(position,0.1,app.debugDescription)
    app.swipeUp();let shot=XCTAttachment(screenshot:app.screenshot());shot.name="resource-native-audio-playback";shot.lifetime = .keepAlways;add(shot)
    let report:[String:Any]=["kind":"hypergolic-ios-resource-audio-v1","allChecksPassed":true,"bytes":39868,"sha256":"41191d0727073bf848bcc8f0bd851d71a0b0058e901abb1c1b236ad327bda52e","playedTo":position,"scope":"Actual SDK/native HTTPS audio-only MP3 decode/playback on selected Simulator."]
    let a=XCTAttachment(data:try JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),uniformTypeIdentifier:"public.json");a.name="resource-audio-report";a.lifetime = .keepAlways;add(a)
  }

}
