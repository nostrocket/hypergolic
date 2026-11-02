import UIKit

struct SystemNativeBackupPresenter: NativeBackupPresenter {
  @MainActor func presentBackup(attemptID: UInt64, secret: Data,
    canPresent: @escaping @Sendable () -> Bool) async throws {
    try await NativeBackupPanelProcess.shared.presentBackup(attemptID: attemptID, secret: secret, canPresent: canPresent)
  }
  @MainActor func cancelBackupPresentation(attemptID: UInt64) {
    NativeBackupPanelProcess.shared.cancelBackupPresentation(attemptID: attemptID)
  }
  @MainActor func applicationWillResignActive() {
    NativeBackupPanelProcess.shared.applicationWillResignActive()
  }
}

/// The only production nsec reveal surface. It has no copy, share, logging or accessibility export action.
@MainActor final class NativeBackupPanelProcess: NSObject, NativeBackupPresenter, UIAdaptivePresentationControllerDelegate {
  static let shared = NativeBackupPanelProcess()
  private struct Pending {
    let id: UInt64
    let controller: UIViewController
    let secretContainer: UIView
    let secretLabel: UILabel
    let nsec: String
    let canPresent: @Sendable () -> Bool
    let continuation: CheckedContinuation<Void, any Error>
    let captureObserver: any NSObjectProtocol
  }
  private var pending: Pending?

  func presentBackup(attemptID: UInt64, secret: Data,
    canPresent: @escaping @Sendable () -> Bool) async throws {
    guard pending == nil, canPresent(), !Task.isCancelled,
      UIApplication.shared.applicationState == .active,
      !Self.anyScreenCaptured,
      let host = Self.presentationHost() else { throw DeletionActionFailure.unavailable }
    var ownedSecret = secret
    defer { ownedSecret.resetBytes(in: 0..<ownedSecret.count) }
    let nsec = try NostrSecretBech32.encode(ownedSecret)
    let (controller, container, label) = panel(nsec: nsec)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let observer = NotificationCenter.default.addObserver(forName: UIScreen.capturedDidChangeNotification,
          object: nil, queue: .main) { [weak self] _ in
          MainActor.assumeIsolated { self?.refreshCaptureState() }
        }
        pending = Pending(id: attemptID, controller: controller, secretContainer: container,
          secretLabel: label, nsec: nsec, canPresent: canPresent,
          continuation: continuation, captureObserver: observer)
        controller.presentationController?.delegate = self
        host.present(controller, animated: true) { [weak self] in
          guard let self, self.pending?.id == attemptID, canPresent(), !Task.isCancelled,
            UIApplication.shared.applicationState == .active, !Self.anyScreenCaptured else {
            self?.finish(attemptID: attemptID, error: DeletionActionFailure.denied)
            return
          }
          self.refreshCaptureState()
        }
      }
    } onCancel: { [weak self] in
      Task { @MainActor in self?.cancelBackupPresentation(attemptID: attemptID) }
    }
  }

  func cancelBackupPresentation(attemptID: UInt64) {
    finish(attemptID: attemptID, error: DeletionActionFailure.denied)
  }

  func applicationWillResignActive() {
    guard let id = pending?.id else { return }
    // Clear synchronously before UIKit can take an app-switcher snapshot.
    finish(attemptID: id, error: DeletionActionFailure.denied)
  }

  @objc private func closePanel() {
    guard let id = pending?.id else { return }
    finish(attemptID: id, error: nil)
  }

  private func finish(attemptID: UInt64, error: (any Error)?) {
    guard let current = pending, current.id == attemptID else { return }
    current.secretLabel.text = nil
    current.secretContainer.isHidden = true
    current.controller.view.isHidden = true
    pending = nil
    NotificationCenter.default.removeObserver(current.captureObserver)
    let resume = {
      if let error { current.continuation.resume(throwing: error) }
      else { current.continuation.resume() }
    }
    if current.controller.presentingViewController != nil {
      current.controller.dismiss(animated: false, completion: resume)
    } else {
      resume()
    }
  }

  private func refreshCaptureState() {
    guard let pending else { return }
    guard pending.canPresent(), UIApplication.shared.applicationState == .active else {
      finish(attemptID: pending.id, error: DeletionActionFailure.denied)
      return
    }
    if Self.anyScreenCaptured {
      pending.secretLabel.text = "Hidden while screen recording or mirroring is active."
    } else {
      pending.secretLabel.text = pending.nsec
    }
  }

  private func panel(nsec: String) -> (UIViewController, UIView, UILabel) {
    let controller = UIViewController()
    controller.modalPresentationStyle = .pageSheet
    controller.isModalInPresentation = true
    controller.view.backgroundColor = .systemBackground

    let title = UILabel(), warning = UILabel(), secretContainer = UIView(), secret = UILabel()
    title.text = "Identity backup"
    title.font = .preferredFont(forTextStyle: .title2)
    title.adjustsFontForContentSizeCategory = true
    title.textAlignment = .center
    warning.text = "Keep this nsec private. Anyone with it can control your identity. iOS cannot prevent screenshots, so check your surroundings before revealing it."
    warning.font = .preferredFont(forTextStyle: .body)
    warning.adjustsFontForContentSizeCategory = true
    warning.numberOfLines = 0
    warning.textAlignment = .center
    // Never populate the secret before presentation completes and capture/liveness is rechecked.
    secret.text = "Preparing protected backup…"
    secret.font = .monospacedSystemFont(ofSize: 16, weight: .semibold)
    secret.numberOfLines = 0
    secret.textAlignment = .center
    secret.lineBreakMode = .byCharWrapping
    secret.isAccessibilityElement = false
    secretContainer.accessibilityElementsHidden = true
    secretContainer.backgroundColor = .secondarySystemBackground
    secretContainer.layer.cornerRadius = 12
    secretContainer.addSubview(secret)
    secret.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      secret.leadingAnchor.constraint(equalTo: secretContainer.leadingAnchor, constant: 16),
      secret.trailingAnchor.constraint(equalTo: secretContainer.trailingAnchor, constant: -16),
      secret.topAnchor.constraint(equalTo: secretContainer.topAnchor, constant: 16),
      secret.bottomAnchor.constraint(equalTo: secretContainer.bottomAnchor, constant: -16),
    ])
    let close = UIButton(type: .system)
    close.setTitle("Done", for: .normal)
    close.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    close.addTarget(self, action: #selector(closePanel), for: .touchUpInside)
    close.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    let stack = UIStackView(arrangedSubviews: [title, warning, secretContainer, close])
    stack.axis = .vertical; stack.spacing = 24; stack.alignment = .fill
    let scroll = UIScrollView()
    scroll.alwaysBounceVertical = true
    controller.view.addSubview(scroll)
    scroll.addSubview(stack)
    scroll.translatesAutoresizingMaskIntoConstraints = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    let safeArea = controller.view.safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: safeArea.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: safeArea.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: safeArea.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: safeArea.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
    ])
    return (controller, secretContainer, secret)
  }

  private static func presentationHost() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
    guard let root = scenes.flatMap({ $0.windows }).first(where: { $0.isKeyWindow })?.rootViewController else { return nil }
    var current = root
    while true {
      if let presented = current.presentedViewController { current = presented; continue }
      if let navigation = current as? UINavigationController, let visible = navigation.visibleViewController {
        current = visible; continue
      }
      if let tabs = current as? UITabBarController, let selected = tabs.selectedViewController {
        current = selected; continue
      }
      return current
    }
  }
  private static var anyScreenCaptured: Bool {
    UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.screen }
      .contains(where: \.isCaptured)
  }
}
