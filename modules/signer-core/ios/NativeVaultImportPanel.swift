import UIKit
#if canImport(HypergolicIdentityStore)
import HypergolicIdentityStore
#endif

@MainActor final class NativePrivateKeyField: UITextField {
  override var accessibilityValue: String? {
    get { "Private entry is hidden" }
    set { }
  }
  override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
    if action == #selector(copy(_:)) || action == #selector(cut(_:)) { return false }
    return super.canPerformAction(action, withSender: sender)
  }
}

/// Native entry owns all text, paste and validation. It emits a C key owner, never text or bytes.
@MainActor final class NativeVaultImportPanel: UIViewController {
  private let input = NativePrivateKeyField()
  private let status = UILabel()
  private let current: @Sendable () -> Bool
  private let complete: (NativeVaultKey?) -> Void
  init(current: @escaping @Sendable () -> Bool, complete: @escaping (NativeVaultKey?) -> Void) {
    self.current = current; self.complete = complete
    super.init(nibName: nil, bundle: nil); isModalInPresentation = true
  }
  required init?(coder: NSCoder) { nil }
  override func viewDidLoad() {
    super.viewDidLoad(); view.backgroundColor = .systemBackground
    let title = UILabel(); title.text = "Import an identity"; title.numberOfLines = 0
    title.font = .preferredFont(forTextStyle: .title2); title.adjustsFontForContentSizeCategory = true
    let explanation = UILabel(); explanation.text = "Enter your nsec here. Your private key stays in native storage. Import does not switch accounts until you confirm the transition."
    explanation.font = .preferredFont(forTextStyle: .body); explanation.numberOfLines = 0
    explanation.adjustsFontForContentSizeCategory = true
    input.isSecureTextEntry = true; input.placeholder = "nsec1…"
    input.autocorrectionType = .no; input.autocapitalizationType = .none; input.spellCheckingType = .no
    input.smartQuotesType = .no; input.smartDashesType = .no; input.smartInsertDeleteType = .no
    input.keyboardType = .asciiCapable; input.textContentType = nil
    input.borderStyle = .roundedRect; input.accessibilityLabel = "Private key input"
    input.accessibilityIdentifier = "native-vault.import-secret"
    input.font = .preferredFont(forTextStyle: .body); input.adjustsFontForContentSizeCategory = true
    input.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
    status.numberOfLines = 0; status.font = .preferredFont(forTextStyle: .body)
    status.accessibilityIdentifier = "native-vault.import-status"
    let cancel = UIButton(type: .system); cancel.setTitle("Cancel", for: .normal)
    cancel.accessibilityIdentifier = "native-vault.import-cancel"
    cancel.addAction(UIAction { [weak self] _ in self?.clear(); self?.complete(nil) }, for: .touchUpInside)
    let prepare = UIButton(type: .system); prepare.setTitle("Continue", for: .normal)
    prepare.accessibilityIdentifier = "native-vault.import-continue"
    prepare.addAction(UIAction { [weak self] _ in self?.prepare() }, for: .touchUpInside)
    for button in [cancel, prepare] { button.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true }
    let actions = UIStackView(arrangedSubviews: [cancel, prepare]); actions.distribution = .fillEqually
    let stack = UIStackView(arrangedSubviews: [title, explanation, input, status, actions])
    stack.axis = .vertical; stack.spacing = 24; stack.translatesAutoresizingMaskIntoConstraints = false
    let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll); scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
    ])
  }
  func clear() { input.text = nil; input.resignFirstResponder(); viewIfLoaded?.isHidden = true }
  private func prepare() {
    guard current(), UIApplication.shared.applicationState == .active else { clear(); complete(nil); return }
    do {
      guard let text = input.text, text.utf8.count <= 128 else { throw NativeVaultFailure.invalidInput }
      var secret = try NativeSignerSecretCodec.decodeNsec(text)
      defer { secret.resetBytes(in: 0..<secret.count) }
      let key = try NativeVaultKey(secret: secret)
      input.text = nil; input.resignFirstResponder()
      guard current() else { key.destroy(); clear(); complete(nil); return }
      complete(key)
    } catch { input.text = nil; status.text = "Enter a valid nsec private key." }
  }
}

/// Native opaque candidates are limited, expire independently and are consumed before commit.
final class NativeVaultCandidatePool: @unchecked Sendable {
  struct Candidate: Sendable {
    let handle: String; let pubkey: String; let key: NativeVaultKey
    let vaultID: String; let revision: UInt64; let epoch: UInt64; let expires: ContinuousClock.Instant
  }
  private let lock = NSLock()
  private var candidate: Candidate?
  private var consumed: Candidate?
  private let lifetime: Duration
  init() { lifetime = .seconds(120) }
  init(testingLifetime: Duration) { precondition(testingLifetime > .zero && testingLifetime <= .seconds(120)); lifetime = testingLifetime }
  func prepare(key: NativeVaultKey, vaultID: String, revision: UInt64, epoch: UInt64) throws -> String {
    try lock.withLock {
      candidate?.key.destroy(); consumed?.key.destroy(); consumed = nil; candidate = nil
      let row = Candidate(handle: UUID().uuidString.lowercased(), pubkey: try key.publicKey(), key: key,
        vaultID: vaultID, revision: revision, epoch: epoch, expires: .now.advanced(by: lifetime))
      candidate = row
      let parts = lifetime.components
      let delay = Double(parts.seconds) + Double(parts.attoseconds) / 1e18
      DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in self?.cancel(row.handle); row.key.destroy() }
      return String(decoding: try JSONSerialization.data(withJSONObject: ["handle": row.handle, "pubkey": row.pubkey]), as: UTF8.self)
    }
  }
  func take(handle: String, vaultID: String, revision: UInt64, epoch: UInt64) throws -> Candidate {
    try lock.withLock {
      guard let row = candidate, row.handle == handle else { throw NativeVaultFailure.denied }
      candidate = nil // A failed commit cannot replay its candidate.
      guard row.vaultID == vaultID, row.revision == revision, row.epoch == epoch,
        ContinuousClock.now < row.expires else { row.key.destroy(); throw NativeVaultFailure.stale }
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
