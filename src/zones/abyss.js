import * as THREE from 'three';
import { WORLD } from '../env.js';
import { abyssTerrain, createSediment, createVentField } from '../environment/abyss.js';
import { createMarineSnow } from '../environment/effects.js';
import { CollisionWorld } from '../collision.js';
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

    return {
      world,
      followTargets: {},
      update(dt, camera) {},
      onTap(ray, hit) {},
    };
  },
};
