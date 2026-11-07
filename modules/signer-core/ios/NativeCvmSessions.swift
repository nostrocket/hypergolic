import Foundation
import CoreFoundation
#if canImport(UIKit)
import UIKit
#endif
import HypergolicNappletHost

/// Private native actor. No bridge method accepts a private key, unsigned event or arbitrary decoder/socket URL.
final class NativeCvmSessions: @unchecked Sendable {
  enum Failure: Error { case denied, unavailable, uncertain }
  private final class Plan: @unchecked Sendable {
    let approved: NativeCvmSourceFacade.Approved, prepared: NativeCvmEnvelope.Prepared, purpose: String
    var committed = false
    init(approved: NativeCvmSourceFacade.Approved, prepared: NativeCvmEnvelope.Prepared, purpose: String) { self.approved = approved; self.prepared = prepared; self.purpose = purpose }
  }
  private final class Context: @unchecked Sendable {
    let id = UUID().uuidString.lowercased(), source: NativeCvmSourceFacade.Approved
    let resource: NativeCvmLifetime.Session, operation: NativeCvmLifetime.Operation
    let originalDeadline: Int64
    var envelope: NativeCvmEnvelope?, transport: (any NativeCvmSessionIO)?, proto: NativeCvmProtocol
    var plans: [String: Plan] = [:], acknowledgements: [String: CheckedContinuation<Void, Error>] = [:]
    var drainingOwner: NativeCvmSessions? // Bounded native self-retention ends only after actual transport/key drain.
    var ready: CheckedContinuation<String, Error>?, terminal = false, transportDrained = false, keyDrained = false
    var relay = "", subscription = UUID().uuidString.lowercased(), inbound = 0
    init(source: NativeCvmSourceFacade.Approved, resource: NativeCvmLifetime.Session, operation: NativeCvmLifetime.Operation) {
      self.source = source; self.resource = resource; self.operation = operation; originalDeadline = source.permit.originalDeadline
      proto = NativeCvmProtocol(approved:source)
    }
  }
  private let queue = DispatchQueue(label: "org.nostrocket.hypergolic.cvm.session")
  private let lifetime = NativeCvmLifetime(clock: { Int64(ProcessInfo.processInfo.systemUptime * 1000) })
  private var contexts: [String: Context] = [:]
  private let factory: NativeCvmSessionFactory
  private let active: @Sendable () -> Bool
  private let emit: @Sendable (String, String) -> Void
  private let gate = NSLock()
  private var foreground = false, closed = false
  private var observers: [NSObjectProtocol] = []
  init(active: @escaping @Sendable () -> Bool, emit: @escaping @Sendable (String, String) -> Void, factory: @escaping NativeCvmSessionFactory = nativeCvmSessionTransport) {
    self.active = active; self.emit = emit; self.factory = factory
    #if canImport(UIKit)
    let center = NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName:name,object:nil,queue:nil) { [weak self] _ in self?.setForeground(false) })
    }
    observers.append(center.addObserver(forName:UIApplication.didBecomeActiveNotification,object:nil,queue:nil) { [weak self] _ in self?.setForeground(true) })
    Task { @MainActor [weak self] in self?.setForeground(UIApplication.shared.applicationState == .active) }
    #endif
    NativeCvmSourceFacade.observeRevocation { [weak self] generation, provider in self?.cancel(generation: generation, provider: provider) }
    NativeCvmSourceFacade.observeCompletion { [weak self] approved, success in self?.completed(approved, success: success) }
  }
  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }
  private func available() -> Bool { gate.withLock { !closed && foreground } && active() }
  func setForeground(_ value: Bool) {
    gate.withLock { foreground = value }; lifetime.setForeground(value)
    if !value { cancel(generation: nil, provider: nil) }
  }
  private func current(_ context: Context) throws {
    guard available(), context.source.permit.sourceCurrent() else { throw Failure.denied }
    try lifetime.current(context.operation)
  }
  private func check(_ context: Context, approved: NativeCvmSourceFacade.Approved) throws {
    try current(context)
    guard approved.permit.current(), context.source.permit.sameSource(approved.permit),
      approved.permit.provider == context.source.permit.provider,
      approved.permit.relays.contains(context.relay) else { throw Failure.denied }
  }
  func open(_ token: String) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      queue.async {
        do {
          guard self.available(), let approved = NativeCvmSourceFacade.approved(token) else { throw Failure.denied }
          if let existing = self.contexts.values.first(where: { $0.source.permit.sameSource(approved.permit) && $0.source.permit.provider == approved.permit.provider && !$0.terminal }) {
            try self.check(existing, approved: approved); continuation.resume(returning: existing.id); return
          }
          let resource = try self.lifetime.open(current: { [weak owner = self] in owner?.available() == true && approved.permit.sourceCurrent() })
          do {
            let operation = try self.lifetime.begin(resource, originalDeadline: approved.permit.originalDeadline)
            let context = Context(source: approved, resource: resource, operation: operation)
            self.contexts[context.id] = context; context.drainingOwner = self; context.ready = continuation
            do { try self.connect(context) } catch { self.retire(context, reason: "provider unavailable") }
          } catch { self.lifetime.drained(resource, certain: true); throw error }
        } catch { continuation.resume(throwing: error) }
      }
    }
  }
  private func connect(_ context: Context) throws {
    try current(context)
    guard let relay = context.source.permit.relays.first else { throw Failure.denied }; context.relay = relay
    context.envelope = try NativeCvmEnvelope(peer: context.source.permit.provider, current: { [weak self, weak context] in
      guard let self, let context else { throw Failure.denied }; try self.current(context)
    }, outgoing: { _, _ in /* prepare validates the exact native permit/purpose before invoking this private owner. */ })
    let client = try context.envelope!.clientPublicKey()
    let subscription = "[\"REQ\",\"\(context.subscription)\",{\"kinds\":[1059,21059],\"#p\":[\"\(client)\"],\"limit\":0}]"
    let remaining = context.originalDeadline - Int64(ProcessInfo.processInfo.systemUptime * 1000)
    guard remaining > 0 else { throw Failure.denied }
    let control = NativeCvmSessionCallbacks(current: { [weak self, weak context] in
      guard let self, let context else { return false }; return (try? self.current(context)) != nil
    }, ready: { [weak self, weak context] in guard let self, let context else { return }; self.queue.async { guard !context.terminal else { return }; context.ready?.resume(returning: context.id); context.ready = nil } },
      receive: { [weak self, weak context] text in guard let self, let context else { throw Failure.denied }; self.queue.async { self.receive(text, context: context) } },
      ended: { [weak self, weak context] _ in guard let self, let context else { return }; self.queue.async { self.retire(context, reason: "session closed") } },
      drained: { [weak self, weak context] in guard let self, let context else { return }; self.queue.async { context.transportDrained = true; self.drain(context) } })
    context.transport = try factory(relay,subscription,ContinuousClock.now.advanced(by:.milliseconds(remaining)),control)
  }
  func prepare(session: String, token: String, purpose: String, message: String, replyTo: String?) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in queue.async {
      do {
        guard let context = self.contexts[session], let approved = NativeCvmSourceFacade.approved(token), context.plans.count < 4 else { throw Failure.denied }
        try self.check(context, approved: approved); try context.proto.validate(purpose, raw: message, replyTo: replyTo, approved: approved)
        guard let envelope = context.envelope else { throw Failure.denied }
        let prepared = try envelope.prepare(message: message, now: UInt64(Date().timeIntervalSince1970), ephemeralWrap: false, replyTo: replyTo)
        try self.check(context, approved: approved)
        let id = UUID().uuidString.lowercased(); context.plans[id] = Plan(approved: approved, prepared: prepared, purpose: purpose)
        let data = try JSONSerialization.data(withJSONObject: ["plan":id,"innerEventId":prepared.innerEventId])
        continuation.resume(returning: String(decoding:data,as:UTF8.self))
      } catch { continuation.resume(throwing:error) }
    } }
  }
  func commit(session: String, plan: String) async throws {
    try await withCheckedThrowingContinuation { continuation in queue.async {
      do {
        guard let context = self.contexts[session], let prepared = context.plans.removeValue(forKey: plan), !prepared.committed,
          let transport = context.transport, context.acknowledgements.count < 4,
          let event = NativeCvmProtocol.object(prepared.prepared.wire), let id = event["id"] as? String else { throw Failure.denied }
        try self.check(context, approved: prepared.approved); prepared.committed = true
        context.acknowledgements[id] = continuation
        transport.send("[\"EVENT\"," + prepared.prepared.wire + "]", beforeSend: {
          try self.check(context, approved: prepared.approved)
          if prepared.purpose == "approved", !NativeCvmSourceFacade.consume(prepared.approved, message: prepared.approved.message, relay: context.relay) { throw Failure.denied }
        }, complete: { result in self.queue.async { if case .failure = result { self.retire(context, reason: "provider unavailable") } } })
      } catch { continuation.resume(throwing:error) }
    } }
  }
  private func receive(_ raw: String, context: Context) {
    do {
      try current(context)
      guard context.inbound < 1024, let frame = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [Any], let type = frame.first as? String else { throw Failure.denied }
      context.inbound += 1
      switch type {
      case "OK":
        guard frame.count == 4, let id = frame[1] as? String, let ok = frame[2] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), frame[3] is String else { throw Failure.denied }
        guard let waiter = context.acknowledgements.removeValue(forKey:id) else { return }
        if ok.boolValue { waiter.resume() } else { waiter.resume(throwing:Failure.unavailable); retire(context,reason:"provider unavailable") }
      case "EVENT":
        guard frame.count == 3, frame[1] as? String == context.subscription, let event = frame[2] as? [String:Any], let envelope = context.envelope else { throw Failure.denied }
        let bytes = try JSONSerialization.data(withJSONObject:event)
        let decoded = try envelope.decode(signed:String(decoding:bytes,as:UTF8.self),now:UInt64(Date().timeIntervalSince1970))
        try current(context)
        var payload: [String:Any] = ["session":context.id,"message":decoded.message,"eventId":decoded.eventId,"references":decoded.references]
        if let mode = decoded.paymentInteraction { payload["paymentInteraction"] = mode }; emitValue("onCvmMessage",payload)
      case "EOSE": guard frame.count == 2, frame[1] as? String == context.subscription else { throw Failure.denied }
      case "NOTICE": guard frame.count == 2, frame[1] is String else { throw Failure.denied }
      default: throw Failure.denied // Includes relay AUTH/CLOSED: no automatic authentication or retry.
      }
    } catch { retire(context, reason:"session closed") }
  }
  private func completed(_ approved: NativeCvmSourceFacade.Approved, success: Bool) {
    queue.async {
      for context in Array(self.contexts.values) where context.source.permit === approved.permit {
        if success { try? self.lifetime.delivered(context.operation) }
        self.retire(context, reason: success ? "session closed" : "policy denied")
      }
    }
  }
  func cancel(generation: String?, provider: String?) {
    queue.async { for context in Array(self.contexts.values) where (generation == nil || context.source.permit.source.generation == generation) && (provider == nil || context.source.permit.provider == provider) { self.retire(context,reason:"session closed") } }
  }
  func close(session: String) { queue.async { if let context = self.contexts[session] { self.retire(context,reason:"session closed") } } }
  private func retire(_ context: Context, reason: String) {
    guard !context.terminal else { return }; context.terminal = true; lifetime.cancel(context.resource)
    context.ready?.resume(throwing:Failure.unavailable); context.ready = nil
    for waiter in context.acknowledgements.values { waiter.resume(throwing:Failure.uncertain) }; context.acknowledgements.removeAll(); context.plans.removeAll()
    context.transport?.cancel(); if context.transport == nil { context.transportDrained = true }
    context.envelope?.close(); context.envelope = nil; context.keyDrained = true
    emitValue("onCvmClosed",["session":context.id,"error":reason]); drain(context)
  }
  private func emitValue(_ event: String, _ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject:value) else { return }; emit(event,String(decoding:data,as:UTF8.self))
  }
  private func drain(_ context: Context) {
    guard context.terminal, context.keyDrained, context.transportDrained else { return }
    contexts.removeValue(forKey:context.id); lifetime.drained(context.resource,certain:true); context.drainingOwner = nil
  }
  func close() { gate.withLock { closed = true }; lifetime.close(); cancel(generation:nil,provider:nil) }
}
