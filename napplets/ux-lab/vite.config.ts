import { defineConfig, loadEnv } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig(({ mode }) => {
  if (loadEnv(mode, '.', 'VITE_DEV_PRIVKEY_HEX').VITE_DEV_PRIVKEY_HEX) {
    throw new Error('UX Lab builds must be unsigned. Remove the development signing environment variable.');
  }
  return {
    plugins: [nip5aManifest({
      nappletType: 'ux-lab',
      title: 'UX Lab',
      description: 'Temporary input, scrolling and lifecycle test fixture.',
      artifactMode: 'single-file',
      requires: { infer: false, explicit: [] },
    })],
    build: { target: 'es2022', sourcemap: false, modulePreload: false },
  };
});
