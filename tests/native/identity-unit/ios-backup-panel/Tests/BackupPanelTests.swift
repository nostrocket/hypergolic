import UIKit
import XCTest
@testable import BackupPanelProbe

@MainActor
final class BackupPanelTests: XCTestCase {
  // PUBLIC test fixture: secp256k1 scalar 2. It is not an application identity.
  private let publicScalar2 = Data(repeating: 0, count: 31) + Data([2])

  @MainActor final class AuthenticationDouble {
    private(set) var calls = 0
    func authenticate() async throws { calls += 1 }
  }

  final class LivenessDouble: @unchecked Sendable {
    private let lock = NSLock()
    private var allowed = true
    func get() -> Bool { lock.withLock { allowed } }
    func deny() { lock.withLock { allowed = false } }
  }

  final class Completion: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<Void, Error>?
    func set(_ result: Result<Void, Error>) { lock.withLock { value = result } }
    func get() -> Result<Void, Error>? { lock.withLock { value } }
  }

  override func tearDown() async throws {
    NativeBackupPanelProcess.shared.cancelBackupPresentation(attemptID: 1)
    NativeBackupPanelProcess.shared.cancelBackupPresentation(attemptID: 2)
    NativeBackupPanelProcess.shared.cancelBackupPresentation(attemptID: 3)
    try await until("panel dismissal") { self.host.presentedViewController == nil }
  }

  func testInitialContentAccessibilityLargeTextAndDoneCompletion() async throws {
    let authentication = AuthenticationDouble(), liveness = LivenessDouble(), completion = Completion()
    let task = reveal(id: 1, authentication: authentication, liveness: liveness, completion: completion)
    let controller = try await presentedController()
    let initial = labels(in: controller.view).compactMap(\.text)
    XCTAssertFalse(initial.contains { $0.hasPrefix("nsec1") }, "Secret must not exist in the view before presentation completion")

    let expected = try NostrSecretBech32.encode(publicScalar2)
    XCTAssertEqual(expected, "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqpqptcfk2")
    try await until("nsec reveal after presentation") {
      self.labels(in: controller.view).contains { $0.text == expected }
    }
    let secret = try XCTUnwrap(labels(in: controller.view).first { $0.text == expected })
    XCTAssertFalse(secret.isAccessibilityElement)
    XCTAssertEqual(secret.superview?.accessibilityElementsHidden, true)
    XCTAssertEqual(authentication.calls, 1)
    XCTAssertNil(completion.get(), "Promise completed while the native panel was still visible")

    controller.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
    controller.view.setNeedsLayout(); controller.view.layoutIfNeeded()
    let button = try XCTUnwrap(descendants(of: controller.view).compactMap { $0 as? UIButton }
      .first { $0.title(for: .normal) == "Done" })
    let scroll = try XCTUnwrap(descendants(of: controller.view).compactMap { $0 as? UIScrollView }.first)
    let target = button.convert(button.bounds, to: scroll)
    scroll.scrollRectToVisible(target, animated: false); scroll.layoutIfNeeded()
    XCTAssertGreaterThanOrEqual(button.bounds.height, 44)
    XCTAssertTrue(scroll.bounds.intersects(button.convert(button.bounds, to: scroll)), "Done must remain scroll-reachable at AX XXXL")

    button.sendActions(for: .touchUpInside)
    try await until("dismissal and promise completion") {
      self.host.presentedViewController == nil && completion.get() != nil
    }
    if case .failure(let error) = completion.get() { XCTFail("Done failed: \(error)") }
    await task.value
  }

  func testImmediateCancelDuringAnimatedPresentationClearsAndRejects() async throws {
    let authentication = AuthenticationDouble(), liveness = LivenessDouble(), completion = Completion()
    let task = reveal(id: 2, authentication: authentication, liveness: liveness, completion: completion)
    let controller = try await presentedController()
    let secret = try XCTUnwrap(labels(in: controller.view).first { $0.superview?.accessibilityElementsHidden == true })
    XCTAssertEqual(secret.text, "Preparing protected backup…")
    NativeBackupPanelProcess.shared.cancelBackupPresentation(attemptID: 2)
    XCTAssertNil(secret.text, "Cancellation must clear text synchronously")
    XCTAssertTrue(secret.superview?.isHidden == true)
    XCTAssertTrue(controller.view.isHidden)
    XCTAssertNil(completion.get(), "Promise must wait for dismissal completion")
    try await until("cancel dismissal") { self.host.presentedViewController == nil && completion.get() != nil }
    assertDenied(completion.get())
    await task.value
  }

  func testResignActiveClearsSynchronouslyBeforeDismissalCompletes() async throws {
    let authentication = AuthenticationDouble(), liveness = LivenessDouble(), completion = Completion()
    let task = reveal(id: 3, authentication: authentication, liveness: liveness, completion: completion)
    let controller = try await presentedController()
    let expected = try NostrSecretBech32.encode(publicScalar2)
    try await until("revealed secret") { self.labels(in: controller.view).contains { $0.text == expected } }
    let secret = try XCTUnwrap(labels(in: controller.view).first { $0.text == expected })
    NativeBackupPanelProcess.shared.applicationWillResignActive()
    XCTAssertNil(secret.text, "Resign-active must clear text synchronously")
    XCTAssertTrue(secret.superview?.isHidden == true)
    XCTAssertTrue(controller.view.isHidden)
    XCTAssertNil(completion.get(), "Promise must wait for dismissal completion")
    try await until("background dismissal") { self.host.presentedViewController == nil && completion.get() != nil }
    assertDenied(completion.get())
    await task.value
  }

  private func reveal(id: UInt64, authentication: AuthenticationDouble, liveness: LivenessDouble,
    completion: Completion) -> Task<Void, Never> {
    Task { @MainActor in
      do {
        try await authentication.authenticate()
        try await SystemNativeBackupPresenter().presentBackup(attemptID: id, secret: publicScalar2) {
          liveness.get()
        }
        completion.set(.success(()))
      } catch { completion.set(.failure(error)) }
    }
  }

  private var host: UIViewController {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows).first(where: \.isKeyWindow)!.rootViewController!
  }
  private func presentedController() async throws -> UIViewController {
    try await until("native panel presentation") { self.host.presentedViewController != nil }
    return try XCTUnwrap(host.presentedViewController)
  }
  private func descendants(of view: UIView) -> [UIView] {
    [view] + view.subviews.flatMap(descendants(of:))
  }
  private func labels(in view: UIView) -> [UILabel] { descendants(of: view).compactMap { $0 as? UILabel } }
  private func until(_ description: String, timeout: TimeInterval = 4,
    _ condition: @escaping @MainActor () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
      if Date() >= deadline { XCTFail("Timed out: \(description)"); return }
      try await Task.sleep(for: .milliseconds(10))
    }
  }
  private func assertDenied(_ result: Result<Void, Error>?) {
    guard case .failure(let error) = result else { XCTFail("Expected native denial"); return }
    XCTAssertEqual(error as? DeletionActionFailure, .denied)
  }
}
