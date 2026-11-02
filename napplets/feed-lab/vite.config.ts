import { defineConfig, loadEnv } from 'vite';
import { nip5aManifest } from '@napplet/vite-plugin';
export default defineConfig(({ mode }) => {
  if (loadEnv(mode, '.', 'VITE_DEV_PRIVKEY_HEX').VITE_DEV_PRIVKEY_HEX) throw new Error('Feed Lab fixture builds must be unsigned.');
  return { plugins: [nip5aManifest({ nappletType: 'feed-lab', title: 'Feed Lab',
    description: 'Bounded historical relay query test fixture.', artifactMode: 'single-file',
    requires: { infer: false, explicit: ['identity', 'outbox', 'relay'] } })],
    build: { outDir: 'dist', target: 'es2022', sourcemap: false, modulePreload: false } };
});
