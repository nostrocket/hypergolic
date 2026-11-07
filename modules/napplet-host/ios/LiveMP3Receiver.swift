import Foundation

/// Per-response parser reset retains original budget and decoder. Redirects cannot renew either.
final class LiveMP3Receiver: PublishedHTTPStreamSink {
  let idleSeconds = 10
  private let budget: LiveMP3Budget
  private let active: () throws -> Void
  private let decoder: LiveMP3AudioQueue
  private let gate: LiveMP3Gate
  private var parser: LiveMP3Response!
  private var audio = false
  init(budget: LiveMP3Budget,active: @escaping () throws -> Void,decoder: LiveMP3AudioQueue) {
    self.budget=budget;self.active=active;self.decoder=decoder
    gate=LiveMP3Gate(output:decoder.append)
    reset()
  }
  var maximumReadSize: Int { budget.readAllowance }
  private func reset() {
    parser=LiveMP3Response(budget:budget,active:active,output:{ [weak self] data in
      guard let self else { throw LiveMP3Budget.Failure.retired };self.audio=true;try self.gate.append(data)
    })
  }
  func append(_ chunk: Data) throws { try parser.append(chunk) }
  func finish() throws { try parser.finish();try gate.finish();try budget.finishedTransport();try decoder.finish() }
  func resetResponse() throws { guard !audio else { throw LiveMP3Response.Failure.framing };try active();reset() }
  func cancel() { decoder.cancel() }
}
