import Foundation

enum NostrSecretBech32 {
  private static let alphabet = Array("qpzry9x8gf2tvdw0s3jn54khce6mua7l")
  private static let generators: [UInt32] = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

  static func encode(_ secret: Data) throws -> String {
    guard secret.count == 32 else { throw StoreFailure.unauthorized }
    var source = Array(secret), words: [UInt8] = []
    defer {
      source.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
      words.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) }
    }
    var accumulator = 0, bits = 0
    for byte in source {
      accumulator = (accumulator << 8) | Int(byte)
      bits += 8
      while bits >= 5 {
        bits -= 5
        words.append(UInt8((accumulator >> bits) & 31))
      }
    }
    if bits > 0 { words.append(UInt8((accumulator << (5 - bits)) & 31)) }
    let humanReadable = Array("nsec".utf8)
    var checksumInput = humanReadable.map { $0 >> 5 } + [0] + humanReadable.map { $0 & 31 } + words
    checksumInput += Array(repeating: 0, count: 6)
    defer { checksumInput.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) } }
    let value = polymod(checksumInput) ^ 1
    var result = "nsec1"
    result.reserveCapacity(63)
    for word in words { result.append(alphabet[Int(word)]) }
    for index in 0..<6 { result.append(alphabet[Int((value >> UInt32(5 * (5 - index))) & 31)]) }
    guard result.count == 63 else { throw StoreFailure.unauthorized }
    return result
  }

  static func decode(_ value: String) throws -> Data {
    guard value.utf8.count == 63, value.hasPrefix("nsec1"), value == value.lowercased() else { throw StoreFailure.invalidInput }
    var words: [UInt8] = []
    defer { words.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) } }
    for character in value.dropFirst(5) {
      guard let index = alphabet.firstIndex(of: character) else { throw StoreFailure.invalidInput }
      words.append(UInt8(index))
    }
    let hrp = Array("nsec".utf8)
    var expanded = hrp.map { $0 >> 5 } + [0] + hrp.map { $0 & 31 } + words
    defer { expanded.withUnsafeMutableBufferPointer { $0.initialize(repeating: 0) } }
    guard polymod(expanded) == 1 else { throw StoreFailure.invalidInput }
    var result = Data(), accumulator: UInt32 = 0, bits = 0
    for word in words.dropLast(6) {
      accumulator = ((accumulator << 5) | UInt32(word)) & 0xffff
      bits += 5
      if bits >= 8 { bits -= 8; result.append(UInt8((accumulator >> UInt32(bits)) & 255)) }
    }
    guard result.count == 32, bits < 5, (accumulator & UInt32((1 << bits) - 1)) == 0 else {
      result.resetBytes(in: 0..<result.count); throw StoreFailure.invalidInput
    }
    return result
  }

  private static func polymod(_ values: [UInt8]) -> UInt32 {
    var checksum: UInt32 = 1
    for value in values {
      let top = checksum >> 25
      checksum = ((checksum & 0x1ffffff) << 5) ^ UInt32(value)
      for index in 0..<5 where ((top >> UInt32(index)) & 1) != 0 { checksum ^= generators[index] }
    }
    return checksum
  }
}

/// Native input/backup codec only. Neither method is an Expo function or accepts a bridge secret.
public enum NativeSignerSecretCodec {
  public static func decodeNsec(_ value: String) throws -> Data { try NostrSecretBech32.decode(value) }
}
