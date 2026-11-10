const release = require('./config/android-release.json');

module.exports = ({ config }) => {
  const variant = process.env.HYPERGOLIC_VARIANT ?? 'development';
  if (!['development', 'production'].includes(variant)) {
    throw new Error('HYPERGOLIC_VARIANT must be development or production.');
  }
  return {
    ...config,
    android: { ...config.android, package: variant === 'production' ? release.applicationId : config.android.package },
    extra: { ...config.extra, hypergolic: { variant } },
  };
};
