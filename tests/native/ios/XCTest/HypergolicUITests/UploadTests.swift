import XCTest
import Darwin
final class UploadTests: XCTestCase {
  func testReviewRejectApprove() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func capture(_ name: String) {
      let attachment = XCTAttachment(screenshot: app.screenshot())
      attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
      let tree = XCTAttachment(string: app.debugDescription)
      tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func review() {
      app.buttons["Request PNG upload"].tap()
      XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 15), app.debugDescription)
      XCTAssertTrue(app.images["Exact photo selected for upload"].exists, app.debugDescription)
      let approve = app.buttons["Approve once"]
      XCTAssertTrue(approve.waitForExistence(timeout: 10), app.debugDescription)
      XCTAssertTrue(approve.isEnabled, app.debugDescription)
      capture("upload-trusted-review")
    }
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Native host connected"].waitForExistence(timeout: 30), app.debugDescription)
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 15), app.debugDescription)
    capture("upload-sdk-ready"); review()
    app.buttons["Reject upload"].tap()
    XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 10), app.debugDescription)
    capture("upload-rejected"); print("UPLOAD_REJECT_CHECKPOINT"); fflush(stdout)
    // The external observer records wall-clock counts between these native inputs.
    Thread.sleep(forTimeInterval: 3)
    app.buttons["upload-outcome"].tap(); review(); app.buttons["Approve once"].tap()
    XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 20), app.debugDescription)
    XCTAssertEqual(app.buttons["upload-outcome"].label, "Upload confirmed by server.")
    capture("upload-confirmed"); app.buttons["upload-outcome"].tap(); app.buttons["Read upload status"].tap()
    let receipt = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6")).firstMatch
    XCTAssertTrue(receipt.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(receipt.label.contains("complete")); XCTAssertTrue(receipt.label.contains("71")); capture("upload-sdk-final-status")
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    capture("upload-cold-launch")
    let report: [String: Any] = ["kind": "hypergolic-ios-upload-v1", "nativeChecksPassed": true,
      "checks": ["decoded-trusted-review", "native-reject", "native-approved-completion", "original-sdk-final-receipt", "cold-launch"],
      "scope": "Actual isolated SDK/Kehto/native Simulator journey with disposable identity. Independent TLS observer verification is required separately; no picker or protected-device identity acceptance."]
    let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), uniformTypeIdentifier: "public.json")
    attachment.name = "upload-native-report"; attachment.lifetime = .keepAlways; add(attachment)
  }
  func testSelectedPhotoRejectApprove() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    let hash = "5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6"
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func selected() -> XCUIElement {app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Selected bytes: 71; SHA-256: " + hash)).firstMatch}
    func tap(_ element: XCUIElement) {
      for _ in 0..<4 {if element.isHittable {break}; app.webViews.firstMatch.swipeUp()}
      XCTAssertTrue(element.isHittable, app.debugDescription); element.tap()
    }
    func review() {
      tap(app.buttons["Request selected upload"])
      XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 15), app.debugDescription)
      XCTAssertTrue(app.images["Exact photo selected for upload"].exists, app.debugDescription)
      XCTAssertTrue(app.buttons["Approve once"].isEnabled, app.debugDescription); capture("picker-trusted-review")
    }
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    tap(app.buttons["Select a file"])
    XCTAssertTrue(app.buttons["Choose photo"].waitForExistence(timeout: 10), app.debugDescription)
    app.buttons["Choose photo"].tap()
    let photo = app.images.matching(NSPredicate(format: "label CONTAINS %@", "Private fixture location/date/device")).firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10), app.debugDescription); capture("system-photo-selection")
    // Photos exposes this remote grid image without a hittability flag; use its observed native bounds.
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    XCTAssertTrue(selected().waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertTrue(selected().label.contains("type: image/png")); XCTAssertTrue(selected().label.hasSuffix("relative path:")); capture("sanitized-guest-handoff")
    review(); app.buttons["Reject upload"].tap()
    XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 10), app.debugDescription)
    print("UPLOAD_PICKER_REJECT_CHECKPOINT"); fflush(stdout); Thread.sleep(forTimeInterval: 3)
    app.buttons["upload-outcome"].tap(); tap(app.buttons["Read selected file"])
    XCTAssertTrue(selected().waitForExistence(timeout: 10), app.debugDescription); capture("guest-read-after-rejection")
    review(); app.buttons["Approve once"].tap()
    XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 20), app.debugDescription)
    XCTAssertEqual(app.buttons["upload-outcome"].label, "Upload confirmed by server."); capture("selected-upload-confirmed")
  }

  func testSelectedAttachmentsRejectApprove() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func tapGuest(_ element: XCUIElement) {
      for _ in 0..<5 {if element.isHittable {break}; app.webViews.firstMatch.swipeUp()}
      XCTAssertTrue(element.isHittable, app.debugDescription); element.tap()
    }
    func named(_ value: String) -> XCUIElement {app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch}
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    for ext in ["wav","mp4","pdf","zip","txt"] {
      tapGuest(app.buttons["Select a file"])
      XCTAssertTrue(app.buttons["Choose file"].waitForExistence(timeout: 10), app.debugDescription); app.buttons["Choose file"].tap()
      XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
      if app.buttons["Browse"].exists {app.buttons["Browse"].tap()}
      if named("On My iPhone").exists {named("On My iPhone").tap()}
      let container = app.cells["Hypergolic, Container"]
      if container.waitForExistence(timeout: 3) {container.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()}
      let folder = app.cells["UploadLab, Folder"]
      if folder.waitForExistence(timeout: 3) {
        // Tap the observed folder icon area; the title label is not its open control.
        folder.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
      }
      let file = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", "proof-" + ext)).firstMatch
      XCTAssertTrue(file.waitForExistence(timeout: 10), app.debugDescription); capture(ext + "-system-file-selection")
      file.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
      let selected = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Selected bytes:")).firstMatch
      XCTAssertTrue(selected.waitForExistence(timeout: 15), app.debugDescription)
      print("UPLOAD_ATTACHMENT_SELECTED:" + ext + ":" + selected.label); fflush(stdout); capture(ext + "-guest-handoff")
      func review() {
        tapGuest(app.buttons["Request selected upload"])
        XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.staticTexts["upload-attachment-inspection"].exists, app.debugDescription)
        XCTAssertTrue(app.buttons["Approve once"].isEnabled, app.debugDescription); capture(ext + "-trusted-file-review")
      }
      review(); app.buttons["Reject upload"].tap()
      XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 10), app.debugDescription)
      print("UPLOAD_ATTACHMENT_REJECT:" + ext); fflush(stdout); Thread.sleep(forTimeInterval: 3)
      app.buttons["upload-outcome"].tap(); tapGuest(app.buttons["Read selected file"])
      XCTAssertTrue(selected.waitForExistence(timeout: 10), app.debugDescription)
      print("UPLOAD_ATTACHMENT_READ:" + ext + ":" + selected.label); fflush(stdout); capture(ext + "-guest-read-after-rejection")
      review(); app.buttons["Approve once"].tap()
      XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 20), app.debugDescription)
      XCTAssertEqual(app.buttons["upload-outcome"].label, "Upload confirmed by server."); capture(ext + "-confirmed")
      app.buttons["upload-outcome"].tap()
    }
  }

  func testSelectedPhotosRejectApprove() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func tapGuest(_ element: XCUIElement) {
      for _ in 0..<5 {if element.isHittable {break}; app.webViews.firstMatch.swipeUp()}
      XCTAssertTrue(element.isHittable, app.debugDescription); element.tap()
    }
    func named(_ value: String) -> XCUIElement {app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch}
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    for index in 1...14 {
      let ext = String(format: "photo-%02d", index)
      tapGuest(app.buttons["Select a file"])
      XCTAssertTrue(app.buttons["Choose file"].waitForExistence(timeout: 10), app.debugDescription); app.buttons["Choose file"].tap()
      XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10), app.debugDescription)
      if app.buttons["Browse"].exists {app.buttons["Browse"].tap()}
      if named("On My iPhone").exists {named("On My iPhone").tap()}
      let container = app.cells["Hypergolic, Container"]
      if container.waitForExistence(timeout: 3) {container.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()}
      let folder = app.cells["UploadPhotos, Folder"]
      if folder.waitForExistence(timeout: 3) {
        // Tap the observed folder icon area; the title label is not its open control.
        folder.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
      }
      let file = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", ext)).firstMatch
      func activeList() throws -> XCUIElement {
        // Bind the live query to this folder's observed photo cells, not a transient index.
        let lists = app.collectionViews.matching(identifier: "File View").containing(NSPredicate(format: "label BEGINSWITH %@", "photo-"))
        XCTAssertTrue(lists.firstMatch.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(lists.count, 1, app.debugDescription); return lists.firstMatch
      }
      if !file.exists || !file.isHittable {
        // Files restores its prior viewport, including after cold app launch.
        let first = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", "photo-01,")).firstMatch
        for _ in 0..<8 {if first.exists && first.isHittable {break}; try activeList().swipeDown()}
      }
      for _ in 0..<8 {if file.exists && file.isHittable {break}; try activeList().swipeUp()}
      XCTAssertTrue(file.waitForExistence(timeout: 10), app.debugDescription)
      XCTAssertTrue(file.isHittable, app.debugDescription); capture(ext + "-system-file-selection")
      file.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25)).tap()
      let selected = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Selected bytes:")).firstMatch
      XCTAssertTrue(selected.waitForExistence(timeout: 15), app.debugDescription)
      print("UPLOAD_PHOTO_SELECTED:" + ext + ":" + selected.label); fflush(stdout); capture(ext + "-guest-handoff")
      func review() {
        tapGuest(app.buttons["Request selected upload"])
        XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.images["Exact photo selected for upload"].exists, app.debugDescription)
        XCTAssertTrue(app.buttons["Approve once"].isEnabled, app.debugDescription); capture(ext + "-trusted-file-review")
      }
      review(); app.buttons["Reject upload"].tap()
      XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 10), app.debugDescription)
      print("UPLOAD_PHOTO_REJECT:" + ext); fflush(stdout); Thread.sleep(forTimeInterval: 3)
      app.buttons["upload-outcome"].tap(); tapGuest(app.buttons["Read selected file"])
      XCTAssertTrue(selected.waitForExistence(timeout: 10), app.debugDescription)
      print("UPLOAD_PHOTO_READ:" + ext + ":" + selected.label); fflush(stdout); capture(ext + "-guest-read-after-rejection")
      review(); app.buttons["Approve once"].tap()
      XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 20), app.debugDescription)
      XCTAssertEqual(app.buttons["upload-outcome"].label, "Upload confirmed by server."); capture(ext + "-confirmed")
      app.buttons["upload-outcome"].tap()
    }
  }

  func testSelectedHEICPhotoRejectApprove() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func tapGuest(_ element: XCUIElement) {
      for _ in 0..<5 {if element.isHittable {break}; app.webViews.firstMatch.swipeUp()}
      XCTAssertTrue(element.isHittable, app.debugDescription); element.tap()
    }
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    tapGuest(app.buttons["Select a file"])
    XCTAssertTrue(app.buttons["Choose photo"].waitForExistence(timeout: 10), app.debugDescription); app.buttons["Choose photo"].tap()
    let photo = app.images.matching(NSPredicate(format: "label CONTAINS %@", "Public photo picker HEIC proof")).firstMatch
    XCTAssertTrue(photo.waitForExistence(timeout: 10), app.debugDescription); capture("heic-library-selection")
    photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    let selected = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Selected bytes:")).firstMatch
    XCTAssertTrue(selected.waitForExistence(timeout: 15), app.debugDescription)
    print("UPLOAD_PHOTO_SELECTED:photo-01:" + selected.label); fflush(stdout); capture("heic-library-guest-handoff")
    func review() {
      tapGuest(app.buttons["Request selected upload"])
      XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 15), app.debugDescription)
      XCTAssertTrue(app.images["Exact photo selected for upload"].exists, app.debugDescription)
      XCTAssertTrue(app.buttons["Approve once"].isEnabled, app.debugDescription); capture("heic-library-trusted-review")
    }
    review(); app.buttons["Reject upload"].tap()
    XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 10), app.debugDescription)
    print("UPLOAD_PHOTO_REJECT:photo-01"); fflush(stdout); Thread.sleep(forTimeInterval: 3)
    app.buttons["upload-outcome"].tap(); tapGuest(app.buttons["Read selected file"])
    XCTAssertTrue(selected.waitForExistence(timeout: 10), app.debugDescription)
    print("UPLOAD_PHOTO_READ:photo-01:" + selected.label); fflush(stdout); capture("heic-library-read-after-reject")
    review(); app.buttons["Approve once"].tap()
    XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 20), app.debugDescription)
    XCTAssertEqual(app.buttons["upload-outcome"].label, "Upload confirmed by server."); capture("heic-library-confirmed")
    app.buttons["upload-outcome"].tap()
  }
  func testOriginalPhotosRejectApprove() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func tapGuest(_ label: String) {
      let button = app.buttons[label]
      for _ in 0..<10 {if button.isHittable {break}; app.webViews.firstMatch.swipeDown()}
      for _ in 0..<10 {if button.isHittable {break}; app.webViews.firstMatch.swipeUp()}
      XCTAssertTrue(button.isHittable, app.debugDescription);button.tap()
    }
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    for kind in ["JPEG", "HEIC"] {
      func review() {
        tapGuest("Request original " + kind)
        XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertTrue(app.images["Exact photo selected for upload"].exists, app.debugDescription)
        XCTAssertTrue(app.buttons["Approve once"].isEnabled, app.debugDescription); capture(kind + "-trusted-native-prepared-review")
      }
      review(); app.buttons["Reject upload"].tap()
      XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 10), app.debugDescription)
      print("UPLOAD_ORIGINAL_REJECT:" + kind); fflush(stdout); Thread.sleep(forTimeInterval: 3)
      app.buttons["upload-outcome"].tap()
      let input = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Original " + kind + " input:")).firstMatch
      for _ in 0..<10 {if input.exists {break}; app.webViews.firstMatch.swipeUp()}
      XCTAssertTrue(input.exists, app.debugDescription);capture(kind + "-original-input-after-reject")
      print("UPLOAD_ORIGINAL_INPUT:" + kind + ":" + input.label);fflush(stdout)
      review();app.buttons["Approve once"].tap()
      XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 20), app.debugDescription)
      XCTAssertEqual(app.buttons["upload-outcome"].label, "Upload confirmed by server.");capture(kind + "-confirmed")
      app.buttons["upload-outcome"].tap();tapGuest("Read upload status")
      let receipt = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "\"status\": \"complete\"")).firstMatch
      XCTAssertTrue(receipt.waitForExistence(timeout: 10), app.debugDescription);capture(kind + "-sdk-receipt")
      print("UPLOAD_ORIGINAL_RECEIPT:" + kind + ":" + receipt.label.replacingOccurrences(of: "\n", with: " "));fflush(stdout)
    }
  }

  func testPickerRecipientFaults() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func openFiles() {
      let select = app.buttons["Select a file"]
      for _ in 0..<5 {if select.isHittable {break}; app.webViews.firstMatch.swipeUp()}
      XCTAssertTrue(select.isHittable, app.debugDescription); select.tap()
      XCTAssertTrue(app.buttons["Choose file"].waitForExistence(timeout: 10), app.debugDescription); app.buttons["Choose file"].tap()
      XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 10), app.debugDescription)
    }
    func noFile(_ name: String) {
      XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Selected bytes:")).firstMatch.exists, app.debugDescription)
      XCTAssertFalse(app.buttons["Request selected upload"].isEnabled, app.debugDescription)
      capture(name); print("UPLOAD_PICKER_DENIED:" + name); fflush(stdout); Thread.sleep(forTimeInterval: 2)
    }
    for action in ["close", "replace", "identity", "renderer"] {
      app.terminate(); app.launch()
      XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
      app.buttons["Arm picker " + action].tap(); openFiles(); capture(action + "-pending-system-picker")
      let code = action == "close" ? "proof-close" : action == "renderer" ? "renderer-stopped" : "session-reuse-blocked"
      XCTAssertTrue(app.staticTexts["Native host failed: " + code].waitForExistence(timeout: 20), app.debugDescription)
      let removed = [app.webViews.firstMatch, app.buttons["Cancel"]].map {
        XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: $0)
      }
      XCTAssertEqual(XCTWaiter.wait(for: removed, timeout: 5), .completed, app.debugDescription)
      capture(action + "-native-revoked"); app.buttons["Open Upload Lab"].tap()
      XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 20), app.debugDescription)
      noFile(action + "-fresh-recipient-no-late-file")
    }
    openFiles()
    if app.buttons["Browse"].exists {app.buttons["Browse"].tap()}
    let phone = app.cells.matching(NSPredicate(format: "label CONTAINS %@", "On My iPhone")).firstMatch
    if phone.exists {phone.tap()}
    let folder = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", "Hypergolic")).firstMatch
    if folder.exists {folder.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.24)).tap()}
    let file = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", "photo-00-denied")).firstMatch
    let listing = app.collectionViews.matching(identifier: "File View").containing(NSPredicate(format: "label BEGINSWITH %@", "photo-")).firstMatch
    for _ in 0..<16 {if file.exists {break}; XCTAssertTrue(listing.exists, app.debugDescription); listing.swipeDown()}
    XCTAssertTrue(file.waitForExistence(timeout: 10), app.debugDescription); capture("malformed-photo-before-selection")
    file.coordinate(withNormalizedOffset: CGVector(dx: 0.18, dy: 0.32)).tap()
    if app.buttons["OK"].waitForExistence(timeout: 5) {app.buttons["OK"].tap()}
    XCTAssertTrue(app.buttons["Select a file"].waitForExistence(timeout: 10), app.debugDescription); noFile("malformed-photo-denied")
  }

  func testPickerCancellationAndBackground() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: app.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func openMenu() {
      let select = app.buttons["Select a file"]
      for _ in 0..<5 {if select.isHittable {break}; app.webViews.firstMatch.swipeUp()}
      XCTAssertTrue(select.isHittable, app.debugDescription); select.tap()
      XCTAssertTrue(app.buttons["Choose photo"].waitForExistence(timeout: 10), app.debugDescription)
    }
    func noFile(_ name: String) {
      XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Selected bytes:")).firstMatch.exists, app.debugDescription)
      XCTAssertFalse(app.buttons["Request selected upload"].isEnabled, app.debugDescription)
      capture(name); print("UPLOAD_PICKER_DENIED:" + name); fflush(stdout); Thread.sleep(forTimeInterval: 2)
    }
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    openMenu(); app.buttons["Cancel"].tap(); noFile("menu-cancel")
    openMenu(); app.buttons["Choose photo"].tap()
    XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 10), app.debugDescription); app.buttons["Cancel"].tap(); noFile("photo-cancel")
    openMenu(); app.buttons["Choose file"].tap()
    XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 10), app.debugDescription); app.buttons["Cancel"].tap(); noFile("file-cancel")
    openMenu(); app.buttons["Choose photo"].tap()
    XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 10), app.debugDescription); capture("photo-before-background")
    XCUIDevice.shared.press(.home); Thread.sleep(forTimeInterval: 2); app.activate()
    XCTAssertTrue(app.buttons["Select a file"].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertFalse(app.buttons["Choose photo"].exists, app.debugDescription); noFile("photo-background-revoked")
    openMenu(); app.buttons["Choose file"].tap()
    XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 10), app.debugDescription); capture("file-before-background")
    XCUIDevice.shared.press(.home); Thread.sleep(forTimeInterval: 2); app.activate()
    XCTAssertTrue(app.buttons["Select a file"].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertFalse(app.buttons["Choose file"].exists, app.debugDescription); noFile("file-background-revoked")
    openMenu(); app.buttons["Cancel"].tap(); noFile("fresh-menu-after-revocation")
  }

  func testInterruptedUploadRecovery() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func emit(_ value: String) {print("RECOVERY_" + value); fflush(stdout)}
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func guest(_ label: String) {
      guard let view = app.webViews.allElementsBoundByIndex.first(where: {$0.frame.height > 1 && $0.frame.width > 1}) else {XCTFail(app.debugDescription); return}
      let button = view.buttons[label]
      func exposed() -> Bool {
        let overlay = app.buttons["upload-recovery-open"]
        let center = CGPoint(x: button.frame.midX, y: button.frame.midY)
        return button.isHittable && (!overlay.exists || !overlay.frame.contains(center))
      }
      for _ in 0..<12 {if exposed() {break}; view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).press(forDuration: 0.05, thenDragTo: view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)))}
      if !exposed() {for _ in 0..<12 {if exposed() {break}; view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).press(forDuration: 0.05, thenDragTo: view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)))}}
      XCTAssertTrue(exposed(), app.debugDescription); button.tap()
    }
    func review() {
      guest("Request PNG upload")
      XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 15), app.debugDescription)
      XCTAssertTrue(app.buttons["Approve once"].isEnabled, app.debugDescription); capture("recovery-trusted-review")
    }
    func mode(_ value: String) {emit("MODE:" + value); Thread.sleep(forTimeInterval: 3)}
    func waitCheck() {
      let button = app.buttons["Check saved server"]
      let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND enabled == true"), object: button)
      XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed, app.debugDescription)
    }
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    review(); app.buttons["Reject upload"].tap()
    XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 10), app.debugDescription)
    emit("REJECT"); Thread.sleep(forTimeInterval: 2); app.buttons["upload-outcome"].tap()
    review(); app.buttons["Approve once"].tap()
    XCTAssertTrue(app.staticTexts["Upload failed."].waitForExistence(timeout: 20), app.debugDescription)
    XCTAssertTrue(app.buttons["upload-recovery-open"].waitForExistence(timeout: 10), app.debugDescription)
    capture("lost-ack-unknown"); emit("LOST_ACK"); Thread.sleep(forTimeInterval: 2)
    app.terminate(); app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    XCTAssertTrue(app.buttons["upload-recovery-open"].waitForExistence(timeout: 10), app.debugDescription)
    capture("cold-restart-unknown"); emit("COLD_RESTART"); Thread.sleep(forTimeInterval: 2)
    guest("Request PNG upload")
    let blocked = app.staticTexts["upload failed"]
    XCTAssertTrue(blocked.waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertFalse(app.staticTexts["Approve file upload"].exists, app.debugDescription)
    capture("unresolved-hash-blocked"); emit("DUPLICATE_BLOCKED"); Thread.sleep(forTimeInterval: 2)
    app.buttons["upload-recovery-open"].tap()
    XCTAssertTrue(app.staticTexts["Check interrupted uploads"].waitForExistence(timeout: 10), app.debugDescription)
    for fault in ["wrong-hash","truncated","redirect","quota"] {
      mode(fault); app.buttons["Check saved server"].tap()
      Thread.sleep(forTimeInterval: 1); waitCheck()
      XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "still unknown")).firstMatch.exists, app.debugDescription)
      capture("recovery-" + fault); emit("CHECKED:" + fault); Thread.sleep(forTimeInterval: 2)
    }
    mode("hold"); app.buttons["Check saved server"].tap()
    XCTAssertTrue(app.buttons["Checking saved server…"].waitForExistence(timeout: 10), app.debugDescription)
    emit("CHECK_HELD"); Thread.sleep(forTimeInterval: 4); capture("native-read-held")
    XCUIDevice.shared.press(.home); capture("native-background-home"); emit("BACKGROUND"); Thread.sleep(forTimeInterval: 2)
    app.activate(); waitCheck(); capture("background-read-revoked"); emit("BACKGROUND_RETURN"); Thread.sleep(forTimeInterval: 2)
    mode("normal"); app.buttons["Check saved server"].tap()
    let present = app.staticTexts["A matching copy is present. This check does not prove which attempt stored it."]
    XCTAssertTrue(present.waitForExistence(timeout: 15), app.debugDescription)
    capture("native-present"); emit("PRESENT"); Thread.sleep(forTimeInterval: 2); app.buttons["Close upload checks"].tap()
    review(); app.buttons["Approve once"].tap()
    XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 20), app.debugDescription)
    emit("FRESH_APPROVAL"); Thread.sleep(forTimeInterval: 2); app.buttons["upload-outcome"].tap()
    app.buttons["Load Peer Napplet"].tap()
    XCTAssertTrue(app.staticTexts["Native peer connected"].waitForExistence(timeout: 20), app.debugDescription)
    mode("put-hold"); review(); app.buttons["Approve once"].tap()
    XCTAssertTrue(app.buttons["Cancel upload"].waitForExistence(timeout: 15), app.debugDescription)
    emit("PUT_HELD"); Thread.sleep(forTimeInterval: 4); app.buttons["Switch to Peer Napplet"].tap()
    XCTAssertTrue(app.staticTexts["Peer napplet focused"].waitForExistence(timeout: 10), app.debugDescription)
    XCTAssertTrue(app.buttons["Cancel upload"].exists, app.debugDescription)
    XCTAssertGreaterThanOrEqual(app.webViews.count, 2, app.debugDescription)
    capture("two-loaded-hosts-progress"); emit("PEER_SWITCH"); Thread.sleep(forTimeInterval: 2)
    emit("RELEASE"); Thread.sleep(forTimeInterval: 2)
    XCTAssertTrue(app.buttons["upload-outcome"].waitForExistence(timeout: 15), app.debugDescription)
    XCTAssertEqual(app.buttons["upload-outcome"].label, "Upload confirmed by server.")
    capture("peer-focus-native-completion"); app.buttons["upload-outcome"].tap(); app.buttons["Switch to Upload Lab"].tap()
    guest("Read upload status")
    let receipt = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6")).allElementsBoundByIndex.first(where: {$0.label.contains("complete")})
    XCTAssertNotNil(receipt, app.debugDescription)
    if let receipt, let view = app.webViews.allElementsBoundByIndex.first(where: {$0.frame.height > 1 && $0.frame.width > 1}) {
      for _ in 0..<12 {
        if receipt.frame.minY >= view.frame.minY && receipt.frame.minY < view.frame.midY {break}
        view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)).press(forDuration: 0.05, thenDragTo: view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)))
      }
      XCTAssertTrue(view.frame.intersects(receipt.frame), app.debugDescription)
    }
    capture("original-recipient-after-peer-switch"); emit("COMPLETE")
  }

  func testUploadTransferFaultMatrix() {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func emit(_ value: String) {print("TRANSFER_" + value); fflush(stdout)}
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func guest(_ label: String) {
      guard let view = app.webViews.allElementsBoundByIndex.first(where: {$0.frame.height > 1 && $0.frame.width > 1}) else {XCTFail(app.debugDescription); return}
      let button = view.buttons[label]
      func exposed() -> Bool {
        let center = CGPoint(x: button.frame.midX, y: button.frame.midY)
        return button.isHittable && !["upload-recovery-open","upload-outcome","upload-cancel"].contains(where: {let overlay = app.buttons[$0]; return overlay.exists && overlay.frame.contains(center)})
      }
      for direction in [true,false] {for _ in 0..<12 {
        if exposed() {break}
        let high = view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)), low = view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        (direction ? low : high).press(forDuration: 0.05, thenDragTo: direction ? high : low)
      }}
      XCTAssertTrue(exposed(), app.debugDescription); button.tap()
    }
    func reset(_ name: String, _ mode: String) {
      app.terminate();emit("RESET:" + name + ":" + mode);Thread.sleep(forTimeInterval: 6);app.launch()
      XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
    }
    func review(_ large: Bool = false) {
      guest(large ? "Request large WAV upload" : "Request PNG upload")
      XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 20), app.debugDescription)
      XCTAssertTrue(app.buttons["Approve once"].isEnabled, app.debugDescription)
    }
    for mode in ["reject","large","quota","wrong-receipt","truncated-receipt","malformed-receipt","redirect","drop-before-store","timeout"] {
      reset(mode, mode);review();capture(mode + "-review");app.buttons["Approve once"].tap()
      XCTAssertTrue(app.staticTexts["Upload failed."].waitForExistence(timeout: 75), app.debugDescription)
      XCTAssertFalse(app.staticTexts["Upload complete."].exists, app.debugDescription)
      capture(mode + "-failed");emit("RESULT:" + mode);Thread.sleep(forTimeInterval: 2)
    }
    for action in ["before-body","stream","cancel","background","close","native-close","replace","identity","renderer"] {
      reset(action, action == "before-body" ? "before-tls" : action == "stream" ? "slow-stream" : "hold")
      review(action == "stream");app.buttons["Approve once"].tap()
      XCTAssertTrue(app.buttons["Cancel upload"].waitForExistence(timeout: 20), app.debugDescription)
      emit("HELD:" + action);Thread.sleep(forTimeInterval: 3);capture(action + "-held")
      if action == "background" {
        XCUIDevice.shared.press(.home);capture("actual-Home-transfer");emit("RELEASE");Thread.sleep(forTimeInterval: 2);app.activate()
      } else if action == "close" {
        app.buttons["Close Upload Lab"].tap();XCTAssertTrue(app.staticTexts["Upload Lab closed"].waitForExistence(timeout: 10))
        emit("RELEASE");Thread.sleep(forTimeInterval: 2);app.buttons["Open Upload Lab"].tap()
        XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 20), app.debugDescription)
      } else if ["native-close","replace","identity","renderer"].contains(action) {
        app.buttons["Upload fault controls"].tap();app.buttons["Interrupt upload " + (action == "native-close" ? "close" : action)].tap()
        let code = action == "native-close" ? "proof-close" : action == "renderer" ? "renderer-stopped" : "session-reuse-blocked"
        XCTAssertTrue(app.staticTexts["Native host failed: " + code].waitForExistence(timeout: 20), app.debugDescription)
        emit("RELEASE");Thread.sleep(forTimeInterval: 2);app.buttons["Open Upload Lab"].tap()
        XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 20), app.debugDescription)
      } else {app.buttons["Cancel upload"].tap();emit("RELEASE")}
      Thread.sleep(forTimeInterval: 3);XCTAssertFalse(app.staticTexts["Upload complete."].exists, app.debugDescription)
      capture(action + "-revoked");emit("RESULT:" + action);Thread.sleep(forTimeInterval: 2)
    }
    for kind in ["checksum","mode","symlink"] {
      reset(kind, "lost-ack");review();app.buttons["Approve once"].tap()
      XCTAssertTrue(app.staticTexts["Upload failed."].waitForExistence(timeout: 20), app.debugDescription)
      app.terminate();emit("CORRUPT:" + kind);Thread.sleep(forTimeInterval: 6);app.launch()
      XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30), app.debugDescription)
      guest("Request PNG upload");Thread.sleep(forTimeInterval: 2)
      XCTAssertFalse(app.staticTexts["Approve file upload"].exists, app.debugDescription)
      XCTAssertFalse(app.staticTexts["Upload complete."].exists, app.debugDescription)
      capture(kind + "-storage-denied");emit("RESULT:" + kind);Thread.sleep(forTimeInterval: 2)
    }
    emit("COMPLETE")
  }

  func testUploadQueueBounds() {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func emit(_ value: String) {print("QUEUE_" + value); fflush(stdout)}
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); image.name = name; image.lifetime = .keepAlways; add(image)
      let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-accessibility"; tree.lifetime = .keepAlways; add(tree)
    }
    func counts(_ value: String) {XCTAssertTrue(app.staticTexts[value].waitForExistence(timeout: 15), app.debugDescription)}
    func guest(_ label: String) {
      guard let view = app.webViews.allElementsBoundByIndex.first(where: {$0.frame.height > 1 && $0.frame.width > 1}) else {XCTFail(app.debugDescription); return}
      let button = view.buttons[label]
      for direction in [true,false] {for _ in 0..<12 {
        if button.isHittable {break}
        let high = view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)), low = view.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
        (direction ? low : high).press(forDuration: 0.05, thenDragTo: direction ? high : low)
      }}
      XCTAssertTrue(button.isHittable, app.debugDescription);button.tap()
    }
    app.terminate();app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30))
    app.buttons["Load Peer Napplet"].tap();XCTAssertTrue(app.staticTexts["Native peer connected"].waitForExistence(timeout: 20))
    guest("Schedule PNG request in fifteen seconds")
    app.buttons["Switch to Peer Napplet"].tap();guest("Request large WAV upload")
    XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 20));app.buttons["Approve once"].tap();emit("FIRST_APPROVED")
    app.buttons["Switch to Upload Lab"].tap();XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 20));app.buttons["Approve once"].tap();emit("SECOND_APPROVED")
    counts("Active: 2; queued: 0");app.buttons["Load eight queue peers"].tap();counts("Active: 2; queued: 8");capture("two-active-eight-queued");emit("HELD")
    app.buttons["Focus queue peer"].tap();counts("Active: 2; queued: 8");XCTAssertFalse(app.staticTexts["Approve file upload"].exists)
    XCTAssertTrue(app.staticTexts["Queue pending; second request rejected: quota exceeded"].waitForExistence(timeout: 10));emit("REALM_BOUND")
    app.buttons["Load overflow peer"].tap();app.buttons["Focus queue peer"].tap()
    XCTAssertTrue(app.staticTexts["Queue request rejected: quota exceeded"].waitForExistence(timeout: 10));counts("Active: 2; queued: 8");capture("native-overflow-denied");emit("OVERFLOW")
    app.buttons.matching(identifier: "upload-cancel").firstMatch.tap();counts("Active: 1; queued: 8")
    app.buttons.matching(identifier: "upload-cancel").firstMatch.tap();counts("Active: 0; queued: 8");emit("RELEASE");Thread.sleep(forTimeInterval: 2);capture("two-cancelled-eight-queued");emit("CANCELLED")
    XCUIDevice.shared.press(.home);Thread.sleep(forTimeInterval: 1);app.activate();counts("Active: 0; queued: 0");capture("background-revokes-all-queued");emit("COMPLETE")
  }


  func testVerifiedPublishedUpload() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "org.nostrocket.hypergolic.uploadfixture")
    func emit(_ value: String) {print("PUBLISHED_UPLOAD_" + value);fflush(stdout);Thread.sleep(forTimeInterval: 2)}
    func capture(_ name: String) {
      let image = XCTAttachment(screenshot: app.screenshot());image.name = "published-" + name;image.lifetime = .keepAlways;add(image)
      let tree = XCTAttachment(string: app.debugDescription);tree.name = "published-" + name + "-accessibility";tree.lifetime = .keepAlways;add(tree)
    }
    func settings(_ element: XCUIElement) {
      for _ in 0..<16 {
        if element.isHittable {return}
        let scroll = app.scrollViews.firstMatch
        if element.exists && element.frame.midY < scroll.frame.minY {scroll.swipeDown()} else {scroll.swipeUp()}
      }
      XCTAssertTrue(element.isHittable, app.debugDescription)
    }
    func guest(_ element: XCUIElement) {
      guard let view = app.webViews.allElementsBoundByIndex.first(where: {$0.frame.height > 1 && $0.frame.width > 1}) else {XCTFail(app.debugDescription);return}
      for direction in [false,true] {for _ in 0..<12 {
        if element.isHittable {element.tap();return}
        let high = view.coordinate(withNormalizedOffset: CGVector(dx: 0.5,dy: 0.15)), low = view.coordinate(withNormalizedOffset: CGVector(dx: 0.5,dy: 0.45))
        (direction ? low : high).press(forDuration: 0.05,thenDragTo: direction ? high : low)
      }}
      XCTFail("Guest control not exposed: " + app.debugDescription)
    }
    func review() {
      guest(app.buttons["Request PNG upload"])
      XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 20),app.debugDescription)
      XCTAssertTrue(app.images["Exact photo selected for upload"].exists)
      XCTAssertTrue(app.buttons["Approve once"].isEnabled);capture("trusted-review")
    }
    app.terminate();app.launch()
    let address = app.staticTexts["signed-upload-address"]
    XCTAssertTrue(address.waitForExistence(timeout: 30),app.debugDescription)
    let link = address.label;XCTAssertTrue(link.hasPrefix("naddr1"));XCTAssertFalse(link.contains("..."));XCTAssertFalse(link.contains("…"))
    app.buttons["shell-settings"].tap()
    let input = app.textFields["settings-napplet-address"];settings(input);input.tap();input.typeText(link + "\n")
    let consent = app.staticTexts["Allow this napplet?"].firstMatch
    XCTAssertTrue(consent.waitForExistence(timeout: 30),app.debugDescription);settings(consent);capture("first-open-consent")
    XCTAssertTrue(app.staticTexts["Requested access: upload"].exists)
    XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", "Upload access allows this napplet to read files you select. Every upload still needs your separate approval of the file, identity and server.")).firstMatch.exists)
    let reject = app.buttons["settings-napplet-reject"];settings(reject);reject.tap();emit("CONSENT_REJECT")
    let verify = app.buttons["settings-open-napplet"];settings(verify);verify.tap()
    XCTAssertTrue(consent.waitForExistence(timeout: 30),app.debugDescription)
    let allow = app.buttons["settings-napplet-approve"];settings(allow);allow.tap()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30),app.debugDescription);capture("signed-sdk-ready");emit("ADMITTED")
    guest(app.buttons["Read upload limits"])
    let info = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "\"maxBytes\"")).firstMatch
    XCTAssertTrue(info.waitForExistence(timeout: 15),app.debugDescription);capture("native-SDK-upload-info");emit("INFO:" + info.label.replacingOccurrences(of: "\n",with: " "))
    review();app.buttons["Reject upload"].tap()
    XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 15),app.debugDescription);emit("REJECT")
    app.buttons["upload-outcome"].tap();review();app.buttons["Approve once"].tap()
    XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 30),app.debugDescription)
    XCTAssertEqual(app.buttons["upload-outcome"].label,"Upload confirmed by server.");capture("confirmed");emit("APPROVED")
    app.buttons["upload-outcome"].tap();guest(app.buttons["Read upload status"])
    let receipt = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "\"status\": \"complete\"")).firstMatch
    XCTAssertTrue(receipt.waitForExistence(timeout: 15),app.debugDescription)
    XCTAssertTrue(receipt.label.contains("5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6"));capture("original-sdk-receipt");emit("RECEIPT:" + receipt.label.replacingOccurrences(of: "\n",with: " "))
    guest(app.buttons["Select a file"])
    XCTAssertTrue(app.buttons["Choose file"].waitForExistence(timeout: 10));app.buttons["Choose file"].tap()
    XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 10))
    if app.buttons["Browse"].exists {app.buttons["Browse"].tap()}
    let local = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "On My iPhone")).firstMatch
    if local.exists {local.tap()}
    let container = app.cells["Hypergolic, Container"]
    if container.waitForExistence(timeout: 3) {container.coordinate(withNormalizedOffset: CGVector(dx: 0.5,dy: 0.25)).tap()}
    let file = app.cells.matching(NSPredicate(format: "label BEGINSWITH %@", "published-proof")).firstMatch
    XCTAssertTrue(file.waitForExistence(timeout: 10),app.debugDescription);capture("system-selected-WAV");file.coordinate(withNormalizedOffset: CGVector(dx: 0.5,dy: 0.25)).tap()
    let selected = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Selected bytes: 4194304; SHA-256: b662d59b296866a4472ac00bd2fde89b616af2368b1222c1250afc141ecb58c9")).firstMatch
    XCTAssertTrue(selected.waitForExistence(timeout: 15),app.debugDescription);capture("selected-WAV-guest-handoff");emit("WAV_SELECTED")
    func reviewWav() {
      guest(app.buttons["Request selected upload"]);XCTAssertTrue(app.staticTexts["Approve file upload"].waitForExistence(timeout: 15))
      XCTAssertTrue(app.staticTexts["upload-attachment-inspection"].exists);XCTAssertTrue(app.buttons["Approve once"].isEnabled);capture("selected-WAV-review")
    }
    reviewWav();app.buttons["Reject upload"].tap();XCTAssertTrue(app.staticTexts["Upload cancelled."].waitForExistence(timeout: 15));emit("WAV_REJECT")
    app.buttons["upload-outcome"].tap();guest(app.buttons["Read selected file"]);XCTAssertTrue(selected.exists);emit("WAV_READ")
    reviewWav();app.buttons["Approve once"].tap();XCTAssertTrue(app.staticTexts["Upload complete."].waitForExistence(timeout: 30));XCTAssertEqual(app.buttons["upload-outcome"].label,"Upload confirmed by server.");capture("selected-WAV-confirmed");emit("WAV_APPROVED");app.buttons["upload-outcome"].tap()
    app.terminate();app.launch()
    XCTAssertTrue(app.staticTexts["Ready to request a PNG upload."].waitForExistence(timeout: 30),app.debugDescription)
    XCTAssertFalse(consent.exists);capture("persisted-cold-restart");emit("COLD_RESTART");emit("COMPLETE")
  }
}
