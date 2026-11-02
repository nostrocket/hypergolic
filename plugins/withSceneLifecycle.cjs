const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');
const { isDeepStrictEqual } = require('node:util');

const manifest = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [{
      UISceneConfigurationName: 'Hypergolic',
      UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).HypergolicSceneDelegate',
    }],
  },
};
const properties = '  var reactNativeFactory: RCTReactNativeFactory?';
const sceneProperties = `${properties}

  // @generated begin hypergolic-scene-properties
  private var sceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?
  private weak var connectedScene: UIWindowScene?
  // @generated end hypergolic-scene-properties`;
const legacyStart = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;
const sceneStart = `    // UIKit connects the scene after application launch; create the window there.
    sceneLaunchOptions = launchOptions`;
const linkMarker = '  // Linking API';
const sceneConnection = `  // @generated begin hypergolic-scene-connection
  func ownsScene(_ scene: UIScene) -> Bool {
    scene.session.role == .windowApplication && connectedScene === scene
  }

  func connectScene(_ scene: UIWindowScene, options: UIScene.ConnectionOptions) -> UIWindow? {
    guard scene.session.role == .windowApplication,
      connectedScene == nil || connectedScene === scene,
      let factory = reactNativeFactory else { return nil }
    connectedScene = scene
    if let window {
      // Reconnection reuses the process runtime and native owner claim.
      window.windowScene = scene
      window.makeKeyAndVisible()
      forwardSceneURLs(options.urlContexts)
      for activity in options.userActivities { continueSceneActivity(activity) }
      return window
    }
    var launchOptions = sceneLaunchOptions ?? [:]
    if let context = options.urlContexts.first {
      launchOptions[.url] = context.url
      launchOptions[.sourceApplication] = context.options.sourceApplication
      launchOptions[.annotation] = context.options.annotation
    }
    if let activity = options.userActivities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb }) ?? options.userActivities.first {
      launchOptions[.userActivityDictionary] = [
        UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType,
        "UIApplicationLaunchOptionsUserActivityKey": activity,
      ]
    }
    let window = UIWindow(windowScene: scene)
    self.window = window
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)
    sceneLaunchOptions = nil
    // Cold links are initial launch options, not duplicate warm events.
    return window
  }

  func disconnectScene(_ scene: UIScene) {
    guard ownsScene(scene) else { return }
    connectedScene = nil
    window?.isHidden = true
    window?.windowScene = nil
  }

  func forwardSceneURLs(_ contexts: Set<UIOpenURLContext>) {
    for context in contexts {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
      options[.sourceApplication] = context.options.sourceApplication
      options[.annotation] = context.options.annotation
      _ = application(UIApplication.shared, open: context.url, options: options)
    }
  }

  func continueSceneActivity(_ activity: NSUserActivity) {
    _ = application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
  }
  // @generated end hypergolic-scene-connection

`;
const delegateMarker = 'class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {';
const sceneDelegate = `// @generated begin hypergolic-scene-delegate
@MainActor
class HypergolicSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  private var appDelegate: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene else { return }
    window = appDelegate?.connectScene(scene, options: connectionOptions)
  }

  func sceneDidDisconnect(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    appDelegate.disconnectScene(scene)
    window = nil
  }

  // UIKit owns UIApplication notifications. Forward only Expo's delegate subscribers.
  func sceneDidBecomeActive(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    appDelegate.applicationDidBecomeActive(UIApplication.shared)
  }
  func sceneWillResignActive(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    appDelegate.applicationWillResignActive(UIApplication.shared)
  }
  func sceneDidEnterBackground(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    appDelegate.applicationDidEnterBackground(UIApplication.shared)
  }
  func sceneWillEnterForeground(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    appDelegate.applicationWillEnterForeground(UIApplication.shared)
  }
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    appDelegate.forwardSceneURLs(URLContexts)
  }
  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    appDelegate.continueSceneActivity(userActivity)
  }
}
// @generated end hypergolic-scene-delegate

`;
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Expo AppDelegate template changed; review scene lifecycle integration.');
  return source.replace(before, after);
}
function transformAppDelegate(source) {
  if (source.includes('hypergolic-scene-')) {
    for (const block of [sceneProperties, sceneStart, sceneConnection, sceneDelegate]) {
      if (source.split(block).length !== 2) throw new Error('Generated scene lifecycle integration changed; review before rebuilding.');
    }
  } else {
    if (/SceneDelegate|connectScene\(|UIApplicationSceneManifest/.test(source)) throw new Error('Existing scene lifecycle integration conflicts with Hypergolic.');
    source = replaceOnce(source, properties, sceneProperties);
    source = replaceOnce(source, legacyStart, sceneStart);
    source = replaceOnce(source, linkMarker, sceneConnection + linkMarker);
    source = replaceOnce(source, delegateMarker, sceneDelegate + delegateMarker);
  }
  if (source.includes('UIWindow(frame:') || source.split('factory.startReactNative(').length !== 2) {
    throw new Error('AppDelegate must start one React runtime in its scene-owned window.');
  }
  return source;
}
module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, result => {
    const existing = result.modResults.UIApplicationSceneManifest;
    if (existing !== undefined && !isDeepStrictEqual(existing, manifest)) {
      throw new Error('Existing UIApplicationSceneManifest conflicts with the single Hypergolic scene.');
    }
    result.modResults.UIApplicationSceneManifest = structuredClone(manifest);
    return result;
  });
  return withAppDelegate(config, result => {
    if (result.modResults.language !== 'swift') throw new Error('Hypergolic scene lifecycle requires the reviewed Swift AppDelegate.');
    result.modResults.contents = transformAppDelegate(result.modResults.contents);
    return result;
  });
};
