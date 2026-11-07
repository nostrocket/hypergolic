import Foundation
import HypergolicNappletHost

/// Internal construction seam for owned in-memory proofs; no Expo/native capability exposes a factory.
protocol NativeCvmSessionIO: AnyObject, Sendable {
  func send(_ text: String, beforeSend: @escaping @Sendable () throws -> Void, complete: @escaping @Sendable (Result<Void, Error>) -> Void)
  func cancel()
}
extension NativeCvmRelayTransport.Operation: NativeCvmSessionIO {}
struct NativeCvmSessionCallbacks: Sendable {
  let current: @Sendable () -> Bool, ready: @Sendable () -> Void
  let receive: @Sendable (String) throws -> Void
  let ended: @Sendable (Error) -> Void, drained: @Sendable () -> Void
}
typealias NativeCvmSessionFactory = @Sendable (String, String, ContinuousClock.Instant, NativeCvmSessionCallbacks) throws -> any NativeCvmSessionIO
func nativeCvmSessionTransport(_ relay: String, _ subscription: String, _ deadline: ContinuousClock.Instant,
  _ callbacks: NativeCvmSessionCallbacks) throws -> any NativeCvmSessionIO {
  try NativeCvmRelayTransport.open(relay:relay,subscription:subscription,deadline:deadline,
    control:NativeCvmRelayTransport.Control(current:callbacks.current,ready:{ _ in callbacks.ready() },receive:callbacks.receive,ended:callbacks.ended,drained:callbacks.drained))
}
