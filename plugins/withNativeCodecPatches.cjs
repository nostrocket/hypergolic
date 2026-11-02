const { withPodfile } = require('expo/config-plugins');
const { wrapperCommit } = require('./native-codec-patches.json');

module.exports = function withNativeCodecPatches(config) {
  return withPodfile(config, (result) => {
    const marker = "    require_relative '../plugins/native-codec-patches'";
    const applyLine = '    HypergolicNativeCodecPatches.apply(installer.sandbox.root.to_s)';
    const hook = '  post_install do |installer|';
    let source = result.modResults.contents;
    const nativeModules = '  use_expo_modules!';
    const pin = `  pod 'libdav1d', :git => 'https://github.com/SDWebImage/libdav1d-Xcode.git', :commit => '${wrapperCommit}', :submodules => true`;
    if (source.includes("pod 'libdav1d'") && !source.includes(pin)) throw new Error('Native codec source pin changed; review before rebuilding.');
    if (!source.includes(pin)) {
      if (source.split(nativeModules).length !== 2) throw new Error('Expo Podfile template changed; review the native codec pin.');
      source = source.replace(nativeModules, `${pin}\n${nativeModules}`);
    }
    if (source.includes(marker) || source.includes(applyLine)) {
      if (source.split(marker).length !== 2 || source.split(applyLine).length !== 2 ||
          source.split(hook).length !== 2 || !source.includes(`${hook}\n${marker}\n${applyLine}`)) {
        throw new Error('Native codec patch hook changed; review before rebuilding.');
      }
      result.modResults.contents = source;
      return result;
    }
    if (source.split(hook).length !== 2) {
      throw new Error('CocoaPods post-install template changed; review codec patch integration.');
    }
    result.modResults.contents = source.replace(hook, `${hook}\n${marker}\n${applyLine}`);
    return result;
  });
};
