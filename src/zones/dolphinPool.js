import * as THREE from 'three';
import { WORLD } from '../env.js';
import { createWaterSurface } from '../environment/surface.js';
import { createSand } from '../environment/seabed.js';
import { createGodRays, createBubbles, createMarineSnow } from '../environment/effects.js';
import { CollisionWorld } from '../collision.js';
import { DolphinPod, DOLPHIN_KINDS } from '../creatures/dolphin.js';
import { DOLPHIN_POOL_SPECIES } from '../species.js';
import { fbm3 } from '../noise.js';

// ============ イルカプールゾーン ============
// 大水槽と違い、浅く明るいラグーン。日射が強く、水色は透明な турコイズ。
// 底は白い砂で、光が回り込むので全体が明るい。

// 中央が広く平らで、外周に向かって緩やかに浅くなる皿状の底。
// イルカがジャンプできる十分な水深(水面16に対し底6前後)を確保する。
export function poolTerrain(x, z) {
  const r = Math.hypot(x, z);
  // 中央は平坦、外周で立ち上がって水面のすぐ上で縁になる。
  // 頭打ちにしないと砂の板の端(半径110)で数百の高さまで伸びてしまい、
  // 水中では霧に隠れていても、水上へ出た瞬間に白い壁として空を埋める。
  const rise = Math.min(Math.pow(Math.max(r - 26, 0) / 16, 2.0) * 9.0, 12.2);
  // 縁の外側は落ち込ませる。遠景に白い台地が広がらないように
  const drop = Math.min(Math.pow(Math.max(r - 46, 0) / 10, 1.6) * 14.0, 34.0);
  // 砂紋程度の細かい起伏だけ(落ち込んだ先ではならす)
  const ripple = fbm3(x * 0.05 + 30, 0, z * 0.05, 2) * 0.9 * (1 - drop / 34);
  return 5.4 + rise - drop + ripple;
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
  tap: 'イルカはときどき水面へ跳びます',
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

    // --- 3種のポッド ---
    // 種ごとに遊泳域をずらして、同じ水槽の別の場所で暮らしているように見せる
    const pods = {
      bottlenose: new DolphinPod(root, {
        kind: DOLPHIN_KINDS.bottlenose,
        count: 4,
        center: new THREE.Vector3(-3, 10.8, 2),
        radius: 15,
      }),
      beluga: new DolphinPod(root, {
        kind: DOLPHIN_KINDS.beluga,
        count: 3,
        center: new THREE.Vector3(9, 9.2, -9),   // ゆったり深めを泳ぐ
        radius: 13,
      }),
      whiteSided: new DolphinPod(root, {
        kind: DOLPHIN_KINDS.whiteSided,
        count: 6,
        center: new THREE.Vector3(-6, 12.0, -7),  // 俊敏に浅いところを走る
        radius: 16,
      }),
    };

    // 全個体を共有して、種をまたいでぶつからないようにする
    const everyone = [];
    for (const p of Object.values(pods)) everyone.push(...p.members);
    for (const p of Object.values(pods)) {
      p.setWorld(world);
      p.setNeighbors(everyone);
      p.onBreach = () => audio.dolphinCall(p.kind.key);
    }

    return {
      world,
      followTargets: {
        bottlenose: { get: () => pods.bottlenose.podCenter, dist: [9, 24] },
        beluga: { get: () => pods.beluga.podCenter, dist: [11, 27] },
        whiteSided: { get: () => pods.whiteSided.podCenter, dist: [8, 21] },
      },
      update(dt, camera) {
        for (const p of Object.values(pods)) p.update(dt);
        godRays.update(camera);
      },
      onTap() { /* イルカは驚かせない */ },
    };
  },
};

// 水面より上へ跳び出せるよう、カメラの上限は水面直下に留める
export const POOL_SURFACE = WORLD.surfaceY;
