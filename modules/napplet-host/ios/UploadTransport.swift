import Foundation
#if HYPERGOLIC_NETWORK_PROOF
import Network
#endif

/// Native admission and captured WebKit recipient. Initial reply handlers are never reused for progress.
@MainActor enum UploadTransport {
  nonisolated private static let recoveryReads = UploadRecoveryReadAuthority(clock: { Int64(ProcessInfo.processInfo.systemUptime * 1000) })
  nonisolated private static let recovery: UploadRecoveryLedger? = try? UploadRecoveryLedger(store: UploadRecoveryFileStore.applicationStore())
  nonisolated private static func recoveryEntry(_ transfer: UploadLeaseRegistry.Transfer) throws -> UploadRecoveryLedger.Entry {
    let registration = try UploadWire.object(transfer.registration), review = transfer.permit.review
    guard registration["user"] as? String == review.identity, let publisher = registration["publisher"] as? String,
      let appId = registration["appId"] as? String else { throw UploadWire.Invalid.value }
    return try UploadRecoveryLedger.Entry(uploadId: transfer.uploadId, identity: review.identity, publisher: publisher, appId: appId,
      destination: review.destination, sha256: review.sha256, mimeType: review.mimeType, size: review.size, state: .unknown)
  }
  nonisolated static let leases = UploadLeaseRegistry(clock: { Int64(ProcessInfo.processInfo.systemUptime * 1000) }, prepare: UploadPhotoPreparation.prepare)
  private final class Store: @unchecked Sendable {
    let lock = NSLock()
    var server: String?
#if HYPERGOLIC_NETWORK_PROOF
    var proofAnchor: Data?
#endif
    var completed: [String: String] = [:]
    var activeRecovery = Set<String>()
    var observer: (@Sendable (ProgressEvent) -> Void)?
    var operations: [String: UploadPinnedHTTPS.Operation] = [:]
    var finishedBeforeRegistration: Set<String> = []
  }
  struct ProgressEvent: Sendable { let token: String; let bytesSent: Int; let bytesTotal: Int }
  nonisolated static func observeProgress(_ observer: (@Sendable (ProgressEvent) -> Void)?) { store.lock.withLock { store.observer = observer } }
  nonisolated private static let store = Store()
  private struct Pending {
    let generation: String; let uploadId: String; let sequence: UInt64; let review: NativeUploadAuthority.Review
    let push: @MainActor @Sendable (String) -> Void
    var delivery: UInt64 = 0; var sent = 0
  }
  private static var nativeIdentity: String?
  private static var pending: [String: Pending] = [:]
  private static var statuses: [String: String] = [:]
  private static var statusOrder: [String] = []
  nonisolated static func configureProof(_ anchor: String) throws {
#if HYPERGOLIC_NETWORK_PROOF
    guard anchor.utf8.count <= 8192, let bytes = Data(base64Encoded: anchor), bytes.base64EncodedString() == anchor else { throw UploadWire.Invalid.value }
    try store.lock.withLock { guard store.proofAnchor == nil else { throw UploadWire.Invalid.value }; store.proofAnchor = bytes }
#else
    throw UploadWire.Invalid.value
#endif
  }
  nonisolated private static func transfer(_ value: UploadLeaseRegistry.Transfer, progress: @escaping @Sendable (Int) -> Void,
    completion: @escaping UploadPinnedHTTPS.Completion) throws -> UploadPinnedHTTPS.Operation {
#if HYPERGOLIC_NETWORK_PROOF
    if let anchor = store.lock.withLock({store.proofAnchor}) {
      guard value.permit.review.destination == "https://files.example.com:19943" else { throw UploadWire.Invalid.value }
      let address = PublishedPinnedHTTPS.Address(host: NWEndpoint.Host("127.0.0.1"), bytes: Data([127, 0, 0, 1]))
      return try UploadPinnedHTTPS.putForProof(value.authority, grant: value.grant, permit: value.permit, addresses: [address], anchorDER: anchor,
        now: {Int64(Date().timeIntervalSince1970)}, progress: progress, completion: completion)
    }
#endif
    return try UploadPinnedHTTPS.put(value.authority, grant: value.grant, permit: value.permit, progress: progress, completion: completion)
  }
  nonisolated static func configure(_ server: String?) throws {
    if let server { guard NativeUploadAuthority.validDestination(server) else { throw UploadWire.Invalid.value } }
    store.lock.withLock { store.server = server }
  }
  static func register(_ generation: String, config: CapabilityConfiguration) -> Bool {
    if let nativeIdentity, nativeIdentity != config.user { leases.revokeAll(); sweep() }
    nativeIdentity = config.user
    guard recoveryReads.register(generation, identity: config.user) else { return false }
    if !config.domains.contains("upload") || leases.register(generation, identity: config.user, registration: config.snapshot, granted: true) { return true }
    recoveryReads.revoke(generation); return false
  }
  nonisolated static func foreground(_ value: Bool) { recoveryReads.foreground(value); leases.foreground(value); Task { @MainActor in sweep() } }
  static func focus(_ generation: String, active: Bool) { leases.focus(generation, active: active); sweep() }
  static func revoke(_ generation: String) {
    recoveryReads.revoke(generation); leases.revoke(generation); sweep()
    for key in statusOrder.filter({ $0.hasPrefix(generation + ":") }) { statuses.removeValue(forKey: key) }
    statusOrder.removeAll { $0.hasPrefix(generation + ":") }
  }
  static func receive(_ generation: String, sequence: UInt64, raw: String,
    push: @escaping @MainActor @Sendable (String) -> Void, onReview: @escaping @MainActor @Sendable (String) -> Void) -> String? {
    sweep(); var type: String?, id: String?
    do {
      guard CapabilityTransport.leases.sessionActive(generation) else { throw UploadWire.Invalid.value }
      let value = try UploadWire.object(raw, limit: 400 * 1024)
      type = try UploadWire.text(value["type"], 32); id = try UploadWire.text(value["id"], 128)
      var response: [String: Any] = ["type": type! + ".result", "id": id!]
      switch type {
      case "upload.info":
        try UploadWire.fields(value, ["type", "id"])
        response["info"] = ["rails": [["rail": "blossom", "enabled": store.lock.withLock {store.server != nil}, "returns": ["https", "blossom"]], ["rail": "nip96", "enabled": false]], "maxBytes": NativeUploadAuthority.maxBytes] as [String: Any]
      case "upload.status":
        try UploadWire.fields(value, ["type", "id", "uploadId"])
        let publicId = try UploadWire.text(value["uploadId"], 128)
        guard let status = statuses[generation + ":" + publicId] else { throw UploadWire.Invalid.value }
        response["status"] = try UploadWire.object(status)
      case "upload.__begin":
        try UploadWire.fields(value, ["type", "id", "wireId", "byteLength", "request"])
        guard let server = store.lock.withLock({store.server}) else { response["error"] = "no server configured"; return try UploadWire.json(response) }
        guard let header = value["request"] as? [String: Any] else { throw UploadWire.Invalid.value }
        if let rail = header["rail"], rail as? String != "blossom" { response["error"] = "unsupported rail"; return try UploadWire.json(response) }
        let requestText = try UploadWire.header(header), length = Int(try UploadWire.integer(value["byteLength"], Int64(NativeUploadAuthority.maxBytes)))
        guard let token = leases.begin(generation, callerId: try UploadWire.text(value["wireId"], 128), requestText: requestText, length: length, destination: server) else {
          response["error"] = "quota exceeded"; return try UploadWire.json(response)
        }
        response["token"] = token; response["uploadId"] = leases.publicId(generation, token: token)
      case "upload.__append":
        try UploadWire.fields(value, ["type", "id", "token", "offset", "base64"])
        var chunk = try UploadWire.chunk(value["base64"]); defer { chunk.resetBytes(in: 0..<chunk.count) }
        guard let cursor = leases.append(generation, token: try UploadWire.text(value["token"], 128), offset: Int(try UploadWire.integer(value["offset"], Int64(NativeUploadAuthority.maxBytes))), chunk: chunk) else { throw UploadWire.Invalid.value }
        response["cursor"] = cursor
      case "upload.__seal":
        try UploadWire.fields(value, ["type", "id", "token"])
        let token = try UploadWire.text(value["token"], 128)
        guard leases.seal(generation, token: token) else { response["error"] = "unsupported media type"; return try UploadWire.json(response) }
        guard let publicId = leases.publicId(generation, token: token), let review = leases.sealedReview(generation, token: token) else { throw UploadWire.Invalid.value }
        guard let recovery else { leases.cancel(token); sweep(); throw UploadWire.Invalid.value }
        if try recovery.blocks(identity: review.identity, destination: review.destination, sha256: review.sha256) {
          leases.cancel(token); sweep(); response["error"] = "recovery required"; return try UploadWire.json(response)
        }
        pending[token] = Pending(generation: generation, uploadId: publicId, sequence: sequence, review: review, push: push)
        let status = UploadWire.status(publicId, "pending"); retain(generation, id: publicId, result: status)
        Task { @MainActor in if pending[token] != nil { onReview(token) } }
        Task { @MainActor in try? await Task.sleep(for: .seconds(600)); sweep() }
        response["result"] = status
      case "upload.__cancel":
        try UploadWire.fields(value, ["type", "id", "token"])
        guard leases.cancelOwned(generation, token: try UploadWire.text(value["token"], 128)) else { throw UploadWire.Invalid.value }; sweep()
      default: throw UploadWire.Invalid.value
      }
      return try UploadWire.json(response)
    } catch {
      guard let type, let id else { return nil }
      return try? UploadWire.json(["type": type + ".result", "id": id, "error": "policy denied"])
    }
  }
  nonisolated private static func recoveryState(_ state: UploadRecoveryLedger.State) -> String {
    switch state { case .unknown: "unknown"; case .present: "present"; case .absent: "absent"; case .confirmed: "confirmed"; case .rejected: "rejected"; case .notSent: "not_sent" }
  }
  nonisolated static func listRecovery() -> String {
    do {
      guard let identity = recoveryReads.identity(), let recovery else { throw UploadWire.Invalid.value }
      let active = store.lock.withLock {store.activeRecovery}
      let records = try recovery.list(identity).filter {!active.contains($0.uploadId)}.map { row -> [String: Any] in
        ["uploadId": row.uploadId, "identity": row.identity, "publisher": row.publisher, "appId": row.appId, "destination": row.destination,
         "sha256": row.sha256, "mimeType": row.mimeType, "size": row.size, "state": recoveryState(row.state)]
      }
      return try UploadWire.json(["available": true, "identity": identity, "records": records])
    } catch { return "{\"available\":false,\"identity\":null,\"records\":[]}" }
  }
  nonisolated static func checkRecovery(_ uploadId: String) async -> String {
    do {
      guard let identity = recoveryReads.identity(), let recovery,
        let record = try recovery.list(identity).first(where: {$0.uploadId == uploadId && $0.state == .unknown}),
        !store.lock.withLock({store.activeRecovery.contains(record.uploadId)}),
        let lease = recoveryReads.capture(record) else { throw UploadWire.Invalid.value }
      defer { recoveryReads.cancel(lease) }
      return await withCheckedContinuation { continuation in
        do {
          let completion: @Sendable (Result<PublishedHTTPResponse, Error>) -> Void = { response in
            let state: UploadRecoveryLedger.State
            do { let receipt = try response.get(); state = try recoveryReads.finish(lease, status: receipt.status, body: receipt.body, ledger: recovery) }
            catch { state = .unknown }
            continuation.resume(returning: (try? UploadWire.json(["uploadId": uploadId, "state": recoveryState(state)])) ?? "{}")
          }
          let input = record.destination + "/" + record.sha256
#if HYPERGOLIC_NETWORK_PROOF
          if let anchor = store.lock.withLock({store.proofAnchor}) {
            guard record.destination == "https://files.example.com:19943" else { throw UploadWire.Invalid.value }
            let address = PublishedPinnedHTTPS.Address(host: NWEndpoint.Host("127.0.0.1"), bytes: Data([127,0,0,1]))
            _ = try PublishedPinnedHTTPS.fetchForProof(input, maximumBodyBytes: NativeUploadAuthority.maxBytes, timeout: 60, addresses: [address], anchorDER: anchor,
              recoveryProfile: true, active: { recoveryReads.live(lease) }, completion: completion)
            return
          }
#endif
          _ = try PublishedPinnedHTTPS.fetchRecovery(input, active: { recoveryReads.live(lease) }, completion: completion)
        } catch { continuation.resume(returning: (try? UploadWire.json(["uploadId": uploadId, "state": "unknown"])) ?? "{}") }
      }
    } catch { return (try? UploadWire.json(["uploadId": uploadId, "state": "unknown"])) ?? "{}" }
  }
  nonisolated static func take(_ token: String) -> String? {
    guard let taken = leases.take(token), let registration = try? UploadWire.object(taken.registration) else { return nil }
    return try? UploadWire.json(["registration": registration, "request": taken.request, "uploadId": taken.uploadId, "review": UploadWire.review(taken.review)])
  }
  nonisolated static func cancel(_ token: String) { leases.cancel(token); Task { @MainActor in sweep() } }
  nonisolated static func put(_ token: String, credential: String) async -> String {
    guard let transfer = leases.transfer(token, credential: credential, now: Int64(Date().timeIntervalSince1970)),
      let recovery else { return "{\"ok\":false,\"error\":\"policy denied\"}" }
    return await putTransfer(transfer, token: token, recovery: recovery, active: {leases.isApproved(token)},
      complete: { exact in store.lock.withLock {
        store.completed[token] = exact
        while store.completed.count > 2, let oldest = store.completed.keys.first {store.completed.removeValue(forKey:oldest)}
      }}, progress: {sent in Task {@MainActor in progress(token,sent:sent)}})
  }
  nonisolated static func putTrustedFixture(_ transfer: UploadLeaseRegistry.Transfer) async -> String {
    guard let recovery else {return "{\"ok\":false,\"error\":\"recovery unavailable\"}"}
    return await putTransfer(transfer,token:transfer.uploadId,recovery:recovery,
      active:{transfer.authority.isApproved(transfer.grant)},complete:{_ in},progress:{_ in})
  }
  nonisolated private static func putTransfer(_ transfer: UploadLeaseRegistry.Transfer, token: String, recovery: UploadRecoveryLedger,
    active: @escaping @Sendable () -> Bool, complete: @escaping @Sendable (String) -> Void,
    progress: @escaping @Sendable (Int) -> Void) async -> String {
    let record: UploadRecoveryLedger.Entry
    do {
      record = try recoveryEntry(transfer)
      guard store.lock.withLock({store.activeRecovery.insert(record.uploadId).inserted}) else { return "{\"ok\":false,\"error\":\"policy denied\"}" }
      guard try recovery.start(record) else {
        store.lock.withLock { _ = store.activeRecovery.remove(record.uploadId) }; return "{\"ok\":false,\"error\":\"recovery required\"}"
      }
    } catch { store.lock.withLock { _ = store.activeRecovery.remove(transfer.uploadId) }; return "{\"ok\":false,\"error\":\"recovery unavailable\"}" }
    return await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        do {
          let operation = try Self.transfer(transfer,
            progress: progress, completion: { response in
              let encoded: String
              do {
                let receipt = try response.get()
                let captured = try UploadWire.receipt(receipt.body, review: transfer.permit.review, id: transfer.uploadId)
                guard active(), try recovery.settle(record, state: .confirmed) else { throw UploadWire.Invalid.value }
                let exact = try UploadWire.json(captured.result)
                complete(exact)
                encoded = try UploadWire.json(["ok": true, "descriptor": captured.descriptor])
              } catch {
                let dispatched = transfer.authority.wasDispatched(transfer.grant)
                var code = (error as? UploadPinnedHTTPS.Failure)?.code ?? (dispatched ? "outcome unknown" : "upload failed")
                let state: UploadRecoveryLedger.State? = !dispatched ? .notSent :
                  error is UploadPinnedHTTPS.Failure && ["server rejected", "file too large", "quota exceeded"].contains(code) ? .rejected : nil
                if let state, (try? recovery.settle(record, state: state)) != true { code = "outcome unknown" }
                encoded = (try? UploadWire.json(["ok": false, "error": code])) ?? "{\"ok\":false,\"error\":\"upload failed\"}"
              }
              store.lock.withLock {
                store.activeRecovery.remove(record.uploadId)
                if store.operations.removeValue(forKey: token) == nil { store.finishedBeforeRegistration.insert(token) }
              }
              continuation.resume(returning: encoded)
            })
          store.lock.withLock {
            if store.finishedBeforeRegistration.remove(token) == nil { store.operations[token] = operation }
          }
        } catch {
          store.lock.withLock { _ = store.activeRecovery.remove(record.uploadId) }
          if !transfer.authority.wasDispatched(transfer.grant) { _ = try? recovery.settle(record, state: .notSent) }
          continuation.resume(returning: "{\"ok\":false,\"error\":\"policy denied\"}")
        }
      }
    } onCancel: { transfer.authority.cancelGrant(transfer.grant); cancel(token) }
  }
  nonisolated static func finish(_ token: String, raw: String) {
    guard let publicId = leases.publicIdForApp(token) else { return }
    let cached = store.lock.withLock { store.completed.removeValue(forKey: token) }
    let captured = cached.flatMap {try? UploadWire.object($0)}
    let result = try? UploadWire.terminal(raw, id: publicId)
    let success = result != nil && result?["status"] as? String == "complete" && captured != nil && UploadWire.sameCompletion(result!, captured!)
    let approved = leases.finish(token)
    let terminal: [String: Any]
    if success && approved { terminal = captured! }
    else if let result, result["status"] as? String != "complete" {
      let definitive = ["server rejected", "file too large", "quota exceeded"].contains(result["error"] as? String ?? "")
      terminal = leases.wasDispatched(token) && !definitive ? UploadWire.status(publicId, "failed", error: "outcome unknown") : result
    } else { terminal = UploadWire.status(publicId, "failed", error: leases.wasDispatched(token) ? "outcome unknown" : "policy denied") }
    guard let encoded = try? UploadWire.json(terminal) else { return }
    Task { @MainActor in
      if pending[token]?.uploadId == publicId, let decoded = try? UploadWire.object(encoded) { deliver(token, result: decoded) }
      sweep()
    }
  }
  private static func progress(_ token: String, sent: Int) {
    guard var request = pending[token] else { return }
    guard leases.isApproved(token), sent >= request.sent, sent <= request.review.size else { sweep(); return }
    request.sent = sent; pending[token] = request
    store.lock.withLock {store.observer}?(ProgressEvent(token: token, bytesSent: sent, bytesTotal: request.review.size))
    var result = UploadWire.status(request.uploadId, "uploading"); result["bytesSent"] = sent; result["bytesTotal"] = request.review.size
    publish(token, request: request, result: result)
  }
  private static func retain(_ generation: String, id: String, result: [String: Any]) {
    let key = generation + ":" + id
    if statuses[key] == nil { statusOrder.append(key) }; statuses[key] = try? UploadWire.json(result)
    while statusOrder.count > 128 { statuses.removeValue(forKey: statusOrder.removeFirst()) }
  }
  private static func publish(_ token: String, request: Pending, result: [String: Any]) {
    retain(request.generation, id: request.uploadId, result: result)
    guard CapabilityTransport.leases.sessionActive(request.generation) else { return }
    var delivered = request; delivered.delivery += 1
    if pending[token] != nil { pending[token] = delivered }
    guard let response = try? UploadWire.json(["type": "upload.status.changed", "status": result]),
      let envelope = try? UploadWire.json(["type": "capability.upload", "sessionId": request.generation, "sequence": request.sequence,
        "delivery": delivered.delivery, "response": response]) else { return }
    request.push(envelope)
  }
  private static func deliver(_ token: String, result: [String: Any]) {
    guard let request = pending.removeValue(forKey: token) else { return }
    store.lock.withLock { _ = store.completed.removeValue(forKey: token) }; publish(token, request: request, result: result)
  }
  private static func sweep() {
    for invalid in leases.drainInvalid() { deliver(invalid.token, result: UploadWire.status(invalid.uploadId,
      invalid.dispatched ? "failed" : "cancelled", error: invalid.dispatched ? "outcome unknown" : "user cancelled")) }
  }
}
