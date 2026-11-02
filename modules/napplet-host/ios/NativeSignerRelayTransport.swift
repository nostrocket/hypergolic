import Foundation
import Network
import Security
import Synchronization

/// Native-only one-request WSS transport. It resolves and pins vetted public addresses,
/// preserves TLS hostname validation, and never reconnects a dispatched session.
public enum NativeSignerRelayTransport {
  public enum Failure: Error { case unavailable, invalidResponse, expired, cancelled, uncertain }
  public static let maximumTextBytes = 6_992_652
  public static let maximumWireBytes = 32 * 1024 * 1024
  public static let maximumFrames = 64
  public static let maximumMessages = 32
  /// One operation shares a sticky budget across every RPC, address attempt and relay.
  public final class Budget: Sendable {
    private struct State { var deadline: ContinuousClock.Instant?; var wire = 0; var frames = 0; var texts = 0; var opens = 0; var poisoned = false }
    private let state = Mutex(State())
    private let maximumOpens: Int
    public init(maximumOpens: Int = 9) { precondition((1...9).contains(maximumOpens)); self.maximumOpens = maximumOpens }
    public func accept(deadline: ContinuousClock.Instant, wire: Int = 0, frames: Int = 0, texts: Int = 0, opening: Bool = false) throws {
      try state.withLock { value in
        if value.deadline == nil { value.deadline = deadline }
        guard !value.poisoned, value.deadline == deadline,
          wire >= 0, frames >= 0, texts >= 0, wire <= maximumWireBytes - value.wire,
          frames <= maximumFrames - value.frames, texts <= maximumMessages - value.texts,
          !opening || value.opens < maximumOpens else { value.poisoned = true; throw Failure.invalidResponse }
        guard ContinuousClock.now < deadline else { throw Failure.expired }
        value.wire += wire; value.frames += frames; value.texts += texts; if opening { value.opens += 1 }
      }
    }
    func invalidate() { state.withLock { $0.poisoned = true } }
    func check(deadline: ContinuousClock.Instant) throws {
      try state.withLock { value in
        guard !value.poisoned, value.deadline == nil || value.deadline == deadline else { throw Failure.invalidResponse }
        guard ContinuousClock.now < deadline else { throw Failure.expired }
      }
    }
    public func isValid(deadline: ContinuousClock.Instant) -> Bool {
      do { try check(deadline: deadline); return true } catch { return false }
    }
  }
  /// Preflight one complete network read before callers inspect any authenticated response.
  static func decodeBatch(_ bytes: Data, decoder: PublishedRelayWebSocketFrames, budget: Budget,
    deadline: ContinuousClock.Instant, wireAlreadyCounted: Bool = false) throws -> [PublishedRelayWebSocketFrames.Event] {
    if !wireAlreadyCounted { try budget.accept(deadline: deadline, wire: bytes.count) }
    let before = decoder.completedFrames, batch = decoder.feed(bytes)
    guard decoder.consumedInput == bytes.count, !batch.contains(where: { if case .error = $0 { return true }; return false }) else {
      budget.invalidate(); throw Failure.invalidResponse
    }
    let texts = batch.reduce(0) { count, event in if case .text = event { return count + 1 }; return count }
    try budget.accept(deadline: deadline, frames: decoder.completedFrames - before, texts: texts)
    return batch
  }
  public struct Control: Sendable {
    public let budget: Budget
    public let current: @Sendable () -> Bool
    public let dispatch: @Sendable (@Sendable () -> Void) throws -> Void
    public init(current: @escaping @Sendable () -> Bool, budget: Budget = Budget(), dispatch: @escaping @Sendable (@Sendable () -> Void) throws -> Void) { self.current = current; self.budget = budget; self.dispatch = dispatch }
  }
  public static func exchange(_ relay: String, subscription: String, event: String,
    deadline: ContinuousClock.Instant, control: Control,
    validate: @escaping @Sendable (String) throws -> Bool,
    completion: @escaping @Sendable (Result<String, Error>) -> Void) throws -> Operation {
    let request = try PublishedRelayWebSocketQuery.Request(relay)
    guard subscription.utf8.count <= 4096, event.utf8.count <= maximumTextBytes, deadline > .now, control.current() else { throw Failure.cancelled }
    let operation = Operation(request: request, subscription: subscription, event: event, deadline: deadline, control: control, validate: validate, completion: completion)
    operation.start(); return operation
  }
#if HYPERGOLIC_NETWORK_PROOF
  /// Controlled test build only: production has no address or trust-anchor argument.
  public static func exchangeForProof(_ relay: String, subscription: String, event: String, address: String,
    anchorDER: Data, deadline: ContinuousClock.Instant, control: Control,
    validate: @escaping @Sendable (String) throws -> Bool,
    completion: @escaping @Sendable (Result<String, Error>) -> Void) throws -> Operation {
    let request = try PublishedRelayWebSocketQuery.Request(relay)
    guard let literal = IPv4Address(address), address == "127.0.0.1", !anchorDER.isEmpty,
      subscription.utf8.count <= 4096, event.utf8.count <= maximumTextBytes, deadline > .now, control.current() else { throw Failure.cancelled }
    let operation = Operation(request: request, subscription: subscription, event: event, deadline: deadline, control: control, validate: validate, completion: completion)
    operation.proofAddress = PublishedPinnedHTTPS.Address(host: .ipv4(literal), bytes: literal.rawValue)
    operation.proofAnchor = anchorDER; operation.start(); return operation
  }
#endif
  public final class Operation: @unchecked Sendable {
    private let request: PublishedRelayWebSocketQuery.Request
    private let subscription: String, event: String
    private let deadline: ContinuousClock.Instant
    private let control: Control
    private let validate: @Sendable (String) throws -> Bool
    private let completion: @Sendable (Result<String, Error>) -> Void
    private let queue = DispatchQueue(label: "org.nostrocket.hypergolic.nip46.wss")
    private let cancellation = Mutex<(cancelled: Bool, connection: NWConnection?)>((false, nil))
    private let frames = PublishedRelayWebSocketFrames(maximumBytes: maximumTextBytes + 14)
    private var connection: NWConnection?, cursor: VettedAddressCursor<PublishedPinnedHTTPS.Address>?
    private var handshake = PublishedRelayWebSocketQuery.HandshakeAccumulator(), nonce = Data()
    private var ended = false, dispatched = false
#if HYPERGOLIC_NETWORK_PROOF
    fileprivate var proofAddress: PublishedPinnedHTTPS.Address?
    fileprivate var proofAnchor: Data?
#endif
    fileprivate init(request: PublishedRelayWebSocketQuery.Request, subscription: String, event: String,
      deadline: ContinuousClock.Instant, control: Control, validate: @escaping @Sendable (String) throws -> Bool,
      completion: @escaping @Sendable (Result<String, Error>) -> Void) {
      self.request = request; self.subscription = subscription; self.event = event; self.deadline = deadline
      self.control = control; self.validate = validate; self.completion = completion
    }
    fileprivate func start() {
      let duration = ContinuousClock.now.duration(to: deadline).components
      let seconds = max(0, Double(duration.seconds) + Double(duration.attoseconds) / 1e18)
      queue.asyncAfter(deadline: .now() + seconds) { self.finish(.failure(self.dispatched ? Failure.uncertain : .expired)) }
#if HYPERGOLIC_NETWORK_PROOF
      if let proofAddress { queue.async { guard self.live() else { return }; self.cursor = VettedAddressCursor([proofAddress]); self.connectNext() }; return }
#endif
      DispatchQueue.global(qos: .utility).async {
        let resolved = Result { try PublishedPinnedHTTPS.resolve(self.request.host) }
        self.queue.async {
          guard self.live() else { return }
          switch resolved {
          case .success(let values): self.cursor = VettedAddressCursor(values); self.connectNext()
          case .failure: self.finish(.failure(Failure.unavailable))
          }
        }
      }
    }
    public func cancel() {
      cancellation.withLock { $0.cancelled = true; $0.connection?.cancel(); $0.connection = nil }
      queue.async { self.finish(.failure(self.dispatched ? Failure.uncertain : .cancelled)) }
    }
    private func live() -> Bool {
      guard !ended else { return false }
      do { try control.budget.check(deadline: deadline) }
      catch Failure.expired { finish(.failure(dispatched ? Failure.uncertain : .expired)); return false }
      catch { finish(.failure(Failure.invalidResponse)); return false }
      guard !cancellation.withLock({ $0.cancelled }), control.current(), ContinuousClock.now < deadline else {
        finish(.failure(dispatched ? Failure.uncertain : .cancelled)); return false
      }; return true
    }
    private func connectNext() {
      guard live() else { return }
      guard let address = cursor?.next() else { finish(.failure(dispatched ? Failure.uncertain : .unavailable)); return }
      do { try control.budget.accept(deadline: deadline, opening: true) } catch { finish(.failure(error)); return }
      connection?.stateUpdateHandler = nil; connection?.cancel()
      let tls = NWProtocolTLS.Options(), host = request.host
      host.withCString { sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, $0) }
      sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
#if HYPERGOLIC_NETWORK_PROOF
      let proofAnchor = proofAnchor
#endif
      sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, peer, verified in
        let trust = sec_trust_copy_ref(peer).takeRetainedValue()
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
          SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { verified(false); return }
#if HYPERGOLIC_NETWORK_PROOF
        if let proofAnchor {
          guard let certificate = SecCertificateCreateWithData(nil, proofAnchor as CFData),
            SecTrustSetAnchorCertificates(trust, [certificate] as CFArray) == errSecSuccess,
            SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else { verified(false); return }
        }
#endif
        verified(SecTrustEvaluateWithError(trust, nil))
      }, queue)
      guard let port = NWEndpoint.Port(rawValue: request.port) else { finish(.failure(Failure.unavailable)); return }
      let socket = NWConnection(host: address.host, port: port, using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
      connection = socket
      let attached = cancellation.withLock { state in guard !state.cancelled else { return false }; state.connection = socket; return true }
      guard attached else { socket.cancel(); finish(.failure(Failure.cancelled)); return }
      socket.stateUpdateHandler = { [weak self] state in
        guard let self, self.live(), self.connection === socket else { return }
        switch state {
        case .ready:
          guard self.cursor?.markReady() == true else { return }
          self.upgrade(socket)
        case .waiting, .failed, .cancelled: self.connectNext()
        default: break
        }
      }; socket.start(queue: queue)
    }
    private func upgrade(_ socket: NWConnection) {
      var random = [UInt8](repeating: 0, count: 16)
      guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { finish(.failure(Failure.unavailable)); return }
      nonce = Data(random)
      do { let wire = try request.upgrade(nonce: nonce); try control.budget.accept(deadline: deadline, wire: wire.count); socket.send(content: wire, completion: .contentProcessed { error in
        guard self.live() else { return }
        if error != nil { self.finish(.failure(Failure.unavailable)) } else { self.receiveHandshake() }
      }) } catch { finish(.failure(Failure.unavailable)) }
    }
    private func receiveHandshake() {
      guard live(), let connection else { return }
      connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { bytes, _, complete, error in
        guard self.live() else { return }
        guard error == nil, !complete, let bytes, !bytes.isEmpty else { self.finish(.failure(Failure.unavailable)); return }
        do {
          try self.control.budget.accept(deadline: self.deadline, wire: bytes.count)
          guard let parts = try self.handshake.append(bytes) else { self.receiveHandshake(); return }
          try PublishedRelayWebSocketHandshake.validate(parts.headers, nonce: self.nonce)
          let subscription = try Self.masked(Data(self.subscription.utf8), opcode: 1)
          try self.control.budget.accept(deadline: self.deadline, wire: subscription.count, frames: 1, texts: 1)
          connection.send(content: subscription, completion: .contentProcessed { error in
            guard self.live() else { return }
            guard error == nil else { self.finish(.failure(Failure.unavailable)); return }
            do {
              let publication = try Self.masked(Data(self.event.utf8), opcode: 1)
              try self.control.budget.accept(deadline: self.deadline, wire: publication.count, frames: 1, texts: 1)
              try self.control.dispatch {
                self.dispatched = true
                connection.send(content: publication, completion: .contentProcessed { error in
                  guard self.live() else { return }
                  guard error == nil else { self.finish(.failure(Failure.uncertain)); return }
                  if parts.prefetchedFrames.isEmpty { self.receiveFrames() } else { self.consume(parts.prefetchedFrames, wireAlreadyCounted: true) }
                })
              }
            } catch { self.finish(.failure(self.dispatched ? Failure.uncertain : .cancelled)) }
          })
        } catch { self.finish(.failure(Failure.invalidResponse)) }
      }
    }
    private func receiveFrames() {
      guard live(), let connection else { return }
      connection.receive(minimumIncompleteLength: 1, maximumLength: PublishedRelayWebSocketFrames.maxRead) { bytes, _, complete, error in
        guard self.live() else { return }
        guard error == nil, !complete, let bytes, !bytes.isEmpty else { self.finish(.failure(Failure.uncertain)); return }
        self.consume(bytes)
      }
    }
    private func consume(_ bytes: Data, wireAlreadyCounted: Bool = false) {
      guard live(), let connection else { return }
      let batch: [PublishedRelayWebSocketFrames.Event]
      do { batch = try NativeSignerRelayTransport.decodeBatch(bytes, decoder: frames, budget: control.budget,
        deadline: deadline, wireAlreadyCounted: wireAlreadyCounted) } catch { finish(.failure(error)); return }
      for frame in batch {
        switch frame {
        case .text(let text):
          do { if try validate(text) { guard live() else { return }; finish(.success(text)); return } }
          catch { finish(.failure(error)); return }
        case .ping(let data):
          do { let pong = try Self.masked(data, opcode: 10); try control.budget.accept(deadline: deadline, wire: pong.count, frames: 1); connection.send(content: pong, completion: .contentProcessed { error in if error != nil { self.finish(.failure(Failure.uncertain)) } }) }
          catch Failure.expired { finish(.failure(Failure.expired)); return }
          catch { finish(.failure(Failure.invalidResponse)); return }
        case .pong: break
        case .close: finish(.failure(dispatched ? Failure.uncertain : .unavailable)); return
        case .error: finish(.failure(Failure.invalidResponse)); return
        }
      }; receiveFrames()
    }
    private static func masked(_ bytes: Data, opcode: UInt8) throws -> Data {
      guard bytes.count <= maximumTextBytes, opcode == 1 || (opcode == 10 && bytes.count <= 125) else { throw Failure.invalidResponse }
      var mask = [UInt8](repeating: 0, count: 4)
      guard SecRandomCopyBytes(kSecRandomDefault, 4, &mask) == errSecSuccess else { throw Failure.unavailable }
      var result = Data([0x80 | opcode])
      if bytes.count < 126 { result.append(0x80 | UInt8(bytes.count)) }
      else if bytes.count < 65536 { result.append(0x80 | 126); result.append(UInt8(bytes.count >> 8)); result.append(UInt8(bytes.count & 255)) }
      else { result.append(0x80 | 127); for shift in stride(from: 56, through: 0, by: -8) { result.append(UInt8((UInt64(bytes.count) >> shift) & 255)) } }
      result.append(contentsOf: mask)
      for (offset, byte) in bytes.enumerated() { result.append(byte ^ mask[offset % 4]) }; return result
    }
    private func finish(_ result: Result<String, Error>) {
      guard !ended else { return }; ended = true
      connection?.stateUpdateHandler = nil; connection?.cancel(); connection = nil
      cancellation.withLock { $0.connection = nil }
      completion(result)
    }
  }
}
