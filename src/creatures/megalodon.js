// ============ メガロドン ============
//
// Otodus megalodon。復元は文献の数字から起こす。
// 「サメっぽい形」で始めて手直しを重ねると、いつまでも収束しない。
//
// 拠りどころにした3本:
//
//  [1] Cooper, Pimiento, Ferrón & Benton (2020)
//      "Body dimensions of the extinct giant shark Otodus megalodon:
//       a 2D reconstruction", Scientific Reports 10:14596
//      現生ネズミザメ類5種から外挿した部位寸法。全長 16m の個体で
//      頭部 4.65m・第一背びれ高 1.62m・尾高 3.85m。
//      → 全長比で 頭 29% / 背びれ 10% / 尾 24%
//
//  [2] Cooper et al. (2022)
//      "The extinct shark Otodus megalodon was a transoceanic
//       superpredator: Inferences from 3D modeling", Sci. Adv. 8
//      **吻はホホジロザメより丸く湾曲していた**と明記されている。
//      胴があれほど鋭く鼻先へ絞れないため。頭部は頑丈で、
//      大型の獲物を扱う造り
//
//  [3] Shimada et al. (2025), Palaeontologia Electronica
//      現生145種＋化石20種の体部比データベースとの照合。
//      体型は**レモンザメ(Negaprion brevirostris)に近い細身**で、
//      ホホジロザメの拡大版ではない。最大全長 24.3m(94t)、
//      巡航速度 2.1〜3.5 km/h(≒0.6〜1.0 m/s)でホホジロザメ並み
//
// ここから外していたもの(実際に指摘された順):
//   ・体高/体幅が倍。height/width は半値なのを見落としていた
//   ・吻を尖らせた。[2][3] のとおり**逆**で、短く丸い吻が正しい
//     (レモンザメの種小名 brevirostris がまさに「短い吻」)
//   ・巡航 3.2m/s は速すぎ。[3] の 3 倍
//
// 意匠として1点だけ文献から外す: 全長は 24m とる。
// [3] の「科学的に正当化できる最大」24.3m のほぼ上限で、
// プロテウスの殻(直径 27m)と並べて負けない大きさがここから始まる。

import * as THREE from 'three';
import { buildFishGeometry } from './fishGeometry.js';
import { createFishMaterial } from './fishMaterial.js';
import { wander1 } from '../noise.js';

// 胴の長さ。尾と吻がこれに足されて、全長はおよそ 23.5m になる
const LEN = 20.0;

// 体高・体幅の半値。断面は yc ± H*profile / ±W*profile に広がる
const H = LEN * 0.132;
const W = LEN * 0.082;

// 尾の付け根が体軸方向に占める割合。当たり判定の節を体軸に置くとき、
// 形状側と同じ式を使わないと、節が体からずれる
const TAIL_LEN = 0.145;

// 腹を平らに、背を弓なりに。
//
// 輪郭が上下対称だと、太さが正しくても「レンズ」に見える。
// 実物は腹の線がほぼまっすぐで、深さは背が反ることで出ている。
// 細いところ(頭と尾)ほど体軸を上げると、下端が揃って腹が平らになる。
//
// 当たり判定の節もこの軸に乗せるので、モジュール定数に出してある
const Y_OFFSET = [0.21, 0.144, 0.090, 0.045, 0.015, 0.0, 0.0, 0.012,
                  0.033, 0.060, 0.090, 0.123, 0.159, 0.195, 0.231, 0.261];

// ---- 当たり判定に使う体の節 ----
//
// 24m の体を1個の楕円体で包むと、頭と尾のあいだの何もない空間まで
// 硬くなる(体の外を泳いでいるのに弾かれる)。逆に節が粗いと、
// 節と節の隙間を通り抜けられてしまう。
//
// t は体軸(0=吻・1=尾)。r は球の半径で、その位置の体幅(=細いほう)と
// 体高(=太いほう)の中間を採る。楕円体を向きに合わせて回すこともできるが
// (addDynamic の oriented)、それは heading しか見ないので、
// 傾いたり潜ったりしているあいだ判定が体からずれる。球なら向きに
// よらないので、姿勢がどうであれ体の中に収まる。
//
// 間隔は 0.12(=2.35m)。中央の球は半径 1.5 前後あるので隣と重なり、
// 隙間はできない。細い両端だけは重なりが切れるが、そこは実際に
// 体も細いので、多少すり抜けても不自然ではない
//
// 半径は輪郭表から出す。体を太らせたら、ここも一緒に太らせないと
// 判定だけ痩せたままになる(体の中に手が入る)
const SEGMENTS = [
  [0.05, 0.97], [0.17, 1.69], [0.29, 2.05], [0.41, 2.11],
  [0.53, 1.94], [0.66, 1.62], [0.79, 1.12], [0.91, 0.76],
];

/** 折れ線として輪郭表を読む(体軸 0..1 → 表の値) */
function sampleLinear(arr, t) {
  const f = THREE.MathUtils.clamp(t, 0, 1) * (arr.length - 1);
  const i = Math.min(Math.floor(f), arr.length - 2);
  return THREE.MathUtils.lerp(arr[i], arr[i + 1], f - i);
}

/**
 * 断面の変形。楕円だけでは出せない3つを足す。
 *   ・頭は幅広で丸い([2])
 *   ・腹は平ら
 *   ・尾柄の左右にキール
 */
function megalodonSection(x, y, t) {
  // --- 頭は「幅広で、丸い」 ---
  //
  // [2] は吻が丸く湾曲していたとする。上下に強くつぶすと角ばった
  // 楔になってしまうので、幅だけ少し出して、つぶしはごく浅く。
  // 眼の上の稜(まゆ)だけは残す——ここが無いと顔が球になる
  const head = 1 - THREE.MathUtils.smoothstep(t, 0.02, 0.30);
  let sx = x * (1 + 0.14 * head);
  let sy = y * (1 - 0.07 * head);
  const brow = Math.max(y, 0);
  sy *= 1 - 0.12 * brow * brow * head;

  // --- 平らな腹 ---
  // 下半分だけ、外へ向かって押し戻す。丸いままだと浮き袋に見える
  const bel = Math.max(-y, 0);
  sy *= 1 - 0.18 * bel * bel * THREE.MathUtils.smoothstep(t, 0.08, 0.32);

  // --- 尾柄のキール ---
  //
  // 体側の中ほど(y≈0)から水平に張り出す隆起。ただし**隆起であって
  // ヘラではない**。ここを 0.70(=幅 1.7倍)にしていたせいで、
  // 体の後ろ 1/3 が体高より体幅のほうが大きくなっていた:
  //
  //   吻から 64%TL … 体高 2.30m / 体幅 2.51m
  //
  // 横に平たい板を後ろに引きずっている形で、どの角度から見ても
  // 「細長い」になる。実物のネズミザメ類のキールは体幅の数%しかない
  // 細い稜で、尾柄そのものは**縦に厚い**。
  const keel = THREE.MathUtils.smoothstep(t, 0.58, 0.84)
             * (1 - THREE.MathUtils.smoothstep(t, 0.94, 1.02));
  sx *= 1 + 0.20 * keel * Math.exp(-Math.pow(y / 0.22, 2));
  // 縦のつぶしも効きすぎていた。0.34 は「尾柄を薄く」ではなく
  // 「後ろ半分を薄く」になっていて、70%TL の体高が最大の 39% まで
  // 落ちていた(輪郭表の値は 52% のはず＝つぶしぶんが丸ごと余計)
  sy *= 1 - 0.12 * keel;

  return [sx, sy];
}

/**
 * 施設のまわりを回遊する。
 *
 * 位置は角度と半径から解析的に出す。ボイドや自由なさまよいにしないのは、
 * ここが「建てたものが詰まっている水域」だから——柱・やぐら・潜水艦・
 * 観測所を、24m の体で毎回よけさせるより、通る道のほうを決めるほうが
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
    // 角速度。半径が小さいほど速く回ってしまうので、半径で割る
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
      // **height / width は半値**(断面は yc ± height*profile)。
      //
      // ここは3回書き直している。0.178(体高が全長の 30%)→ 0.096
      // (16%)→ 0.111(18.5%)。行って戻ってきた。
      //
      // 16% は**痩せすぎ**だった。細身に寄せる根拠は [3] にあるが、
      // 出来上がりの体積を出してみると 70m³ ≒ 74t で、
      // [3] 自身の推定(24.3m で 94t、23.5m に換算して 85t)を
      // 13% 下回っていた。**いちばん細い論文より細い**のは、
      // もう解釈ではなく間違い。
      //
      // 復元の幅は論文間でかなり広い。同じ 24m でも
      //   [1] Cooper 2020 系(ホホジロザメ型) …… 190t 相当
      //   [3] Shimada 2025 系(細身)         …… 94t
      //
      // 18.5% でもまだ細いと言われた。細く見えていた原因の半分は
      // キール(下の megalodonSection を見よ)だったが、残り半分は
      // 素直に太さ不足。**細いほうの端に張り付くのをやめて、
      // 2つの復元の中間に置く**——体高 20.5% / 体幅 14.0%、
      // 体積 132m³ ≒ 138t。[3] の 94t と [1] の 190t のあいだ
      // 3倍近く違う。細いほうの端に寄せつつ、その下には出ない
      // ——体高 18.5%・体幅 12.5% で体積 102m³ ≒ 107t。
      // ホホジロザメの体高(18〜19%)と同じで、[3] のすぐ上に立つ
      height: LEN * 0.132,
      width: LEN * 0.082,
      // 太さの頂点は前3分の1。そこから尾柄までは、曲線で落とすより
      // **まっすぐ長く**落とす。後半が太いまま尾へ突き当たると、
      // どれだけ大きくしても飛行船に見える。
      //
      // 前を細く長く引くのも間違い。それは鋭い吻のアオザメ型で、
      // [2][3] は逆——頭は短く、吻の手前まで胴の太さが残っている
      //
      // 後半の落ち方も緩めた。太さの数字だけ上げても、頂点のすぐ後ろから
      // 絞り始めると**紡錘のまま太った**だけで、力のある体には見えない。
      // 胴の厚みが尾柄の手前まで残っているのが大型のサメの輪郭
      hProfile: [0.30, 0.52, 0.71, 0.86, 0.96, 1.00, 1.00, 0.98,
                 0.93, 0.86, 0.77, 0.66, 0.53, 0.39, 0.25, 0.14],
      // 幅は高さより速く落とす。後ろへ行くほど側扁して、
      // 尾柄で「横に薄い板」になる
      wProfile: [0.26, 0.50, 0.71, 0.87, 0.97, 1.00, 1.00, 0.97,
                 0.91, 0.83, 0.72, 0.60, 0.45, 0.31, 0.18, 0.10],
      yOffset: Y_OFFSET,   // 腹を平らに、背を弓なりに(定義は上)
      rings: 42, radial: 30,
      sectionMod: megalodonSection,
      // 短く丸い吻。flat が**大きいほど鈍る**(e = 2/flat で
      // cos^e の落ちが緩む)。1.02 まで下げて尖らせたのが誤りで、
      // [2] のとおり丸く、[3] のレモンザメ(brevirostris=短い吻)に
      // ならって短くする
      nose: { rings: 9, len: 0.042, flat: 2.6 },
      // 三日月形の尾。lobe を 0 に近づけて上下の葉を揃えるのが要。
      // ここを 0.4 にすると、それだけでジンベエザメの尾になる。
      //
      // height の単位に注意。尾の張り出しは tail.height * 体高 * 2.2 で、
      // **全長ではなく体高**に掛かる。[1] の尾高 24% に合わせてある
      //
      // 体高を 16%→18.5% に上げたので、ここは**下げる**。
      // 体高に比例する寸法(尾・背びれ・臀びれ)を据え置くと、
      // 胴を太らせただけでひれまで一緒に育ってしまう。
      // 0.60 * 体高(4.44m) * 2.2 = 5.86m ＝ 全長の 24.9%
      tail: { len: 0.145, height: 0.51, fork: 0.78, lobe: 0.06 },
      dorsal: [
        // 第一背びれ。[1] の全長 10% を保つ——高さの単位は**体高**なので、
        // 体高を上げたぶんこちらを下げる。1.08 * 2.22 = 2.40m ＝ 10.2%
        { from: 0.335, to: 0.505, height: 0.91 },
        { from: 0.755, to: 0.815, height: 0.16 },   // 第二背びれ(ごく小さい)
      ],
      anal: { from: 0.785, to: 0.850, height: 0.16 },
      // 胸びれ。len は後ろへの後退量、width は外への張り出しで、
      // どちらも**全長に掛かる**(半値ではない)。ひれの実長は
      // その2つの合成で、全長の 18% 前後(=4.3m)に収める。
      // 一度 24% まで伸ばしたら「翼のある魚」になった
      pectoral: { at: 0.235, len: 0.155, width: 0.150,
                  shape: 'falcate', chord: 0.28, droop: 0.28 },
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
    // 24m の体は、中心が画面の外にあっても体の一部が映る。
    // 自動の視錐台カリングだと、寄られたときに丸ごと消える
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);

    this.patrol = new Patrol({
      speed: opt.speed ?? 1.5,
      seed: 4.71,
      floorAt: opt.floorAt,
      clearAt: opt.clearAt,
      yNear: opt.yNear, yFar: opt.yFar, yOver: opt.yOver,
      rNear: opt.rNear, rFar: opt.rFar,
    });

    // ---- 当たり判定 ----
    //
    // 節ごとに { pos } を持つ小さな入れ物を作って、CollisionWorld に
    // 動く球として登録する。あとは毎フレーム pos を書き換えるだけで、
    // 押し出しは向こうがやってくれる。
    //
    // 節の局所座標は、形状を組むときと同じ式から出す——
    // z は zNose - tt*(L - tail.len*L*0.15)、y は yOffset*H。
    // ここを目分量で書くと、体型を直すたびに判定だけ取り残される
    this.segments = [];
    if (opt.world) {
      const zNose = LEN / 2;
      const span = LEN - TAIL_LEN * LEN * 0.15;
      for (const [tt, r] of SEGMENTS) {
        const seg = {
          pos: new THREE.Vector3(),
          local: new THREE.Vector3(0, sampleLinear(Y_OFFSET, tt) * H, zNose - tt * span),
        };
        this.segments.push(seg);
        opt.world.addDynamic(seg, r, r, r);
      }
      this._syncSegments();
    }
  }

  get pos() { return this.patrol.pos; }

  /** 節の世界座標を、いまの姿勢から作り直す */
  _syncSegments() {
    if (!this.segments.length) return;
    this.mesh.updateMatrixWorld(true);
    for (const seg of this.segments) {
      seg.pos.copy(seg.local).applyMatrix4(this.mesh.matrixWorld);
    }
  }

  update(dt) {
    this.patrol.update(dt);
    this.mesh.position.copy(this.patrol.pos);
    this.mesh.rotation.set(this.patrol.pitch, this.patrol.heading, this.patrol.bank, 'YXZ');
    this._syncSegments();
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
