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


  // ハッシュ付きの不変資産はキャッシュ優先(内容が変わればファイル名が変わる)
  const immutable = url.pathname.includes('/assets/');
  const isMedia = /\.(mp4|webm)$/.test(url.pathname);

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isMedia) return media(req, cache);

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
      // 206 は Cache API に入れられないので 200 だけ保存する
      if (res && res.ok && res.status === 200) cache.put(req, res.clone());
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

// ============ 動画 ============
// <video> は Range リクエストで飛んでくるが、206 Partial Content は
// Cache API に入れられない(cache.put が例外を投げる)。
// そこで「全体を一度だけ取ってキャッシュし、Range は自前で切り出して返す」。
// これで圏外でも、一度でも再生した動画はそのまま見られる。
// 逆に一度も開いていなければ入っていない(勝手に数MBを落とさないため)。
async function media(req, cache) {
  const base = new Request(new URL(req.url).toString());   // Rangeヘッダを外した素の要求
  let full = await cache.match(base);
  if (!full) {
    try {
      const res = await fetch(base);
      if (!res || !res.ok || res.status !== 200) return res;
      await cache.put(base, res.clone());
      full = res;
    } catch (err) {
      return new Response(null, { status: 504, statusText: 'offline' });
    }
  }

  const range = req.headers.get('range');
  if (!range) return full;

  const buf = await full.arrayBuffer();
  const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Math.min(Number(m[2]), buf.byteLength - 1) : buf.byteLength - 1;
  if (start >= buf.byteLength) {
    return new Response(null, { status: 416,
      headers: { 'Content-Range': `bytes */${buf.byteLength}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': full.headers.get('content-type') || 'video/mp4',
      'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}
