import Constants from 'expo-constants';
import { Platform } from 'react-native';

const config = Constants.expoConfig;
// Missing or unfamiliar build metadata never enables internal tooling.
export const developerToolsEnabled = config?.extra?.hypergolic?.variant === 'development';
export const buildInfo = Object.freeze({
  version: config?.version ?? 'Unknown',
  build: Platform.OS === 'android' ? String(config?.android?.versionCode ?? 'Unknown') : config?.ios?.buildNumber ?? 'Development',
  development: developerToolsEnabled,
});
