// ============ Service Worker ============
// 方針: ネットワーク優先。開くたびに必ず最新を取りに行き、
// 取得できたものでキャッシュを更新する。オフライン時のみキャッシュで応答。
// ハッシュ付きビルド資産(/assets/)だけは不変なのでキャッシュ優先。

const VERSION = 'v1';
const CACHE = `grand-aquarium-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(['./', './manifest.webmanifest']).catch(() => {}))
      .then(() => self.skipWaiting()) // 待機せず即座に新版へ
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 旧バージョンのキャッシュを掃除
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部リソースは素通し

  // 動画は Range リクエストで飛んでくる。206 Partial Content は Cache API に
  // 入れられず cache.put が例外を投げるため、SWを通さずブラウザに任せる。
  if (req.headers.has('range') || url.pathname.endsWith('.mp4')) return;

  // ハッシュ付きの不変資産はキャッシュ優先(内容が変わればファイル名が変わる)
  const immutable = url.pathname.includes('/assets/');

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);

    if (immutable) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    }

    // ---- ネットワーク優先: 常に最新を見に行く ----
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      // オフライン時のみキャッシュへフォールバック
      const hit = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await cache.match('./');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
