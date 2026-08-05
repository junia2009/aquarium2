import * as THREE from 'three';
import { WORLD } from '../env.js';
import { abyssTerrain, createSediment, createVentField } from '../environment/abyss.js';
import { createMarineSnow } from '../environment/effects.js';
import { CollisionWorld } from '../collision.js';
import { FISH_SHAPES } from '../creatures/fishGeometry.js';
import { createFishMaterial } from '../creatures/fishMaterial.js';
import { School, makeSchoolInstanceAttr } from '../creatures/school.js';
import { AtollaSwarm } from '../creatures/abyssal.js';
import { disturbPoint } from '../interaction.js';
import { ABYSS_SPECIES } from '../species.js';

// ============ 深海ゾーン ============
// 太陽の届かない漸深層。ここでは照明のモデルが丸ごと反転する。
//   ・太陽光もコースティクスもスネルの窓もない(uSunColor をほぼ黒にする)
//   ・見えるのは「ダイバーライトが当たったもの」と「自分で光るもの」だけ
//   ・水は赤から先に吸うので、遠いものは青緑に沈み、近いものだけが色を持つ
// 赤い深海生物が赤いのは、そこでは赤が「見えない色」だからで、
// ライトを当てた瞬間だけ血の色に見える、という体験がそのまま成立する。

const VENTS = [
  { x: 11, z: -12, h: 5.4, r: 1.15, seed: 3 },
  { x: 14.5, z: -8.5, h: 3.6, r: 0.85, seed: 11 },
  { x: 7.5, z: -15.5, h: 4.2, r: 0.95, seed: 27 },
];

export const ABYSS = {
  key: 'abyss',
  name: '深海',
  sub: 'MIDNIGHT ZONE',
  icon: '🔦',
  terrain: abyssTerrain,
  env: {
    fogColor: new THREE.Color('#01070d'),
    fogDensity: 0.030,
    ambTop: new THREE.Color('#07202c'),     // はるか上から届く、かすかな青
    ambBottom: new THREE.Color('#010509'),
    sunColor: new THREE.Color('#020507'),   // 太陽はここまで届かない
    sunDir: new THREE.Vector3(0.1, 1, 0.05).normalize(),
    exposure: 1.45,
    lamp: {
      intensity: 2.1,
      reach: 34,
      angle: 0.52,
      color: new THREE.Color('#e8f2ff'),
    },
  },
  camera: {
    pos: new THREE.Vector3(4.5, 5.2, -1.0),
    look: new THREE.Vector3(12, 3.6, -13),
  },
  species: ABYSS_SPECIES,

  build(root, audio) {
    createSediment(root);
    const vents = createVentField(root, VENTS);
    // マリンスノーは深海の主役。濃く、粒を大きめにして光錐の中で舞わせる
    createMarineSnow(root, { count: 2600, size: 1.6 });

    const world = new CollisionWorld();
    for (const c of vents.colliders) world.addStatic(c.center, c.rx, c.ry, c.rz);

    // --- ハダカイワシの群れ ---
    // 深海でいちばん数の多い魚。ゆっくり漂い、腹の発光器だけが動いて見える
    const lanternGeo = FISH_SHAPES.lanternfish();
    lanternGeo.scale(0.42, 0.42, 0.42);
    const LANTERN_N = 90;
    const lanternMesh = new THREE.InstancedMesh(
      lanternGeo,
      createFishMaterial({
        pattern: 8,
        len: lanternGeo.userData.length * 0.42,
        swim: { freq: 6.5, amp: 0.075, waveNum: 0.95, headAmp: 0.10, flapFreq: 4.5 },
      }),
      LANTERN_N
    );
    lanternMesh.frustumCulled = false;
    makeSchoolInstanceAttr(lanternGeo, LANTERN_N, [0.8, 1.2]);
    root.add(lanternMesh);
    const lanterns = new School({
      mesh: lanternMesh, count: LANTERN_N,
      center: new THREE.Vector3(-4, 9.5, 2), homeRadius: 15, seed: 9,
      params: {
        maxSpeed: 2.4, minSpeed: 0.7, perception: 2.2,
        wSep: 1.8, wAli: 0.9, wCoh: 0.7, maxForce: 7,
        yMin: 5.0, yMax: WORLD.surfaceY - 1.0, burstSpeed: 6.5,
        bodyRadius: 0.16, avoidRange: 1.0,
      },
    });


    // --- Atollaクラゲ ---
    const atolla = new AtollaSwarm(root, {
      count: 5, center: new THREE.Vector3(-2, 9.5, -4), radius: 13,
    });

    return {
      world,
      followTargets: {
        lanternfish: { get: () => lanterns.schoolCenter, dist: [4, 11] },
        atolla: { get: () => atolla.swarmCenter, dist: [3.5, 10] },
      },
      update(dt, camera) {
        lanterns.update(dt, [], world);
        atolla.update(dt);
      },
      onTap(ray, hit) {
        // 深海で光を向けられるのは強い刺激。
        // Atollaクラゲは逃げる代わりに警報発光を始め、
        // ハダカイワシの群れは爆発的に散る。
        // クラゲは視線で直接判定する(群れの代理点を経由すると当たらない)
        const jelly = atolla.alarmAlongRay(ray, 2.6);
        if (jelly) atolla.alarmNear(jelly, 5);
        if (disturbPoint(ray, lanterns, 3.5, hit)) lanterns.scare(hit, 9, 70);
      },
    };
  },
};
