// ============ メガロドン ============
//
// Otodus megalodon。全長 17m。ジンベエザメと同じ「大きなサメ」だが、
// 見た目はまったく別物で、同じ形から出発すると必ず失敗する。
// ネズミザメ類(ホホジロザメの仲間)であることが輪郭を決めている:
//
//   ・ずんぐりした紡錘形。いちばん太いところが体の前3分の1にある。
//     ジンベエザメの「平たく広い頭」とは真逆で、断面は丸に近い
//   ・短く円錐形の吻。長く尖らせるとアオザメ、平たくするとジンベエ
//   ・三日月形の尾。上葉と下葉がほぼ同じ長さ——**ここが最大の違い**。
//     ジンベエザメは上葉が長い。速く泳ぐ魚の尾は必ず三日月になる
//   ・尾柄の左右に走るキール。速く泳ぐサメの証で、
//     これがあると輪郭が一気に「生き物の機械」寄りになる
//   ・巨大な三角形の第一背びれ
//   ・大きく長い胸びれ
//
// 施設のまわりを回遊させる。近づいたときは舷窓の正面、離れるときは
// 高く——という高さの付け方にしてある。理由は2つあって、
// 部屋から見上げる絵と見渡す絵の両方が作れることと、
// 区域照明の柱(海底から 9.2m)を突き抜けないこと。

import * as THREE from 'three';
import { buildFishGeometry } from './fishGeometry.js';
import { createFishMaterial } from './fishMaterial.js';
import { wander1 } from '../noise.js';

// 胴の長さ。尾と吻がこれに足されるので、全長はおよそ 24m になる。
// 学術的な推定の上限(20m)より大きい。ここは資料どおりの寸法より、
// 「見上げたときに怖いこと」を取っている——プロテウスの殻が
// 直径 27m なので、施設と並べて負けない大きさがここから始まる
const LEN = 20.0;

/**
 * 断面の変形。楕円だけでは出せない3つを足す。
 *   ・吻はわずかに上下へつぶれる(口が下面に横へ広いため)
 *   ・腹は平ら。ネズミザメ類の下面は板のように広い
 *   ・尾柄の左右にキール
 */
function megalodonSection(x, y, t) {
  // --- 頭は「横に張った楔」 ---
  //
  // 卵形の頭は、どれだけ大きく作っても怖くない。実物のホホジロザメの
  // 頭は上から見ると幅広の三角で、真横から見ると上面が平らに近い。
  // 幅を出し、上を削ぐ。この2つで顔つきが変わる
  const head = 1 - THREE.MathUtils.smoothstep(t, 0.02, 0.34);
  let sx = x * (1 + 0.26 * head);
  let sy = y * (1 - 0.20 * head);
  // 上面をさらに削いで、眼の上に稜(まゆ)を作る
  const brow = Math.max(y, 0);
  sy *= 1 - 0.18 * brow * brow * head;

  // --- 平らな腹 ---
  // 下半分だけ、外へ向かって押し戻す。丸いままだと浮き袋に見える
  const bel = Math.max(-y, 0);
  sy *= 1 - 0.18 * bel * bel * THREE.MathUtils.smoothstep(t, 0.08, 0.32);

  // --- 尾柄のキール ---
  // 体側の中ほど(y≈0)から水平に張り出す隆起。尾柄でいちばん強い
  const keel = THREE.MathUtils.smoothstep(t, 0.58, 0.84)
             * (1 - THREE.MathUtils.smoothstep(t, 0.94, 1.02));
  sx *= 1 + 0.70 * keel * Math.exp(-Math.pow(y / 0.28, 2));
  // キールのぶん、尾柄は縦につぶれる。横に広く縦に薄い——
  // これが速く泳ぐ魚の尾柄の形で、**ここが薄いほど胴が太く見える**
  sy *= 1 - 0.34 * keel;

  return [sx, sy];
}

/**
 * 施設のまわりを回遊する。
 *
 * 位置は角度と半径から解析的に出す。ボイドや自由なさまよいにしないのは、
 * ここが「建てたものが詰まっている水域」だから——柱・やぐら・潜水艦・
 * 観測所を、17m の体で毎回よけさせるより、通る道のほうを決めるほうが
 * 確実だし、回遊しているサメの動きとしても正しい。
 */
class Patrol {
  constructor({ speed, seed, floorAt, clearAt, yNear, yFar, yOver, rNear, rFar }) {
    this.speed = speed;
    this.seed = seed;
    this.floorAt = floorAt;     // その半径の海底の高さ
    this.clearAt = clearAt;     // その半径で越えるべき高さ(柱の頭など)
    this.yNear = yNear;         // 内側を回るときの高さ(舷窓の正面)
    this.yFar = yFar;           // 外側を回るときの高さ
    this.yOver = yOver;         // いちばん内側。天蓋の上を越える高さ
    this.rNear = rNear;
    this.rFar = rFar;
    this.t = Math.random() * 200;
    this.ang = Math.random() * Math.PI * 2;
    this.pos = new THREE.Vector3();
    this.prev = new THREE.Vector3();
    this.heading = 0;
    this.bank = 0;
    this.pitch = 0;
    this._init = false;
  }

  radiusAt(t) {
    // ゆっくり寄っては離れる。周期の違う2つを足して、
    // 同じ間隔で来ないようにする
    const a = 0.5 + 0.5 * Math.sin(t * 0.098);
    const b = 0.5 + 0.5 * wander1(t * 0.055, this.seed);
    // 内側に寄せる。ならすと外側にいる時間のほうが長くなり、
    // 部屋にいるあいだ一度も窓の前を通らない
    const k = Math.pow(THREE.MathUtils.clamp(a * 0.68 + b * 0.32, 0, 1), 1.5);
    return THREE.MathUtils.lerp(this.rNear, this.rFar, k);
  }

  heightAt(r) {
    // 半径で高さが決まる。内側ほど低い——ただしいちばん内側だけは
    // 逆に高い(天蓋の上を越えるので)
    const inner = THREE.MathUtils.smoothstep(r, this.rNear, this.rNear + 6.0);
    const outer = THREE.MathUtils.smoothstep(r, this.rNear + 7.0, this.rFar - 2.0);
    let y = THREE.MathUtils.lerp(this.yOver, this.yNear, inner);
    y = THREE.MathUtils.lerp(y, this.yFar, outer);
    // 柱やぐらを越える。ここは目分量にしない——照明の柱と同じ式から
    // 頭の高さを引いて、それに余裕を足す
    return Math.max(y, this.clearAt(r), this.floorAt(r) + 3.2);
  }

  update(dt) {
    this.t += dt;
    const r = this.radiusAt(this.t);
    // 角速度。半径が小さいほど速く回ってしまうので、半径で割る。
    // 17m の体が半径 17m で回るのは実物のサメの旋回半径より緩い
    this.ang += (this.speed / Math.max(r, this.rNear)) * dt;
    this.prev.copy(this.pos);
    this.pos.set(Math.cos(this.ang) * r, this.heightAt(r), Math.sin(this.ang) * r);
    if (!this._init) { this.prev.copy(this.pos); this._init = true; }

    // 向きは「実際に動いた向き」から出す。角度から作ると、
    // 半径が伸び縮みするぶんの斜行が乗らず、横滑りして見える
    const dx = this.pos.x - this.prev.x, dy = this.pos.y - this.prev.y;
    const dz = this.pos.z - this.prev.z;
    const flat = Math.hypot(dx, dz);
    if (flat > 1e-5) {
      let h = Math.atan2(dx, dz);
      let diff = h - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      this.heading += diff * Math.min(1, dt * 6);
      // 旋回に合わせて内側へ傾ける。傾かない大型魚は板に見える
      const rate = diff / Math.max(dt, 1e-4);
      const want = THREE.MathUtils.clamp(-rate * 1.6, -0.36, 0.36);
      this.bank += (want - this.bank) * (1 - Math.exp(-1.6 * dt));
      const wantP = THREE.MathUtils.clamp(-Math.atan2(dy, flat), -0.28, 0.28);
      this.pitch += (wantP - this.pitch) * (1 - Math.exp(-2.0 * dt));
    }
  }
}

export class Megalodon {
  /**
   * @param {THREE.Object3D} parent  ぶら下げる先
   * @param {object} opt { env, floorAt, clearAt, yNear, yFar, yOver, rNear, rFar, speed }
   */
  constructor(parent, opt) {
    const geo = buildFishGeometry({
      length: LEN,
      // 体高 18%・体幅 14%。ホホジロザメ(15% / 12%)より一回り太い。
      // 復元では椎骨の直径から、より頑丈な体だったと考えられている
      height: LEN * 0.178,
      width: LEN * 0.140,
      // いちばん太いところが前3分の1。
      //
      // 「小太りに見える」と言われた原因はここだった。太さの頂点の
      // 位置は合っていたが、**後半が細らずに太いまま尾へ突き当たって
      // いた**(t=0.47 でまだ 97%)。ずんどうな胴に小さい尾が付くと、
      // どれだけ大きくしても飛行船にしか見えない。
      // 前を重く、後ろを速く落として、細い尾柄へ絞る
      // また、**吻が短すぎた**。頭が丸く詰まっていると、どれだけ
      // 大きくしても愛嬌が出る。前の4点をぐっと下げて、頭を長い
      // 円錐にする。口はその長い頭の後ろ半分へ切れ込む
      hProfile: [0.13, 0.33, 0.57, 0.78, 0.93, 1.00, 1.00, 0.94,
                 0.85, 0.74, 0.62, 0.49, 0.36, 0.24, 0.155, 0.10],
      // 幅は高さより速く落とす。後ろへ行くほど側扁して、
      // 尾柄で「横に薄い板」になる
      wProfile: [0.11, 0.31, 0.57, 0.79, 0.94, 1.00, 0.98, 0.91,
                 0.80, 0.68, 0.55, 0.42, 0.30, 0.19, 0.12, 0.078],
      // 吻はわずかに体軸より上。下面に口が開くぶん、頭は上へ乗る
      yOffset: [0.12, 0.11, 0.09, 0.065, 0.04, 0.018, 0.0, 0.0,
                0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
      rings: 42, radial: 30,
      sectionMod: megalodonSection,
      // 円錐形の吻。flat が小さいほど尖る(e = 2/flat で cos^e が
      // 速く落ちる)。丸いと愛嬌が出るので、少し尖らせる
      nose: { rings: 10, len: 0.078, flat: 1.02 },
      // 三日月形の尾。lobe を 0 に近づけて上下の葉を揃えるのが要。
      // ここを 0.4 にすると、それだけでジンベエザメの尾になる。
      //
      // height の単位に注意。尾の張り出しは tail.height * 体高 * 2.2 で、
      // **全長ではなく体高**に掛かる。0.82 と書いたら高さ 11m の尾が
      // 生えて、17m の体に帆が立った。実物の尾高は全長の 22% 前後
      tail: { len: 0.145, height: 0.40, fork: 0.80, lobe: 0.05 },
      dorsal: [
        { from: 0.305, to: 0.470, height: 0.88 },   // 第一背びれ(巨大)
        { from: 0.745, to: 0.805, height: 0.12 },   // 第二背びれ(ごく小さい)
      ],
      anal: { from: 0.775, to: 0.840, height: 0.12 },
      // 胸びれ。len は後ろへの後退量、width は外への張り出しで、
      // どちらも**全長に掛かる**。len 0.40 と書いたら 6.8m 後ろへ
      // 流れる翼になった。ひれの実長はこの2つの合成で、
      // 全長の 20% 前後(=3.4m)に収める
      pectoral: { at: 0.225, len: 0.185, width: 0.170,
                  shape: 'falcate', chord: 0.32, droop: 0.22 },
      pelvic: { at: 0.585, len: 0.055, width: 0.055,
                shape: 'falcate', chord: 0.14, droop: 0.26, low: 0.85 },
    });
    this.mat = createFishMaterial({
      pattern: 10,
      len: LEN,
      // ネズミザメ類の泳ぎは体をあまりくねらせない。推進はほぼ尾だけで、
      // 頭から胴までは硬い棒のように保たれる(遊泳形式の名前でいうと
      // thunniform 寄り)。うねりを大きくすると、たちまちウナギになる
      swim: { freq: 1.45, amp: 0.036, waveNum: 0.78, headAmp: 0.07, flapFreq: 1.25 },
      env: opt.env ?? null,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    // 17m の体は、中心が画面の外にあっても体の一部が映る。
    // 自動の視錐台カリングだと、寄られたときに丸ごと消える
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);

    this.patrol = new Patrol({
      speed: opt.speed ?? 3.2,
      seed: 4.71,
      floorAt: opt.floorAt,
      clearAt: opt.clearAt,
      yNear: opt.yNear, yFar: opt.yFar, yOver: opt.yOver,
      rNear: opt.rNear, rFar: opt.rFar,
    });
  }

  get pos() { return this.patrol.pos; }

  update(dt) {
    this.patrol.update(dt);
    this.mesh.position.copy(this.patrol.pos);
    this.mesh.rotation.set(this.patrol.pitch, this.patrol.heading, this.patrol.bank, 'YXZ');
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
