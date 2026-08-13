import * as THREE from 'three';
import { setIceCover } from '../env.js';
import { createWaterSurface } from '../environment/surface.js';
import { createSand } from '../environment/seabed.js';
import { iceTerrain, createIceCanopy, createDropstones, ICE_EXTENT } from '../environment/ice.js';
import { createGodRays, createMarineSnow } from '../environment/effects.js';
import { CollisionWorld } from '../collision.js';
import { ICE_SEA_SPECIES } from '../species.js';

// ============ 流氷の海ゾーン ============
// 南極の縁、海氷に覆われた大陸棚。
//
// このゾーンの光は、これまでの3つとまったく違う成り立ちをしている。
// 大水槽やイルカプールでは太陽が水面ぜんたいから均等に差してくる。
// ここでは海面の大半が氷で塞がれていて、光が入るのは割れ目(リード)だけ。
// だから明るさは「深さ」ではなく「頭上に氷があるかどうか」で決まる。
// リードの真下だけが眩しく、そこを離れると急に薄暗くなる。
// この一点が、氷の海を氷の海に見せている。
//
// 水そのものは冷たく澄んでいる。プランクトンが少ないので視程が長く、
// フォグは大水槽の半分ほどにしてある。

export const ICE_SEA = {
  key: 'iceSea',
  name: '流氷の海',
  sub: 'PACK ICE',
  icon: '🧊',
  terrain: iceTerrain,
  env: {
    // 冷たく澄んだ水。緑がかった青
    fogColor: new THREE.Color('#136683'),
    fogDensity: 0.013,
    ambTop: new THREE.Color('#6ea9c2'),
    ambBottom: new THREE.Color('#2c5b6e'),
    // 極域の太陽は低い。斜めに差すので、氷の影も水平にずれる
    sunColor: new THREE.Color('#f4faff'),
    sunDir: new THREE.Vector3(0.34, 0.84, 0.26).normalize(),
    exposure: 1.06,
  },
  // リードのすぐ下、光の柱を見上げる位置から始める
  camera: { pos: new THREE.Vector3(-2, 9.0, 14), look: new THREE.Vector3(2, 14.0, -2) },
  species: ICE_SEA_SPECIES,

  build(root, audio) {
    createWaterSurface(root);
    // 極域の礫底。有機物が少なく、貝殻片も乏しいので冷たい灰褐色
    createSand(root, {
      height: iceTerrain,
      tint: {
        light: new THREE.Color(0.30, 0.30, 0.29),
        dark: new THREE.Color(0.165, 0.175, 0.185),
      },
    });
    const stones = createDropstones(root);

    // 流氷の天蓋。ここで焼いた被覆テクスチャを全マテリアル共有の
    // ユニフォームへ渡すと、海底も岩も生き物も、まとめて氷の影に入る
    const ice = createIceCanopy(root, { seed: 3 });

    // 光芒はリード(割れ目)からだけ差し込む。氷の下に立てても
    // 「板を突き抜けてくる光の柱」になってしまう
    const godRays = createGodRays(root, { spots: ice.leadSpots, width: 22 });
    // 極域の海は懸濁物が少ない。粒は控えめに
    createMarineSnow(root, { count: 500, size: 0.8 });

    const world = new CollisionWorld();
    for (const c of stones.colliders) world.addStatic(c.center, c.rx, c.ry, c.rz);

    return {
      world,
      ice,
      followTargets: {},
      onEnter() {
        setIceCover(ice.coverTexture, ICE_EXTENT);
      },
      onLeave() {
        setIceCover(null);
      },
      update(dt, camera) {
        godRays.update(camera);
      },
      onTap() {},
    };
  },
};
