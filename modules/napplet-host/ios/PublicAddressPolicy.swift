import Foundation

/// Conservative address classifier used before native published transports connect.
/// The transport separately binds a vetted numeric answer to its socket.
public enum PublicAddressPolicy {
  /// Classifies an address already resolved by a transport, without any name lookup.
  public static func accepts(_ address: Data) -> Bool {
    let bytes = [UInt8](address)
    if bytes.count == 4 { return publicV4(bytes) }
    if bytes.count == 16 { return publicV6(bytes) }
    return false
  }

  /// True only for syntactically valid, globally routable unicast address literals.
  public static func isPublicLiteral(_ value: String) -> Bool {
    guard !value.isEmpty, !value.contains("%"), !value.contains("["), !value.contains("]") else { return false }
    if value.contains(":") {
      guard let bytes = parseV6(value) else { return false }
      return publicV6(bytes)
    }
    guard let bytes = parseV4(value) else { return false }
    return publicV4(bytes)
  }

  /// Reject the whole DNS result set if it is empty, malformed, or contains any non-public answer.
  public static func allPublicAnswers(_ answers: [String]) -> Bool {
    !answers.isEmpty && answers.allSatisfy(isPublicLiteral)
  }

  private static func parseV4(_ input: String) -> [UInt8]? {
    let parts = input.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var result = [UInt8]()
    for part in parts {
      guard !part.isEmpty, part.count <= 3, !(part.count > 1 && part.first == "0"),
            part.allSatisfy({ $0 >= "0" && $0 <= "9" }), let number = UInt16(part), number <= 255 else { return nil }
      result.append(UInt8(number))
    }
    return result
  }

  private static func parseV6(_ input: String) -> [UInt8]? {
    if input.components(separatedBy: "::").count > 2 { return nil }
    var text = input
    if text.contains(".") {
      guard let colon = text.lastIndex(of: ":"), let v4 = parseV4(String(text[text.index(after: colon)...])) else { return nil }
      let tail = String(format: "%x:%x", (UInt16(v4[0]) << 8) | UInt16(v4[1]), (UInt16(v4[2]) << 8) | UInt16(v4[3]))
      text = String(text[...colon]) + tail
    }
    let compressed = text.contains("::")
    let halves = text.components(separatedBy: "::")
    let left = halves[0].isEmpty ? [] : halves[0].split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    let right = halves.count == 1 || halves[1].isEmpty ? [] : halves[1].split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    let count = left.count + right.count
    guard (compressed ? count < 8 : count == 8) else { return nil }
    let groups = left + Array(repeating: "0", count: compressed ? 8 - count : 0) + right
    guard groups.count == 8 else { return nil }
    var bytes = [UInt8]()
    for group in groups {
      guard !group.isEmpty, group.count <= 4, group.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }),
            let number = UInt16(group, radix: 16) else { return nil }
      bytes.append(UInt8(number >> 8))
      bytes.append(UInt8(number & 0xff))
    }
    return bytes
  }

  private static func publicV4(_ a: [UInt8]) -> Bool {
    !(hasPrefix(a, [0], 8) || hasPrefix(a, [10], 8) || hasPrefix(a, [100, 64], 10) || hasPrefix(a, [127], 8) ||
      hasPrefix(a, [169, 254], 16) || hasPrefix(a, [172, 16], 12) || hasPrefix(a, [192, 0, 0], 24) ||
      hasPrefix(a, [192, 0, 2], 24) || hasPrefix(a, [192, 88, 99], 24) || hasPrefix(a, [192, 168], 16) ||
      hasPrefix(a, [198, 18], 15) || hasPrefix(a, [198, 51, 100], 24) || hasPrefix(a, [203, 0, 113], 24) ||
      hasPrefix(a, [224], 4) || hasPrefix(a, [240], 4))
  }

  private static func publicV6(_ a: [UInt8]) -> Bool {
    guard a.count == 16, (a[0] & 0xe0) == 0x20 else { return false } // Only 2000::/3.
    if a[0] == 0x20 && a[1] == 0x01 && a[2] <= 0x01 { return false } // 2001::/23 special use.
    if a[0] == 0x20 && a[1] == 0x01 && a[2] == 0x0d && a[3] == 0xb8 { return false } // Documentation.
    if a[0] == 0x20 && a[1] == 0x02 { return false } // 6to4.
    if a[0] == 0x3f && a[1] == 0xff && (a[2] & 0xf0) == 0 { return false } // 3fff::/20 documentation.
    // IPv4-mapped forms are rejected even when the embedded IPv4 address is public.
    return !a.prefix(10).allSatisfy({ $0 == 0 }) || a[10] != 0xff || a[11] != 0xff
  }

  private static func hasPrefix(_ address: [UInt8], _ prefix: [UInt8], _ bits: Int) -> Bool {
    var remaining = bits
    for index in prefix.indices {
      let count = min(8, remaining)
      if count == 0 { break }
      let mask = UInt8(0xff) << (8 - count)
      if (address[index] & mask) != (prefix[index] & mask) { return false }
      remaining -= count
    }
    return true
  }
}

/// Descriptive name for native published-artifact transports.
public typealias PublishedPublicAddressPolicy = PublicAddressPolicy
