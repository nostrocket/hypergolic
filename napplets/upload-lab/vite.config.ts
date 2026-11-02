import { defineConfig, loadEnv } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
export default defineConfig(({ mode }) => {
  if (loadEnv(mode, '.', 'VITE_DEV_PRIVKEY_HEX').VITE_DEV_PRIVKEY_HEX) throw new Error('Upload Lab fixture builds must be unsigned.');
  return { plugins: [nip5aManifest({ nappletType: 'upload-lab', title: 'Upload Lab',
    description: 'Per-file upload review and exact-byte fixture.', artifactMode: 'single-file',
    requires: { infer: false, explicit: ['upload'] } })],
    build: { outDir: 'dist', minify: false, target: 'es2022', sourcemap: false, modulePreload: false } };
});
