import Foundation
import ExpoModulesCore
import UIKit
import HypergolicIdentityStore
import HypergolicNappletHost

@MainActor final class NativeVaultSession {
  let authority: NativeVaultRuntimeAuthority
  let candidates: NativeVaultCandidatePool
  let remoteCandidates: NativeVaultRemoteCandidates
  private let handoffs: NativeNip46HandoffRegistry
  private let launch = NativeVaultLaunchGate()
  private var safari: NativeVaultSafariPanel?
  private weak var context: AppContext?
  private let core = NativeVaultCore.shared
  private var observations: [VaultObservation] = []
  private var importPanel: NativeVaultImportPanel?
  private var importReply: CheckedContinuation<String?, any Error>?
  private var remotePanel: NativeVaultRemotePanel?
  private var remoteOperation: UUID?
  private var remoteReply: CheckedContinuation<String?, any Error>?
  private var remoteTask: Task<Void, Never>?
  private var signTask: Task<Void, Never>?
  private var signDispatchState: NativeNip46DispatchState?
  private var signPanel: NativeSignerReviewPanel?
  private var signOperation: UUID?
  private var signReply: CheckedContinuation<String, any Error>?
  private var signSource: NativeSigningSourceCapture?
  private var signKind: String?
  private var signToken: String?
  private var timer: Task<Void, Never>?
  private var authentication: (NativeSignerIdentityActions.Action, UInt64)?
  private var nextAttempt: UInt64 = 0
  private var confirmation: UIAlertController?
  private var confirmReply: CheckedContinuation<Bool, Never>?
  private var confirmationTimer: Task<Void, Never>?

  init(context: AppContext, authority: NativeVaultRuntimeAuthority, candidates: NativeVaultCandidatePool, remoteCandidates: NativeVaultRemoteCandidates, handoffs: NativeNip46HandoffRegistry) {
    self.context = context; self.authority = authority; self.candidates = candidates; self.remoteCandidates = remoteCandidates; self.handoffs = handoffs
    let center = NotificationCenter.default
    observations = [
      VaultObservation(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.resignActive() }
      }),
      VaultObservation(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.background() }
      }),
      VaultObservation(center.addObserver(forName: UIApplication.protectedDataWillBecomeUnavailableNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.background() }
      }),
      VaultObservation(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.refresh(); self?.launch.changed() }
      }),
    ]
    refresh()
  }
  deinit { timer?.cancel(); confirmationTimer?.cancel(); remoteTask?.cancel(); signTask?.cancel() }
  private func refresh() {
    authority.update(foreground: UIApplication.shared.applicationState == .active,
      protectedData: UIApplication.shared.isProtectedDataAvailable)
  }
  private func resignActive() {
    NativeSignerIdentityActions.clearBackup()
    if authentication == nil { background() } else { cancelImport(); cancelSigning() }
  }
  private func background() {
    authority.update(foreground: false, protectedData: false)
    cancelAll()
  }
  private func activeEpoch() throws -> UInt64 {
    refresh()
    let epoch = try authority.epoch()
    guard authority.current(epoch), UIApplication.shared.applicationState == .active else { throw NativeVaultFailure.denied }
    return epoch
  }
  private func current(_ epoch: UInt64) -> @Sendable () -> Bool {
    let authority = authority
    return { authority.current(epoch) }
  }
  private func idle() throws {
    guard !launch.isOpening, importReply == nil, remoteReply == nil, signReply == nil, authentication == nil, confirmation == nil, safari == nil else { throw NativeVaultFailure.busy }
  }
  private func presenter() throws -> UIViewController {
    guard let host = context?.utilities?.currentViewController(), host.viewIfLoaded?.window != nil,
      host.presentedViewController == nil else { throw NativeVaultFailure.unavailable }
    return host
  }
  func open() async throws -> String {
    try idle(); refresh()
    let epoch = try authority.epoch()
    return try await launch.open(state: { [self] in
      guard authority.current(epoch, requireForeground: false), UIApplication.shared.isProtectedDataAvailable,
        UIApplication.shared.applicationState != .background else { return .denied }
      return UIApplication.shared.applicationState == .active ? .ready : .waiting
    }) { [self] in
      guard try activeEpoch() == epoch else { throw NativeVaultFailure.denied }
      return try await core.open(authority: authority.permit(epoch), current: current(epoch))
    }
  }
  func methods(pubkey: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); let epoch = try activeEpoch()
    // Read-only metadata does not cancel, rotate or extend any prepared candidate.
    return try await core.methods(pubkey: pubkey, vaultID: vaultID, revision: revision, current: current(epoch))
  }
  func prepareImport(vaultID: String, revision: UInt64) async throws -> String? {
    try idle(); let epoch = try activeEpoch()
    _ = try await core.snapshot(vaultID: vaultID, revision: revision, current: current(epoch))
    let host = try presenter(); candidates.cancelAll(); remoteCandidates.cancelAll()
    return try await withCheckedThrowingContinuation { reply in
      importReply = reply
      let panel = NativeVaultImportPanel(current: current(epoch)) { [weak self] key in
        self?.completeImport(key, vaultID: vaultID, revision: revision, epoch: epoch)
      }
      importPanel = panel; host.present(panel, animated: true)
      timer = Task { [weak self] in
        do { try await Task.sleep(for: .seconds(120)) } catch { return }
        self?.cancelImport()
      }
    }
  }
  private func completeImport(_ key: NativeVaultKey?, vaultID: String, revision: UInt64, epoch: UInt64) {
    guard let reply = importReply else { key?.destroy(); return }
    timer?.cancel(); timer = nil
    importReply = nil; let panel = importPanel; importPanel = nil
    panel?.clear()
    let deliver = { [weak self] in
      guard let self, self.authority.current(epoch) else { key?.destroy(); reply.resume(throwing: NativeVaultFailure.denied); return }
      do {
        let result = try key.map { try self.candidates.prepare(key: $0, vaultID: vaultID, revision: revision, epoch: epoch) }
        reply.resume(returning: result)
      } catch { key?.destroy(); reply.resume(throwing: error) }
    }
    if let panel, panel.presentingViewController != nil { panel.dismiss(animated: true, completion: deliver) } else { deliver() }
  }
  func prepareRemote(vaultID: String, revision: UInt64, attemptID: String) async throws -> String? {
    try idle(); let epoch = try activeEpoch(), deadline = ContinuousClock.now.advanced(by: .seconds(120))
    _ = try await core.snapshot(vaultID: vaultID, revision: revision, current: current(epoch))
    let host = try presenter(); candidates.cancelAll(); remoteCandidates.cancelAll()
    let operation = UUID()
    return try await withCheckedThrowingContinuation { reply in
      remoteOperation = operation; remoteReply = reply
      let panel = NativeVaultRemotePanel(current: current(epoch)) { [weak self] connection in
        self?.startRemoteHandshake(connection, vaultID: vaultID, revision: revision, epoch: epoch, deadline: deadline, attemptID: attemptID, operation: operation)
      }
      remotePanel = panel; host.present(panel, animated: true)
      timer = Task { [weak self] in
        do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
        self?.cancelRemotePreparation(operation: operation, failure: .signerExpired)
      }
    }
  }
  private func startRemoteHandshake(_ connection: NativeBunkerConnection?, vaultID: String, revision: UInt64,
    epoch: UInt64, deadline: ContinuousClock.Instant, attemptID: String, operation: UUID) {
    guard remoteOperation == operation, remoteReply != nil else { var stale = connection; stale?.clear(); return }
    guard let connection else { cancelRemotePreparation(operation: operation); return }
    let panel = remotePanel; remotePanel = nil; panel?.clear()
    let start = { [weak self] in
      guard let self, remoteOperation == operation, remoteReply != nil else { var stale = connection; stale.clear(); return }
      remoteTask = Task { [weak self] in
        var connection = connection
        defer { connection.clear() }
        guard let self, remoteOperation == operation, remoteReply != nil, !Task.isCancelled else { return }
        do {
          let key = try NativeVaultKey(); var transferred = false
          defer { if !transferred { key.destroy() } }
          let checker: @Sendable () -> Bool = { [authority] in authority.current(epoch) && ContinuousClock.now < deadline }
          let permit = authority.permit(epoch, deadline: deadline)
          let ticket = makeHandoff(binding: .preparation(vaultID: vaultID, revision: revision, attemptID: attemptID, refresh: false), deadline: deadline, current: checker)
          let bound = try await NativeNip46Client(key: key, peer: connection.peer, handoff: ticket).handshake(token: connection.token,
            relays: connection.relays, deadline: deadline, current: checker, dispatch: { emit in try permit.performMutation { emit() } })
          guard checker(), !Task.isCancelled, remoteOperation == operation, remoteReply != nil else { throw NativeVaultFailure.signerExpired }
          do { let info = try await methodInfo(pubkey: bound.pubkey, vaultID: vaultID, revision: revision, epoch: epoch)
            guard info.remote == nil else { throw NativeVaultFailure.signerAlreadyConnected }
          } catch NativeVaultFailure.notFound { }
          guard checker(), !Task.isCancelled, remoteOperation == operation, remoteReply != nil else { throw NativeVaultFailure.signerExpired }
          let result = try remoteCandidates.prepare(pubkey: bound.pubkey, peer: connection.peer, relays: bound.relays,
            key: key, vaultID: vaultID, revision: revision, epoch: epoch, expires: deadline)
          transferred = true; finishRemotePreparation(.success(result), operation: operation)
        } catch { finishRemotePreparation(.failure(error), operation: operation) }
      }
    }
    if let panel, panel.presentingViewController != nil { panel.dismiss(animated: true, completion: start) } else { start() }
  }
  private func finishRemotePreparation(_ result: Result<String?, any Error>, operation: UUID) {
    guard remoteOperation == operation, let reply = remoteReply else { return }
    remoteOperation = nil; remoteReply = nil; remoteTask = nil; timer?.cancel(); timer = nil
    if case .failure = result { cancelAll() }
    reply.resume(with: result)
  }
  private func cancelRemotePreparation(operation: UUID? = nil, failure: NativeVaultFailure? = nil) {
    guard let currentOperation = remoteOperation, operation == nil || operation == currentOperation else { return }
    remoteCandidates.cancelAll(); remoteTask?.cancel(); remoteTask = nil
    let panel = remotePanel; remotePanel = nil; panel?.clear(); panel?.dismiss(animated: false)
    finishRemotePreparation(failure.map { .failure($0) } ?? .success(nil), operation: currentOperation)
  }
  func prepareRemoteRefresh(pubkey: String, vaultID: String, revision: UInt64, attemptID: String) async throws -> String? {
    try idle(); let epoch = try activeEpoch(), deadline = ContinuousClock.now.advanced(by: .seconds(120))
    let capability = try await core.remoteCapability(pubkey: pubkey, vaultID: vaultID, revision: revision, current: current(epoch))
    var transferred = false; defer { if !transferred { capability.key.destroy() } }
    guard await confirm(title: "Check signer relays?", message: "Account:\n" + pubkey + "\nSigner peer:\n" + capability.peer + "\nCurrent signer relays:\n" + capability.relays.joined(separator: "\n"), approve: "Check relays", deadline: deadline),
      authority.current(epoch), ContinuousClock.now < deadline else { throw NativeVaultFailure.denied }
    candidates.cancelAll(); remoteCandidates.cancelAll()
    let operation = UUID()
    let result: String? = try await withCheckedThrowingContinuation { reply in
      remoteOperation = operation; remoteReply = reply
      remoteTask = Task { [weak self] in
        guard let self else { reply.resume(throwing: NativeVaultFailure.denied); return }
        guard remoteOperation == operation, remoteReply != nil, !Task.isCancelled else { return }
        do {
          let checker: @Sendable () -> Bool = { [authority] in authority.current(epoch) && ContinuousClock.now < deadline }
          let permit = authority.permit(epoch, deadline: deadline)
          let ticket = makeHandoff(binding: .preparation(vaultID: vaultID, revision: revision, attemptID: attemptID, refresh: true), deadline: deadline, current: checker)
          let proposed = try await NativeNip46Client(key: capability.key, peer: capability.peer, handoff: ticket).refresh(pubkey: pubkey,
            relays: capability.relays, deadline: deadline, current: checker, dispatch: { emit in try permit.performMutation { emit() } })
          guard checker(), !Task.isCancelled, remoteOperation == operation, remoteReply != nil else { throw NativeVaultFailure.signerExpired }
          guard let proposed else {
            _ = await confirm(title: "No relay changes", message: "Your saved signer relays are current.", approve: "Done", deadline: deadline)
            guard checker(), !Task.isCancelled, remoteOperation == operation, remoteReply != nil else { throw NativeVaultFailure.signerExpired }
            finishRemotePreparation(.success(nil), operation: operation); return
          }
          let prepared = try remoteCandidates.prepare(pubkey: pubkey, peer: capability.peer, relays: proposed, key: capability.key,
            vaultID: vaultID, revision: revision, epoch: epoch, expires: deadline, purpose: .refresh)
          finishRemotePreparation(.success(prepared), operation: operation)
        } catch { finishRemotePreparation(.failure(error), operation: operation) }
      }
      timer = Task { [weak self] in
        do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
        self?.cancelRemotePreparation(operation: operation, failure: .signerExpired)
      }
    }
    transferred = result != nil; return result
  }
  func commitRemoteRefresh(handle: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); handoffs.cancelAll(); let epoch = try activeEpoch()
    let candidate = try remoteCandidates.take(handle: handle, vaultID: vaultID, revision: revision, epoch: epoch, purpose: .refresh)
    defer { remoteCandidates.release(handle); candidate.key.destroy() }
    guard try await core.selected(vaultID: vaultID, revision: revision, current: current(epoch)) == candidate.pubkey else { throw NativeVaultFailure.denied }
    _ = try await methodInfo(pubkey: candidate.pubkey, vaultID: vaultID, revision: revision, epoch: epoch)
    guard await confirm(title: "Update signer relays?", message: "Account:\n" + candidate.pubkey + "\nSigner peer:\n" + candidate.peer + "\nNew signer relays:\n" + candidate.relays.joined(separator: "\n") + "\nYour selected signing method and workspace remain the same.", approve: "Update relays", deadline: candidate.expires),
      authority.current(epoch), ContinuousClock.now < candidate.expires else { throw NativeVaultFailure.denied }
    candidates.cancelAll()
    let checker: @Sendable () -> Bool = { [authority] in authority.current(epoch) && ContinuousClock.now < candidate.expires }
    return try await core.commitRemoteRefresh(pubkey: candidate.pubkey, peerPubkey: candidate.peer, relays: candidate.relays, clientKey: candidate.key,
      vaultID: vaultID, revision: revision, authority: authority.permit(epoch, deadline: candidate.expires), current: checker,
      revokePending: { NativeSigningSourceFacade.revokeAll() })
  }
  func commitRemote(handle: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); handoffs.cancelAll(); let epoch = try activeEpoch()
    let candidate = try remoteCandidates.take(handle: handle, vaultID: vaultID, revision: revision, epoch: epoch)
    defer { remoteCandidates.release(handle); candidate.key.destroy() }
    var local = false
    do { let info = try await methodInfo(pubkey: candidate.pubkey, vaultID: vaultID, revision: revision, epoch: epoch)
      guard info.remote == nil else { throw NativeVaultFailure.signerAlreadyConnected }; local = info.local
    } catch NativeVaultFailure.notFound { }
    guard await confirm(title: "Connect and use remote signer?", message: "Account:\n" + candidate.pubkey + "\nSigner peer:\n" + candidate.peer + "\nSigner relays:\n" + candidate.relays.joined(separator: "\n") + (local ? "\nA local key remains on this device." : "\nThere is no local key on this device."), approve: "Use remote signer", deadline: candidate.expires),
      authority.current(epoch), ContinuousClock.now < candidate.expires else { throw NativeVaultFailure.denied }
    candidates.cancelAll()
    let checker: @Sendable () -> Bool = { [authority] in authority.current(epoch) && ContinuousClock.now < candidate.expires }
    return try await core.commitRemote(pubkey: candidate.pubkey, peerPubkey: candidate.peer, relays: candidate.relays, clientKey: candidate.key,
      vaultID: vaultID, revision: revision, authority: authority.permit(epoch, deadline: candidate.expires), current: checker,
      revokePending: { NativeSigningSourceFacade.revokeAll() })
  }
  func commitImport(handle: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); handoffs.cancelAll(); let epoch = try activeEpoch()
    let candidate = try candidates.take(handle: handle, vaultID: vaultID, revision: revision, epoch: epoch)
    let key = candidate.key; defer { candidates.release(handle); key.destroy() }
    _ = try await core.snapshot(vaultID: vaultID, revision: revision, current: current(epoch))
    let pubkey = try key.publicKey()
    guard await confirm(title: "Switch to imported identity?", message: "Public key:\n" + pubkey + "\nUse the local key on this device for this account. Your saved workspace will switch to this identity.", approve: "Use local key", deadline: candidate.expires),
      ContinuousClock.now < candidate.expires, authority.current(epoch) else { throw NativeVaultFailure.denied }
    let committedEpoch = epoch
    return try await core.commitImport(key: key, vaultID: vaultID, revision: revision,
      authority: authority.permit(committedEpoch, deadline: candidate.expires),
      current: { [authority] in authority.current(committedEpoch) && ContinuousClock.now < candidate.expires }, revokePending: { NativeSigningSourceFacade.revokeAll() })
  }
  func select(pubkey: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); handoffs.cancelAll(); let epoch = try activeEpoch()
    let selected = try await core.selected(vaultID: vaultID, revision: revision, current: current(epoch))
    try await core.requireIdentity(pubkey: pubkey, vaultID: vaultID, revision: revision, current: current(epoch))
    if selected != pubkey {
      guard await confirm(title: "Switch identity?", message: "Public key:\n" + pubkey + "\nYour saved workspace will switch to this identity.", approve: "Switch identity"),
        authority.current(epoch) else { throw NativeVaultFailure.denied }
    }
    candidates.cancelAll(); let committedEpoch = epoch
    return try await core.select(pubkey: pubkey, vaultID: vaultID, revision: revision,
      authority: authority.permit(committedEpoch), current: current(committedEpoch), revokePending: { NativeSigningSourceFacade.revokeAll() })
  }
  private func methodInfo(pubkey: String, vaultID: String, revision: UInt64, epoch: UInt64) async throws -> (selected: String?, local: Bool, remote: [String: Any]?) {
    let raw = try await core.methods(pubkey: pubkey, vaultID: vaultID, revision: revision, current: current(epoch))
    guard let object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any], let methods = object["methods"] as? [[String: Any]] else { throw NativeVaultFailure.corrupt }
    return (object["selectedMethod"] as? String, methods.contains { $0["kind"] as? String == "local" }, methods.first { $0["kind"] as? String == "nip46" })
  }
  func selectMethod(pubkey: String, method: NativeSigningMethod, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); handoffs.cancelAll(); let epoch = try activeEpoch()
    guard try await core.selected(vaultID: vaultID, revision: revision, current: current(epoch)) == pubkey else { throw NativeVaultFailure.denied }
    let info = try await methodInfo(pubkey: pubkey, vaultID: vaultID, revision: revision, epoch: epoch)
    if info.selected != method.rawValue {
      guard method == .local ? info.local : info.remote != nil else { throw method == .local ? NativeVaultFailure.localKeyUnavailable : .signerUnavailable }
      let detail = method == .local ? "Use the local key on this device." : "Use the saved remote signer.\nPeer: " + (info.remote?["peerPubkey"] as? String ?? "") + "\nSigner relays:\n" + ((info.remote?["relays"] as? [String]) ?? []).joined(separator: "\n") + (info.local ? "\nA local key remains on this device." : "\nThere is no local key on this device.")
      guard await confirm(title: "Change signing method?", message: "Account:\n" + pubkey + "\n" + detail, approve: "Use this method"), authority.current(epoch) else { throw NativeVaultFailure.denied }
    }
    candidates.cancelAll(); remoteCandidates.cancelAll()
    return try await core.selectMethod(pubkey: pubkey, method: method, vaultID: vaultID, revision: revision,
      authority: authority.permit(epoch), current: current(epoch), revokePending: { NativeSigningSourceFacade.revokeAll() })
  }
  func disconnectRemote(pubkey: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); handoffs.cancelAll(); let epoch = try activeEpoch()
    guard try await core.selected(vaultID: vaultID, revision: revision, current: current(epoch)) == pubkey else { throw NativeVaultFailure.denied }
    let info = try await methodInfo(pubkey: pubkey, vaultID: vaultID, revision: revision, epoch: epoch)
    guard info.remote != nil else { throw NativeVaultFailure.signerUnavailable }
    guard await confirm(title: "Disconnect remote signer?", message: "Account:\n" + pubkey + "\nThis removes the saved connection even if the signer is offline. Your account and napplet data remain." + (info.selected == "nip46" ? "\nNo signing method will be selected." : ""), approve: "Disconnect signer"), authority.current(epoch) else { throw NativeVaultFailure.denied }
    candidates.cancelAll(); remoteCandidates.cancelAll()
    return try await core.disconnectRemote(pubkey: pubkey, vaultID: vaultID, revision: revision,
      authority: authority.permit(epoch), current: current(epoch), revokePending: { NativeSigningSourceFacade.revokeAll() })
  }
  func deleteLocalKey(pubkey: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); handoffs.cancelAll(); let epoch = try activeEpoch()
    guard try await core.selected(vaultID: vaultID, revision: revision, current: current(epoch)) == pubkey else { throw NativeVaultFailure.denied }
    let info = try await methodInfo(pubkey: pubkey, vaultID: vaultID, revision: revision, epoch: epoch)
    guard info.local else { throw NativeVaultFailure.localKeyUnavailable }
    guard await confirm(title: "Delete local key?", message: "Account:\n" + pubkey + "\nMake a backup first. You will need that backup to restore this key. Your account and napplet data remain." + (info.selected == "local" ? "\nNo signing method will be selected." : ""), approve: "Delete local key"), authority.current(epoch) else { throw NativeVaultFailure.denied }
    let attempt = try await authenticate(.deletion, epoch: epoch)
    defer { if authentication?.1 == attempt.id { authentication = nil; timer?.cancel(); timer = nil } }
    candidates.cancelAll(); remoteCandidates.cancelAll()
    return try await core.deleteLocalKey(pubkey: pubkey, vaultID: vaultID, revision: revision,
      authority: authority.permit(epoch, deadline: attempt.deadline),
      current: { [authority] in authority.current(epoch) && ContinuousClock.now < attempt.deadline }, revokePending: { NativeSigningSourceFacade.revokeAll() })
  }
  private func authenticate(_ action: NativeSignerIdentityActions.Action, epoch: UInt64) async throws -> (id: UInt64, deadline: ContinuousClock.Instant) {
    guard nextAttempt < UInt64.max else { throw NativeVaultFailure.unavailable }; nextAttempt += 1
    let attempt = nextAttempt, deadline = ContinuousClock.now.advanced(by: .seconds(60)); authentication = (action, attempt)
    timer = Task { [weak self] in
      do { try await Task.sleep(for: .seconds(60)) } catch { return }
      if self?.authentication?.1 == attempt { self?.cancelAll() }
    }
    let checker: @Sendable () -> Bool = { [authority] in authority.current(epoch) && ContinuousClock.now < deadline }
    do { try await NativeSignerIdentityActions.authenticate(action, attemptID: attempt, canPresent: checker) }
    catch {
      if authentication?.1 == attempt { authentication = nil; timer?.cancel(); timer = nil }
      throw NativeVaultFailure.denied
    }
    guard !Task.isCancelled, checker(), authentication?.1 == attempt, UIApplication.shared.applicationState == .active else {
      NativeSignerIdentityActions.cancel(action, attemptID: attempt)
      if authentication?.1 == attempt { authentication = nil; timer?.cancel(); timer = nil }
      throw NativeVaultFailure.denied
    }
    return (attempt, deadline)
  }
  func backup(pubkey: String, vaultID: String, revision: UInt64) async throws {
    try idle(); let epoch = try activeEpoch()
    let selected = try await core.selected(vaultID: vaultID, revision: revision, current: current(epoch))
    guard selected == pubkey else { throw NativeVaultFailure.denied }
    let attempt = try await authenticate(.backup, epoch: epoch)
    defer {
      if authentication?.1 == attempt.id { authentication = nil; timer?.cancel(); timer = nil; NativeSignerIdentityActions.clearBackup() }
    }
    let checker: @Sendable () -> Bool = { [authority] in authority.current(epoch) && ContinuousClock.now < attempt.deadline }
    var secret = try await core.backupSecret(pubkey: pubkey, vaultID: vaultID, revision: revision, current: checker)
    defer { secret.resetBytes(in: 0..<secret.count) }
    guard checker() else { throw NativeVaultFailure.denied }
    // The same absolute native deadline covers authentication, read and reveal.
    try await NativeSignerIdentityActions.showBackup(attemptID: attempt.id, secret: secret, canPresent: checker)
  }
  func delete(pubkey: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); handoffs.cancelAll(); let epoch = try activeEpoch()
    let selected = try await core.selected(vaultID: vaultID, revision: revision, current: current(epoch))
    guard selected != pubkey else { throw NativeVaultFailure.deleteSelected }
    try await core.requireIdentity(pubkey: pubkey, vaultID: vaultID, revision: revision, current: current(epoch))
    guard await confirm(title: "Delete this identity?", message: "Public key:\n" + pubkey + "\nAll its saved signing methods will be permanently removed.", approve: "Delete identity"),
      authority.current(epoch) else { throw NativeVaultFailure.denied }
    let attempt = try await authenticate(.deletion, epoch: epoch)
    defer { if authentication?.1 == attempt.id { authentication = nil; timer?.cancel(); timer = nil } }
    return try await core.delete(pubkey: pubkey, vaultID: vaultID, revision: revision,
      authority: authority.permit(epoch, deadline: attempt.deadline),
      current: { [authority] in authority.current(epoch) && ContinuousClock.now < attempt.deadline })
  }
  private func confirm(title: String, message: String, approve: String, deadline: ContinuousClock.Instant = .now.advanced(by: .seconds(60))) async -> Bool {
    guard ContinuousClock.now < deadline, let host = try? presenter() else { return false }
    return await withCheckedContinuation { reply in
      confirmReply = reply
      let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
      alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self, weak alert] _ in if let alert { self?.finishConfirmation(false, expected: alert) } })
      alert.addAction(UIAlertAction(title: approve, style: .default) { [weak self, weak alert] _ in if let alert { self?.finishConfirmation(true, expected: alert) } })
      confirmation = alert; host.present(alert, animated: true)
      confirmationTimer = Task { [weak self, weak alert] in
        do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
        guard let self, let alert, self.confirmation === alert else { return }
        self.finishConfirmation(false, expected: alert)
      }
    }
  }
  private func finishConfirmation(_ approved: Bool, expected: UIAlertController) {
    guard confirmation === expected else { return }
    confirmationTimer?.cancel(); confirmationTimer = nil
    let reply = confirmReply; confirmReply = nil; confirmation = nil
    if expected.presentingViewController != nil { expected.dismiss(animated: true) { reply?.resume(returning: approved) } }
    else { reply?.resume(returning: approved) }
  }
  func reviewAndSign(kind: String, token: String, unsignedJSON: String, vaultID: String, revision: UInt64) async throws -> String {
    try idle(); let epoch = try activeEpoch()
    let selected = try await core.selected(vaultID: vaultID, revision: revision, current: current(epoch))
    guard let source = NativeSigningSourceFacade.capture(kind: kind, token: token), source.identity == selected, source.isLive() else { throw NativeVaultFailure.denied }
    let event: ExactSignerEvent
    do { event = try ExactSignerEvent(json: unsignedJSON, expectedPubkey: selected) } catch { throw NativeVaultFailure.denied }
    if let original = source.eventJSON {
      guard event.kind != 22242, event.kind != 24242,
        let captured = try? ExactSignerEvent(json: original, expectedPubkey: selected), captured == event else { throw NativeVaultFailure.denied }
    } else {
      let now = UInt64(max(0, Date().timeIntervalSince1970))
      guard ["upload", "fixture-upload"].contains(kind), event.kind == 24242,
        source.destinations.count == 1, let hash = source.uploadHash,
        let host = URLComponents(string: source.destinations[0])?.host,
        event.createdAt > 0, event.createdAt <= now, now - event.createdAt < 120,
        event.content == "Upload reviewed file to " + source.destinations[0],
        event.tags == [["t", "upload"], ["x", hash], ["server", host], ["expiration", String(event.createdAt + 120)]] else { throw NativeVaultFailure.denied }
    }
    let info = try await methodInfo(pubkey: selected, vaultID: vaultID, revision: revision, epoch: epoch)
    guard info.selected == "local" || info.selected == "nip46" else { throw NativeVaultFailure.signerUnavailable }
    let remote = info.selected == "nip46", deadline = ContinuousClock.now.advanced(by: .seconds(remote ? 120 : 600))
    let host = try presenter()
    let operation = UUID()
    return try await withCheckedThrowingContinuation { reply in
      signDispatchState = NativeNip46DispatchState()
      signOperation = operation; signReply = reply; signSource = source; signKind = kind; signToken = token
      let panel = NativeSignerReviewPanel(event: event, requester: source.requester, destinations: source.destinations, method: remote ? "Remote signer (NIP-46)" : "Local key", signerRelays: remote ? ((info.remote?["relays"] as? [String]) ?? []) : [], signerPeer: remote ? info.remote?["peerPubkey"] as? String : nil) { [weak self] approved in
        self?.decideSigning(approved, event: event, source: source, vaultID: vaultID, revision: revision, epoch: epoch, deadline: deadline, operation: operation)
      }
      signPanel = panel; host.present(panel, animated: true)
      timer = Task { [weak self] in
        for _ in 0..<(remote ? 120 : 600) {
          do { try await Task.sleep(for: .seconds(1)) } catch { return }
          if !source.isLive() || !nativeSigningDeadlineValid(event) { self?.cancelSigning(operation: operation); return }
        }
        self?.cancelSigning(operation: operation)
      }
    }
  }
  private func decideSigning(_ approved: Bool, event: ExactSignerEvent, source: NativeSigningSourceCapture,
    vaultID: String, revision: UInt64, epoch: UInt64, deadline: ContinuousClock.Instant, operation: UUID) {
    guard signOperation == operation, signReply != nil else { return }
    guard approved, ContinuousClock.now < deadline, authority.current(epoch), source.isLive(), nativeSigningDeadlineValid(event), signPanel?.viewIfLoaded?.window != nil,
      source.consumeForNativeSigning() else { cancelSigning(operation: operation); return }
    let checker: @Sendable () -> Bool = { [authority] in authority.current(epoch) && source.isLive() && nativeSigningDeadlineValid(event) }
    let state = signDispatchState ?? NativeNip46DispatchState(), permit = authority.permit(epoch, deadline: deadline)
    let ticket: NativeNip46Handoff?
    if let kind = signKind, let token = signToken {
      ticket = makeHandoff(binding: .signing(kind: kind, token: token, vaultID: vaultID, revision: revision, eventID: event.digest.map { String(format: "%02x", $0) }.joined()),
        deadline: deadline, current: checker, source: source)
    } else { ticket = nil }
    signTask = Task { [weak self] in
      guard let self, signOperation == operation, signReply != nil, !Task.isCancelled else { return }
      do {
        let signed = try await core.sign(event: event, vaultID: vaultID, revision: revision, current: checker, deadline: deadline,
          dispatch: { emit in guard checker() else { throw NativeVaultFailure.denied }; try permit.performMutation { emit() } }, state: state, handoff: ticket)
        finishSigning(.success(signed), operation: operation, checker: checker)
      } catch { finishSigning(.failure(error), operation: operation, checker: checker) }
    }
  }
  private func finishSigning(_ result: Result<String, any Error>, operation: UUID, checker: @escaping @Sendable () -> Bool) {
    guard signOperation == operation, let reply = signReply else { return }
    signOperation = nil; signReply = nil; signTask = nil; let uncertain = signDispatchState?.possible == true; signDispatchState = nil; timer?.cancel(); timer = nil
    if case .failure = result { cancelAll() }
    let panel = signPanel; signPanel = nil; signSource = nil; signKind = nil; signToken = nil
    let deliver = {
      if case .success = result, (!checker() || UIApplication.shared.applicationState != .active) { reply.resume(throwing: uncertain ? NativeVaultFailure.signerUncertain : .denied) }
      else { reply.resume(with: result) }
    }
    if let panel, panel.presentingViewController != nil { panel.dismiss(animated: true, completion: deliver) } else { deliver() }
  }
  func cancelSigning(kind: String? = nil, token: String? = nil, operation: UUID? = nil) {
    if let operation, signOperation != operation { return }
    if let kind, let token, (signKind != kind || signToken != token) { NativeSigningSourceFacade.cancel(kind: kind, token: token); return }
    signSource?.cancel(); signSource = nil
    signTask?.cancel()
    if let currentOperation = signOperation {
      finishSigning(.failure(signDispatchState?.possible == true ? NativeVaultFailure.signerUncertain : .denied), operation: currentOperation, checker: { false })
    }
  }
  private func cancelImport() {
    candidates.cancelAll(); importPanel?.clear()
    completeImport(nil, vaultID: "", revision: 0, epoch: (try? authority.epoch()) ?? 0)
  }
  private func makeHandoff(binding: NativeNip46Handoff.Binding, deadline: ContinuousClock.Instant,
    current: @escaping @Sendable () -> Bool, source: NativeSigningSourceCapture? = nil) -> NativeNip46Handoff {
    let ticket = NativeNip46Handoff(binding: binding, deadline: deadline, current: current,
      pause: { source?.pauseExecution($0) ?? true }, cancel: { source?.cancel() }, show: { [weak self] ticket, url in
        Task { @MainActor [weak self] in await self?.showHandoff(ticket, url: url) }
      })
    handoffs.install(ticket); return ticket
  }
  private func cancelHandoff(_ ticket: NativeNip46Handoff) {
    let owned = handoffs.owns(ticket); ticket.cancel(); if owned { cancelAll() }
  }
  private func showHandoff(_ ticket: NativeNip46Handoff, url: URL) async {
    guard handoffs.permitsPresentation(ticket) else { return }
    do { try await Task.detached { try NativeSignerRelayPolicy.validateAuthenticationResolution(url) }.value }
    catch { cancelHandoff(ticket); return }
    guard handoffs.permitsPresentation(ticket), authority.isOwner(), ContinuousClock.now < ticket.deadline else { cancelHandoff(ticket); return }
    if let panel = signPanel, panel.presentingViewController != nil {
      signPanel = nil
      await withCheckedContinuation { reply in panel.dismiss(animated: true) { reply.resume() } }
    }
    guard handoffs.permitsPresentation(ticket) else { return }
    let origin = (url.host ?? "") + (url.port.map { ":\($0)" } ?? "")
    guard await confirm(title: "Open signer authentication?", message: "Authenticate with your signer at:\nhttps://" + origin + "\nReturn here to review resuming this exact request. Opening or loading this page does not approve signing.", approve: "Open authentication", deadline: ticket.deadline),
      handoffs.permitsPresentation(ticket), ticket.arm(), let host = try? presenter() else { cancelHandoff(ticket); return }
    let panel = NativeVaultSafariPanel(url: url, done: { [weak self] in
      Task { @MainActor [weak self] in await self?.resumeHandoff(ticket) }
    }, cancel: { [weak self] in self?.cancelHandoff(ticket) })
    safari = panel; host.present(panel.controller, animated: true)
  }
  private func resumeHandoff(_ ticket: NativeNip46Handoff) async {
    guard handoffs.permitsPresentation(ticket, resuming: true) else { return }
    safari = nil
    guard await confirm(title: "Resume the same signer request?", message: "Continue the exact request you reviewed. The signer must still return an authenticated reply for its original request ID. No challenged request will be sent again.", approve: "Resume request", deadline: ticket.deadline),
      handoffs.permitsPresentation(ticket, resuming: true), ticket.requestResume() else { cancelHandoff(ticket); return }
  }
  func cancelAll() {
    launch.cancel()
    timer?.cancel(); timer = nil; confirmationTimer?.cancel(); confirmationTimer = nil
    authority.invalidateActions(); handoffs.cancelAll(); candidates.cancelAll(); remoteCandidates.cancelAll()
    let browser = safari; safari = nil; browser?.cancel()
    cancelImport(); cancelRemotePreparation(); cancelSigning(); NativeSignerIdentityActions.clearBackup()
    if let authentication { NativeSignerIdentityActions.cancel(authentication.0, attemptID: authentication.1) }; authentication = nil
    let alert = confirmation; confirmation = nil; let reply = confirmReply; confirmReply = nil
    alert?.dismiss(animated: false); reply?.resume(returning: false)
  }
}
private final class VaultObservation: @unchecked Sendable {
  let token: any NSObjectProtocol
  init(_ token: any NSObjectProtocol) { self.token = token }
  deinit { NotificationCenter.default.removeObserver(token) }
}

private func nativeSigningDeadlineValid(_ event: ExactSignerEvent) -> Bool {
  guard event.kind == 24242 else { return true }
  let now = Date().timeIntervalSince1970
  return now >= Double(event.createdAt) && now < Double(event.createdAt + 120)
}


/// One launch admission wait. No storage work runs until the caller rechecks its native epoch.
@MainActor final class NativeVaultLaunchGate {
  enum State { case waiting, ready, denied }
  private(set) var isOpening = false
  private var reply: CheckedContinuation<Void, any Error>?
  private var state: (() -> State)?
  private var timer: Task<Void, Never>?
  private var ticket: UUID?
  private var deadline: ContinuousClock.Instant?

  func open(state: @escaping () -> State, timeout: Duration = .seconds(5),
    operation: () async throws -> String) async throws -> String {
    guard !isOpening else { throw NativeVaultFailure.busy }
    isOpening = true
    defer { isOpening = false }
    guard !Task.isCancelled else { throw NativeVaultFailure.denied }
    let ticket = UUID(), deadline = ContinuousClock.now.advanced(by: timeout)
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { reply in
        self.reply = reply; self.state = state; self.ticket = ticket; self.deadline = deadline
        changed()
        if self.reply != nil {
          timer = Task { [weak self] in
            do { try await Task.sleep(until: deadline, clock: .continuous) } catch { return }
            self?.cancel(ticket)
          }
        }
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.cancel(ticket) }
    }
    guard !Task.isCancelled, ContinuousClock.now < deadline else { throw NativeVaultFailure.denied }
    return try await operation()
  }
  func changed() {
    guard let state else { return }
    guard let deadline, ContinuousClock.now < deadline else { cancel(); return }
    switch state() {
    case .waiting: break
    case .ready: finish(nil)
    case .denied: cancel()
    }
  }
  func cancel() { finish(NativeVaultFailure.denied) }
  private func cancel(_ ticket: UUID) {
    guard self.ticket == ticket else { return }
    cancel()
  }
  private func finish(_ failure: NativeVaultFailure?) {
    guard let reply else { return }
    self.reply = nil; state = nil; self.ticket = nil; deadline = nil; timer?.cancel(); timer = nil
    if let failure { reply.resume(throwing: failure) } else { reply.resume() }
  }
}
