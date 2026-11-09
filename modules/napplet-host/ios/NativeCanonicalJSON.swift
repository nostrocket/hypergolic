import Foundation
import CryptoKit

/// Exact shared JSON quoting, independent of signing or relay state.
enum NativeCanonicalJSON {
  static func quote(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
      switch scalar.value {
      case 34: result += "\\\""
      case 92: result += "\\\\"
      case 8: result += "\\b"
      case 12: result += "\\f"
      case 10: result += "\\n"
      case 13: result += "\\r"
      case 9: result += "\\t"
      case 0...31: result += String(format: "\\u%04x", scalar.value)
      default: result.unicodeScalars.append(scalar)
      }
    }
    return result + "\""
  }
  static func hashStrings(_ values: [String]) -> String {
    let canonical = "[" + values.map(quote).joined(separator: ",") + "]"
    return SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
  }
}
