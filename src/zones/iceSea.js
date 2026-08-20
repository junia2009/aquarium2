import * as THREE from 'three';
import { setIceCover, WORLD } from '../env.js';
import { createWaterSurface } from '../environment/surface.js';
import { createSand } from '../environment/seabed.js';
import { iceTerrain, createIceCanopy, createDropstones, ICE_EXTENT } from '../environment/ice.js';
import { createGodRays, createMarineSnow } from '../environment/effects.js';
import { CollisionWorld } from '../collision.js';
import { PENGUIN_KINDS } from '../creatures/penguin.js';
import { PenguinFlock, BubbleTrail } from '../creatures/penguinFlock.js';
import { SplashField } from '../creatures/dolphin.js';
import { FeedCloud } from '../creatures/feed.js';
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
    // ポータルの色。霧の色をそのまま使うと、正規化した時点で
    // どれも同じ青になって行き先が見分けられない。氷を透かした淡い水色
    portalTint: new THREE.Color('#9fd8e8'),
    fogDensity: 0.013,
    ambTop: new THREE.Color('#6ea9c2'),
    ambBottom: new THREE.Color('#2c5b6e'),
    // 極域の太陽は低い。斜めに差すので、氷の影も水平にずれる
    sunColor: new THREE.Color('#f4faff'),
    sunDir: new THREE.Vector3(0.34, 0.84, 0.26).normalize(),
    exposure: 1.06,
    // うねりをほぼ殺す。海氷は波を吸うので、固まった流氷の中の海面は
    // 池のように平らになる(だから探検家は氷の中を「millpond」と書いた)。
    // ここが外洋なみ(±1m)のままだと、板の乾舷は中央値でも32cmしか
    // ないので、氷の上に立っているペンギンが波に飲まれてしまう
    swell: 0.12,
  },
  // リードのすぐ下、光の柱を見上げる位置から始める
  camera: { pos: new THREE.Vector3(-2, 9.0, 14), look: new THREE.Vector3(2, 14.0, -2) },
  tap: 'クリック: ペンギンが寄ってくる / えさをまくとオキアミを追う',
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
    // いちばん大きい板の下面を、図鑑の注視点にする
    const big = ice.floes.reduce((a, b) => (b.rMean > a.rMean ? b : a));
    FLOE_VIEW.set(big.x, ice.field.under(big.x, big.z) - 1.2, big.z);

    // 光芒はリード(割れ目)からだけ差し込む。氷の下に立てても
    // 「板を突き抜けてくる光の柱」になってしまう
    const godRays = createGodRays(root, { spots: ice.leadSpots, width: 22 });
    // 極域の海は懸濁物が少ない。粒は控えめに
    createMarineSnow(root, { count: 500, size: 0.8 });

    const world = new CollisionWorld();
    for (const c of stones.colliders) world.addStatic(c.center, c.rx, c.ry, c.rz);
    // 氷山は水面下に本体がある。ここを入れないと、泳いでいて塊を
    // すり抜けることになる
    for (const c of ice.colliders) world.addStatic(c.center, c.rx, c.ry, c.rz);

    // --- ペンギン4種 ---
    // 気泡は1つの粒プールを4種で共有する。種ごとに持たせても意味がなく、
    // 描画呼び出しだけが増える
    const bubbles = new BubbleTrail(root);
    // 餌はオキアミ。ペンギンの主食で、密な群れを作って自分で泳ぎ、
    // 捕食者が来ると跳ねて散る
    const krill = new FeedCloud(root, 'krill');
    // 水面を割るしぶきはイルカと同じものを使う。物理は同じ
    const splash = new SplashField(root);
    // カメラは原点から半径42mまでしか出られない(camera.js の maxR)。
    // 流氷そのものは160m四方に敷いてあるが、息継ぎと上陸は
    // 「見にいける範囲」で起きなければ意味がない。
    // ここを絞らないと、たどり着けない板の上でペンギンが立っていることになる
    const REACH = 34;
    const near = (p) => Math.hypot(p.x, p.z) < REACH;
    const openSpots = ice.leadSpots
      .concat(ice.polynyas.map((p) => ({ x: p.x, z: p.z })))
      .filter(near);
    const haulOuts = ice.haulOuts.filter(near);
    const shared = { iceField: ice.field, bubbles, splash, openSpots, haulOuts };
    const flocks = {
      king: new PenguinFlock(root, {
        kind: PENGUIN_KINDS.king, count: 5,
        center: new THREE.Vector3(-6, 8.5, 4), radius: 15,
        ...shared,
      }),
      gentoo: new PenguinFlock(root, {
        kind: PENGUIN_KINDS.gentoo, count: 7,
        center: new THREE.Vector3(7, 10.5, -8), radius: 17,
        ...shared,
      }),
      adelie: new PenguinFlock(root, {
        kind: PENGUIN_KINDS.adelie, count: 8,
        center: new THREE.Vector3(-9, 6.5, -11), radius: 16,
        ...shared,
      }),
      chinstrap: new PenguinFlock(root, {
        kind: PENGUIN_KINDS.chinstrap, count: 7,
        center: new THREE.Vector3(11, 9.0, 9), radius: 16,
        ...shared,
      }),
    };
    // 種をまたいでぶつからないよう、全個体を共有する
    const everyone = [];
    for (const f of Object.values(flocks)) everyone.push(...f.members);
    for (const f of Object.values(flocks)) {
      f.setWorld(world);
      f.setNeighbors(everyone);
    }

    return {
      world,
      ice,
      // 検証用。ヘッドレスから群れの内部状態を読むため
      __flocks: flocks,
      followTargets: {
        king: { get: () => flocks.king.lead, dist: [2.2, 6.0] },
        gentoo: { get: () => flocks.gentoo.lead, dist: [1.8, 5.0] },
        adelie: { get: () => flocks.adelie.lead, dist: [1.6, 4.5] },
        chinstrap: { get: () => flocks.chinstrap.lead, dist: [1.6, 4.5] },
        // 流氷そのものも図鑑から見にいける。板の下面を見上げる位置へ
        floe: { get: () => FLOE_VIEW, dist: [6, 14] },
      },
      onEnter() {
        setIceCover(ice.coverTexture, ICE_EXTENT);
      },
      onLeave() {
        setIceCover(null);
      },
      update(dt, camera) {
        for (const f of Object.values(flocks)) f.update(dt);
        // オキアミは追ってくるペンギンから逃げる
        krill.update(dt, null, everyone);
        godRays.update(camera);
      },
      feedLeft: () => krill.n,
      __cloud: krill,
      /**
       * 餌をまく。氷の下でしか撒けない——甲板の上へこぼしても
       * ペンギンは水中から取りに行けない
       */
      onFeed(p) {
        const y = Math.min(p.y, ice.field.under(p.x, p.z) - 0.5, WORLD.surfaceY - 0.6);
        _feed.set(p.x, Math.max(y, iceTerrain(p.x, p.z) + 1.2), p.z);
        krill.drop(_feed, 190, 1.0);
        for (const f of Object.values(flocks)) f.noticeFeed(krill);
      },
      onTap(ray) {
        // ペンギンは驚いて散るのではなく、寄ってくる。
        // 潜水者のまわりを回ってのぞき込み、満足すると離れていく
        for (const f of Object.values(flocks)) {
          if (f.curiousAlongRay(ray)) break;
        }
      },
    };
  },
};

// 図鑑から「流氷」を選んだときの注視点。いちばん大きい板の下面。
// build() のなかで確定させる
const FLOE_VIEW = new THREE.Vector3(0, 13, 0);
const _feed = new THREE.Vector3();
