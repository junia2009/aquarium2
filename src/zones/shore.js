import * as THREE from 'three';
import { U, WORLD } from '../env.js';
import { createWaterSurface } from '../environment/surface.js';
import { createGodRays } from '../environment/effects.js';
import {
  meshHeightAt, createShoreRock, createBoulders, createTidePools,
  tideAt, waterAt, localWater, POOLS, TIDE,
} from '../environment/shore.js';
import { CollisionWorld } from '../collision.js';
import { FeedCloud } from '../creatures/feed.js';
import { CrabColony, AnemoneBed, createSeaStars, createUrchins } from '../creatures/shoreLife.js';
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

// 開幕のカメラ。いちばん大きい潮だまりの縁を基準に組む。
// 座標を手で書いていたら、地形の高さを直したときに岩の中に入った
// (足元の余裕57cm)。開いた瞬間に衝突判定で押し出され、意図とは
// まるで違う絵から始まってしまう。
// 高さは「溜まりの縁 + 4.2m」と「その真下の岩 + 3.0m」の高いほう。
// 前者だけだと、溜まりより高い岩の陰に置かれることがある。
//
// 距離は溜まりの半径の2倍ほど離す。2.4mまで寄せていたら、
// 半径3.4mの溜まりが画面いっぱいの青い円盤になって、
// 磯を見にきたのに水たまりの中しか見えなかった。
// 見せたいのは「棚の上の溜まりと、その先の海」という並び
const START_CAM = (() => {
  const p = POOLS[0];
  const x = p.x - p.r * 1.7, z = p.z + p.r * 2.4;
  return {
    pos: new THREE.Vector3(x, Math.max(p.rim + 4.2, meshHeightAt(x, z) + 3.0), z),
    look: new THREE.Vector3(p.x, p.rim - 0.15, p.z - p.r * 0.8),
  };
})();

export const SHORE = {
  key: 'shore',
  name: '磯',
  sub: 'ROCKY SHORE',
  icon: '🦀',
  // 地形として外へ出すのは「描かれている高さ」。生き物もカメラも
  // 餌も、画面に見えている岩と同じ一つの高さを見ていなければならない
  terrain: meshHeightAt,
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
  // 潮だまりを見下ろす位置から始める。磯は上から覗きこむ場所。
  //
  // 座標を手で書いていたら、地形の高さを直したときに岩の中へ入った
  // (足元の余裕57cm)。開いた瞬間に衝突判定で押し出され、
  // 意図とはまるで違う絵から始まることになる。
  // いちばん大きい潮だまりの縁を基準に組み立てて、地形が動いても
  // 「溜まりを覗きこむ」という意図のほうが残るようにする
  camera: START_CAM,
  // 磯の主役は甲幅3〜7cmの生き物。既定の0.9mでは高すぎて、
  // 追いかけてもカニが画面の3%にしかならない。35cmまで降りられるように、
  // かわりに大きい転石を衝突判定に入れて、すり抜けないようにしてある
  clearance: 0.35,
  tap: 'クリック: カニが岩陰へ逃げる / 潮は3分でひと巡りします',
  species: SHORE_SPECIES,

  build(root, audio) {
    const surface = createWaterSurface(root);
    const rock = createShoreRock(root);
    // 転石。磯は一枚の起伏ではなく、割れた岩が積み重なった場所
    const stones = createBoulders(root);
    const pools = createTidePools(root);
    // 光芒は沖側の深いところにだけ立てる。岩の上に立てると
    // 岩を突き抜ける光の柱になる
    const godRays = createGodRays(root, {
      spots: [{ x: -14, z: -22 }, { x: 9, z: -26 }, { x: -2, z: -18 }], width: 16,
    });

    const world = new CollisionWorld();
    // 大きい転石はすり抜けない。カメラが地面の35cmまで降りられるので、
    // 入れていないと巨礫の中を素通りしてしまう
    const _b = new THREE.Vector3();
    for (const s of stones.bodies) {
      world.addStatic(_b.set(s.x, s.y, s.z), s.rx, s.ry, s.rz);
    }

    // --- 生き物 ---
    // 磯の住人はほとんどが泳がない。岩に張り付き、脚で歩き、
    // 潮が引けば体を縮めて水の戻りを待つ
    // 餌は砕いた貝や魚の身。磯でこれを岩に置くと、どこにいたのか
    // 分からないカニが次々に出てくる。沈むだけで自分では泳がない
    const bits = new FeedCloud(root, 'detritus');
    // 磯の餌は水面より高い岩の上に載る。既定の「水面より上へ行かせない」
    // 制限を外さないと、岩に埋まって誰も食べられない
    bits.ceiling = 1e4;
    const crabs = new CrabColony(root, { count: 26 });
    const anemones = new AnemoneBed(root, { count: 120 });
    const stars = createSeaStars(root);
    const urchins = createUrchins(root);

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
        // 追う個体は選んだときに1匹決めて、離さない。
        // 毎フレーム選び直していたら、数秒おきに別のカニへ飛んでいた
        crab: {
          start: () => { followed = pickCrab(crabs, lastCam); },
          get: () => {
            if (!followed) followed = pickCrab(crabs, lastCam);
            return _crabPos.set(followed.x, followed.y + 0.05, followed.z);
          },
          // 床(このゾーンでは地形の35cm上)より下は書かない。届かない
          // 下限を書いても枝が発火しないだけだが、読んだ人が誤解する。
          //
          // 上限は近く保つこと。カニは甲幅3〜7cm しかないので、
          // 距離がそのまま「見えるかどうか」になる:
          //   2.20m → 画面の 2%(1100px 中 22px)。何がいるのか分からない
          //   1.30m → 4%
          //   0.62m → 8%(90px)。脚の動きが見える
          dist: [0.42, 0.62],
        },
      },
      // 検証用
      __life: { crabs, anemones, stars, urchins, bits },
      __stones: stones,
      feedLeft: () => bits.n,
      __cloud: bits,
      onFeed(p) {
        // 岩の上に置く。空中に撒いても意味がない
        const y = meshHeightAt(p.x, p.z);
        _feed.set(p.x, y + 0.12, p.z);
        bits.drop(_feed, 60, 0.5);
        crabs.noticeFeed(bits);
      },
      onTap(ray, hit) {
        // カニは近づくと岩陰へ走る。磯でカニを見つけたときに
        // 必ず起きることなので、これが無いと歩いている置物になる
        if (hit) crabs.scareAt(hit, 6);
      },
      onEnter() {
        // 潮位を共有ユニフォームへ。以後 update が毎フレーム更新する
        U.uSurfaceY.value = tideAt(U.uTime.value);
      },
      onLeave() {
        // 必ず戻す。ここを忘れると次のゾーンの水面が潮位のままになる
        U.uSurfaceY.value = WORLD.surfaceY;
        surface.position.y = WORLD.surfaceY;
        // 追っていた個体も手放す。次に入ったときは選び直す
        followed = null;
      },
      update(dt, camera) {
        lastCam.copy(camera.position);
        const t = U.uTime.value;
        const tide = tideAt(t);
        const water = waterAt(t);
        // 濡れの上端。波が上がれば即座に、引いたあとはゆっくり乾く。
        // 乾く速さは岩肌で30秒ほど
        wetTop = Math.max(water, wetTop - dt * 0.045);

        // 水面(一枚板)と、その高さを参照する全マテリアル
        surface.position.y = water;
        U.uSurfaceY.value = water;
        for (const m of [rock.mat, stones.mat]) {
          m.uniforms.uTide.value = tide;
          m.uniforms.uWater.value = water;
          m.uniforms.uWetTop.value = wetTop;
        }
        pools.update(water);
        // 生き物は「いまの水位」を見て振る舞いを変える。
        // 潮位ではなく波の打ち上げまで入れた水際を渡すこと——
        // 波が来た一瞬だけイソギンチャクが開くのが、実際の磯の見え方
        // 餌は岩の上に落ちて止まる。海底ではなく「その場の岩の高さ」
        bits.update(dt, meshHeightAt);
        crabs.update(dt, water);
        anemones.update(dt, water);
        stars.update(dt, water);
        urchins.update(dt, water);
        godRays.update(camera);
      },
    };
  },
};

// 図鑑から「潮だまり」を選んだときの注視点。いちばん大きい溜まり
const POOL_VIEW = new THREE.Vector3(POOLS[0].x, POOLS[0].rim - 0.4, POOLS[0].z);

// 生き物側から使う。潮だまりの中では海が引いても水が残る
export { localWater };

const _feed = new THREE.Vector3();
const _crabPos = new THREE.Vector3();

// 図鑑で「イソガニ」を選んだときに追う個体。選んだ時点で1匹に決めて持つ。
//
// もとは「いま歩いている最初の個体」を毎フレーム選び直していた。
// カニは数秒ごとに歩いたり止まったりするので、そのたびに条件を満たす
// 先頭の個体が入れ替わり、カメラが別のカニへ飛んでいた。
// 実測で 50 秒のあいだに 0.3m を超えるワープが5回、いちばん大きいもので
// 5.6m。追跡とは「同じ個体を見続けること」なので、選び直してはいけない。
let followed = null;
// カメラのいる場所。追う個体を選ぶときに近いほうを選びたい
const lastCam = new THREE.Vector3();

/** 追うに値するカニを1匹選ぶ。大きめの個体から、カメラに近いもの */
function pickCrab(crabs, near) {
  // 小さい個体(甲幅3cm)は追ってもほとんど画面に映らない。
  // 大きいほうの半分から選ぶ
  const sorted = crabs.members.slice().sort((a, b) => b.body - a.body);
  const pool = sorted.slice(0, Math.max(4, Math.ceil(sorted.length / 2)));
  let best = pool[0], bd = Infinity;
  for (const m of pool) {
    const d = Math.hypot(m.x - near.x, m.z - near.z);
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}
