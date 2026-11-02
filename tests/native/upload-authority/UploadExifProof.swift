import Foundation
@main struct UploadExifProof {
  static func main() throws {
    let root = URL(fileURLWithPath: CommandLine.arguments[1]); var checks = 0
    let cases = try String(contentsOf: root.appendingPathComponent("exif-cases.tsv"), encoding: .utf8)
    for line in cases.split(separator: "\n") {
      let fields = line.split(separator: "\t"), data = try Data(contentsOf: root.appendingPathComponent(String(fields[0]))), bytes = [UInt8](data), before = bytes
      precondition((UploadExifMetadata.orientation(bytes, 0, bytes.count) ?? 0) == Int(fields[1])!, String(fields[0])); checks += 1
      precondition(bytes == before); checks += 1
    }
    let bytes = [UInt8](try Data(contentsOf: root.appendingPathComponent("exif-valid.tiff")))
    for length in 0..<bytes.count {precondition(UploadExifMetadata.orientation(Array(bytes.prefix(length)), 0, length) == nil, "Truncation \(length)"); checks += 1}
    precondition(UploadExifMetadata.orientation(bytes, -1, bytes.count) == nil && UploadExifMetadata.orientation(bytes, 1, bytes.count) == nil &&
      UploadExifMetadata.orientation(bytes, 0, -1) == nil && UploadExifMetadata.orientation([UInt8](repeating: 0, count: 262145), 0, 262145) == nil); checks += 1
    print("{\"language\":\"Swift\",\"exifChecks\":\(checks),\"failed\":0}")
  }
}
