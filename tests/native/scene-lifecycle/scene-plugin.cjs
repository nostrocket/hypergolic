const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');
const plugin = require(path.join(root, 'plugins/withSceneLifecycle.cjs'));

// Reviewed Expo 57 template, before scene adoption. No generated ios/ tree is required.
const template = String.raw`internal import Expo
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
`;
async function apply(modName, modResults) {
  const config = plugin({ name: 'Hypergolic', slug: 'hypergolic' });
  return (await config.mods.ios[modName]({ ...config, modResults,
    modRequest: { platform: 'ios', modName } })).modResults;
}
const transform = async (contents = template, language = 'swift') =>
  (await apply('appDelegate', { contents, language })).contents;
const count = (source, needle) => source.split(needle).length - 1;

test('registered Expo plugin adds one real scene delegate and preserves other plist values', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  assert(config.expo.plugins.includes('./plugins/withSceneLifecycle.cjs'));
  const result = await apply('infoPlist', { NSFaceIDUsageDescription: 'Existing reason', CFBundleIdentifier: 'org.example.check' });
  assert.equal(result.NSFaceIDUsageDescription, 'Existing reason');
  assert.equal(result.CFBundleIdentifier, 'org.example.check');
  assert.deepEqual(result.UIApplicationSceneManifest, {
    UIApplicationSupportsMultipleScenes: false,
    UISceneConfigurations: { UIWindowSceneSessionRoleApplication: [{
      UISceneConfigurationName: 'Hypergolic',
      UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).HypergolicSceneDelegate',
    }] },
  });
  assert.deepEqual(await apply('infoPlist', result), result);
});
for (const existing of [{}, null, { UIApplicationSupportsMultipleScenes: true }]) {
  test(`conflicting scene manifest ${JSON.stringify(existing)} fails closed`, async () => {
    await assert.rejects(apply('infoPlist', { UIApplicationSceneManifest: existing }), /conflicts/);
  });
}
test('cold scene owns the window before the sole React start and reconnect reuses that runtime', async () => {
  const result = await transform();
  assert.equal(await transform(result), result);
  assert.equal(count(result, 'factory.startReactNative('), 1);
  assert.equal(count(result, 'let window = UIWindow(windowScene: scene)'), 1);
  assert.equal(count(result, 'class HypergolicSceneDelegate:'), 1);
  assert.doesNotMatch(result, /UIWindow\(frame:|UIScreen\.main|NotificationCenter|post\(name:/);
  const launch = result.slice(result.indexOf('public override func application('), result.indexOf('func ownsScene('));
  assert.match(launch, /sceneLaunchOptions = launchOptions/);
  assert.doesNotMatch(launch, /startReactNative|UIWindow\(/);
  const reconnect = result.slice(result.indexOf('if let window {'), result.indexOf('var launchOptions = sceneLaunchOptions'));
  assert.match(reconnect, /window.windowScene = scene/);
  assert.match(reconnect, /forwardSceneURLs\(options.urlContexts\)/);
  assert.match(reconnect, /continueSceneActivity\(activity\)/);
  assert.doesNotMatch(reconnect, /startReactNative|UIWindow\(/);
  assert.match(result, /connectedScene == nil \|\| connectedScene === scene/);
  assert.match(result, /scene.session.role == \.windowApplication/);
  assert(result.indexOf('self.window = window') < result.indexOf('factory.startReactNative('));
  assert.match(result, /window = appDelegate\?\.connectScene\(scene, options: connectionOptions\)/);
});
test('disconnect retires only the owned scene and permits a later session without a new runtime', async () => {
  const result = await transform();
  const disconnect = result.slice(result.indexOf('func disconnectScene('), result.indexOf('func forwardSceneURLs('));
  assert.match(result, /private weak var connectedScene: UIWindowScene\?/);
  assert.match(result, /scene.session.role == \.windowApplication && connectedScene === scene/);
  assert.match(disconnect, /guard ownsScene\(scene\) else \{ return \}/);
  assert(disconnect.indexOf('guard ownsScene') < disconnect.indexOf('connectedScene = nil'));
  assert.match(disconnect, /window\?\.windowScene = nil/);
  assert.doesNotMatch(disconnect, /self.window = nil|factory|startReactNative|NotificationCenter/);
  const delegate = result.slice(result.indexOf('func sceneDidDisconnect('), result.indexOf('// UIKit owns UIApplication notifications'));
  assert.match(delegate, /appDelegate.ownsScene\(scene\)/);
  assert.match(delegate, /appDelegate.disconnectScene\(scene\)/);
  assert.doesNotMatch(result, /persistentIdentifier|sceneSessionID/);
});
test('cold custom and universal URLs become initial RN options without a second warm delivery', async () => {
  const result = await transform();
  const cold = result.slice(result.indexOf('var launchOptions = sceneLaunchOptions'), result.indexOf('func forwardSceneURLs'));
  for (const text of ['launchOptions[.url] = context.url',
    'launchOptions[.sourceApplication] = context.options.sourceApplication',
    'launchOptions[.annotation] = context.options.annotation',
    'UIApplication.LaunchOptionsKey.userActivityType.rawValue: activity.activityType',
    '"UIApplicationLaunchOptionsUserActivityKey": activity', 'launchOptions[.userActivityDictionary]']) assert(cold.includes(text), text);
  assert(cold.indexOf('launchOptions[.url]') < cold.indexOf('factory.startReactNative'));
  assert(cold.indexOf('launchOptions[.userActivityDictionary]') < cold.indexOf('factory.startReactNative'));
  assert.doesNotMatch(cold, /forwardSceneURLs|continueSceneActivity|application\(UIApplication/);
  const warm = result.slice(result.indexOf('func forwardSceneURLs'), result.indexOf('// @generated end hypergolic-scene-connection'));
  for (const text of ['.openInPlace: context.options.openInPlace',
    'options[.sourceApplication] = context.options.sourceApplication', 'options[.annotation] = context.options.annotation',
    'application(UIApplication.shared, open: context.url, options: options)',
    'application(UIApplication.shared, continue: activity, restorationHandler: { _ in })']) assert(warm.includes(text), text);
  // The original Expo/RCT handlers remain the only link routing implementation.
  assert(result.includes('super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)'));
  assert(result.includes('RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)'));
});
test('each owned scene transition forwards Expo once while UIKit remains notification owner', async () => {
  const result = await transform();
  const delegate = result.slice(result.indexOf('class HypergolicSceneDelegate:'), result.indexOf('// @generated end hypergolic-scene-delegate'));
  for (const callback of ['DidBecomeActive', 'WillResignActive', 'DidEnterBackground', 'WillEnterForeground']) {
    assert.equal(count(delegate, `func scene${callback}(`), 1);
    assert.equal(count(delegate, `appDelegate.application${callback}(UIApplication.shared)`), 1);
  }
  assert.equal(count(delegate, 'appDelegate.ownsScene(scene)'), 7);
  assert.doesNotMatch(delegate, /NotificationCenter|post\(/);
});
for (const mutate of [source => source.replace('UIWindow(frame: UIScreen.main.bounds)', 'UIWindow()'),
  source => source.replace('  // Linking API', ''), source => source + '\n' + 'class HypergolicSceneDelegate {}']) {
  test('unreviewed AppDelegate templates fail closed', async () => {
    await assert.rejects(transform(mutate(template)), /template changed|conflicts/);
  });
}
test('unsupported language, edited generated blocks and extra React startups fail closed', async () => {
  await assert.rejects(transform(template, 'objc'), /reviewed Swift/);
  const result = await transform();
  await assert.rejects(transform(result.replace('window.windowScene = scene', 'window.windowScene = nil')), /integration changed/);
  await assert.rejects(transform(result + '\nfactory.startReactNative('), /one React runtime/);
});
