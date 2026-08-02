import * as THREE from 'three';
import { DiveCamera } from './camera.js';
// スタイルは index.html の <link> で読み込む(ビルドなし配信と両立させるため)

import { U } from './env.js';
import { createBackground, createLights, setupFog } from './environment/background.js';
import { createWaterSurface } from './environment/surface.js';
import { createSand, createRocks, sandHeight } from './environment/seabed.js';
import { createKelp, createAnemone, KELP_CLUSTERS } from './environment/flora.js';
import { CollisionWorld } from './collision.js';
import { disturbPoint, raySandHit } from './interaction.js';
import { createGodRays, createBubbles, createMarineSnow } from './environment/effects.js';

import { FISH_SHAPES } from './creatures/fishGeometry.js';
import { createFishMaterial } from './creatures/fishMaterial.js';
import { School, makeSchoolInstanceAttr } from './creatures/school.js';
import { Wanderer } from './creatures/wanderer.js';
import { EagleRay } from './creatures/ray.js';
import { SeaTurtle } from './creatures/turtle.js';
import { JellyfishSwarm } from './creatures/jellyfish.js';
import { GardenEelColony } from './creatures/gardenEel.js';
import { WhaleShark, HumpbackWhale } from './creatures/giants.js';

import { setupUI } from './ui.js';
import { UnderwaterAudio } from './audio.js';

// ================= 基盤 =================
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 7.5, 24);

// ダイバー視点の自由カメラ(見回す/平行移動/前後進/上下が全て独立)
const diveCam = new DiveCamera(camera, canvas);
diveCam.lookAt(new THREE.Vector3(0, 7, 0));

// ================= 環境 =================
setupFog(scene);
createBackground(scene);
const lights = createLights(scene);
createWaterSurface(scene);
createSand(scene);
const rocks = createRocks(scene);
createKelp(scene);
const anemonePos = new THREE.Vector3(12.5, 0, -12.5);
createAnemone(scene, anemonePos);

// ================= 衝突ワールド =================
// 岩とイソギンチャクは実体のある障害物、海藻はしなるので
// 「避けるが押し戻さない」やわらかい障害物として登録する。
const world = new CollisionWorld();
for (const c of rocks.colliders) world.addStatic(c.center, c.rx, c.ry, c.rz);
for (const k of KELP_CLUSTERS) {
  const base = sandHeight(k.x, k.z);
  world.addStatic(new THREE.Vector3(k.x, base + 3.6, k.z), k.r + 0.6, 4.2, k.r + 0.6, { soft: true });
}
world.addStatic(
  new THREE.Vector3(anemonePos.x, sandHeight(anemonePos.x, anemonePos.z) + 0.7, anemonePos.z),
  1.9, 1.4, 1.9
);
diveCam.world = world;
const godRays = createGodRays(scene);
createBubbles(scene, [
  { x: -13.5, y: sandHeight(-13.5, -7) + 0.5, z: -7, count: 170, radius: 0.9 },
  { x: 14.5, y: sandHeight(14.5, -11) + 0.4, z: -11, count: 110, radius: 0.6 },
]);
createMarineSnow(scene);

// ================= 生物 =================

// --- マイワシの群れ(ボイド) ---
const sardineGeo = FISH_SHAPES.sardine();
sardineGeo.scale(0.55, 0.55, 0.55);
const sardineMat = createFishMaterial({
  pattern: 0,
  len: 0.55,
  swim: { freq: 11, amp: 0.09, waveNum: 1.1, headAmp: 0.12, flapFreq: 6 },
});
const SARDINE_N = 180;
const sardineMesh = new THREE.InstancedMesh(sardineGeo, sardineMat, SARDINE_N);
sardineMesh.frustumCulled = false;
makeSchoolInstanceAttr(sardineGeo, SARDINE_N, [0.8, 1.15]);
scene.add(sardineMesh);
const sardines = new School({
  mesh: sardineMesh,
  count: SARDINE_N,
  center: new THREE.Vector3(0, 9.5, 0),
  homeRadius: 19,
  seed: 1,
  params: { maxSpeed: 6.0, minSpeed: 2.4, perception: 2.4, bodyRadius: 0.22, avoidRange: 1.2 },
});

// --- ナンヨウハギの小さな群れ ---
const tangGeo = FISH_SHAPES.tang();
tangGeo.scale(0.72, 0.72, 0.72);
const tangMat = createFishMaterial({
  pattern: 2,
  len: 0.72,
  swim: { freq: 4.5, amp: 0.035, waveNum: 0.55, headAmp: 0.06, flapFreq: 7.5 },
});
const TANG_N = 7;
const tangMesh = new THREE.InstancedMesh(tangGeo, tangMat, TANG_N);
tangMesh.frustumCulled = false;
makeSchoolInstanceAttr(tangGeo, TANG_N, [0.85, 1.1]);
scene.add(tangMesh);
const tangs = new School({
  mesh: tangMesh,
  count: TANG_N,
  center: new THREE.Vector3(10, 5, -10),
  homeRadius: 9,
  seed: 5,
  params: {
    maxSpeed: 2.6, minSpeed: 0.9, perception: 3.0,
    wCoh: 0.5, wAli: 0.6, maxForce: 8, yMin: 1.8, yMax: 9, burstSpeed: 6,
    bodyRadius: 0.30, avoidRange: 1.3,
  },
});

// --- カクレクマノミのペア(イソギンチャクに定住) ---
const clownGeo = FISH_SHAPES.clownfish();
clownGeo.scale(0.42, 0.42, 0.42);
const clownMat = createFishMaterial({
  pattern: 1,
  len: 0.42,
  swim: { freq: 10, amp: 0.09, waveNum: 0.7, headAmp: 0.3, flapFreq: 9 },
});
const clownMesh = new THREE.InstancedMesh(clownGeo, clownMat, 2);
clownMesh.frustumCulled = false;
makeSchoolInstanceAttr(clownGeo, 2, [0.8, 1.05]);
scene.add(clownMesh);
const clowns = new Wanderer({
  mesh: clownMesh,
  count: 2,
  home: anemonePos.clone().add(new THREE.Vector3(0, sandHeight(anemonePos.x, anemonePos.z) + 1.4, 0)),
  radius: 2.6,
  speed: [0.5, 2.0],
  retarget: [0.8, 2.4],
});

// --- 大型遊泳者たち ---
const ray = new EagleRay(scene);
const turtle = new SeaTurtle(scene);
const whaleShark = new WhaleShark(scene);
const whale = new HumpbackWhale(scene);
const jellies = new JellyfishSwarm(scene, 6);
const eels = new GardenEelColony(scene, {
  center: new THREE.Vector3(4, 0, 13),
  radius: 6.5,
  count: 14,
});

// 大型生物同士もぶつからないよう、動く障害物として登録する
world.addDynamic(whaleShark, 1.5, 1.5, 4.6);
world.addDynamic(whale, 1.9, 1.9, 5.8);
world.addDynamic(ray, 2.6, 0.9, 2.2);
world.addDynamic(turtle, 1.7, 0.9, 1.8);
for (const c of [whaleShark, whale, ray, turtle, jellies]) c.setWorld(world);

// ================= UI・カメラ追跡 =================
const audio = new UnderwaterAudio();

// クジラの息継ぎで鳴き声(環境音ON時のみ)
whale.onBlow = () => audio.whaleCall();

// 追跡対象と、生物の大きさに応じた追跡距離 [近, 遠]
const followTargets = {
  whaleshark: { get: () => whaleShark.pos, dist: [10, 24] },
  whale: { get: () => whale.pos, dist: [11, 26] },
  sardine: { get: () => sardines.schoolCenter, dist: [6, 16] },
  tang: { get: () => tangs.schoolCenter, dist: [4, 10] },
  clownfish: { get: () => clowns.center, dist: [2.5, 7] },
  ray: { get: () => ray.pos, dist: [5, 14] },
  turtle: { get: () => turtle.pos, dist: [5, 13] },
  jelly: { get: () => jellies.center, dist: [4, 11] },
  eel: { get: () => new THREE.Vector3(4, sandHeight(4, 13) + 2.2, 13), dist: [4, 11] },
};

const ui = setupUI({
  onFollow: (key) => {
    const t = followTargets[key];
    if (t) diveCam.setFollow(t.get, t.dist[0], t.dist[1]);
  },
  onFree: () => diveCam.clearFollow(),
  audio,
});

// ================= クリックで驚かせる =================
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
  const ray = _raycaster.ray;

  if (disturbPoint(ray, sardines, 4.5, _hitPoint)) sardines.scare(_hitPoint, 11, 80);
  if (disturbPoint(ray, tangs, 3.0, _hitPoint)) tangs.scare(_hitPoint, 6, 34);
  // チンアナゴは砂底にいるので、視線が砂に当たった場所で驚かせる
  if (raySandHit(ray, _hitPoint)) eels.scare(_hitPoint, 9);
});

// ================= リサイズ =================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ================= メインループ =================
const clock = new THREE.Clock();

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

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  U.uTime.value = t;
  lights.sun.intensity = 1.6 * U.uSunI.value;
  lights.hemi.intensity = 0.9 * (0.6 + 0.4 * U.uSunI.value);

  // --- 生物の更新 ---
  const predators = [
    { pos: ray.pos, radius: 4.5 },
    { pos: turtle.pos, radius: 4.0 },
    { pos: whaleShark.pos, radius: 6.5 },
    { pos: whale.pos, radius: 7.5 },
  ];
  sardines.update(dt, predators, world);
  tangs.update(dt, predators, world);
  clowns.update(dt);
  ray.update(dt);
  turtle.update(dt);
  whaleShark.update(dt);
  whale.update(dt);
  jellies.update(dt);
  eels.update(dt, [
    { pos: ray.pos, radius: 8 },
    { pos: turtle.pos, radius: 7 },
    { pos: whaleShark.pos, radius: 11 },
    { pos: whale.pos, radius: 11 },
    { pos: camera.position, radius: 6 },
  ]);

  // --- カメラ(境界クランプ・追跡補正は DiveCamera 内) ---
  diveCam.update(dt);

  godRays.update(camera);

  renderer.render(scene, camera);
  ui.tickFPS(dt);
}

animate();
