import { defineConfig, loadEnv } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig(({ mode }) => {
  if (loadEnv(mode, '.', 'VITE_DEV_PRIVKEY_HEX').VITE_DEV_PRIVKEY_HEX) {
    throw new Error('Approval Lab builds must be unsigned. Remove the development signing environment variable.');
  }
  return {
    plugins: [nip5aManifest({
      nappletType: 'approval-lab',
      title: 'Approval Lab',
      description: 'Explicit note, profile and relay-list approval test fixture.',
      artifactMode: 'single-file',
      requires: { infer: false, explicit: ['identity', 'relay'] },
    })],
    build: { outDir: 'dist', target: 'es2022', sourcemap: false, modulePreload: false },
  };
});
