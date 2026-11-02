import CryptoKit
import Foundation
import Network
import Security

/// One bounded, pinned WSS subscription against one public relay. The caller owns
/// event structure and decides when a validated EOSE ends the operation.
enum PublishedRelayWebSocketQuery {
  enum Failure: Error { case invalidURL, resolution, connection, handshake, frame, closed, timeout, cancelled, limit }
  static let maxWireBytes = 2 * 1024 * 1024
  static let maxEvents = 32
  static let maxTextMessages = 64
  static let maxTextBytes = 2 * 1024 * 1024

  enum TextKind: Equatable { case event, other, eose, invalid }

  /// Holds bounded complete text envelopes, including OTHER and EOSE, like Android's
  /// `List<String>` result. Structural interpretation remains the trusted caller's job.
  struct TextCollector {
    private(set) var envelopes: [String] = []
    private var bytes = 0
    private var eventCount = 0
    private var ended = false

    mutating func accept(_ values: [(String, TextKind)]) throws -> Bool {
      guard values.count <= PublishedRelayWebSocketQuery.maxTextMessages - envelopes.count else { throw Failure.limit }
      let newBytes = values.reduce(0) { $0 + Data($1.0.utf8).count }
      guard newBytes <= PublishedRelayWebSocketQuery.maxTextBytes - bytes else { throw Failure.limit }
      let newEvents = values.filter { $0.1 == .event }.count
      guard newEvents <= PublishedRelayWebSocketQuery.maxEvents - eventCount,
            !values.contains(where: { $0.1 == .invalid }) else { throw Failure.limit }
      var sawEOSE = false
      for (_, kind) in values {
        guard !ended && !sawEOSE else { throw Failure.frame }
        if kind == .eose { sawEOSE = true }
      }
      envelopes.append(contentsOf: values.map(\.0))
      bytes += newBytes; eventCount += newEvents; ended = sawEOSE
      return sawEOSE
    }
  }

  /// Accepts one bounded response chunk and returns headers plus any coalesced frames.
  /// A second append after completion fails closed.
  struct HandshakeAccumulator {
    private var bytes = Data()
    private var complete = false

    mutating func append(_ chunk: Data) throws -> (headers: Data, prefetchedFrames: Data)? {
      guard !complete, !chunk.isEmpty, chunk.count <= PublishedRelayWebSocketFrames.maxRead,
            bytes.count + chunk.count <= PublishedRelayWebSocketHandshake.maxHeaderBytes + PublishedRelayWebSocketFrames.maxRead else {
        throw Failure.handshake
      }
      bytes.append(chunk)
      let marker = Data([13, 10, 13, 10])
      guard let range = bytes.range(of: marker) else {
        guard bytes.count < PublishedRelayWebSocketHandshake.maxHeaderBytes else { throw Failure.handshake }
        return nil
      }
      guard range.upperBound <= PublishedRelayWebSocketHandshake.maxHeaderBytes else { throw Failure.handshake }
      complete = true
      return (Data(bytes.prefix(upTo: range.upperBound)), Data(bytes.suffix(from: range.upperBound)))
    }
  }

  struct Request {
    let host: String
    let port: UInt16
    let target: String

    init(_ input: String) throws {
      let endpoint: NativeSignerRelayPolicy.Endpoint
      do { endpoint = try NativeSignerRelayPolicy.endpoint(input) } catch { throw Failure.invalidURL }
      host = endpoint.host; port = endpoint.port
      let originalPath = URLComponents(string: input)?.percentEncodedPath ?? ""
      target = originalPath.isEmpty ? "/" : originalPath // Preserve the ordinary query's exact accepted path.
    }

    func upgrade(nonce: Data) throws -> Data {
      guard nonce.count == 16 else { throw Failure.handshake }
      let authority = port == 443 ? host : "\(host):\(port)"
      let text = "GET \(target) HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: \(nonce.base64EncodedString())\r\nSec-WebSocket-Version: 13\r\n\r\n"
      let data = Data(text.utf8)
      guard data.count <= PublishedRelayWebSocketHandshake.maxHeaderBytes else { throw Failure.invalidURL }
      return data
    }
  }

  struct PublicationControl: Sendable {
    let mayContinue: @Sendable () -> Bool
    let send: @Sendable (@Sendable () -> Void) throws -> Void
  }
  static func query(_ url: String, subscription: String,
                    publication: PublicationControl? = nil,
                    classifyText: @escaping @Sendable (String) throws -> TextKind,
                    completion: @escaping @Sendable (Result<[String], Error>) -> Void) throws -> Operation {
    let request = try Request(url)
    guard Data(subscription.utf8).count <= PublishedRelayWebSocketClientFrames.maxTextBytes,
          String(data: Data(subscription.utf8), encoding: .utf8) == subscription else { throw Failure.invalidURL }
    let operation = Operation(request: request, subscription: subscription, classifyText: classifyText, completion: completion)
    operation.publication = publication
    operation.start()
    return operation
  }

  /// Persistent reads reuse the pinned transport. One frame resumes only after native acknowledgement.
  typealias StreamDelivery = @Sendable (String, @escaping @Sendable () -> Void) -> Void
  static func stream(_ url: String, subscription: String, subscriptionId: String,
    delivery: @escaping StreamDelivery, completion: @escaping @Sendable (Result<[String], Error>) -> Void) throws -> Operation {
    let request = try Request(url)
    guard Data(subscription.utf8).count <= PublishedRelayWebSocketClientFrames.maxTextBytes else { throw Failure.invalidURL }
    let operation = Operation(request: request, subscription: subscription,
      classifyText: { PublishedRelayEnvelope.classify($0, subscriptionId: subscriptionId) }, completion: completion)
    operation.streamDelivery = delivery
    operation.start()
    return operation
  }

#if HYPERGOLIC_NETWORK_PROOF
  /// Host-only proof seam. The production query cannot choose addresses or trust anchors.
  static func queryForProof(_ url: String, subscription: String,
                            addresses: [PublishedPinnedHTTPS.Address], anchorDER: Data?,
                            publication: PublicationControl? = nil,
                            classifyText: @escaping @Sendable (String) throws -> TextKind,
                            completion: @escaping @Sendable (Result<[String], Error>) -> Void) throws -> Operation {
    let request = try Request(url)
    guard Data(subscription.utf8).count <= PublishedRelayWebSocketClientFrames.maxTextBytes,
          String(data: Data(subscription.utf8), encoding: .utf8) == subscription,
          !addresses.isEmpty else { throw Failure.invalidURL }
    let operation = Operation(request: request, subscription: subscription,
                              classifyText: classifyText, completion: completion)
    operation.proofAddresses = addresses
    operation.proofAnchorDER = anchorDER
    operation.publication = publication
    operation.start()
    return operation
  }
#endif

  private final class CancellationState: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var connection: NWConnection?
    func attach(_ value: NWConnection) -> Bool {
      lock.withLock { guard !cancelled else { value.cancel(); return false }; connection = value; return true }
    }
    func cancel() { lock.withLock { cancelled = true; connection?.cancel(); connection = nil } }
  }
  final class Operation: @unchecked Sendable {
    private let request: Request
    private let subscription: String
    private let classifyText: @Sendable (String) throws -> TextKind
    private let completion: @Sendable (Result<[String], Error>) -> Void
    private let queue = DispatchQueue(label: "org.nostrocket.hypergolic.published-relay-wss")
    private let frames = PublishedRelayWebSocketFrames()
    private let cancellation = CancellationState()
    private var connection: NWConnection?
    private var addresses: VettedAddressCursor<PublishedPinnedHTTPS.Address>?
    private var nonce = Data()
    private var handshake = HandshakeAccumulator()
    private var total = 0
    private var collector = TextCollector()
    private var ended = false
    fileprivate var publication: PublicationControl?
    fileprivate var streamDelivery: StreamDelivery?
    private var streamTexts: [String] = []
    private var streamBytes = 0
    private var waiting = false
    private var streamEOSE = false
    private var rateStart = ContinuousClock.now
    private var rateFrames = 0
    private var rateBytes = 0
#if HYPERGOLIC_NETWORK_PROOF
    fileprivate var proofAddresses: [PublishedPinnedHTTPS.Address]?
    fileprivate var proofAnchorDER: Data?
#endif

    fileprivate init(request: Request, subscription: String,
                     classifyText: @escaping @Sendable (String) throws -> TextKind,
                     completion: @escaping @Sendable (Result<[String], Error>) -> Void) {
      self.request = request; self.subscription = subscription; self.classifyText = classifyText; self.completion = completion
    }

    fileprivate func start() {
      guard publication?.mayContinue() != false else { finish(.failure(Failure.cancelled)); return }
      queue.asyncAfter(deadline: .now() + 10) { if self.streamDelivery == nil || !self.streamEOSE { self.finish(.failure(Failure.timeout)) } }
#if HYPERGOLIC_NETWORK_PROOF
      if let proofAddresses {
        queue.async {
          guard !self.ended else { return }
          self.addresses = VettedAddressCursor(proofAddresses)
          self.connectNext()
        }
        return
      }
#endif
      DispatchQueue.global(qos: .utility).async {
        let result = Result { try PublishedPinnedHTTPS.resolve(self.request.host) }
        self.queue.async {
          guard !self.ended else { return }
          switch result {
          case .failure(let error): self.finish(.failure(error))
          case .success(let addresses):
            self.addresses = VettedAddressCursor(addresses)
            self.connectNext()
          }
        }
      }
    }

    func cancel() { cancellation.cancel(); queue.async { self.finish(.failure(Failure.cancelled)) } }

    private func connectNext() {
      guard publication?.mayContinue() != false else { finish(.failure(Failure.cancelled)); return }
      guard let address = addresses?.next() else { finish(.failure(Failure.connection)); return }
      connection?.stateUpdateHandler = nil
      connection?.cancel()
      connection = nil
      connect(address)
    }

    private func connect(_ address: PublishedPinnedHTTPS.Address) {
      var random = [UInt8](repeating: 0, count: 16)
      guard SecRandomCopyBytes(kSecRandomDefault, random.count, &random) == errSecSuccess else { finish(.failure(Failure.handshake)); return }
      nonce = Data(random)
      let tls = NWProtocolTLS.Options()
      request.host.withCString { sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, $0) }
      sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
      let expectedHost = request.host
#if HYPERGOLIC_NETWORK_PROOF
      let proofAnchorDER = proofAnchorDER
#endif
      sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, peerTrust, verify in
        let trust = sec_trust_copy_ref(peerTrust).takeRetainedValue()
        let policy = SecPolicyCreateSSL(true, expectedHost as CFString)
        guard SecTrustSetPolicies(trust, policy) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { verify(false); return }
#if HYPERGOLIC_NETWORK_PROOF
        if let proofAnchorDER {
          guard let anchor = SecCertificateCreateWithData(nil, proofAnchorDER as CFData),
                SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
                SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess
          else { verify(false); return }
        }
#endif
        verify(SecTrustEvaluateWithError(trust, nil))
      }, queue)
      let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
      guard let port = NWEndpoint.Port(rawValue: request.port) else { finish(.failure(Failure.invalidURL)); return }
      let connection = NWConnection(host: address.host, port: port, using: parameters)
      self.connection = connection
      guard cancellation.attach(connection) else { finish(.failure(Failure.cancelled)); return }
      connection.stateUpdateHandler = { [weak self] state in
        guard let self, !self.ended, self.connection === connection else { return }
        switch state {
        case .ready:
          guard self.addresses?.markReady() == true else { return }
          do {
            let request = try self.request.upgrade(nonce: self.nonce)
            connection.send(content: request, completion: .contentProcessed { error in
              if error != nil { self.finish(.failure(Failure.connection)) } else { self.receiveHandshake() }
            })
          } catch { self.finish(.failure(error)) }
        case .failed, .cancelled, .waiting: self.connectNext()
        default: break
        }
      }
      connection.start(queue: queue)
    }

    private func receiveHandshake() {
      guard !ended, let connection else { return }
      connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
        guard !self.ended else { return }
        guard error == nil, !complete, let data, !data.isEmpty else { self.finish(.failure(Failure.handshake)); return }
        let parts: (headers: Data, prefetchedFrames: Data)?
        do { parts = try self.handshake.append(data) }
        catch { self.finish(.failure(error)); return }
        self.total += data.count
        guard self.total <= PublishedRelayWebSocketQuery.maxWireBytes else { self.finish(.failure(Failure.limit)); return }
        if let parts {
          do { try PublishedRelayWebSocketHandshake.validate(parts.headers, nonce: self.nonce) }
          catch { self.finish(.failure(error)); return }
          do {
            let frame = try PublishedRelayWebSocketClientFrames.textReq(self.subscription)
            let emit: @Sendable () -> Void = {
              connection.send(content: frame, completion: .contentProcessed { sendError in
                if sendError != nil { self.finish(.failure(Failure.connection)) }
                else if parts.prefetchedFrames.isEmpty { self.receiveFrames() }
                else { self.consumeFrames(parts.prefetchedFrames) }
              })
            }
            if let publication = self.publication { try publication.send(emit) } else { emit() }
          } catch { self.finish(.failure(error)) }
        } else { self.receiveHandshake() }
      }
    }

    private func receiveFrames() {
      guard !ended, let connection else { return }
      connection.receive(minimumIncompleteLength: 1, maximumLength: PublishedRelayWebSocketFrames.maxRead) { data, _, complete, error in
        guard !self.ended else { return }
        guard error == nil, !complete, let data, !data.isEmpty else { self.finish(.failure(Failure.connection)); return }
        if self.streamDelivery == nil {
          self.total += data.count
          guard self.total <= PublishedRelayWebSocketQuery.maxWireBytes else { self.finish(.failure(Failure.limit)); return }
        } else {
          let now = ContinuousClock.now
          if self.rateStart.duration(to: now) >= .seconds(1) { self.rateStart = now; self.rateBytes = 0; self.rateFrames = 0 }
          self.rateBytes += data.count
          guard self.rateBytes <= 2 * 1024 * 1024 else { self.finish(.failure(Failure.limit)); return }
        }
        self.consumeFrames(data)
      }
    }

    private func consumeFrames(_ data: Data) {
      guard !ended, let connection else { return }
      let events = frames.feed(data)
      if events.contains(where: { if case .error = $0 { return true }; return false }) {
        finish(.failure(Failure.frame)); return
      }
      // Classify every decoded text before mutating bounded result storage or honoring EOSE.
      var texts: [(String, TextKind)] = []
      for event in events {
        guard case .text(let text) = event else { continue }
        do {
          let kind = try classifyText(text)
          guard kind != .invalid else { finish(.failure(Failure.frame)); return }
          texts.append((text, kind))
        } catch { finish(.failure(error)); return }
      }
      if streamDelivery != nil {
        rateFrames += events.count
        guard rateFrames <= 64, streamTexts.count + texts.count <= 64 else { finish(.failure(Failure.limit)); return }
        let bytes = texts.reduce(0) { $0 + $1.0.utf8.count }
        guard streamBytes + bytes <= 256 * 1024 else { finish(.failure(Failure.limit)); return }
        for event in events {
          switch event {
          case .ping(let payload):
            do { connection.send(content: try PublishedRelayWebSocketClientFrames.pong(payload), completion: .contentProcessed { error in if error != nil { self.finish(.failure(Failure.connection)) } }) }
            catch { finish(.failure(error)); return }
          case .close, .error: finish(.failure(Failure.closed)); return
          default: break
          }
        }
        if texts.contains(where: { $0.1 == .eose }) { streamEOSE = true }
        streamTexts.append(contentsOf: texts.map(\.0)); streamBytes += bytes
        pumpStream()
        return
      }
      let sawEOSE: Bool
      do { sawEOSE = try collector.accept(texts) }
      catch { finish(.failure(error)); return }
      for event in events {
          switch event {
          case .text:
            break
          case .ping(let payload):
            do {
              let pong = try PublishedRelayWebSocketClientFrames.pong(payload)
              connection.send(content: pong, completion: .contentProcessed { error in if error != nil { self.finish(.failure(Failure.connection)) } })
            } catch { self.finish(.failure(error)); return }
          case .pong: break
          case .close, .error: self.finish(.failure(Failure.frame)); return
          }
      }
      if sawEOSE { finish(.success(collector.envelopes)); return }
      receiveFrames()
    }

    private func pumpStream() {
      guard !ended, !waiting, let streamDelivery else { return }
      guard !streamTexts.isEmpty else { receiveFrames(); return }
      let text = streamTexts.removeFirst(); streamBytes -= text.utf8.count; waiting = true
      streamDelivery(text) { [weak self] in
        guard let self else { return }
        self.queue.async { guard !self.ended, self.waiting else { return }; self.waiting = false; self.pumpStream() }
      }
    }

    private func finish(_ result: Result<[String], Error>) {
      guard !ended else { return }
      ended = true; connection?.stateUpdateHandler = nil; cancellation.cancel(); connection = nil
      completion(result)
    }
  }
}
