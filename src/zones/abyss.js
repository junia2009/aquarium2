import * as THREE from 'three';
import { WORLD } from '../env.js';
import { abyssTerrain, createSediment, createVentField } from '../environment/abyss.js';
import { createMarineSnow } from '../environment/effects.js';
import { CollisionWorld } from '../collision.js';
import { FISH_SHAPES } from '../creatures/fishGeometry.js';
import { createFishMaterial } from '../creatures/fishMaterial.js';
import { School, makeSchoolInstanceAttr } from '../creatures/school.js';
import { AtollaSwarm, DreamCucumbers, TunicateBed } from '../creatures/abyssal.js';
import { Anglerfish } from '../creatures/angler.js';
import { FeedCloud } from '../creatures/feed.js';
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

// いちばん大きい噴出口の注視点(build 時に確定する)
const VENT_VIEW = new THREE.Vector3();

// オオグチボヤの群落。数カ所にかたまって生え、株ごとの間隔は数十cm。
// 同じ群落の個体はそろって流れの上手(＝口を開ける向き)を向く。
function tunicateSpots() {
  const CLUMPS = [
    { x: 14.8, z: -14.8, r: 0.9, n: 14, face: 2.2 },
    { x: 13.2, z: -16.4, r: 0.7, n: 9, face: 2.1 },
    { x: 5.3, z: -6.8, r: 0.8, n: 11, face: -0.9 },
  ];
  const out = [];
  for (const c of CLUMPS) {
    for (let i = 0; i < c.n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * c.r;
      out.push({
        x: c.x + Math.cos(a) * r,
        z: c.z + Math.sin(a) * r,
        scale: 0.10 + Math.random() * 0.05,
        face: c.face,
      });
    }
  }
  return out;
}

export const ABYSS = {
  key: 'abyss',
  name: '深海',
  sub: 'MIDNIGHT ZONE',
  icon: '🔦',
  terrain: abyssTerrain,
  env: {
    fogColor: new THREE.Color('#01070d'),
    // ポータルの色。霧の色をそのまま使うと、正規化した時点で
    // どれも同じ青になって行き先が見分けられない。光の届かない藍。暗いことが行き先の性格
    portalTint: new THREE.Color('#1b2a4e'),
    // 向こう側の水の動き。色だけ変えても、5枚が同じ絵の色違いに
    // しかならない。光の届かない層。集光はゼロで、マリンスノーだけが降る
    portalMood: { speed: 0.18, caustic: 0.0, motes: 1.0, surge: 0.0 },
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
  tap: 'クリック: クラゲが警報発光 / えさをまくと落ちてきた餌に集まる',
  species: ABYSS_SPECIES,

  build(root, audio) {
    createSediment(root);
    const vents = createVentField(root, VENTS);
    VENT_VIEW.copy(vents.mouths[0]).y -= 1.6;
    // マリンスノーは深海の主役。濃く、粒を大きめにして光錐の中で舞わせる
    createMarineSnow(root, { count: 2600, size: 1.6 });

    const world = new CollisionWorld();
    for (const c of vents.colliders) world.addStatic(c.center, c.rx, c.ry, c.rz);

    // --- ハダカイワシの群れ ---
    // 深海でいちばん数の多い魚。ゆっくり漂い、腹の発光器だけが動いて見える。
    // 実物は体長10cm前後。すぐ隣でミツクリエナガチョウチンアンコウ(18cm)が
    // これを丸呑みするので、ここを盛ると大きさの関係が一目で嘘になる
    const LANTERN_LEN = 0.11;
    const lanternGeo = FISH_SHAPES.lanternfish();
    lanternGeo.scale(LANTERN_LEN, LANTERN_LEN, LANTERN_LEN);
    const LANTERN_N = 90;
    const lanternMesh = new THREE.InstancedMesh(
      lanternGeo,
      createFishMaterial({
        pattern: 8,
        len: lanternGeo.userData.length * LANTERN_LEN,
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
        // 体長10cmの魚の速度感。毎秒10体長で1m/s強
        maxSpeed: 1.3, minSpeed: 0.40, perception: 1.0, sepDist: 0.34,
        wSep: 1.8, wAli: 0.9, wCoh: 0.7, maxForce: 5,
        yMin: 5.0, yMax: WORLD.surfaceY - 1.0, burstSpeed: 3.4,
        bodyRadius: 0.05, avoidRange: 0.4,
      },
    });


    // --- Atollaクラゲ ---
    const atolla = new AtollaSwarm(root, {
      count: 5, center: new THREE.Vector3(-2, 9.5, -4), radius: 13,
    });

    // --- ユメナマコ ---
    // 泥の上を漂う半透明のナマコ。中身(泥を詰めた消化管)が透けて見える
    // 餌は沈降する有機物。深海には光が届かないので、上から落ちてくる
    // これだけが食べもの。落ちてきた一片に生き物が集まるのは、
    // この海でいちばんよく起きる出来事そのもの
    const fall = new FeedCloud(root, 'detritus');
    const cukes = new DreamCucumbers(root, {
      count: 6, center: new THREE.Vector3(-6, 0, -8), radius: 5,
      floorFn: abyssTerrain,
    });

    // --- オオグチボヤ ---
    // 海丘の斜面に固着する。チューブワームの群落とは場所を分ける
    // (混ざると赤い鰓冠に埋もれて、口が開くところが見えなくなる)
    const tunicates = new TunicateBed(root, {
      floorFn: abyssTerrain,
      // scale は 1.0 で「柄まで約12cm」。実物どおり小さいので、
      // 一株ずつ離して置かず、身を寄せ合った群落にする
      spots: tunicateSpots(),
    });

    // --- ミツクリエナガチョウチンアンコウ ---
    // ハダカイワシの群れの近くに待ち伏せさせる。エスカの光が群れを引き寄せ、
    // 一匹が近づきすぎたところで大口を開ける
    const angler = new Anglerfish(root, {
      home: new THREE.Vector3(-3.5, 8.2, 3.0), length: 0.19, prey: lanterns,
    });

    return {
      world,
      followTargets: {
        lanternfish: { get: () => lanterns.schoolCenter, dist: [1.4, 4.0] },
        atolla: { get: () => atolla.swarmCenter, dist: [2.2, 6.0] },
        seacucumber: { get: () => cukes.center3, dist: [1.5, 4.0] },
        tunicate: { get: () => tunicates.center3, dist: [1.2, 3.0] },
        angler: { get: () => angler.pos, dist: [0.38, 1.0] },
        // 煙突は動かないが、図鑑から選んだら見にいけたほうがいい。
        // いちばん大きい噴出口の少し下(煙の出口が視界の上に来る高さ)を見る
        vent: { get: () => VENT_VIEW, dist: [7, 16] },
      },
      update(dt, camera) {
        lanterns.update(dt, [], world);
        atolla.update(dt);
        fall.update(dt, abyssTerrain);
        if (fall.active) {
          const c = fall.focus(_focus);
          lanterns.feedAt(c);
          lanterns.lure(c, 9, 5.5);
          for (let i = 0; i < lanterns.count && fall.credit >= 1; i++) {
            fall.eatNear(lanterns.pos[i], 0.5);
          }
          // 底に降り積もったぶんはナマコが掃除する。
          // ユメナマコは海底の堆積物を漉して食べる、いわば掃除屋で、
          // 実際に「落ちてきた餌のまわりに集まる」ことが知られている
          const q = cukes.forageAt(c, 4.5);
          if (q) fall.eatNear(q, 1.1);
        }
        cukes.update(dt);
        tunicates.update(dt, camera);
        angler.update(dt, camera);
      },
      feedLeft: () => fall.n,
      __cloud: fall,
      onFeed(p) {
        // 沈んでいくものなので、少し上から落とす
        const y = Math.max(p.y, abyssTerrain(p.x, p.z) + 1.5);
        _focus.set(p.x, Math.min(y + 1.5, WORLD.surfaceY - 1), p.z);
        fall.drop(_focus, 150, 0.9);
      },
      onTap(ray, hit) {
        // 深海で光を向けられるのは強い刺激。
        // Atollaクラゲは逃げる代わりに警報発光を始め、
        // ハダカイワシの群れは爆発的に散る。
        // クラゲは視線で直接判定する(群れの代理点を経由すると当たらない)
        atolla.alarmAlongRay(ray);
        if (disturbPoint(ray, lanterns, 2.0, hit)) lanterns.scare(hit, 3.5, 26);
        // ユメナマコは触られると体表が青く光る(捕食者に「印」をつける)。
        // 光るのは触れた本人だけ
        cukes.glowAlongRay(ray);
        // チョウチンアンコウを狙って触れたら、その場で襲いかからせる
        if (hit && hit.distanceTo(angler.pos) < 0.6) angler.provoke();
      },
    };
  },
};

const _focus = new THREE.Vector3();
