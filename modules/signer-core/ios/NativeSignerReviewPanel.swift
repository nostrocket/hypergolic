import UIKit

/// Native controls hold the private handle. Neither approval nor handles cross Expo.
@MainActor final class NativeSignerReviewPanel: UIViewController {
  private let event: ExactSignerEvent
  private let requester: String
  private let destinations: [String]
  private let method: String
  private let signerRelays: [String]
  private let signerPeer: String?
  private let reviewTitle: String
  private let decide: (Bool) -> Void
  private var decided = false
  init(review: SignerReview, decide: @escaping (Bool) -> Void) {
    event = review.event; requester = review.requester; destinations = []; method = "Disposable native key"
    signerRelays = []; signerPeer = nil; reviewTitle = "Review disposable signature"; self.decide = decide
    super.init(nibName: nil, bundle: nil)
    isModalInPresentation = true
  }
  init(event: ExactSignerEvent, requester: String, destinations: [String], method: String, signerRelays: [String] = [], signerPeer: String? = nil,
    decide: @escaping (Bool) -> Void) {
    self.event = event; self.requester = requester; self.destinations = destinations; self.method = method; self.signerRelays = signerRelays; self.signerPeer = signerPeer
    reviewTitle = "Review signature"; self.decide = decide
    super.init(nibName: nil, bundle: nil); isModalInPresentation = true
  }
  private func decideOnce(_ approved: Bool) {
    guard !decided else { return }; decided = true; decide(approved)
  }
  required init?(coder: NSCoder) { nil }
  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    let title = UILabel()
    title.text = reviewTitle
    title.font = UIFont.preferredFont(forTextStyle: .title2)
    title.adjustsFontForContentSizeCategory = true
    title.numberOfLines = 0
    let identity = UILabel()
    identity.text = "\(requester)\nSigning method: \(method)\nAction: Sign this exact event once." + (destinations.isEmpty ? " No publication is requested." : "\nDestinations:\n" + destinations.joined(separator: "\n")) + (signerRelays.isEmpty ? "" : "\nSigner peer:\n" + (signerPeer ?? "") + "\nSigner relays (private signing request):\n" + signerRelays.joined(separator: "\n"))
    identity.numberOfLines = 0
    identity.font = UIFont.preferredFont(forTextStyle: .body)
    identity.adjustsFontForContentSizeCategory = true
    let account = UILabel()
    account.text = "Account: " + event.pubkey
    account.numberOfLines = 0
    account.lineBreakMode = .byCharWrapping
    account.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont.monospacedSystemFont(ofSize: 15, weight: .regular))
    account.adjustsFontForContentSizeCategory = true
    account.accessibilityIdentifier = "signer.account"
    let details = UITextView()
    details.text = event.canonical
    details.isEditable = false
    details.isScrollEnabled = false
    details.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont.monospacedSystemFont(ofSize: 15, weight: .regular))
    details.adjustsFontForContentSizeCategory = true
    details.backgroundColor = .secondarySystemBackground
    details.accessibilityIdentifier = "signer.exactEvent"
    let reject = UIButton(type: .system)
    reject.setTitle("Reject", for: .normal)
    reject.accessibilityIdentifier = "signer.reject"
    reject.addAction(UIAction { [weak self] _ in self?.decideOnce(false) }, for: .touchUpInside)
    let approve = UIButton(type: .system)
    approve.setTitle("Approve once", for: .normal)
    approve.accessibilityIdentifier = "signer.approve"
    approve.addAction(UIAction { [weak self] _ in self?.decideOnce(true) }, for: .touchUpInside)
    for button in [reject, approve] {
      button.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
      button.titleLabel?.adjustsFontForContentSizeCategory = true
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
    }
    let actions = UIStackView(arrangedSubviews: [reject, approve])
    actions.distribution = .fillEqually; actions.spacing = 12
    let header = UIStackView(arrangedSubviews: [title, account, identity])
    header.axis = .vertical; header.spacing = 16
    let content = UIStackView(arrangedSubviews: [header, details])
    content.axis = .vertical; content.spacing = 20; content.translatesAutoresizingMaskIntoConstraints = false
    let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
    actions.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(content); view.addSubview(scroll); view.addSubview(actions)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
      scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
      scroll.bottomAnchor.constraint(equalTo: actions.topAnchor, constant: -20),
      content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
      actions.leadingAnchor.constraint(equalTo: scroll.leadingAnchor),
      actions.trailingAnchor.constraint(equalTo: scroll.trailingAnchor),
      actions.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
    ])
  }
}

/// Per-runtime native presenter. Runtime/lifecycle state is rechecked at the button and before delivery.
@MainActor final class NativeSignerReviewCoordinator {
  private let core: NativeSignerCore
  private let owner: SignerOwner
  private let current: @Sendable () -> Bool
  private var panel: NativeSignerReviewPanel?
  private var continuation: CheckedContinuation<String, any Error>?
  private var backgroundObserver: SignerBackgroundObservation?
  private var keyExpiry: Task<Void, Never>?
  private var expiry: Task<Void, Never>?
  private let keyLifetime: Duration
  init(core: NativeSignerCore, owner: SignerOwner, current: @escaping @Sendable () -> Bool, testingKeyLifetime: Duration? = nil) {
    self.core = core; self.owner = owner; self.current = current
    keyLifetime = testingKeyLifetime ?? NativeSignerCore.lifetime
    backgroundObserver = SignerBackgroundObservation(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification,
      object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.cancel(revoke: true) }
      })
  }
  deinit {
    expiry?.cancel(); keyExpiry?.cancel()
  }
  func generate() throws -> String {
    guard current(), UIApplication.shared.applicationState == .active else { throw SignerFailure.staleOwner }
    let pubkey = try core.generate(owner: owner)
    if keyExpiry == nil {
      let lifetime = keyLifetime
      keyExpiry = Task { [weak self] in
        do { try await Task.sleep(for: lifetime) } catch { return }
        self?.cancel(revoke: true, failure: .expired)
      }
    }
    return pubkey
  }
  func reviewAndSign(_ json: String, presenter: UIViewController) async throws -> String {
    guard current(), UIApplication.shared.applicationState == .active,
      presenter.viewIfLoaded?.window != nil else { throw SignerFailure.staleOwner }
    guard continuation == nil, presenter.presentedViewController == nil else { throw SignerFailure.busy }
    let review = try core.beginReview(owner: owner, unsignedJSON: json)
    return try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let panel = NativeSignerReviewPanel(review: review) { [weak self] approved in
        self?.decide(approved, review: review)
      }
      self.panel = panel
      presenter.present(panel, animated: true)
      expiry = Task { [weak self] in
        do { try await Task.sleep(for: NativeSignerCore.lifetime) } catch { return }
        self?.cancel(revoke: true, failure: .expired)
      }
    }
  }
  func cancel(revoke: Bool = false, failure: SignerFailure = .denied) {
    if revoke { core.revoke(); keyExpiry?.cancel(); keyExpiry = nil } else { core.cancelReview() }
    finish(.failure(failure))
  }
  private func decide(_ approved: Bool, review: SignerReview) {
    guard current(), UIApplication.shared.applicationState == .active,
      panel?.viewIfLoaded?.window != nil else { cancel(revoke: true, failure: .staleOwner); return }
    do {
      guard approved else {
        try core.reject(owner: owner, handle: review.handle)
        finish(.failure(SignerFailure.denied)); return
      }
      let signed = try core.approveAndSign(owner: owner, handle: review.handle)
      guard current(), UIApplication.shared.applicationState == .active else { cancel(revoke: true, failure: .staleOwner); return }
      finish(.success(signed))
    } catch { finish(.failure(error)) }
  }
  private func finish(_ result: Result<String, any Error>) {
    expiry?.cancel(); expiry = nil
    let pending = continuation; continuation = nil
    let presented = panel; panel = nil
    // The promise resolves after the trusted sheet leaves the screen.
    if let presented, presented.presentingViewController != nil {
      presented.dismiss(animated: true) { [weak self] in
        guard let self else { pending?.resume(throwing: SignerFailure.staleOwner); return }
        self.deliver(result, pending: pending)
      }
    } else { deliver(result, pending: pending) }
  }
  private func deliver(_ result: Result<String, any Error>, pending: CheckedContinuation<String, any Error>?) {
    if case .success = result, (!current() || core.isRevoked || UIApplication.shared.applicationState != .active) {
      pending?.resume(throwing: SignerFailure.staleOwner)
    } else { pending?.resume(with: result) }
  }
}

/// NotificationCenter tokens are removable from any thread; keep actor state out of destruction.
private final class SignerBackgroundObservation: @unchecked Sendable {
  private let token: any NSObjectProtocol
  init(_ token: any NSObjectProtocol) { self.token = token }
  deinit { NotificationCenter.default.removeObserver(token) }
}
