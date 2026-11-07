import Foundation

/// Complete bounded Layer III frames only. No decoder sees arbitrary URLs, ID3 allocations or midstream junk.
final class LiveMP3Gate {
  enum Failure: Error { case format, metadata, truncated }
  private static let v1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0]
  private static let v2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0]
  private let output: (Data) throws -> Void
  private var header = [UInt8](), frame = Data()
  private var skip = 0, metadata = 0, wanted = 0, format = 0, frames = 0
  init(output: @escaping (Data) throws -> Void) { self.output = output; header.reserveCapacity(10); frame.reserveCapacity(2048) }
  func append(_ bytes: Data) throws {
    guard bytes.count <= 8192 else { throw Failure.format }; let input = [UInt8](bytes); var index = 0
    while index < input.count {
      if skip > 0 { let size = min(skip,input.count-index); skip -= size; index += size; continue }
      if wanted > 0 {
        let size = min(wanted-frame.count,input.count-index);frame.append(contentsOf:input[index..<(index+size)]);index += size
        if frame.count == wanted { try output(frame);frames += 1;wanted = 0;frame.removeAll(keepingCapacity:true) }
        continue
      }
      header.append(input[index]);index += 1
      if header.count == 3 && header.prefix(3) == [73,68,51] {
        guard frames == 0 else { throw Failure.metadata }
      } else if header.count == 4 && header[0] != 73 {
        wanted = try frameLength();frame.append(contentsOf:header);header.removeAll(keepingCapacity:true)
      } else if header.count == 10 { try id3() }
    }
  }
  private func id3() throws {
    guard header.prefix(3) == [73,68,51],frames == 0,(2...4).contains(header[3]),header[4] != 255,header[5]&31 == 0 else { throw Failure.metadata }
    var size = 0
    for byte in header[6..<10] { guard byte < 128 else { throw Failure.metadata };size = (size<<7)|Int(byte) }
    guard size <= 64*1024-metadata-10 else { throw Failure.metadata }
    metadata += size+10;skip = size;header.removeAll(keepingCapacity:true)
  }
  private func frameLength() throws -> Int {
    let second=Int(header[1]),third=Int(header[2]),version=(second>>3)&3,rate=(third>>2)&3,bitrate=(third>>4)&15
    guard header[0] == 255,second&224 == 224,version != 1,second&6 == 2,rate != 3,bitrate != 0,bitrate != 15,header[3]&3 != 2 else { throw Failure.format }
    let signature=(version<<8)|(rate<<4)|((header[3]&192 == 192) ? 1:2)
    guard format == 0 || signature == format else { throw Failure.format };format=signature
    let sampleRate=[44100,48000,32000][rate]/(version == 3 ? 1:version == 2 ? 2:4)
    let length=(version == 3 ? 144000*Self.v1[bitrate]:72000*Self.v2[bitrate])/sampleRate+((third>>1)&1)
    guard (4...2048).contains(length) else { throw Failure.format };return length
  }
  func finish() throws { guard frames > 0,header.isEmpty,skip == 0,wanted == 0 else { throw Failure.truncated } }
}
