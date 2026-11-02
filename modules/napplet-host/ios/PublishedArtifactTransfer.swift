import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// App-only, bounded transport into the one-use native artifact registry.
/// HTML is never returned through a module function or sent in an event.
final class PublishedArtifactTransfer: @unchecked Sendable {
  static let shared = PublishedArtifactTransfer(registry: PublishedArtifactRegistry())
  static let maximumUploads = 4
  static let maximumChunkBytes = 48 * 1024
  static let lifetime: Duration = .seconds(60)

  private struct Upload {
    let claims: PublishedArtifactRegistry.Claims
    let byteLength: Int
    let expires: ContinuousClock.Instant
    var nextSequence: Int
    var bytes: Data
  }

  let registry: PublishedArtifactRegistry
  private let now: @Sendable () -> ContinuousClock.Instant
  private let lock = NSLock()
  private var uploads: [String: Upload] = [:]
  #if canImport(UIKit)
  private var backgroundObserver: NSObjectProtocol?
  #endif

  init(registry: PublishedArtifactRegistry,
       now: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now }) {
    self.registry = registry
    self.now = now
    #if canImport(UIKit)
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.revokeAll() }
    #endif
  }

  deinit {
    #if canImport(UIKit)
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    #endif
    revokeAll()
  }

  func registerPublishedSession(_ sessionId: String) -> Bool {
    registry.registerSession(sessionId)
  }

  func beginPublishedArtifact(sessionId: String, publisher: String, identifier: String,
                              eventId: String, aggregateHash: String, htmlHash: String,
                              byteLength: Int) -> String? {
    guard (1...PublishedArtifactRegistry.maximumHTMLBytes).contains(byteLength) else { return nil }
    let claims = PublishedArtifactRegistry.Claims(
      sessionId: sessionId, publisher: publisher, identifier: identifier, eventId: eventId,
      aggregateHash: aggregateHash, htmlHash: htmlHash)
    return lock.withLock {
      pruneLocked()
      guard registry.isSessionRegistered(sessionId), uploads.count < Self.maximumUploads,
        !uploads.values.contains(where: { $0.claims.sessionId == sessionId }) else { return nil }
      var uploadId: String
      repeat { uploadId = UUID().uuidString.lowercased() } while uploads[uploadId] != nil
      uploads[uploadId] = Upload(claims: claims, byteLength: byteLength,
        expires: now().advanced(by: Self.lifetime), nextSequence: 0, bytes: Data())
      return uploadId
    }
  }

  func appendPublishedArtifact(_ uploadId: String, sequence: Int, base64Chunk: String) -> Bool {
    lock.withLock {
      pruneLocked()
      guard var upload = uploads.removeValue(forKey: uploadId) else { return false }
      // Removing first makes every malformed attempt consume and erase this partial upload.
      guard registry.isSessionRegistered(upload.claims.sessionId),
        sequence == upload.nextSequence, sequence >= 0,
        !base64Chunk.isEmpty, base64Chunk.utf8.count <= 4 * Self.maximumChunkBytes / 3,
        let chunk = Data(base64Encoded: base64Chunk),
        chunk.base64EncodedString() == base64Chunk,
        (1...Self.maximumChunkBytes).contains(chunk.count),
        chunk.count <= upload.byteLength - upload.bytes.count else { return false }
      upload.bytes.append(chunk)
      upload.nextSequence += 1
      uploads[uploadId] = upload
      return true
    }
  }

  func finishPublishedArtifact(_ uploadId: String) -> String? {
    lock.withLock {
      pruneLocked()
      guard let upload = uploads.removeValue(forKey: uploadId),
        registry.isSessionRegistered(upload.claims.sessionId),
        upload.bytes.count == upload.byteLength else { return nil }
      return registry.stage(upload.bytes, claims: upload.claims)
    }
  }

  func cancelPublishedArtifact(_ uploadId: String) {
    _ = lock.withLock { uploads.removeValue(forKey: uploadId) }
  }

  func revokePublishedSession(_ sessionId: String) {
    lock.withLock {
      uploads = uploads.filter { $0.value.claims.sessionId != sessionId }
      registry.revokeSession(sessionId)
    }
  }

  func revokeAll() {
    lock.withLock {
      uploads.removeAll()
      registry.revokeAll()
    }
  }

  private func pruneLocked() {
    let instant = now()
    uploads = uploads.filter { instant < $0.value.expires }
  }
}
