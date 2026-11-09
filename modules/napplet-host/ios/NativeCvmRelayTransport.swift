import Foundation
import Network
import Security
import Synchronization

/// Native-only duplex CVM transport. No Expo URL/socket route; the owning source facade supplies authority.
public enum NativeCvmRelayTransport {
  public enum Failure: Error { case unavailable, invalidResponse, expired, cancelled, uncertain, capacity }
  public static let maximumText = 66 * 1024, maximumWire = 4 * 1024 * 1024
  public struct Control: Sendable {
    public let current: @Sendable () -> Bool
    public let ready: @Sendable (Operation) -> Void
    public let receive: @Sendable (String) throws -> Void
    public let ended: @Sendable (Error) -> Void
    public let drained: @Sendable () -> Void
    public init(current: @escaping @Sendable () -> Bool, ready: @escaping @Sendable (Operation) -> Void,
      receive: @escaping @Sendable (String) throws -> Void, ended: @escaping @Sendable (Error) -> Void, drained: @escaping @Sendable () -> Void) {
      self.current = current; self.ready = ready; self.receive = receive; self.ended = ended; self.drained = drained
    }
  }
  public static func open(relay: String, subscription: String, deadline: ContinuousClock.Instant, control: Control) throws -> Operation {
    let request = try PublishedRelayWebSocketQuery.Request(relay)
    guard !subscription.isEmpty, subscription.utf8.count <= 4096, deadline > .now,
      deadline <= ContinuousClock.now.advanced(by: .seconds(120)), control.current() else { throw Failure.cancelled }
    let operation = Operation(request: request, subscription: subscription, deadline: deadline, control: control)
    operation.start(); return operation
  }
  public final class Operation: @unchecked Sendable {
    private struct Send: Sendable {
      let text: String
      let beforeSend: @Sendable () throws -> Void
      let complete: @Sendable (Result<Void, Error>) -> Void
    }
    private let request: PublishedRelayWebSocketQuery.Request
    private let subscription: String
    private let deadline: ContinuousClock.Instant
    private let control: Control
    private let queue = DispatchQueue(label: "org.nostrocket.hypergolic.cvm.wss")
    private let cancellation = Mutex<(cancelled: Bool, connection: NWConnection?)>((false, nil))
    private var cursor: VettedAddressCursor<PublishedPinnedHTTPS.Address>?
    private var connection: NWConnection?
    private var handshake = PublishedRelayWebSocketQuery.HandshakeAccumulator(), nonce = Data()
    private let frames = PublishedRelayWebSocketFrames(maximumBytes: maximumText + 14)
    private var pending: [Send] = []
    private var resolving = false, ended = false, didDrain = false, fallback = false, ready = false, writing = false, dispatched = false
    private var inFlight = 0, wire = 0, frameCount = 0, texts = 0, opens = 0
    fileprivate init(request: PublishedRelayWebSocketQuery.Request, subscription: String, deadline: ContinuousClock.Instant, control: Control) {
      self.request = request; self.subscription = subscription; self.deadline = deadline; self.control = control
    }
    fileprivate func start() {
      resolving = true
      let remaining = ContinuousClock.now.duration(to: deadline).components
      queue.asyncAfter(deadline: .now() + max(0, Double(remaining.seconds) + Double(remaining.attoseconds) / 1e18)) {
        self.finish(self.dispatched ? Failure.uncertain : .expired)
      }
      DispatchQueue.global(qos: .utility).async {
        let result = Result { try PublishedPinnedHTTPS.resolve(self.request.host) }
        self.queue.async {
          self.resolving = false
          guard self.live() else { self.maybeDrained(); return }
          switch result {
          case .success(let addresses): self.cursor = VettedAddressCursor(addresses); self.connectNext()
          case .failure: self.finish(Failure.unavailable)
          }
        }
      }
    }
    /// Bounded serial send; the native source rechecks/consumes its exact permit immediately before emission.
    public func send(_ text: String, beforeSend: @escaping @Sendable () throws -> Void, complete: @escaping @Sendable (Result<Void, Error>) -> Void) {
      guard text.utf8.count <= maximumText else { complete(.failure(Failure.invalidResponse)); return }
      queue.async {
        guard self.live(), self.ready else { complete(.failure(Failure.cancelled)); return }
        guard self.pending.count + (self.writing ? 1 : 0) < 4 else { complete(.failure(Failure.capacity)); return }
        self.pending.append(Send(text: text, beforeSend: beforeSend, complete: complete)); self.flush()
      }
    }
    public func cancel() {
      cancellation.withLock { $0.cancelled = true; $0.connection?.cancel() }
      queue.async { self.finish(self.dispatched ? Failure.uncertain : .cancelled) }
    }
    private func live() -> Bool {
      guard !ended else { return false }
      guard !cancellation.withLock({ $0.cancelled }), control.current(), ContinuousClock.now < deadline else {
        finish(dispatched ? Failure.uncertain : .cancelled); return false
      }
      return true
    }
    private func account(wire: Int = 0, frames: Int = 0, texts: Int = 0) throws {
      guard wire >= 0, wire <= maximumWire - self.wire, frames >= 0, frames <= 4096 - frameCount,
        texts >= 0, texts <= 2048 - self.texts else { throw Failure.invalidResponse }
      self.wire += wire; frameCount += frames; self.texts += texts
    }
    private func connectNext() {
      guard live(), connection == nil else { return }
      guard opens < 4, let address = cursor?.next() else { finish(Failure.unavailable); return }; opens += 1
      let tls = NWProtocolTLS.Options(), host = request.host
      host.withCString { sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, $0) }
      sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
      sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, peer, verified in
        let trust = sec_trust_copy_ref(peer).takeRetainedValue()
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
          SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { verified(false); return }
        verified(SecTrustEvaluateWithError(trust, nil))
      }, queue)
      guard let port = NWEndpoint.Port(rawValue: request.port) else { finish(Failure.unavailable); return }
      let socket = NWConnection(host: address.host, port: port, using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
      connection = socket
      let attached = cancellation.withLock { state in guard !state.cancelled else { return false }; state.connection = socket; return true }
      socket.stateUpdateHandler = { [weak self] state in
        guard let self, self.connection === socket else { return }
        if case .cancelled = state {
          self.connection = nil; self.cancellation.withLock { if $0.connection === socket { $0.connection = nil } }
          if self.ended { self.maybeDrained() }
          else if self.fallback { self.fallback = false; self.connectNext() }
          else { self.finish(self.dispatched ? Failure.uncertain : .unavailable) }
          return
        }
        guard self.live() else { return }
        switch state {
        case .ready:
          guard self.cursor?.markReady() == true else { self.finish(Failure.unavailable); return }; self.upgrade(socket)
        case .waiting, .failed:
          // Before ready only: serial address fallback waits for the old cancellation acknowledgement.
          if !self.ready && self.cursor?.ready == false { self.fallback = true; socket.cancel() }
          else { self.finish(self.dispatched ? Failure.uncertain : .unavailable) }
        default: break
        }
      }
      guard attached else { socket.stateUpdateHandler = nil; connection = nil; finish(Failure.cancelled); return }
      socket.start(queue: queue)
    }
    private func upgrade(_ socket: NWConnection) {
      var bytes = [UInt8](repeating: 0, count: 16)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { finish(Failure.unavailable); return }
      nonce = Data(bytes)
      do { try write(try request.upgrade(nonce: nonce), on: socket) { result in
        switch result { case .success: self.receive(handshake: true); case .failure(let error): self.finish(error) }
      } } catch { finish(error) }
    }
    private func write(_ data: Data, on socket: NWConnection, complete: @escaping @Sendable (Result<Void, Error>) -> Void) throws {
      guard live(), connection === socket else { throw Failure.cancelled }
      guard inFlight < 5 else { throw Failure.capacity }; try account(wire: data.count); inFlight += 1
      socket.send(content: data, completion: .contentProcessed { error in
        self.inFlight -= 1
        if let error { complete(.failure(error)) } else if self.connection === socket && self.live() { complete(.success(())) }
        else { complete(.failure(Failure.cancelled)) }
        self.maybeDrained()
      })
    }
    private func receive(handshake: Bool) {
      guard live(), let socket = connection else { return }
      guard wire < maximumWire else { finish(Failure.invalidResponse); return }; inFlight += 1
      socket.receive(minimumIncompleteLength: 1, maximumLength: min(8192, maximumWire - wire)) { bytes, _, complete, error in
        self.inFlight -= 1
        guard self.connection === socket, self.live() else { self.maybeDrained(); return }
        guard error == nil, !complete, let bytes, !bytes.isEmpty else { self.finish(self.dispatched ? Failure.uncertain : .unavailable); return }
        do {
          try self.account(wire: bytes.count)
          if handshake { try self.handshakeBytes(bytes, socket) } else { try self.consume(bytes); self.receive(handshake: false) }
        } catch { self.finish(error) }
      }
    }
    private func handshakeBytes(_ bytes: Data, _ socket: NWConnection) throws {
      guard let parts = try handshake.append(bytes) else { receive(handshake: true); return }
      try PublishedRelayWebSocketHandshake.validate(parts.headers, nonce: nonce)
      let frame = try masked(Data(subscription.utf8), opcode: 1); try account(frames: 1, texts: 1)
      try write(frame, on: socket) { result in
        switch result {
        case .failure(let error): self.finish(error)
        case .success:
          do { self.ready = true; self.control.ready(self); if !parts.prefetchedFrames.isEmpty { try self.consume(parts.prefetchedFrames) }; self.receive(handshake: false) }
          catch { self.finish(error) }
        }
      }
    }
    private func consume(_ bytes: Data) throws {
      let before = frames.completedFrames, batch = frames.feed(bytes)
      guard frames.consumedInput == bytes.count, !batch.contains(where: { if case .error = $0 { return true }; return false }) else { throw Failure.invalidResponse }
      let textCount = batch.reduce(0) { count, frame in if case .text = frame { return count + 1 }; return count }
      try account(frames: frames.completedFrames - before, texts: textCount)
      for frame in batch {
        guard live() else { throw Failure.cancelled }
        switch frame {
        case .text(let text): try control.receive(text)
        case .ping(let bytes):
          guard let socket = connection else { throw Failure.cancelled }; try account(frames: 1)
          try write(try masked(bytes, opcode: 10), on: socket) { if case .failure(let error) = $0 { self.finish(error) } }
        case .pong: break
        case .close, .error: throw Failure.invalidResponse
        }
      }
    }
    private func flush() {
      guard live(), ready, !writing, !pending.isEmpty, let socket = connection else { return }
      let row = pending.removeFirst(); writing = true
      do {
        let frame = try masked(Data(row.text.utf8), opcode: 1); try account(frames: 1, texts: 1)
        try row.beforeSend(); guard live() else { throw Failure.cancelled }; dispatched = true
        try write(frame, on: socket) { result in
          self.writing = false; row.complete(result)
          if case .failure(let error) = result { self.finish(error) } else { self.flush() }
        }
      } catch { writing = false; row.complete(.failure(error)); finish(error) }
    }
    private func masked(_ bytes: Data, opcode: UInt8) throws -> Data {
      guard bytes.count <= maximumText, opcode == 1 || opcode == 10 && bytes.count <= 125 else { throw Failure.invalidResponse }
      var mask = [UInt8](repeating: 0, count: 4)
      guard SecRandomCopyBytes(kSecRandomDefault, 4, &mask) == errSecSuccess else { throw Failure.unavailable }
      var result = Data([0x80 | opcode])
      if bytes.count < 126 { result.append(0x80 | UInt8(bytes.count)) }
      else if bytes.count < 65536 { result.append(0x80 | 126); result.append(UInt8(bytes.count >> 8)); result.append(UInt8(bytes.count & 255)) }
      else { result.append(0x80 | 127); for shift in stride(from: 56, through: 0, by: -8) { result.append(UInt8((UInt64(bytes.count) >> shift) & 255)) } }
      result.append(contentsOf: mask); for (offset, byte) in bytes.enumerated() { result.append(byte ^ mask[offset % 4]) }; return result
    }
    private func finish(_ error: Error) {
      guard !ended else { maybeDrained(); return }; ended = true; ready = false
      let discarded = pending; pending.removeAll(); for row in discarded { row.complete(.failure(error)) }
      connection?.cancel(); control.ended(error); maybeDrained()
    }
    private func maybeDrained() {
      guard ended, !didDrain, !resolving, inFlight == 0, connection == nil else { return }
      didDrain = true; control.drained()
    }
  }
}
