#if HYPERGOLIC_NETWORK_PROOF
import UIKit
import SafariServices
import Synchronization

/// Isolated ephemeral UI observer. It never opens a vault, claims an Expo owner, or publishes user events.
@MainActor final class NativeHandoffProbeController: UIViewController, @preconcurrency SFSafariViewControllerDelegate {
  private var minimalBrowser: SFSafariViewController?
  private let status = UILabel(), lifetime = NativeVaultMutationGate(), handoffs = NativeNip46HandoffRegistry()
  private var task: Task<Void, Never>?, browser: NativeVaultSafariPanel?, review: NativeSignerReviewPanel?
  private var reviewReply: CheckedContinuation<Bool, Never>?
  private var observations: [NativeHandoffProofObservation] = []
  private var scenario: String { let args = ProcessInfo.processInfo.arguments; guard let index = args.firstIndex(of: "native-handoff-ui"), index + 1 < args.count else { return "approve" }; return args[index + 1] }
  override func viewDidLoad() {
    super.viewDidLoad(); view.backgroundColor = .systemBackground
    let title = UILabel(); title.text = "Disposable native Safari trace"; title.font = .preferredFont(forTextStyle: .title2); title.numberOfLines = 0
    let detail = UILabel(); detail.text = "Ephemeral test key. No vault access or event publication."; detail.numberOfLines = 0
    let start = UIButton(type: .system); start.setTitle("Start native handoff", for: .normal); start.accessibilityIdentifier = "handoff.start"
    start.addAction(UIAction { [weak self] _ in self?.start() }, for: .touchUpInside)
    start.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
    status.numberOfLines = 0; status.accessibilityIdentifier = "handoff.status"
    let stack = UIStackView(arrangedSubviews: [title, detail, start, status]); stack.axis = .vertical; stack.spacing = 24; stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack); NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24), stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 40)])
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification, UIApplication.protectedDataWillBecomeUnavailableNotification] {
      observations.append(NativeHandoffProofObservation(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.cancel() } }))
    }
  }
  deinit { task?.cancel() }
  private func start() {
    if scenario == "minimal" {
      let browser = SFSafariViewController(url: URL(string: "https://example.com")!); browser.delegate = self; browser.modalPresentationStyle = .fullScreen
      minimalBrowser = browser; present(browser, animated: true); return
    }
    guard task == nil else { return }; status.text = "Preparing disposable native signer"
    lifetime.update(foreground: UIApplication.shared.applicationState == .active, protectedData: UIApplication.shared.isProtectedDataAvailable)
    task = Task { [weak self] in
      guard let self else { return }
      let dispatchState = NativeNip46DispatchState()
      do {
        let fixture = try NativeHandoffProofFixture(), epoch = try lifetime.epoch()
        var scalar = Data(count: 32); scalar[31] = 1
        let key = try NativeVaultKey(secret: scalar); scalar.resetBytes(in: 0..<scalar.count); defer { key.destroy() }
        try await fixture.configure()
        let client = fixture.client(key), checker: @Sendable () -> Bool = { [lifetime] in lifetime.current(epoch) }
        var bunker = try NativeBunkerConnection(fixture.bunker); defer { bunker.clear() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(120))
        let bound = try await client.handshake(token: bunker.token, relays: [fixture.relay], deadline: deadline, current: checker, dispatch: { [lifetime] emit in try lifetime.mutate(epoch, deadline: deadline) { emit() } })
        guard bound.pubkey == fixture.user else { throw NativeVaultFailure.signerResponseInvalid }
        let event = try fixture.event()
        // The actual native registry captures immutable event/publication destinations before native review.
        let registration = "{\"user\":\"" + fixture.user + "\"}"
        let template: [String: Any] = ["kind": event.kind, "created_at": event.createdAt, "tags": event.tags, "content": event.content]
        func wire(_ object: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self) }
        let source = try wire(["registration": try JSONSerialization.jsonObject(with: Data(registration.utf8)), "request": wire(["type": "relay.publish", "id": "native-safari-proof", "event": template])])
        let captured = try wire(["event": template, "selectedPubkey": fixture.user, "hash": event.digest.hex, "destinations": ["wss://publication.example.org"]])
        // Isolated registry owns its actual lease core; there is no Expo activation flag.
        let leases = CapabilityLeaseRegistry(); let owner = ApprovalTransportRegistry(leases: leases, schedule: { _, _ in })
        guard leases.register("safari-proof"), owner.register("safari-proof") else { throw NativeVaultFailure.denied }
        owner.setForeground(true); owner.setFocused("safari-proof", active: true)
        guard let token = owner.admit("safari-proof", snapshot: source, wireId: "native-safari-proof", reply: { _ in }), owner.take(token) != nil,
          owner.prepareSigning(token, raw: captured), owner.approve(token), let exact = owner.signingSnapshot(token) else { throw NativeVaultFailure.denied }
        guard await trustedReview(event: event, peer: fixture.peer, relays: [fixture.relay]), checker(), owner.claimNativeSigning(token, expected: exact) else { throw NativeVaultFailure.denied }
        let current: @Sendable () -> Bool = { checker() && owner.isSigningLive(token) }
        let ticket = NativeNip46Handoff(binding: .signing(kind: "approval", token: token, vaultID: "disposable-ui-proof", revision: 1, eventID: event.digest.hex), deadline: deadline, current: current,
          pause: { owner.pauseNativeSigning(token, paused: $0) }, cancel: { owner.cancel(token) }, show: { [weak self] ticket, url in Task { @MainActor [weak self] in await self?.show(ticket, url: url, fixture: fixture, clientPubkey: (try? key.publicKey()) ?? "") } })
        handoffs.install(ticket)
        let signed = try await fixture.client(key, ticket: ticket).sign(event, relays: [fixture.relay], deadline: deadline, current: current,
          dispatch: { [lifetime] emit in try lifetime.mutate(epoch, deadline: deadline) { emit() } }, state: dispatchState)
        guard current(), ticket.publicState == "resumed", try NativeNostrSignedEvent(json: signed, peer: fixture.user).event == event else { throw NativeVaultFailure.denied }
        let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try Data(signed.utf8).write(to: directory.appendingPathComponent("handoff-ui-signature.json"), options: .atomic)
        try record(["scenario": scenario, "signatureReturned": true, "sourceLive": owner.isLive(token), "state": ticket.publicState ?? "none", "possibleSign": dispatchState.possible])
        status.text = "Native handoff signature verified"
      } catch {
        let code = (error as? NativeVaultFailure)?.bridgeCode ?? "SIGNER_UNAVAILABLE"
        try? record(["scenario": scenario, "signatureReturned": false, "sourceLive": false, "state": "denied", "possibleSign": dispatchState.possible, "errorCode": code])
        status.text = "Native handoff denied: " + code
      }
      task = nil
    }
  }
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    guard controller === minimalBrowser else { return }
    minimalTrace("didFinish", controller: controller)
    controller.dismiss(animated: true) { [weak self] in self?.status.text = "Minimal Safari Close observed" }
  }
  func safariViewController(_ controller: SFSafariViewController, didCompleteInitialLoad didLoadSuccessfully: Bool) {
    if controller === minimalBrowser { minimalTrace("initialLoad", controller: controller) }
  }
  private func minimalTrace(_ event: String, controller: SFSafariViewController) {
    let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("minimal-safari-callbacks.json")
    var rows = (try? Data(contentsOf: path)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
    rows.append(["event": event, "delegateInstalled": (controller.delegate as AnyObject?) === self, "hasPresenter": controller.presentingViewController != nil])
    if let bytes = try? JSONSerialization.data(withJSONObject: rows) { try? bytes.write(to: path, options: .atomic) }
  }
  private func trustedReview(event: ExactSignerEvent, peer: String, relays: [String]) async -> Bool {
    await withCheckedContinuation { reply in
      reviewReply = reply
      let panel = NativeSignerReviewPanel(event: event, requester: "Disposable native Safari trace", destinations: ["wss://publication.example.org"], method: "Remote signer (NIP-46)", signerRelays: relays, signerPeer: peer) { [weak self] approved in
        guard let self, let reply = reviewReply else { return }; reviewReply = nil; let panel = review; review = nil
        panel?.dismiss(animated: true) { reply.resume(returning: approved) }
      }
      review = panel; present(panel, animated: true)
    }
  }
  private func show(_ ticket: NativeNip46Handoff, url: URL, fixture: NativeHandoffProofFixture, clientPubkey: String) async {
    guard handoffs.permitsPresentation(ticket) else { return }
    do { try await Task.detached { try NativeSignerRelayPolicy.validateAuthenticationResolution(url) }.value }
    catch { cancel(); return }
    guard handoffs.permitsPresentation(ticket) else { return }
    let alert = UIAlertController(title: "Open signer authentication?", message: "https://" + (url.host ?? "") + "\nThe page itself does not approve signing.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.cancel() })
    alert.addAction(UIAlertAction(title: "Open authentication", style: .default) { [weak self] _ in
      guard let self, handoffs.permitsPresentation(ticket), ticket.arm() else { return }
      let safari = NativeVaultSafariPanel(url: url, done: { [weak self] in print("HANDOFF_UI_NATIVE_BROWSER_COMPLETION"); self?.resume(ticket) }, cancel: { [weak self] in self?.cancel() })
      browser = safari
      alert.dismiss(animated: true) {
        guard self.handoffs.owns(ticket), ticket.isActive else { return }; self.present(safari.controller, animated: true)
      }
      // Only the private controlled peer completes authentication; Safari load/navigation is never proof.
      Task { do { try await fixture.complete(clientPubkey: clientPubkey) } catch { self.cancel() } }
    })
    present(alert, animated: true)
  }
  private func resume(_ ticket: NativeNip46Handoff) {
    guard handoffs.permitsPresentation(ticket, resuming: true) else { return }; browser = nil
    let alert = UIAlertController(title: "Resume the same signer request?", message: "Use only its authenticated original-ID reply. No challenged request is resent.", preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.cancel() })
    alert.addAction(UIAlertAction(title: "Resume request", style: .default) { [weak self] _ in
      guard let self, handoffs.permitsPresentation(ticket, resuming: true), ticket.requestResume() else { self?.cancel(); return }
    })
    present(alert, animated: true)
  }
  private func record(_ value: [String: Any]) throws {
    let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("handoff-ui-" + scenario + ".json")
    try JSONSerialization.data(withJSONObject: value, options: .sortedKeys).write(to: path, options: .atomic)
  }
  private func cancel() {
    lifetime.update(foreground: false, protectedData: false); handoffs.cancelAll(); task?.cancel()
    let safari = browser; browser = nil; safari?.cancel()
    let reply = reviewReply; reviewReply = nil; reply?.resume(returning: false); review = nil
    presentedViewController?.dismiss(animated: false)
  }
}
private final class NativeHandoffProofObservation: @unchecked Sendable {
  let token: any NSObjectProtocol
  init(_ token: any NSObjectProtocol) { self.token = token }
  deinit { NotificationCenter.default.removeObserver(token) }
}
private final class NativeHandoffProofExchange: Sendable {
  private let state = Mutex<(cancelled: Bool, operation: NativeSignerRelayTransport.Operation?)>((false, nil))
  func attach(_ operation: NativeSignerRelayTransport.Operation) { state.withLock { if $0.cancelled { operation.cancel() } else { $0.operation = operation } } }
  func cancel() { state.withLock { $0.cancelled = true; $0.operation?.cancel(); $0.operation = nil } }
}
private struct NativeHandoffProofFixture: @unchecked Sendable {
  let relay: String, peer: String, user: String, bunker: String, control: String, nonce: String, anchor: Data
  init() throws {
    let raw = try Data(contentsOf: Bundle.main.url(forResource: "Nip46Fixture", withExtension: "json")!)
    let object = try JSONSerialization.jsonObject(with: raw) as! [String: String]
    relay = object["relayURL"]!; peer = object["peerPubkey"]!; user = object["userPubkey"]!; bunker = object["bunkerURL"]!
    control = object["controlURL"]!; nonce = object["nonce"]!; anchor = Data(base64Encoded: object["anchor"]!)!
  }
  private func post(_ object: [String: Any]) async throws {
    var request = URLRequest(url: URL(string: control)!); request.httpMethod = "POST"; request.setValue(nonce, forHTTPHeaderField: "x-fixture-control"); request.httpBody = try JSONSerialization.data(withJSONObject: object)
    let (_, response) = try await URLSession.shared.data(for: request); guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw NativeVaultFailure.signerUnavailable }
  }
  func configure() async throws { try await post(["fault": "auth-url", "method": "sign_event", "authURL": "https://example.com", "relays": [relay]]) }
  func complete(clientPubkey: String) async throws {
    var request = URLRequest(url: URL(string: control.replacingOccurrences(of: "/control", with: "/status"))!); request.setValue(nonce, forHTTPHeaderField: "x-fixture-control")
    let (data, _) = try await URLSession.shared.data(for: request); let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    let rows = object["requests"] as! [[String: Any]], id = rows.last(where: { $0["clientPubkey"] as? String == clientPubkey && $0["method"] as? String == "sign_event" })!["id"] as! String
    try await post(["completeAuth": ["clientPubkey": clientPubkey, "id": id, "decision": "approve"]])
  }
  func event() throws -> ExactSignerEvent {
    try ExactSignerEvent(json: "{\"pubkey\":\"\(user)\",\"created_at\":\(UInt64(Date().timeIntervalSince1970)),\"kind\":1,\"tags\":[[\"r\",\"wss://publication.example.org\"]],\"content\":\"Disposable Safari exact event 🛰️\"}", expectedPubkey: user)
  }
  func client(_ key: NativeVaultKey, ticket: NativeNip46Handoff? = nil) -> NativeNip46Client {
    NativeNip46Client(key: key, peer: peer, handoff: ticket, exchange: { relay, subscription, event, deadline, control, validate in
      let lifetime = NativeHandoffProofExchange()
      return try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { reply in
          do { lifetime.attach(try NativeSignerRelayTransport.exchangeForProof(relay, subscription: subscription, event: event, address: "127.0.0.1", anchorDER: anchor, deadline: deadline, control: control, validate: validate) { reply.resume(with: $0) }) }
          catch { reply.resume(throwing: error) }
        }
      } onCancel: { lifetime.cancel() }
    })
  }
}
#endif
