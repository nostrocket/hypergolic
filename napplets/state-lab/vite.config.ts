import { defineConfig, loadEnv } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig(({ mode }) => {
  if (loadEnv(mode, '.', 'VITE_DEV_PRIVKEY_HEX').VITE_DEV_PRIVKEY_HEX) {
    throw new Error('State Lab builds must be unsigned. Remove the development signing environment variable.');
  }
  const peer = mode === 'peer';
  return {
    define: { __LAB_TITLE__: JSON.stringify(peer ? 'State Lab Peer' : 'State Lab') },
    plugins: [nip5aManifest({
      nappletType: peer ? 'state-lab-peer' : 'state-lab',
      title: peer ? 'State Lab Peer' : 'State Lab',
      description: 'Public identity and saved-string test fixture.',
      artifactMode: 'single-file',
      requires: { infer: false, explicit: ['identity', 'storage'] },
    })],
    build: { outDir: peer ? 'dist-peer' : 'dist', target: 'es2022', sourcemap: false, modulePreload: false },
  };
});
