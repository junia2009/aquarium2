import * as THREE from 'three';
import { WORLD } from '../env.js';
import { createWaterSurface } from '../environment/surface.js';
import { createSand } from '../environment/seabed.js';
import { createGodRays, createBubbles, createMarineSnow } from '../environment/effects.js';
import { CollisionWorld } from '../collision.js';
import { DolphinPod } from '../creatures/dolphin.js';
import { DOLPHIN_POOL_SPECIES } from '../species.js';
import { fbm3 } from '../noise.js';

// ============ イルカプールゾーン ============
// 大水槽と違い、浅く明るいラグーン。日射が強く、水色は透明な турコイズ。
// 底は白い砂で、光が回り込むので全体が明るい。

// 中央が広く平らで、外周に向かって緩やかに浅くなる皿状の底。
// イルカがジャンプできる十分な水深(水面16に対し底6前後)を確保する。
export function poolTerrain(x, z) {
  const r = Math.hypot(x, z);
  // 中央は平坦、外周で立ち上がる
  const bowl = 5.4 + Math.pow(Math.max(r - 26, 0) / 16, 2.0) * 9.0;
  // 砂紋程度の細かい起伏だけ
  const ripple = fbm3(x * 0.05 + 30, 0, z * 0.05, 2) * 0.9;
  return bowl + ripple;
}

export const DOLPHIN_POOL = {
  key: 'dolphinPool',
  name: 'イルカプール',
  sub: 'DOLPHIN LAGOON',
  icon: '🐬',
  terrain: poolTerrain,
  env: {
    fogColor: new THREE.Color('#12658c'),
    fogDensity: 0.023,
    ambTop: new THREE.Color('#4a9fbe'),
    ambBottom: new THREE.Color('#1b4f61'),
    sunDir: new THREE.Vector3(0.16, 0.96, 0.22).normalize(),
    exposure: 1.0,
  },
  camera: { pos: new THREE.Vector3(0, 10.0, 16), look: new THREE.Vector3(0, 10.5, 0) },
  species: DOLPHIN_POOL_SPECIES,

  build(root, audio) {
    createWaterSurface(root);
    // 明るい白砂。ただしコースティクスと環境光で持ち上がるので、
    // 素の反射率は抑えめにしておかないと白飛びする
    createSand(root, {
      height: poolTerrain,
      tint: {
        light: new THREE.Color(0.52, 0.51, 0.45),
        dark: new THREE.Color(0.36, 0.37, 0.35),
      },
    });

    const world = new CollisionWorld();
    const godRays = createGodRays(root);
    // 底のエアレーション
    createBubbles(root, [
      { x: -9, y: poolTerrain(-9, 6) + 0.4, z: 6, count: 120, radius: 0.8 },
      { x: 11, y: poolTerrain(11, -8) + 0.4, z: -8, count: 90, radius: 0.6 },
    ]);
    createMarineSnow(root);

    // --- イルカのポッド ---
    const pod = new DolphinPod(root, {
      count: 5,
      center: new THREE.Vector3(0, 10.8, 0),
      radius: 15,
      length: 3.4,
    });
    pod.setWorld(world);
    pod.onBreach = () => audio.dolphinCall();

    return {
      world,
      followTargets: {
        dolphin: { get: () => pod.podCenter, dist: [9, 24] },
      },
      update(dt, camera) {
        pod.update(dt);
        godRays.update(camera);
      },
      onTap() { /* イルカは驚かせない */ },
    };
  },
};

// 水面より上へ跳び出せるよう、カメラの上限は水面直下に留める
export const POOL_SURFACE = WORLD.surfaceY;
