const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = function withUnsignedRelease(config) {
  return withAppBuildGradle(config, (result) => {
    const source = result.modResults.contents;
    const releaseSigning = /(release\s*\{[\s\S]*?)signingConfig signingConfigs\.debug/;
    if (releaseSigning.test(source)) {
      result.modResults.contents = source.replace(releaseSigning, '$1signingConfig null');
    } else if (!/release\s*\{[\s\S]*?signingConfig null/.test(source)) {
      throw new Error('Android release signing template changed; review before building.');
    }
    return result;
  });
};
