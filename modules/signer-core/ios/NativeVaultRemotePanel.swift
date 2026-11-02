import UIKit
import SafariServices

/// This native entry never returns a URI or handshake token through Expo.
@MainActor final class NativeVaultRemotePanel: UIViewController {
  private let input = NativePrivateKeyField(), status = UILabel()
  private let current: @Sendable () -> Bool
  private let complete: (NativeBunkerConnection?) -> Void
  init(current: @escaping @Sendable () -> Bool, complete: @escaping (NativeBunkerConnection?) -> Void) {
    self.current = current; self.complete = complete; super.init(nibName: nil, bundle: nil); isModalInPresentation = true
  }
  required init?(coder: NSCoder) { nil }
  override func viewDidLoad() {
    super.viewDidLoad(); view.backgroundColor = .systemBackground
    let title = UILabel(); title.text = "Connect a remote signer"; title.numberOfLines = 0; title.font = .preferredFont(forTextStyle: .title2)
    let explanation = UILabel(); explanation.text = "Paste a bunker URL from your signer. The connection stays on this device. You will review the account and signer before switching."; explanation.numberOfLines = 0; explanation.font = .preferredFont(forTextStyle: .body)
    input.isSecureTextEntry = true; input.placeholder = "bunker://…"; input.keyboardType = .asciiCapable; input.textContentType = nil
    input.autocorrectionType = .no; input.autocapitalizationType = .none; input.spellCheckingType = .no
    input.smartQuotesType = .no; input.smartDashesType = .no; input.smartInsertDeleteType = .no; input.borderStyle = .roundedRect
    input.accessibilityLabel = "Private signer connection"; input.accessibilityIdentifier = "native-vault.remote-connection"
    input.font = .preferredFont(forTextStyle: .body); input.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
    status.numberOfLines = 0; status.font = .preferredFont(forTextStyle: .body)
    let cancel = UIButton(type: .system); cancel.setTitle("Cancel", for: .normal); cancel.accessibilityIdentifier = "native-vault.remote-cancel"
    cancel.addAction(UIAction { [weak self] _ in self?.clear(); self?.complete(nil) }, for: .touchUpInside)
    let prepare = UIButton(type: .system); prepare.setTitle("Connect", for: .normal); prepare.accessibilityIdentifier = "native-vault.remote-connect"
    prepare.addAction(UIAction { [weak self] _ in self?.prepare() }, for: .touchUpInside)
    for button in [cancel, prepare] { button.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true; button.titleLabel?.font = .preferredFont(forTextStyle: .headline) }
    for label in [title, explanation, status] { label.adjustsFontForContentSizeCategory = true }; input.adjustsFontForContentSizeCategory = true
    let actions = UIStackView(arrangedSubviews: [cancel, prepare]); actions.distribution = .fillEqually
    let stack = UIStackView(arrangedSubviews: [title, explanation, input, status, actions]); stack.axis = .vertical; stack.spacing = 24; stack.translatesAutoresizingMaskIntoConstraints = false
    let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(scroll); scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24), stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24), stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
    ])
  }
  func clear() { input.text = nil; input.resignFirstResponder(); viewIfLoaded?.isHidden = true }
  private func prepare() {
    guard current(), UIApplication.shared.applicationState == .active else { clear(); complete(nil); return }
    do { guard let text = input.text else { throw NativeVaultFailure.invalidSignerConnection }; let connection = try NativeBunkerConnection(text)
      input.text = nil; input.resignFirstResponder(); complete(connection)
    } catch { input.text = nil; status.text = "Enter a valid bunker URL with public WSS relays." }
  }
}

final class NativeVaultRemoteCandidates: @unchecked Sendable {
  enum Purpose: Sendable { case connection, refresh }
  struct Candidate: Sendable {
    let purpose: Purpose
    let handle: String, pubkey: String, peer: String, relays: [String], key: NativeVaultKey
    let vaultID: String, revision: UInt64, epoch: UInt64, expires: ContinuousClock.Instant
  }
  private let lock = NSLock()
  private var candidate: Candidate?
  private var consumed: Candidate?
  func prepare(pubkey: String, peer: String, relays: [String], key: NativeVaultKey, vaultID: String, revision: UInt64, epoch: UInt64, expires: ContinuousClock.Instant, purpose: Purpose = .connection) throws -> String {
    try lock.withLock {
      guard ContinuousClock.now < expires else { key.destroy(); throw NativeVaultFailure.signerExpired }
      candidate?.key.destroy(); consumed?.key.destroy(); consumed = nil
      let row = Candidate(purpose: purpose, handle: UUID().uuidString.lowercased(), pubkey: pubkey, peer: peer, relays: relays, key: key, vaultID: vaultID, revision: revision, epoch: epoch, expires: expires)
      candidate = row
      let duration = ContinuousClock.now.duration(to: expires).components
      DispatchQueue.global().asyncAfter(deadline: .now() + Double(duration.seconds) + Double(duration.attoseconds) / 1e18) { [weak self] in self?.cancel(row.handle); row.key.destroy() }
      return "{\"handle\":\(ExactSignerEvent.quote(row.handle)),\"pubkey\":\(ExactSignerEvent.quote(pubkey))}"
    }
  }
  func take(handle: String, vaultID: String, revision: UInt64, epoch: UInt64, purpose: Purpose = .connection) throws -> Candidate {
    try lock.withLock {
      guard let row = candidate, row.handle == handle else { throw NativeVaultFailure.denied }; candidate = nil
      guard row.purpose == purpose, row.vaultID == vaultID, row.revision == revision, row.epoch == epoch, ContinuousClock.now < row.expires else { row.key.destroy(); throw NativeVaultFailure.signerExpired }
      consumed = row; return row
    }
  }
  func cancel(_ handle: String, beforeDestroy: @Sendable () -> Void = {}) {
    lock.withLock {
      guard candidate?.handle == handle || consumed?.handle == handle else { return }
      beforeDestroy()
      if candidate?.handle == handle { candidate?.key.destroy(); candidate = nil }
      if consumed?.handle == handle { consumed?.key.destroy(); consumed = nil }
    }
  }
  func cancelAll() { lock.withLock { candidate?.key.destroy(); consumed?.key.destroy(); candidate = nil; consumed = nil } }
  func release(_ handle: String) { cancel(handle) }
  deinit { candidate?.key.destroy(); consumed?.key.destroy() }
}

/// Safari has no Expo or napplet bridge. Browser callbacks request native Resume; they grant no authority.
@MainActor final class NativeVaultSafariPanel: NSObject, @preconcurrency SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  let controller: SFSafariViewController
  private let done: () -> Void, cancelled: () -> Void
  private var finished = false
  init(url: URL, done: @escaping () -> Void, cancel: @escaping () -> Void) {
    controller = SFSafariViewController(url: url); self.done = done; cancelled = cancel; super.init()
    controller.delegate = self; controller.modalPresentationStyle = .fullScreen
    controller.presentationController?.delegate = self
#if HYPERGOLIC_NETWORK_PROOF
    proofTrace("delegateInstalled", matched: (controller.delegate as AnyObject?) === self)
#endif
  }
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
#if HYPERGOLIC_NETWORK_PROOF
    proofTrace("didFinish", matched: controller === self.controller)
#endif
    guard controller === self.controller, !finished else { return }; finished = true
    controller.dismiss(animated: true) { [self] in
#if HYPERGOLIC_NETWORK_PROOF
      proofTrace("dismissCompletion", matched: true)
#endif
      done()
    }
  }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
#if HYPERGOLIC_NETWORK_PROOF
    proofTrace("presentationDidDismiss", matched: presentationController.presentedViewController === controller)
#endif
    guard presentationController.presentedViewController === controller, !finished else { return }; finished = true; done()
  }
  func safariViewControllerWillOpenInBrowser(_ controller: SFSafariViewController) {
#if HYPERGOLIC_NETWORK_PROOF
    proofTrace("willOpenInBrowser", matched: controller === self.controller)
#endif
    if controller === self.controller { cancel() }
  }
#if HYPERGOLIC_NETWORK_PROOF
  func safariViewController(_ controller: SFSafariViewController, didCompleteInitialLoad didLoadSuccessfully: Bool) {
    proofTrace("initialLoadCallback", matched: controller === self.controller)
  }
  private func proofTrace(_ event: String, matched: Bool) {
    let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("native-safari-callbacks.json")
    var rows = (try? Data(contentsOf: file)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [[String: Any]] } ?? []
    guard rows.count < 16 else { return }
    rows.append(["event": event, "matchedController": matched, "finished": finished,
      "hasPresenter": self.controller.presentingViewController != nil, "isBeingDismissed": self.controller.isBeingDismissed,
      "delegateRespondsToFinish": responds(to: #selector(SFSafariViewControllerDelegate.safariViewControllerDidFinish(_:))),
      "delegateStillInstalled": (self.controller.delegate as AnyObject?) === self])
    if let bytes = try? JSONSerialization.data(withJSONObject: rows, options: .sortedKeys) { try? bytes.write(to: file, options: .atomic) }
  }
#endif
  func cancel() { guard !finished else { return }; finished = true; controller.dismiss(animated: false); cancelled() }
}
