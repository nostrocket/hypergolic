import Foundation
import CryptoKit

/// Metadata-only native write-ahead state; contains no bytes, credential or reusable upload approval.
final class UploadRecoveryLedger: @unchecked Sendable {
  static let maximumRecords = 32, maximumStoreBytes = 128 * 1024
  private static let magic = Data("HGUR0001".utf8)
  enum Failure: Error { case unavailable, corrupt, invalidMetadata, quota }
  enum State: UInt8, Sendable { case unknown, present, absent, confirmed, rejected, notSent }
  protocol Store: Sendable { func read() throws -> Data?; func write(_ value: Data) throws }
  struct Entry: Equatable, Sendable {
    let uploadId: String, identity: String, publisher: String, appId: String, destination: String, sha256: String, mimeType: String
    let size: Int
    let state: State
    init(uploadId: String, identity: String, publisher: String, appId: String, destination: String,
         sha256: String, mimeType: String, size: Int, state: State) throws {
      guard UUID(uuidString: uploadId)?.uuidString.lowercased() == uploadId,
        UploadRecoveryLedger.hex(identity), UploadRecoveryLedger.hex(publisher), UploadRecoveryLedger.hex(sha256),
        !appId.isEmpty, appId.utf8.count <= 1024, NativeUploadAuthority.validDestination(destination),
        (1...NativeUploadAuthority.maxBytes).contains(size),
        ["image/png", "audio/wav", "audio/mpeg", "video/mp4", "application/pdf", "application/zip", "text/plain", "text/html"].contains(mimeType)
      else { throw Failure.invalidMetadata }
      self.uploadId = uploadId; self.identity = identity; self.publisher = publisher; self.appId = appId
      self.destination = destination; self.sha256 = sha256; self.mimeType = mimeType; self.size = size; self.state = state
    }
    func withState(_ next: State) throws -> Entry {
      try Entry(uploadId: uploadId, identity: identity, publisher: publisher, appId: appId, destination: destination,
        sha256: sha256, mimeType: mimeType, size: size, state: next)
    }
  }
  private let lock = NSLock()
  private let store: any Store
  private var rows: [Entry]
  private var healthy = true
  init(store: any Store) throws {
    self.store = store
    if let bytes = try store.read() { rows = try Self.decode(bytes) } else { rows = [] }
  }
  func list(_ identity: String) throws -> [Entry] {
    try lock.withLock { try available(); guard Self.hex(identity) else { throw Failure.invalidMetadata }; return rows.filter {$0.identity == identity} }
  }
  func blocks(identity: String, destination: String, sha256: String) throws -> Bool {
    try lock.withLock {
      try available(); guard Self.hex(identity), Self.hex(sha256), NativeUploadAuthority.validDestination(destination) else { throw Failure.invalidMetadata }
      return blocked(identity, destination, sha256)
    }
  }
  private func blocked(_ identity: String, _ destination: String, _ hash: String) -> Bool {
    rows.contains {$0.state == .unknown && $0.identity == identity && $0.destination == destination && $0.sha256 == hash}
  }
  /// Store and readback must complete before the caller can emit any PUT headers or body.
  func start(_ entry: Entry) throws -> Bool {
    try lock.withLock {
      try available()
      guard entry.state == .unknown, !rows.contains(where: {$0.uploadId == entry.uploadId}),
        !blocked(entry.identity, entry.destination, entry.sha256) else { return false }
      var next = rows
      if next.count == Self.maximumRecords {
        guard let oldest = next.firstIndex(where: {$0.state != .unknown}) else { return false }; next.remove(at: oldest)
      }
      next.append(entry); try commit(next); return true
    }
  }
  /// Only a captured native receipt/read may settle its exact unchanged record.
  func settle(_ expected: Entry, state: State) throws -> Bool {
    try lock.withLock {
      try available()
      guard state != .unknown, expected.state == .unknown, let index = rows.firstIndex(of: expected) else { return false }
      var next = rows; next[index] = try expected.withState(state); try commit(next); return true
    }
  }
  private func available() throws { guard healthy else { throw Failure.unavailable } }
  private func commit(_ next: [Entry]) throws {
    let bytes = try Self.encode(next)
    do {
      try store.write(bytes); guard try store.read() == bytes else { throw Failure.unavailable }; rows = next
    } catch { healthy = false; throw Failure.unavailable }
  }
  private static func hex(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
  }
  private static func number(_ value: Int, into bytes: inout Data) {
    for shift in [24,16,8,0] { bytes.append(UInt8((value >> shift) & 255)) }
  }
  private static func text(_ value: String, into bytes: inout Data) {
    let field = Data(value.utf8); number(field.count, into: &bytes); bytes.append(field)
  }
  static func encode(_ rows: [Entry]) throws -> Data {
    guard rows.count <= maximumRecords, Set(rows.map(\.uploadId)).count == rows.count else { throw Failure.quota }
    var bytes = magic; number(rows.count, into: &bytes)
    for row in rows {
      for value in [row.uploadId,row.identity,row.publisher,row.appId,row.destination,row.sha256,row.mimeType] { text(value, into: &bytes) }
      number(row.size, into: &bytes); bytes.append(row.state.rawValue)
    }
    bytes.append(contentsOf: SHA256.hash(data: bytes)); guard bytes.count <= maximumStoreBytes else { throw Failure.quota }; return bytes
  }
  static func decode(_ bytes: Data) throws -> [Entry] {
    guard (magic.count + 4 + 32...maximumStoreBytes).contains(bytes.count) else { throw Failure.corrupt }
    let payload = Data(bytes.dropLast(32))
    guard Data(SHA256.hash(data: payload)) == Data(bytes.suffix(32)), payload.prefix(magic.count) == magic else { throw Failure.corrupt }
    var cursor = magic.count
    func integer() throws -> Int {
      guard cursor <= payload.count - 4 else { throw Failure.corrupt }
      var value = 0; for _ in 0..<4 { value = value << 8 | Int(payload[cursor]); cursor += 1 }; return value
    }
    func field(_ maximum: Int) throws -> String {
      let length = try integer(); guard length <= maximum, length <= payload.count - cursor,
        let value = String(data: payload[cursor..<(cursor + length)], encoding: .utf8) else { throw Failure.corrupt }
      cursor += length; return value
    }
    let count = try integer(); guard count <= maximumRecords else { throw Failure.corrupt }
    var rows: [Entry] = [], ids = Set<String>()
    for _ in 0..<count {
      let id = try field(36), identity = try field(64), publisher = try field(64), app = try field(1024)
      let server = try field(2048), hash = try field(64), mime = try field(32), size = try integer()
      guard cursor < payload.count, let state = State(rawValue: payload[cursor]), ids.insert(id).inserted else { throw Failure.corrupt }; cursor += 1
      rows.append(try Entry(uploadId: id, identity: identity, publisher: publisher, appId: app, destination: server,
        sha256: hash, mimeType: mime, size: size, state: state))
    }
    guard cursor == payload.count else { throw Failure.corrupt }; return rows
  }
}
