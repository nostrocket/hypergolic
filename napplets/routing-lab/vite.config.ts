import {defineConfig,loadEnv} from 'vite';
import {nip5aManifest} from '@napplet/vite-plugin';
export default defineConfig(({mode}) => {
  if (loadEnv(mode, '.', 'VITE_DEV_PRIVKEY_HEX').VITE_DEV_PRIVKEY_HEX) throw new Error('Routing Lab builds must be unsigned.');
  return {plugins: [nip5aManifest({nappletType: 'routing-lab', title: 'Routing Lab', description: 'Intent and cross-view communication contract fixture.', artifactMode: 'single-file', requires: {infer: false, explicit: ['intent', 'inc', 'notify', 'config']}})], build: {outDir: 'dist', target: 'es2022', sourcemap: false, modulePreload: false}};
});
