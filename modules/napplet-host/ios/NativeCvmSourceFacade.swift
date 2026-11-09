import Foundation
import CoreFoundation

/// Private native-only handoff. A bridge token cannot manufacture a source or an approved message.
public enum NativeCvmSourceFacade {
  public struct Approved: Sendable {
    public let permit: NativeCvmServiceAuthority.Permit
    public let message: String
    public let initialize: Bool
    public let progressTokenJSON: String?
  }
  public static func approved(_ token: String) -> Approved? { CvmTransport.shared.approved(token) }
  public static func consume(_ approved: Approved, message: String, relay: String) -> Bool {
    CvmTransport.shared.authority.consume(approved.permit, provider: approved.permit.provider, exactMessage: message, relay: relay)
  }
  public static func observeCompletion(_ handler: (@Sendable (Approved, Bool) -> Void)?) { CvmTransport.shared.observeCompletion(handler) }
  public static func observeRevocation(_ handler: (@Sendable (String?, String?) -> Void)?) { CvmTransport.shared.observeRevocation(handler) }
}

/// One process composition owns the logical four-request service authority; crypto/socket slots are separate.
final class CvmTransport: @unchecked Sendable {
  static let shared = CvmTransport()
  let authority = NativeCvmServiceAuthority(clock: { Int64(ProcessInfo.processInfo.systemUptime * 1000) })
  private let lock = NSRecursiveLock()
  private struct Source {
    let registration: NativeCvmServiceAuthority.Registration, configuration: CapabilityConfiguration
    let revision = UUID().uuidString.lowercased()
    let push: @MainActor @Sendable (String) -> Void
  }
  private final class Pending: @unchecked Sendable {
    let token: String, request: NativeCvmServiceAuthority.Request, generation: String, id: String
    let raw: String, message: String, initialize: Bool, provider: String, relays: [String], deadline: Int64
    let reply: @MainActor @Sendable (String?) -> Void
    let revision: String, operation: String, progressTokenJSON: String?
    var taken = false
    var approved: NativeCvmSourceFacade.Approved?
    init(token: String, request: NativeCvmServiceAuthority.Request, generation: String, id: String, raw: String,
      message: String, initialize: Bool, provider: String, relays: [String], deadline: Int64, revision: String, operation: String, progressTokenJSON: String?, reply: @escaping @MainActor @Sendable (String?) -> Void) {
      self.token = token; self.request = request; self.generation = generation; self.id = id; self.raw = raw
      self.revision = revision; self.operation = operation; self.progressTokenJSON = progressTokenJSON; self.message = message; self.initialize = initialize; self.provider = provider; self.relays = relays; self.deadline = deadline; self.reply = reply
    }
  }
  private final class Delivery: @unchecked Sendable {
    let generation: String, revision: String, requestToken: String, provider: String, deadline: Int64
    let response: Bool
    var cancelled = false
    init(generation: String, revision: String, requestToken: String, provider: String, deadline: Int64, response: Bool) { self.generation=generation; self.revision=revision; self.requestToken=requestToken; self.provider=provider; self.deadline=deadline; self.response=response }
  }
  private var deliveries: [String: Delivery] = [:]
  private var sources: [String: Source] = [:], pending: [String: Pending] = [:]
  private var defaults: [String] = []
  private var accountUser: String?, accountEpoch: Int64?
  private var completion: (@Sendable (NativeCvmSourceFacade.Approved, Bool) -> Void)?
  private var revocation: (@Sendable (String?, String?) -> Void)?
  private func locked<T>(_ body: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body() }
  private func json(_ value: Any) -> String? { guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }; return String(decoding: data, as: UTF8.self) }
  func observeCompletion(_ handler: (@Sendable (NativeCvmSourceFacade.Approved, Bool) -> Void)?) { locked { completion = handler } }
  func observeRevocation(_ handler: (@Sendable (String?, String?) -> Void)?) { locked { revocation = handler } }
  func configure(relays: [String]) throws {
    guard relays.count <= 4, Set(relays).count == relays.count else { throw NativeCvmServiceAuthority.Failure.invalid }
    for relay in relays { _ = try PublishedRelayWebSocketQuery.Request(relay) }
    locked { defaults = relays }
  }
  func account(user: String, epoch: Int64, available: Bool) {
    // Account transition and registration replacement are atomic with native ingress.
    locked {
      let changed = accountUser != user || accountEpoch != epoch || !available
      accountUser=user; accountEpoch=epoch
      if changed { closeAll() }; authority.account(user:user,epoch:epoch)
      if !available { authority.setForeground(false) }
    }
  }
  func foreground(_ value: Bool) { authority.setForeground(value); if !value { closeAll() } }
  private func closeAll() {
    let action = locked { () -> ([Pending], (@Sendable (String?, String?) -> Void)?) in
      let rows = Array(pending.values); pending.removeAll(); for delivery in deliveries.values { delivery.cancelled=true }
      for source in sources.values { authority.revoke(source.registration) }; sources.removeAll()
      return (rows, revocation)
    }
    action.1?(nil, nil)
    for row in action.0 { fail(row, error: "session closed") }
  }
  func revoke(_ generation: String, provider: String? = nil) {
    let action = locked { () -> ([Pending], (@Sendable (String?, String?) -> Void)?) in
      if provider == nil, let source = sources.removeValue(forKey: generation) { authority.revoke(source.registration) }
      for delivery in deliveries.values where delivery.generation == generation && (provider == nil || delivery.provider == provider) { delivery.cancelled=true }
      let rows = pending.values.filter { $0.generation == generation && (provider == nil || $0.provider == provider) }
      for row in rows { pending.removeValue(forKey: row.token) }; return (rows, revocation)
    }
    action.1?(generation, provider)
    for row in action.0 { fail(row, error: "session closed") }
  }
  private func fail(_ row: Pending, error: String) {
    authority.cancel(row.request); if let approved = row.approved { locked { completion }?(approved, false); authority.cancel(approved.permit) }
    let result = json(["type":"cvm.request.result", "id":row.id, "error":error])
    Task { @MainActor in row.reply(result) }
  }
  func receive(_ generation: String, config: CapabilityConfiguration, raw: String,
    push: @escaping @MainActor @Sendable (String) -> Void, reply: @escaping @MainActor @Sendable (String?) -> Void) -> String? {
    guard config.fixture == "published", config.cvmProfile == "free-foreground-v1", config.domains.contains("cvm"),
      raw.utf8.count <= 80 * 1024, let data = raw.data(using: .utf8),
      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let type = value["type"] as? String, let id = value["id"] as? String, (1...128).contains(id.utf8.count) else { return nil }
    if type != "cvm.request" { return receiveControl(generation, type: type, id: id, value: value, reply: reply) }
    guard Set(value.keys) == ["type","id","server","message","options","operation","progressTokenJSON"], let server = value["server"] as? [String: Any],
      Set(server.keys).isSubset(of: ["pubkey","relays"]), let provider = server["pubkey"] as? String,
      let message = value["message"] as? String, message.utf8.count <= 32768,
      let operation = value["operation"] as? String,
      value["progressTokenJSON"] is NSNull || (value["progressTokenJSON"] as? String).map({$0.utf8.count <= 1024}) == true,
      let options = value["options"] as? [String: Any],
      Set(options.keys) == ["timeoutMs","initialize","payment"], let timeout = options["timeoutMs"] as? NSNumber,
      CFGetTypeID(timeout) != CFBooleanGetTypeID(), timeout.doubleValue.rounded() == timeout.doubleValue,
      (1...120000).contains(timeout.int64Value), let initialize = options["initialize"] as? NSNumber,
      CFGetTypeID(initialize) == CFBooleanGetTypeID(), let payment = options["payment"] as? String,
      ["prompt","deny","allow"].contains(payment) else { return nil }
    let progressTokenJSON = value["progressTokenJSON"] as? String
    let originalDeadline = Int64(ProcessInfo.processInfo.systemUptime * 1000) + timeout.int64Value
    let token: String? = locked {
      guard pending.count + deliveries.values.filter({$0.response}).count < 4 else { return nil }
      let relays = (server["relays"] as? [String]) ?? defaults
      guard (1...4).contains(relays.count), server["relays"] == nil || server["relays"] is [String] else { return nil }
      for relay in relays { guard (try? PublishedRelayWebSocketQuery.Request(relay)) != nil else { return nil } }
      let source: Source
      if let existing = sources[generation], authority.current(existing.registration) { source = existing }
      else {
        guard let snapshot = try? JSONSerialization.jsonObject(with: Data(config.snapshot.utf8)) as? [String: Any],
          let instance = snapshot["instanceId"] as? String,
          let captured = try? NativeCvmServiceAuthority.Source(endpoint: config.sessionId, generation: generation, user: config.user,
            epoch: Int64(config.epoch), publisher: config.publisher, appId: config.appId, version: config.version, instance: instance),
          let registration = authority.register(captured) else { return nil }
        source = Source(registration: registration, configuration: config, push: push); sources[generation] = source
      }
      guard let request = authority.admit(source.registration, provider: provider, operation: operation, exactMessage: message,
        relays: relays, timeoutMillis: timeout.int64Value) else { return nil }
      let token = UUID().uuidString.lowercased()
      pending[token] = Pending(token: token, request: request, generation: generation, id: id, raw: raw, message: message, initialize: initialize.boolValue, provider: provider, relays: relays, deadline: originalDeadline, revision: source.revision, operation:operation, progressTokenJSON:progressTokenJSON, reply: reply)
      return token
    }
    if let token { DispatchQueue.global().asyncAfter(deadline: .now() + Double(timeout.int64Value) / 1000) { self.expire(token) } }
    return token
  }
  private func receiveControl(_ generation: String, type: String, id: String, value: [String: Any], reply: @escaping @MainActor @Sendable (String?) -> Void) -> String? {
    let recognized = ["cvm.close","cvm.discover","cvm.registry.list","cvm.registry.has","cvm.registry.describe","cvm.registry.call"]
    guard recognized.contains(type) else { return nil }
    if type == "cvm.close" {
      guard Set(value.keys) == ["type","id","server"], let server = value["server"] as? [String: Any],
        let provider = server["pubkey"] as? String, provider.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else { return nil }
      revoke(generation, provider: provider)
    }
    let result: [String: Any] = type == "cvm.close" ? ["type":type + ".result","id":id] :
      type == "cvm.registry.has" ? ["type":type + ".result","id":id,"has":false] : ["type":type + ".result","id":id,"error":"unsupported method"]
    let response = json(result); Task { @MainActor in reply(response) }; return ""
  }
  private func expire(_ token: String) { let row = locked { pending.removeValue(forKey: token) }; if let row { fail(row, error: "relay timeout") } }
  func take(_ token: String) -> String? {
    locked {
      guard let row = pending[token], !row.taken, let source = sources[row.generation], authority.current(source.registration),
        row.deadline > Int64(ProcessInfo.processInfo.systemUptime * 1000) else { return nil }
      row.taken = true; let config = source.configuration
      let snapshot = (try? JSONSerialization.jsonObject(with: Data(config.snapshot.utf8))) as? [String: Any]
      let scope: [String: Any] = ["endpoint":config.sessionId,"generation":row.generation,"sourceRevision":row.revision,"identity":config.user,"epoch":config.epoch,
        "publisher":config.publisher,"appId":config.appId,"version":config.version,"instance":snapshot?["instanceId"] ?? ""]
      let rawObject = (try? JSONSerialization.jsonObject(with: Data(row.raw.utf8))) as? [String: Any]
      return json(["token":token,"scope":scope,"requestId":row.id,"server":["pubkey":row.provider,"relays":row.relays],
        "message":row.message,"operation":row.operation,"progressTokenJSON":row.progressTokenJSON as Any? ?? NSNull(),"options":rawObject?["options"] ?? [:],
        "remainingMs":max(0, row.deadline - Int64(ProcessInfo.processInfo.systemUptime * 1000))])
    }
  }
  func approve(_ token: String) -> String? {
    locked {
      guard let row = pending[token], row.taken, row.approved == nil, let permit = authority.approve(row.request) else { return nil }
      row.approved = NativeCvmSourceFacade.Approved(permit: permit, message: row.message, initialize: row.initialize, progressTokenJSON:row.progressTokenJSON); return token
    }
  }
  func approved(_ token: String) -> NativeCvmSourceFacade.Approved? { locked { guard let approved = pending[token]?.approved, approved.permit.current() else { return nil }; return approved } }
  func current(_ generation: String, revision: String? = nil) -> Bool { locked { guard let source = sources[generation], revision == nil || source.revision == revision else { return false }; return authority.current(source.registration) } }
  func reject(_ token: String) { let row = locked { pending.removeValue(forKey: token) }; if let row { fail(row, error: "policy denied") } }
  func finish(_ token: String, response: String?) {
    locked {
      guard let row = pending.removeValue(forKey:token) else { return }
      if response == nil { for delivery in deliveries.values where delivery.requestToken == token { delivery.cancelled=true } }
      let valid = response != nil && row.approved?.permit.current() == true
      authority.cancel(row.request); if let approved = row.approved { completion?(approved,valid); _ = authority.finish(approved.permit) }
      let denied = json(["type":"cvm.request.result","id":row.id,"error":"session closed"])
      let bounded = response.flatMap { $0.utf8.count <= 80*1024 ? $0 : nil }
      schedule(Delivery(generation:row.generation,revision:row.revision,requestToken:token,provider:row.provider,deadline:row.deadline,response:true)) { current in row.reply(valid && current ? bounded : denied) }
    }
  }
  private func schedule(_ delivery: Delivery, deliver: @escaping @MainActor @Sendable (Bool) -> Void) {
    let id=UUID().uuidString
    locked { deliveries[id]=delivery }
    Task { @MainActor in
      let valid = self.locked { () -> Bool in
        defer { self.deliveries.removeValue(forKey:id) }
        return !delivery.cancelled && self.current(delivery.generation,revision:delivery.revision) && Int64(ProcessInfo.processInfo.systemUptime*1000) < delivery.deadline
      }
      deliver(valid)
    }
  }
  func send(_ generation: String, revision: String, requestToken: String, response: String) -> Bool {
    locked {
      guard current(generation,revision:revision), response.utf8.count <= 80*1024, deliveries.values.filter({!$0.response}).count < 64,
        let value = try? JSONSerialization.jsonObject(with:Data(response.utf8)) as? [String:Any], Set(value.keys) == ["provider","message"],
        let provider = value["provider"] as? String, let message = value["message"] as? String, message.utf8.count <= 40*1024,
        let row = pending[requestToken], row.generation == generation, row.revision == revision, row.provider == provider, row.approved?.permit.current() == true,
        let source = sources[generation] else { return false }
      schedule(Delivery(generation:generation,revision:revision,requestToken:requestToken,provider:row.provider,deadline:row.deadline,response:false)) { current in if current { source.push(message) } }
      return true
    }
  }
}
