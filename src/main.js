import * as THREE from 'three';
import { DiveCamera } from './camera.js';
// スタイルは index.html の <link> で読み込む(ビルドなし配信と両立させるため)

import { U } from './env.js';
import { createBackground, createLights } from './environment/background.js';
import { setTerrain } from './environment/seabed.js';
import { GREAT_TANK } from './zones/greatTank.js';
import { DOLPHIN_POOL } from './zones/dolphinPool.js';

import { setupUI } from './ui.js';
import { UnderwaterAudio } from './audio.js';

// ================= 基盤 =================
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 500);
scene.fog = new THREE.FogExp2(U.uFogColor.value.clone(), U.uFogDensity.value);

// ダイバー視点の自由カメラ(見回す/平行移動/前後進/上下が全て独立)
const diveCam = new DiveCamera(camera, canvas);

// 背景ドームとライトは全ゾーン共通(色はゾーンのユニフォームで変わる)
createBackground(scene);
const lights = createLights(scene);

const audio = new UnderwaterAudio();

// ================= ゾーン =================
// 各ゾーンは初回訪問時に構築し、以降は表示の切り替えだけで往復する。
const ZONES = [GREAT_TANK, DOLPHIN_POOL];
const built = new Map();
let active = null;

function buildZone(def) {
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);
  // 生物の配置は地形に依存するので、構築前に地形を差し替えておく
  setTerrain(def.terrain);
  const inst = def.build(root, audio);
  built.set(def.key, { def, root, ...inst });
  return built.get(def.key);
}

function enterZone(key, { moveCamera = true } = {}) {
  const zone = built.get(key) || buildZone(ZONES.find((z) => z.key === key));
  if (active === zone) return;
  if (active) active.root.visible = false;
  active = zone;
  active.root.visible = true;

  // 地形・水の色・光をゾーンのものへ
  setTerrain(zone.def.terrain);
  const e = zone.def.env;
  U.uFogColor.value.copy(e.fogColor);
  U.uFogDensity.value = e.fogDensity;
  U.uAmbTop.value.copy(e.ambTop);
  U.uAmbBottom.value.copy(e.ambBottom);
  U.uSunDir.value.copy(e.sunDir);
  scene.fog.color.copy(e.fogColor);
  scene.fog.density = e.fogDensity;
  renderer.toneMappingExposure = e.exposure;
  lights.sun.position.copy(e.sunDir).multiplyScalar(60);

  diveCam.world = zone.world;
  diveCam.clearFollow();
  if (moveCamera) {
    diveCam.pos.copy(zone.def.camera.pos);
    diveCam.vel.set(0, 0, 0);
    diveCam.glide.set(0, 0, 0);
    diveCam.lookAt(zone.def.camera.look);
  }
  ui.setZone(zone.def);
}

// ================= UI =================
const ui = setupUI({
  zones: ZONES,
  onFollow: (key) => {
    const t = active.followTargets[key];
    if (t) diveCam.setFollow(t.get, t.dist[0], t.dist[1]);
  },
  onFree: () => diveCam.clearFollow(),
  onZone: (key) => enterZone(key),
  audio,
});

enterZone(GREAT_TANK.key);

// ================= タップ =================
let downPos = null;
let downTime = 0;
canvas.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  downTime = performance.now();
});
const _raycaster = new THREE.Raycaster();
const _hitPoint = new THREE.Vector3();

canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  const held = performance.now() - downTime;
  downPos = null;
  // タップ判定はゆるめに(指はわずかにぶれるし、ゆっくり離すこともある)
  if (e.button > 0 || moved > 12 || held > 600) return;

  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  _raycaster.setFromCamera(ndc, camera);
  if (active && active.onTap) active.onTap(_raycaster.ray, _hitPoint);
});

// ================= リサイズ =================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ================= PWA: Service Worker =================
// ネットワーク優先のSW。ここでは登録と「開き直し・復帰のたびの更新チェック」、
// 新版が有効化されたときの自動リロードを行う。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // updateViaCache:'none' で sw.js 自体もHTTPキャッシュを介さず毎回確認
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check(); // タブ復帰のたびに更新確認
      });
      // 新しいSWが制御を握ったら一度だけリロードして最新版へ
      let hadController = !!navigator.serviceWorker.controller;
      let refreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) { hadController = true; return; } // 初回インストールは除外
        if (refreshed) return;
        refreshed = true;
        window.location.reload();
      });
    } catch (e) {
      // SW非対応・登録失敗でもアプリはそのまま動く
    }
  });
}

// ================= メインループ =================
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  U.uTime.value = clock.elapsedTime;
  lights.sun.intensity = 1.6 * U.uSunI.value;
  lights.hemi.intensity = 0.9 * (0.6 + 0.4 * U.uSunI.value);

  active.update(dt, camera);
  diveCam.update(dt);
  // 頭が水面から出ると、こもった水中音から水面のさざめきへ入れ替わる
  audio.setAbove(THREE.MathUtils.smoothstep(camera.position.y, U.uSurfaceY.value - 0.2, U.uSurfaceY.value + 0.8));

  renderer.render(scene, camera);
  ui.tickFPS(dt);
}

animate();
