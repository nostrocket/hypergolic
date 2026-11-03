const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');
function samePlistValue(actual, expected) {
  if (actual === expected) return true;
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length &&
    Reflect.ownKeys(actual).length === Reflect.ownKeys(expected).length &&
    expected.every((value, index) => samePlistValue(actual[index], value));
  if (expected === null || typeof expected !== 'object' || actual === null ||
      typeof actual !== 'object' || Array.isArray(actual)) return false;
  const keys = Reflect.ownKeys(expected);
  return Reflect.ownKeys(actual).length === keys.length &&
    keys.every(key => Object.hasOwn(actual, key) && samePlistValue(actual[key], expected[key]));
}

const manifest = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [{
      UISceneConfigurationName: 'Hypergolic',
      UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).HypergolicSceneDelegate',
    }],
  },
};
const sdk58DefaultManifest = {
  UIApplicationSupportsMultipleScenes: false,
  UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [{
      UISceneConfigurationName: 'Default Configuration',
      UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
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
function sceneConnection(sdk58) {
  return `  // @generated begin hypergolic-scene-connection
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
      window.makeKeyAndVisible()${sdk58 ? '' : `
      forwardSceneURLs(options.urlContexts)
      for activity in options.userActivities { continueSceneActivity(activity) }`}
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

${sdk58 ? '' : `  func forwardSceneURLs(_ contexts: Set<UIOpenURLContext>) {
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
`}  // @generated end hypergolic-scene-connection

`;
}
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

const sceneDelegate58 = `// @generated begin hypergolic-scene-delegate
@MainActor
class HypergolicSceneDelegate: ExpoAppSceneDelegate {
  private var appDelegate: AppDelegate? { UIApplication.shared.delegate as? AppDelegate }

  override func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard let scene = scene as? UIWindowScene, let appDelegate else { return }
    let reconnecting = appDelegate.window != nil
    window = appDelegate.connectScene(scene, options: connectionOptions)
    guard appDelegate.ownsScene(scene), window != nil else { return }
    // A reconnecting scene routes to the retained runtime. Cold links were launch options.
    if reconnecting {
      super.scene(scene, openURLContexts: connectionOptions.urlContexts)
      for activity in connectionOptions.userActivities { super.scene(scene, continue: activity) }
    }
  }

  override func sceneDidDisconnect(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    appDelegate.disconnectScene(scene)
    super.sceneDidDisconnect(scene)
  }

  override func sceneDidBecomeActive(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.sceneDidBecomeActive(scene)
  }

  override func sceneWillResignActive(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.sceneWillResignActive(scene)
  }

  override func sceneDidEnterBackground(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.sceneDidEnterBackground(scene)
  }

  override func sceneWillEnterForeground(_ scene: UIScene) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.sceneWillEnterForeground(scene)
  }

  override func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.scene(scene, openURLContexts: contexts)
  }

  override func scene(_ scene: UIScene, continue activity: NSUserActivity) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.scene(scene, continue: activity)
  }

  override func scene(_ scene: UIScene, willContinueUserActivityWithType type: String) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.scene(scene, willContinueUserActivityWithType: type)
  }

  override func scene(_ scene: UIScene, didUpdate activity: NSUserActivity) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.scene(scene, didUpdate: activity)
  }

  override func scene(_ scene: UIScene, didFailToContinueUserActivityWithType type: String, error: Error) {
    guard let appDelegate, appDelegate.ownsScene(scene) else { return }
    super.scene(scene, didFailToContinueUserActivityWithType: type, error: error)
  }

  override func windowScene(_ scene: UIWindowScene, performActionFor item: UIApplicationShortcutItem,
      completionHandler: @escaping (Bool) -> Void) {
    // Hypergolic does not expose quick-action routing.
    completionHandler(false)
  }
}
// @generated end hypergolic-scene-delegate

`;
const sdk58Start = "    // The window is created and React Native is started by `SceneDelegate` under the\n    // scene-based life cycle (required by the iOS 27 SDK).";
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Expo AppDelegate template changed; review scene lifecycle integration.');
  return source.replace(before, after);
}
function transformAppDelegate(source) {
  const sdk58 = source.includes('ExpoReactNativeFactoryProvider');
  const connection = sceneConnection(sdk58);
  const delegate = sdk58 ? sceneDelegate58 : sceneDelegate;
  if (source.includes('hypergolic-scene-')) {
    for (const block of [sceneProperties, sceneStart, connection, delegate]) {
      if (source.split(block).length !== 2) throw new Error('Generated scene lifecycle integration changed; review before rebuilding.');
    }
  } else {
    if ((sdk58 ? /class HypergolicSceneDelegate|connectScene\(/ : /SceneDelegate|connectScene\(|UIApplicationSceneManifest/).test(source)) throw new Error('Existing scene lifecycle integration conflicts with Hypergolic.');
    source = replaceOnce(source, properties, sceneProperties);
    source = replaceOnce(source, sdk58 ? sdk58Start : legacyStart, sceneStart);
    source = sdk58
      ? replaceOnce(source, '}\n\n' + delegateMarker, connection + '}\n\n' + delegate + delegateMarker)
      : replaceOnce(replaceOnce(source, linkMarker, connection + linkMarker), delegateMarker, delegate + delegateMarker);
  }
  if (source.includes('UIWindow(frame:') || source.split('factory.startReactNative(').length !== 2) {
    throw new Error('AppDelegate must start one React runtime in its scene-owned window.');
  }
  return source;
}
module.exports = function withSceneLifecycle(config) {
  config = withInfoPlist(config, result => {
    const existing = result.modResults.UIApplicationSceneManifest;
    if (existing !== undefined && !samePlistValue(existing, manifest) && !samePlistValue(existing, sdk58DefaultManifest)) {
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
