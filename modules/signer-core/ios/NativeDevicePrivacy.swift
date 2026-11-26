import ExpoModulesCore
import LocalAuthentication
import UIKit

@MainActor final class NativeDevicePrivacy {
  static let shared = NativeDevicePrivacy()
  private let preferences = UserDefaults.standard
  private let lockKey = "hypergolic.workspace-lock.v1"
  private var locked = true
  private var away: ContinuousClock.Instant?
  private var curtain: UIWindow?
  private var signingOperation: UUID?
  private var authentication: LAContext?
  private var generation = 0
  private var installed = false
  private var opening: CheckedContinuation<Bool, Never>?
  var enabled: Bool { preferences.bool(forKey: lockKey) }
  var accessible: Bool { !enabled || !locked }
  private var scene: UIWindowScene? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.session.role == .windowApplication }
  }

  func prepare() async -> Bool {
    if !installed {
      installed = true
      let center = NotificationCenter.default
      for (name, selector) in [
        (UIScene.willDeactivateNotification, #selector(inactive)),
        (UIScene.didEnterBackgroundNotification, #selector(background)),
        (UIScene.didActivateNotification, #selector(active)),
        (UIApplication.protectedDataWillBecomeUnavailableNotification, #selector(lockNow))
      ] { center.addObserver(self, selector: selector, name: name, object: nil) }
    }
    if accessible { return true }
    show()
    return await withCheckedContinuation { reply in
      opening?.resume(returning: false)
      opening = reply
    }
  }

  @objc func lockNow() {
    generation += 1
    authentication?.invalidate()
    locked = true
    if enabled { show() }
  }
  @objc private func inactive() { if enabled { show() } }
  @objc private func background() {
    if away == nil { away = .now }
    generation += 1
    authentication?.invalidate()
    if enabled { show() }
  }
  @objc private func active() {
    if let away, away.duration(to: .now) >= .seconds(60) { locked = true }
    away = nil
    if enabled && locked { show() } else { hide() }
  }

  private func show() {
    guard curtain == nil, let scene else { return }
    let window = UIWindow(windowScene: scene)
    let view = UIViewController()
    view.view.backgroundColor = .systemBackground
    let button = UIButton(type: .system)
    button.setTitle("Unlock Hypergolic", for: .normal)
    button.titleLabel?.font = .preferredFont(forTextStyle: .title2)
    button.titleLabel?.adjustsFontForContentSizeCategory = true
    button.addAction(UIAction { [weak self] _ in
      Task { @MainActor in
        guard let self, await self.confirm("Unlock your Hypergolic workspace.") else { return }
        self.locked = false
        self.hide()
        self.opening?.resume(returning: true)
        self.opening = nil
      }
    }, for: .touchUpInside)
    button.translatesAutoresizingMaskIntoConstraints = false
    view.view.addSubview(button)
    NSLayoutConstraint.activate([button.centerXAnchor.constraint(equalTo: view.view.centerXAnchor),
      button.centerYAnchor.constraint(equalTo: view.view.centerYAnchor), button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48)])
    window.rootViewController = view
    window.windowLevel = .alert + 2
    window.accessibilityViewIsModal = true
    curtain = window
    window.isHidden = false
    if locked { window.makeKey() }
  }
  private func hide() {
    guard let window = curtain else { return }
    window.isHidden = true
    curtain = nil
    scene?.windows.first { !$0.isHidden && $0.windowLevel == .normal }?.makeKey()
  }

  func cancelSigning(_ operation: UUID) {
    if signingOperation == operation { authentication?.invalidate() }
  }
  func confirm(_ reason: String, operation: UUID? = nil) async -> Bool {
    guard authentication == nil, scene?.activationState == .foregroundActive,
      UIApplication.shared.isProtectedDataAvailable else { return false }
    let context = LAContext(), attempt = generation
    context.touchIDAuthenticationAllowableReuseDuration = 0
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return false }
    authentication = context
    signingOperation = operation
    defer { context.invalidate(); authentication = nil; signingOperation = nil }
    guard (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) == true else { return false }
    let deadline = ContinuousClock.now.advanced(by: .seconds(2))
    while scene?.activationState == .foregroundInactive && ContinuousClock.now < deadline {
      do { try await Task.sleep(for: .milliseconds(30)) } catch { return false }
    }
    return !Task.isCancelled && attempt == generation && scene?.activationState == .foregroundActive && UIApplication.shared.isProtectedDataAvailable
  }

  func requiresSigning(_ pubkey: String, external: Bool) -> Bool {
    preferences.bool(forKey: signingKey(pubkey, external))
  }
  private func signingKey(_ pubkey: String, _ external: Bool) -> String {
    "hypergolic.sign-confirm.v1." + (external ? "external." : "local.") + pubkey
  }
  func configure(_ mode: String, pubkey: String, enabled value: Bool) async -> Bool {
    let action = value ? "Enable" : "Disable"
    let target = mode == "workspace" ? "workspace lock" : "\(mode) signing confirmation for \(pubkey)"
    guard accessible, pubkey.count == 64, pubkey.allSatisfy({ "0123456789abcdef".contains($0) }),
      ["workspace", "local", "external"].contains(mode),
      await confirm("\(action) \(target)."), accessible else { return false }
    if mode == "workspace" {
      locked = false
      preferences.set(value, forKey: lockKey)
      hide()
    } else { preferences.set(value, forKey: signingKey(pubkey, mode == "external")) }
    return true
  }
}

public final class HypergolicDevicePrivacyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HypergolicDevicePrivacy")
    AsyncFunction("prepare") { () async -> Bool in await NativeDevicePrivacy.shared.prepare() }
    AsyncFunction("preferences") { (pubkey: String) async -> [String: Bool] in
      await MainActor.run {
        let privacy = NativeDevicePrivacy.shared
        return ["workspace": privacy.enabled, "local": privacy.requiresSigning(pubkey, external: false),
          "external": privacy.requiresSigning(pubkey, external: true)]
      }
    }
    AsyncFunction("configure") { (mode: String, pubkey: String, enabled: Bool) async -> Bool in
      await NativeDevicePrivacy.shared.configure(mode, pubkey: pubkey, enabled: enabled)
    }
    AsyncFunction("lock") { () async in await NativeDevicePrivacy.shared.lockNow() }
  }
}
