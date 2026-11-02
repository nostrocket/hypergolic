import Foundation
import UIKit
import WebKit
import XCTest
@testable import BoundaryProbe

/// Privileged native test instrumentation. No handler or observer is exported by Expo.
@MainActor
final class Probe: NSObject, WKScriptMessageHandler {
  let session = "probe-" + UUID().uuidString.lowercased()
  let nonce = UUID().uuidString.lowercased()
  let world = WKContentWorld.world(name: "org.nostrocket.hypergolic.boundary-observer.v1")
  let diagnosticWorld = WKContentWorld.world(name: "org.nostrocket.hypergolic.diagnostics.v1")
  private(set) var host: RestrictedNappletHost!
  private(set) var webView: WKWebView?
  private(set) var main: WKFrameInfo?
  private(set) var guest: WKFrameInfo?
  private(set) var events: [[String: Any]] = []
  private(set) var frames: [[String: Any]] = []
  var observations: [[String: Any]] = []

  override init() {
    super.init()
    host = RestrictedNappletHost { [weak self] view in self?.observe(view) }
    host.onEvent = { [weak self] event in self?.events.append(event) }
  }

  private func observe(_ view: WKWebView) {
    precondition(webView == nil, "Each probe owns exactly one native generation")
    webView = view
    let controller = view.configuration.userContentController
    controller.add(self, contentWorld: world, name: "BoundaryObserver")
    // A distinct world records real WKFrameInfo; it cannot see page globals.
    let script = """
      (() => {
        const report = () => window.webkit.messageHandlers.BoundaryObserver.postMessage({nonce:'\(nonce)', href:location.href});
        if (document.readyState === 'loading') addEventListener('DOMContentLoaded', report, {once:true});
        else report();
      })();
      """
    controller.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart,
      forMainFrameOnly: false, in: world))
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard message.name == "BoundaryObserver", message.world.name == world.name,
      message.webView === webView, message.frameInfo.webView === webView,
      let body = message.body as? [String: String], body["nonce"] == nonce else { return }
    let frame = message.frameInfo
    let url = frame.request.url?.absoluteString ?? ""
    frames.append(["main": frame.isMainFrame, "requestURL": url, "reportedURL": body["href"] ?? "",
      "world": message.world.name ?? "", "originProtocol": frame.securityOrigin.protocol,
      "originHost": frame.securityOrigin.host, "originPort": frame.securityOrigin.port])
    if frame.isMainFrame { main = frame }
    else if url == "about:srcdoc" { guest = frame }
  }

  func start(_ id: String? = nil, configuration: String? = nil) throws {
    let app = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
    let container = try XCTUnwrap(app.window?.rootViewController?.view)
    host.frame = container.bounds
    container.addSubview(host)
    if let configuration { host.startConfiguredSession(configuration) }
    else { host.startSession(id ?? session) }
  }

  func startPublished(_ raw: String) throws {
    let app = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
    let container = try XCTUnwrap(app.window?.rootViewController?.view)
    host.frame = container.bounds
    container.addSubview(host)
    host.startPublishedArtifact(raw)
    host.setActive(true)
  }

  func ready(configuration: String? = nil) async throws {
    try start(configuration: configuration)
    try await until("genuine native ready plus real main/guest frames") {
      self.events.contains { $0["type"] as? String == "ready" } && self.main != nil && self.guest != nil
    }
    XCTAssertEqual(events.count, 1, "A bootstrap error must not be hidden by eventual readiness")
    XCTAssertEqual(events.first?["sessionId"] as? String, session)
    XCTAssertEqual(frames.filter { $0["requestURL"] as? String == "about:srcdoc" }.count, 1)
    let themeDeadline = Date().addingTimeInterval(3)
    while true {
      let value = try await json("return {ready:document.querySelector('[data-testid=lab]')?.dataset.ready,theme:document.getElementById('theme-status')?.textContent};", frame: guest)
      if value["ready"] as? String == "true" && value["theme"] as? String == "Host colors" { break }
      if Date() >= themeDeadline { throw ProbeError.timedOut("genuine SDK theme response") }
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  var generation: String {
    get throws {
      let url = try XCTUnwrap(webView?.url)
      return try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "sessionId" })?.value)
    }
  }

  func json(_ body: String, frame: WKFrameInfo?, world: WKContentWorld = .page) async throws -> [String: Any] {
    let view = try XCTUnwrap(webView)
    let text: String = try await withCheckedThrowingContinuation { continuation in
      view.callAsyncJavaScript("return JSON.stringify(await (async () => {\n" + body + "\n})());",
        arguments: [:], in: frame, in: world) { result in
          switch result {
          case .success(let value):
            guard let text = value as? String else {
              continuation.resume(throwing: ProbeError.invalidResult); return
            }
            continuation.resume(returning: text)
          case .failure(let error): continuation.resume(throwing: error)
          }
        }
    }
    guard let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
      throw ProbeError.invalidResult
    }
    observations.append(["world": world.name ?? "page", "frameMain": frame?.isMainFrame ?? true, "result": value])
    return value
  }

  func diagnostic(_ value: Any, frame: WKFrameInfo?, world: WKContentWorld? = nil) async throws -> [String: Any] {
    let data = try JSONSerialization.data(withJSONObject: [value], options: [.fragmentsAllowed])
    let encoded = String(decoding: data, as: UTF8.self)
    return try await json("""
      const value = \(encoded)[0];
      try { await window.webkit.messageHandlers.HypergolicDiagnostic.postMessage(value); return {accepted:true}; }
      catch(error) { return {accepted:false,error:String(error)}; }
      """, frame: frame, world: world ?? diagnosticWorld)
  }

  func barrier() async throws {
    let value = try await json("""
      const id = 'barrier-' + crypto.randomUUID();
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Theme barrier timed out')), 2000);
        const listener = event => {
          if(event.source !== parent || event.data?.id !== id) return;
          clearTimeout(timeout); removeEventListener('message',listener);
          if(event.data.type !== 'theme.get.result') {reject(new Error('Theme barrier received a denial'));return;}
          resolve({received:true,type:event.data.type,colors:event.data.theme?.colors});
        };
        addEventListener('message',listener); parent.postMessage({type:'theme.get',id},'*');
      });
      """, frame: guest)
    XCTAssertEqual(value["received"] as? Bool, true)
    XCTAssertEqual(value["type"] as? String, "theme.get.result")
    XCTAssertEqual(value["colors"] as? [String: String], ["background":"#140f0b","text":"#f3efeb","primary":"#e8805d"])
    XCTAssertEqual(events.count, 1)
  }

  func until(_ description: String, timeout: TimeInterval = 15, _ predicate: @MainActor () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !predicate() {
      if Date() >= deadline { throw ProbeError.timedOut(description) }
      try await Task.sleep(for: .milliseconds(20))
    }
  }

  func close() {
    host.destroySession()
    host.removeFromSuperview()
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "BoundaryObserver", contentWorld: world)
  }

  func attach(to test: XCTestCase, name: String) throws {
    // Invalid-session tests intentionally have no WKView/URL. Recording that absence must not assert.
    let observedGeneration = webView?.url.flatMap { URLComponents(url:$0,resolvingAgainstBaseURL:false) }?
      .queryItems?.first(where: { $0.name == "sessionId" })?.value
    let receipt: [String: Any] = ["schema":1,"test":name,"session":session,"nativeGeneration":observedGeneration ?? "",
      "instrumentation":"privileged native frame-scoped callAsyncJavaScript; no fabricated frame or message",
      "frames":frames,"events":events,"observations":observations]
    let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: receipt, options: [.prettyPrinted,.sortedKeys]), uniformTypeIdentifier: "public.json")
    attachment.name = name + ".json"
    attachment.lifetime = .keepAlways
    test.add(attachment)
  }
}

enum ProbeError: Error { case invalidResult, timedOut(String) }
