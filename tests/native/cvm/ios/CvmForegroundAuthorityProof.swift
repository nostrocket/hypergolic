@main
enum CvmForegroundAuthorityProof {
  typealias Authority = NativeCvmServiceAuthority

  static func main() throws {
    let authority = Authority(clock: { 1_000 })
    let user = String(repeating: "a", count: 64)
    let provider = String(repeating: "b", count: 64)
    let relay = "wss://relay.example"
    let message = #"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#

    func register(_ card: String, epoch: Int64 = 1) throws -> Authority.Registration {
      let source = try Authority.Source(endpoint: card, generation: card, user: user, epoch: epoch,
        publisher: String(repeating: "c", count: 64), appId: card,
        version: String(repeating: "d", count: 64), instance: card)
      guard let registration = authority.register(source) else { fatalError("Could not register " + card) }
      return registration
    }
    func request(_ card: Authority.Registration) -> Authority.Request? {
      authority.admit(card, provider: provider, operation: "tools/list", exactMessage: message,
        relays: [relay], timeoutMillis: 30_000)
    }
    func approve(_ card: Authority.Registration) -> Authority.Permit {
      guard let pending = request(card), authority.review()?.request === pending,
        let permit = authority.approve(pending) else { fatalError("Expected a reviewed permit") }
      return permit
    }
    func consume(_ permit: Authority.Permit) -> Bool {
      authority.consume(permit, provider: provider, exactMessage: message, relay: relay)
    }

    authority.account(user: user, epoch: 1)
    authority.setForeground(true)
    let first = try register("first"), second = try register("second")
    let firstPermit = approve(first), secondPermit = approve(second)
    guard let firstPending = request(first), let secondPending = request(second) else {
      fatalError("Expected both cards to have a pending request")
    }
    authority.revoke(first)
    precondition(!consume(firstPermit) && authority.approve(firstPending) == nil && request(first) == nil)
    precondition(authority.review()?.request === secondPending && secondPermit.current())
    precondition(consume(secondPermit) && authority.finish(secondPermit))

    guard let beforeBackground = authority.approve(secondPending), let queued = request(second) else {
      fatalError("Expected the second card to continue independently")
    }
    authority.setForeground(false)
    authority.setForeground(true)
    precondition(!consume(beforeBackground) && authority.approve(queued) == nil && request(second) == nil)

    let reopened = try register("second")
    let beforeSwitch = approve(reopened)
    authority.account(user: String(repeating: "e", count: 64), epoch: 2)
    authority.account(user: user, epoch: 3)
    precondition(!consume(beforeSwitch) && request(reopened) == nil)

    let fresh = try register("second", epoch: 3)
    let accepted = approve(fresh)
    precondition(consume(accepted) && !consume(accepted) && authority.finish(accepted))
    print("CVM foreground authority lifecycle passed")
  }
}
