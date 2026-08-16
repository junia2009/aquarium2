import * as THREE from 'three';
import { U, WORLD } from '../env.js';
import { createWaterSurface } from '../environment/surface.js';
import { createGodRays } from '../environment/effects.js';
import {
  shoreTerrain, createShoreRock, createTidePools, tideAt, waterAt, localWater, POOLS, TIDE,
} from '../environment/shore.js';
import { CollisionWorld } from '../collision.js';
import { SHORE_SPECIES } from '../species.js';

// ============ 磯ゾーン ============
//
// ここまでの4ゾーンは、どれも水面が動かなかった。頭上にある天井で、
// 高さは16mで固定。磯はそこが違う。
//
// 潮が満ちれば岩が沈み、引けば現れる。波が寄せれば水は岩を駆け上がり、
// 引けば泡だけが残る。同じ岩が1分後には濡れて黒く、5分後には乾いて白い。
// 水際そのものが主役になる、はじめてのゾーン。
//
// そのため水面は「動かせるもの」として扱う。共有ユニフォーム uSurfaceY を
// 毎フレーム書き換え、ゾーンを出るときに必ず戻す(戻さないとほかの
// ゾーンの水面が潮位のまま残る)。

export const SHORE = {
  key: 'shore',
  name: '磯',
  sub: 'ROCKY SHORE',
  icon: '🦀',
  terrain: shoreTerrain,
  env: {
    // 浅い岩礁の水。砂ではなく岩と海藻の上なので、青緑に寄る
    fogColor: new THREE.Color('#1c6a70'),
    fogDensity: 0.030,
    ambTop: new THREE.Color('#63a8ad'),
    ambBottom: new THREE.Color('#22484a'),
    sunColor: new THREE.Color('#fff2d8'),
    sunDir: new THREE.Vector3(0.30, 0.86, 0.41).normalize(),
    // 快晴の磯は本当に眩しいが、露出を上げると帯状分布の色差が
    // トーンマッピングで潰れて、全部おなじ灰色の岩になる
    exposure: 0.88,
    // 外洋のうねりがそのまま入る岸。ただし打ち上げは surge で別に作るので、
    // 沖合の水面自体は控えめに
    swell: 0.45,
  },
  // 潮だまりを見下ろす位置から始める。磯は上から覗きこむ場所
  camera: { pos: new THREE.Vector3(-7.5, 17.9, 8.0), look: new THREE.Vector3(-7.0, 15.3, 0.5) },
  tap: 'クリック: カニが岩陰へ逃げる / 潮は3分でひと巡りします',
  species: SHORE_SPECIES,

  build(root, audio) {
    const surface = createWaterSurface(root);
    const rock = createShoreRock(root);
    const pools = createTidePools(root);
    // 光芒は沖側の深いところにだけ立てる。岩の上に立てると
    // 岩を突き抜ける光の柱になる
    const godRays = createGodRays(root, {
      spots: [{ x: -14, z: -22 }, { x: 9, z: -26 }, { x: -2, z: -18 }], width: 16,
    });

    const world = new CollisionWorld();

    // 直前まで水が届いていた高さ。波が引いたあとも岩はしばらく濡れている。
    // これを持たないと、波が去った瞬間に岩がからりと乾いて嘘になる
    let wetTop = TIDE.mean;

    return {
      world,
      // 検証用
      __shore: { get tide() { return tideAt(U.uTime.value); },
                 get water() { return waterAt(U.uTime.value); },
                 get wetTop() { return wetTop; }, pools: POOLS },
      followTargets: {
        // 潮だまりは動かないが、図鑑から見にいけたほうがいい
        tidepool: { get: () => POOL_VIEW, dist: [3.0, 7.0] },
      },
      onEnter() {
        // 潮位を共有ユニフォームへ。以後 update が毎フレーム更新する
        U.uSurfaceY.value = tideAt(U.uTime.value);
      },
      onLeave() {
        // 必ず戻す。ここを忘れると次のゾーンの水面が潮位のままになる
        U.uSurfaceY.value = WORLD.surfaceY;
        surface.position.y = WORLD.surfaceY;
      },
      update(dt, camera) {
        const t = U.uTime.value;
        const tide = tideAt(t);
        const water = waterAt(t);
        // 濡れの上端。波が上がれば即座に、引いたあとはゆっくり乾く。
        // 乾く速さは岩肌で30秒ほど
        wetTop = Math.max(water, wetTop - dt * 0.045);

        // 水面(一枚板)と、その高さを参照する全マテリアル
        surface.position.y = water;
        U.uSurfaceY.value = water;
        rock.mat.uniforms.uTide.value = tide;
        rock.mat.uniforms.uWater.value = water;
        rock.mat.uniforms.uWetTop.value = wetTop;
        pools.update(water);
        godRays.update(camera);
      },
    };
  },
};

// 図鑑から「潮だまり」を選んだときの注視点。いちばん大きい溜まり
const POOL_VIEW = new THREE.Vector3(POOLS[0].x, POOLS[0].rim - 0.4, POOLS[0].z);

// 生き物側から使う。潮だまりの中では海が引いても水が残る
export { localWater };
