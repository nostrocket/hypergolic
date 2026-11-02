import Foundation
import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// Native single-file selection, sanitized before WebKit receives a copied, app-private URL.
@MainActor
final class SelectedFilePicker: NSObject, UIDocumentPickerDelegate, PHPickerViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
  private static var preparing = false
  private static var selections = Set<UUID>()
  private static let stagingRoot: URL = {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("hypergolic-selected-files", isDirectory: true)
    try? FileManager.default.removeItem(at: root)
    try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }()
  private var selectionID: UUID?
  private static weak var current: SelectedFilePicker?
  private let live: @MainActor () -> Bool
  private var completion: (@MainActor @Sendable ([URL]?) -> Void)?
  private weak var presenter: UIViewController?
  private weak var panel: UIViewController?
  private var selectedDirectory: URL?
  private var deadline: TimeInterval = 0
  private var processing = false
  private var photoProgress: Progress?

  init(live: @escaping @MainActor () -> Bool) { self.live = live; super.init() }
  func choose(from presenter: UIViewController, completion: @escaping @MainActor @Sendable ([URL]?) -> Void) {
    guard self.completion == nil, Self.current == nil, !Self.preparing, live(), UIApplication.shared.applicationState == .active,
      presenter.presentedViewController == nil else { completion(nil); return }
    clearSelection(); self.presenter = presenter; self.completion = completion; Self.current = self
    deadline = ProcessInfo.processInfo.systemUptime + 600
    let menu = UIAlertController(title: "Share a selected file", message: "The requesting napplet can read the selected file. Supported photos are prepared as PNG without resizing before sharing. Uploading requires a separate approval.", preferredStyle: .alert)
    menu.addAction(UIAlertAction(title: "Choose photo", style: .default) { [weak self] _ in self?.afterMenu { $0.photos() } })
    menu.addAction(UIAlertAction(title: "Choose file", style: .default) { [weak self] _ in self?.afterMenu { $0.files() } })
    menu.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in self?.finish(nil) })
    panel = menu; presenter.present(menu, animated: true)
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(600))
      guard let self, self.completion != nil, ProcessInfo.processInfo.systemUptime >= self.deadline else { return }
      self.cancel()
    }
  }
  func cancel() {
    let panel = panel; finish(nil); panel?.dismiss(animated: false); clearSelection()
  }
  func background() { cancel() }
  private func permitted() -> Bool {
    completion != nil && live() && UIApplication.shared.applicationState == .active && ProcessInfo.processInfo.systemUptime < deadline
  }
  private func afterMenu(_ show: @escaping @MainActor (SelectedFilePicker) -> Void) {
    guard let menu = panel else {finish(nil); return}
    menu.dismiss(animated: false) { [weak self] in guard let self else {return}; show(self) }
  }
  private func files() {
    guard permitted(), let presenter else { finish(nil); return }
    // Open in place: bound our read before creating any app-owned copy; no persistent bookmark.
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
    picker.allowsMultipleSelection = false; picker.delegate = self
    panel = picker; picker.presentationController?.delegate = self; presenter.present(picker, animated: true)
  }
  private func photos() {
    guard permitted(), let presenter else { finish(nil); return }
    var config = PHPickerConfiguration(); config.filter = .images; config.selectionLimit = 1
    config.preferredAssetRepresentationMode = .current
    let picker = PHPickerViewController(configuration: config); picker.delegate = self
    panel = picker; picker.presentationController?.delegate = self; presenter.present(picker, animated: true)
  }
  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(nil) }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(nil) }
  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard permitted(), urls.count == 1, !processing else { finish(nil); return }
    processing = true; Self.preparing = true; let url = urls[0]
    Task { @MainActor [weak self] in
      let data = await Task.detached(priority: .userInitiated) { Self.prepare(url) }.value
      Self.preparing = false; self?.deliver(data)
    }
  }
  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard permitted(), results.count == 1, !processing else { finish(nil); return }
    processing = true; Self.preparing = true
    let provider = results[0].itemProvider
    guard let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) else {Self.preparing = false; finish(nil); return}
    // File representation avoids allocating an unbounded Data object from a library asset.
    photoProgress = provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] url, error in
      let data = error == nil ? url.flatMap { Self.prepare($0) } : nil
      Task { @MainActor [weak self] in Self.preparing = false; self?.deliver(data) }
    }
  }
  private nonisolated static func prepare(_ url: URL) -> UploadFileProfile.Prepared? {
    guard url.isFileURL else { return nil }
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
      attributes[.type] as? FileAttributeType == .typeRegular,
      let length = attributes[.size] as? NSNumber, length.int64Value <= Int64(NativeUploadAuthority.maxBytes),
      let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer {try? handle.close()}
    var original = Data(); defer {original.resetBytes(in: 0..<original.count)}
    do {
      while true {
        guard let chunk = try handle.read(upToCount: 64 * 1024), !chunk.isEmpty else { break }
        guard chunk.count <= NativeUploadAuthority.maxBytes - original.count else { return nil }; original.append(chunk)
      }
    } catch { return nil }
    // Failed photos never become unchanged attachments.
    return UploadPhotoPreparation.prepare(original)
  }
  private func deliver(_ data: UploadFileProfile.Prepared?) {
    guard permitted() else {finish(nil); return}
    guard let data else {
      finish(nil)
      if let presenter, presenter.presentedViewController == nil {
        let error = UIAlertController(title: "File could not be prepared", message: "No file was shared. Select a supported file within the file size limit.", preferredStyle: .alert)
        error.addAction(UIAlertAction(title: "OK", style: .default)); presenter.present(error, animated: true)
      }
      return
    }
    do {
      guard Self.selections.count < 2 else {finish(nil); return}
      let id = UUID()
      let directory = Self.stagingRoot.appendingPathComponent(id.uuidString, isDirectory: true)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
      selectedDirectory = directory; selectionID = id; Self.selections.insert(id)
      let file = directory.appendingPathComponent("Selected file." + Self.fileExtension(data.mimeType))
      try data.bytes.write(to: file, options: [.atomic, .completeFileProtection])
      guard permitted() else { clearSelection(); finish(nil); return }
      finish([file])
      Task { @MainActor [weak self] in
        try? await Task.sleep(for: .seconds(600))
        guard let self, self.selectionID == id else {return}
        self.clearSelection()
      }
    } catch {clearSelection(); finish(nil)}
  }
  private nonisolated static func fileExtension(_ mime: String) -> String {
    switch mime {case "image/png": "png"; case "audio/wav": "wav"; case "audio/mpeg": "mp3"; case "video/mp4": "mp4"; case "application/pdf": "pdf"; case "application/zip": "zip"; case "text/plain": "txt"; default: "bin"}
  }
  private func finish(_ urls: [URL]?) {
    let callback = completion; completion = nil; processing = false
    photoProgress?.cancel(); photoProgress = nil
    if Self.current === self {Self.current = nil}; callback?(urls)
  }
  private func clearSelection() {
    if let directory = selectedDirectory {try? FileManager.default.removeItem(at: directory)}
    if let id = selectionID {Self.selections.remove(id)}
    selectedDirectory = nil; selectionID = nil
  }
}
