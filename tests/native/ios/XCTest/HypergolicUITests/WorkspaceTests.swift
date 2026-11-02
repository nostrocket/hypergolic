import CoreGraphics
import Foundation
import XCTest

@MainActor
final class WorkspaceTests: XCTestCase {
  private var app: XCUIApplication!
  private var checks: [[String: Any]] = []
  private var observations: [String: Any] = [:]
  private var gestures: [[String: Any]] = []
  private var complete = false
  private var scenario = ""
  private var nonce = ""
  private let placeholder = "Something you will recognise…"
  private let expected: [String: Set<String>] = [
    "ui-style": ["empty-shelf", "address-validation", "grouped-identity-settings", "workspace-navigation", "close-protection", "trusted-review"],
    "identity-delete-unavailable": ["delete-exact-target", "unavailable-has-no-confirm", "cancel-keeps-workspace"],
    "state-close": ["state-close-warning", "state-reopen-shared", "state-reopen-instance"],
    "state-storage": ["state-identity", "state-storage-operations", "state-restart", "state-instance-scope", "state-owner-isolation", "state-identity-isolation"],
    "identity-switch": ["identity-settings-safe-area", "identity-cancel-retains-live-state", "identity-import-restarts-all", "identity-duplicate-and-selector", "identity-selection-after-restart"],
    "workspace-restart": ["selected-napplet-after-restart", "opening-order-after-restart", "explicit-empty-after-restart"],
    "card-cancel": ["short-card-stroke-cancel", "two-touch-card-cancel", "cancelled-card-state-retained"],
    "closing": ["seed-close-state", "gentle-overview-scroll", "rapid-swipe-warning", "keep-open-retains-state", "close-removes-only-target", "other-session-state-retained", "visible-close-controls", "quiet-empty-overview", "empty-settings-and-open"],
    "switch-state": ["seed-a", "seed-b-isolated", "edge-roundtrip-a", "two-column-overview", "overview-restore-b", "stop-at-last", "stop-at-first-and-restore-a"],
    "gestures": ["vertical-content-scroll", "horizontal-content-scroll", "marker-selection", "scroll-and-selection-retained"],
    "approval-review": ["exact-public-review", "reject-denies-sdk", "dismiss-pauses-queue", "background-preserves-pending"],
    "published-host": ["review-exact-signed-fixture", "native-host-connected", "close-returns-to-fixture"],
    "live-published": ["live-native-relay-https", "live-first-open-exact-review", "live-guest-connected"],
    "published-update": ["public-fixture-and-runtime", "first-open-exact-review", "update-cancel-retains-old", "update-accept-replaces-host", "cold-restart-retains-v2", "rollback-rejected-after-restart", "background-retains-verified-v2"],
    "live-update-v1": ["live-public-fixture", "live-first-open-exact-review", "live-v1-connected"],
    "live-update-v2": ["live-v1-before-update", "live-update-exact-review", "live-decline-retains-v1", "live-accept-renders-v2", "live-cold-restart-retains-v2"],
    "changed-access": ["public-fixture-and-runtime", "first-open-exact-review", "update-review-exact-candidate", "changed-access-decline-retains-v1", "changed-access-accept-replaces-host"],
  ]

  override func setUpWithError() throws {
    continueAfterFailure = false
    let environment = ProcessInfo.processInfo.environment
    scenario = environment["HG_SCENARIO"] ?? ""
    nonce = environment["HG_NONCE"] ?? ""
    guard expected[scenario] != nil, nonce.range(of: "^[a-z0-9]{12}$", options: .regularExpression) != nil,
          let bundle = environment["HG_TARGET_BUNDLE_ID"], !bundle.isEmpty else { throw Failure.invalid("Invalid workspace configuration") }
    app = XCUIApplication(bundleIdentifier: bundle)
    observations = ["nonce": nonce, "bundleIdentifier": bundle, "appStateBeforeActivate": app.state.rawValue]
    app.activate()
  }

  override func tearDownWithError() throws {
    if app != nil { capture("final") }
    let names = Set(checks.compactMap { $0["name"] as? String })
    let allPassed = complete && names == expected[scenario] && checks.count == expected[scenario]?.count && checks.allSatisfy { $0["passed"] as? Bool == true }
    let kind: String
    switch scenario {
    case "published-host": kind = "hypergolic-ios-published-host-v1"
    case "live-published": kind = "hypergolic-ios-live-published-v1"
    case "published-update": kind = "hypergolic-ios-published-update-v1"
    case "changed-access": kind = "hypergolic-ios-changed-access-v1"
    default: kind = scenario.hasPrefix("live-update-") ? "hypergolic-ios-live-update-v1" : "hypergolic-ios-workspace-v1"
    }
    attach([
      "kind": kind, "scenario": scenario, "completed": complete,
      "allChecksPassed": allPassed, "checks": checks, "observations": observations, "gestures": gestures,
      "proofScope": "Public native XCTest gestures and accessibility. Temporary fixture values/scroll positions only; native generation identity and transition frame pacing are not directly observed."
    ], "workspace-report")
  }

  func testUIStyle() throws {
    guard ProcessInfo.processInfo.environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.uistyle" else { throw Failure.invalid("Requires isolated UI style fixture") }
    func tap(_ identifier: String) throws {
      let button = app.buttons.matching(identifier: identifier).firstMatch
      for _ in 0..<6 where !button.isHittable { app.swipeUp() }
      try until(identifier + " reachable") { button.exists && button.isHittable }
      button.tap()
    }
    try tap("ui-fixture-empty")
    let empty = app.buttons.matching(identifier: "empty-open-napplet").firstMatch
    for _ in 0..<6 where !empty.isHittable { app.swipeUp() }
    try until("Empty shelf has its opening action") { empty.exists && empty.isHittable }
    record("empty-shelf", true, ["actionFrame": NSCoder.string(for: empty.frame)])
    capture("glass-empty")
    try tap("empty-open-napplet")
    let address = app.textFields.matching(identifier: "settings-napplet-address").firstMatch
    try until("Address input visible") { address.exists && address.isHittable }
    capture("glass-settings")
    address.tap()
    address.typeText("not-a-napplet\n")
    let error = app.staticTexts.matching(identifier: "settings-napplet-error").firstMatch
    try until("Invalid address reports correction") { error.exists && error.label.contains("naddr1") }
    record("address-validation", !app.otherElements.matching(identifier: "settings-napplet-review").firstMatch.exists, ["error": error.label])
    capture("glass-address-error")
    try tap("settings-section-identity")
    let importButton = app.buttons.matching(identifier: "settings-import-identity").firstMatch
    for _ in 0..<4 where !importButton.isHittable { app.swipeUp() }
    try tap("settings-import-identity")
    let secret = app.secureTextFields.matching(identifier: "identity-import-input").firstMatch
    try until("Private key field remains masked") { secret.exists && secret.isHittable }
    record("grouped-identity-settings", true, ["maskedInput": secret.exists])
    capture("glass-import")
    try tap("identity-import-cancel")
    try tap("settings-done")
    try tap("ui-fixture-workspace")
    let overview = app.buttons.matching(identifier: "shell-overview").firstMatch
    try until("Visible workspace navigation") { overview.exists && overview.isHittable }
    let guestReady = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Ready ·")).firstMatch
    try until("Actual napplet rendered") { guestReady.exists }
    let increment = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Add one")).firstMatch
    try until("Guest counter accepts input") { increment.exists && increment.isHittable }
    increment.tap()
    capture("glass-active")
    try tap("shell-overview")
    let card = app.buttons.matching(identifier: "overview-card-ux-lab-1").firstMatch
    try until("Live overview has first card") { card.exists && card.isHittable }
    capture("glass-overview")
    card.tap()
    try until("Overview returns to focused napplet") { overview.exists && overview.isHittable }
    record("workspace-navigation", currentTitle() == "UX Lab 1", ["title": currentTitle()])
    try tap("shell-napplet-menu")
    try until("Focused napplet menu is reachable") { app.buttons.matching(identifier: "shell-close").firstMatch.isHittable }
    capture("slim-napplet-menu")
    try tap("shell-menu-done")
    try until("Menu dismisses back to napplet") { overview.isHittable }
    try tap("shell-napplet-menu")
    try tap("shell-close")
    let keep = app.buttons.matching(identifier: "close-keep-open").firstMatch
    try until("Unknown dirty state still asks") { keep.exists && keep.isHittable }
    capture("glass-close")
    keep.tap()
    record("close-protection", app.buttons.matching(identifier: "shell-napplet-menu").firstMatch.exists, [:])
    try tap("ui-fixture-review")
    let content = app.staticTexts.matching(identifier: "approval-sheet-content").firstMatch
    try until("Exact request body remains visible") { content.exists && content.label == "A note from my own corner of the network." }
    let approve = app.buttons.matching(identifier: "approval-sheet-approve").firstMatch
    let reject = app.buttons.matching(identifier: "approval-sheet-reject").firstMatch
    record("trusted-review", approve.isHittable && reject.isHittable, ["content": content.label, "scope": "Presentation only; no signer or network effect"])
    capture("glass-review")
    try tap("approval-sheet-reject")
    complete = true
  }

  func testIdentityDeleteUnavailable() throws {
    guard ProcessInfo.processInfo.environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.identityuifixture" else { throw Failure.invalid("Requires public identity UI fixture") }
    app.terminate()
    try until("Previous fixture process retired") { self.app.state == .notRunning }
    observations["cleanLaunchBeforeDraft"] = true
    app.launch()
    let original = try selectedIdentity(), title = currentTitle()
    try until("State Lab identity connection and editable field") {
      (try? self.web().staticTexts.matching(NSPredicate(format: "label == %@", "Identity connected")).count) == 1
        && (try? self.web().textViews.matching(NSPredicate(format: "label == %@", "String value")).firstMatch.isEnabled) == true
    }
    let field = try stateField("value")
    let marker = "NoDelete" + nonce
    field.typeText(marker)
    guard let draft = field.value as? String, draft.contains(marker) else { throw Failure.invalid("Draft input was not retained") }
    try dismissKeyboard()
    try identityPress("shell-settings")
    let other = try one(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND NOT label CONTAINS %@", "identity-select-", original)), "inactive saved identity")
    guard let range = other.label.range(of: "npub1[023456789acdefghjklmnpqrstuvwxyz]{58}", options: .regularExpression) else { throw Failure.invalid("Missing target public identity") }
    let target = String(other.label[range])
    let key = String(other.identifier.dropFirst("identity-select-".count))
    try identityPress("identity-delete-" + key)
    let reviewed = app.staticTexts.matching(identifier: "identity-delete-npub").firstMatch
    try until("Exact inactive identity review") { reviewed.exists && reviewed.label == target }
    record("delete-exact-target", true, ["targetNpub": target, "selectedNpub": original])
    let unavailable = app.staticTexts.matching(identifier: "identity-delete-unavailable").firstMatch
    try until("Explicit unavailable authentication fixture") { unavailable.exists && unavailable.label.contains("unavailable") }
    record("unavailable-has-no-confirm", !app.buttons.matching(identifier: "identity-delete-confirm").firstMatch.exists,
      ["scope": "Public-key fixture with explicit authentication-unavailable double; no native OS authentication or secret erasure"])
    capture("identity-delete-unavailable")
    try identityPress("identity-delete-cancel")
    try until("Unchanged two-identity inventory") { self.app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "identity-select-")).count == 2 }
    try identityPress("settings-done")
    record("cancel-keeps-workspace", try selectedIdentity() == original && currentTitle() == title && stateField("value").value as? String == draft,
      ["title": title, "selectedNpub": original, "savedIdentities": 2])
    try dismissKeyboard()
    capture("identity-delete-cancelled-live-state")
    complete = true
  }

  func testStateClose() throws {
    guard ProcessInfo.processInfo.environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.identityuifixture" else { throw Failure.invalid("Requires isolated State Lab fixture") }
    let original = try selectedIdentity()
    let first = try openState("state-lab")
    let value = "Close" + nonce
    try stateField("key").typeText(nonce)
    try dismissKeyboard()
    try stateField("value").typeText(value)
    try dismissKeyboard()
    try stateAction("Write", status: "Write confirmed.")
    try stateScope(instance: true)
    try stateAction("Write", status: "Write confirmed.")
    try stateRead(value)
    try workspaceSaved()
    let title = currentTitle()
    try identityPress("handle-right")
    let close = app.buttons.matching(identifier: "overview-close-" + first).firstMatch
    try stateNativeReveal(close)
    try identityPress("overview-close-" + first)
    try until("Exact close warning") { self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Close " + title + "?")).firstMatch.exists }
    capture("state-close-warning")
    record("state-close-warning", true, ["instance": first, "title": title])
    try identityPress("close-confirm")
    try until("Only target card removed") { !self.app.buttons.matching(identifier: "overview-card-" + first).firstMatch.exists }
    try workspaceSaved()
    let second = try openState("state-lab")
    guard first != second else { throw Failure.invalid("Reopened instance reused closed native ID") }
    try stateField("key").typeText(nonce)
    try dismissKeyboard()
    try stateRead(value)
    record("state-reopen-shared", try selectedIdentity() == original, ["closed": first, "opened": second, "value": value])
    try stateScope(instance: true)
    try stateAction("Read", status: "No value saved.")
    record("state-reopen-instance", true, ["closed": first, "opened": second, "oldInstanceNotInherited": true])
    capture("state-reopened-instance")
    complete = true
  }

  func testStateStorage() throws {
    guard ProcessInfo.processInfo.environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.identityuifixture" else { throw Failure.invalid("State test requires the isolated public identity fixture") }
    if app.buttons.matching(identifier: "settings-done").firstMatch.isHittable { try identityPress("settings-done") }
    try dismissKeyboard()
    let original = try selectedIdentity()
    let first = try openState("state-lab")
    capture("state-open")
    let key = "sample" + nonce
    try stateField("key").typeText(nonce)
    try dismissKeyboard()
    let publicValues = try web().staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[0-9a-f]{64}")).allElementsBoundByIndex
    guard publicValues.count == 1 else { throw Failure.invalid("Expected one rendered public key") }
    let publicKey = publicValues[0].label
    observations["stateIdentity"] = ["npub": original, "pubkey": publicKey]
    record("state-identity", true, ["npub": original, "pubkey": publicKey, "instance": first])
    try stateAction("Read", status: "No value saved.")
    try stateAction("Write", status: "Write confirmed.")
    try stateAction("Read", status: "Read an empty string.")
    let value = "Stored" + nonce
    try stateField("value").typeText(value)
    try dismissKeyboard()
    try stateAction("Write", status: "Write confirmed.")
    try stateRead(value)
    try stateAction("List keys", status: nil)
    try until("Saved key visible") { (try? self.stateResult().staticTexts.matching(NSPredicate(format: "label == %@", key)).count) == 1 }
    try stateAction("Remove", status: "Remove confirmed.")
    try stateAction("Read", status: "No value saved.")
    try stateAction("Write", status: "Write confirmed.")
    try stateRead(value)
    record("state-storage-operations", true, ["key": key, "value": value, "emptyDistinctFromMissing": true])
    capture("state-saved")
    try workspaceSaved()
    try restartWorkspaceApp()
    try stateReady(first)
    try stateField("key").typeText(nonce)
    try dismissKeyboard()
    try stateRead(value)
    record("state-restart", try selectedIdentity() == original, ["instance": first, "value": value])
    capture("state-restarted")
    // The rest of the journey uses the same nonce in separately opened trusted fixtures.
    try stateScope(instance: true)
    try stateAction("Read", status: "No value saved.")
    try stateField("value").typeText("Private" + nonce)
    try dismissKeyboard()
    try stateAction("Write", status: "Write confirmed.")
    let second = try openState("state-lab")
    try stateField("key").typeText(nonce)
    try dismissKeyboard()
    try stateRead(value)
    try stateScope(instance: true)
    try stateAction("Read", status: "No value saved.")
    record("state-instance-scope", first != second, ["first": first, "second": second, "shared": value])
    for variant in ["state-lab-peer", "state-lab-other-publisher"] {
      _ = try openState(variant)
      try stateField("key").typeText(nonce)
      try dismissKeyboard()
      try stateAction("Read", status: "No value saved.")
    }
    record("state-owner-isolation", true, ["key": key, "appAndPublisherIsolated": true])
    // Return to the first loaded State Lab using its persistent instance identifier.
    try stateFocus(first)
    try stateScope(instance: false)
    try stateRead(value)
    try identityPress("shell-settings")
    let other = try one(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND NOT label CONTAINS %@", "identity-select-", original)), "other saved identity")
    let otherID = other.identifier
    try nativeTap(other, name: "select-other-identity")
    try identityPress("identity-change-cancel")
    try identityPress("settings-done")
    try stateRead(value)
    try identityPress("shell-settings")
    try identityPress(otherID)
    try identityPress("identity-change-confirm")
    try stateReady(first)
    try stateField("key").typeText(nonce)
    try dismissKeyboard()
    try stateAction("Read", status: "No value saved.")
    try identityPress("shell-settings")
    try identityPress("identity-select-" + publicKey)
    try identityPress("identity-change-confirm")
    try stateReady(first)
    try stateField("key").typeText(nonce)
    try dismissKeyboard()
    try stateRead(value)
    record("state-identity-isolation", try selectedIdentity() == original, ["returnedValue": value, "npub": original])
    capture("state-identity-restored")
    complete = true
  }

  func testApprovalReview() throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.approvalfixture" else {
      throw Failure.invalid("Requires isolated public approval fixture")
    }
    guard let expectedTitle = environment["HG_EXPECTED_TITLE"], !expectedTitle.isEmpty else {
      throw Failure.invalid("Missing expected Approval Lab title")
    }
    let fixture = try one(app.staticTexts.matching(identifier: "approval-fixture-label"), "public approval fixture label")
    guard fixture.label == "Approval fixture · public scalar 2 · signing unavailable" else {
      throw Failure.invalid("Fixture boundary label mismatch")
    }
    let selected = try selectedIdentity()
    guard selected == "npub1ccz8l9zpa47k6vz9gphftsrumpw80rjt3nhnefat4symjhrsnmjs38mnyd" else {
      throw Failure.invalid("Selected identity is not public scalar 2")
    }
    try identityPress("shell-settings")
    let open = app.buttons.matching(identifier: "settings-open-approval-lab").firstMatch
    try stateNativeReveal(open)
    try identityPress("settings-open-approval-lab")
    try until("Approval Lab native and SDK ready") {
      guard self.currentTitle() == expectedTitle, let host = try? self.web() else { return false }
      return host.staticTexts.matching(NSPredicate(format: "label == %@", "Identity connected")).count == 1
        && host.staticTexts.matching(NSPredicate(format: "label == %@", "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5")).count == 1
    }

    try approvalWebAction("Send note")
    try approvalSheet()
    let content = try one(app.staticTexts.matching(identifier: "approval-sheet-content"), "approval content")
    let publisher = try one(app.staticTexts.matching(identifier: "approval-sheet-publisher"), "approval publisher")
    let identity = try one(app.staticTexts.matching(identifier: "approval-sheet-identity"), "approval identity")
    let relays = ["wss://relay.damus.io", "wss://nos.lol", "wss://bucket.coracle.social"]
    let relayLabels = Set(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "wss://"))
      .allElementsBoundByIndex.map(\.label))
    let exactRelays = relayLabels == Set([relays.map { $0 + "/" }.joined(separator: "\n")])
    record("exact-public-review", content.label == "Approval Lab test note"
      && publisher.label == String(repeating: "f", count: 64) + "\nnpub1lllllllllllllllllllllllllllllllllllllllllllllllllllsq7lrjw"
      && identity.label == selected && exactRelays
      && app.buttons.matching(identifier: "approval-sheet-approve").firstMatch.exists,
      ["content": content.label, "publisher": publisher.label, "identity": identity.label,
       "destinations": relays, "renderedDestinations": Array(relayLabels), "approveTapped": false, "fixture": fixture.label])
    capture("approval-exact-public-review")
    try identityPress("approval-sheet-reject")
    try until("SDK observes native rejection") { !self.approvalSheetVisible() && (try? self.approvalFailures()) == 1 }
    record("reject-denies-sdk", true, ["failedRequests": 1, "publication": "not attempted"])

    try approvalWebAction("Send 3 notes")
    try approvalSheet()
    try identityPress("approval-sheet-dismiss")
    try until("Dismissal pauses the two remaining requests") {
      !self.approvalSheetVisible() && self.app.buttons.matching(identifier: "approval-resume").firstMatch.isHittable
        && (try? self.approvalFailures()) == 2
    }
    capture("approval-dismissed-paused-queue")
    try identityPress("approval-resume")
    for _ in 0..<2 {
      try approvalSheet()
      try identityPress("approval-sheet-reject")
    }
    try until("Approval queue drained") {
      !self.approvalSheetVisible() && !self.app.buttons.matching(identifier: "approval-resume").firstMatch.exists
        && (try? self.approvalFailures()) == 4
    }
    record("dismiss-pauses-queue", true, ["dismissedRequestDenied": true, "resumedRequestsRejected": 2, "failedRequests": 4])

    try approvalWebAction("Send note")
    try approvalSheet()
    XCUIDevice.shared.press(.home)
    try until("Approval fixture backgrounded") { self.app.state == .runningBackground || self.app.state == .runningBackgroundSuspended }
    app.activate()
    try until("Backgrounded approval waits for explicit resume") {
      self.app.state == .runningForeground && !self.approvalSheetVisible()
        && self.app.buttons.matching(identifier: "approval-resume").firstMatch.isHittable
    }
    capture("approval-background-paused")
    record("background-preserves-pending", true, ["autoPrompt": false, "resumeRequired": true, "approveTapped": false])
    try identityPress("approval-resume")
    try approvalSheet()
    try identityPress("approval-sheet-reject")
    try until("Backgrounded request rejected after resume") { !self.approvalSheetVisible() && (try? self.approvalFailures()) == 5 }
    complete = true
  }

  func testPublishedHost() throws {
    guard ProcessInfo.processInfo.environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.publishedhostfixture" else {
      throw Failure.invalid("Requires the isolated direct published-host fixture")
    }
    let title = app.staticTexts.matching(NSPredicate(format: "label == %@", "Signed host QA fixture")).firstMatch
    try until("Direct published-host fixture title") { title.exists }
    capture("published-host-fixture-start")

    let publisher = try one(app.staticTexts.matching(identifier: "published-lab-publisher"), "signed fixture publisher")
    let identifier = app.staticTexts.matching(NSPredicate(format: "label == %@", "hypergolic-qa-embedded")).firstMatch
    let event = app.staticTexts.matching(NSPredicate(format: "label == %@", "abc35c0b0d09e6934d94321f66fd309b62a2d92031d5501cbbdf175bddf049f6")).firstMatch
    let access = app.staticTexts.matching(NSPredicate(format: "label == %@", "Theme only")).firstMatch
    try until("Exact signed fixture review fields") { identifier.exists && event.exists && access.exists }
    guard publisher.label == "cb9e62b0a9bdb390be102d17ecd9f1c652824723229577066d938d5cbee4a6e3" else {
      throw Failure.invalid("Signed fixture publisher does not match the reviewed public key")
    }
    record("review-exact-signed-fixture", identifier.label == "hypergolic-qa-embedded"
      && event.label == "abc35c0b0d09e6934d94321f66fd309b62a2d92031d5501cbbdf175bddf049f6"
      && access.label == "Theme only"
      && app.buttons.matching(identifier: "published-lab-open").firstMatch.exists,
      ["publisher": publisher.label, "identifier": identifier.label, "eventId": event.label,
       "access": access.label, "openAvailable": true,
       "scope": "Direct test-only fixture entry; no selected identity or production shell settings assumed"])
    capture("published-host-review")

    let open = try one(app.buttons.matching(identifier: "published-lab-open"), "Open signed test", visible: false)
    try stateNativeReveal(open)
    try nativeTap(open, name: "published-lab-open")
    let status = app.staticTexts.matching(identifier: "published-lab-status").firstMatch
    try until("Signed test napplet connected through native host") {
      status.exists && status.label == "Signed test napplet connected"
    }

    // WebKit accessibility exposure varies by Simulator version. Record whether
    // the guest's rendered marker is queryable; shell.ready remains required.
    var marker: XCUIElement?
    let markerDeadline = Date().addingTimeInterval(3)
    repeat {
      marker = app.webViews.allElementsBoundByIndex
        .filter { $0.exists && $0.isHittable && $0.descendants(matching: .webView).count == 0 }
        .flatMap { $0.staticTexts.matching(NSPredicate(format: "label == %@", "fixture-loaded")).allElementsBoundByIndex }
        .first(where: { $0.exists })
      if marker != nil { break }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    } while Date() < markerDeadline

    record("native-host-connected", true, ["status": status.label, "guestMarkerAccessible": marker != nil,
      "guestMarker": marker?.label ?? "",
      "scope": "Direct test-only fixture; host flow only, no production identity claim"])
    capture("published-host-connected")
    let close = try one(app.buttons.matching(identifier: "published-lab-close"), "Close signed test", visible: false)
    try stateNativeReveal(close)
    try nativeTap(close, name: "published-lab-close")
    try until("Signed test lab closed to direct fixture screen") {
      self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Signed host QA fixture")).firstMatch.exists
        && !self.app.buttons.matching(identifier: "published-lab-open").firstMatch.exists
    }
    record("close-returns-to-fixture", true, ["title": "Signed host QA fixture", "selectedIdentityAssumed": false])
    capture("published-host-fixture-returned")
    complete = true
  }

  func testLivePublished() throws {
    guard ProcessInfo.processInfo.environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.livepublishedfixture" else {
      throw Failure.invalid("Requires isolated public-only live fixture")
    }
    let naddr = "naddr1qvzqqqyf8ypzqfngzhsvjggdlgeycm96x4emzjlwf8dyyzdfg4hefp89zpkdgz99qqxxv6tvv5kkyun0waek2us8fz2v6"
    let publisher = "266815e0c9210dfa324c6cba3573b14bee49da4209a9456f9484e5106cd408a5"
    let event = "a3c01be3f0d75cd8ff758c78f71ab9446487f01b791f53ac141fce15d1214d0d"
    let verified = "Native relay and HTTPS artifact verified (56974 bytes)"
    let banner = try one(app.staticTexts.matching(identifier: "live-fixture-label"), "public-only live fixture", visible: false)
    let address = try one(app.staticTexts.matching(identifier: "live-fixture-address"), "public signed coordinate", visible: false)
    guard banner.label == "Live published QA · public identity · signing unavailable", address.label == naddr,
          currentTitle() == "Hypergolic", (try selectedIdentity()).hasPrefix("npub1") else {
      throw Failure.invalid("Live fixture did not begin with the exact public identity and coordinate")
    }
    capture("live-published-start")
    try identityPress("live-fixture-probe")
    let probe = app.staticTexts.matching(identifier: "live-fixture-probe-result").firstMatch
    try until("Native relay and HTTPS probe outcome", timeout: 60) {
      probe.exists && (probe.label == verified || probe.label.contains(" failed:"))
    }
    guard probe.label == verified else { throw Failure.invalid("Native source probe reported " + probe.label) }
    record("live-native-relay-https", true, ["result": probe.label, "eventId": event])
    capture("live-published-probe-verified")

    try identityPress("shell-settings")
    let input = try one(app.textFields.matching(identifier: "settings-napplet-address"), "published naddr input", visible: false)
    input.tap()
    for character in naddr { input.typeText(String(character)) }
    guard (input.value as? String) == naddr else { throw Failure.invalid("Could not enter exact public naddr") }
    let open = app.buttons.matching(identifier: "settings-open-napplet").firstMatch
    try stateNativeReveal(open)
    try identityPress("settings-open-napplet")
    let openError = app.staticTexts.matching(identifier: "settings-napplet-error").firstMatch
    try until("Live first-open review or explicit open error", timeout: 60) {
      (self.app.descendants(matching: .any).matching(identifier: "settings-napplet-review").firstMatch.exists
        && self.app.buttons.matching(identifier: "settings-napplet-approve").firstMatch.isHittable) || openError.exists
    }
    if openError.exists {
      let source = app.staticTexts.matching(identifier: "live-fixture-open-diagnostic").firstMatch
      throw Failure.invalid("Published open reported verification error before review: " +
        String(openError.label.prefix(200)) + " / " + (source.exists ? String(source.label.prefix(200)) : "source stage unavailable"))
    }
    let claims = Set(app.staticTexts.allElementsBoundByIndex.filter { $0.exists }.map(\.label))
    record("live-first-open-exact-review", claims.contains(publisher) && claims.contains("file-browser")
      && claims.contains(event) && claims.contains("Requested access: theme"),
      ["publisher": publisher, "identifier": "file-browser", "eventId": event, "requestedAccess": "theme"])
    capture("live-published-review")
    try identityPress("settings-napplet-approve")
    try until("Verified live guest connected", timeout: 45) {
      self.currentTitle() == "file-browser"
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("live-guest-connected", true, ["title": "file-browser", "runtimeConnected": true])
    capture("live-published-connected")
    complete = true
  }

  private func liveUpdateFixture() throws -> (naddr: String, publisher: String, identifier: String, v1: String, v2: String) {
    let environment = ProcessInfo.processInfo.environment
    guard environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.livepublishedfixture",
          let naddr = environment["HG_LIVE_NADDR"], naddr.hasPrefix("naddr1"),
          let publisher = environment["HG_LIVE_PUBLISHER"], publisher.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
          let identifier = environment["HG_LIVE_IDENTIFIER"], identifier.range(of: "^[a-z0-9-]{1,13}$", options: .regularExpression) != nil,
          let v1 = environment["HG_LIVE_V1"], v1.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
          let v2 = environment["HG_LIVE_V2"], v2.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
          v1 != v2 else { throw Failure.invalid("Requires exact public live-update fixture handoff") }
    return (naddr, publisher, identifier, v1, v2)
  }

  func testLiveUpdateV1() throws {
    let fixture = try liveUpdateFixture()
    let banner = try one(app.staticTexts.matching(identifier: "live-fixture-label"), "public live fixture banner", visible: false)
    guard banner.label == "Live published QA · public identity · signing unavailable",
          currentTitle() == "Hypergolic",
          !publishedMarker("update-v1") && !publishedMarker("update-v2") else {
      throw Failure.invalid("Live update fixture did not begin empty and public-only")
    }
    let selected = try selectedIdentity()
    guard selected.hasPrefix("npub1") else { throw Failure.invalid("Public-only selected identity missing") }
    record("live-public-fixture", true, ["selectedIdentity": selected, "signing": "unavailable", "initialTitle": currentTitle()])
    capture("live-update-empty-shell")

    try identityPress("shell-settings")
    let input = try one(app.textFields.matching(identifier: "settings-napplet-address"), "live naddr input", visible: false)
    input.tap()
    for character in fixture.naddr { input.typeText(String(character)) }
    guard (input.value as? String) == fixture.naddr else { throw Failure.invalid("Could not enter exact live naddr") }
    let open = app.buttons.matching(identifier: "settings-open-napplet").firstMatch
    try stateNativeReveal(open)
    try identityPress("settings-open-napplet")
    try until("Live v1 first-open review") {
      self.app.descendants(matching: .any).matching(identifier: "settings-napplet-review").firstMatch.exists
        && self.app.buttons.matching(identifier: "settings-napplet-approve").firstMatch.isHittable
    }
    let claims = Set(app.staticTexts.allElementsBoundByIndex.filter { $0.exists }.map(\.label))
    record("live-first-open-exact-review", claims.contains(fixture.publisher) && claims.contains(fixture.identifier)
      && claims.contains(fixture.v1) && claims.contains("Requested access: theme"),
      ["publisher": fixture.publisher, "identifier": fixture.identifier, "eventId": fixture.v1,
       "requestedAccess": "theme", "explicitApprovalRequired": true])
    capture("live-update-v1-review")
    try identityPress("settings-napplet-approve")
    try until("Live v1 native host connected") {
      self.currentTitle() == fixture.identifier && self.publishedMarker("update-v1") && !self.publishedMarker("update-v2")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("live-v1-connected", true, ["eventId": fixture.v1, "host": "update-v1", "runtimeConnected": true])
    capture("live-update-v1-connected")
    complete = true
  }

  func testLiveUpdateV2() throws {
    let fixture = try liveUpdateFixture()
    try until("Pinned live v1 restored before update check") {
      self.currentTitle() == fixture.identifier && self.publishedMarker("update-v1") && !self.publishedMarker("update-v2")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("live-v1-before-update", true, ["host": "update-v1", "eventId": fixture.v1])
    capture("live-update-before-v2-review")
    try identityPress("shell-settings")
    let check = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "published-update-check-")).firstMatch
    try stateNativeReveal(check)
    let session = String(check.identifier.dropFirst("published-update-check-".count))
    guard session.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil,
          app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + fixture.v1)).firstMatch.exists else {
      throw Failure.invalid("Live v1 pin or session identity missing")
    }
    try identityPress(check.identifier)
    let reviewId = "published-update-review-" + session
    try until("Live v2 candidate review") { self.app.descendants(matching: .any).matching(identifier: reviewId).firstMatch.exists }
    let publisherClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", fixture.publisher)).firstMatch
    let identifierClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", fixture.identifier)).firstMatch
    let oldClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", fixture.v1)).firstMatch
    let newClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", fixture.v2)).firstMatch
    let accessClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", "Requested access: theme")).firstMatch
    try until("Exact live old and new event fields") {
      publisherClaim.exists && identifierClaim.exists && oldClaim.exists && newClaim.exists && accessClaim.exists
    }
    record("live-update-exact-review", publisherClaim.label == fixture.publisher && identifierClaim.label == fixture.identifier
      && oldClaim.label == fixture.v1 && newClaim.label == fixture.v2 && accessClaim.label == "Requested access: theme",
      ["publisher": fixture.publisher, "identifier": fixture.identifier, "oldEvent": fixture.v1, "newEvent": fixture.v2])
    capture("live-update-v2-review-decline")
    let cancel = app.buttons.matching(identifier: "published-update-cancel-" + session).firstMatch
    try stateNativeReveal(cancel)
    try nativeTap(cancel, name: "decline-live-v2")
    try identityPress("settings-done")
    try until("Declining live v2 retains native v1 guest") {
      self.publishedMarker("update-v1") && !self.publishedMarker("update-v2")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("live-decline-retains-v1", true, ["pinnedEvent": fixture.v1, "host": "update-v1"])
    capture("live-update-declined-v1")

    try identityPress("shell-settings")
    let secondCheck = app.buttons.matching(identifier: "published-update-check-" + session).firstMatch
    try stateNativeReveal(secondCheck)
    try identityPress(secondCheck.identifier)
    try until("Second exact live v2 review") {
      self.app.descendants(matching: .any).matching(identifier: reviewId).firstMatch.exists
        && oldClaim.exists && newClaim.exists && publisherClaim.exists && identifierClaim.exists && accessClaim.exists
    }
    let accept = app.buttons.matching(identifier: "published-update-accept-" + session).firstMatch
    try stateNativeReveal(accept)
    try nativeTap(accept, name: "accept-live-v2")
    try until("Accepted live v2 native guest") {
      self.publishedMarker("update-v2") && !self.publishedMarker("update-v1")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("live-accept-renders-v2", true, ["eventId": fixture.v2, "host": "update-v2", "runtimeConnected": true])
    capture("live-update-accepted-v2")
    app.terminate()
    app.activate()
    try until("Accepted live v2 restored after cold restart") {
      self.currentTitle() == fixture.identifier && self.publishedMarker("update-v2") && !self.publishedMarker("update-v1")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("live-cold-restart-retains-v2", true, ["eventId": fixture.v2, "host": "update-v2"])
    capture("live-update-restarted-v2")
    complete = true
  }

  func testPublishedUpdate() throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.publishedupdatefixture" else {
      throw Failure.invalid("Requires the isolated public-only published-update fixture")
    }
    let fixture = try one(app.staticTexts.matching(identifier: "update-fixture-label"), "public update fixture label", visible: false)
    let address = try one(app.staticTexts.matching(identifier: "update-fixture-address"), "fixture naddr", visible: false)
    guard fixture.label == "Published update QA · public identity · signing unavailable",
          address.label.hasPrefix("naddr1") else { throw Failure.invalid("Published update fixture boundary or naddr mismatch") }
    let addressText = address.label
    try until("Empty shell settings control") { self.app.buttons.matching(identifier: "shell-settings").firstMatch.isHittable }
    guard currentTitle() == "Hypergolic",
          app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).count == 0 else {
      throw Failure.invalid("Published update fixture did not start with an empty shell workspace")
    }
    let fixtureNpub = "npub1qdy7xywj7luwyagwz6gz2u52t026eqzv9pvg9y5t7zvvlzc7nzlqnsqte4"
    guard try selectedIdentity() == fixtureNpub else {
      throw Failure.invalid("Published update fixture selected a different identity")
    }
    record("public-fixture-and-runtime", true, ["fixture": fixture.label, "naddr": addressText,
      "selectedIdentity": fixtureNpub, "initialFocusedTitle": currentTitle(), "runtimeSessions": 0, "signing": "unavailable"])
    capture("published-update-fixture-empty-shell")

    try identityPress("shell-settings")
    let input = try one(app.textFields.matching(identifier: "settings-napplet-address"), "published naddr input", visible: false)
    input.tap()
    // One long XCTest text action outruns React Native's controlled input on Simulator.
    for character in addressText { input.typeText(String(character)) }
    guard (input.value as? String) == addressText else { throw Failure.invalid("Could not enter fixture naddr") }
    let open = app.buttons.matching(identifier: "settings-open-napplet").firstMatch
    try stateNativeReveal(open)
    try identityPress("settings-open-napplet")
    try until("Exact first-open published consent review") {
      self.app.descendants(matching: .any).matching(identifier: "settings-napplet-review").firstMatch.exists
        && self.app.buttons.matching(identifier: "settings-napplet-approve").firstMatch.isHittable
    }
    let review = app.descendants(matching: .any).matching(identifier: "settings-napplet-review").firstMatch
    let claims = Set(app.staticTexts.allElementsBoundByIndex.filter { $0.exists }.map(\.label))
    let publisher = "638cd26c28fb52d057f424d11a14e24526ac4b5e08cbad5d6c36f8f57cacce2f"
    let appId = "hypergolic-update-qa"
    let oldEvent = "dc078ef5973560de09933f39f19dddc28c51b2b30c7ec505157442db665a48b1"
    let newEvent = "df50ad4aa2bcbc0514f75a63ca72c0dfb12da1b1e9e199f551bd6d2d98a71640"
    let exactReview = claims.contains(publisher) && claims.contains(appId) && claims.contains(oldEvent)
      && claims.contains("Requested access: theme")
      && app.buttons.matching(identifier: "settings-napplet-approve").firstMatch.exists
    record("first-open-exact-review", exactReview, ["publisher": publisher, "identifier": appId, "eventId": oldEvent,
      "reviewVisible": review.exists, "signing": "unavailable", "requestedAccess": "theme"])
    capture("published-update-first-open-review")
    try identityPress("settings-napplet-approve")
    try until("Published update v1 host connected") {
      self.currentTitle() == appId
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    try until("Published v1 rendered marker") { self.publishedMarker("update-v1") }
    let release = try one(app.buttons.matching(identifier: "update-fixture-release"), "fixture release control", visible: false)
    try nativeTap(release, name: "release-published-update")
    try until("Fixture exposes its newer revision") { self.app.buttons.matching(identifier: "update-fixture-release").firstMatch.label.contains("New revision available") }
    try identityPress("shell-settings")
    let check = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "published-update-check-")).firstMatch
    try stateNativeReveal(check)
    let sessionId = String(check.identifier.dropFirst("published-update-check-".count))
    guard sessionId.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil else {
      throw Failure.invalid("Published session control did not include a UUID")
    }
    let pinned = app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + oldEvent)).firstMatch
    try until("Pinned v1 event and update check") { pinned.exists && check.isHittable }
    try identityPress(check.identifier)
    let updateReviewId = "published-update-review-" + sessionId
    try until("Update candidate review") { self.app.descendants(matching: .any).matching(identifier: updateReviewId).firstMatch.exists }
    let updateReview = app.descendants(matching: .any).matching(identifier: updateReviewId).firstMatch
    let reviewWasVisible = updateReview.exists
    let oldClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", oldEvent)).firstMatch
    let newClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", newEvent)).firstMatch
    let publisherClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", publisher)).firstMatch
    let appClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", appId)).firstMatch
    let accessClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", "Requested access: theme")).firstMatch
    try until("Review names exact publisher, napplet, access and signed events") {
      oldClaim.exists && newClaim.exists && publisherClaim.exists && appClaim.exists && accessClaim.exists
    }
    let exactCancelledCandidate = oldClaim.label == oldEvent && newClaim.label == newEvent
      && publisherClaim.label == publisher && appClaim.label == appId && accessClaim.label == "Requested access: theme"
    capture("published-update-review-cancel")
    let cancel = app.buttons.matching(identifier: "published-update-cancel-" + sessionId).firstMatch
    try stateNativeReveal(cancel)
    try nativeTap(cancel, name: "published-update-cancel")
    try until("Cancelled update keeps v1 pinned and connected") {
      !self.app.descendants(matching: .any).matching(identifier: updateReviewId).firstMatch.exists
        && self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + oldEvent)).firstMatch.exists
        && self.app.buttons.matching(identifier: "published-update-check-" + sessionId).firstMatch.exists
    }
    try identityPress("settings-done")
    try until("Cancelled update leaves old host connected") {
      self.currentTitle() == appId && self.publishedMarker("update-v1")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("update-cancel-retains-old", reviewWasVisible && exactCancelledCandidate,
      ["sessionId": sessionId, "oldEvent": oldEvent, "candidateEvent": newEvent, "pinnedAfterCancel": oldEvent,
       "hostAfterCancel": "update-v1", "runtimeConnected": true])
    capture("published-update-cancel-retained-v1")

    try identityPress("shell-settings")
    let secondCheck = app.buttons.matching(identifier: "published-update-check-" + sessionId).firstMatch
    try stateNativeReveal(secondCheck)
    try identityPress(secondCheck.identifier)
    try until("Second update candidate review") { self.app.descendants(matching: .any).matching(identifier: updateReviewId).firstMatch.exists }
    let secondOldClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", oldEvent)).firstMatch
    let secondNewClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", newEvent)).firstMatch
    try until("Second review names exact publisher, napplet, access and events") {
      secondOldClaim.exists && secondNewClaim.exists && publisherClaim.exists && appClaim.exists && accessClaim.exists
    }
    let exactAcceptedCandidate = secondOldClaim.label == oldEvent && secondNewClaim.label == newEvent
      && publisherClaim.label == publisher && appClaim.label == appId && accessClaim.label == "Requested access: theme"
    capture("published-update-review-accept")
    let accept = app.buttons.matching(identifier: "published-update-accept-" + sessionId).firstMatch
    try stateNativeReveal(accept)
    try nativeTap(accept, name: "published-update-accept")
    try until("Accepted update returns to focused shell") { self.app.buttons.matching(identifier: "shell-settings").firstMatch.isHittable }
    try identityPress("shell-settings")
    let updatedPinned = app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + newEvent)).firstMatch
    try stateNativeReveal(updatedPinned)
    try until("New event is the only visible pin") {
      updatedPinned.exists && self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + oldEvent)).count == 0
    }
    let newPinWasVisible = updatedPinned.exists
    try identityPress("settings-done")
    try until("Accepted update replaces v1 runtime") {
      self.currentTitle() == appId && self.publishedMarker("update-v2")
        && !self.publishedMarker("update-v1")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("update-accept-replaces-host", exactAcceptedCandidate
      && newPinWasVisible, ["sessionId": sessionId, "pinnedEvent": newEvent, "host": "update-v2",
        "oldHostVisible": false, "runtimeConnected": true,
        "scope": "Process-owned coordinator, grant and workspace path; no signing, key material or release-signing claim"])
    capture("published-update-accepted-v2")

    app.terminate()
    app.activate()
    try until("Accepted update restored after cold restart") {
      self.currentTitle() == appId && self.publishedMarker("update-v2")
        && !self.publishedMarker("update-v1")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    try identityPress("shell-settings")
    let restartedPin = app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + newEvent)).firstMatch
    try stateNativeReveal(restartedPin)
    let newPinAfterRestart = restartedPin.exists
      && app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + oldEvent)).count == 0
    try identityPress("settings-done")
    record("cold-restart-retains-v2", newPinAfterRestart,
      ["pinnedEvent": newEvent, "host": "update-v2", "oldHostVisible": false, "runtimeConnected": true])
    capture("published-update-restarted-v2")

    try identityPress("shell-settings")
    let olderCheck = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "published-update-check-")).firstMatch
    try stateNativeReveal(olderCheck)
    let restartedSessionId = String(olderCheck.identifier.dropFirst("published-update-check-".count))
    guard restartedSessionId.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil else {
      throw Failure.invalid("Restored published session control did not include a UUID")
    }
    try nativeTap(olderCheck, name: "check-older-revision")
    let olderStatus = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "current version remains open")).firstMatch
    let latestStatus = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "latest verified version")).firstMatch
    try until("Older signed revision rejected without review") { olderStatus.exists || latestStatus.exists }
    let olderWasRejected = !app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", "published-update-review-")).firstMatch.exists
      && app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + newEvent)).firstMatch.exists
    try identityPress("settings-done")
    try until("Accepted guest remains after older revision check") {
      self.publishedMarker("update-v2") && !self.publishedMarker("update-v1")
    }
    record("rollback-rejected-after-restart", olderWasRejected,
      ["restoredSessionId": restartedSessionId, "availableRevision": oldEvent,
       "pinnedEvent": newEvent, "reviewOffered": false, "host": "update-v2"])
    capture("published-update-older-revision-rejected")

    XCUIDevice.shared.press(.home)
    try until("Published fixture backgrounded") {
      self.app.state == .runningBackground || self.app.state == .runningBackgroundSuspended
    }
    app.activate()
    try until("Verified published read view retained after background") {
      self.publishedMarker("update-v2") && !self.publishedMarker("update-v1")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    let retained = !app.buttons.matching(identifier: "published-retry-" + restartedSessionId).firstMatch.exists
    record("background-retains-verified-v2", retained,
      ["retainedSessionId": restartedSessionId, "pinnedEvent": newEvent,
       "scope": "Loaded read view retention; stream reconnect is tested separately."])
    capture("published-update-background-retained")
    complete = true
  }

  func testChangedAccess() throws {
    let bundle = "org.nostrocket.hypergolic.publishedupdatefixture"
    guard ProcessInfo.processInfo.environment["HG_TARGET_BUNDLE_ID"] == bundle else {
      throw Failure.invalid("Requires the isolated public-only changed-access fixture")
    }
    let fixture = try one(app.staticTexts.matching(identifier: "changed-access-fixture-label"), "changed-access fixture label", visible: false)
    let address = try one(app.staticTexts.matching(identifier: "changed-access-fixture-address"), "changed-access fixture naddr", visible: false)
    guard fixture.label.localizedCaseInsensitiveContains("changed access"), address.label.hasPrefix("naddr1") else {
      throw Failure.invalid("Changed-access fixture boundary or naddr mismatch")
    }
    let addressText = address.label
    try until("Empty shell settings control") { self.app.buttons.matching(identifier: "shell-settings").firstMatch.isHittable }
    guard currentTitle() == "Hypergolic",
          app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).count == 0 else {
      throw Failure.invalid("Changed-access fixture did not start with an empty shell workspace")
    }
    record("public-fixture-and-runtime", true, ["fixture": fixture.label, "naddr": addressText,
      "initialFocusedTitle": currentTitle(), "runtimeSessions": 0, "signing": "unavailable"])
    capture("changed-access-fixture-empty-shell")

    let publisher = "803d57d794cf576cbef909cd854a040bddd4a04fc6ea7a36f85a1daf0bc43799"
    let appId = "hypergolic-changed-access-qa"
    let v1Event = "2bd6f1bfcfbbd1053735e98e9306664577334ecde33f8420f8cbaa638fb2a0ac"
    let v2Event = "1f7adba5c649f9ab5f5933d658e4aea76c23347d982bbdfe3fa9202155c17beb"
    let v2Domains = "relay, theme"

    try identityPress("shell-settings")
    let input = try one(app.textFields.matching(identifier: "settings-napplet-address"), "changed-access naddr input", visible: false)
    input.tap()
    for character in addressText { input.typeText(String(character)) }
    guard (input.value as? String) == addressText else { throw Failure.invalid("Could not enter changed-access fixture naddr") }
    try stateNativeReveal(app.buttons.matching(identifier: "settings-open-napplet").firstMatch)
    try identityPress("settings-open-napplet")
    try until("Exact first-open changed-access consent review") {
      self.app.descendants(matching: .any).matching(identifier: "settings-napplet-review").firstMatch.exists
        && self.app.buttons.matching(identifier: "settings-napplet-approve").firstMatch.isHittable
    }
    let firstReview = app.descendants(matching: .any).matching(identifier: "settings-napplet-review").firstMatch
    let initialClaims = Set(app.staticTexts.allElementsBoundByIndex.filter { $0.exists }.map(\.label))
    let exactFirstOpen = initialClaims.contains(publisher) && initialClaims.contains(appId)
      && initialClaims.contains(v1Event) && initialClaims.contains("Requested access: theme")
    record("first-open-exact-review", exactFirstOpen, ["publisher": publisher, "appId": appId,
      "eventId": v1Event, "domains": ["theme"], "reviewVisible": firstReview.exists])
    capture("changed-access-first-open-review")
    try identityPress("settings-napplet-approve")
    try until("Changed-access v1 host connected") {
      self.currentTitle() == appId
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
        && self.publishedMarker("changed-access-v1")
    }
    try nativeTap(try one(app.buttons.matching(identifier: "changed-access-fixture-release"), "release v2 control", visible: false),
      name: "release-changed-access-v2")
    try until("Changed-access v2 released") {
      self.app.buttons.matching(identifier: "changed-access-fixture-release").firstMatch.label == "Changed-access revision available"
    }

    try identityPress("shell-settings")
    let check = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "published-update-check-")).firstMatch
    try stateNativeReveal(check)
    let sessionId = String(check.identifier.dropFirst("published-update-check-".count))
    guard sessionId.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil else {
      throw Failure.invalid("Changed-access session control did not include a UUID")
    }
    try until("v1 event pin and update check") {
      self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + v1Event)).firstMatch.exists && check.isHittable
    }
    try identityPress(check.identifier)
    let candidateId = "published-update-review-" + sessionId
    try until("Changed-access signed update review") { self.app.descendants(matching: .any).matching(identifier: candidateId).firstMatch.exists }
    let candidate = app.descendants(matching: .any).matching(identifier: candidateId).firstMatch
    let oldClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", v1Event)).firstMatch
    let newClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", v2Event)).firstMatch
    let publisherClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", publisher)).firstMatch
    let appClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", appId)).firstMatch
    let domainsClaim = app.staticTexts.matching(NSPredicate(format: "label == %@", "Requested access: " + v2Domains)).firstMatch
    try until("Candidate review names exact publisher, app, signed events and changed domains") {
      oldClaim.exists && newClaim.exists && publisherClaim.exists && appClaim.exists && domainsClaim.exists
    }
    let exactCandidate = candidate.exists && oldClaim.label == v1Event && newClaim.label == v2Event
      && publisherClaim.label == publisher && appClaim.label == appId && domainsClaim.label == "Requested access: " + v2Domains
    record("update-review-exact-candidate", exactCandidate, ["publisher": publisher, "appId": appId,
      "previousEvent": v1Event, "candidateEvent": v2Event, "domains": v2Domains])
    capture("changed-access-update-review")
    let acceptCandidate = try one(app.buttons.matching(identifier: "published-update-accept-" + sessionId), "accept signed update", visible: false)
    try stateNativeReveal(acceptCandidate)
    try nativeTap(acceptCandidate, name: "accept-changed-access-candidate")

    let accessReviewId = "published-update-access-" + sessionId
    try until("Separate changed-access review appears before v2 host") {
      self.app.descendants(matching: .any).matching(identifier: accessReviewId).firstMatch.exists
        && self.app.buttons.matching(identifier: "published-update-access-cancel-" + sessionId).firstMatch.exists
    }
    let accessReview = app.descendants(matching: .any).matching(identifier: accessReviewId).firstMatch
    let accessLabels = Set(app.staticTexts.allElementsBoundByIndex.filter { $0.exists }.map(\.label))
    let exactAccessReview = accessReview.exists && accessLabels.contains(publisher) && accessLabels.contains(appId)
      && accessLabels.contains("The update requests: " + v2Domains)
    capture("changed-access-review-decline")
    let cancelAccess = try one(app.buttons.matching(identifier: "published-update-access-cancel-" + sessionId), "decline changed access", visible: false)
    try stateNativeReveal(cancelAccess)
    try nativeTap(cancelAccess, name: "decline-changed-access")
    try until("Declined access leaves v1 pinned and update check available") {
      !self.app.descendants(matching: .any).matching(identifier: accessReviewId).firstMatch.exists
        && self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + v1Event)).firstMatch.exists
        && self.app.buttons.matching(identifier: "published-update-check-" + sessionId).firstMatch.exists
    }
    try identityPress("settings-done")
    try until("Declined changed access retains connected v1 guest") {
      self.currentTitle() == appId && self.publishedMarker("changed-access-v1")
        && !self.publishedMarker("changed-access-v2")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("changed-access-decline-retains-v1", exactAccessReview, ["v1Event": v1Event,
      "candidateEvent": v2Event, "host": "changed-access-v1", "runtimeConnected": true,
      "separateAccessReview": true])
    capture("changed-access-declined-v1-retained")

    try identityPress("shell-settings")
    let secondCheck = app.buttons.matching(identifier: "published-update-check-" + sessionId).firstMatch
    try stateNativeReveal(secondCheck)
    try identityPress(secondCheck.identifier)
    try until("Repeated changed-access update review") { self.app.descendants(matching: .any).matching(identifier: candidateId).firstMatch.exists }
    let secondAccept = try one(app.buttons.matching(identifier: "published-update-accept-" + sessionId), "accept repeated signed update", visible: false)
    try stateNativeReveal(secondAccept)
    try nativeTap(secondAccept, name: "accept-repeated-changed-access-candidate")
    try until("Repeated changed-access consent review") {
      self.app.descendants(matching: .any).matching(identifier: accessReviewId).firstMatch.exists
        && self.app.buttons.matching(identifier: "published-update-access-accept-" + sessionId).firstMatch.exists
    }
    let repeatedAccessLabels = Set(app.staticTexts.allElementsBoundByIndex.filter { $0.exists }.map(\.label))
    let exactRepeatedAccess = repeatedAccessLabels.contains(publisher) && repeatedAccessLabels.contains(appId)
      && repeatedAccessLabels.contains("The update requests: " + v2Domains)
    let acceptAccess = try one(app.buttons.matching(identifier: "published-update-access-accept-" + sessionId), "allow changed access", visible: false)
    try stateNativeReveal(acceptAccess)
    try nativeTap(acceptAccess, name: "accept-changed-access")
    try until("Accepted changed-access update returns to focused shell") {
      self.app.buttons.matching(identifier: "shell-settings").firstMatch.isHittable
    }
    try identityPress("shell-settings")
    let pinnedV2 = app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + v2Event)).firstMatch
    try stateNativeReveal(pinnedV2)
    try until("v2 event is the only pinned revision") {
      pinnedV2.exists && self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Pinned event " + v1Event)).count == 0
    }
    try identityPress("settings-done")
    try until("Accepted changed-access v2 host connected") {
      self.currentTitle() == appId && self.publishedMarker("changed-access-v2")
        && !self.publishedMarker("changed-access-v1")
        && self.app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).firstMatch.label == "Runtime connected"
    }
    record("changed-access-accept-replaces-host", exactCandidate && exactRepeatedAccess,
      ["v2Event": v2Event, "domains": v2Domains, "host": "changed-access-v2", "v1Visible": false,
       "runtimeConnected": true])
    capture("changed-access-accepted-v2")
    complete = true
  }

  private func approvalWebAction(_ label: String) throws {
    let host = try web()
    let button = host.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    try stateReveal(button, in: host)
    try clearTap(button, within: host, name: "approval-" + label.lowercased().replacingOccurrences(of: " ", with: "-"))
  }
  private func approvalSheetVisible() -> Bool {
    app.descendants(matching: .any).matching(identifier: "approval-sheet").firstMatch.exists
  }
  private func approvalSheet() throws {
    try until("Native approval sheet") {
      self.approvalSheetVisible() && self.app.buttons.matching(identifier: "approval-sheet-reject").firstMatch.isHittable
    }
  }
  private func approvalFailures() throws -> Int {
    try web().staticTexts.matching(NSPredicate(format: "label == %@", "Failed")).count
  }
  private func stateReady(_ id: String) throws {
    try until("State Lab native and SDK ready") {
      self.app.staticTexts.matching(identifier: "runtime-status-" + id).firstMatch.label == "Runtime connected"
        && (try? self.web().staticTexts.matching(NSPredicate(format: "label == %@", "Identity connected")).count) == 1
    }
  }
  private func openState(_ variant: String) throws -> String {
    try identityPress("shell-settings")
    let button = app.buttons.matching(identifier: "settings-open-" + variant).firstMatch
    try stateNativeReveal(button)
    try identityPress("settings-open-" + variant)
    try until("New State Lab title") { self.currentTitle().hasPrefix("State Lab") && !self.app.buttons.matching(identifier: "settings-done").firstMatch.exists }
    let statuses = app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", "runtime-status-")).allElementsBoundByIndex.filter { $0.isHittable }
    guard statuses.count == 1 else { throw Failure.invalid("Expected one focused runtime status") }
    let id = String(statuses[0].identifier.dropFirst("runtime-status-".count))
    guard id.hasPrefix(variant + "-") else { throw Failure.invalid("Wrong opened fixture") }
    try stateReady(id)
    return id
  }
  private func stateField(_ id: String) throws -> XCUIElement {
    let host = try web()
    let field = id == "key" ? host.textFields.matching(NSPredicate(format: "label == %@", "Key")).firstMatch
      : host.textViews.matching(NSPredicate(format: "label == %@", "String value")).firstMatch
    try stateReveal(field, in: host)
    try clearTap(field, within: host, name: "state-field-" + id)
    return field
  }
  private func stateReveal(_ element: XCUIElement, in host: XCUIElement) throws {
    guard element.exists else { throw Failure.invalid("Missing State Lab control") }
    for _ in 0..<8 {
      let point = CGPoint(x: element.frame.midX, y: element.frame.midY)
      if element.isHittable && host.frame.insetBy(dx: 12, dy: 20).contains(point) { return }
      let towardTop = point.y < host.frame.midY
      try contentDrag(in: host, from: CGVector(dx: 0.5, dy: towardTop ? 0.25 : 0.75),
        to: CGVector(dx: 0.5, dy: towardTop ? 0.7 : 0.3), name: "reveal-state-control")
    }
    throw Failure.invalid("Cannot reach State Lab control centre")
  }
  private func stateAction(_ title: String, status: String?) throws {
    let before = try stateRequests()
    let host = try web()
    let button = host.buttons.matching(NSPredicate(format: "label == %@", title)).firstMatch
    try stateReveal(button, in: host)
    try clearTap(button, within: host, name: "state-action-" + title)
    try until("A new SDK request") { (try? self.stateRequests()) == before + 1 }
    if let status { try until(status) { (try? self.stateResult().staticTexts.matching(NSPredicate(format: "label == %@", status)).count) == 1 } }
    else { try until("Keys response") { (try? self.stateResult().staticTexts.matching(NSPredicate(format: "label MATCHES %@", "[0-9]+ saved keys\\.")).count) == 1 } }
  }
  private func stateResult() throws -> XCUIElement {
    try one(web().otherElements.matching(NSPredicate(format: "label == %@", "Result, region")), "State Lab result region", visible: false)
  }
  private func stateRequests() throws -> Int {
    let output = try one(stateResult().otherElements.matching(NSPredicate(format: "label MATCHES %@", "[0-9]+, application status")), "SDK request counter", visible: false)
    guard let count = Int(output.label.components(separatedBy: ",")[0]) else { throw Failure.invalid("Missing SDK request counter") }
    return count
  }
  private func stateRead(_ value: String) throws {
    try stateAction("Read", status: "Read complete.")
    try until("Saved string rendered") { (try? self.stateResult().staticTexts.matching(NSPredicate(format: "label == %@", value)).count) == 1 }
  }
  private func stateScope(instance: Bool) throws {
    let host = try web()
    let menu = host.otherElements.matching(NSPredicate(format: "label == %@ AND value != nil", "Save in")).firstMatch
    try stateReveal(menu, in: host)
    try clearTap(menu, within: host, name: "state-scope")
    let label = instance ? "This instance only" : "All instances of this napplet"
    capture("scope-menu")
    let choice = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    guard choice.isHittable else { throw Failure.invalid("Unobservable storage scope option") }
    choice.tap()
    try dismissKeyboard()
  }
  private func stateNativeReveal(_ element: XCUIElement) throws {
    let scroll = app.scrollViews.firstMatch
    guard scroll.exists else { throw Failure.invalid("Missing native scroll surface") }
    for _ in 0..<10 {
      let centre = CGPoint(x: element.frame.midX, y: element.frame.midY)
      if element.isHittable && scroll.frame.insetBy(dx: 8, dy: 20).contains(centre) { return }
      if centre.y < scroll.frame.midY { scroll.swipeDown(velocity: .slow) }
      else { scroll.swipeUp(velocity: .slow) }
    }
    throw Failure.invalid("Could not reveal native control centre")
  }
  private func stateFocus(_ id: String) throws {
    try identityPress("handle-right")
    let card = app.buttons.matching(identifier: "overview-card-" + id).firstMatch
    try stateNativeReveal(card)
    try nativeTap(one(app.buttons.matching(identifier: "overview-card-" + id), "State Lab card"), name: "focus-state")
    try stateReady(id)
  }

  func testIdentitySwitch() throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["HG_TARGET_BUNDLE_ID"] == "org.nostrocket.hypergolic.identityuifixture",
          let nsec = environment["HG_PUBLIC_TEST_NSEC"], let destination = environment["HG_PUBLIC_TEST_NPUB"]
    else { throw Failure.invalid("Expected the isolated public identity UI fixture") }
    try identityFocus(1)
    let original = try selectedIdentity()
    let safeTop = try one(app.staticTexts.matching(identifier: "simulator-ui-fixture-label"), "top safe-area fixture label").frame.minY
    guard safeTop > app.frame.minY else { throw Failure.invalid("Unobservable safe-area baseline") }
    var saved: [Int: State] = [:]
    for number in 1...3 {
      try identityFocus(number)
      saved[number] = try seed(marker: "identity-" + nonce + "-\(number)", increments: number)
    }
    try identityPress("shell-settings")
    let done = try one(app.buttons.matching(identifier: "settings-done"), "Settings Done")
    record("identity-settings-safe-area", done.frame.minY >= safeTop && done.frame.height >= 44, ["safeTop": safeTop, "done": attributes(done)])
    try identityReview("invalid-nsec")
    try until("Invalid import feedback") { self.app.staticTexts.matching(identifier: "identity-import-error").firstMatch.exists }
    try identityPress("identity-import-cancel")
    try identityReview(nsec)
    try until("Reviewed public identity") { self.app.staticTexts.matching(identifier: "identity-change-npub").firstMatch.label == destination }
    capture("identity-confirmation")
    try identityPress("identity-change-cancel")
    try identityPress("settings-done")
    guard try selectedIdentity() == original else { throw Failure.invalid("Cancellation changed identity") }
    for number in 1...3 {
      try identityFocus(number)
      guard try state() == saved[number] else { throw Failure.invalid("Cancelled import changed live state") }
    }
    record("identity-cancel-retains-live-state", true, ["sessions": 3, "npub": original])
    try identityPress("shell-settings")
    try identityReview(nsec)
    try identityPress("identity-change-confirm")
    try focused(3)
    guard try selectedIdentity() == destination else { throw Failure.invalid("Import did not select reviewed identity") }
    for number in 1...3 {
      try identityFocus(number)
      let fresh = try state()
      guard fresh.counter == 0 && fresh.draft.isEmpty else { throw Failure.invalid("Accepted switch retained old live state") }
    }
    record("identity-import-restarts-all", true, ["sessions": 3, "npub": destination])
    try identityPress("shell-settings")
    try until("Two saved identities") { self.identityRows().count == 2 }
    let originalRow = try one(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "identity-select-", original)), "original identity")
    let originalID = originalRow.identifier
    capture("identity-inventory")
    try identityReview(nsec)
    try until("Duplicate current import dismissed") { self.app.staticTexts.matching(identifier: "settings-full-npub").firstMatch.exists }
    guard !app.buttons.matching(identifier: "identity-change-confirm").firstMatch.exists && identityRows().count == 2 else { throw Failure.invalid("Duplicate import added an identity or requested a switch") }
    try identityPress(originalID)
    try identityPress("identity-change-cancel")
    guard app.staticTexts.matching(identifier: "settings-full-npub").firstMatch.label == destination else { throw Failure.invalid("Cancelled saved selector changed identity") }
    try identityPress(originalID)
    try identityPress("identity-change-confirm")
    try focused(3)
    guard try selectedIdentity() == original else { throw Failure.invalid("Saved selector did not restore original public identity") }
    record("identity-duplicate-and-selector", true, ["identities": 2, "npub": original])
    try workspaceSaved()
    try restartWorkspaceApp()
    try focused(3)
    guard try selectedIdentity() == original else { throw Failure.invalid("Selected identity did not survive restart") }
    try identityPress("shell-settings")
    try until("Retained inventory after restart") { self.identityRows().count == 2 }
    capture("identity-after-restart")
    record("identity-selection-after-restart", true, ["npub": original, "identities": identityRows().count, "scope": "Public-key-only fixture inventory; no protected key storage"])
    complete = true
  }
  private func identityRows() -> [XCUIElement] {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "identity-select-")).allElementsBoundByIndex.filter { $0.exists }
  }
  private func selectedIdentity() throws -> String {
    try until("Full identity header visible") { self.app.buttons.matching(identifier: "shell-settings").firstMatch.isHittable }
    let button = try one(app.buttons.matching(identifier: "shell-settings"), "identity header")
    guard button.label.hasPrefix("Settings for npub1") else { throw Failure.invalid("Missing full selected public identity") }
    return String(button.label.dropFirst("Settings for ".count))
  }
  private func identityPress(_ identifier: String) throws {
    try until("Native identity control " + identifier) { self.app.buttons.matching(identifier: identifier).firstMatch.isHittable }
    try nativeTap(one(app.buttons.matching(identifier: identifier), identifier), name: identifier)
  }
  private func identityReview(_ input: String) throws {
    try identityPress("settings-import-identity")
    let field = try one(app.secureTextFields.matching(identifier: "identity-import-input"), "masked secret input")
    field.tap()
    field.typeText(input)
    guard !(field.value as? String ?? "").contains(input) else { throw Failure.invalid("Secret input appeared in accessibility value") }
    // Public disposable test key only. Return invokes the real trusted Continue handler.
    field.typeText("\n")
  }
  private func identityFocus(_ number: Int) throws {
    guard var current = Int(currentTitle().replacingOccurrences(of: "UX Lab ", with: "")) else { throw Failure.invalid("No focused fixture") }
    while current != number {
      let next = current + (number > current ? 1 : -1)
      try switchHandle(number > current ? "right" : "left", to: next)
      current = next
    }
    try focused(number)
  }

  func testWorkspaceRestart() throws {
    try focused(1)
    try workspaceSaved()
    try nativeTap(one(app.buttons.matching(identifier: "shell-settings"), "Settings"), name: "open-settings")
    try nativeTap(one(app.buttons.matching(identifier: "settings-open-ux-lab"), "Open UX Lab"), name: "open-fourth-fixture")
    try focused(4)
    try workspaceSaved()
    capture("before-workspace-restart")
    try restartWorkspaceApp()
    try focused(4)
    try workspaceSaved()
    record("selected-napplet-after-restart", currentTitle() == "UX Lab 4", ["title": currentTitle()])
    capture("restored-focused")
    try openOverview(expected: [1, 2, 3, 4])
    let cards = try [1, 2, 3, 4].map { number in
      try one(app.buttons.matching(identifier: "overview-card-ux-lab-\(number)"), "restored card", visible: false)
    }
    let a = cards[0].frame, b = cards[1].frame, c = cards[2].frame, d = cards[3].frame
    record("opening-order-after-restart", a.maxX < b.minX && abs(a.minY - b.minY) < 2
      && abs(c.minX - a.minX) < 2 && abs(d.minX - b.minX) < 2 && abs(c.minY - d.minY) < 2
      && c.minY > max(a.maxY, b.maxY), ["cards": cards.map(attributes)])
    capture("restored-order")
    for number in 1...4 {
      try nativeTap(one(app.buttons.matching(identifier: "overview-close-ux-lab-\(number)"), "Close first remaining fixture"), name: "close-fixture-\(number)")
      try warning(for: number)
      try nativeTap(one(app.buttons.matching(identifier: "close-confirm"), "Close anyway"), name: "confirm-close-\(number)")
      try overviewReady(Array(1...4).filter { $0 > number })
      try workspaceSaved()
    }
    guard try emptyOverview() else { throw Failure.invalid("Workspace did not become empty before restart") }
    capture("empty-before-restart")
    try restartWorkspaceApp()
    try until("Restored explicit empty workspace") { self.currentTitle() == "Hypergolic" && (try? self.emptyOverview()) == true }
    try workspaceSaved()
    record("explicit-empty-after-restart", try emptyOverview(), ["title": currentTitle(), "sessions": overviewIDs()])
    capture("empty-after-restart")
    complete = true
  }

  private func workspaceSaved() throws {
    try until("Workspace save complete") {
      self.app.descendants(matching: .any).matching(identifier: "workspace-saved").firstMatch.exists
        && !self.app.descendants(matching: .any).matching(identifier: "workspace-saving").firstMatch.exists
    }
  }
  private func restartWorkspaceApp() throws {
    app.terminate()
    try until("Target process terminated") { self.app.state == .notRunning }
    app.launch()
    try until("Target relaunched in foreground") { self.app.state == .runningForeground }
    let completed = observations["completedRestarts"] as? Int ?? 0
    observations["completedRestarts"] = completed + 1
  }

  func testSwitchState() throws {
    try focused(1)
    let a = try seed(marker: "ios-" + nonce + "-a", increments: 1)
    record("seed-a", a.draft.contains(nonce + "-a"), a.json)
    try switchHandle("right", to: 2)
    let beforeB = try state()
    guard !beforeB.draft.contains(nonce + "-a") else { throw Failure.invalid("Fresh A marker leaked into napplet B before B input") }
    let increments = beforeB.counter + 2 == a.counter ? 3 : 2
    let b = try seed(marker: "ios-" + nonce + "-b", increments: increments)
    record("seed-b-isolated", b.counter != a.counter && b.draft != a.draft && !b.draft.contains(nonce + "-a"), ["a": a.json, "b": b.json, "beforeB": beforeB.json])
    try switchHandle("left", to: 1)
    record("edge-roundtrip-a", try state() == a, ["expected": a.json, "actual": try state().json])
    capture("edge-return-a")

    let overviewHandle = try handle("right")
    gestures.append(["name": "open-overview", "input": "XCUICoordinate.tap", "point": pointJSON(CGPoint(x: overviewHandle.frame.midX, y: overviewHandle.frame.midY)), "handle": attributes(overviewHandle)])
    overviewHandle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    try until("Overview controls") { let card = self.app.buttons.matching(identifier: "overview-card-ux-lab-1").firstMatch; return card.exists && card.isHittable }
    let cardA = try one(app.buttons.matching(identifier: "overview-card-ux-lab-1"), "first overview card")
    let cardB = try one(app.buttons.matching(identifier: "overview-card-ux-lab-2"), "second overview card")
    let cardC = try one(app.buttons.matching(identifier: "overview-card-ux-lab-3"), "third overview card", visible: false)
    let leafCount = visibleLeaves().count
    let handles = app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "handle-left", "handle-right")).allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
    record("two-column-overview", cardA.frame.maxX < cardB.frame.minX && abs(cardA.frame.minY - cardB.frame.minY) < 2
           && abs(cardA.frame.width - cardB.frame.width) < 2 && abs(cardA.frame.width - cardC.frame.width) < 2
           && abs(cardC.frame.minX - cardA.frame.minX) < 2 && cardC.frame.minY > max(cardA.frame.maxY, cardB.frame.maxY)
           && leafCount == 0 && handles.isEmpty,
           ["a": attributes(cardA), "b": attributes(cardB), "c": attributes(cardC), "visibleLeafWebViews": leafCount, "visibleHandles": handles.count])
    capture("two-column-overview")
    cardB.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    try focused(2)
    record("overview-restore-b", try state() == b, ["expected": b.json, "actual": try state().json])

    try switchHandle("right", to: 3)
    let c = try state()
    try switchHandle("right", to: 3)
    record("stop-at-last", try state() == c && currentTitle() == "UX Lab 3", ["expected": c.json, "actual": try state().json])
    capture("last-end-stop")
    try switchHandle("left", to: 2)
    guard try state() == b else { throw Failure.invalid("B state changed during end-stop route") }
    try switchHandle("left", to: 1)
    try switchHandle("left", to: 1)
    record("stop-at-first-and-restore-a", try state() == a && currentTitle() == "UX Lab 1", ["expected": a.json, "actual": try state().json])
    capture("first-end-stop")
    complete = true
  }

  func testGestures() throws {
    try focused(1)
    try dismissKeyboard()
    let host = try web()
    let anchor = try one(host.buttons.matching(NSPredicate(format: "label == %@", "Left edge at marker 01")), "vertical fixture anchor", visible: false)
    let beforeY = anchor.frame.minY
    try contentDrag(in: host, from: CGVector(dx: 0.5, dy: 0.92), to: CGVector(dx: 0.5, dy: 0.35), name: "vertical-content")
    try until("Vertical content movement") { abs(anchor.frame.minY - beforeY) > 40 }
    record("vertical-content-scroll", currentTitle() == "UX Lab 1" && beforeY - anchor.frame.minY > 40, ["anchorBeforeY": beforeY, "anchorAfterY": anchor.frame.minY])

    let railQuery = host.otherElements.matching(NSPredicate(format: "label == %@", "Horizontal marker strip, region"))
    var rail = try one(railQuery, "horizontal fixture strip", visible: false)
    for _ in 0..<6 {
      let visible = rail.frame.intersection(host.frame)
      if rail.isHittable && visible.height > 90 { break }
      let down = rail.frame.midY < host.frame.midY
      try contentDrag(in: host, from: CGVector(dx: 0.5, dy: down ? 0.25 : 0.85), to: CGVector(dx: 0.5, dy: down ? 0.65 : 0.35), name: "reveal-horizontal-strip")
      rail = try one(railQuery, "horizontal fixture strip", visible: false)
    }
    guard rail.isHittable, rail.frame.intersection(host.frame).height > 90 else { throw Failure.invalid("Horizontal strip not sufficiently visible") }
    let marker = try one(rail.switches.matching(NSPredicate(format: "label == %@", "Select marker 04")), "fourth strip marker", visible: false)
    let beforeX = marker.frame.minX
    let railVisible = rail.frame.intersection(host.frame)
    let start = CGPoint(x: max(host.frame.minX + host.frame.width * 0.72, railVisible.midX), y: railVisible.midY)
    let end = CGPoint(x: host.frame.minX + host.frame.width * 0.22, y: railVisible.midY)
    try drag(in: host, start: start, end: end, name: "horizontal-content", avoidHandles: true)
    try until("Horizontal strip movement") { beforeX - marker.frame.minX > 40 }
    record("horizontal-content-scroll", currentTitle() == "UX Lab 1" && beforeX - marker.frame.minX > 40,
           ["markerBeforeX": beforeX, "markerAfterX": marker.frame.minX, "strip": attributes(rail)])
    guard marker.isHittable else { throw Failure.invalid("Fourth marker is not visible after horizontal gesture") }
    try clearTap(marker, within: host, name: "select-fourth-marker")
    try until("Marker selected") { (marker.value as? String) == "1" }
    record("marker-selection", (marker.value as? String) == "1", attributes(marker))
    let saved = try state()
    let savedX = marker.frame.minX
    let savedY = anchor.frame.minY
    capture("scrolled-selected-a")
    try switchHandle("right", to: 2)
    try switchHandle("left", to: 1)
    let returned = try web()
    let returnedMarker = try one(returned.switches.matching(NSPredicate(format: "label == %@", "Select marker 04")), "returned fourth marker", visible: false)
    let returnedAnchor = try one(returned.buttons.matching(NSPredicate(format: "label == %@", "Left edge at marker 01")), "returned vertical anchor", visible: false)
    record("scroll-and-selection-retained", try state() == saved && abs(returnedMarker.frame.minX - savedX) < 4 && abs(returnedAnchor.frame.minY - savedY) < 4 && (returnedMarker.value as? String) == "1",
           ["savedState": saved.json, "actualState": try state().json, "savedMarkerX": savedX, "returnedMarkerX": returnedMarker.frame.minX, "savedAnchorY": savedY, "returnedAnchorY": returnedAnchor.frame.minY])
    capture("scrolled-return-a")
    complete = true
  }

  func testCardCancellation() throws {
    try focused(1)
    try dismissKeyboard()
    let saved = try state()
    try openOverview(expected: [1, 2, 3])
    let scroller = try one(app.scrollViews, "overview scroll surface")
    let card = try overviewCard(1)
    let initial = card.frame
    guard initial.intersection(scroller.frame).height >= initial.height - 2 else { throw Failure.invalid("Card must be fully visible for bounded cancellation inputs") }
    let start = CGPoint(x: initial.midX, y: initial.minY + initial.height * 0.6)
    let end = CGPoint(x: start.x, y: start.y - 20)
    try nativeDrag(in: scroller, start: start, end: end, velocity: 1500, name: "short-card-stroke")
    try until("Short card stroke returned to overview") {
      self.overviewIDs() == ["ux-lab-1", "ux-lab-2", "ux-lab-3"] && !self.closePromptVisible()
        && abs(card.frame.minY - initial.minY) < 2
    }
    record("short-card-stroke-cancel", !closePromptVisible() && overviewIDs().count == 3,
      ["requestedTravelPixels": 20, "requestedVelocityPixelsPerSecond": 1500, "before": rectJSON(initial), "after": attributes(card)])
    capture("short-card-stroke-cancel")

    let target = attributes(card)
    observations["twoTouchTarget"] = target
    gestures.append(["name": "two-touch-card", "input": "XCUIElement.pinch", "scale": 0.75, "velocityScalePerSecond": -1,
      "target": target, "scope": "Two simultaneous touches from gesture start; adding a finger after active drag is not claimed."])
    card.pinch(withScale: 0.75, velocity: -1)
    try until("Two-touch gesture returned to overview") {
      self.overviewIDs() == ["ux-lab-1", "ux-lab-2", "ux-lab-3"] && !self.closePromptVisible()
        && abs(card.frame.minY - initial.minY) < 2
    }
    record("two-touch-card-cancel", !closePromptVisible() && overviewIDs().count == 3,
      ["before": target, "after": attributes(card), "inputProof": "Launcher must separately validate two simultaneous archived touch paths inside this observed target."])
    capture("two-touch-card-cancel")
    try nativeTap(overviewCard(1), name: "return-to-cancelled-card")
    try focused(1)
    record("cancelled-card-state-retained", try state() == saved, ["before": saved.json, "after": try state().json])
    capture("cancelled-card-state-retained")
    complete = true
  }

  private func rectJSON(_ rect: CGRect) -> [String: CGFloat] {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
  }

  func testClosing() throws {
    try focused(1)
    let a = try seed(marker: "ios-" + nonce + "-close-a", increments: 1)
    let selectedA = try selectedMarkers()
    guard selectedA.count == 1 else { throw Failure.invalid("Closing requires one selected marker in UX Lab 1; run gestures first") }
    try switchHandle("right", to: 2)
    let beforeB = try state()
    let b = try seed(marker: "ios-" + nonce + "-close-b", increments: beforeB.counter + 2 == a.counter ? 3 : 2)
    try switchHandle("left", to: 1)
    record("seed-close-state", try state() == a && a.counter != b.counter && a.draft != b.draft,
           ["a": a.json, "b": b.json, "selectedA": selectedA])
    try openOverview(expected: [1, 2, 3])

    let scroller = try one(app.scrollViews, "overview scroll surface")
    let first = try overviewCard(1)
    let beforeY = first.frame.minY
    try overviewDrag(first, within: scroller, from: 0.78, to: 0.23, velocity: 250, name: "gentle-overview-scroll")
    try until("Overview list moved gently") { beforeY - first.frame.minY > 40 }
    record("gentle-overview-scroll", overviewIDs() == ["ux-lab-1", "ux-lab-2", "ux-lab-3"] && !closePromptVisible(),
           ["cardBeforeY": beforeY, "cardAfterY": first.frame.minY, "requestedVelocityPixelsPerSecond": 250])
    capture("gentle-overview-scroll")
    // A downward gesture cannot satisfy the upward-close classifier; return the first card into clear view.
    let gutter = CGPoint(x: scroller.frame.midX, y: scroller.frame.minY + scroller.frame.height * 0.25)
    try nativeDrag(in: scroller, start: gutter, end: CGPoint(x: gutter.x, y: scroller.frame.minY + scroller.frame.height * 0.8), velocity: 250, name: "restore-overview-scroll")
    try until("First card fully available for swipe") {
      first.frame.intersection(scroller.frame).height > first.frame.height * 0.9
    }
    try rapidCloseSwipe(1)
    try warning(for: 1)
    record("rapid-swipe-warning", closePromptVisible(), ["title": "Close UX Lab 1?", "warning": warningText])
    capture("unknown-state-warning")
    try nativeTap(one(app.buttons.matching(identifier: "close-keep-open"), "Keep open"), name: "keep-open")
    try overviewReady([1, 2, 3])
    try nativeTap(overviewCard(1), name: "return-to-kept-a")
    try focused(1)
    record("keep-open-retains-state", try state() == a && selectedMarkers() == selectedA,
           ["expected": a.json, "actual": try state().json, "expectedSelected": selectedA, "actualSelected": try selectedMarkers()])
    capture("kept-a-state")

    try openOverview(expected: [1, 2, 3])
    try rapidCloseSwipe(1)
    try warning(for: 1)
    try nativeTap(one(app.buttons.matching(identifier: "close-confirm"), "Close anyway"), name: "confirm-close-a")
    try overviewReady([2, 3])
    record("close-removes-only-target", overviewIDs() == ["ux-lab-2", "ux-lab-3"] && visibleLeaves().isEmpty,
           ["remainingCards": overviewIDs(), "removedCardExists": app.buttons.matching(identifier: "overview-card-ux-lab-1").firstMatch.exists])
    capture("a-closed-overview")
    try nativeTap(overviewCard(2), name: "return-to-retained-b")
    try focused(2)
    record("other-session-state-retained", try state() == b, ["expected": b.json, "actual": try state().json])
    capture("retained-b-state")
    try openOverview(expected: [2, 3])
    for number in [2, 3] {
      try nativeTap(one(app.buttons.matching(identifier: "overview-close-ux-lab-\(number)"), "visible close control"), name: "visible-close-\(number)")
      try warning(for: number)
      capture("close-warning-\(number)")
      try nativeTap(one(app.buttons.matching(identifier: "close-confirm"), "Close anyway"), name: "confirm-close-\(number)")
      try overviewReady(number == 2 ? [3] : [])
    }
    record("visible-close-controls", overviewIDs().isEmpty, ["remainingCards": overviewIDs()])
    record("quiet-empty-overview", try emptyOverview(), ["visibleLeafWebViews": visibleLeaves().count, "remainingCards": overviewIDs()])
    capture("quiet-empty-overview")
    for target in ["shell-settings", "overview-open", "empty-open-napplet"] {
      try nativeTap(one(app.buttons.matching(identifier: target), "empty overview entry point"), name: "empty-" + target)
      try until("Settings opened from empty overview") { self.app.buttons.matching(identifier: "settings-done").firstMatch.isHittable }
      capture("empty-settings-" + target)
      try nativeTap(one(app.buttons.matching(identifier: "settings-done"), "Settings Done"), name: "settings-done")
      try overviewReady([])
      guard try emptyOverview() else { throw Failure.invalid("Empty overview did not survive Settings roundtrip") }
    }
    record("empty-settings-and-open", try emptyOverview(), ["testedEntryPoints": ["shell-settings", "overview-open", "empty-open-napplet"]])
    capture("empty-after-settings")
    complete = true
  }

  private let warningText = "Unsaved work may be lost. Saved data will remain available when you open it again."
  private func selectedMarkers() throws -> [String] {
    let markers = try web().switches.matching(NSPredicate(format: "label BEGINSWITH %@", "Select marker ")).allElementsBoundByIndex
    guard markers.count == 10, markers.allSatisfy({ ["0", "1"].contains($0.value as? String ?? "") }) else { throw Failure.invalid("Marker selection is not observable") }
    return markers.filter { ($0.value as? String) == "1" }.map { $0.label }.sorted()
  }
  private func overviewIDs() -> [String] {
    app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "overview-card-")).allElementsBoundByIndex
      .filter { $0.exists }.map { String($0.identifier.dropFirst("overview-card-".count)) }.sorted()
  }
  private func overviewCard(_ number: Int) throws -> XCUIElement {
    try one(app.buttons.matching(identifier: "overview-card-ux-lab-\(number)"), "overview card \(number)")
  }
  private func overviewReady(_ numbers: [Int]) throws {
    let wanted = numbers.map { "ux-lab-\($0)" }.sorted()
    try until("Expected overview cards") {
      self.overviewIDs() == wanted && self.visibleLeaves().isEmpty && !self.closePromptVisible()
        && self.app.buttons.matching(identifier: "overview-open").firstMatch.exists
    }
  }
  private func openOverview(expected: [Int]) throws {
    try dismissKeyboard()
    try nativeTap(handle("right"), name: "open-overview")
    try overviewReady(expected)
  }
  private func closePromptVisible() -> Bool {
    let button = app.buttons.matching(identifier: "close-confirm").firstMatch
    return button.exists && button.isHittable
  }
  private func warning(for number: Int) throws {
    try until("Unknown-state warning for UX Lab \(number)") {
      self.closePromptVisible() && self.app.buttons.matching(identifier: "close-keep-open").firstMatch.isHittable
        && self.app.staticTexts.matching(NSPredicate(format: "label == %@", "Close UX Lab \(number)?")).firstMatch.exists
        && self.app.staticTexts.matching(NSPredicate(format: "label == %@", self.warningText)).firstMatch.exists
    }
  }
  private func rapidCloseSwipe(_ number: Int) throws {
    let scroller = try one(app.scrollViews, "overview scroll surface")
    try overviewDrag(overviewCard(number), within: scroller, from: 0.8, to: 0.35, velocity: 1500, name: "rapid-close-\(number)")
  }
  private func overviewDrag(_ card: XCUIElement, within scroller: XCUIElement, from: CGFloat, to: CGFloat, velocity: CGFloat, name: String) throws {
    let start = CGPoint(x: card.frame.midX, y: card.frame.minY + card.frame.height * from)
    let end = CGPoint(x: card.frame.midX, y: card.frame.minY + card.frame.height * to)
    guard card.frame.contains(start), card.frame.contains(end) else { throw Failure.invalid("Gesture outside observed card") }
    gestures.append(["name": name + "-target", "card": attributes(card)])
    try nativeDrag(in: scroller, start: start, end: end, velocity: velocity, name: name)
  }
  private func nativeDrag(in element: XCUIElement, start: CGPoint, end: CGPoint, velocity: CGFloat, name: String) throws {
    guard element.frame.contains(start), element.frame.contains(end) else { throw Failure.invalid("Gesture outside observed native surface") }
    gestures.append(["name": name, "input": "XCUICoordinate.press-and-drag", "start": pointJSON(start), "end": pointJSON(end),
                     "requestedVelocityPixelsPerSecond": velocity, "initialHoldSeconds": 0, "finalHoldSeconds": 0, "surface": attributes(element)])
    let origin = element.coordinate(withNormalizedOffset: .zero)
    origin.withOffset(CGVector(dx: start.x - element.frame.minX, dy: start.y - element.frame.minY)).press(forDuration: 0,
      thenDragTo: origin.withOffset(CGVector(dx: end.x - element.frame.minX, dy: end.y - element.frame.minY)),
      withVelocity: XCUIGestureVelocity(rawValue: velocity), thenHoldForDuration: 0)
  }
  private func nativeTap(_ element: XCUIElement, name: String) throws {
    let point = CGPoint(x: element.frame.midX, y: element.frame.midY)
    guard element.exists, element.isHittable, app.frame.contains(point) else { throw Failure.invalid("Native tap target is not visible") }
    gestures.append(["name": name, "input": "XCUICoordinate.tap", "point": pointJSON(point), "target": attributes(element)])
    element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
  }
  private func emptyOverview() throws -> Bool {
    let handles = app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "handle-left", "handle-right")).allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
    return overviewIDs().isEmpty && visibleLeaves().isEmpty && handles.isEmpty
      && app.staticTexts.matching(NSPredicate(format: "label == %@", "Nothing open")).firstMatch.exists
      && app.buttons.matching(identifier: "empty-open-napplet").firstMatch.isHittable
      && app.buttons.matching(identifier: "overview-open").firstMatch.isHittable
      && app.buttons.matching(identifier: "shell-settings").firstMatch.isHittable
  }

  private struct State: Equatable {
    let counter: Int
    let draft: String
    var json: [String: Any] { ["counter": counter, "draft": draft] }
  }
  private func state() throws -> State {
    let host = try web()
    let container = try one(host.otherElements.matching(NSPredicate(format: "label == %@", "Counter, application status")), "counter", visible: false)
    let values = container.staticTexts.allElementsBoundByIndex.compactMap { Int($0.label) }
    let draft = try one(host.textViews.matching(NSPredicate(format: "label == %@", "Your temporary note")), "draft", visible: false)
    guard values.count == 1, let value = draft.value as? String else { throw Failure.invalid("Unobservable counter/draft") }
    return State(counter: values[0], draft: value == placeholder ? "" : value)
  }
  private func seed(marker: String, increments: Int) throws -> State {
    try dismissKeyboard()
    let host = try web()
    let add = try one(host.buttons.matching(NSPredicate(format: "label == %@", "Add one")), "increment", visible: false)
    for _ in 0..<8 where !add.isHittable {
      try contentDrag(in: host, from: CGVector(dx: 0.5, dy: 0.25), to: CGVector(dx: 0.5, dy: 0.7), name: "reveal-counter")
    }
    guard add.isHittable else { throw Failure.invalid("Could not reveal counter input") }
    let before = try state()
    for _ in 0..<increments { add.tap() }
    let draft = try one(host.textViews.matching(NSPredicate(format: "label == %@", "Your temporary note")), "draft", visible: false)
    for _ in 0..<4 where !draft.isHittable {
      try contentDrag(in: host, from: CGVector(dx: 0.5, dy: 0.9), to: CGVector(dx: 0.5, dy: 0.45), name: "reveal-draft")
    }
    guard before.draft.count + marker.count < 2000 else { throw Failure.invalid("Draft capacity exceeded; existing text is not cleared") }
    try clearTap(draft, within: host, name: "focus-draft")
    draft.typeText(marker)
    try dismissKeyboard()
    let seeded = try state()
    guard seeded.counter == before.counter + increments, seeded.draft.contains(marker),
          seeded.draft.replacingOccurrences(of: marker, with: "") == before.draft
    else { throw Failure.invalid("Fixture input did not produce the expected counter/draft while preserving prior text") }
    capture("seed-" + marker.suffix(1))
    return seeded
  }
  private func dismissKeyboard() throws {
    if app.keyboards.count == 0 { return }
    let done = try one(app.toolbars.buttons.matching(NSPredicate(format: "label == %@", "Done")), "native input toolbar Done")
    observations["nativeKeyboardDismissedWithDone"] = true
    done.tap()
    try until("Native keyboard dismissed") { self.app.keyboards.count == 0 }
  }
  private func currentTitle() -> String { let title = app.staticTexts.matching(identifier: "focused-napplet-name").firstMatch; return title.exists ? title.label : "" }
  private func focused(_ number: Int) throws {
    try until("Focused UX Lab \(number) ready") {
      guard self.currentTitle() == "UX Lab \(number)" else { return false }
      let leaves = self.visibleLeaves()
      guard leaves.count == 1 else { return false }
      // Glass hides its connected-status label. Readiness requires the actual
      // focused guest tree, its ready marker and applied host theme.
      return leaves[0].staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Ready ·")).count == 1
        && leaves[0].staticTexts.matching(NSPredicate(format: "label == %@", "Host colors")).count == 1
    }
  }
  private func visibleLeaves() -> [XCUIElement] {
    app.webViews.allElementsBoundByIndex.filter { $0.exists && $0.isHittable && $0.descendants(matching: .webView).count == 0 }
  }
  private func web() throws -> XCUIElement {
    var found = visibleLeaves()
    // WK accessibility can expand its nested tree between enumeration and descendant queries after cold launch.
    if found.isEmpty {
      try until("Active WebView accessibility tree") {
        found = self.visibleLeaves()
        return !found.isEmpty
      }
    }
    guard found.count == 1 else { throw Failure.invalid("Expected one active leaf WebView, got \(found.count)") }
    return found[0]
  }
  private func publishedMarker(_ marker: String) -> Bool {
    app.webViews.allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
      .contains { $0.descendants(matching: .any).matching(NSPredicate(format: "label == %@", marker)).firstMatch.exists }
  }
  private func handle(_ side: String) throws -> XCUIElement { try one(app.buttons.matching(identifier: "handle-" + side), side + " handle") }
  private func switchHandle(_ side: String, to number: Int) throws {
    try dismissKeyboard()
    let host = try web()
    let grip = try handle(side)
    let start = CGPoint(x: grip.frame.midX, y: grip.frame.midY)
    let end = CGPoint(x: host.frame.midX, y: grip.frame.midY)
    try drag(in: host, start: start, end: end, name: "edge-" + side, avoidHandles: false)
    try focused(number)
    // A same-title end-stop must also finish its transition and remain out of overview.
    try until("Handles restored") { self.app.buttons.matching(identifier: "handle-" + side).firstMatch.isHittable }
  }
  private func clearTap(_ element: XCUIElement, within host: XCUIElement, name: String) throws {
    let point = CGPoint(x: element.frame.midX, y: element.frame.midY)
    try verifyClear(point, within: host)
    gestures.append(["name": name, "input": "XCUICoordinate.tap", "point": pointJSON(point), "element": attributes(element), "handles": handleAttributes()])
    element.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
  }
  private func contentDrag(in host: XCUIElement, from start: CGVector, to end: CGVector, name: String) throws {
    try drag(in: host, start: CGPoint(x: host.frame.minX + host.frame.width * start.dx, y: host.frame.minY + host.frame.height * start.dy),
             end: CGPoint(x: host.frame.minX + host.frame.width * end.dx, y: host.frame.minY + host.frame.height * end.dy), name: name, avoidHandles: true)
  }
  private func drag(in host: XCUIElement, start: CGPoint, end: CGPoint, name: String, avoidHandles: Bool) throws {
    guard host.frame.contains(start), host.frame.contains(end) else { throw Failure.invalid("Gesture point outside observed host") }
    if avoidHandles { try verifyClear(start, within: host); try verifyClear(end, within: host) }
    let origin = host.coordinate(withNormalizedOffset: .zero)
    gestures.append(["name": name, "input": "XCUICoordinate.press-and-drag", "start": pointJSON(start), "end": pointJSON(end), "host": attributes(host), "handles": handleAttributes()])
    origin.withOffset(CGVector(dx: start.x - host.frame.minX, dy: start.y - host.frame.minY)).press(forDuration: 0.05,
      thenDragTo: origin.withOffset(CGVector(dx: end.x - host.frame.minX, dy: end.y - host.frame.minY)), withVelocity: .slow, thenHoldForDuration: 0.05)
  }
  private func verifyClear(_ point: CGPoint, within host: XCUIElement) throws {
    let grips = try [handle("left"), handle("right")]
    guard host.frame.contains(point), !grips.contains(where: { $0.frame.contains(point) }),
          !app.keyboards.allElementsBoundByIndex.contains(where: { $0.exists && $0.frame.contains(point) }) else { throw Failure.invalid("No clear gesture point away from handles/keyboard") }
  }
  private func handleAttributes() -> [[String: Any]] { app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "handle-left", "handle-right")).allElementsBoundByIndex.filter { $0.exists }.map(attributes) }
  private func pointJSON(_ point: CGPoint) -> [String: Double] { ["x": point.x, "y": point.y] }
  private func one(_ query: XCUIElementQuery, _ description: String, visible: Bool = true) throws -> XCUIElement {
    let found = query.allElementsBoundByIndex.filter { $0.exists && (!visible || $0.isHittable) }
    guard found.count == 1 else { throw Failure.invalid("\(description): expected one element, observed \(found.count)") }
    return found[0]
  }
  private func until(_ description: String, timeout: TimeInterval = 10, _ condition: () -> Bool) throws {
    let deadline = Date().addingTimeInterval(timeout)
    repeat { if condition() { return }; RunLoop.current.run(until: Date().addingTimeInterval(0.2)) } while Date() < deadline
    throw Failure.invalid("Timed out: " + description)
  }
  private func record(_ name: String, _ passed: Bool, _ detail: [String: Any]) {
    checks.append(["name": name, "passed": passed, "details": detail])
    XCTAssertTrue(passed, name)
  }
  private func attributes(_ element: XCUIElement) -> [String: Any] {
    ["identifier": element.identifier, "label": element.label, "value": element.value as Any? ?? NSNull(), "hittable": element.isHittable,
     "bounds": ["x": element.frame.minX, "y": element.frame.minY, "width": element.frame.width, "height": element.frame.height]]
  }
  private func capture(_ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name + ".png"; shot.lifetime = .keepAlways; add(shot)
    let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-hierarchy.txt"; tree.lifetime = .keepAlways; add(tree)
  }
  private func attach(_ json: [String: Any], _ name: String) {
    do {
      let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
      attachment.name = name + ".json"; attachment.lifetime = .keepAlways; add(attachment)
    } catch { XCTFail("Could not serialize workspace evidence: \(error)") }
  }
  private enum Failure: Error { case invalid(String) }
}
