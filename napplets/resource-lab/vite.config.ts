import { defineConfig, loadEnv } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
export default defineConfig(({ mode }) => {
  if (loadEnv(mode, '.', 'VITE_DEV_PRIVKEY_HEX').VITE_DEV_PRIVKEY_HEX) throw new Error('Resource Lab fixture builds must be unsigned.');
  return { plugins: [nip5aManifest({ nappletType: 'resource-lab', title: 'Resource Lab',
    description: 'Bounded complete resource byte and playback fixture.', artifactMode: 'single-file',
    requires: { infer: false, explicit: ['resource', 'link'] } })],
    build: { outDir: 'dist', minify: false, target: 'es2022', sourcemap: false, modulePreload: false } };
});
