import Darwin
import Foundation

struct UploadRecoveryFilePolicy {
  func protectNew(_ url: URL, directory: Bool) throws {
    #if os(iOS)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    var target = URL(fileURLWithPath: url.path, isDirectory: directory)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try target.setResourceValues(values)
    try verify(url, directory: directory)
    #else
    throw UploadRecoveryLedger.Failure.unavailable // No weaker production implementation on another platform.
    #endif
  }
  func verify(_ url: URL, directory: Bool) throws {
    #if os(iOS)
    var fresh = URL(fileURLWithPath: url.path, isDirectory: directory)
    fresh.removeAllCachedResourceValues()
    let values = try fresh.resourceValues(forKeys: [.isExcludedFromBackupKey, .isSymbolicLinkKey])
    let attributes = try FileManager.default.attributesOfItem(atPath: fresh.path)
    let protection = (attributes[.protectionKey] as? FileProtectionType)?.rawValue ?? (attributes[.protectionKey] as? String)
    #if HYPERGOLIC_NETWORK_PROOF && targetEnvironment(simulator)
    // The isolated Simulator fixture has no data-protection attribute. It proves
    // metadata I/O, exclusion and mode only; hardware protection remains a device gate.
    let protected = protection == nil || protection == FileProtectionType.complete.rawValue
    #else
    let protected = protection == FileProtectionType.complete.rawValue
    #endif
    guard values.isExcludedFromBackup == true, values.isSymbolicLink == false, protected,
      (attributes[.posixPermissions] as? NSNumber)?.intValue == (directory ? 0o700 : 0o600) else { throw UploadRecoveryLedger.Failure.unavailable }
    #else
    throw UploadRecoveryLedger.Failure.unavailable
    #endif
  }
}


/// Native-owned excluded metadata; no bodies, signing material or resumable grants.
struct UploadRecoveryFileStore: UploadRecoveryLedger.Store {
  private let root: URL
  private let policy = UploadRecoveryFilePolicy()
  private var file: URL { root.appendingPathComponent("ledger.bin") }
  static func applicationStore() throws -> Self {
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return try Self(root: base.appendingPathComponent("UploadRecovery-v1", isDirectory: true))
  }
  init(root: URL) throws {
    guard root.isFileURL, root.lastPathComponent == "UploadRecovery-v1" else { throw UploadRecoveryLedger.Failure.invalidMetadata }
    self.root = root.standardizedFileURL
    if try statPath(self.root) == nil {
      try FileManager.default.createDirectory(at: self.root, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
      try policy.protectNew(self.root, directory: true)
      try syncDirectory(self.root.deletingLastPathComponent())
    }
    try checkRoot()
    let pending = self.root.appendingPathComponent(".pending")
    if let info = try statPath(pending) {
      guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { throw UploadRecoveryLedger.Failure.corrupt }
      try policy.verify(pending, directory: false)
      guard unlink(pending.path) == 0 else { throw UploadRecoveryLedger.Failure.unavailable }; try syncDirectory(self.root)
    }
  }
  private func statPath(_ path: URL) throws -> stat? {
    var info = stat(); if lstat(path.path, &info) == 0 { return info }
    if errno == ENOENT { return nil }; throw UploadRecoveryLedger.Failure.unavailable
  }
  private func checkRoot() throws {
    guard let info = try statPath(root), info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid() else { throw UploadRecoveryLedger.Failure.corrupt }
    try policy.verify(root, directory: true)
  }
  private func syncDirectory(_ path: URL) throws {
    let fd = Darwin.open(path.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw UploadRecoveryLedger.Failure.unavailable }
    let synced = fsync(fd), closed = Darwin.close(fd)
    guard synced == 0, closed == 0 else { throw UploadRecoveryLedger.Failure.unavailable }
  }
  func read() throws -> Data? {
    try checkRoot()
    let fd = Darwin.open(file.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 { if errno == ENOENT { return nil }; throw UploadRecoveryLedger.Failure.unavailable }
    defer { _ = Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
      info.st_size >= 0, info.st_size <= UploadRecoveryLedger.maximumStoreBytes else { throw UploadRecoveryLedger.Failure.corrupt }
    try policy.verify(file, directory: false)
    var bytes = Data(), buffer = [UInt8](repeating: 0, count: 8192)
    while true {
      let count = Darwin.read(fd, &buffer, buffer.count)
      if count < 0 { if errno == EINTR { continue }; throw UploadRecoveryLedger.Failure.unavailable }
      if count == 0 { return bytes }
      guard bytes.count + count <= UploadRecoveryLedger.maximumStoreBytes else { throw UploadRecoveryLedger.Failure.corrupt }
      bytes.append(contentsOf: buffer.prefix(count))
    }
  }
  func write(_ value: Data) throws {
    guard value.count <= UploadRecoveryLedger.maximumStoreBytes else { throw UploadRecoveryLedger.Failure.quota }
    try checkRoot()
    if let info = try statPath(file) {
      guard info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1 else { throw UploadRecoveryLedger.Failure.corrupt }
      try policy.verify(file, directory: false)
    }
    let temporary = root.appendingPathComponent(".pending")
    let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw UploadRecoveryLedger.Failure.unavailable }
    var opened = true, pending = true
    defer { if opened { _ = Darwin.close(fd) }; if pending { _ = unlink(temporary.path) } }
    try policy.protectNew(temporary, directory: false)
    try value.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if count < 0 { if errno == EINTR { continue }; throw UploadRecoveryLedger.Failure.unavailable }
        guard count > 0 else { throw UploadRecoveryLedger.Failure.unavailable }; offset += count
      }
    }
    guard fcntl(fd, F_FULLFSYNC) == 0 else { throw UploadRecoveryLedger.Failure.unavailable }
    let closed = Darwin.close(fd); opened = false; guard closed == 0 else { throw UploadRecoveryLedger.Failure.unavailable }
    guard rename(temporary.path, file.path) == 0 else { throw UploadRecoveryLedger.Failure.unavailable }
    pending = false; try policy.verify(file, directory: false); try syncDirectory(root)
  }
}
