import AVFoundation
import CoreFoundation
import UIKit

/// Main-actor owner of an optional shell-only finite video card.
@MainActor
final class NativeFiniteVideo {
  @MainActor private final class Session {
    let id = "media-" + UUID().uuidString.lowercased()
    let url: String, host: String
    let push: ([String: Any]) -> Void
    var consent: String?
    var volume: Float = 1
    var fetch: Fetch?
    var operation: PublishedPinnedHTTPS.Operation?
    var file: URL?
    var player: AVPlayer?
    var layer: AVPlayerLayer?
    var observation: NSKeyValueObservation?
    var itemObservation: NSKeyValueObservation?
    var sizeObservation: NSKeyValueObservation?
    var durationObservation: NSKeyValueObservation?
    var clock: Any?
    var ended: NSObjectProtocol?
    var interruption: NSObjectProtocol?
    var finished = false
    var prepared = false
    var prepareDeadline: Task<Void, Never>?
    init(url: String, host: String, push: @escaping ([String: Any]) -> Void) {
      self.url = url; self.host = host; self.push = push
    }
  }
  private final class Fetch: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var progressPending = false
    private var nextProgress = DispatchTime.now()
    let deadline = DispatchTime.now() + .seconds(MediaHTTPSFile.totalSeconds)
    var active: Bool { lock.withLock { !cancelled } }
    func cancel() { lock.withLock { cancelled = true } }
    func queueProgress() -> Bool {
      lock.withLock {
        let now = DispatchTime.now()
        guard !cancelled, !progressPending, now >= nextProgress else { return false }
        progressPending = true; nextProgress = now + .milliseconds(500)
        return true
      }
    }
    func deliveredProgress() { lock.withLock { progressPending = false } }
  }
  private weak var host: UIView?
  private let allowed: () -> Bool
  private let generation: String
  private let permit: @Sendable () -> String?
  private var session: Session?
  private var panel: UIView?, picture: UIView?, heading: UILabel?, play: UIButton?, stop: UIButton?
  private var created = 0
  private static weak var active: NativeFiniteVideo?
  private static var download: Fetch?

  init(host: UIView, generation: String, permit: @escaping @Sendable () -> String?, allowed: @escaping () -> Bool) {
    self.host = host; self.generation = generation; self.permit = permit; self.allowed = allowed
  }
  static func revokeGenerations(_ generations: Set<String>) {
    if let active, generations.contains(active.generation) { active.retire("policy") }
  }

  func receive(_ request: [String: Any], push: @escaping ([String: Any]) -> Void) {
    if request["type"] as? String == "media.session.create" { create(request, push: push); return }
    guard let row = session, request["sessionId"] as? String == row.id else { return }
    let fields = Set(request.keys)
    if request["type"] as? String == "media.session.destroy", fields == ["type", "sessionId"] { retire("destroyed"); return }
    guard allowed(), permit() != nil, request["type"] as? String == "media.command",
      fields.isSubset(of: ["type", "sessionId", "action", "value"]), let action = request["action"] as? String,
      (request["value"] != nil) == (action == "seek" || action == "volume") else { return }
    let value = (request["value"] as? NSNumber).flatMap { CFGetTypeID($0) != CFBooleanGetTypeID() && $0.doubleValue.isFinite ? $0.doubleValue : nil }
    switch action {
    case "play": if authorized(row), row.player != nil { resume(row) }
    case "pause": pause(row, reason: "user")
    case "stop": retire("user")
    case "seek":
      if let value, let player = row.player, row.prepared, authorized(row), (0...3600).contains(value) {
        player.seek(to: CMTime(seconds: min(value, duration(row) ?? value), preferredTimescale: 600))
      }
    case "volume":
      if let value, (0...1).contains(value) { row.volume = Float(value); row.player?.volume = row.volume; publishState(row) }
    default: break
    }
  }

  private func create(_ request: [String: Any], push: @escaping ([String: Any]) -> Void) {
    guard let id = request["id"] as? String, id.range(of: "^[!-~]{1,128}$", options: .regularExpression) != nil else { return }
    let result = ["type": "media.session.create.result", "id": id]
    guard allowed(), permit() != nil, created < 64 else { push(result.merging(["error":"Media unavailable."]) { _, b in b }); return }
    guard Set(request.keys) == ["type", "id", "url"], let raw = request["url"] as? String,
      let target = try? PublishedPinnedHTTPS.Request(raw, resourceProfile: true),
      let url = URL(string: raw), !url.path.lowercased().hasSuffix(".m3u8") else {
      push(result.merging(["error":"Unsupported media source."]) { _, b in b }); return
    }
    Self.active?.retire("preempted")
    let row = Session(url: raw, host: target.host, push: push)
    session = row; Self.active = self; created += 1
    show(row)
    push(result.merging(["sessionId":row.id, "owner":"shell"]) { _, b in b })
    publishState(row)
    publishCapabilities(row)
  }

  private func show(_ row: Session) {
    let card = UIView(); card.backgroundColor = .black
    let picture = UIView(); picture.backgroundColor = .black
    let title = UILabel(); title.text = offer(row); title.textColor = .white; title.numberOfLines = 3
    let play = UIButton(type: .system); play.setTitle("Play video", for: .normal)
    play.addAction(UIAction { [weak self, weak row] _ in if let row { self?.trustedPlay(row) } }, for: .touchUpInside)
    let close = UIButton(type: .system); close.setTitle("Close video", for: .normal)
    close.addAction(UIAction { [weak self, weak row] _ in if self?.session === row { self?.retire("user") } }, for: .touchUpInside)
    let buttons = UIStackView(arrangedSubviews: [play, close]); buttons.axis = .horizontal; buttons.distribution = .fillEqually
    let content = UIStackView(arrangedSubviews: [title, picture, buttons]); content.axis = .vertical; content.spacing = 4
    content.translatesAutoresizingMaskIntoConstraints = false; picture.isHidden = true
    card.addSubview(content); host?.addSubview(card)
    NSLayoutConstraint.activate([content.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
      content.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -12),
      content.topAnchor.constraint(equalTo: card.topAnchor, constant: 8), content.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -4),
      buttons.heightAnchor.constraint(equalToConstant: 44)])
    panel = card; self.picture = picture; heading = title; self.play = play; stop = close
    layout()
  }

  func layout() {
    guard let host, let panel else { return }
    let playing = session?.prepared == true
    let height = 106 + (playing ? min(host.bounds.width * 9 / 16, host.bounds.height * 0.55) : 0)
    panel.frame = CGRect(x:0, y:max(0, host.bounds.height - height), width:host.bounds.width, height:min(height, host.bounds.height))
    panel.layoutIfNeeded()
    if let picture { session?.layer?.frame = picture.bounds }
  }

  private func trustedPlay(_ row: Session) {
    guard session === row, allowed(), panel?.window != nil, panel?.isHidden == false else { return }
    if let status = row.player?.timeControlStatus, status != .paused { row.consent = nil; pause(row, reason:"user"); return }
    if row.fetch != nil { return }
    guard let receipt = permit() else { return }
    row.consent = receipt
    if row.player != nil { if row.prepared { resume(row) }; return }
    guard Self.download == nil else { heading?.text = "Previous video is stopping. Try Play again."; return }
    let job = Fetch(); row.fetch = job; Self.download = job
    play?.isEnabled = false
    heading?.text = "\(row.host) · Connecting"
    stop?.setTitle("Cancel download", for:.normal)
    publishState(row)
    do {
      let permit = self.permit
      let stillActive: @Sendable () -> Bool = { job.active && permit() == receipt }
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent("hypergolic-finite-media-file-v1", isDirectory:true)
      let sink = MediaHTTPSFile(directory: directory, deadline: job.deadline, active: stillActive) { [weak self] written, total in
        guard job.queueProgress() else { return }
        Task { @MainActor in
          job.deliveredProgress()
          guard let self, let row = self.session, row.fetch === job else { return }
          self.heading?.text = "\(row.host) · Downloading \(written * 100 / total)%"
        }
      }
      row.operation = try PublishedPinnedHTTPS.fetchMediaFile(row.url, sink: sink, deadline: job.deadline,
        active: stillActive) { [weak self] result in
          let staged = try? result.get()
          Task { @MainActor in
            if Self.download === job { Self.download = nil }
            guard let self, let row = self.session, row.fetch === job, self.allowed(), self.authorized(row) else {
              if let staged { try? FileManager.default.removeItem(at: staged) }
              return
            }
            self.complete(row, staged: staged)
          }
        }
    } catch {
      Self.download = nil; row.fetch = nil; fail(row)
    }
  }

  private func offer(_ row: Session) -> String { "\(row.host) · Play downloads up to 256 MiB" }

  private func complete(_ row: Session, staged: URL?) {
    row.fetch = nil; row.operation = nil
    heading?.text = row.host; stop?.setTitle("Close video", for:.normal)
    guard let staged else { fail(row); return }
    row.file = staged
    // AVPlayer sees an app-private local file and never receives the publisher URL.
    let asset = AVURLAsset(url: staged, options: [AVURLAssetReferenceRestrictionsKey: NSNumber(value: AVAssetReferenceRestrictions.forbidAll.rawValue)])
    let item = AVPlayerItem(asset: asset), player = AVPlayer(playerItem: item)
    player.allowsExternalPlayback = false; player.volume = row.volume
    row.player = player
    let layer = AVPlayerLayer(player: player); layer.videoGravity = .resizeAspect; row.layer = layer
    picture?.layer.addSublayer(layer)
    row.observation = player.observe(\.timeControlStatus) { [weak self, weak row] _, _ in
      Task { @MainActor [weak self, weak row] in if let row, self?.session === row { self?.publishState(row) } }
    }
    row.itemObservation = item.observe(\.status, options:[.initial, .new]) { [weak self, weak row] _, _ in
      Task { @MainActor [weak self, weak row] in if let row { self?.checkItem(row) } }
    }
    row.sizeObservation = item.observe(\.presentationSize, options:[.initial, .new]) { [weak self, weak row] _, _ in
      Task { @MainActor [weak self, weak row] in if let row { self?.checkItem(row) } }
    }
    row.durationObservation = item.observe(\.duration, options:[.new]) { [weak self, weak row] _, _ in
      Task { @MainActor [weak self, weak row] in if let row { self?.checkItem(row) } }
    }
    row.prepareDeadline = Task { @MainActor [weak self, weak row] in
      try? await Task.sleep(for:.seconds(10))
      guard !Task.isCancelled, let self, let row, self.session === row, !row.prepared else { return }
      self.fail(row)
    }
    row.clock = player.addPeriodicTimeObserver(forInterval: CMTime(seconds:0.5, preferredTimescale:600), queue:.main) { [weak self, weak row] _ in
      MainActor.assumeIsolated { if let self, let row, self.session === row, self.checkItem(row) { self.publishState(row) } }
    }
    row.ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object:item, queue:.main) { [weak self, weak row] _ in
      MainActor.assumeIsolated {
        if let row, self?.session === row { row.finished = true; self?.play?.setTitle("Play video", for: .normal); self?.publishState(row, reason:"ended") }
      }
    }
    row.interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self, weak row] notification in
      guard notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt == AVAudioSession.InterruptionType.began.rawValue else { return }
      MainActor.assumeIsolated {
        if let row, self?.session === row { row.consent = nil; self?.pause(row, reason:"focus-lost") }
      }
    }
  }

  @discardableResult
  private func checkItem(_ row: Session) -> Bool {
    guard session === row, let item = row.player?.currentItem else { return false }
    if item.status == .failed { fail(row); return false }
    guard item.status == .readyToPlay else { return false }
    let duration = item.duration.seconds, size = item.presentationSize
    guard duration.isFinite else {
      if row.prepared { fail(row) }
      return false
    }
    guard duration > 0, duration <= 3600 else { fail(row); return false }
    guard size.width != 0 || size.height != 0 else { return false }
    guard FiniteMP4.validDimensions(size.width, size.height) else { fail(row); return false }
    if !row.prepared {
      row.prepareDeadline?.cancel(); row.prepareDeadline = nil; row.prepared = true
      picture?.isHidden = false; layout()
      play?.isEnabled = true
      if authorized(row) && allowed() { resume(row) } else { publishCapabilities(row) }
    }
    return true
  }

  private func resume(_ row: Session) {
    guard session === row, allowed(), authorized(row), row.prepared, let player = row.player else { return }
    if row.finished { row.finished = false; player.seek(to:.zero) }
    player.play(); play?.setTitle("Pause video", for: .normal); publishState(row); publishCapabilities(row)
  }
  private func pause(_ row: Session, reason: String) {
    row.fetch?.cancel(); row.fetch = nil; row.operation?.cancel(); row.operation = nil
    row.player?.pause()
    play?.isEnabled = true; play?.setTitle("Play video", for: .normal)
    stop?.setTitle("Close video", for:.normal); heading?.text = row.file == nil ? offer(row) : row.host
    publishState(row, reason: reason); publishCapabilities(row)
  }
  private func duration(_ row: Session) -> Double? {
    guard let seconds = row.player?.currentItem?.duration.seconds, seconds.isFinite, seconds >= 0 else { return nil }
    return min(seconds, 3600)
  }
  private func publishState(_ row: Session, reason: String? = nil) {
    let status: String
    if row.finished || reason == "error" { status = "stopped" }
    else if row.fetch != nil || row.player?.timeControlStatus == .waitingToPlayAtSpecifiedRate { status = "buffering" }
    else { status = row.player?.timeControlStatus == .playing ? "playing" : "paused" }
    var state: [String: Any] = ["type":"media.state", "sessionId":row.id, "status":status, "volume":row.volume]
    if let reason = reason ?? (row.finished ? "ended" : nil) { state["reason"] = reason }
    if let duration = duration(row) { state["duration"] = duration }
    if let current = row.player?.currentTime().seconds, current.isFinite, current >= 0 { state["position"] = min(current, 3600) }
    row.push(state)
  }
  private func publishCapabilities(_ row: Session) {
    let actions = row.prepared && authorized(row) ? ["play", "pause", "stop", "seek", "volume"] : ["pause", "stop", "volume"]
    row.push(["type":"media.capabilities", "sessionId":row.id, "actions":actions])
  }

  func focusChanged(visible: Bool) {
    guard let row = session else { return }
    let focused = visible && allowed(); panel?.isHidden = !focused
    if !focused { row.consent = nil; pause(row, reason:"focus-lost") }
  }
  private func authorized(_ row: Session) -> Bool { row.consent.map { permit() == $0 } == true }
  private func fail(_ row: Session) { publishState(row, reason:"error"); retire("error") }
  func retire(_ reason: String? = nil) {
    guard let row = session else { return }
    session = nil; if Self.active === self { Self.active = nil }
    row.fetch?.cancel(); row.operation?.cancel(); row.prepareDeadline?.cancel()
    row.observation?.invalidate(); row.itemObservation?.invalidate(); row.sizeObservation?.invalidate(); row.durationObservation?.invalidate()
    if let ended = row.ended { NotificationCenter.default.removeObserver(ended) }
    if let interruption = row.interruption { NotificationCenter.default.removeObserver(interruption) }
    if let clock = row.clock { row.player?.removeTimeObserver(clock) }
    row.player?.pause(); row.player?.replaceCurrentItem(with:nil); row.layer?.player = nil
    if let file = row.file { try? FileManager.default.removeItem(at:file) }
    panel?.removeFromSuperview(); panel = nil; picture = nil; heading = nil; play = nil; stop = nil
    if let reason { row.push(["type":"media.session.ended", "sessionId":row.id, "reason":reason]) }
  }
}
