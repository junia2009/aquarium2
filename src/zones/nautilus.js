// ============ ノーチラス号 ============
//
// 海底に横付けされた潜水艦。ヴェルヌの『海底二万里』の船で、姿は
// 1954年の映画版(ハーパー・ゴフの意匠)を下敷きにしている。あの形が
// 「鉄の魚」として今も通じるのは、飾りではなく次の5つが揃っているから:
//
//   ・衝角(ラム)を持つ紡錘形の船体。船首が尖っていて、船として速い形
//   ・背に並ぶ鋸歯。ヴェルヌの本文で船を「巨大な海の怪物」と誤認させた
//     ものの正体で、この輪郭ひとつで遠目にもノーチラスと分かる
//   ・船首の大きな丸窓2つ。魚の目に見える位置にあり、光ると生き物になる
//   ・鋲を打った鉄板の質感。19世紀の工業製品であること
//   ・真鍮の縁取り。鉄一色にすると潜水艦ではなくただの筒になる
//
// 施設が冷たい白で照らされているので、こちらは琥珀色で灯す。
// 同じ色にすると、隣に置いた別の建物にしか見えない。
//
// 最初は施設の外殻と同じ材質で描いていた。形は出たが、近づくと
// **のっぺりした白い風船**だった。曲面に何の割付も無いものは、
// どれだけ形を作り込んでも大きさが読めない——鉄板の継ぎ目と鋲は、
// 模様ではなく「この物体は何メートルか」を伝える唯一の手がかり。
// なので船体には専用の材質を持たせて、板と鋲をそこで描く。

import * as THREE from 'three';
import { UW_FRAG_OUTPUT } from '../glsl.js';

const IRON = [0.088, 0.092, 0.098];
const IRON2 = [0.068, 0.072, 0.078];   // 鉄板の色違い(継ぎ目の段)
const BRASS = [0.190, 0.138, 0.052];
const GLASS_LIT = [0.30, 0.255, 0.14];

// 材質は頂点色の緑成分で見分ける。属性をもう1本足すより、
// 既にある色を判別に使うほうが仕組みが増えない
//   鉄   g ≈ 0.07-0.09    → 板と鋲を描く
//   真鍮 g ≈ 0.138        → 磨いた金属。板は描かない
//   ガラス g ≈ 0.255      → 自分で光る

// 船体の縦断面。[z(船首が+), 半径]
//
// 舳先は「細く長い円錐」ではなく「膨らんだ紡錘＋短い衝角」。
//
// はじめ船体の中ほどから舳先まで 14m かけて素直に絞っていた。
// 断面の並びとしては正しいのだが、斜め前から見ると
// **平らな黒い三角**が一枚立っているようにしか見えなかった。
// 円錐は、どの角度から見ても輪郭が直線になるので形が読めない。
// 太いところを前へ寄せて、輪郭を膨らませ、絞りは最後の3mに集める
const HULL = [
  [14.6, 0.26], [13.4, 0.88], [12.0, 1.54], [10.2, 2.12],
  [8.0, 2.50], [5.0, 2.68], [2.0, 2.74], [-1.5, 2.72],
  [-5.0, 2.52], [-8.5, 2.14], [-11.2, 1.62], [-13.4, 1.00],
  [-15.0, 0.42], [-15.8, 0.18],
];
const SIDES = 20;

/** 断面の形。真円ではなく、縦に少しつぶれている(水中での安定と、船らしさ) */
function section(k, r) {
  const t = (k / SIDES) * Math.PI * 2;
  return [Math.cos(t) * r, Math.sin(t) * r * 0.86];
}

/**
 * ローカル座標(+Z が船首、+Y が上)を世界座標へ移す関数を作る。
 * 姿勢は 横傾き → 縦傾き → 向き の順に掛ける。
 */
function makeXform(origin, heading, pitch, roll) {
  const ch = Math.cos(heading), sh = Math.sin(heading);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  return (x, y, z) => {
    const X = x * cr - y * sr;
    const Y0 = x * sr + y * cr;
    const Y = Y0 * cp - z * sp;
    const Z = Y0 * sp + z * cp;
    return [origin[0] + X * ch + Z * sh, origin[1] + Y, origin[2] - X * sh + Z * ch];
  };
}

/**
 * 船体の材質。船のローカル座標をシェーダの中で作り直せるよう、
 * 姿勢の3軸を定数として焼き込む。
 *
 * 世界座標しか渡ってこないので、船の向きが分からないと板の割付が
 * できない。回転行列は建てるときに決まっていて二度と動かないので、
 * ユニフォームにせず数値で埋める
 */
function nautFrag(origin, ex, ey, ez) {
  const v3 = (a) => `vec3(${a.map((x) => x.toFixed(5)).join(',')})`;
  return /* glsl */ `
    varying vec3 vCol;
    varying vec3 vN;
    varying vec3 vW;
    void main() {
      vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
      vec3 d = vW - ${v3(origin)};
      // 船体ローカル。基底は正規直交なので、内積で戻せる
      vec3 L = vec3(dot(d, ${v3(ex)}), dot(d, ${v3(ey)}), dot(d, ${v3(ez)}));

      float iron = 1.0 - smoothstep(0.105, 0.165, vCol.g);
      float lit  = smoothstep(0.200, 0.240, vCol.g);

      // ---- 鉄板の割付 ----
      // 板は帯状に巻いてある。船首尾方向に「列」、周方向に「枚」。
      // 周方向は本数を固定する。実長で割ると、太いところと細い
      // ところで枚数が変わり、一周したところで継ぎ目が合わない
      float ang = atan(L.y, L.x);
      float rad = max(length(L.xy), 0.25);
      float cz = L.z / 1.45;
      float ca = ang * ${(20 / (Math.PI * 2)).toFixed(5)};
      // 継ぎ目までの近さ。0.5 で継ぎ目の真上
      float dz = abs(fract(cz) - 0.5);
      float da = abs(fract(ca) - 0.5);
      float seam = max(smoothstep(0.415, 0.5, dz), smoothstep(0.435, 0.5, da));

      // 板ごとの色むら。同じ工場の鋼板でも、焼きと錆で一枚ずつ違う。
      // ここの振れ幅が小さいと、継ぎ目を描いても「線を引いた一枚板」に
      // しかならない——板に見えるのは、隣どうしで明るさが違うから
      float plate = hash12(vec2(floor(cz), floor(ca)));
      vec3 alb = vCol * mix(1.0, 0.70 + 0.62 * plate, iron);
      // 板をまたいで広がる汚れ。継ぎ目の格子だけだと図面のようになる
      alb *= mix(1.0, 0.78 + 0.40 * fbm(vec2(ang * 3.0, L.z * 0.42)), iron);
      alb *= mix(1.0, 1.0 - 0.58 * seam, iron);       // 継ぎ目は溝

      // ---- 鋲 ----
      // 継ぎ目に沿って等間隔に並ぶ。これが入って初めて、
      // 曲面に「板を張った」感じと寸法感が出る
      //
      // 鋲の「間隔から中心までの近さ」は smoothstep を逆向きに書かない。
      // GLSL の smoothstep は edge0 >= edge1 のとき未定義で、実際
      // 逆向きに書いていたあいだ鋲は1つも出ていなかった
      float arc = ang * rad;
      float rv = abs(fract(arc / 0.34) - 0.5);        // 周方向の並び
      float rvz = abs(fract(L.z / 0.34) - 0.5);       // 船首尾方向の並び
      float headA = smoothstep(0.42, 0.5, dz) * (1.0 - smoothstep(0.07, 0.20, rv));
      float headB = smoothstep(0.44, 0.5, da) * (1.0 - smoothstep(0.07, 0.20, rvz));
      float rivet = max(headA, headB) * iron;
      // 鋲の頭は半球。上側が明るく下側が暗い——
      // 一様に明るくすると、白い点を等間隔に並べたシールになる。
      // 光の向きは投光器ごとに違うので、面の向きで代用する
      alb *= 1.0 + rivet * (0.85 * max(n.y * 0.5 + 0.5, 0.0) - 0.30);

      // 圧延した鋼の細かいむら。これが無いと、板の中が塗り潰しになる
      alb *= mix(1.0, 0.90 + 0.20 * fbm(vec2(arc * 6.5, L.z * 6.5)), iron);

      // ---- 錆 ----
      // 継ぎ目から下へ垂れる。船なので施設ほど汚れてはいない
      float st = fbm(vec2(arc * 1.9, L.z * 0.30));
      float run = smoothstep(0.52, 0.88, st) * smoothstep(0.30, 0.5, dz)
                  * (1.0 - abs(n.y)) * iron;
      alb = mix(alb, alb * vec3(0.85, 0.52, 0.30), run * 0.55);

      // ---- 付着生物 ----
      // 動く船なので上面だけ薄く。施設のようには覆われない
      float foul = smoothstep(0.35, 0.95, n.y) * (0.3 + 0.7 * fbm(L.xz * 1.3)) * iron;
      alb = mix(alb, vec3(0.075, 0.086, 0.066), foul * 0.30);

      // ---- 光 ----
      vec3 col = alb * (vec3(0.028, 0.043, 0.058) + floodLight(vW, n));
      // 真鍮は磨いてある。すれすれの角度で鈍く返す
      float brass = (1.0 - iron) * (1.0 - lit);
      vec3 v = normalize(cameraPosition - vW);
      col += vCol * brass * pow(max(dot(n, v), 0.0), 3.0) * 0.55;
      // ガラスは自分で光る。船内の灯りは琥珀色——
      // 施設の白と同じ色にすると、隣り合う別棟にしか見えない。
      //
      // 視線との角度で落としすぎない。20m 先だと往路復路で赤が
      // 1/10 まで吸われるので、手前で琥珀に見える強さでは
      // 遠くから見たとき濁った黄土色の楕円になる
      //
      // 桟(さん)を1本入れる。均一に光る楕円は、窓ではなく
      // 船体に貼った発光板に見える。窓が窓に見えるのは、
      // 向こう側に何かがあって、それが手前の桟で切られているから
      float bar = smoothstep(0.40, 0.5, abs(fract(L.z / 0.62) - 0.5));
      vec3 glow = vec3(2.20, 1.06, 0.31) * (0.76 + 0.34 * pow(max(dot(n, v), 0.0), 1.5));
      glow *= 1.0 - 0.62 * bar;
      col = mix(col, glow, lit * 0.90);

      gl_FragColor = vec4(extFog(col, vW), 1.0);
      ${UW_FRAG_OUTPUT}
    }
  `;
}

/**
 * ノーチラス号を建てる。
 *
 * @param {object} M      Buf(v/quad/tri を持つ)。世界座標で積む
 * @param {object} neon   標識灯の収集役
 * @param {object} world  当たり判定(省略可)
 * @param {object} opt    { origin, heading, pitch, roll, strut }
 * @returns {{frag: string, xform: Function}} 船体専用の材質と、座標変換
 */
export function buildNautilus(M, neon, world, opt) {
  const { origin, heading = 0, pitch = 0, roll = 0, strut } = opt;
  const T = makeXform(origin, heading, pitch, roll);
  const V = (x, y, z, col) => { const p = T(x, y, z); return M.v(p[0], p[1], p[2], col); };
  // 船体の半径をその z で引く
  const radAt = (z) => {
    for (let i = 0; i < HULL.length - 1; i++) {
      const [z0, r0] = HULL[i], [z1, r1] = HULL[i + 1];
      if (z <= z0 && z >= z1) {
        const t = (z0 - z) / (z0 - z1);
        return r0 + (r1 - r0) * t;
      }
    }
    return 0.2;
  };
  // その高さ・その位置で、船体の横幅はいくつか。
  //
  // 窓を「半径の何割」で置くと必ず船体に食い込む。断面は縦に
  // つぶれた楕円なので、中心から離れた高さでは横幅が半径より
  // ずっと狭い。実際サロンの大窓は縁だけが外に出て、中の
  // ガラスが船体に埋まり、光らない楕円の輪郭になっていた
  const surfX = (y, z) => {
    const r = radAt(z), ry = r * 0.86;
    const t = Math.min(Math.abs(y) / Math.max(ry, 1e-3), 0.999);
    return r * Math.sqrt(1 - t * t);
  };
  // 材質へ渡す基底。原点を引いた変換に単位ベクトルを通せば出る
  const axis = (x, y, z) => {
    const a = T(x, y, z), o = T(0, 0, 0);
    return [a[0] - o[0], a[1] - o[1], a[2] - o[2]];
  };
  const frag = nautFrag(T(0, 0, 0), axis(1, 0, 0), axis(0, 1, 0), axis(0, 0, 1));

  // ---- 船体 ----
  const rings = HULL.map(([z, r], i) => {
    const col = (i % 2 === 0) ? IRON : IRON2;   // 鉄板の列
    const ring = [];
    for (let k = 0; k < SIDES; k++) {
      const [dx, dy] = section(k, r);
      ring.push(V(dx, dy, z, col));
    }
    return ring;
  });
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < SIDES; k++) {
      const k2 = (k + 1) % SIDES;
      M.quad(rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]);
    }
  }
  // 衝角(ラム)。船首の尖り。短く鋭く
  const ram = V(0, 0.1, 16.6, IRON);
  for (let k = 0; k < SIDES; k++) M.tri(ram, rings[0][(k + 1) % SIDES], rings[0][k]);
  // 艫の蓋
  const stern = V(0, 0, -15.6, IRON2);
  const last = rings[rings.length - 1];
  for (let k = 0; k < SIDES; k++) M.tri(stern, last[k], last[(k + 1) % SIDES]);

  // ---- 背の鋸歯 ----
  //
  // 遠目にノーチラスと分かるのは、ほぼこの輪郭のおかげ。
  // 板を1枚立てて、上の縁をぎざぎざに切る。
  //
  // 最初は歯の間隔 0.75m・高さ 0.78m で、恐竜の背びれになっていた。
  // 「鋸」に見えるのは歯が細かく詰んでいるからで、大きな三角を
  // まばらに並べると別の生き物の意匠になる
  {
    const TH = 0.075, STEP = 0.45;
    const Z0 = 11.2, Z1 = -9.6;
    let prev = null;
    for (let z = Z0, i = 0; z >= Z1; z -= STEP, i++) {
      const base = radAt(z) * 0.86;
      // 端では低くする。切り落としたように終わると、貼り付けた板に見える
      const taper = Math.min(1, (Z0 - z) / 2.2, (z - Z1) / 2.6);
      const tip = base + ((i % 2 === 0) ? 0.46 : 0.17) * Math.max(taper, 0.12);
      const cur = [V(-TH, base - 0.06, z, IRON2), V(TH, base - 0.06, z, IRON2),
                   V(TH, tip, z, IRON), V(-TH, tip, z, IRON)];
      if (prev) {
        for (let j = 0; j < 4; j++) {
          const j2 = (j + 1) % 4;
          M.quad(prev[j], prev[j2], cur[j2], cur[j]);
        }
      }
      prev = cur;
    }
  }

  // ---- 船首の目 ----
  //
  // 「鉄の魚」に見えるかどうかは、ほぼこの2つで決まる。
  // 位置は魚の目のところ——船首の少し後ろ、中心線より上
  for (const sgn of [-1, 1]) {
    const ez = 9.6, ey = 0.66;
    const RN = 14, R0 = 0.50, R1 = 0.72;
    const inn = [], out = [], lip = [];
    for (let k = 0; k < RN; k++) {
      const t = (k / RN) * Math.PI * 2;
      const uy = Math.sin(t), uz = Math.cos(t) * 0.85;
      // 船体の曲面に載せる。平らな板を貼ると浮いて見える
      const y0 = ey + uy * R0, z0 = ez + uz * R0;
      const y1 = ey + uy * R1, z1 = ez + uz * R1;
      inn.push(V(sgn * (surfX(y0, z0) + 0.03), y0, z0, GLASS_LIT));
      out.push(V(sgn * (surfX(y1, z1) + 0.06), y1, z1, BRASS));
      lip.push(V(sgn * (surfX(y1, z1) + 0.26), ey + uy * R1 * 0.9, ez + uz * R1 * 0.9, BRASS));
    }
    for (let k = 0; k < RN; k++) {
      const k2 = (k + 1) % RN;
      M.quad(inn[k], inn[k2], out[k2], out[k]);
      M.quad(out[k], out[k2], lip[k2], lip[k]);
    }
    const hub = V(sgn * (surfX(ey, ez) + 0.02), ey, ez, GLASS_LIT);
    for (let k = 0; k < RN; k++) {
      const k2 = (k + 1) % RN;
      if (sgn > 0) M.tri(hub, inn[k], inn[k2]); else M.tri(hub, inn[k2], inn[k]);
    }
    // 灯りは器具ではなく窓なので、暈だけ小さく添える。
    // 大きく光らせると、船体に貼りついた発光体になる
    neon.add(T(sgn * (surfX(ey, ez) + 0.14), ey, ez), [2.6, 1.35, 0.42], 0.11, 0);
  }

  // ---- 司令塔 ----
  //
  // 直方体にしたら白い箱が載っているだけだった。前を斜めに削いで、
  // 上を絞る。水を切る形になっていないものは船に見えない
  {
    const st = [
      [0.8, 1.16, 0.00], [2.2, 1.20, 0.55], [4.2, 1.14, 0.72],
      [5.6, 0.92, 0.62], [6.5, 0.52, 0.18],
    ];
    const yBase = radAt(3.4) * 0.86 - 0.20;
    const yTop = 4.35;
    const lo = [], hi = [];
    for (const [z, hw, up] of st) {
      lo.push([V(-hw, yBase, z, IRON2), V(hw, yBase, z, IRON2)]);
      hi.push([V(-hw * 0.78, yTop + up * 0.30, z, IRON), V(hw * 0.78, yTop + up * 0.30, z, IRON)]);
    }
    for (let i = 0; i < st.length - 1; i++) {
      M.quad(lo[i][1], lo[i + 1][1], hi[i + 1][1], hi[i][1]);   // 右舷
      M.quad(lo[i + 1][0], lo[i][0], hi[i][0], hi[i + 1][0]);   // 左舷
      M.quad(hi[i][0], hi[i][1], hi[i + 1][1], hi[i + 1][0]);   // 天板
    }
    M.quad(lo[0][0], lo[0][1], hi[0][1], hi[0][0]);             // 後ろ
    const f = st.length - 1;
    M.quad(lo[f][1], lo[f][0], hi[f][0], hi[f][1]);             // 前(斜めに削いだ面)
    // 司令塔の丸窓。左右に2つずつ
    for (const sgn of [-1, 1]) {
      for (const z of [2.4, 4.2]) {
        neon.add(T(sgn * 1.22, yBase + 1.45, z), [2.3, 1.20, 0.36], 0.075, 0);
      }
    }
    // 前照灯。1つだけ白く、前を向いている
    neon.add(T(0, yTop - 0.15, 6.6), [4.6, 4.4, 3.9], 0.13, 0);
    // 空中線。てっぺんに標識灯
    if (strut) {
      const a = T(0, yTop + 0.2, 1.0), b = T(0, yTop + 2.0, -0.8);
      strut(M, [a[0], a[1], a[2]], [b[0], b[1], b[2]], 0.045, BRASS);
      neon.add([b[0], b[1], b[2]], [3.4, 0.55, 0.28], 0.075, 1.4, 0);
    }
  }

  // ---- 舷側の大窓(サロン) ----
  //
  // 原作でネモが海を眺める部屋。船体で一番大きな窓で、
  // ここが光っていると「中に人がいる船」になる
  for (const sgn of [-1, 1]) {
    const cz = 1.8, cy = 0.10, RN = 16;
    const inn = [], out = [];
    for (let k = 0; k < RN; k++) {
      const t = (k / RN) * Math.PI * 2;
      const uy = Math.sin(t) * 0.58, uz = Math.cos(t) * 1.30;
      const y0 = cy + uy, z0 = cz + uz;
      const y1 = cy + uy * 1.22, z1 = cz + uz * 1.14;
      inn.push(V(sgn * (surfX(y0, z0) + 0.03), y0, z0, GLASS_LIT));
      out.push(V(sgn * (surfX(y1, z1) + 0.11), y1, z1, BRASS));
    }
    for (let k = 0; k < RN; k++) {
      const k2 = (k + 1) % RN;
      M.quad(inn[k], inn[k2], out[k2], out[k]);
    }
    const hub = V(sgn * (surfX(cy, cz) + 0.02), cy, cz, GLASS_LIT);
    for (let k = 0; k < RN; k++) {
      const k2 = (k + 1) % RN;
      if (sgn > 0) M.tri(hub, inn[k], inn[k2]); else M.tri(hub, inn[k2], inn[k]);
    }
    neon.add(T(sgn * (surfX(cy, cz) + 0.14), cy, cz), [1.9, 1.05, 0.36], 0.10, 0);
  }

  // ---- 舷窓の列 ----
  // 窓そのものは船体材質のガラス色で光るので、ここは滲みだけ
  for (const sgn of [-1, 1]) {
    for (let z = -7.0; z <= 7.6; z += 1.6) {
      if (Math.abs(z - 1.8) < 1.9) continue;      // 大窓のところは空ける
      const r = radAt(z);
      // 舷窓の本体。真鍮の縁と、その中のガラス
      const RN = 8, PR = 0.20;
      const rimA = [], glA = [];
      for (let k = 0; k < RN; k++) {
        const t = (k / RN) * Math.PI * 2;
        const uy = Math.sin(t), uz = Math.cos(t);
        const yg = 0.35 + uy * PR, zg = z + uz * PR;
        const yr = 0.35 + uy * PR * 1.35, zr = z + uz * PR * 1.35;
        rimA.push(V(sgn * (surfX(yr, zr) + 0.08), yr, zr, BRASS));
        glA.push(V(sgn * (surfX(yg, zg) + 0.02), yg, zg, GLASS_LIT));
      }
      const c = V(sgn * (surfX(0.35, z) + 0.01), 0.35, z, GLASS_LIT);
      for (let k = 0; k < RN; k++) {
        const k2 = (k + 1) % RN;
        M.quad(glA[k], glA[k2], rimA[k2], rimA[k]);
        if (sgn > 0) M.tri(c, glA[k], glA[k2]); else M.tri(c, glA[k2], glA[k]);
      }
      neon.add(T(sgn * (surfX(0.35, z) + 0.10), 0.35, z), [1.6, 0.85, 0.28], 0.045, 0);
    }
  }

  // ---- 潜舵と尾翼 ----
  const fin = (z, dirX, dirY, span, chord, thick) => {
    const r = radAt(z) * (dirY === 0 ? 1 : 0.86);
    const bx = dirX * r * 0.88, by = dirY * r * 0.88;
    const tx = dirX * (r + span), ty = dirY * (r + span);
    const q = [];
    for (const [px, py, cz] of [[bx, by, z - chord], [tx, ty, z - chord * 0.50],
                                [tx, ty, z + chord * 0.42], [bx, by, z + chord]]) {
      q.push([V(px - dirY * thick, py + dirX * thick, cz, IRON2),
              V(px + dirY * thick, py - dirX * thick, cz, IRON2)]);
    }
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      M.quad(q[j][0], q[j2][0], q[j2][1], q[j][1]);
    }
    // 板の面。裏表を閉じないと、真横から見たとき紙のように消える
    M.quad(q[0][0], q[1][0], q[2][0], q[3][0]);
    M.quad(q[3][1], q[2][1], q[1][1], q[0][1]);
  };
  fin(7.6, 1, 0, 2.5, 1.6, 0.16);      // 前部潜舵
  fin(7.6, -1, 0, 2.5, 1.6, 0.16);
  fin(-10.6, 1, 0, 2.2, 2.0, 0.18);    // 尾翼(十字)
  fin(-10.6, -1, 0, 2.2, 2.0, 0.18);
  fin(-10.6, 0, 1, 2.1, 2.0, 0.18);
  fin(-10.6, 0, -1, 1.7, 2.0, 0.18);

  // ---- 推進器 ----
  {
    const pz = -15.4, GR = 1.85;
    const RN = 16;
    const a = [], bb = [];
    for (let k = 0; k < RN; k++) {
      const t = (k / RN) * Math.PI * 2;
      a.push(V(Math.cos(t) * GR, Math.sin(t) * GR, pz + 0.65, IRON2));
      bb.push(V(Math.cos(t) * GR, Math.sin(t) * GR, pz - 0.65, IRON2));
    }
    for (let k = 0; k < RN; k++) {
      const k2 = (k + 1) % RN;
      M.quad(a[k], a[k2], bb[k2], bb[k]);
    }
    // 羽根。4枚をひねって付ける
    for (let b = 0; b < 4; b++) {
      const t = (b / 4) * Math.PI * 2 + 0.4;
      const c = Math.cos(t), s = Math.sin(t);
      const q = [
        V(c * 0.25, s * 0.25, pz + 0.10, BRASS), V(c * 1.65, s * 1.65, pz + 0.42, BRASS),
        V(c * 1.65 - s * 0.5, s * 1.65 + c * 0.5, pz - 0.32, BRASS),
        V(c * 0.25 - s * 0.35, s * 0.25 + c * 0.35, pz - 0.18, BRASS),
      ];
      M.quad(q[0], q[1], q[2], q[3]);
      M.quad(q[3], q[2], q[1], q[0]);
    }
  }

  // ---- 橇(そり) ----
  // 海底に据わっているので、腹で泥に接している。
  // 支えが見えないと「浮いている絵」になる
  if (strut) {
    for (const sgn of [-1, 1]) {
      for (const z of [-6.2, 0, 6.2]) {
        const r = radAt(z);
        const a = T(sgn * r * 0.50, -r * 0.82, z);
        const b = T(sgn * 1.45, -3.02, z);
        strut(M, [a[0], a[1], a[2]], [b[0], b[1], b[2]], 0.20, IRON2);
      }
      const c0 = T(sgn * 1.45, -3.05, -7.4), c1 = T(sgn * 1.45, -3.05, 7.4);
      strut(M, [c0[0], c0[1], c0[2]], [c1[0], c1[1], c1[2]], 0.28, IRON2);
    }
  }

  // ---- 当たり判定 ----
  //
  // 船体をすり抜けられては、そこに在ることにならない。
  // 当たり判定は楕円体の列なので、細長い船体を輪切りにして並べる。
  // 半径は「その z の船体の太さ」そのままではなく、隣との隙間を
  // 埋めるぶんだけ膨らませる——ぴったりで置くと、輪と輪の谷間に
  // 体がはまり込む
  if (world && world.addStatic) {
    const _b = new THREE.Vector3();
    for (let z = -14; z <= 14.5; z += 2.2) {
      const r = Math.max(radAt(z), 0.7);
      const p = T(0, 0, z);
      world.addStatic(_b.set(p[0], p[1], p[2]), r + 0.35, r * 0.86 + 0.35, r + 0.35);
    }
    // 司令塔。背の高い箱なので、船体の輪では覆えない。
    // 楕円体は世界軸に揃うので、船の向きに関わらず効くよう xz は真円で取る
    {
      const p = T(0, 3.3, 3.7);
      world.addStatic(_b.set(p[0], p[1], p[2]), 2.4, 1.5, 2.4);
    }
  }
  return { frag, xform: T };
}
