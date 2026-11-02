import Foundation

@main
struct VectorsSwift {
    static func main() throws {
        let contents = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
        var assertions = 0
        for line in contents.split(whereSeparator: \.isNewline) {
            if line.isEmpty || line.hasPrefix("#") { continue }
            let fields = line.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
            guard fields.count == 4, let nonce = Data(base64Encoded: fields[1]),
                  let response = Data(base64Encoded: fields[2]) else { fatalError("Malformed vector") }
            var accepted = true
            do { try PublishedRelayWebSocketHandshake.validate(response, nonce: nonce) }
            catch { accepted = false }
            let expected = fields[3] == "accept"
            guard accepted == expected else {
                fatalError("\(fields[0]) expected \(expected) got \(accepted)")
            }
            assertions += 1
        }
        print("Swift RFC6455 shared vectors: \(assertions) passed")
    }
}
