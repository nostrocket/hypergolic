import CoreGraphics
import Foundation
import XCTest

@MainActor
final class HostTraceTests: XCTestCase {
  private var app: XCUIApplication!
  private var checks: [[String: Any]] = []
  private var observations: [String: Any] = [:]
  private var completed = false

  override func setUpWithError() throws {
    continueAfterFailure = true
    let environment = ProcessInfo.processInfo.environment
    guard environment["HG_SCENARIO"] == "trace-host",
          let bundle = environment["HG_TARGET_BUNDLE_ID"], !bundle.isEmpty,
          let nonce = environment["HG_NONCE"], nonce.range(of: "^[a-z0-9]{12}$", options: .regularExpression) != nil
    else { throw TraceError.invalidConfiguration }
    app = XCUIApplication(bundleIdentifier: bundle)
    observations["bundleIdentifier"] = bundle
    observations["nonce"] = nonce
    observations["appStateBeforeActivate"] = app.state.rawValue
    // Public activation preserves an already-running instance. No launch arguments or app environment.
    app.activate()
  }

  override func tearDownWithError() throws {
    if app != nil { capture("final") }
    attachJSON([
      "kind": "hypergolic-ios-trace-v1", "scenario": "trace-host",
      "completed": completed, "checks": checks, "observations": observations,
      "allChecksPassed": completed && checks.count == 5 && checks.allSatisfy { $0["passed"] as? Bool == true },
      "proofScope": "Public XCTest input and accessibility on the installed iOS app; no JavaScript evaluation or native security claim."
    ], name: "trace-report")
  }

  func testHostTrace() throws {
    let environment = ProcessInfo.processInfo.environment
    let title = environment["HG_EXPECTED_TITLE"] ?? "UX Lab 1"
    let session = environment["HG_EXPECTED_SESSION"] ?? "ux-lab-1"
    let timeout = Double(environment["HG_TIMEOUT"] ?? "30") ?? 30
    let header = app.staticTexts.matching(identifier: "focused-napplet-name")
    let status = app.staticTexts.matching(identifier: "runtime-status-" + session)
    try waitUntil(timeout, description: "Focused native fixture header and runtime diagnostic") {
      self.visible(header).count == 1 && self.visible(header).first?.label == title &&
      self.visible(status).count == 1 && self.visible(status).first?.label == "Runtime connected"
    }
    record("native-runtime-ready", true, ["title": title, "session": session, "label": "Runtime connected"])
    capture("native-ready")

    let candidates = app.webViews.allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
    observations["hittableWebViews"] = candidates.map { element -> [String: Any] in
      var observation = attributes(element)
      observation["descendantWebViews"] = element.descendants(matching: .webView).count
      return observation
    }
    // WK exposes three nested WebView AX nodes on the observed iOS runtime. Use
    // actual descendants to select the unique leaf; multiple live siblings fail.
    let leaves = candidates.filter { $0.descendants(matching: .webView).count == 0 }
    guard leaves.count == 1 else { throw TraceError.ambiguous("Expected one active leaf WebView; observed \(leaves.count) among \(candidates.count) WebView nodes") }
    let web = leaves[0]
    let ready = web.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", "Ready ·"))
    let theme = web.staticTexts.matching(NSPredicate(format: "label == %@", "Host colors"))
    try waitUntil(timeout, description: "Actual fixture ready and host theme reply") {
      self.visible(ready).count == 1 && self.visible(theme).count == 1
    }
    record("fixture-ready-and-theme", true, ["ready": visible(ready)[0].label, "theme": visible(theme)[0].label])

    let counterQuery = web.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR label == %@ OR label == %@", "counter", "Counter", "Counter, application status"))
    let incrementQuery = web.buttons.matching(NSPredicate(format: "identifier == %@ OR label == %@", "increment", "Add one"))
    let increment = try uniqueVisible(incrementQuery, description: "Add one button")
    let countersBefore = visible(counterQuery)
    let countBefore = countersBefore.count == 1 ? numericCounter(countersBefore[0]) : nil
    observations["counterBeforeElements"] = countersBefore.map(attributes)
    increment.tap()
    var countAfter: Int?
    if let before = countBefore {
      _ = poll(5) {
        let current = self.visible(counterQuery)
        countAfter = current.count == 1 ? self.numericCounter(current[0]) : nil
        return countAfter == before + 1
      }
    }
    observations["counterAfterElements"] = visible(counterQuery).map(attributes)
    record("counter-input-and-delta", countBefore != nil && countAfter == countBefore.map { $0 + 1 }, [
      "before": countBefore as Any? ?? NSNull(), "after": countAfter as Any? ?? NSNull(),
      "input": "XCUIElement.tap", "limitation": "A missing numeric accessibility value fails; unrelated visible numbers and DOM guesses are never used."
    ])
    capture("after-counter")

    let drafts = web.textViews.matching(NSPredicate(format: "identifier == %@ OR label == %@ OR placeholderValue == %@", "draft", "Your temporary note", "Something you will recognise…"))
    var draftCandidates = visible(drafts)
    // Bounded real scrolling may bring the observed fixture's input into view.
    for _ in 0..<3 where draftCandidates.isEmpty {
      web.swipeUp(velocity: .slow)
      draftCandidates = visible(drafts)
    }
    guard draftCandidates.count == 1 else { throw TraceError.ambiguous("Expected one visible fixture textarea; observed \(draftCandidates.count)") }
    let draft = draftCandidates[0]
    let marker = "ios-" + (environment["HG_NONCE"] ?? "invalid")
    let initialValue = (draft.value as? String) ?? ""
    guard initialValue.count + marker.count < 2000 else { throw TraceError.ambiguous("Fixture draft has insufficient remaining capacity; it was not cleared") }
    let draftFrame = draft.frame
    let focusPoint = CGPoint(x: draftFrame.midX, y: draftFrame.midY)
    let handles = app.buttons.matching(NSPredicate(format: "identifier == %@ OR identifier == %@", "handle-left", "handle-right")).allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
    let keyboards = app.keyboards.allElementsBoundByIndex.filter { $0.exists }
    observations["draftFocus"] = [
      "method": "XCUICoordinate.tap at observed textarea center", "textarea": attributes(draft),
      "point": ["x": focusPoint.x, "y": focusPoint.y], "handles": handles.map(attributes), "keyboards": keyboards.map(attributes),
    ]
    guard draftFrame.width > 0, draftFrame.height > 0, web.frame.contains(focusPoint),
          handles.count == 2, Set(handles.map(\.identifier)) == Set(["handle-left", "handle-right"]),
          !handles.contains(where: { $0.frame.contains(focusPoint) }),
          !keyboards.contains(where: { $0.frame.contains(focusPoint) })
    else { throw TraceError.ambiguous("Textarea center is not visibly inside the WebView and clear of observed shell handles; no focus tap was attempted") }
    draft.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    capture("after-draft-focus")
    guard draft.exists else { throw TraceError.ambiguous("Textarea disappeared after its recorded interior focus tap") }
    draft.typeText(marker)
    var typedValue = ""
    let typed = poll(5) {
      typedValue = (draft.value as? String) ?? ""
      return typedValue.contains(marker)
    }
    observations["keyboardVisibleAfterTyping"] = app.keyboards.count > 0
    record("native-text-input", typed, ["input": "XCUIElement.typeText", "marker": marker, "value": typedValue])
    capture("after-typing")

    // Exact rendered mirror must be a separate static text, never the editable textarea.
    func visibleMirrors() -> [XCUIElement] {
      // WK exposes typed textarea contents as nested static text too. Exclude
      // those observed input bounds; the mirror must be a separate visible node.
      web.staticTexts.matching(NSPredicate(format: "label == %@", typedValue)).allElementsBoundByIndex.filter {
        $0.exists && $0.isHittable && !$0.frame.intersects(draft.frame)
      }
    }
    var mirrors = visibleMirrors()
    for _ in 0..<2 where typed && mirrors.isEmpty {
      web.swipeUp(velocity: .slow)
      mirrors = visibleMirrors()
    }
    record("typed-rendered-mirror", typed && mirrors.count == 1, ["text": typedValue, "visibleMatchingStaticTexts": mirrors.count])
    capture("typed-mirror")
    completed = true
  }

  private func numericCounter(_ element: XCUIElement) -> Int? {
    if let value = element.value as? String, let number = Int(value.trimmingCharacters(in: .whitespacesAndNewlines)) { return number }
    if let number = Int(element.label.trimmingCharacters(in: .whitespacesAndNewlines)) { return number }
    let numbers = element.descendants(matching: .staticText).allElementsBoundByIndex.compactMap { Int($0.label.trimmingCharacters(in: .whitespacesAndNewlines)) }
    return numbers.count == 1 ? numbers[0] : nil
  }
  private func visible(_ query: XCUIElementQuery) -> [XCUIElement] {
    query.allElementsBoundByIndex.filter { $0.exists && $0.isHittable }
  }
  private func uniqueVisible(_ query: XCUIElementQuery, description: String) throws -> XCUIElement {
    let found = visible(query)
    guard found.count == 1 else { throw TraceError.ambiguous("\(description): found \(found.count) visible matches") }
    return found[0]
  }
  private func poll(_ timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    repeat {
      if condition() { return true }
      RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    } while Date() < end
    return false
  }
  private func waitUntil(_ timeout: TimeInterval, description: String, _ condition: () -> Bool) throws {
    guard poll(timeout, condition) else { throw TraceError.ambiguous("Timed out: " + description) }
  }
  private func record(_ name: String, _ passed: Bool, _ details: [String: Any]) {
    checks.append(["name": name, "passed": passed, "details": details])
    if !passed { XCTFail(name + ": " + String(describing: details)) }
  }
  private func attributes(_ element: XCUIElement) -> [String: Any] {
    ["identifier": element.identifier, "label": element.label, "value": element.value as Any? ?? NSNull(), "type": element.elementType.rawValue, "frame": String(describing: element.frame), "bounds": ["x": element.frame.minX, "y": element.frame.minY, "width": element.frame.width, "height": element.frame.height], "hittable": element.isHittable]
  }
  private func snapshotObject(_ node: XCUIElementSnapshot, budget: inout Int) -> [String: Any] {
    guard budget > 0 else { return ["truncated": true] }
    budget -= 1
    return ["identifier": node.identifier, "label": node.label, "value": node.value as Any? ?? NSNull(), "type": node.elementType.rawValue, "frame": String(describing: node.frame), "children": node.children.map { snapshotObject($0, budget: &budget) }]
  }
  private func capture(_ name: String) {
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = name + ".png"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    let debug = XCTAttachment(string: app.debugDescription)
    debug.name = name + "-hierarchy.txt"
    debug.lifetime = .keepAlways
    add(debug) // Debug text is evidence only; queries never parse its unsupported format.
    do {
      var budget = 10000
      let tree = snapshotObject(try app.snapshot(), budget: &budget)
      attachJSON(["kind": "xcui-public-snapshot", "tree": tree], name: name + "-hierarchy")
    } catch { attachJSON(["snapshotError": String(describing: error)], name: name + "-snapshot-error") }
  }
  private func attachJSON(_ object: [String: Any], name: String) {
    do {
      let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
      attachment.name = name + ".json"
      attachment.lifetime = .keepAlways
      add(attachment)
    } catch { XCTFail("Could not serialize evidence \(name): \(error)") }
  }
  private enum TraceError: Error { case invalidConfiguration; case ambiguous(String) }
}
