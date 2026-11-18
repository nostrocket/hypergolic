const { withDangerousMod, withAndroidStyles, AndroidConfig, IOSConfig } = require('expo/config-plugins');
const { copyFile, mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const sky = require('../assets/shell/launch-sky.json');

async function writeResource(root, relative, contents) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function androidLaunch(config) {
  config = withAndroidStyles(config, result => {
    // MainActivity switches to AppTheme before React has drawn its first frame.
    result.modResults = AndroidConfig.Styles.assignStylesValue(result.modResults, {
      add: true, parent: AndroidConfig.Styles.getAppThemeGroup(), name: 'android:windowBackground', value: '@color/launch_sky',
    });
    const theme = result.modResults.resources.style.find(style => style.$.name === 'Theme.App.SplashScreen');
    if (!theme) throw new Error('Android launch theme is missing.');
    theme.item = [
      ['android:windowBackground', '@drawable/hypergolic_launch'],
      ['android:windowSplashScreenBackground', '@color/launch_sky'],
      ['android:windowSplashScreenAnimatedIcon', '@mipmap/ic_launcher_foreground'],
    ].map(([name, value]) => ({ $: { name }, _: value }));
    return result;
  });
  return withDangerousMod(config, ['android', async result => {
    const res = path.join(result.modRequest.platformProjectRoot, 'app/src/main/res');
    for (const [folder, color] of [['values', sky.morning], ['values-night', sky.night]]) {
      await writeResource(res, folder + '/launch_sky.xml', '<resources><color name="launch_sky">' + color + '</color></resources>\n');
    }
    await writeResource(res, 'drawable/hypergolic_launch.xml', `<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
  <item android:drawable="@color/launch_sky"/>
  <item><bitmap android:src="@mipmap/ic_launcher_foreground" android:gravity="center"/></item>
</layer-list>\n`);
    return result;
  }]);
}

function appleColor(hex) {
  const [red, green, blue] = hex.slice(1).match(/../g).map(value => '0x' + value);
  return { 'color-space': 'srgb', components: { red, green, blue, alpha: '1.000' } };
}

module.exports = config => withDangerousMod(androidLaunch(config), ['ios', async result => {
  const root = IOSConfig.Paths.getSourceRoot(result.modRequest.projectRoot);
  const catalog = path.join(root, 'Images.xcassets');
  const info = { author: 'xcode', version: 1 };
  const colors = [
    { idiom: 'universal', color: appleColor(sky.morning) },
    { idiom: 'universal', appearances: [{ appearance: 'luminosity', value: 'dark' }], color: appleColor(sky.night) },
  ];
  await writeResource(catalog, 'LaunchSky.colorset/Contents.json', JSON.stringify({ info, colors }));
  const images = [{ idiom: 'universal', filename: 'mark.png' }];
  await writeResource(catalog, 'LaunchMark.imageset/Contents.json', JSON.stringify({ info, images }));
  await copyFile(path.join(result.modRequest.projectRoot, 'assets/brand/hypergolic-logo.png'), path.join(catalog, 'LaunchMark.imageset/mark.png'));
  const storyboard = path.join(root, 'SplashScreen.storyboard');
  const source = await readFile(storyboard, 'utf8');
  if (source.includes('image="LaunchMark"')) return result;
  if (!source.includes('image="SplashScreen"') || !source.includes('key="backgroundColor" systemColor="systemBackgroundColor"')) {
    throw new Error('Review the updated Expo launch storyboard.');
  }
  await writeFile(storyboard, source.replace('image="SplashScreen"', 'image="LaunchMark"')
    .replace('<accessibility key="accessibilityConfiguration">', `<constraints>
      <constraint firstAttribute="width" constant="96" id="LaunchMark-width"/>
      <constraint firstAttribute="height" constant="96" id="LaunchMark-height"/>
    </constraints><accessibility key="accessibilityConfiguration">`)
    .replace('key="backgroundColor" systemColor="systemBackgroundColor"', 'key="backgroundColor" name="LaunchSky"')
    .replace('name="SplashScreenLogo"', 'name="LaunchMark"')
    .replaceAll('systemColor name="systemBackgroundColor"', 'namedColor name="LaunchSky"').replace('</systemColor>', '</namedColor>'));
  return result;
}]);
