import Foundation
import WebKit

/// A new ephemeral view per image, with no message handlers or publisher document navigation.
@MainActor
final class ResourceSvg: NSObject, WKNavigationDelegate {
  private static var active = 0
  private var view: WKWebView?
  private var completion: CheckedContinuation<String?, Never>?
  private var timer: Task<Void, Never>?

  static func render(_ encoded: String) async -> String? {
    guard active < 4, (1...349528).contains(encoded.utf8.count),
      Data(base64Encoded: encoded) != nil,
      let url = Bundle(for: ResourceSvg.self).url(forResource: "HypergolicNappletHostAssets", withExtension: "bundle")
        ?? Bundle.main.url(forResource: "HypergolicNappletHostAssets", withExtension: "bundle"),
      let file = Bundle(url: url)?.url(forResource: "resource-svg", withExtension: "html"),
      let template = try? String(contentsOf: file, encoding: .utf8) else { return nil }
    active += 1
    defer { active -= 1 }
    let renderer = ResourceSvg()
    return await renderer.run(template.replacingOccurrences(of: "__SVG_BASE64__", with: encoded))
  }

  private func run(_ page: String) async -> String? {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    let browser = WKWebView(frame: .zero, configuration: config)
    view = browser
    browser.navigationDelegate = self
    return await withCheckedContinuation { continuation in
      completion = continuation
      timer = Task { @MainActor in
        try? await Task.sleep(for: .seconds(4))
        if !Task.isCancelled { self.finish(nil) }
      }
      browser.loadHTMLString(page, baseURL: nil)
    }
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    Task { @MainActor in
      while completion != nil {
        if let result = try? await webView.evaluateJavaScript("window.pngResult ?? null") as? String {
          finish(!result.isEmpty && result.utf8.count <= 6291456 ? result : nil)
          return
        }
        try? await Task.sleep(for: .milliseconds(40))
      }
    }
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { finish(nil) }

  private func finish(_ result: String?) {
    timer?.cancel()
    timer = nil
    view?.stopLoading()
    view?.navigationDelegate = nil
    view = nil
    completion?.resume(returning: result)
    completion = nil
  }
}
