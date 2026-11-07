import Foundation

/// Strong process reservation. Unknown decoder cleanup keeps its owner reachable and blocks replacement.
final class MediaPlaybackReservation: @unchecked Sendable {
  static let shared = MediaPlaybackReservation()
  private let lock = NSLock()
  private var owner: AnyObject?
  private var draining=false,uncertain=false
  func acquire(_ value: AnyObject) -> Bool { lock.withLock {
    guard owner == nil || owner === value else { return false };if owner == nil { owner = value;draining=false;uncertain=false };return true
  } }
  func release(_ value: AnyObject) { lock.withLock { if owner === value { owner = nil;draining=false;uncertain=false } } }
  func draining(_ value:AnyObject){lock.withLock{if owner === value{draining=true}}}
  func uncertain(_ value:AnyObject){lock.withLock{if owner === value{uncertain=true}}}
  var hint:String{lock.withLock{
    if uncertain{return "A player could not close cleanly. Restart Hypergolic before playing another source."}
    if draining{return "The previous player is stopping. Try Play again shortly."}
    return "Close the other video or radio player, then try Play again."
  }}

}
final class LiveMP3Owner: @unchecked Sendable {
  static let profile = "finite-live-mp3-v1"
  enum Phase { case offered, buffering, playing, stopping, paused, ended }
  private let lock = NSLock(), scope: String, profile: String?
  private let clock: @Sendable () -> UInt64
  private let duration: UInt64
  private var budgetValue: LiveMP3Budget?, receipt: String?, retained: AnyObject?
  private var phaseValue: Phase = .offered
  private var attempt: UInt64 = 0
  private var network = false, decoder = false, terminal = false, uncertain = false,terminalTaken=false
  private var reasonValue:String?
  init(profile: String?,scope: String,clock: @escaping @Sendable () -> UInt64 = { LiveMP3Budget.milliseconds() },duration: UInt64 = LiveMP3Budget.sessionMilliseconds) {
    self.profile=profile;self.scope=scope;self.clock=clock;self.duration=duration
  }
  func nativePlay(scope: String,receipt: String?,foreground: Bool,focused: Bool,retaining: AnyObject) throws -> UInt64 {
    try lock.withLock {
      guard profile == Self.profile,self.scope == scope,let receipt,foreground,focused,!terminal,!network,!decoder,
        attempt < UInt64.max,MediaPlaybackReservation.shared.acquire(self) else { throw LiveMP3Budget.Failure.retired }
      do {
        if budgetValue == nil { budgetValue = LiveMP3Budget(clock:clock,duration:duration) }
        try budgetValue!.beginAttempt();self.receipt=receipt;attempt += 1;network=true;decoder=true;phaseValue = .buffering;retained=retaining
        return attempt
      } catch { terminal=true;phaseValue = .ended;reasonValue="policy";MediaPlaybackReservation.shared.release(self);throw error }
    }
  }
  func check(_ token: UInt64,scope: String,receipt: String?,foreground: Bool,focused: Bool) throws {
    try lock.withLock {
      guard !terminal,token == attempt,self.scope == scope,let receipt,self.receipt == receipt,foreground,focused,
        phaseValue == .buffering || phaseValue == .playing else { throw LiveMP3Budget.Failure.retired }
      try budgetValue!.check()
    }
  }
  func output(_ token: UInt64) throws { try lock.withLock {
    guard !terminal,token == attempt,phaseValue == .buffering else { throw LiveMP3Budget.Failure.retired }
    try budgetValue!.markOutput();phaseValue = .playing
  } }
  func pause() -> Bool { lock.withLock {
    guard !terminal,phaseValue == .buffering || phaseValue == .playing else { return false }
    receipt=nil;phaseValue = network || decoder ? .stopping:.paused
    do { try budgetValue?.pause() } catch {
      terminal=true;reasonValue="policy";phaseValue = .ended;budgetValue?.cancel();MediaPlaybackReservation.shared.draining(self)
    };return true
  } }
  func retire(_ reason:String="policy") -> Bool { lock.withLock {
    guard !terminal else { return false };terminal=true;reasonValue=reason;receipt=nil;phaseValue = .ended;budgetValue?.cancel();MediaPlaybackReservation.shared.draining(self)
    if !network && !decoder { MediaPlaybackReservation.shared.release(self);retained=nil };return true
  } }
  func drained(_ token: UInt64,transport: Bool) { lock.withLock {
    guard token == attempt else { return };if transport { network=false } else if !uncertain { decoder=false }
    if !network && !decoder { MediaPlaybackReservation.shared.release(self);retained=nil;if !terminal { phaseValue = .paused } }
  } }
  func budget(_ token: UInt64) throws -> LiveMP3Budget { try lock.withLock {
    guard token == attempt,!terminal,let budgetValue else { throw LiveMP3Budget.Failure.retired };return budgetValue
  } }
  func uncertainCleanup(){lock.withLock{
    uncertain=true;terminal=true;reasonValue="backend-exited";receipt=nil;phaseValue = .ended;budgetValue?.cancel();MediaPlaybackReservation.shared.uncertain(self)
  }}
  var reason:String?{lock.withLock{reasonValue}}
  func takeTerminal()->String?{lock.withLock{
    guard terminal,!terminalTaken,uncertain || (!network && !decoder) else{return nil}
    terminalTaken=true;return reasonValue
  }}
  var drained: Bool { lock.withLock { !network && !decoder } }
  var phase: Phase { lock.withLock { phaseValue } }
}
