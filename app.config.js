const release = require('./config/android-release.json');

module.exports = ({ config }) => {
  const variant = process.env.HYPERGOLIC_VARIANT ?? 'production';
  if (!['development', 'production'].includes(variant)) {
    throw new Error('HYPERGOLIC_VARIANT must be development or production.');
  }
  return {
    ...config,
    android: { ...config.android, package: variant === 'production' ? release.applicationId : config.android.package },
    ios: {
      ...config.ios,
      bundleIdentifier: variant === 'production' ? release.applicationId : config.ios.bundleIdentifier,
      buildNumber: String(config.android.versionCode),
    },
    extra: { ...config.extra, hypergolic: { variant } },
  };
};
