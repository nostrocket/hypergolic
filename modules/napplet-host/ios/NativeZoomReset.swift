import UIKit
import WebKit
import CoreFoundation

/// App-owned view command only; no guest message or automatic focus behavior.
@MainActor enum NativeZoomReset {
  struct Request {let sessionId: String; let generation: String; let sequence: Int}
  static func accept(_ raw: String, sessionId: String?, generation: String, lastSequence: inout Int,
    interruptedAt: TimeInterval, now: Double = Date().timeIntervalSince1970 * 1_000,
    uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Request? {
    guard raw.utf8.count <= 320, let data = raw.data(using: .utf8),
      let row = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(row.keys) == ["sessionId", "generation", "sequence", "issuedAt"],
      let requestedSession = row["sessionId"] as? String, requestedSession == sessionId,
      let requestedGeneration = row["generation"] as? String, requestedGeneration == generation,
      let sequence = row["sequence"] as? NSNumber, CFGetTypeID(sequence) != CFBooleanGetTypeID(),
      sequence.doubleValue.isFinite, sequence.doubleValue.rounded(.towardZero) == sequence.doubleValue,
      sequence.doubleValue > Double(lastSequence), sequence.doubleValue <= 9_007_199_254_740_991,
      let issued = row["issuedAt"] as? NSNumber, CFGetTypeID(issued) != CFBooleanGetTypeID(),
      issued.doubleValue.isFinite, issued.doubleValue.rounded(.towardZero) == issued.doubleValue,
      issued.doubleValue >= 0, issued.doubleValue <= 9_007_199_254_740_991,
      now >= issued.doubleValue, now - issued.doubleValue <= 1_000,
      uptime - (now - issued.doubleValue) / 1_000 >= interruptedAt else { return nil }
    lastSequence = sequence.intValue
    return Request(sessionId: requestedSession, generation: requestedGeneration, sequence: lastSequence)
  }

  struct Context {
    let sessionId: String?
    let generation: String
    let expectedURL: URL?
    let live: Bool
    let ready: Bool
    let loaded: Bool
    let disposed: Bool
    let active: Bool
    let foreground: Bool
  }

  static func reset(_ view: WKWebView, sessionId: String, generation: String, context: Context) -> Bool {
    guard !sessionId.isEmpty, !generation.isEmpty, sessionId.utf8.count <= 80, generation.utf8.count <= 80,
      sessionId == context.sessionId, generation == context.generation,
      context.live, context.ready, context.loaded, !context.disposed, context.active, context.foreground,
      let expectedURL = context.expectedURL, view.url?.absoluteString == expectedURL.absoluteString,
      view.superview != nil, view.window != nil else { return false }
    let minimum = view.scrollView.minimumZoomScale
    guard minimum.isFinite, minimum > 0 else { return false }
    // Preserve pinch, maximum scale, text preferences and the guest document.
    view.scrollView.setZoomScale(minimum, animated: !UIAccessibility.isReduceMotionEnabled)
    return true
  }
}
