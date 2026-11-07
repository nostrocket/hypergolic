import Foundation
final class Clock: @unchecked Sendable {private let lock=NSLock();private var value:UInt64=0;func read()->UInt64{lock.withLock{value}};func set(_ n:UInt64){lock.withLock{value=n}}}
@main struct Review {
 static func main() throws {
  let clock=Clock(),retained=NSObject();let o=LiveMP3Owner(profile:LiveMP3Owner.profile,scope:"exact",clock:{clock.read()},duration:100)
  let t=try o.nativePlay(scope:"exact",receipt:"permit",foreground:true,focused:true,retaining:retained)
  clock.set(100);precondition(o.pause());precondition(o.reason=="policy");precondition(o.takeTerminal()==nil)
  o.drained(t,transport:true);precondition(o.takeTerminal()==nil);o.drained(t,transport:false)
  precondition(o.takeTerminal()=="policy");precondition(o.takeTerminal()==nil);precondition(!o.retire("late"))
  let other=NSObject();precondition(MediaPlaybackReservation.shared.acquire(other));MediaPlaybackReservation.shared.release(other)
  let u=LiveMP3Owner(profile:LiveMP3Owner.profile,scope:"exact",clock:{0},duration:100)
  let q=try u.nativePlay(scope:"exact",receipt:"permit",foreground:true,focused:true,retaining:retained)
  u.uncertainCleanup();precondition(u.takeTerminal()=="backend-exited");precondition(u.takeTerminal()==nil)
  u.drained(q,transport:true);u.drained(q,transport:false);precondition(!u.drained);precondition(!MediaPlaybackReservation.shared.acquire(other))
  print("Swift V3 terminal review: expiry drains once; uncertain outcome once; shared ownership retained")
 }
}
