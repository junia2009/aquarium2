// ============ ノーチラス号 ============
//
// 海底に横付けされた潜水艦。ヴェルヌの『海底二万里』の船で、姿は
// 1954年の映画版——ハーパー・ゴフの意匠に寄せている。
//
// ゴフのノーチラスが「鉄の魚」として今も通じるのは、飾りではなく
// 次の6つが揃っているから。作るときはここを外さない:
//
//   ・銅。鋼の灰色ではない。緑青の浮いた赤銅色が、この船を
//     19世紀の手仕事のものにしている
//   ・全長を貫く鋸歯。舳先の先端から尾まで途切れず走る。
//     本文で船を「巨大な海の怪物」と誤認させたものの正体で、
//     この輪郭ひとつで遠目にもノーチラスと分かる
//   ・腹にも鋸歯。背だけだと背びれのある魚で、上下にあって初めて
//     「刃を並べた機械」になる
//   ・船首の丸窓2つ。せり出した座に載っていて、魚の目に見える
//   ・大きな扇形の尾。細く伸びた艫の先に、団扇のような舵が立つ
//   ・鋲。継ぎ目という継ぎ目に打ってある
//
// 施設が冷たい白で照らされているので、こちらは琥珀で灯し、
// 海底からも暖色で焚く。銅は暖色の下でしか銅に見えない。

import * as THREE from 'three';
import { UW_FRAG_OUTPUT } from '../glsl.js';

// 銅。線形の反射率で持つ。
//
// 実物の銅の反射率は赤が緑のおよそ2倍だが、**その値をそのまま置くと
// 水の中では銅に見えない**。水は赤を緑の3倍近い速さで吸うので、
// 25m 先では赤が 1/4、緑が 3/5 まで落ちる。往路(器具→船)と復路
// (船→目)で二度掛かるから、2:1 の差はあっさり逆転して、
// 画面には黄土色〜オリーブの船が出る。実際そうなった。
//
// なので赤の比率を実物より大きく取る。距離の分だけ前借りしている
// ことになるが、見る場所での色が正しいほうが正しい
const COPPER = [0.330, 0.078, 0.028];
const COPPER2 = [0.250, 0.057, 0.021];   // 銅板の色違い(継ぎ目の段)
const BRASS = [0.360, 0.185, 0.055];
const GLASS_LIT = [0.30, 0.255, 0.14];

// 材質は頂点色の緑成分で見分ける。属性をもう1本足すより、
// 既にある色を判別に使うほうが仕組みが増えない
//   銅     g ≈ 0.068-0.092  → 板と鋲を描く。緑青も浮く
//   真鍮   g ≈ 0.186        → 磨いた金属。板は描かない
//   ガラス g ≈ 0.255        → 自分で光る

// 船体の縦断面。[z(船首が+), 半径]
//
// ゴフの船は「膨らんだ紡錘」ではなく「前寄りに太いところがあって、
// 舳先へ長い衝角、艫へ長く細く伸びる」形。太さの頂点を前へ置き、
// 後ろを長く絞ると、あの前のめりな輪郭になる
const HULL = [
  [16.2, 0.10], [15.0, 0.34], [13.2, 0.80], [11.2, 1.36],
  [9.0, 1.94], [6.0, 2.40], [3.0, 2.64], [0.0, 2.70],
  [-3.0, 2.58], [-6.2, 2.26], [-9.0, 1.82], [-11.4, 1.32],
  [-13.4, 0.86], [-15.4, 0.46], [-17.0, 0.22],
];
const SIDES = 20;
const SQUASH = 0.82;

/** 断面の形。縦につぶし、上下をすぼめる(魚の断面) */
function section(k, r) {
  const t = (k / SIDES) * Math.PI * 2;
  const c = Math.cos(t), s = Math.sin(t);
  return [c * r * (1 - 0.16 * s * s), s * r * SQUASH];
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

      float metal = 1.0 - smoothstep(0.115, 0.170, vCol.g);
      float lit   = smoothstep(0.200, 0.240, vCol.g);

      // ---- 銅板の割付 ----
      // 板は帯状に巻いてある。船首尾方向に「列」、周方向に「枚」。
      // 周方向は本数を固定する。実長で割ると、太いところと細い
      // ところで枚数が変わり、一周したところで継ぎ目が合わない
      float ang = atan(L.y, L.x);
      float rad = max(length(L.xy), 0.25);
      float cz = L.z / 1.32;
      float ca = ang * ${(22 / (Math.PI * 2)).toFixed(5)};
      // 継ぎ目までの近さ。0.5 で継ぎ目の真上
      float dz = abs(fract(cz) - 0.5);
      float da = abs(fract(ca) - 0.5);
      float seam = max(smoothstep(0.405, 0.5, dz), smoothstep(0.425, 0.5, da));

      // 板ごとの色むら。同じ工房で打った銅板でも、焼きと磨きで
      // 一枚ずつ違う。ここの振れ幅が小さいと、継ぎ目を描いても
      // 「線を引いた一枚板」にしかならない
      float plate = hash12(vec2(floor(cz), floor(ca)));
      vec3 alb = vCol * mix(1.0, 0.74 + 0.50 * plate, metal);
      // 板をまたいで広がる汚れ。継ぎ目の格子だけだと図面のようになる
      alb *= mix(1.0, 0.78 + 0.40 * fbm(vec2(ang * 3.0, L.z * 0.42)), metal);
      alb *= mix(1.0, 1.0 - 0.60 * seam, metal);       // 継ぎ目は溝

      // ---- 鋲 ----
      // 継ぎ目に沿って等間隔に並ぶ。これが入って初めて、
      // 曲面に「板を張った」感じと寸法感が出る
      //
      // 鋲の「間隔から中心までの近さ」は smoothstep を逆向きに書かない。
      // GLSL の smoothstep は edge0 >= edge1 のとき未定義で、実際
      // 逆向きに書いていたあいだ鋲は1つも出ていなかった
      float arc = ang * rad;
      float rv = abs(fract(arc / 0.28) - 0.5);        // 周方向の並び
      float rvz = abs(fract(L.z / 0.28) - 0.5);       // 船首尾方向の並び
      float headA = smoothstep(0.40, 0.5, dz) * (1.0 - smoothstep(0.08, 0.22, rv));
      float headB = smoothstep(0.42, 0.5, da) * (1.0 - smoothstep(0.08, 0.22, rvz));
      float rivet = max(headA, headB) * metal;
      // 鋲の頭は半球。上側が明るく下側が暗い——
      // 一様に明るくすると、白い点を等間隔に並べたシールになる
      alb *= 1.0 + rivet * (1.05 * max(n.y * 0.5 + 0.5, 0.0) - 0.34);

      // 打ち出した銅の細かいむら。これが無いと、板の中が塗り潰しになる
      alb *= mix(1.0, 0.90 + 0.20 * fbm(vec2(arc * 6.5, L.z * 6.5)), metal);

      // ---- 緑青 ----
      //
      // 銅を銅に見せているのは、赤銅色そのものより**緑青との対比**。
      // 海水に浸かった銅は必ず青緑に曇り、しかも一様には曇らない
      // ——水の溜まる継ぎ目と上向きの面から先に来る
      float pat = fbm(vec2(arc * 0.85, L.z * 0.55));
      float verd = smoothstep(0.42, 0.80, pat) * metal
                   * (0.35 + 0.65 * max(n.y, 0.0) + 0.5 * seam);
      alb = mix(alb, vec3(0.045, 0.105, 0.088), clamp(verd, 0.0, 1.0) * 0.36);

      // ---- 付着生物 ----
      // 動く船なので上面だけ薄く。施設のようには覆われない
      float foul = smoothstep(0.45, 0.98, n.y) * (0.3 + 0.7 * fbm(L.xz * 1.3)) * metal;
      alb = mix(alb, vec3(0.070, 0.082, 0.062), foul * 0.26);

      // ---- 光 ----
      vec3 col = alb * (vec3(0.030, 0.046, 0.062) + floodLight(vW, n));
      // 磨いた金属はすれすれの角度で鈍く返す。銅も真鍮も
      vec3 v = normalize(cameraPosition - vW);
      float gloss = pow(max(dot(n, v), 0.0), 3.0);
      col += vCol * (1.0 - lit) * gloss * mix(0.62, 0.30, metal);
      // ガラスは自分で光る。船内の灯りは琥珀色——
      // 施設の白と同じ色にすると、隣り合う別棟にしか見えない。
      //
      // 桟(さん)を1本入れる。均一に光る円は、窓ではなく船体に
      // 貼った発光板に見える。窓が窓に見えるのは、向こう側に何かが
      // あって、それが手前の桟で切られているから
      float bar = smoothstep(0.40, 0.5, abs(fract(L.z / 0.62) - 0.5));
      vec3 glow = vec3(2.55, 1.24, 0.38) * (0.78 + 0.32 * pow(max(dot(n, v), 0.0), 1.5));
      glow *= 1.0 - 0.58 * bar;
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
  const W = (x, y, z) => { const p = T(x, y, z); return [p[0], p[1], p[2]]; };
  // 船体の半径をその z で引く
  const radAt = (z) => {
    if (z >= HULL[0][0]) return HULL[0][1];
    for (let i = 0; i < HULL.length - 1; i++) {
      const [z0, r0] = HULL[i], [z1, r1] = HULL[i + 1];
      if (z <= z0 && z >= z1) {
        const t = (z0 - z) / (z0 - z1);
        return r0 + (r1 - r0) * t;
      }
    }
    return 0.18;
  };
  // 船体の上端(=下端)の高さ
  const hullY = (z) => radAt(z) * SQUASH;
  // その高さ・その位置で、船体の横幅はいくつか。
  //
  // 窓を「半径の何割」で置くと必ず船体に食い込む。断面は縦に
  // つぶれた楕円なので、中心から離れた高さでは横幅が半径より
  // ずっと狭い。実際サロンの大窓は縁だけが外に出て、中の
  // ガラスが船体に埋まり、光らない楕円の輪郭になっていた
  const surfX = (y, z) => {
    const r = radAt(z), ry = r * SQUASH;
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
    const col = (i % 2 === 0) ? COPPER : COPPER2;   // 銅板の列
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
  // 衝角(ラム)。長く尖った嘴
  const ram = V(0, 0.05, 17.6, BRASS);
  for (let k = 0; k < SIDES; k++) M.tri(ram, rings[0][(k + 1) % SIDES], rings[0][k]);
  // 艫の蓋
  const stern = V(0, 0, -17.5, COPPER2);
  const last = rings[rings.length - 1];
  for (let k = 0; k < SIDES; k++) M.tri(stern, last[k], last[(k + 1) % SIDES]);

  // ---- 鋸歯の稜 ----
  //
  // 遠目にノーチラスと分かるのは、ほぼこの輪郭のおかげ。
  // 背と腹の両方に、舳先から尾まで途切れず走らせる。
  //
  // 歯は「並べた三角」で作る。以前は帯の上の縁を一つおきに
  // 上下させていたが、それはジグザグであって鋸ではない。
  // 実物の鋸に見えるのは、独立した歯が等間隔に立っているから
  const sawRidge = (zFrom, zTo, dir, step, tooth, lift, th, tip, skip = []) => {
    const inSkip = (z) => skip.some(([a, b]) => z < a && z > b);
    const n = Math.max(2, Math.round((zFrom - zTo) / step));
    const dz = (zFrom - zTo) / n;
    // 連続する土台。歯だけだと、根もとが船体から浮いて見える
    let prev = null;
    for (let i = 0; i <= n; i++) {
      const z = zFrom - dz * i;
      if (inSkip(z)) { prev = null; continue; }
      const y0 = hullY(z) * dir - dir * 0.06;
      const y1 = y0 + dir * lift;
      const cur = [V(-th, y0, z, COPPER2), V(th, y0, z, COPPER2),
                   V(th, y1, z, COPPER), V(-th, y1, z, COPPER)];
      if (prev) {
        for (let j = 0; j < 4; j++) {
          const j2 = (j + 1) % 4;
          M.quad(prev[j], prev[j2], cur[j2], cur[j]);
        }
      }
      prev = cur;
    }
    // 歯
    for (let i = 0; i < n; i++) {
      const za = zFrom - dz * i, zb = zFrom - dz * (i + 1), zm = (za + zb) * 0.5;
      if (inSkip(za) || inSkip(zb)) continue;
      // 端では低くする。切り落としたように終わると、貼り付けた板になる
      const taper = Math.min(1, (zFrom - zm) / 2.0, (zm - zTo) / 2.0, 1);
      const hh = tooth * Math.max(taper, 0.15);
      const ya = hullY(za) * dir + dir * lift;
      const yb = hullY(zb) * dir + dir * lift;
      const ym = hullY(zm) * dir + dir * (lift + hh);
      const l0 = V(-th, ya, za, COPPER2), l1 = V(-th, yb, zb, COPPER2);
      const lm = V(-th * 0.3, ym, zm, tip);
      const r0 = V(th, ya, za, COPPER2), r1 = V(th, yb, zb, COPPER2);
      const rm = V(th * 0.3, ym, zm, tip);
      M.tri(l0, lm, l1);
      M.tri(r0, r1, rm);
      M.quad(l1, lm, rm, r1);       // 後ろの斜面
      M.quad(lm, l0, r0, rm);       // 前の斜面
    }
  };
  // 司令塔と後部構造のところは歯を抜く
  const DECK_GAP = [[11.2, 6.4], [4.8, 1.0]];
  sawRidge(16.4, -12.4, 1, 0.52, 0.38, 0.15, 0.080, BRASS, DECK_GAP);
  sawRidge(15.4, -10.6, -1, 0.52, 0.30, 0.13, 0.075, COPPER2);

  // ---- 舷側の張り出し ----
  //
  // 舳先から胴へ、両舷を長く後ろへ流れる板。参考にした模型で
  // いちばん目を引くのがこれで、船体をただの回転体でなくしている。
  // 縁は鋸歯と揃えて薄く尖らせる
  for (const sgn of [-1, 1]) {
    const st = [
      [14.2, 0.05, -0.10], [12.0, 0.55, -0.32], [9.5, 1.05, -0.50],
      [6.5, 1.35, -0.62], [3.0, 1.45, -0.70], [-0.5, 1.30, -0.66],
      [-3.5, 0.95, -0.55], [-6.0, 0.45, -0.40], [-7.6, 0.05, -0.30],
    ];
    //
    // 高さと色に注意がいる。腹すれすれに真鍮で張ると、海底から
    // 焚いた地明かりを真正面から受けて白く飛び、船の下半分が
    // 黄緑の帯になる。舷の中ほどに上げて、色も銅で通す
    let prev = null;
    for (const [z, out, drop] of st) {
      const y0 = drop * 1.1;
      const xs = surfX(y0, z);
      const cur = [
        V(sgn * (xs - 0.05), y0 + 0.09, z, COPPER2),
        V(sgn * (xs + out), y0 + drop + 0.05, z, COPPER),
        V(sgn * (xs + out), y0 + drop - 0.05, z, COPPER),
        V(sgn * (xs - 0.05), y0 - 0.09, z, COPPER2),
      ];
      if (prev) {
        for (let j = 0; j < 4; j++) {
          const j2 = (j + 1) % 4;
          M.quad(prev[j], prev[j2], cur[j2], cur[j]);
        }
      }
      prev = cur;
    }
  }

  // ---- 舷窓 ----
  //
  // 平らな円を貼るだけだと、船体に描いたシールになる。
  // 実物の耐圧窓は分厚い座の上に載っていて、その座の側面が
  // 影を作るから窓に見える
  const bossWindow = (sgn, cz, cy, R, proj, spokes, glowSize, glowCol) => {
    const RN = 18;
    const base = surfX(cy, cz);
    const root = [], lipO = [], lipI = [], gl = [];
    for (let k = 0; k < RN; k++) {
      const t = (k / RN) * Math.PI * 2;
      const uy = Math.sin(t), uz = Math.cos(t);
      const y = cy + uy * R, z = cz + uz * R;
      root.push(V(sgn * (surfX(y, z) + 0.02), y, z, COPPER2));
      lipO.push(V(sgn * (base + proj), y, z, BRASS));
      lipI.push(V(sgn * (base + proj), cy + uy * R * 0.80, cz + uz * R * 0.80, BRASS));
      gl.push(V(sgn * (base + proj - 0.07), cy + uy * R * 0.78, cz + uz * R * 0.78, GLASS_LIT));
    }
    for (let k = 0; k < RN; k++) {
      const k2 = (k + 1) % RN;
      M.quad(root[k], root[k2], lipO[k2], lipO[k]);   // 座の側面
      M.quad(lipO[k], lipO[k2], lipI[k2], lipI[k]);   // 縁の面
      M.quad(lipI[k], lipI[k2], gl[k2], gl[k]);       // 縁の内側
    }
    const hub = V(sgn * (base + proj - 0.09), cy, cz, GLASS_LIT);
    for (let k = 0; k < RN; k++) {
      const k2 = (k + 1) % RN;
      if (sgn > 0) M.tri(hub, gl[k], gl[k2]); else M.tri(hub, gl[k2], gl[k]);
    }
    // 放射状の桟。ガラスの手前を横切る細い真鍮
    if (spokes && strut) {
      for (let s = 0; s < spokes; s++) {
        const t = (s / spokes) * Math.PI;
        const uy = Math.sin(t) * R * 0.80, uz = Math.cos(t) * R * 0.80;
        strut(M, W(sgn * (base + proj - 0.04), cy + uy, cz + uz),
              W(sgn * (base + proj - 0.04), cy - uy, cz - uz), 0.045, BRASS);
      }
    }
    neon.add(W(sgn * (base + proj + 0.10), cy, cz), glowCol, glowSize, 0);
  };

  // 船首の目。位置は魚の目のところ——舳先の少し後ろ、中心線より上
  for (const sgn of [-1, 1]) {
    bossWindow(sgn, 10.6, 0.72, 0.74, 0.40, 2, 0.20, [4.2, 2.15, 0.62]);
  }
  // サロンの大窓。原作でネモが海を眺める部屋。船体で一番大きな窓で、
  // ここが光っていると「中に人がいる船」になる
  for (const sgn of [-1, 1]) {
    bossWindow(sgn, -0.4, 0.10, 1.16, 0.34, 3, 0.26, [3.2, 1.70, 0.55]);
  }
  // 小さい舷窓の列
  for (const sgn of [-1, 1]) {
    for (const z of [7.2, 5.6, 4.0, -3.2, -4.8, -6.4, -8.0]) {
      bossWindow(sgn, z, 0.42, 0.30, 0.16, 0, 0.10, [2.6, 1.35, 0.42]);
    }
  }

  // ---- 司令塔 ----
  //
  // 参考にした模型では、船首寄りに小さな操舵室が1つ載っているだけ。
  // 大きな箱を置くと、細長い輪郭が途中で折れて船に見えなくなる。
  //
  // ただし「小さく」の下限は人で決まる。はじめ内法 1.55m・長さ 2.8m で
  // 作っていて、これは人が立てない電話ボックスだった。36m の船に
  // それが載っていると、船のほうが模型に見える。舵輪の前に人が立って、
  // 頭上に余裕がある高さ——内法 2.5m を下限にする
  {
    const zc = 9.0, yB = hullY(zc) - 0.10, yT = yB + 2.50;
    const st = [[6.8, 0.80], [7.9, 1.14], [9.9, 1.16], [11.0, 0.74]];
    const lo = [], hi = [];
    for (const [z, hw] of st) {
      lo.push([V(-hw, yB, z, COPPER2), V(hw, yB, z, COPPER2)]);
      hi.push([V(-hw * 0.72, yT, z, COPPER), V(hw * 0.72, yT, z, COPPER)]);
    }
    for (let i = 0; i < st.length - 1; i++) {
      M.quad(lo[i][1], lo[i + 1][1], hi[i + 1][1], hi[i][1]);
      M.quad(lo[i + 1][0], lo[i][0], hi[i][0], hi[i + 1][0]);
      M.quad(hi[i][0], hi[i][1], hi[i + 1][1], hi[i + 1][0]);
    }
    M.quad(lo[0][0], lo[0][1], hi[0][1], hi[0][0]);
    const f = st.length - 1;
    M.quad(lo[f][1], lo[f][0], hi[f][0], hi[f][1]);
    // 天蓋。真鍮の小さなドーム
    {
      const RN = 14, DR = 0.72;
      const rim = [];
      for (let k = 0; k < RN; k++) {
        const t = (k / RN) * Math.PI * 2;
        rim.push(V(Math.cos(t) * DR, yT, zc + Math.sin(t) * DR, BRASS));
      }
      const top = V(0, yT + 0.58, zc, BRASS);
      for (let k = 0; k < RN; k++) M.tri(top, rim[k], rim[(k + 1) % RN]);
    }
    // 操舵室の窓。前と左右
    neon.add(W(0, yB + 1.45, 11.0), [4.4, 2.4, 0.72], 0.14, 0);
    for (const sgn of [-1, 1]) {
      for (const z of [8.2, 9.8]) {
        neon.add(W(sgn * 1.20, yB + 1.45, z), [3.6, 1.9, 0.58], 0.10, 0);
      }
    }
    // 前照灯。舳先を照らす白い1灯
    neon.add(W(0, yB + 0.45, 11.2), [7.0, 6.8, 6.0], 0.18, 0);
    // 空中線とてっぺんの標識灯
    if (strut) {
      strut(M, W(0, yT + 0.50, zc), W(0, yT + 3.2, zc - 1.9), 0.050, BRASS);
      neon.add(W(0, yT + 3.2, zc - 1.9), [4.4, 0.7, 0.35], 0.090, 1.4, 0);
    }
  }

  // ---- 後部の昇降口 ----
  // 甲板に低く伏せた構造。手すりを回すと「人が歩く場所」になる
  {
    const yB = hullY(2.9) - 0.08, yT = yB + 0.78;
    const st = [[1.4, 0.86], [2.4, 1.05], [3.8, 1.05], [4.5, 0.78]];
    const lo = [], hi = [];
    for (const [z, hw] of st) {
      lo.push([V(-hw, yB, z, COPPER2), V(hw, yB, z, COPPER2)]);
      hi.push([V(-hw * 0.82, yT, z, COPPER), V(hw * 0.82, yT, z, COPPER)]);
    }
    for (let i = 0; i < st.length - 1; i++) {
      M.quad(lo[i][1], lo[i + 1][1], hi[i + 1][1], hi[i][1]);
      M.quad(lo[i + 1][0], lo[i][0], hi[i][0], hi[i + 1][0]);
      M.quad(hi[i][0], hi[i][1], hi[i + 1][1], hi[i + 1][0]);
    }
    M.quad(lo[0][0], lo[0][1], hi[0][1], hi[0][0]);
    M.quad(lo[3][1], lo[3][0], hi[3][0], hi[3][1]);
    // 手すり
    if (strut) {
      for (const sgn of [-1, 1]) {
        const posts = [1.5, 2.6, 3.7, 4.4];
        for (const z of posts) {
          strut(M, W(sgn * 0.95, yT, z), W(sgn * 0.95, yT + 1.05, z), 0.035, BRASS);
        }
        for (const h of [0.55, 1.05]) {
          strut(M, W(sgn * 0.95, yT + h, posts[0]),
                W(sgn * 0.95, yT + h, posts[posts.length - 1]), 0.032, BRASS);
        }
      }
    }
    neon.add(W(0, yT + 0.12, 2.9), [2.8, 1.5, 0.48], 0.11, 0);
  }

  // ---- 甲板の航行灯 ----
  // 灯りの列が船の長さをなぞる。ライトアップはこれが効く
  for (let z = 12.6; z >= -11.0; z -= 1.5) {
    if (z < 10.8 && z > 7.2) continue;
    if (z < 4.8 && z > 1.0) continue;
    for (const sgn of [-1, 1]) {
      const y = hullY(z) * 0.92;
      neon.add(W(sgn * surfX(y, z) * 0.55, y, z), [1.9, 1.05, 0.34], 0.055, 0);
    }
  }

  // ---- 潜舵 ----
  const fin = (z, dirX, dirY, span, chord, thick, sweep) => {
    const r = dirY === 0 ? surfX(0, z) : hullY(z);
    const bx = dirX * r * 0.9, by = dirY * r * 0.9;
    const tx = dirX * (r + span), ty = dirY * (r + span);
    const q = [];
    for (const [px, py, cz] of [[bx, by, z - chord], [tx, ty, z - chord - sweep],
                                [tx, ty, z + chord * 0.42 - sweep], [bx, by, z + chord]]) {
      q.push([V(px - dirY * thick, py + dirX * thick, cz, COPPER2),
              V(px + dirY * thick, py - dirX * thick, cz, COPPER2)]);
    }
    for (let j = 0; j < 4; j++) {
      const j2 = (j + 1) % 4;
      M.quad(q[j][0], q[j2][0], q[j2][1], q[j][1]);
    }
    // 板の面。裏表を閉じないと、真横から見たとき紙のように消える
    M.quad(q[0][0], q[1][0], q[2][0], q[3][0]);
    M.quad(q[3][1], q[2][1], q[1][1], q[0][1]);
  };
  fin(6.4, 1, 0, 2.4, 1.5, 0.14, 0.9);      // 前部潜舵
  fin(6.4, -1, 0, 2.4, 1.5, 0.14, 0.9);
  fin(-9.6, 1, 0, 2.0, 1.5, 0.14, 0.8);     // 後部の水平舵
  fin(-9.6, -1, 0, 2.0, 1.5, 0.14, 0.8);

  // ---- 尾 ----
  //
  // ゴフの船の後ろ姿を決めているのは、細く伸びた艫の先に立つ
  // **大きな扇**。十字の尾翼を4枚置くのとはまったく別の輪郭になる。
  // 上の縁は背の鋸歯からそのまま続き、後ろの縁も鋸で切ってある
  {
    const TH = 0.11;
    // [z, 上端, 下端]
    const prof = [
      [-11.6, 1.30, -1.10], [-13.2, 2.60, -1.95], [-14.8, 3.65, -2.55],
      [-16.2, 4.15, -2.85], [-17.4, 4.05, -2.70], [-18.4, 3.20, -2.05],
      [-19.0, 2.10, -1.30],
    ];
    let prev = null;
    for (const [z, up, dn] of prof) {
      const cur = [V(-TH, up, z, COPPER), V(TH, up, z, COPPER),
                   V(TH, dn, z, COPPER2), V(-TH, dn, z, COPPER2)];
      if (prev) {
        for (let j = 0; j < 4; j++) {
          const j2 = (j + 1) % 4;
          M.quad(prev[j], prev[j2], cur[j2], cur[j]);
        }
      }
      prev = cur;
    }
    // 扇の骨。中心から放射状に走る真鍮の筋。
    //
    // 板の中心線(x=0)に置くと板の中に埋まって1本も見えない。
    // 骨は板の**外側**に張るもので、そうでないと骨の意味が無い
    if (strut) {
      for (const [z, up, dn] of prof.slice(1, 6)) {
        for (const sgn of [-1, 1]) {
          const x = sgn * (TH + 0.045);
          strut(M, W(x, dn * 0.35, -11.9), W(x, up - 0.20, z), 0.050, BRASS);
          strut(M, W(x, dn * 0.35, -11.9), W(x, dn + 0.20, z), 0.045, BRASS);
        }
      }
    }
    // 後ろの縁の鋸歯。厚みを持たせる——
    // 表裏を同じ面に重ねると、深度が競って画面でちらつく
    for (let i = 0; i < 9; i++) {
      const t = i / 9, t2 = (i + 1) / 9;
      const y0 = 3.9 - t * 6.3, y1 = 3.9 - t2 * 6.3;
      const zc = -17.9 - Math.sin(t * Math.PI) * 0.7;
      const zc2 = -17.9 - Math.sin(t2 * Math.PI) * 0.7;
      const ym = (y0 + y1) * 0.5, zm = (zc + zc2) * 0.5 - 0.55;
      const L = [V(-TH, y0, zc, COPPER2), V(-TH, y1, zc2, COPPER2),
                 V(-TH * 0.35, ym, zm, BRASS)];
      const R = [V(TH, y0, zc, COPPER2), V(TH, y1, zc2, COPPER2),
                 V(TH * 0.35, ym, zm, BRASS)];
      M.tri(L[0], L[2], L[1]);
      M.tri(R[0], R[1], R[2]);
      M.quad(L[1], L[2], R[2], R[1]);
      M.quad(L[2], L[0], R[0], R[2]);
    }
    neon.add(W(0, 3.2, -16.0), [2.2, 1.15, 0.36], 0.10, 0);
  }

  // ---- 推進器 ----
  // 扇の前に隠れる位置。真鍮の4枚羽根
  {
    const pz = -11.2;
    for (let b = 0; b < 4; b++) {
      const t = (b / 4) * Math.PI * 2 + 0.4;
      const c = Math.cos(t), s = Math.sin(t);
      const q = [
        V(c * 0.22, s * 0.22, pz + 0.10, BRASS), V(c * 1.30, s * 1.30, pz + 0.38, BRASS),
        V(c * 1.30 - s * 0.42, s * 1.30 + c * 0.42, pz - 0.30, BRASS),
        V(c * 0.22 - s * 0.30, s * 0.22 + c * 0.30, pz - 0.16, BRASS),
      ];
      M.quad(q[0], q[1], q[2], q[3]);
      M.quad(q[3], q[2], q[1], q[0]);
    }
  }

  // ---- 橇(そり) ----
  // 海底に据わっているので、腹で泥に接している。
  // 支えが見えないと「浮いている絵」になる。
  // 腹には鋸歯が並んでいるので、脚はその外側から出す
  //
  // はじめ長い橇を2本、船の全長に渡して敷いていた。支えとしては
  // 正しいのだが、画面では**竹を組んだ足場**にしか見えなかった。
  // 細い横棒が船体の前を長く横切ると、船より足場のほうが目に入る。
  // 短い脚を4本、接地板をつけて下ろすだけにする
  if (strut) {
    for (const sgn of [-1, 1]) {
      for (const z of [-5.2, 5.6]) {
        const yb = -hullY(z) * 0.68;
        const foot = [sgn * 1.9, -3.42, z];
        strut(M, W(sgn * surfX(yb, z) * 0.88, yb, z), W(...foot), 0.22, COPPER2);
        // 接地板。泥に沈みかけた短い裾にして、上向きの平らな面を作らない
        strut(M, W(foot[0], foot[1] + 0.30, foot[2]),
              W(foot[0], foot[1] - 0.22, foot[2]), 0.62, COPPER2);
      }
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
    for (let z = -16; z <= 16; z += 2.2) {
      const r = Math.max(radAt(z), 0.7);
      const p = T(0, 0, z);
      world.addStatic(_b.set(p[0], p[1], p[2]), r + 0.35, r * SQUASH + 0.45, r + 0.35);
    }
    // 司令塔と尾の扇。細長い船体の輪では覆えない。
    // 楕円体は世界軸に揃うので、船の向きに関わらず効くよう xz は真円で取る
    for (const [z, y, rr, ry] of [[9.0, 2.9, 2.3, 1.5], [-16.0, 0.8, 3.4, 3.6]]) {
      const p = T(0, y, z);
      world.addStatic(_b.set(p[0], p[1], p[2]), rr, ry, rr);
    }
  }
  return { frag, xform: T };
}
