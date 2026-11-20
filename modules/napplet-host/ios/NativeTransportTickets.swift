import Foundation

/// Pending transport reservations remain bounded. Only a freshly issued, unused ID can start work.
final class NativeTransportTickets: @unchecked Sendable {
  static let shared = NativeTransportTickets()
  private let lock = NSLock()
  private var issued = Array<String?>(repeating: nil, count: 4096)
  private var available = Set<String>()
  private var next = 0

  func issue() -> String {
    lock.withLock {
      let id = UUID().uuidString.lowercased()
      if let previous = issued[next] { available.remove(previous) }
      issued[next] = id
      next = (next + 1) % issued.count
      available.insert(id)
      return id
    }
  }

  @discardableResult func consume(_ id: String) -> Bool {
    lock.withLock { available.remove(id) != nil }
  }

  func revokeAll() { lock.withLock { available.removeAll(keepingCapacity: true) } }
}
