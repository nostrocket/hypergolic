import UIKit

/// Install once from the native app lifecycle owner before enabling identity actions.
/// Runtime teardown separately uses the registered main-runtime lifetime, not Module.OnDestroy.
@MainActor final class ApplicationIdentityLifecycle {
  private let authority: DeletionGrantAuthority
  private var observers: [any NSObjectProtocol] = []
  init(authority: DeletionGrantAuthority) {
    self.authority = authority
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [authority] _ in
      MainActor.assumeIsolated { authority.applicationWillResignActive() }
    })
    // Explicit background/protected-data loss revokes synchronously on the main notification queue.
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [authority] _ in
      authority.updateApplication(foreground: false, protectedData: false)
    })
    observers.append(center.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main) { [authority] _ in
      authority.updateApplication(foreground: false, protectedData: false)
    })
    for name in [UIApplication.didBecomeActiveNotification, UIApplication.protectedDataDidBecomeAvailableNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.refreshState() }
      })
    }
    refreshState()
    // Resign-active clears an already-visible secret panel. It does not revoke a pending LAContext prompt.
  }
  private func refreshState() {
    authority.updateApplication(foreground: UIApplication.shared.applicationState != .background,
      protectedData: UIApplication.shared.isProtectedDataAvailable)
  }
  func stop() {
    authority.updateApplication(foreground: false, protectedData: false)
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    observers.removeAll()
  }
}
