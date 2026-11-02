import UIKit

@main @MainActor final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    if Bundle.main.object(forInfoDictionaryKey: "UIApplicationSceneManifest") != nil { return true }
    let window = UIWindow(frame: UIScreen.main.bounds)
#if HYPERGOLIC_NETWORK_PROOF
    window.rootViewController = ProcessInfo.processInfo.arguments.contains("native-handoff-ui") ? NativeHandoffProbeController() : SignerProbeController()
#else
    window.rootViewController = SignerProbeController()
#endif
    self.window = window; window.makeKeyAndVisible(); return true
  }
  func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(name: "Native signer proof", sessionRole: session.role)
    configuration.delegateClass = NativeHandoffProofSceneDelegate.self; return configuration
  }
}
@MainActor final class NativeHandoffProofSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    let window = UIWindow(windowScene: scene)
#if HYPERGOLIC_NETWORK_PROOF
    window.rootViewController = ProcessInfo.processInfo.arguments.contains("native-handoff-ui") ? NativeHandoffProbeController() : SignerProbeController()
#else
    window.rootViewController = SignerProbeController()
#endif
    self.window = window; window.makeKeyAndVisible()
  }
}

@MainActor private final class SignerProbeController: UIViewController {
  private let owner = SignerOwner()
  private lazy var core = NativeSignerCore(owner: owner)
  private lazy var coordinator = NativeSignerReviewCoordinator(core: core, owner: owner, current: { true })
  private var pubkey: String?
  private let status = UILabel()
  override func viewDidLoad() {
    super.viewDidLoad(); view.backgroundColor = .systemBackground
    let generate = UIButton(type: .system)
    generate.setTitle("Generate disposable identity", for: .normal); generate.accessibilityIdentifier = "probe.generate"
    generate.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      do {
        self.pubkey = try self.coordinator.generate(); self.status.text = "Disposable identity ready"
      }
      catch { self.status.text = "Generate failed" }
    }, for: .touchUpInside)
    let activate = UIButton(type: .system)
    activate.setTitle("Activate new disposable signer", for: .normal); activate.accessibilityIdentifier = "probe.activate"
    activate.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      if self.core.isRevoked {
        self.core = NativeSignerCore(owner: self.owner)
        self.coordinator = NativeSignerReviewCoordinator(core: self.core, owner: self.owner, current: { true })
        self.pubkey = nil
      }
      self.status.text = "Disposable signer active"
    }, for: .touchUpInside)
    let review = UIButton(type: .system)
    review.setTitle("Review exact event", for: .normal); review.accessibilityIdentifier = "probe.review"
    review.addAction(UIAction { [weak self] _ in self?.review() }, for: .touchUpInside)
    status.accessibilityIdentifier = "probe.status"; status.numberOfLines = 0
    let stack = UIStackView(arrangedSubviews: [activate, generate, review, status])
    stack.axis = .vertical; stack.spacing = 24; stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 48)])
  }
  private func review() {
    guard let pubkey else { status.text = "Generate an identity first"; return }
    let content = "iOS native exact event 🛰️ /\u{2028}\u{2029}\n\t"
    let json = "{\"pubkey\":\"\(pubkey)\",\"created_at\":1791979200,\"kind\":1,\"tags\":[[\"r\",\"wss://example.com\"]],\"content\":\(ExactSignerEvent.quote(content))}"
    Task {
      do {
        let signed = try await coordinator.reviewAndSign(json, presenter: self)
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try Data(signed.utf8).write(to: documents.appendingPathComponent("signature.json"), options: .atomic)
        status.text = "Signed exact event once"
      } catch { status.text = "Review denied" }
    }
  }
}
