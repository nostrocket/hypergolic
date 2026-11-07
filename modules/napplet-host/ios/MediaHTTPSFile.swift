import Foundation
import Darwin

/// Sequentially owns one native response file. Only a validated closed file can leave this owner.
final class MediaHTTPSFile: PublishedHTTPFileSink {
  static let maximumBytes = 256 * 1024 * 1024
  static let totalSeconds = 300
  let idleSeconds = 10
  private static let headroomBytes = 128 * 1024 * 1024
  private static let separator = Data([13, 10, 13, 10])
  enum Failure: Error { case framing, cancelled, storage, invalidVideo }

  private let directory: URL
  private let deadline: DispatchTime
  private let active: @Sendable () -> Bool
  private let progress: @Sendable (Int, Int) -> Void
  private var head = Data()
  private var file: URL?
  private var output: FileHandle?
  private var length = 0, written = 0

  init(directory: URL, deadline: DispatchTime, active: @escaping @Sendable () -> Bool,
       progress: @escaping @Sendable (Int, Int) -> Void) {
    self.directory = directory; self.deadline = deadline; self.active = active; self.progress = progress
  }

  func check() throws {
    guard active(), DispatchTime.now() < deadline else { throw Failure.cancelled }
  }

  func append(_ chunk: Data) throws {
    try check()
    guard chunk.count <= 8192 else { throw Failure.framing }
    if length > 0 { try write(chunk); return }
    head.append(chunk)
    guard let boundary = head.range(of: Self.separator) else {
      guard head.count <= PublishedHTTPResponse.maximumHeaderBytes + 3 else { throw Failure.framing }
      return
    }
    guard boundary.lowerBound <= PublishedHTTPResponse.maximumHeaderBytes else { throw Failure.framing }
    let (status, headers) = try PublishedHTTPResponse.parseHead(head.prefix(upTo: boundary.lowerBound), allowsRepeatedInformational: true)
    if [301, 302, 303, 307, 308].contains(status) {
      guard let location = headers["location"], !location.isEmpty, location.utf8.count <= 8192 else { throw Failure.framing }
      throw PublishedHTTPResponse.Failure.resourceRedirect(location)
    }
    guard status == 200, headers["location"] == nil, headers["content-range"] == nil,
      headers["transfer-encoding"] == nil, headers["connection"].map({ $0.lowercased() == "close" }) ?? true,
      headers["content-encoding"].map({ $0.lowercased() == "identity" }) ?? true,
      let rawLength = headers["content-length"], rawLength.utf8.allSatisfy({ (48...57).contains($0) }),
      let count = Int(rawLength), (1...Self.maximumBytes).contains(count),
      head.distance(from: boundary.upperBound, to: head.endIndex) <= count else { throw Failure.framing }
    try open(count)
    length = count
    progress(0, length)
    defer { head.removeAll(keepingCapacity: false) }
    try write(head.suffix(from: boundary.upperBound))
  }

  private func open(_ length: Int) throws {
    let fm = FileManager.default
    if !fm.fileExists(atPath: directory.path) {
      try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    }
    guard try fm.attributesOfItem(atPath: directory.path)[.type] as? FileAttributeType == .typeDirectory else {
      throw Failure.storage
    }
    let url = directory.appendingPathComponent("video.mp4")
    guard Darwin.unlink(url.path) == 0 || errno == ENOENT,
          let free = try fm.attributesOfFileSystem(forPath: directory.path)[.systemFreeSize] as? NSNumber,
          free.int64Value >= Int64(length + Self.headroomBytes) else { throw Failure.storage }
    try check()
    let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode_t(0o600))
    guard fd >= 0 else { throw Failure.storage }
    file = url
    output = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
#if os(iOS)
    try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
#endif
  }

  private func write(_ chunk: Data) throws {
    guard let output, chunk.count <= length - written else { throw Failure.framing }
    guard !chunk.isEmpty else { return }
    try check()
    try output.write(contentsOf: chunk)
    try check()
    written += chunk.count
    progress(written, length)
  }

  func finish() throws -> URL {
    try check()
    guard length > 0, written == length, let file, let output else { throw Failure.framing }
    try output.close()
    self.output = nil
    guard FiniteMP4.accepts(file, check: check) else { throw Failure.invalidVideo }
    try check()
    self.file = nil
    return file
  }

  func discard() {
    try? output?.close()
    output = nil
    if let file { try? FileManager.default.removeItem(at: file) }
    file = nil
    head.removeAll(keepingCapacity: false)
    length = 0; written = 0
  }

  deinit { discard() }
}
