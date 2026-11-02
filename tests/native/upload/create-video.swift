import Foundation
import AVFoundation
import CoreVideo

/// Independently encoded two-color movie for exact unchanged-attachment acceptance.
@main struct CreateUploadVideo {
  static func main() async throws {
    let url = URL(fileURLWithPath: CommandLine.arguments[1])
    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: 64, AVVideoHeightKey: 32])
    let adapter = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input,
      sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 32])
    guard writer.canAdd(input) else {throw NSError(domain: "Video fixture", code: 1)}
    writer.add(input); guard writer.startWriting() else {throw writer.error ?? NSError(domain: "Video fixture", code: 2)}
    writer.startSession(atSourceTime: .zero)
    for frame in 0..<8 {
      let deadline = Date().addingTimeInterval(10)
      while !input.isReadyForMoreMediaData {guard Date() < deadline else {throw NSError(domain: "Video fixture", code: 3)}; try await Task.sleep(for: .milliseconds(10))}
      var buffer: CVPixelBuffer?
      guard CVPixelBufferCreate(kCFAllocatorDefault, 64, 32, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess,
        let buffer else {throw NSError(domain: "Video fixture", code: 4)}
      CVPixelBufferLockBaseAddress(buffer, [])
      let pixels = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(buffer)
      for y in 0..<32 {for x in 0..<64 {let at = y * stride + x * 4; pixels[at] = 0; pixels[at + 1] = x >= 32 ? 255 : 0; pixels[at + 2] = x < 32 ? 255 : 0; pixels[at + 3] = 255}}
      CVPixelBufferUnlockBaseAddress(buffer, [])
      guard adapter.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 4)) else {throw writer.error ?? NSError(domain: "Video fixture", code: 5)}
    }
    input.markAsFinished(); await writer.finishWriting()
    guard writer.status == .completed else {throw writer.error ?? NSError(domain: "Video fixture", code: 6)}
  }
}
