import CryptoKit
import Foundation
import SQLite3
#if canImport(UIKit)
import UIKit
#endif

/// Short-lived, app-private body files. Exactly one connection writes each file before it is read.
final class PublishedBodyStore: @unchecked Sendable {
  static let shared = PublishedBodyStore()
  enum Failure: Error { case unavailable }
  private final class Entry {
    let file: URL
    var length = 0
    let user: String
    var verified = false
    init(_ file: URL, user: String) { self.file = file; self.user = user }
  }
  private let lock = NSLock()
  private let directory: URL
  private var directoryReady: Bool
  private var account: String?
  private var epoch: UInt64?
  private var entries: [String: Entry] = [:]
  private var foreground = true
  #if canImport(UIKit)
  private var observers: [NSObjectProtocol] = []
  #endif

  init(directory: URL? = nil) {
    self.directory = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("hypergolic-published-body-v1", isDirectory: true)
    directoryReady = directory != nil
    #if canImport(UIKit)
    let center = NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.setForeground(false) })
    }
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in self?.setForeground(true) })
    #endif
  }

  deinit {
    #if canImport(UIKit)
    for observer in observers { NotificationCenter.default.removeObserver(observer) }
    #endif
    clear()
  }

  private func clearLocked() {
    for entry in entries.values where entry.length > 0 { try? FileManager.default.removeItem(at: entry.file) }
    entries.removeAll()
  }

  func clear() { lock.withLock { clearLocked() } }

  func synchronize(_ user: String, epoch nextEpoch: UInt64, available: Bool) {
    lock.withLock {
      let next = available ? user : nil
      if nextEpoch != epoch || next != account {
        clearLocked()
        PublishedArtifactTransfer.shared.revokeAll()
      }
      epoch = nextEpoch
      account = next
    }
  }

  func setForeground(_ value: Bool) {
    lock.withLock { foreground = value; if !value { clearLocked() } }
  }

  func release(_ token: String) {
    lock.withLock { if let entry = entries.removeValue(forKey: token) { try? FileManager.default.removeItem(at: entry.file) } }
  }

  func issue() throws -> String {
    try lock.withLock {
      guard foreground, let account, entries.count < 64 else { throw Failure.unavailable }
      let token = UUID().uuidString.lowercased()
      entries[token] = Entry(directory.appendingPathComponent(token + ".db"), user: account)
      return token
    }
  }

  // Called under the lifetime lock. Allocate only the actual body length, including a cache copy in flight.
  private func reserve(_ token: String, _ length: Int) throws -> Entry {
    guard let entry = entries[token], foreground, (1...20*1024*1024).contains(length) else { throw Failure.unavailable }
    if entry.length == 0 {
      guard entries.values.reduce(length, { $0 + $1.length }) <= 96*1024*1024 else { throw Failure.unavailable }
      if !directoryReady {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        for file in try fm.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) { try? fm.removeItem(at: file) }
        directoryReady = true
      }
      try BodyDatabase.open(entry.file, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE) { db in
        let schema = "CREATE TABLE payload (id INTEGER PRIMARY KEY CHECK(id=1), body BLOB NOT NULL CHECK(typeof(body)='blob' AND length(body)=\(length)))"
        guard sqlite3_exec(db, schema, nil, nil, nil) == SQLITE_OK else { throw Failure.unavailable }
      }
      entry.length = length
    }
    guard entry.length == length else { throw Failure.unavailable }
    return entry
  }

  func database(_ token: String, user: String, length: Int) throws -> String {
    try lock.withLock {
      guard account == user, entries[token]?.user == user else { throw Failure.unavailable }
      return try reserve(token, length).file.path
    }
  }

  private func verify(_ data: Data, _ hash: String) -> Int {
    let actual = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    guard actual == hash else { return -2 }
    return data.withUnsafeBytes { buf in
      hg_published_html_valid(buf.bindMemory(to: UInt8.self).baseAddress, data.count) != 0 ? data.count : -3
    }
  }

  func retainDownload(_ token: String, hash: String, data: Data) throws -> Int {
    let entry = try lock.withLock { try reserve(token, data.count) }
    let result = verify(data, hash)
    guard result > 0 else { return result }
    try BodyDatabase.open(entry.file, SQLITE_OPEN_READWRITE) { db in
      try BodyDatabase.statement(db, "INSERT INTO payload (id,body) VALUES (1,?)") { sql in
        try data.withUnsafeBytes { bytes in
          defer { sqlite3_clear_bindings(sql) }
          guard sqlite3_bind_blob(sql, 1, bytes.baseAddress, Int32(bytes.count), nil) == SQLITE_OK,
                sqlite3_step(sql) == SQLITE_DONE else { throw Failure.unavailable }
        }
      }
    }
    try lock.withLock { guard entries[token] === entry else { throw Failure.unavailable }; entry.verified = true }
    return result
  }

  func verifyCached(_ token: String, hash: String) throws -> Int {
    let entry = try lock.withLock {
      guard let entry = entries[token], entry.user == account, entry.length > 0 else { throw Failure.unavailable }
      return entry
    }
    let result = verify(try BodyDatabase.read(entry.file, length: entry.length), hash)
    try lock.withLock { guard entries[token] === entry else { throw Failure.unavailable }; entry.verified = result > 0 }
    return result
  }

  func stage(_ token: String, json: String) throws -> String? {
    guard let c = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String:String],
      let user=c["user"], let id=c["sessionId"], let publisher=c["publisher"], let identifier=c["identifier"],
      let event=c["eventId"], let aggregate=c["aggregateHash"], let hash=c["htmlHash"] else { throw Failure.unavailable }
    let entry = try lock.withLock {
      guard let entry = entries[token], entry.verified, entry.user == user else { throw Failure.unavailable }
      return entry
    }
    let snapshot = c["title"].flatMap { PublishedArtifactRegistry.Snapshot(eventId: event, title: $0) }
    guard c["title"] == nil || snapshot != nil else { throw Failure.unavailable }
    let claims = PublishedArtifactRegistry.Claims(sessionId: id, publisher: publisher, identifier: identifier,
      eventId: event, aggregateHash: aggregate, htmlHash: hash, snapshot: snapshot)
    let data = try BodyDatabase.read(entry.file, length: entry.length)
    return try lock.withLock {
      guard foreground, entries[token] === entry else { throw Failure.unavailable }
      return PublishedArtifactTransfer.shared.registry.stage(data, claims: claims)
    }
  }
}

private enum BodyDatabase {
  static func open<T>(_ file: URL, _ flags: Int32, _ action: (OpaquePointer) throws -> T) throws -> T {
    var db: OpaquePointer?
    let result = sqlite3_open_v2(file.path, &db, flags, nil)
    defer { sqlite3_close(db) }
    guard result == SQLITE_OK, let db else { throw PublishedBodyStore.Failure.unavailable }
    return try action(db)
  }
  static func statement<T>(_ db: OpaquePointer, _ query: String, _ action: (OpaquePointer) throws -> T) throws -> T {
    var sql: OpaquePointer?
    guard sqlite3_prepare_v2(db, query, -1, &sql, nil) == SQLITE_OK, let sql else { throw PublishedBodyStore.Failure.unavailable }
    defer { sqlite3_finalize(sql) }
    return try action(sql)
  }
  static func read(_ file: URL, length: Int) throws -> Data {
    try open(file, SQLITE_OPEN_READONLY) { db in
      try statement(db, "SELECT body FROM payload WHERE id=1") { sql in
        guard sqlite3_step(sql) == SQLITE_ROW, sqlite3_column_type(sql, 0) == SQLITE_BLOB,
              sqlite3_column_bytes(sql, 0) == length, let bytes = sqlite3_column_blob(sql, 0) else { throw PublishedBodyStore.Failure.unavailable }
        return Data(bytes: bytes, count: length)
      }
    }
  }
}
