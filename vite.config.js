import { defineConfig } from 'vite';
import { cpSync } from 'fs';

// PWA関連ファイルはリポジトリ直下に置く(ビルドなしのブランチ直配信でも
// ./sw.js 等で解決できるようにするため)。ビルド時は dist/ へコピーする。
const copyPwaFiles = {
  name: 'copy-pwa-files',
  closeBundle() {
    cpSync('sw.js', 'dist/sw.js');
    cpSync('manifest.webmanifest', 'dist/manifest.webmanifest');
    cpSync('404.html', 'dist/404.html');
    cpSync('icons', 'dist/icons', { recursive: true });
  },
};

export default defineConfig({
  base: './',
  plugins: [copyPwaFiles],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
});
