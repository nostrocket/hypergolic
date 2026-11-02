import UIKit

/// Native-only review and OS dispatch. There is no guest-visible generic opener.
@MainActor
enum LinkTransport {
  nonisolated private static let leases = LinkLeaseRegistry()
  private struct Pending {let generation: String; let id: String; let url: URL; let reply: @MainActor @Sendable (String?) -> Void; var dialog: UIAlertController?}
  private static var pending: [String: Pending] = [:]
  static func register(_ generation: String, config: CapabilityConfiguration) -> Bool {leases.register(generation, user: config.user, epoch: config.epoch)}
  nonisolated static func synchronizeOwner(_ user: String, epoch: UInt64, available: Bool) -> Bool {
    guard let tokens = leases.synchronizeOwner(user, epoch: epoch, available: available) else {return false}
    Task {@MainActor in cancel(tokens, revoked: true)}; return true
  }
  static func focus(_ generation: String, _ value: Bool) {cancel(leases.focus(generation, value), revoked: false)}
  nonisolated static func foreground(_ value: Bool) {
    let tokens = leases.setForeground(value)
    Task {@MainActor in cancel(tokens, revoked: false)}
  }
  static func revoke(_ generation: String) {cancel(leases.revoke(generation), revoked: true)}
  private static func result(_ id: String, _ status: String, _ error: String? = nil) -> String {
    var value = ["type": "link.open.result", "id": id, "status": status]
    if let error {value["error"] = error}
    return String(decoding: try! JSONSerialization.data(withJSONObject: value), as: UTF8.self)
  }
  private static func cancel(_ tokens: [String], revoked: Bool) {
    for token in tokens {if let p = pending.removeValue(forKey: token) {p.dialog?.dismiss(animated: false); p.reply(revoked || !leases.canDeliver(p.generation) ? nil : result(p.id, "denied", "blocked-by-policy"))}}
  }
  private static func finish(_ token: String, _ status: String, _ error: String? = nil) {
    let active = leases.finish(token)
    if let p = pending.removeValue(forKey: token) {p.dialog?.dismiss(animated: false); p.reply(active ? result(p.id, status, error) : leases.canDeliver(p.generation) ? result(p.id, "denied", "blocked-by-policy") : nil)}
  }
  static func receive(_ generation: String, config: CapabilityConfiguration, raw: String, view: UIView,
      reply: @escaping @MainActor @Sendable (String?) -> Void) {
    guard leases.canDeliver(generation) else {reply(nil); return}
    guard let value = try? UploadWire.object(raw, limit: 16 * 1024), let id = value["id"] as? String,
      (1...128).contains(id.utf8.count), id.unicodeScalars.allSatisfy({$0.value >= 32 && $0.value != 127}) else {reply(nil); return}
    let url = value["url"] as? String
    var shape = value["type"] as? String == "link.open" && Set(value.keys).isSubset(of: ["type", "id", "url", "options"])
    if value.keys.contains("options") {
      if let options = value["options"] as? [String: Any], Set(options.keys).isSubset(of: ["label"]) {
        if options.keys.contains("label") {shape = shape && (options["label"] as? String).map {$0.utf8.count <= 256 && $0.unicodeScalars.allSatisfy {$0.value >= 32 && $0.value != 127}} == true}
      } else {shape = false}
    }
    if let error = shape ? LinkUrl.error(url) : "invalid-url" {reply(result(id, "denied", error)); return}
    guard config.domains.contains("link"), var presenter = view.window?.rootViewController, let token = leases.admit(generation), let target = URL(string: url!) else {reply(result(id, "denied", "blocked-by-policy")); return}
    while let next = presenter.presentedViewController {presenter = next}
    pending[token] = Pending(generation: generation, id: id, url: target, reply: reply)
    guard !presenter.isBeingDismissed, !presenter.isBeingPresented else {finish(token, "denied", "blocked-by-policy"); return}
    let author = config.fixture == "published" ? "Publisher: \(config.publisher)" : "Unsigned embedded test napplet"
    let dialog = UIAlertController(title: "Open external link?", message: "Napplet: \(LinkUrl.displayIdentity(config.appId))\n\(author)\n\nDestination: \(target.host ?? "")\n\(url!)\n\nYour device may open a browser or an associated app.", preferredStyle: .alert)
    dialog.addAction(UIAlertAction(title: "Cancel", style: .cancel) {_ in finish(token, "denied", "user-denied")})
    dialog.addAction(UIAlertAction(title: "Open once", style: .default) {_ in dispatch(token)})
    pending[token]?.dialog = dialog; presenter.present(dialog, animated: true)
    DispatchQueue.main.asyncAfter(deadline: .now() + 25) {cancel(leases.expire(), revoked: false)}
  }
  private static func dispatch(_ token: String) {
    guard let p = pending[token] else {return}
    guard leases.claim(token) else {finish(token, "denied", "blocked-by-policy"); return}
    UIApplication.shared.open(p.url, options: [:]) {accepted in
      Task {@MainActor in finish(token, accepted ? "opened" : "denied", accepted ? nil : "blocked-by-policy")}
    }
  }
}
