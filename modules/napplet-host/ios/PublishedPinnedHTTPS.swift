import Foundation
import Network
import Security

/// Walk only the addresses already vetted by the native public-address policy.
/// Once a connection reaches ready, failures belong to that session and cannot fail over.
struct VettedAddressCursor<Address> {
  private let addresses: [Address]
  private var index = 0
  private(set) var ready = false

  init(_ addresses: [Address]) { self.addresses = addresses }

  mutating func next() -> Address? {
    guard !ready, index < addresses.count else { return nil }
    defer { index += 1 }
    return addresses[index]
  }

  mutating func markReady() -> Bool {
    guard !ready else { return false }
    ready = true
    return true
  }
}

/// HTTPS fetch over a numeric, vetted endpoint. URLSession cannot bind a DNS result
/// before connecting, so this owner resolves first and never gives NWConnection a name.
enum PublishedPinnedHTTPS {
  private final class RecoveryResolutionSlots: @unchecked Sendable {
    private let lock = NSLock(); private var count = 0
    func acquire() -> Bool { lock.withLock { guard count < 2 else { return false }; count += 1; return true } }
    func release() { lock.withLock { count -= 1 } }
  }
  private static let recoveryResolutionSlots = RecoveryResolutionSlots()
  enum Failure: Error { case invalidURL, resolution, privateAddress, connection, cancelled }

  struct Request {
    let source: String
    let host: String
    let port: UInt16
    let target: String
    let resourceProfile: Bool
    let recoveryProfile: Bool

    init(_ input: String, resourceProfile: Bool = false, recoveryProfile: Bool = false) throws {
      guard input.utf8.count <= 8192, !input.contains("\\"),
            let components = URLComponents(string: input), components.scheme == "https",
            components.user == nil, components.password == nil, components.fragment == nil,
            let host = components.host?.lowercased(), host.count <= 253, host.contains("."),
            !host.contains(":"), !host.hasSuffix("."),
            !["localhost", "local", "internal", "home", "home.arpa", "lan", "test", "example", "invalid", "onion", "arpa"].contains(where: { host == $0 || host.hasSuffix(".\($0)") }),
            host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ !$0.isEmpty && $0.count <= 63 }),
            components.port == nil || (1...65535).contains(components.port!)
      else { throw Failure.invalidURL }
      // Reject literal and non-ASCII spellings; the native certificate policy uses this exact name.
      let labels = host.split(separator: ".", omittingEmptySubsequences: false)
      guard labels.allSatisfy({ label in
        label.utf8.allSatisfy({ ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 }) &&
          label.first != "-" && label.last != "-"
      }), !host.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || $0 == 46 })
      else { throw Failure.invalidURL }
      let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
      let query = components.percentEncodedQuery.map { "?\($0)" } ?? ""
      let target = path + query
      guard target.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }), target.hasPrefix("/"),
            target.range(of: "%([01][0-9a-fA-F]|7[fF])", options: .regularExpression) == nil
      else { throw Failure.invalidURL }
      self.source = input
      self.host = host
      self.port = UInt16(components.port ?? 443)
      self.target = target
      guard !(resourceProfile && recoveryProfile) else { throw Failure.invalidURL }
      if recoveryProfile {
        guard components.query == nil, target.range(of: "^/[0-9a-f]{64}(\\.[A-Za-z0-9]{1,16})?$", options: .regularExpression) != nil else { throw Failure.invalidURL }
      }
      self.resourceProfile = resourceProfile; self.recoveryProfile = recoveryProfile
    }

    var wire: Data {
      let authority = port == 443 ? host : "\(host):\(port)"
      return Data("GET \(target) HTTP/1.1\r\nHost: \(authority)\r\nAccept: \((resourceProfile || recoveryProfile) ? "*/*" : "text/html")\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n".utf8)
    }
  }

  struct Address: Sendable {
    let host: NWEndpoint.Host
    let bytes: Data
  }

  static func resolve(_ host: String) throws -> [Address] {
    var hints = addrinfo()
    hints.ai_family = AF_UNSPEC
    hints.ai_socktype = Int32(SOCK_STREAM)
    hints.ai_protocol = IPPROTO_TCP
    var head: UnsafeMutablePointer<addrinfo>?
    guard getaddrinfo(host, nil, &hints, &head) == 0, let head else { throw Failure.resolution }
    defer { freeaddrinfo(head) }
    var addresses: [Address] = []
    var next: UnsafeMutablePointer<addrinfo>? = head
    while let item = next {
      defer { next = item.pointee.ai_next }
      guard let socket = item.pointee.ai_addr else { throw Failure.resolution }
      if item.pointee.ai_family == AF_INET {
        let bytes = socket.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { address in
          withUnsafeBytes(of: address.pointee.sin_addr) { Data($0) }
        }
        guard let literal = IPv4Address(bytes) else { throw Failure.resolution }
        addresses.append(Address(host: .ipv4(literal), bytes: bytes))
      } else if item.pointee.ai_family == AF_INET6 {
        let bytes = socket.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) { address in
          withUnsafeBytes(of: address.pointee.sin6_addr) { Data($0) }
        }
        guard let literal = IPv6Address(bytes) else { throw Failure.resolution }
        addresses.append(Address(host: .ipv6(literal), bytes: bytes))
      } else { throw Failure.resolution }
      guard addresses.count <= 32 else { throw Failure.resolution }
    }
    return try vetResolvedAddresses(addresses)
  }

  /// The resolver must reject the whole answer set before any address is tried.
  static func vetResolvedAddresses(_ addresses: [Address]) throws -> [Address] {
    guard !addresses.isEmpty, addresses.allSatisfy({ PublicAddressPolicy.accepts($0.bytes) })
    else { throw Failure.privateAddress }
    return addresses
  }

  /// Caller retains the returned operation to cancel on identity/session/app changes.
  static func fetch(_ input: String, maximumBodyBytes: Int, timeout: TimeInterval = 15,
                    completion: @escaping @Sendable (Result<PublishedHTTPResponse, Error>) -> Void) throws -> Operation {
    let request = try Request(input)
    guard (1...PublishedHTTPResponse.maximumBodyBytes).contains(maximumBodyBytes), timeout > 0, timeout <= 60
    else { throw Failure.invalidURL }
    let operation = try Operation(request: request, maximumBodyBytes: maximumBodyBytes, timeout: timeout, completion: completion)
    operation.start()
    return operation
  }

  /// Separate app-only fixed-hash recovery parser; published/resource policies are unchanged.
  static func fetchRecovery(_ input: String, active: @escaping @Sendable () -> Bool,
    completion: @escaping @Sendable (Result<PublishedHTTPResponse, Error>) -> Void) throws -> Operation {
    let request = try Request(input, recoveryProfile: true)
    let operation = try Operation(request: request, maximumBodyBytes: NativeUploadAuthority.maxBytes, timeout: 60, active: active, completion: completion)
    operation.start(); return operation
  }

  /// Separate resource profile; ordinary published fetch keeps its 2 MiB parser and URL policy.
  static func fetchResource(_ input: String,
                            completion: @escaping @Sendable (Result<PublishedHTTPResponse, Error>) -> Void) throws -> Operation {
    let request = try Request(input, resourceProfile: true)
    let operation = try Operation(request: request, maximumBodyBytes: PublishedHTTPResponse.maximumResourceBodyBytes,
                                  timeout: 15, completion: completion)
    operation.start()
    return operation
  }

#if HYPERGOLIC_NETWORK_PROOF
  /// Host-only proof seam. Production builds never compile address or trust overrides.
  static func fetchForProof(_ input: String, maximumBodyBytes: Int, timeout: TimeInterval = 5,
                            addresses: [Address], anchorDER: Data?, resolverForProof: (@Sendable (String) throws -> [Address])? = nil, recoveryProfile: Bool = false, active: @escaping @Sendable () -> Bool = {true},
                            completion: @escaping @Sendable (Result<PublishedHTTPResponse, Error>) -> Void) throws -> Operation {
    let request = try Request(input, recoveryProfile: recoveryProfile)
    guard (1...(recoveryProfile ? PublishedHTTPResponse.maximumResourceBodyBytes : PublishedHTTPResponse.maximumBodyBytes)).contains(maximumBodyBytes),
          timeout > 0, timeout <= 60, !addresses.isEmpty else { throw Failure.invalidURL }
    let operation = try Operation(request: request, maximumBodyBytes: maximumBodyBytes,
                                  timeout: timeout, completion: completion)
    operation.setActiveForProof(active)
    operation.proofAddresses = addresses
    operation.proofAnchorDER = anchorDER; operation.proofResolver = resolverForProof
    operation.start()
    return operation
  }
#endif

  final class Operation: @unchecked Sendable {
    private var request: Request
    private let timeout: TimeInterval
    private let queue = DispatchQueue(label: "org.nostrocket.hypergolic.published-https")
    private let completion: @Sendable (Result<PublishedHTTPResponse, Error>) -> Void
    private var accumulator: PublishedHTTPResponseAccumulator
    private let maximumBodyBytes: Int
    private let originalRequest: Request
    private var redirects = 0
    private var visited: Set<String> = []
    private var connection: NWConnection?
    private var addresses: VettedAddressCursor<Address>?
    private var ended = false
    private var active: @Sendable () -> Bool
    private var recoveryTimer: DispatchSourceTimer?
#if HYPERGOLIC_NETWORK_PROOF
    fileprivate var proofResolver: (@Sendable (String) throws -> [Address])?
    fileprivate var proofAddresses: [Address]?
    fileprivate var proofAnchorDER: Data?
#endif

    fileprivate init(request: Request, maximumBodyBytes: Int, timeout: TimeInterval, active: @escaping @Sendable () -> Bool = {true},
                     completion: @escaping @Sendable (Result<PublishedHTTPResponse, Error>) -> Void) throws {
      self.request = request; self.originalRequest = request; self.active = active
      self.maximumBodyBytes = maximumBodyBytes
      self.visited.insert(request.source)
      self.timeout = timeout
      self.completion = completion
      self.accumulator = try PublishedHTTPResponseAccumulator(maximumBodyBytes: maximumBodyBytes, resourceProfile: request.resourceProfile, recoveryProfile: request.recoveryProfile)
    }

#if HYPERGOLIC_NETWORK_PROOF
    fileprivate func setActiveForProof(_ active: @escaping @Sendable () -> Bool) { self.active = active }
#endif
    fileprivate func start() {
      if request.recoveryProfile {
        let timer = DispatchSource.makeTimerSource(queue: queue); recoveryTimer = timer
        timer.schedule(deadline: .now(), repeating: .milliseconds(25))
        timer.setEventHandler { [weak self] in guard let self, !self.ended else { return }; if !self.active() { self.finish(.failure(Failure.cancelled)) } }; timer.resume()
      }
      queue.asyncAfter(deadline: .now() + timeout) { self.finish(.failure(Failure.connection)) }
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
      resolveCurrent()
    }

    private func resolveCurrent() {
      guard active() else { finish(.failure(Failure.cancelled)); return }
      let recovery = request.recoveryProfile
      guard !recovery || PublishedPinnedHTTPS.recoveryResolutionSlots.acquire() else { finish(.failure(Failure.resolution)); return }
      let host = request.host
      DispatchQueue.global(qos: .utility).async {
        let result = Result {
#if HYPERGOLIC_NETWORK_PROOF
          if let resolver = self.proofResolver { return try resolver(host) }
#endif
          return try PublishedPinnedHTTPS.resolve(host)
        }
        if recovery { PublishedPinnedHTTPS.recoveryResolutionSlots.release() }
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

    func cancel() { queue.async { self.finish(.failure(Failure.cancelled)) } }

    private func connectNext() {
      guard !ended, active() else { finish(.failure(Failure.cancelled)); return }
      guard let address = addresses?.next() else { finish(.failure(Failure.connection)); return }
      connection?.stateUpdateHandler = nil
      connection?.cancel()
      connection = nil
      connect(address)
    }

    private func connect(_ address: Address) {
      let tls = NWProtocolTLS.Options()
      request.host.withCString { sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, $0) }
      sec_protocol_options_add_tls_application_protocol(tls.securityProtocolOptions, "http/1.1")
      sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
      let name = request.host
#if HYPERGOLIC_NETWORK_PROOF
      let proofAnchorDER = proofAnchorDER
#endif
      sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, peerTrust, verify in
        let trust = sec_trust_copy_ref(peerTrust).takeRetainedValue()
        let policy = SecPolicyCreateSSL(true, name as CFString)
        guard SecTrustSetPolicies(trust, policy) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess
        else { verify(false); return }
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
      connection.stateUpdateHandler = { [weak self] state in
        guard let self, !self.ended, self.connection === connection else { return }
        switch state {
        case .ready:
          guard self.active() else { self.finish(.failure(Failure.cancelled)); return }
          guard self.addresses?.markReady() == true else { return }
          connection.send(content: self.request.wire, completion: .contentProcessed { error in
            if error != nil { self.finish(.failure(Failure.connection)) }
            else { self.receive() }
          })
        case .failed, .cancelled, .waiting: self.connectNext()
        default: break
        }
      }
      connection.start(queue: queue)
    }

    private func receive() {
      guard !ended, let connection else { return }
      guard active() else { finish(.failure(Failure.cancelled)); return }
      connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
        guard !self.ended else { return }
        guard self.active() else { self.finish(.failure(Failure.cancelled)); return }
        if error != nil { self.finish(.failure(Failure.connection)); return }
        do {
          if let data { try self.accumulator.append(data) }
          if complete {
            let response = try self.accumulator.finish()
            // An alternate origin cannot prove absence at the saved provider.
            guard !self.request.recoveryProfile || response.status != 404 ||
              self.request.host == self.originalRequest.host && self.request.port == self.originalRequest.port else { throw Failure.invalidURL }
            self.finish(.success(response))
          }
          else if data == nil || data?.isEmpty == true { self.finish(.failure(Failure.connection)) }
          else { self.receive() }
        } catch PublishedHTTPResponse.Failure.resourceRedirect(let location) {
          self.followRedirect(location)
        } catch PublishedHTTPResponse.Failure.recoveryRedirect(let location) {
          self.followRedirect(location)
        } catch { self.finish(.failure(error)) }
      }
    }

    private func followRedirect(_ location: String) {
      guard active(), request.resourceProfile || request.recoveryProfile, redirects < 2,
        let base = URL(string: request.source), let url = URL(string: location, relativeTo: base)?.absoluteURL,
        !visited.contains(url.absoluteString) else { finish(.failure(PublishedHTTPResponse.Failure.resourcePolicy)); return }
      do {
        let next = try Request(url.absoluteString, resourceProfile: request.resourceProfile, recoveryProfile: request.recoveryProfile)
        if request.recoveryProfile {
          let hash = originalRequest.target.dropFirst().prefix(64)
          guard next.target.dropFirst().prefix(64) == hash else { throw Failure.invalidURL }
        }
        connection?.stateUpdateHandler = nil;connection?.cancel();connection = nil
        redirects += 1;visited.insert(next.source);request = next
        accumulator = try PublishedHTTPResponseAccumulator(maximumBodyBytes:maximumBodyBytes,resourceProfile:next.resourceProfile,recoveryProfile:next.recoveryProfile)
        addresses = nil
        resolveCurrent()
      } catch { finish(.failure(error)) }
    }

    private func finish(_ result: Result<PublishedHTTPResponse, Error>) {
      guard !ended else { return }
      ended = true; recoveryTimer?.cancel(); recoveryTimer = nil
      connection?.stateUpdateHandler = nil
      connection?.cancel()
      connection = nil
      completion(result)
    }
  }
}
