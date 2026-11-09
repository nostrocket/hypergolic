import Foundation
import AudioToolbox

/// Supplied MP3 frames only. One parser, four fixed buffers and bounded descriptors; no URL-bearing API.
final class LiveMP3AudioQueue: @unchecked Sendable {
  enum Failure: Error { case native(OSStatus), bounds, retired }
  private static let buffers = 4, bytes = 16 * 1024, packets = 512
  private let condition = NSCondition(), parsing = NSLock()
  private let active: @Sendable () -> Bool
  private let consumed: @Sendable () -> Void
  private let ended: @Sendable () -> Void
  private var stream: AudioFileStreamID?, queue: AudioQueueRef?
  private var buffers: [AudioQueueBufferRef] = []
  private var descriptions: [UnsafeMutablePointer<AudioStreamPacketDescription>] = []
  private var available: [Bool] = []
  private var failure: Error?, cancelled = false, inputEnded = false, closing = false
  private var volume: Float
  init(volume: Float, active: @escaping @Sendable () -> Bool,
       consumed: @escaping @Sendable () -> Void, ended: @escaping @Sendable () -> Void) throws {
    guard volume.isFinite && (0...1).contains(volume) else { throw Failure.bounds }
    self.active = active;self.consumed = consumed;self.ended = ended;self.volume = volume
    let status = AudioFileStreamOpen(Unmanaged.passUnretained(self).toOpaque(), Self.property, Self.packet, kAudioFileMP3Type, &stream)
    guard status == 0 else { throw Failure.native(status) }
  }
  func append(_ data: Data) throws {
    try parsing.withLock {
      try check();guard data.count <= 8192,let stream else { throw Failure.bounds }
      let status = data.withUnsafeBytes { AudioFileStreamParseBytes(stream,UInt32(data.count),$0.baseAddress!,[]) }
      guard status == 0 else { throw Failure.native(status) };try check()
    }
  }
  private func check() throws {
    try condition.withLock { if let failure { throw failure };guard !cancelled && !closing && active() else { throw Failure.retired } }
  }
  private func setup(_ file: AudioFileStreamID) throws {
    guard queue == nil else { throw Failure.bounds }
    var format = AudioStreamBasicDescription(), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    try native(AudioFileStreamGetProperty(file,kAudioFileStreamProperty_DataFormat,&size,&format))
    guard format.mFormatID == kAudioFormatMPEGLayer3,(1...2).contains(format.mChannelsPerFrame),
      format.mSampleRate.isFinite,(8000...48000).contains(format.mSampleRate),format.mFramesPerPacket <= 2304 else { throw Failure.bounds }
    var output: AudioQueueRef?
    try native(AudioQueueNewOutput(&format,Self.output,Unmanaged.passUnretained(self).toOpaque(),nil,nil,0,&output))
    guard let output else { throw Failure.bounds };queue = output
    try native(AudioQueueSetParameter(output,kAudioQueueParam_Volume,volume))
    for _ in 0..<Self.buffers {
      var buffer: AudioQueueBufferRef?;try native(AudioQueueAllocateBuffer(output,UInt32(Self.bytes),&buffer))
      guard let buffer else { throw Failure.bounds };buffers.append(buffer);available.append(true)
      descriptions.append(.allocate(capacity:Self.packets))
    }
    try native(AudioQueueAddPropertyListener(output,kAudioQueueProperty_IsRunning,Self.running,Unmanaged.passUnretained(self).toOpaque()))
    try check();try native(AudioQueueStart(output,nil))
  }
  private func enqueue(_ bytes: UInt32,_ count: UInt32,_ source: UnsafeRawPointer,_ packets: UnsafeMutablePointer<AudioStreamPacketDescription>?) throws {
    guard bytes > 0,bytes <= Self.bytes,count > 0,count <= Self.packets,let packets,let queue else { throw Failure.bounds }
    condition.lock()
    while !available.contains(true) {
      if cancelled || closing || !active() { condition.unlock();throw Failure.retired }
      _ = condition.wait(until:Date().addingTimeInterval(0.025))
    }
    guard !cancelled && !closing && active(),let slot = available.firstIndex(of:true) else { condition.unlock();throw Failure.retired }
    available[slot] = false;condition.unlock()
    let target = buffers[slot]
    memcpy(target.pointee.mAudioData,source,Int(bytes));target.pointee.mAudioDataByteSize = bytes
    descriptions[slot].update(from:packets,count:Int(count))
    try native(AudioQueueEnqueueBuffer(queue,target,count,descriptions[slot]))
  }
  func finish() throws {
    try parsing.withLock {
      try check();guard let queue else { throw Failure.bounds }
      condition.withLock { inputEnded = true }
      try native(AudioQueueFlush(queue));try native(AudioQueueStop(queue,false))
    }
  }
  /// Mark cancellation before waiting for an in-progress parser/backpressure callback to return.
  func cancel() { condition.withLock { cancelled = true;condition.broadcast() } }
  func close() throws {
    cancel()
    try parsing.withLock {
      condition.withLock { closing = true }
      var first: OSStatus = 0
      if let queue {
        let stop = AudioQueueStop(queue,true),dispose = AudioQueueDispose(queue,true)
        // Never free descriptors or drop the owner while native disposal is uncertain.
        if dispose != 0 { throw Failure.native(dispose) }
        self.queue = nil;if stop != 0 { first = stop }
      }
      if let stream {
        let status = AudioFileStreamClose(stream)
        guard status == 0 else { throw Failure.native(status) };self.stream = nil
      }
      for value in descriptions { value.deallocate() };descriptions.removeAll();buffers.removeAll();available.removeAll()
      if first != 0 { throw Failure.native(first) }
    }
  }
  private func record(_ error: Error) { condition.withLock { if failure == nil { failure = error };condition.broadcast() } }
  private func native(_ status: OSStatus) throws { if status != 0 { throw Failure.native(status) } }
  private static let property: AudioFileStream_PropertyListenerProc = { raw,file,key,_ in
    let owner=Unmanaged<LiveMP3AudioQueue>.fromOpaque(raw).takeUnretainedValue()
    if key == kAudioFileStreamProperty_ReadyToProducePackets { do { try owner.setup(file) } catch { owner.record(error) } }
  }
  private static let packet: AudioFileStream_PacketsProc = { raw,bytes,count,data,packets in
    let owner=Unmanaged<LiveMP3AudioQueue>.fromOpaque(raw).takeUnretainedValue()
    do { try owner.enqueue(bytes,count,data,packets) } catch { owner.record(error) }
  }
  private static let output: AudioQueueOutputCallback = { raw,_,buffer in
    guard let raw else { return };let owner=Unmanaged<LiveMP3AudioQueue>.fromOpaque(raw).takeUnretainedValue()
    let deliver = owner.condition.withLock {
      guard let index=owner.buffers.firstIndex(of:buffer) else { return false }
      owner.available[index] = true;owner.condition.broadcast();return !owner.cancelled && !owner.closing && owner.active()
    }
    if deliver { owner.consumed() }
  }
  private static let running: AudioQueuePropertyListenerProc = { raw,queue,_ in
    guard let raw else { return };let owner=Unmanaged<LiveMP3AudioQueue>.fromOpaque(raw).takeUnretainedValue()
    var running: UInt32=1,size=UInt32(MemoryLayout<UInt32>.size)
    guard AudioQueueGetProperty(queue,kAudioQueueProperty_IsRunning,&running,&size)==0,running==0 else { return }
    let deliver=owner.condition.withLock { owner.inputEnded && !owner.cancelled && !owner.closing && owner.active() }
    if deliver { owner.ended() }
  }
}
