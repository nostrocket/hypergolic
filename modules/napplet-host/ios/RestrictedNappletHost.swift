import CoreFoundation
import CryptoKit
import UIKit
import WebKit

/// One native generation, one bundled host, one opaque napplet frame.
/// The iOS 18.4 deployment candidate enables public file-picker denial.
@MainActor
final class RestrictedNappletHost: UIView, WKNavigationDelegate, WKUIDelegate {
  var onEvent: (@MainActor ([String: Any]) -> Void)?
  // Native-only observation, absent in production. Never exposed through Expo.
  private let onWebViewCreated: (@MainActor (WKWebView) -> Void)?
  private let generation = UUID().uuidString.lowercased()
  private let bridgeWorld = WKContentWorld.world(name: "org.nostrocket.hypergolic.diagnostics.v1")
  private let bridgeName = "HypergolicDiagnostic"
  private var configuration: CapabilityConfiguration?
  private var configurationSource: String?
  private var publishedSource: String?
  private var publishedReader: PublishedArtifactReadOwner?
  private var sessionId: String?
  private var expectedURL: URL?
  private var webView: WKWebView?
  private var receiver: DiagnosticReceiver?
  private var deadline: DispatchWorkItem?
  private var live = false
  private var closeCheckId: String?
  private var closeCheckDeadline: TimeInterval = 0
  private var pendingNativeReplies: [String: TimeInterval] = [:]
  private var closeUnsafeUntil: TimeInterval = 0
  private var ready = false
  private var loaded = false
  private var initialNavigationAllowed = false
  private var disposed = false
#if HYPERGOLIC_NETWORK_PROOF
  private var pickerFaultProof: String?
#endif
  // A newly mounted hidden host cannot claim focus before the trusted active prop.
  private var active = false
  private lazy var selectedFilePicker = SelectedFilePicker(live: { [weak self] in self?.maySelectFile() == true })
  private func maySelectFile() -> Bool {
    live && ready && loaded && !disposed && active && configuration?.domains.contains("upload") == true && UploadTransport.leases.isRegistered(generation)
  }

  init(onWebViewCreated: (@MainActor (WKWebView) -> Void)? = nil) {
    self.onWebViewCreated = onWebViewCreated
    super.init(frame: .zero)
    NotificationCenter.default.addObserver(self, selector: #selector(mediaBackground), name: UIApplication.willResignActiveNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(mediaForeground), name: UIApplication.didBecomeActiveNotification, object: nil)
    clipsToBounds = true
    backgroundColor = UIColor(red: 18/255, green: 14/255, blue: 10/255, alpha: 1)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("Use init(onWebViewCreated:)") }

  override func layoutSubviews() {
    super.layoutSubviews()
    webView?.frame = bounds
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    // Loaded napplets must stay mounted when merely backgrounded/overviewed.
    // Actual unmount is destruction; this view is never recycled as a new session.
    if superview != nil && newSuperview == nil { destroySession() }
    super.willMove(toSuperview: newSuperview)
  }

  func setCloseCheck(_ raw: String) {
    closeCheckId = nil
    guard live, ready, loaded, !disposed, UIApplication.shared.applicationState == .active,
      raw.utf8.count <= 256, let data = raw.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: String],
      Set(value.keys) == ["id", "generation"], value["generation"] == generation,
      let id = value["id"], id.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
      let view = webView, let expectedURL, view.url == expectedURL else { return }
    closeCheckId = id
    closeCheckDeadline = ProcessInfo.processInfo.systemUptime + 0.5
    let script = "if(location.href===" + jsString(expectedURL.absoluteString) + "){window.postMessage({type:'hypergolic.close-check.request',id:" + jsString(id) + "},'*')}"
    view.evaluateJavaScript(script, completionHandler: nil)
  }

  private func receiveCloseCheck(_ value: [String: Any]) {
    guard ready, UIApplication.shared.applicationState == .active,
      Set(value.keys) == ["type", "sessionId", "id", "state"],
      let id = value["id"] as? String, id == closeCheckId,
      ProcessInfo.processInfo.systemUptime < closeCheckDeadline,
      let state = value["state"] as? String, ["clean", "dirty", "unknown"].contains(state) else { return }
    closeCheckId = nil
    let now = ProcessInfo.processInfo.systemUptime
    pendingNativeReplies = pendingNativeReplies.filter { $0.value > now }
    let guarded = state == "clean" && (!pendingNativeReplies.isEmpty || closeUnsafeUntil > now) ? "dirty" : state
    onEvent?(["type": "close-check", "sessionId": sessionId ?? "", "generation": generation, "id": id, "state": guarded])
  }

  func setActive(_ isActive: Bool) {
    guard active != isActive else { return }
    active = isActive
    if !isActive {selectedFilePicker.cancel()}
    updateMediaPlayback()
    if configuration != nil { ApprovalTransport.setFocused(generation, active: isActive); UploadTransport.focus(generation, active: isActive); LinkTransport.focus(generation, isActive); RoutingTransport.shared.focus(generation, isActive) }
    // Dismiss only this retained view's editor; keep its loaded document and position.
    if !isActive { webView?.endEditing(true) }
  }

  @objc private func mediaBackground() { closeCheckId = nil; selectedFilePicker.background(); updateMediaPlayback(foreground: false) }
  @objc private func mediaForeground() { updateMediaPlayback(foreground: true) }
  private func updateMediaPlayback(foreground: Bool? = nil) {
    guard let view = webView, !disposed else { return }
    let allowed = active && (foreground ?? (UIApplication.shared.applicationState == .active))
    if loaded { view.evaluateJavaScript("window.__hypergolicMediaActive?.(\(allowed))", completionHandler: nil) }
    if !allowed { view.setAllMediaPlaybackSuspended(true, completionHandler: nil) }
    else {
      // Pause first: lifting suspension must not resume the old player automatically.
      view.pauseAllMediaPlayback { [weak self, weak view] in
        guard let self, let view, !self.disposed, self.active,
          UIApplication.shared.applicationState == .active else { return }
        view.setAllMediaPlaybackSuspended(false, completionHandler: nil)
      }
    }
  }

  /// Compile-gated fault injection into the actual captured native host lifetime.
  func armPickerFaultProof(_ action: String) {
#if HYPERGOLIC_NETWORK_PROOF
    pickerFaultProof = ["close", "replace", "identity", "renderer"].contains(action) ? action : nil
#endif
  }
  private func schedulePickerFaultProof() {
#if HYPERGOLIC_NETWORK_PROOF
    guard let action = pickerFaultProof else {return}; pickerFaultProof = nil
    scheduleHostFaultProof(action, delay: 12)
#endif
  }
  func armUploadFaultProof(_ action: String) {
#if HYPERGOLIC_NETWORK_PROOF
    guard ["close", "replace", "identity", "renderer"].contains(action) else {return}
    scheduleHostFaultProof(action, delay: 2)
#endif
  }
  private func scheduleHostFaultProof(_ action: String, delay: Int) {
#if HYPERGOLIC_NETWORK_PROOF
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard let self, !self.disposed, self.live else {return}
      if action == "close" {self.fail("proof-close"); return}
      if action == "renderer" {
#if targetEnvironment(simulator)
        // Upstream WebKit test SPI; compiled only in isolated Simulator proof products.
        // Invoke the actual process termination, never the termination delegate directly.
        let selector = NSSelectorFromString("_killWebContentProcess")
        guard let view = self.webView, view.responds(to: selector) else {self.fail("proof-renderer-unavailable"); return}
        _ = view.perform(selector)
#else
        self.fail("proof-renderer-unavailable")
#endif
        return
      }
      guard let raw = self.configurationSource, var next = try? UploadWire.object(raw) else {return}
      if action == "replace" {next["epoch"] = (next["epoch"] as? Int ?? 0) + 1}
      else {next["user"] = "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"}
      guard let encoded = try? UploadWire.json(next) else {return}
      self.startConfiguredSession(encoded)
    }
#endif
  }

  func startConfiguredSession(_ raw: String) {
    guard !disposed else { return }
    if sessionId != nil {
      guard raw != configurationSource else { return }
      fail("session-reuse-blocked"); return
    }
    do { configuration = try CapabilityConfiguration(raw, generation: generation) }
    catch { fail("invalid-session"); return }
    configurationSource = raw
    startSession(configuration!.sessionId)
  }

  func startPublishedArtifact(_ raw: String) {
    guard !disposed else { return }
    if sessionId != nil {
      guard raw == publishedSource else { fail("session-reuse-blocked"); return }
      return
    }
    guard let input = PublishedArtifactHostInput(raw) else { fail("invalid-published-artifact"); return }
    let publishedConfiguration: CapabilityConfiguration?
    if let rawConfiguration = input.configuration {
      guard let parsed = try? CapabilityConfiguration(rawConfiguration, generation: generation),
        parsed.matchesPublishedClaims(sessionId: input.claims.sessionId,
          publisher: input.claims.publisher, appId: input.claims.identifier,
          version: input.claims.aggregateHash) else {
        fail("invalid-published-configuration"); return
      }
      publishedConfiguration = parsed
    } else {
      publishedConfiguration = nil
    }
    guard let claimed = PublishedArtifactTransfer.shared.registry.claim(
      input.handle, claims: input.claims, viewGeneration: generation) else {
      sessionId = input.claims.sessionId
      fail("artifact-claim-denied")
      return
    }
    configuration = publishedConfiguration
    configurationSource = input.configuration
    publishedReader = PublishedArtifactReadOwner(claimed: claimed,
      domains: publishedConfiguration?.domains ?? ["theme"])
    publishedSource = raw
    // Loaded verified read views survive suspension. Native stream/approval/transfer
    // owners independently stop network work and sensitive authority on inactivity.
    startSession(input.claims.sessionId)
  }

  func startSession(_ id: String) {
    guard !disposed else { return }
    if sessionId == id { return }
    guard sessionId == nil else { fail("session-reuse-blocked"); return }
    sessionId = id
    guard id.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil else {
      fail("invalid-session"); return
    }
    do {
      let assets = try verifiedAssets()
      var components = URLComponents(url: assets.index, resolvingAgainstBaseURL: false)!
      components.queryItems = [URLQueryItem(name: "sessionId", value: generation)]
      if publishedReader != nil {
        components.queryItems?.append(URLQueryItem(name: "source", value: "published"))
      }
      if let configuration {
        if publishedReader == nil {
          components.queryItems?.append(URLQueryItem(name: "fixture", value: configuration.fixture))
        }
        guard CapabilityTransport.leases.register(generation) else { fail("capability-unavailable"); return }
        guard ApprovalTransport.register(generation) else {
          CapabilityTransport.leases.revoke(generation)
          fail("capability-unavailable"); return
        }
        guard RoutingTransport.shared.register(generation, config: configuration) else { fail("routing-unavailable"); return }
        RoutingTransport.shared.focus(generation, active)
        guard LinkTransport.register(generation, config: configuration) else { fail("link-unavailable"); return }
        guard UploadTransport.register(generation, config: configuration) else { fail("upload-unavailable"); return }
        UploadTransport.focus(generation, active: active); LinkTransport.focus(generation, active)
        // React props may set focus before configuration; replay the current native view state.
        ApprovalTransport.setFocused(generation, active: active)
      }
      guard let url = components.url else { fail("invalid-session"); return }
      expectedURL = url
      live = true
      let timeout = DispatchWorkItem { [weak self] in
        guard let self, self.live, !self.ready else { return }
        self.fail("readiness-timeout")
      }
      deadline = timeout
      DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: timeout)
      let rules = try resourceRules(index: url, script: assets.script)
      let ruleIdentifier = "hypergolic-host-v1-" + generation
      WKContentRuleListStore.default().compileContentRuleList(
        forIdentifier: ruleIdentifier,
        encodedContentRuleList: rules
      ) { [weak self] list, error in
        guard let self, !self.disposed, self.live else {
          WKContentRuleListStore.default().removeContentRuleList(forIdentifier: ruleIdentifier) { _ in }
          return
        }
        guard error == nil, let list else { self.fail("content-rules-unavailable"); return }
        self.mount(url: url, readAccess: assets.directory, rules: list)
      }
    } catch {
      fail("bundled-runtime-integrity")
    }
  }

  private func verifiedAssets() throws -> (index: URL, script: URL, directory: URL) {
    enum AssetError: Error { case missing, mismatch }
    let moduleBundle = Bundle(for: RestrictedNappletHost.self)
    guard let resourceURL = moduleBundle.url(forResource: "HypergolicNappletHostAssets", withExtension: "bundle")
      ?? Bundle.main.url(forResource: "HypergolicNappletHostAssets", withExtension: "bundle"),
      let bundle = Bundle(url: resourceURL),
      let index = bundle.url(forResource: "index", withExtension: "html"),
      let script = bundle.url(forResource: "host", withExtension: "js"),
      let manifestURL = bundle.url(forResource: "assets-manifest", withExtension: "json"),
      let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any],
      let assets = manifest["assets"] as? [String: [String: Any]],
      Set(assets.keys) == Set(["index.html", "host.js"]) else { throw AssetError.missing }
    for (name, url) in [("index.html", index), ("host.js", script)] {
      let data = try Data(contentsOf: url)
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      guard let record = assets[name], record["sha256"] as? String == digest,
        (record["bytes"] as? NSNumber)?.intValue == data.count else { throw AssetError.mismatch }
    }
    let directory = index.deletingLastPathComponent().resolvingSymlinksInPath()
    guard script.deletingLastPathComponent().resolvingSymlinksInPath() == directory else { throw AssetError.mismatch }
    return (index, script, directory)
  }

  private func resourceRules(index: URL, script: URL) throws -> String {
    func exact(_ url: URL) -> String { "^" + NSRegularExpression.escapedPattern(for: url.absoluteString) + "$" }
    let rules: [[String: Any]] = [
      ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
      ["trigger": ["url-filter": exact(index), "url-filter-is-case-sensitive": true, "resource-type": ["document"]], "action": ["type": "ignore-previous-rules"]],
      ["trigger": ["url-filter": exact(script), "url-filter-is-case-sensitive": true, "resource-type": ["script"]], "action": ["type": "ignore-previous-rules"]],
      ["trigger": ["url-filter": "^about:blank$", "resource-type": ["document"]], "action": ["type": "ignore-previous-rules"]],
      ["trigger": ["url-filter": "^about:srcdoc$", "resource-type": ["document"]], "action": ["type": "ignore-previous-rules"]],
      ["trigger": ["url-filter": "^data:", "resource-type": ["image"]], "action": ["type": "ignore-previous-rules"]],
      ["trigger": ["url-filter": "^blob:", "resource-type": ["image", "raw", "media"]], "action": ["type": "ignore-previous-rules"]],
      ["trigger": ["url-filter": ".*"], "action": ["type": "block-cookies"]]
    ]
    return String(decoding: try JSONSerialization.data(withJSONObject: rules), as: UTF8.self)
  }

  private func mount(url: URL, readAccess: URL, rules: WKContentRuleList) {
    guard live, !disposed, webView == nil else { return }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    configuration.mediaTypesRequiringUserActionForPlayback = .all
    configuration.allowsInlineMediaPlayback = true
    configuration.allowsAirPlayForMediaPlayback = false
    configuration.allowsPictureInPictureMediaPlayback = false
    configuration.dataDetectorTypes = []
    let controller = configuration.userContentController
    controller.add(rules)
    let receiver = DiagnosticReceiver(owner: self)
    self.receiver = receiver
    controller.addScriptMessageHandler(receiver, contentWorld: bridgeWorld, name: bridgeName)
    controller.addUserScript(WKUserScript(source: isolatedDiagnosticSource(url: url),
      injectionTime: .atDocumentStart, forMainFrameOnly: true, in: bridgeWorld))
    controller.addUserScript(WKUserScript(source: pageDiagnosticSource(url: url),
      injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
    let view = WKWebView(frame: bounds, configuration: configuration)
    view.navigationDelegate = self
    view.uiDelegate = self
    view.isOpaque = false
    view.backgroundColor = backgroundColor
    view.scrollView.backgroundColor = backgroundColor
    view.allowsBackForwardNavigationGestures = false
    view.allowsLinkPreview = false
    #if DEBUG
    view.isInspectable = true
    #endif
    webView = view
    addSubview(view)
    if !active { view.endEditing(true) }
    onWebViewCreated?(view)
    view.loadFileURL(url, allowingReadAccessTo: readAccess)
  }

  private func jsString(_ text: String) -> String {
    // JSON literal, never source interpolation of a raw path or user value.
    let data = try! JSONSerialization.data(withJSONObject: [text])
    let array = String(decoding: data, as: UTF8.self)
    return String(array.dropFirst().dropLast())
  }

  private func isolatedDiagnosticSource(url: URL) -> String {
    """
    (() => {
      'use strict';
      if (window !== window.top || location.href !== \(jsString(url.absoluteString))) return;
      const native = window.webkit.messageHandlers.HypergolicDiagnostic;
      window.addEventListener('message', event => {
        if (!event.isTrusted || event.source !== window || location.href !== \(jsString(url.absoluteString))) return;
        const value = event.data;
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).length !== 2 || value.type !== 'hypergolic.native-diagnostic' ||
            typeof value.message !== 'string' || new TextEncoder().encode(value.message).length > 2097152) return;
        void native.postMessage(value.message).then(response => {
          if (typeof response === 'string' && location.href === \(jsString(url.absoluteString))) {
            window.postMessage({type:'hypergolic.native-response',message:response}, '*');
          }
        }).catch(() => {});
      });
    })();
    """
  }

  private func pageDiagnosticSource(url: URL) -> String {
    """
    (() => {
      'use strict';
      if (window !== window.top || location.href !== \(jsString(url.absoluteString))) return;
      const post = window.postMessage.bind(window);
      const adapter = Object.freeze({postMessage(message) {
        if (typeof message !== 'string' || new TextEncoder().encode(message).length > 2097152) return;
        post({type:'hypergolic.native-diagnostic',message}, '*');
      }});
      Object.defineProperty(window, 'HypergolicHost', {value:adapter,writable:false,configurable:false});
      if (!window.isSecureContext || !window.crypto || typeof crypto.getRandomValues !== 'function' ||
          !crypto.subtle || typeof crypto.subtle.digest !== 'function') {
        adapter.postMessage(JSON.stringify({type:'error',sessionId:\(jsString(generation)),code:'webcrypto-unavailable'}));
      }
    })();
    """
  }

  fileprivate func receive(_ message: WKScriptMessage, reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    guard live, !disposed, message.name == bridgeName, message.world.name == bridgeWorld.name,
      message.webView === webView, message.frameInfo.webView === webView,
      message.frameInfo.isMainFrame, let expectedURL,
      message.frameInfo.request.url?.absoluteString == expectedURL.absoluteString,
      webView?.url?.absoluteString == expectedURL.absoluteString,
      message.frameInfo.securityOrigin.protocol == "file",
      message.frameInfo.securityOrigin.host.isEmpty, message.frameInfo.securityOrigin.port == 0,
      let text = message.body as? String, text.utf8.count <= CapabilityLeaseRegistry.maxBytes,
      let data = text.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      value["sessionId"] as? String == generation else {
        if publishedSource != nil { fail("artifact-read-rejected") }
        reply(nil, "Diagnostic rejected"); return
      }
    if publishedSource != nil && value["type"] as? String == "artifact.read" {
      receiveArtifactRead(value, textLength: text.utf8.count, reply: reply)
      return
    }
    if value["type"] as? String == "relay-stream-ack" {
      receiveStreamAck(value)
      reply(nil, nil)
      return
    }
    if value["type"] as? String == "relay-stream" {
      receiveSubscription(value)
      // Admission uses WebKit's reply exactly once. Persistent pushes use the captured content world.
      reply(nil, nil)
      return
    }
    if value["type"] as? String == "capability" {
      receiveCapability(value, reply: reply)
      return
    }
    guard text.utf8.count <= 2048 else { reply(nil, "Diagnostic rejected"); return }
    switch value["type"] as? String {
    case "close-check.result":
      receiveCloseCheck(value)
      reply(nil, nil)
    case "routing-ack":
      guard Set(value.keys) == ["type", "sessionId", "sequence", "delivery"],
        let sequence = value["sequence"] as? NSNumber, let delivery = value["delivery"] as? NSNumber,
        CFGetTypeID(sequence) != CFBooleanGetTypeID(), CFGetTypeID(delivery) != CFBooleanGetTypeID(),
        sequence.doubleValue.isFinite, delivery.doubleValue.isFinite,
        sequence.doubleValue >= 1, sequence.doubleValue <= 9_007_199_254_740_991, sequence.doubleValue.rounded(.towardZero) == sequence.doubleValue,
        delivery.doubleValue >= 1, delivery.doubleValue <= 9_007_199_254_740_991, delivery.doubleValue.rounded(.towardZero) == delivery.doubleValue,
        CapabilityTransport.leases.consumeSequence(generation, sequence: sequence.uint64Value) else { return }
      RoutingTransport.shared.acknowledge(generation, delivery: delivery.uint64Value)
    case "ready" where value.count == 2 && !ready:
      ready = true
      RoutingTransport.shared.ready(generation)
      deadline?.cancel()
      reply(nil, nil)
      emit("ready")
    case "error" where value.count == 3:
      guard let code = value["code"] as? String,
        code.range(of: "^[a-z-]{1,80}$", options: .regularExpression) != nil else {
        reply(nil, "Diagnostic rejected"); return
      }
      reply(nil, nil)
      fail(code)
    default:
      reply(nil, "Diagnostic rejected")
    }
  }

  private func receiveArtifactRead(_ value: [String: Any], textLength: Int,
      reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    guard textLength <= 2048, Set(value.keys) == Set(["type", "sessionId", "sequence"]),
      let number = value["sequence"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite, number.doubleValue >= 0,
      number.doubleValue <= 9_007_199_254_740_991,
      number.doubleValue.rounded(.towardZero) == number.doubleValue,
      let response = publishedReader?.read(sequence: number.intValue) else {
        reply(nil, "Artifact read rejected")
        fail("artifact-read-rejected")
        return
      }
    reply(response, nil)
  }

  private func streamInteger(_ value: Any?) -> UInt64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
      number.doubleValue.isFinite, number.doubleValue >= 1, number.doubleValue <= 9_007_199_254_740_991,
      number.doubleValue.rounded(.towardZero) == number.doubleValue else { return nil }
    return number.uint64Value
  }
  private func receiveStreamAck(_ value: [String: Any]) {
    guard ready, Set(value.keys) == Set(["type", "sessionId", "sequence", "streamSequence", "delivery"]),
      let sequence = streamInteger(value["sequence"]), let stream = streamInteger(value["streamSequence"]),
      let delivery = streamInteger(value["delivery"]),
      CapabilityTransport.leases.consumeSequence(generation, sequence: sequence) else { return }
    RelaySubscriptionTransport.shared.acknowledge(generation, streamSequence: stream, delivery: delivery)
  }
  private func receiveSubscription(_ value: [String: Any]) {
    guard ready, let configuration, configuration.domains.contains("relay"),
      Set(value.keys) == Set(["type", "sessionId", "sequence", "message"]),
      let counter = streamInteger(value["sequence"]),
      CapabilityTransport.leases.consumeSequence(generation, sequence: counter),
      let message = value["message"] as? String, message.utf8.count <= 16 * 1024,
      let request = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
      let type = request["type"] as? String,
      (type == "relay.subscribe" || (type == "outbox.subscribe" && configuration.domains.contains("outbox"))), let subId = request["subId"] as? String,
      (1...128).contains(subId.utf8.count), !subId.utf8.contains(where: { $0 < 32 || $0 == 127 }),
      let id = request["id"] as? String, (1...128).contains(id.utf8.count),
      let snapshot = try? configuration.request(message), let capturedView = webView, let capturedURL = expectedURL else { return }
    RelaySubscriptionTransport.shared.foreground(UIApplication.shared.applicationState == .active)
    guard let token = RelaySubscriptionTransport.shared.admit(generation, sequence: counter, snapshot: snapshot, subId: subId, outbox: type == "outbox.subscribe",
      push: { [weak self, weak capturedView] envelope in
        guard let self, let capturedView, self.webView === capturedView, self.live, !self.disposed,
          capturedView.url?.absoluteString == capturedURL.absoluteString else { return }
        let script = "window.postMessage({type:'hypergolic.native-response',message:" + self.jsString(envelope) + "}, '*')"
        capturedView.evaluateJavaScript(script, in: nil, in: self.bridgeWorld) { [weak self] result in
          if case .failure = result { self?.fail("renderer-stopped") }
        }
      }) else { return }
    onEvent?(["type": "capability", "lane": type == "outbox.subscribe" ? "outbox-subscription" : "subscription", "sessionId": configuration.sessionId,
      "generation": generation, "token": token])
  }

  private func receiveCapability(_ value: [String: Any],
      reply: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    guard ready, let configuration,
      Set(value.keys) == Set(["type", "sessionId", "sequence", "message"]),
      let sequence = value["sequence"] as? NSNumber, CFGetTypeID(sequence) != CFBooleanGetTypeID(),
      sequence.doubleValue.isFinite, sequence.doubleValue >= 1, sequence.doubleValue <= 9_007_199_254_740_991,
      sequence.doubleValue.rounded(.towardZero) == sequence.doubleValue,
      let message = value["message"] as? String, let snapshot = try? configuration.request(message)
      else { reply(nil, "Capability rejected"); return }
    let counter = sequence.uint64Value
    let operation = UUID().uuidString
    let now = ProcessInfo.processInfo.systemUptime
    pendingNativeReplies = pendingNativeReplies.filter { $0.value > now }
    if pendingNativeReplies.count < 64 { pendingNativeReplies[operation] = now + 660 }
    else { closeUnsafeUntil = now + 660 }
    let respond: @MainActor @Sendable (String?) -> Void = { [weak self] response in
      self?.pendingNativeReplies.removeValue(forKey: operation)
      guard let self, self.live, !self.disposed,
        self.webView?.url?.absoluteString == self.expectedURL?.absoluteString else { reply(nil, "Session unavailable"); return }
      let result: [String: Any] = ["type": "capability.result", "sessionId": self.generation,
        "sequence": counter, "response": response as Any? ?? NSNull()]
      guard let bytes = try? JSONSerialization.data(withJSONObject: result) else { reply(nil, "Capability rejected"); return }
      reply(String(decoding: bytes, as: UTF8.self), nil)
    }
    if let request = try? UploadWire.object(message, limit: 36 * 1024, maximumDepth: 40), request["type"] as? String == "routing.call" {
      guard let capturedView = webView, let capturedURL = expectedURL,
        let token = RoutingTransport.shared.receive(generation, sequence: counter, raw: message,
          push: { [weak self, weak capturedView] envelope in
            guard let self, let capturedView, self.webView === capturedView, self.live, !self.disposed,
              capturedView.url?.absoluteString == capturedURL.absoluteString else { return }
            let script = "window.postMessage({type:'hypergolic.native-response',message:" + self.jsString(envelope) + "}, '*')"
            capturedView.evaluateJavaScript(script, in: nil, in: self.bridgeWorld) { [weak self] result in
              if case .failure = result { self?.fail("renderer-stopped") }
            }
          }, reply: respond) else { return }
      onEvent?(["type": "capability", "lane": ((request["message"] as? [String: Any])?["type"] as? String)?.hasPrefix("notify.") == true ? "presentation" : ((request["message"] as? [String: Any])?["type"] as? String)?.hasPrefix("config.") == true ? "configuration" : "routing", "sessionId": configuration.sessionId, "generation": generation, "token": token])
      return
    }
    if let request = try? UploadWire.object(message, limit: 16 * 1024), request["type"] as? String == "link.open" {
      guard CapabilityTransport.leases.consumeSequence(generation, sequence: counter) else {respond(nil); return}
      LinkTransport.receive(generation, config: configuration, raw: message, view: self, reply: respond)
      return
    }
    if let request = try? UploadWire.object(message, limit: 400 * 1024),
      let type = request["type"] as? String, type.hasPrefix("upload.") {
      guard configuration.domains.contains("upload"), CapabilityTransport.leases.consumeSequence(generation, sequence: counter),
        let capturedView = webView, let capturedURL = expectedURL else { respond(nil); return }
      let result = UploadTransport.receive(generation, sequence: counter, raw: message,
        push: { [weak self, weak capturedView] envelope in
          guard let self, let capturedView, self.webView === capturedView, self.live, !self.disposed,
            capturedView.url?.absoluteString == capturedURL.absoluteString else { return }
          let script = "window.postMessage({type:'hypergolic.native-response',message:" + self.jsString(envelope) + "}, '*')"
          capturedView.evaluateJavaScript(script, in: nil, in: self.bridgeWorld) { [weak self] result in
            if case .failure = result { self?.fail("renderer-stopped") }
          }
        }, onReview: { [weak self] token in
          guard let self, self.live, !self.disposed else { return }
          self.onEvent?(["type": "capability", "lane": "upload", "sessionId": configuration.sessionId, "generation": self.generation, "token": token])
        })
      respond(result)
      return
    }
    let approval = configuration.approvalWireId(message)
    if approval.recognized {
      guard CapabilityTransport.leases.consumeSequence(generation, sequence: counter),
        let token = ApprovalTransport.admit(generation, snapshot: snapshot,
          wireId: approval.wireId, reply: respond) else { respond(nil); return }
      onEvent?(["type": "capability", "sessionId": configuration.sessionId,
        "generation": generation, "token": token, "lane": "approval"])
      return
    }
    guard let token = CapabilityTransport.admit(generation, sequence: counter, snapshot: snapshot, reply: respond) else {
      respond(nil); return
    }
    onEvent?(["type": "capability", "sessionId": configuration.sessionId, "generation": generation, "token": token])
  }

  private func emit(_ type: String, code: String? = nil) {
    var event: [String: Any] = ["type": type, "sessionId": sessionId ?? ""]
    if type == "ready" { event["generation"] = generation }
    if let code { event["code"] = code }
    onEvent?(event)
  }

  private func fail(_ code: String) {
    guard !disposed else { return }
    live = false
    UploadTransport.revoke(generation)
    LinkTransport.revoke(generation)
    ApprovalTransport.revoke(generation)
    CapabilityTransport.leases.revoke(generation)
    emit("error", code: code)
    destroySession()
  }

  func destroySession() {
    guard !disposed else { return }
    disposed = true
    closeCheckId = nil
    pendingNativeReplies.removeAll()
    selectedFilePicker.cancel()
    NotificationCenter.default.removeObserver(self)
    webView?.setAllMediaPlaybackSuspended(true, completionHandler: nil)
    live = false
    publishedReader?.clear()
    publishedReader = nil
    UploadTransport.revoke(generation)
    LinkTransport.revoke(generation)
    ApprovalTransport.revoke(generation)
    CapabilityTransport.revoke(generation)
    deadline?.cancel()
    deadline = nil
    receiver?.owner = nil
    receiver = nil
    WKContentRuleListStore.default().removeContentRuleList(forIdentifier: "hypergolic-host-v1-" + generation) { _ in }
    guard let view = webView else { return }
    view.configuration.userContentController.removeScriptMessageHandler(forName: bridgeName, contentWorld: bridgeWorld)
    view.configuration.userContentController.removeAllUserScripts()
    view.stopLoading()
    view.navigationDelegate = nil
    view.uiDelegate = nil
    view.removeFromSuperview()
    webView = nil
    // Keep content rules attached until this WKWebView is released. Revoking a
    // session must never create an unfiltered interval in a surviving renderer.
  }

  func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
               decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
    guard view === webView, live, !disposed, let url = action.request.url,
      let frame = action.targetFrame else { decisionHandler(.cancel); return }
    if frame.isMainFrame {
      guard !initialNavigationAllowed, action.navigationType == .other,
        url.absoluteString == expectedURL?.absoluteString,
        action.request.httpMethod == nil || action.request.httpMethod == "GET" else {
        decisionHandler(.cancel); fail("navigation-blocked"); return
      }
      initialNavigationAllowed = true
      decisionHandler(.allow)
    } else if !ready && action.navigationType == .other && ["about:blank", "about:srcdoc"].contains(url.absoluteString) {
      decisionHandler(.allow)
    } else {
      decisionHandler(.cancel)
      // Any later attempted document navigation ends this bound generation.
      if ready { fail("frame-navigation") }
    }
  }

  func webView(_ view: WKWebView, decidePolicyFor response: WKNavigationResponse,
               decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
    guard view === webView, live, response.canShowMIMEType else { decisionHandler(.cancel); return }
    if response.isForMainFrame && response.response.url?.absoluteString != expectedURL?.absoluteString {
      decisionHandler(.cancel); fail("navigation-blocked"); return
    }
    decisionHandler(.allow)
  }

  func webView(_ view: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    if view !== webView || !live || loaded { fail("navigation-blocked") }
  }
  func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
    guard view === webView, live, view.url?.absoluteString == expectedURL?.absoluteString else { return }
    loaded = true
    updateMediaPlayback()
  }
  func webView(_ view: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    if view === webView && live { fail("host-load-failed") }
  }
  func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    if view === webView && live { fail("host-load-failed") }
  }
  func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
    if view === webView { fail("renderer-stopped") }
  }
  func webView(_ view: WKWebView, didReceive challenge: URLAuthenticationChallenge,
               completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    completionHandler(.cancelAuthenticationChallenge, nil)
  }
  func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
  func webViewDidClose(_ view: WKWebView) { if view === webView { fail("window-closed") } }
  func webView(_ view: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) { completionHandler() }
  func webView(_ view: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) { completionHandler(false) }
  func webView(_ view: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
               defaultText: String?, initiatedByFrame frame: WKFrameInfo,
               completionHandler: @escaping @MainActor @Sendable (String?) -> Void) { completionHandler(nil) }
  func webView(_ view: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
               initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
               decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
  func webView(_ view: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin,
               initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) { decisionHandler(.deny) }
  @available(iOS 18.4, *)
  func webView(_ view: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
    guard view === webView, maySelectFile(), !frame.isMainFrame, !parameters.allowsDirectories, !parameters.allowsMultipleSelection,
      ["about:srcdoc", "about:blank"].contains(frame.request.url?.absoluteString ?? "") else { completionHandler(nil); return }
    var responder: UIResponder? = self
    while let current = responder, !(current is UIViewController) {responder = current.next}
    guard let presenter = responder as? UIViewController else {completionHandler(nil); return}
    selectedFilePicker.choose(from: presenter, completion: completionHandler)
    schedulePickerFaultProof()
  }
}

@MainActor
private final class DiagnosticReceiver: NSObject, WKScriptMessageHandlerWithReply {
  weak var owner: RestrictedNappletHost?
  init(owner: RestrictedNappletHost) { self.owner = owner }
  func userContentController(_ userContentController: WKUserContentController,
                             didReceive message: WKScriptMessage,
                             replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
    guard let owner else { replyHandler(nil, "Session unavailable"); return }
    owner.receive(message, reply: replyHandler)
  }
}
