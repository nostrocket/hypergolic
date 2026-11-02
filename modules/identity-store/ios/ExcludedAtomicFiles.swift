import Darwin
import Foundation

protocol FilePolicy: Sendable {
  func protectNew(_ url: URL, directory: Bool) throws
  func verify(_ url: URL, directory: Bool) throws
}

struct SystemFilePolicy: FilePolicy {
  func protectNew(_ url: URL, directory: Bool) throws {
    #if os(iOS)
    try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    var target = URL(fileURLWithPath: url.path, isDirectory: directory)
    var values = URLResourceValues(); values.isExcludedFromBackup = true
    try target.setResourceValues(values)
    try verify(url, directory: directory)
    #else
    throw StoreFailure.unavailable // No weaker production implementation on another platform.
    #endif
  }
  func verify(_ url: URL, directory: Bool) throws {
    #if os(iOS)
    var fresh = URL(fileURLWithPath: url.path, isDirectory: directory)
    fresh.removeAllCachedResourceValues()
    let values = try fresh.resourceValues(forKeys: [.isExcludedFromBackupKey, .isSymbolicLinkKey])
    let attributes = try FileManager.default.attributesOfItem(atPath: fresh.path)
    guard values.isExcludedFromBackup == true, values.isSymbolicLink == false,
      attributes[.protectionKey] as? String == FileProtectionType.complete.rawValue,
      (attributes[.posixPermissions] as? NSNumber)?.intValue == (directory ? 0o700 : 0o600) else { throw StoreFailure.unavailable }
    #else
    throw StoreFailure.unavailable
    #endif
  }
}

/// Every temporary/final file stays in one excluded, protected native-owned directory.
public struct ExcludedAtomicFiles: EncryptedFiles {
  private let root: URL
  private let policy: any FilePolicy
  private let entropy: any EntropySource
  private let maximumBytes: Int

  init(root: URL, policy: any FilePolicy, entropy: any EntropySource, maximumBytes: Int = 2081) throws {
    guard root.isFileURL,
      root.lastPathComponent == "IdentitySecrets-v1" && maximumBytes == 2081 ||
      root.lastPathComponent == "NativeSigner-v1" && maximumBytes == 16_384 else { throw StoreFailure.invalidInput }
    self.root = root.standardizedFileURL; self.policy = policy; self.entropy = entropy; self.maximumBytes = maximumBytes
  }
  public static func applicationStore() throws -> ExcludedAtomicFiles {
    #if os(iOS)
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return try ExcludedAtomicFiles(root: base.appendingPathComponent("IdentitySecrets-v1", isDirectory: true), policy: SystemFilePolicy(), entropy: SystemEntropy())
    #else
    throw StoreFailure.unavailable
    #endif
  }
  public static func applicationSignerStore() throws -> ExcludedAtomicFiles {
    #if os(iOS)
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    return try ExcludedAtomicFiles(root: base.appendingPathComponent("NativeSigner-v1", isDirectory: true),
      policy: SystemFilePolicy(), entropy: SystemEntropy(), maximumBytes: 16_384)
    #else
    throw StoreFailure.unavailable
    #endif
  }
  private func statPath(_ url: URL) throws -> stat? {
    var result = stat()
    if lstat(url.path, &result) == 0 { return result }
    if errno == ENOENT { return nil }
    throw StoreFailure.unavailable
  }
  private func checkRoot() throws -> Bool {
    guard let s = try statPath(root) else { return false }
    guard s.st_mode & S_IFMT == S_IFDIR else { throw StoreFailure.corruptState }
    try policy.verify(root, directory: true)
    return true
  }
  private func path(_ slot: SecretSlot) throws -> URL {
    if case .secret(let key) = slot, !Receipt.isPubkey(key) { throw StoreFailure.invalidInput }
    return root.appendingPathComponent(slot.name + ".sealed", isDirectory: false)
  }
  public func hasArtifacts() throws -> Bool {
    guard try checkRoot() else { return false }
    return try !FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty
  }
  public func prepare() throws {
    if try checkRoot() { return }
    // The directory is empty until exclusion and complete protection are set and read back.
    #if os(iOS)
    let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700, .protectionKey: FileProtectionType.complete]
    #else
    let attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
    #endif
    do {
      try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false, attributes: attributes)
      try policy.protectNew(root, directory: true)
      try syncDirectory()
    } catch { throw StoreFailure.unavailable }
  }
  private func syncDirectory() throws {
    let fd = Darwin.open(root.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { throw StoreFailure.unavailable }
    let result = fsync(fd), closed = Darwin.close(fd)
    guard result == 0, closed == 0 else { throw StoreFailure.unavailable }
  }
  public func read(_ slot: SecretSlot) throws -> Data? {
    let url = try path(slot)
    guard try checkRoot() else { return nil }
    let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    if fd < 0 {
      if errno == ENOENT { return nil }
      throw StoreFailure.unavailable
    }
    defer { _ = Darwin.close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
      info.st_size >= 0, info.st_size <= maximumBytes else { throw StoreFailure.corruptState }
    try policy.verify(url, directory: false)
    var result = Data(), buffer = [UInt8](repeating: 0, count: maximumBytes + 1)
    while true {
      let count = Darwin.read(fd, &buffer, buffer.count)
      if count < 0 { if errno == EINTR { continue }; throw StoreFailure.unavailable }
      if count == 0 { return result }
      guard result.count + count <= maximumBytes else { throw StoreFailure.corruptState }
      result.append(contentsOf: buffer.prefix(count))
    }
  }
  public func writeAtomically(_ slot: SecretSlot, data: Data) throws {
    let destination = try path(slot)
    guard data.count <= maximumBytes, try checkRoot() else { throw StoreFailure.unavailable }
    let suffix = try entropy.bytes(count: 16).map { String(format: "%02x", $0) }.joined()
    guard suffix.count == 32 else { throw StoreFailure.unavailable }
    let temporary = root.appendingPathComponent(".pending-" + suffix)
    let fd = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { throw StoreFailure.unavailable }
    var open = true, pending = true
    defer {
      if open { _ = Darwin.close(fd) }
      if pending { _ = unlink(temporary.path) } // Still encrypted/excluded if cleanup itself fails.
    }
    // Root exclusion already covers the file; additionally protect/verify the inode before writing bytes.
    try policy.protectNew(temporary, directory: false)
    try data.withUnsafeBytes { bytes in
      var offset = 0
      while offset < bytes.count {
        let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
        if written < 0 { if errno == EINTR { continue }; throw StoreFailure.unavailable }
        guard written > 0 else { throw StoreFailure.unavailable }
        offset += written
      }
    }
    guard fcntl(fd, F_FULLFSYNC) == 0 else { throw StoreFailure.unavailable }
    let closed = Darwin.close(fd); open = false
    guard closed == 0 else { throw StoreFailure.unavailable }
    guard rename(temporary.path, destination.path) == 0 else { throw StoreFailure.unavailable }
    pending = false
    try policy.verify(destination, directory: false)
    try syncDirectory()
  }
  public func remove(_ slot: SecretSlot) throws {
    let url = try path(slot)
    guard try checkRoot() else { return }
    guard let s = try statPath(url) else { return }
    guard s.st_mode & S_IFMT == S_IFREG, s.st_nlink == 1 else { throw StoreFailure.corruptState }
    try policy.verify(url, directory: false)
    if unlink(url.path) != 0 { if errno == ENOENT { return }; throw StoreFailure.unavailable }
    try syncDirectory()
  }
}
