import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import './style.css';

import { U, WORLD } from './env.js';
import { createBackground, createLights, setupFog } from './environment/background.js';
import { createWaterSurface } from './environment/surface.js';
import { createSand, createRocks, sandHeight } from './environment/seabed.js';
import { createKelp, createAnemone } from './environment/flora.js';
import { createGodRays, createBubbles, createMarineSnow } from './environment/effects.js';

import { FISH_SHAPES } from './creatures/fishGeometry.js';
import { createFishMaterial } from './creatures/fishMaterial.js';
import { School, makeSchoolInstanceAttr } from './creatures/school.js';
import { Wanderer } from './creatures/wanderer.js';
import { EagleRay } from './creatures/ray.js';
import { SeaTurtle } from './creatures/turtle.js';
import { JellyfishSwarm } from './creatures/jellyfish.js';
import { GardenEelColony } from './creatures/gardenEel.js';

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

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 7, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 5;
controls.maxDistance = 36;
controls.minPolarAngle = 0.12;
controls.maxPolarAngle = Math.PI * 0.72;
controls.rotateSpeed = 0.55;

// ================= 環境 =================
setupFog(scene);
createBackground(scene);
const lights = createLights(scene);
createWaterSurface(scene);
createSand(scene);
createRocks(scene);
createKelp(scene);
const anemonePos = new THREE.Vector3(12.5, 0, -12.5);
createAnemone(scene, anemonePos);
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
  params: { maxSpeed: 6.0, minSpeed: 2.4, perception: 2.4 },
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
const jellies = new JellyfishSwarm(scene, 6);
const eels = new GardenEelColony(scene, {
  center: new THREE.Vector3(4, 0, 13),
  radius: 6.5,
  count: 14,
});

// ================= UI・カメラ追跡 =================
const audio = new UnderwaterAudio();

const followTargets = {
  sardine: () => sardines.schoolCenter,
  tang: () => tangs.schoolCenter,
  clownfish: () => clowns.center,
  ray: () => ray.pos,
  turtle: () => turtle.pos,
  jelly: () => jellies.center,
  eel: () => new THREE.Vector3(4, sandHeight(4, 13) + 2.2, 13),
};
let followKey = null;

const ui = setupUI({
  onFollow: (key) => { followKey = key; },
  onFree: () => { followKey = null; },
  audio,
});

// ================= クリックで驚かせる =================
let downPos = null;
let downTime = 0;
canvas.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  downTime = performance.now();
});
canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  const held = performance.now() - downTime;
  downPos = null;
  if (moved > 6 || held > 350) return; // ドラッグは無視

  // クリック方向の水中の一点に「音圧」を発生させる
  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const dist = Math.min(camera.position.distanceTo(controls.target), 20);
  const point = raycaster.ray.origin.clone().addScaledVector(raycaster.ray.direction, dist);

  sardines.scare(point, 10, 70);
  tangs.scare(point, 6, 30);
  eels.scare(point, 9);
});

// ================= リサイズ =================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ================= メインループ =================
const clock = new THREE.Clock();
const _delta = new THREE.Vector3();

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
  ];
  sardines.update(dt, predators);
  tangs.update(dt, predators);
  clowns.update(dt);
  ray.update(dt);
  turtle.update(dt);
  jellies.update(dt);
  eels.update(dt, [
    { pos: ray.pos, radius: 8 },
    { pos: turtle.pos, radius: 7 },
    { pos: camera.position, radius: 6 },
  ]);

  // --- カメラ追跡 ---
  if (followKey && followTargets[followKey]) {
    const target = followTargets[followKey]();
    _delta.copy(target).sub(controls.target);
    const s = 1 - Math.exp(-2.2 * dt);
    controls.target.addScaledVector(_delta, s);
    camera.position.addScaledVector(_delta, s);
  }

  controls.update();

  // カメラを水中に保つ
  const floorLimit = sandHeight(camera.position.x, camera.position.z) + 1.0;
  if (camera.position.y < floorLimit) camera.position.y = floorLimit;
  if (camera.position.y > WORLD.surfaceY - 0.8) camera.position.y = WORLD.surfaceY - 0.8;

  godRays.update(camera);

  renderer.render(scene, camera);
  ui.tickFPS(dt);
}

animate();
