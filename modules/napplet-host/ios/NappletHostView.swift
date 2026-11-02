import ExpoModulesCore

/// Expo lifecycle wrapper. The native core owns one immutable generation.
@MainActor
final class NappletHostView: ExpoView {
  let onHostEvent = EventDispatcher()
  private let host = RestrictedNappletHost()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = host.backgroundColor
    addSubview(host)
    host.onEvent = { [weak self] event in self?.onHostEvent(event) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.frame = bounds
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    // Removing the wrapper does not remove the core from its parent.
    if superview != nil && newSuperview == nil { host.destroySession() }
    super.willMove(toSuperview: newSuperview)
  }

  override func prepareForRecycle() {
    host.destroySession()
    super.prepareForRecycle()
  }

  func armPickerFaultProof(_ action: String) { host.armPickerFaultProof(action) }
  func armUploadFaultProof(_ action: String) { host.armUploadFaultProof(action) }
  func setCloseCheck(_ raw: String) { host.setCloseCheck(raw) }
  func setActive(_ active: Bool) { host.setActive(active) }
  func startConfiguredSession(_ raw: String) { host.startConfiguredSession(raw) }
  func startPublishedArtifact(_ raw: String) { host.startPublishedArtifact(raw) }
  func startSession(_ id: String) { host.startSession(id) }
}
