import Foundation

@main
struct PublicAddressPolicyProof {
  static func main() throws {
    let path = CommandLine.arguments[1]
    let lines = try String(contentsOfFile: path, encoding: .utf8).components(separatedBy: .newlines)
    var checks = 0
    for line in lines where !line.isEmpty && !line.hasPrefix("#") {
      let fields = line.components(separatedBy: "\t")
      guard fields.count == 3 else { throw ProofFailure.invalidVector(line) }
      let expected = fields[2] == "true"
      let actual: Bool
      switch fields[0] {
      case "LITERAL": actual = PublicAddressPolicy.isPublicLiteral(fields[1])
      case "ANSWERS":
        let answers = fields[1].isEmpty ? [] : fields[1].components(separatedBy: ",")
        actual = PublicAddressPolicy.allPublicAnswers(answers)
      case "BYTES":
        guard fields[1].count.isMultiple(of: 2) else { throw ProofFailure.invalidVector(line) }
        var bytes = [UInt8]()
        var cursor = fields[1].startIndex
        while cursor < fields[1].endIndex {
          let end = fields[1].index(cursor, offsetBy: 2)
          guard let value = UInt8(fields[1][cursor..<end], radix: 16) else { throw ProofFailure.invalidVector(line) }
          bytes.append(value)
          cursor = end
        }
        actual = PublicAddressPolicy.accepts(Data(bytes))
      default: throw ProofFailure.invalidVector(line)
      }
      guard actual == expected else { throw ProofFailure.failed(checks + 1, line, actual) }
      checks += 1
    }
    print("iOS/Swift classifier vectors passed: \(checks)")
  }
}

enum ProofFailure: Error, CustomStringConvertible {
  case invalidVector(String)
  case failed(Int, String, Bool)
  var description: String {
    switch self {
    case .invalidVector(let line): return "Invalid vector: \(line)"
    case .failed(let number, let line, let actual): return "Vector \(number) failed: \(line) actual=\(actual)"
    }
  }
}
