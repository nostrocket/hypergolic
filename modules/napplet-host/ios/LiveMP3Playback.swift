import Foundation

/// Unexported byte-mediated backend. Host integration must supply exact live permit and native source Play.
final class LiveMP3Playback: @unchecked Sendable {
  enum Event: Sendable { case buffering, playing, paused, ended(String) }
  private let control=DispatchQueue(label:"org.nostrocket.hypergolic.live-mp3-owner")
  private let owner: LiveMP3Owner,scope: String,url: String
  private let permit: @Sendable () -> String?
  private let event: @Sendable (Event) -> Void
  private var token: UInt64 = 0
  private var operation: PublishedPinnedHTTPS.Operation?,receiver: LiveMP3Receiver?,decoder: LiveMP3AudioQueue?
  private var terminal: String?,pauseDelivered=false
  private var watch: DispatchSourceTimer?
  private var expiry: Task<Void,Never>?
  init(url: String,profile: String?,scope: String,permit: @escaping @Sendable () -> String?,event: @escaping @Sendable (Event) -> Void) {
    self.url=url;self.scope=scope;self.permit=permit;self.event=event;owner=LiveMP3Owner(profile:profile,scope:scope)
  }
  /// No guest command, including a publisher's autoplay/play-on-capabilities, may call this entry point.
  func nativePlay() -> Bool {
    guard (try? PublishedPinnedHTTPS.Request(url,liveMP3Profile:true)) != nil else { return false }
    guard let value=try? owner.nativePlay(scope:scope,receipt:permit(),foreground:true,focused:true,retaining:self) else {
      if owner.phase == .ended { control.async { [self] in terminal="policy";deliverTerminal() } };return false
    }
    control.async { [self] in setup(value) };return true
  }
  private func valid(_ value: UInt64) -> Bool { (try? owner.check(value,scope:scope,receipt:permit(),foreground:true,focused:true)) != nil }
  private func setup(_ value: UInt64) {
    token=value;pauseDelivered=false
    guard valid(value) else { owner.drained(value,transport:true);owner.drained(value,transport:false);completeDrain();return }
    do {
      let budget=try owner.budget(value)
      if expiry == nil {
        let left=try budget.remaining()
        expiry=Task { [weak self] in
          do { try await Task.sleep(for:.milliseconds(left),clock:.continuous);self?.retire("policy") } catch { }
        }
      }
      let player=try LiveMP3AudioQueue(volume:1,active:{ [weak self] in self?.valid(value) == true },consumed:{ [weak self] in
        guard let self,self.valid(value),self.owner.phase == .buffering,(try? self.owner.output(value)) != nil else { return }
        self.control.async { [weak self] in guard let self,self.token == value,self.valid(value) else { return };self.event(.playing) }
      },ended:{ [weak self] in self?.retire("ended") })
      decoder=player
      let sink=LiveMP3Receiver(budget:budget,active:{ [weak self] in
        guard let self,self.valid(value) else { throw LiveMP3Budget.Failure.retired }
      },decoder:player);receiver=sink
      event(.buffering)
      operation=try PublishedPinnedHTTPS.streamLiveMP3(url,sink:sink,deadline:.now() + .milliseconds(Int(try budget.remaining())),active:{ [weak self] in self?.valid(value) == true }) { [weak self] result in
        guard let self else { return };self.control.async { [weak self] in self?.networkFinished(value,result:result) }
      }
      let timer=DispatchSource.makeTimerSource(queue:control);watch=timer
      timer.schedule(deadline:.now(),repeating:.milliseconds(25));timer.setEventHandler { [weak self] in
        guard let self,self.token == value else { return };if !self.valid(value) { self.retire("policy") }
      };timer.resume()
    } catch { finishFailure(value) }
  }
  private func networkFinished(_ value: UInt64,result: Result<Void,Error>) {
    owner.drained(value,transport:true)
    guard token == value else { return };operation=nil;receiver=nil
    if case .failure = result,owner.phase != .stopping,terminal == nil { retire("error") }
    completeDrain()
  }
  private func finishFailure(_ value: UInt64) {
    owner.drained(value,transport:true);_ = owner.retire("error");terminal="error";closeDecoder(value);completeDrain()
  }
  func pause() {
    guard owner.pause() else { return }
    control.async { [self] in
      watch?.cancel();watch=nil;receiver?.cancel();decoder?.cancel();operation?.cancel();closeDecoder(token);completeDrain()
    }
  }
  func retire(_ reason: String) {
    guard owner.retire(reason) else { return }
    control.async { [self] in
      terminal=reason;watch?.cancel();watch=nil;expiry?.cancel();expiry=nil;receiver?.cancel();decoder?.cancel();operation?.cancel();closeDecoder(token);completeDrain()
    }
  }
  private func closeDecoder(_ value: UInt64) {
    do { try decoder?.close();decoder=nil;owner.drained(value,transport:false) }
    catch { terminal="backend-exited";_ = owner.retire();owner.uncertainCleanup();deliverTerminal() } // Keep owner/buffers reserved if native disposal is uncertain.
  }
  private func completeDrain() {
    guard owner.drained else { return };receiver=nil
    if terminal != nil || owner.reason != nil { deliverTerminal() }
    else if !pauseDelivered && owner.phase == .paused { pauseDelivered=true;event(.paused) }
  }
  private func deliverTerminal() {
    guard let reason=owner.takeTerminal() else{return};expiry?.cancel();expiry=nil;event(.ended(reason))
  }
}
