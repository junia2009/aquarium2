import { defineConfig } from 'vite';
import { cpSync, readFileSync, writeFileSync } from 'fs';

// PWA関連ファイルはリポジトリ直下に置く(ビルドなしのブランチ直配信でも
// ./sw.js 等で解決できるようにするため)。ビルド時は dist/ へコピーする。
const pwaFiles = {
  name: 'pwa-files',

  closeBundle() {
    cpSync('sw.js', 'dist/sw.js');
    cpSync('manifest.webmanifest', 'dist/manifest.webmanifest');
    cpSync('404.html', 'dist/404.html');
    cpSync('icons', 'dist/icons', { recursive: true });
    cpSync('media', 'dist/media', { recursive: true });   // 遊び方の動画

    // Vite はマニフェストとアイコンをハッシュ付きで assets/ へ移してしまうが、
    // マニフェスト内の icons・start_url・scope は「マニフェスト自身の位置」からの
    // 相対解決なので、assets/ に置かれると全て壊れる
    // (アイコンが 404 になり、start_url が /assets/ を指してしまう)。
    // 書き出し済みの index.html を、ルートへコピーした実体を指すよう直す。
    const p = 'dist/index.html';
    const html = readFileSync(p, 'utf8')
      .replace(/(?:\.\/)?assets\/manifest-[\w-]+\.webmanifest/g, './manifest.webmanifest')
      .replace(/(?:\.\/)?assets\/apple-touch-icon-[\w-]+\.png/g, './icons/apple-touch-icon.png')
      .replace(/(?:\.\/)?assets\/icon-192-[\w-]+\.png/g, './icons/icon-192.png');
    writeFileSync(p, html);
  },
};

export default defineConfig({
  base: './',
  plugins: [pwaFiles],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
});
