import Foundation
import Network
import Security

/// Private raw PUT lane bound to a native exact-body grant. No generic guest network API.
enum UploadPinnedHTTPS {
  private final class ResolutionSlots: @unchecked Sendable {
    private let lock = NSLock()
    private var active = 0
    func acquire() -> Bool { lock.withLock { guard active < 2 else { return false }; active += 1; return true } }
    func release() { lock.withLock { active -= 1 } }
  }
  private static let resolutionSlots = ResolutionSlots()
  struct Failure: Error {
    let code: String
    let dispatched: Bool
  }
  typealias Completion = @Sendable (Result<PublishedHTTPResponse, Failure>) -> Void
  static func put(_ authority: NativeUploadAuthority, grant: NativeUploadAuthority.Grant,
                  permit: NativeBlossomPermit, progress: @escaping @Sendable (Int) -> Void,
                  completion: @escaping Completion) throws -> Operation {
    let operation = try Operation(authority, grant, permit, progress: progress, completion: completion)
    operation.start(); return operation
  }
#if HYPERGOLIC_NETWORK_PROOF
  /// Only the owning native proof build admits disposable loopback addresses and anchors.
  static func putForProof(_ authority: NativeUploadAuthority, grant: NativeUploadAuthority.Grant,
                         permit: NativeBlossomPermit, addresses: [PublishedPinnedHTTPS.Address], anchorDER: Data?,
                         now: @escaping @Sendable () -> Int64, progress: @escaping @Sendable (Int) -> Void,
                         completion: @escaping Completion) throws -> Operation {
    let operation = try Operation(authority, grant, permit, now: now, progress: progress, completion: completion)
    operation.proofAddresses = addresses; operation.proofAnchorDER = anchorDER
    operation.start(); return operation
  }
#endif
  final class Operation: @unchecked Sendable {
    private let authority: NativeUploadAuthority
    private let grant: NativeUploadAuthority.Grant
    private let permit: NativeBlossomPermit
    private let progress: @Sendable (Int) -> Void
    private let completion: Completion
    private let now: @Sendable () -> Int64
    private let queue = DispatchQueue(label: "org.nostrocket.hypergolic.upload-https")
    private let timer: DispatchSourceTimer
    private let accumulator: PublishedHTTPResponseAccumulator
    private var addresses: VettedAddressCursor<PublishedPinnedHTTPS.Address>?
    private var connection: NWConnection?
    private var body: Data?
    private var ended = false
#if HYPERGOLIC_NETWORK_PROOF
    fileprivate var proofAddresses: [PublishedPinnedHTTPS.Address]?
    fileprivate var proofAnchorDER: Data?
#endif
    fileprivate init(_ authority: NativeUploadAuthority, _ grant: NativeUploadAuthority.Grant,
                     _ permit: NativeBlossomPermit, now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) },
                     progress: @escaping @Sendable (Int) -> Void, completion: @escaping Completion) throws {
      guard authority.approvedReview(grant) === permit.review, permit.validAt(now()),
        authority.claimTransfer(grant) else { throw Failure(code: "policy denied", dispatched: false) }
      self.authority = authority; self.grant = grant; self.permit = permit; self.now = now
      self.progress = progress; self.completion = completion
      accumulator = try PublishedHTTPResponseAccumulator(maximumBodyBytes: PublishedHTTPResponse.maximumUploadBodyBytes, uploadProfile: true)
      timer = DispatchSource.makeTimerSource(queue: queue)
    }
    fileprivate func start() {
      timer.schedule(deadline: .now(), repeating: .milliseconds(25))
      timer.setEventHandler { [weak self] in
        guard let self, !self.ended else { return }; if !self.active() { self.fail("user cancelled") }
      }
      timer.resume()
      queue.asyncAfter(deadline: .now() + 60) { [weak self] in self?.fail("upload failed") }
#if HYPERGOLIC_NETWORK_PROOF
      if let proofAddresses {
        queue.async { guard !self.ended else { return }; self.addresses = VettedAddressCursor(proofAddresses); self.connectNext() }
        return
      }
#endif
      guard UploadPinnedHTTPS.resolutionSlots.acquire() else { queue.async { self.fail("quota exceeded") }; return }
      let host = URLComponents(string: permit.review.destination)!.host!
      DispatchQueue.global(qos: .utility).async {
        let resolved = Result { try PublishedPinnedHTTPS.resolve(host) }
        UploadPinnedHTTPS.resolutionSlots.release()
        self.queue.async {
          guard !self.ended else { return }
          switch resolved {
          case .success(let addresses): self.addresses = VettedAddressCursor(addresses); self.connectNext()
          case .failure(let error): self.fail(error is PublishedPinnedHTTPS.Failure ? "policy denied" : "upload failed")
          }
        }
      }
    }
    /// Revoke synchronously; queued native I/O then observes the permanent grant loss.
    func cancel() { authority.cancelGrant(grant); queue.async { self.fail("user cancelled") } }
    private func active() -> Bool { authority.isApproved(grant) && permit.validAt(now()) }
    private func connectNext() {
      guard !ended, active(), let address = addresses?.next() else { fail("upload failed"); return }
      connection?.stateUpdateHandler = nil; connection?.cancel(); connection = nil
      let components = URLComponents(string: permit.review.destination)!, host = components.host!
      guard let port = NWEndpoint.Port(rawValue: UInt16(components.port ?? 443)) else { fail("policy denied"); return }
      let tls = NWProtocolTLS.Options()
      host.withCString { sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, $0) }
      sec_protocol_options_add_tls_application_protocol(tls.securityProtocolOptions, "http/1.1")
      sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
#if HYPERGOLIC_NETWORK_PROOF
      let proofAnchorDER = proofAnchorDER
#endif
      sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, peerTrust, verify in
        let trust = sec_trust_copy_ref(peerTrust).takeRetainedValue()
        guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
          SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { verify(false); return }
#if HYPERGOLIC_NETWORK_PROOF
        if let proofAnchorDER {
          guard let anchor = SecCertificateCreateWithData(nil, proofAnchorDER as CFData),
            SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
            SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else { verify(false); return }
        }
#endif
        verify(SecTrustEvaluateWithError(trust, nil))
      }, queue)
      let connection = NWConnection(host: address.host, port: port, using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
      self.connection = connection
      connection.stateUpdateHandler = { [weak self] state in
        guard let self, !self.ended, self.connection === connection else { return }
#if HYPERGOLIC_NETWORK_PROOF
        if ProcessInfo.processInfo.environment["HYPERGOLIC_UPLOAD_TRACE"] == "1" {
          FileHandle.standardError.write(Data("Upload proof state: \(state)\n".utf8))
        }
#endif
        switch state {
        case .ready:
          guard self.addresses?.markReady() == true, self.active(), let body = self.authority.dispatch(self.grant) else { self.fail("user cancelled"); return }
          self.body = body
          let authority = host + (components.port == nil || components.port == 443 ? "" : ":" + String(components.port!))
          let headers = "PUT /upload HTTP/1.1\r\nHost: " + authority + "\r\nContent-Type: " + self.permit.review.mimeType +
            "\r\nContent-Length: " + String(body.count) + "\r\nX-SHA-256: " + self.permit.review.sha256 +
            "\r\nAuthorization: " + self.permit.authorization + "\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n"
          self.send(Data(headers.utf8)) { self.sendBody(0) }
        case .failed, .cancelled, .waiting: self.connectNext()
        default: break
        }
      }
      connection.start(queue: queue)
    }
    private func send(_ bytes: Data, then next: @escaping @Sendable () -> Void) {
      guard !ended, active(), let connection else { fail("user cancelled"); return }
      connection.send(content: bytes, completion: .contentProcessed { error in
        guard !self.ended else { return }; if error != nil { self.fail("upload failed") } else { next() }
      })
    }
    private func sendBody(_ offset: Int) {
      guard !ended, active(), let body else { fail("user cancelled"); return }
      if offset == body.count { receive(); return }
      let end = min(offset + 8192, body.count)
      send(body.subdata(in: offset..<end)) { self.progress(end); self.sendBody(end) }
    }
    private func receive() {
      guard !ended, active(), let connection else { fail("user cancelled"); return }
      connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
        guard !self.ended else { return }; if error != nil { self.fail("upload failed"); return }
        do {
          if let data { try self.accumulator.append(data) }
          if complete {
            let response = try self.accumulator.finish()
            guard self.active() else { self.fail("user cancelled"); return }; self.finish(.success(response))
          } else if data == nil || data?.isEmpty == true { self.fail("upload failed") }
          else { self.receive() }
        } catch PublishedHTTPResponse.Failure.uploadStatus(let status) {
          let code = status == 413 ? "file too large" : status == 429 ? "quota exceeded" :
            (400...499).contains(status) ? "server rejected" : "outcome unknown"
          self.finish(.failure(Failure(code: code, dispatched: self.authority.wasDispatched(self.grant))))
        } catch { self.fail("upload failed") }
      }
    }
    private func fail(_ beforeDispatchCode: String) {
      let dispatched = authority.wasDispatched(grant)
      finish(.failure(Failure(code: dispatched ? "outcome unknown" : beforeDispatchCode, dispatched: dispatched)))
    }
    private func finish(_ result: Result<PublishedHTTPResponse, Failure>) {
      guard !ended else { return }; ended = true; timer.cancel()
      connection?.stateUpdateHandler = nil; connection?.cancel(); connection = nil
      if body != nil { body!.resetBytes(in: 0..<body!.count); body = nil }
      completion(result)
    }
    deinit { timer.cancel() }
  }
}
