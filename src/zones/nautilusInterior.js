// ============ ノーチラス号の船内 ============
//
// 外から眺めるだけの船は、大きさの物差しにはなっても、行き先には
// ならない。中に入れて初めて「停泊している船」になる。
//
// 入れるようにするために要ったのは、飾りではなく次の4つ:
//
//  1) 船体の外板を**片面**にする。裏面を描かなければ、中からは
//     外板が見えず、そのまま海が見える。穴を開けて回るより確実で、
//     しかも三角形が半分になる
//  2) 内張り(甲板・腰板・天井)を別に張る。外板を片面にしただけだと、
//     船の中が「海に浮かんだ家具の集まり」になる
//  3) 大窓のガラスを不透明の発光板から**透明**に変える。ここを
//     抜けて海が見えることが、この部屋の全部
//  4) 昇降口。外板に本当に穴を開ける唯一の場所
//
// 内装はゴフの意匠と原作に沿える。ヴェルヌのサロンは
// 「博物館であり客間であり、ネモが海を眺める場所」で、
// 映画版はそこに**パイプオルガン**を置いた。この3つ——
// 大窓・陳列棚・オルガン——が揃っていれば、それはサロンに見える。

import { UW_FRAG_OUTPUT } from '../glsl.js';

// 船体ローカルでの寸法。船体側(nautilus.js)と同じ数字を使うので、
// 片方だけ直すと内張りが外板を突き抜ける
export const IN = {
  deck: -1.15,       // 甲板の高さ。中央で頭上 3.3m、両端で 3.0m
  zFwd: 7.0,         // 前の隔壁
  zAft: -6.0,        // 後ろの隔壁。ここにオルガンが付く
  liner: 0.10,       // 内張りを外板の内側どれだけに張るか
  // 昇降口。**ここだけは外板に本当に穴を開ける**。
  //
  // 大きさは意匠ではなく、通れるかどうかで決まる。当たり判定の
  // カメラは半径 0.6m の球なので、通り道は最低でも 1.2m + 余裕が要る。
  // はじめ実物の潜水艦の昇降筒(直径 0.7m)に寄せて作ったら、
  // 玉が引っかかって一度も入れなかった
  hatchZ0: 1.88, hatchZ1: 4.32,
  hatchHalf: 1.32,
  // サロンの大窓。外板側の bossWindow と同じ位置・同じ半径
  win: { z: -0.4, y: 0.10, r: 1.16 },
};

// 内装の色。線形の反射率。
// 材質は頂点色の緑成分で見分ける——外板と同じ流儀
//   板     g < 0.14
//   真鍮   g ≈ 0.185
//   発光   g > 0.22
const WOOD = [0.105, 0.048, 0.022];    // クルミの腰板
const WOOD2 = [0.076, 0.033, 0.015];   // 影の入る面
const DECK_C = [0.140, 0.075, 0.036];  // 甲板。腰板より明るい
const BRASS = [0.360, 0.185, 0.055];
const LAMP = [0.34, 0.255, 0.13];      // 灯りの球
const CASE = [0.16, 0.235, 0.20];      // 陳列棚のガラス。青緑に光る

/**
 * 船内の材質。
 *
 * 外の投光器は中まで届かないので、こちらは船の灯りだけで照らす。
 * 灯りは船体ローカルで置いて、シェーダの中で世界座標へ移す——
 * 姿勢は建てるときに決まって二度と動かないので、定数で焼き込める。
 *
 * 面ごとの法線で陰影を付けるが、**頂点は粗くてよい**。
 * 光は断片ごとに世界座標から計算するので、平らな板を1枚置いても
 * その上に光の溜まりがちゃんと出る
 */
export function nautInFrag(origin, ex, ey, ez, lamps) {
  const v3 = (a) => `vec3(${a.map((x) => x.toFixed(5)).join(',')})`;
  // 灯りを世界座標へ移して焼き込む
  const L2W = (p) => [
    origin[0] + ex[0] * p[0] + ey[0] * p[1] + ez[0] * p[2],
    origin[1] + ex[1] * p[0] + ey[1] * p[1] + ez[1] * p[2],
    origin[2] + ex[2] * p[0] + ey[2] * p[1] + ez[2] * p[2],
  ];
  const body = lamps.map((L) => {
    const w = L2W(L.p);
    return `s += lamp1(vW, n, ${v3(w)}, ${L.k.toFixed(3)});`;
  }).join('\n      ');

  return /* glsl */ `
    varying vec3 vCol;
    varying vec3 vN;
    varying vec3 vW;

    // 船内の灯り。白熱の球なので全方位。距離の二乗で落として、
    // 水の吸収は掛けない——空気の中だから
    vec3 lamp1(vec3 wp, vec3 n, vec3 lp, float k) {
      vec3 d = lp - wp;
      float dist = length(d);
      vec3 L = d / max(dist, 0.001);
      float att = k / (1.0 + 0.30 * dist + 0.22 * dist * dist);
      // 半球ラップ。裸電球1個の部屋でも、床や壁で回った光が
      // 影の側にわずかに入る。ここを 0 にすると陰が墨になる
      float ndl = max(dot(n, L), 0.0) * 0.82 + 0.18;
      return vec3(1.00, 0.62, 0.26) * (ndl * att);
    }

    void main() {
      vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
      vec3 d = vW - ${v3(origin)};
      vec3 P = vec3(dot(d, ${v3(ex)}), dot(d, ${v3(ey)}), dot(d, ${v3(ez)}));

      float brass = smoothstep(0.150, 0.175, vCol.g) * (1.0 - smoothstep(0.200, 0.225, vCol.g));
      float lit   = smoothstep(0.225, 0.245, vCol.g);
      float wood  = 1.0 - smoothstep(0.120, 0.145, vCol.g);

      vec3 alb = vCol;

      // ---- 甲板の板張り ----
      // 上を向いた面だけ。板は船首尾方向に走るので、幅は x で刻む。
      // 継ぎ目に槇皮(まいはだ)の黒い筋が入るのが木甲板の顔
      float up = smoothstep(0.60, 0.90, n.y);
      float pw = abs(fract(P.x / 0.165) - 0.5);
      float seam = 1.0 - smoothstep(0.36, 0.50, pw);
      alb *= mix(1.0, 1.0 - 0.55 * (1.0 - seam), up);
      // 板ごとの色むら。同じ木でも一枚ずつ違う
      alb *= mix(1.0, 0.80 + 0.40 * hash12(vec2(floor(P.x / 0.165), 3.0)), up * wood);
      // 木目。板の長手に沿って流れる細い縞
      alb *= mix(1.0, 0.88 + 0.24 * fbm(vec2(P.z * 2.2, P.x * 22.0)), wood);

      // ---- 腰板の羽目 ----
      // 立った面。船首尾方向に一定の間隔で縦の目地が入る
      float side = 1.0 - up;
      float pz = abs(fract(P.z / 0.62) - 0.5);
      alb *= mix(1.0, 1.0 - 0.30 * (1.0 - smoothstep(0.40, 0.50, pz)), side * wood);

      // ---- 光 ----
      vec3 s = vec3(0.0);
      ${body}
      // 底上げ。灯りの届かない隅が真っ黒だと、部屋の形が読めない
      vec3 col = alb * (vec3(0.021, 0.016, 0.013) + s);
      // 明るさの目安は施設の部屋(中央値 0.32)。はじめ灯りを 3 倍で
      // 置いていて、壁が白飛びして**橙一色の箱**になった。
      // 部屋が部屋に見えるのは、明るいところと暗いところがあるとき

      // 磨いた真鍮のてかり。すれすれの角度で鈍く返す
      vec3 v = normalize(cameraPosition - vW);
      col += vCol * brass * pow(max(dot(n, v), 0.0), 2.4) * 0.55;
      // 灯りの球と陳列棚のガラスは自分で光る
      col = mix(col, vCol * 7.0, lit * 0.92);

      gl_FragColor = vec4(extFog(col, vW), 1.0);
      ${UW_FRAG_OUTPUT}
    }
  `;
}

/**
 * サロンの大窓のガラス。
 *
 * ここを不透明の発光板のままにすると、船内から見たときに
 * **光る円盤が2枚貼ってあるだけ**になる。サロンの意味は
 * 「ここから海が見える」ことなので、透かさないと部屋が成立しない。
 *
 * かといって完全な素通しも嘘で、厚いガラスは必ず斜めから白く光る。
 * フレネルで縁だけ返す
 */
export function nautGlassFrag() {
  return /* glsl */ `
    varying vec3 vCol;
    varying vec3 vN;
    varying vec3 vW;
    void main() {
      vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
      vec3 v = normalize(cameraPosition - vW);
      float f = pow(1.0 - max(dot(n, v), 0.0), 2.6);
      // 正面から見ればほぼ素通し、斜めからは白く立つ
      float a = 0.10 + 0.62 * f;
      // 船内の琥珀を少し吸って外へ漏らす。海側から見ると
      // この色が「中に灯りがある」の証拠になる
      vec3 c = mix(vec3(0.42, 0.52, 0.55), vec3(1.30, 0.80, 0.36), f * 0.7);
      gl_FragColor = vec4(c * a, a);
      ${UW_FRAG_OUTPUT}
    }
  `;
}

/**
 * 船内を建てる。
 *
 * @param {object} k 道具一式
 *   M       内装を積む Buf(世界座標)
 *   V,W     船体ローカル→世界の頂点/座標
 *   radAt, hullY, surfX  船体の寸法
 *   strut   角柱
 * @returns {Array} 灯りの一覧(船体ローカル)。材質を作るのに要る
 */
export function buildInterior(k) {
  const { M, V, W, radAt, surfX, strut } = k;
  const SQ = k.SQUASH;
  const lamps = [];

  // 灯りを1つ置く。球だけだと**宙に浮いた琥珀の粒**に見えるので、
  // 必ず腕木を付けて壁か天井から吊る。器具に見せるのは形ではなく、
  // 「どこから生えているか」のほう
  const lamp = (x, y, z, k2, anchor, r = 0.085) => {
    lamps.push({ p: [x, y, z], k: k2 });
    globe(M, V, x, y, z, r);
    if (strut && anchor) strut(M, W(...anchor), W(x, y, z), 0.028, BRASS);
  };

  // 内張りの断面。t は +X から測った角。船体と同じ式に内側の寸法を通す
  const inner = (t, z) => {
    const r = radAt(z) - IN.liner;
    const c = Math.cos(t), s = Math.sin(t);
    return [c * r * (1 - 0.16 * s * s), s * r * SQ];
  };
  // その z で、甲板の高さに当たる角(右舷側)。負の値になる
  const tDeck = (z) => {
    const b = (radAt(z) - IN.liner) * SQ;
    return Math.asin(Math.max(Math.min(IN.deck / b, 0.98), -0.98));
  };
  // 甲板の半幅
  const deckHalf = (z) => Math.max(surfX(IN.deck, z) - IN.liner - 0.04, 0.4);

  // ---- 甲板 ----
  //
  // 平らな板でよい。光は断片ごとに世界座標から計算するので、
  // 細かく割っても明るさは変わらない
  {
    const NZ = 26;
    let prev = null;
    for (let i = 0; i <= NZ; i++) {
      const z = IN.zFwd + (IN.zAft - IN.zFwd) * (i / NZ);
      const w = deckHalf(z);
      const cur = [V(-w, IN.deck, z, DECK_C), V(w, IN.deck, z, DECK_C)];
      if (prev) M.quad(prev[0], prev[1], cur[1], cur[0]);
      prev = cur;
    }
  }

  // ---- 腰板と天井(内張り) ----
  //
  // 甲板の縁から立ち上がって、頭の上を回って反対の縁まで。
  // 大窓と昇降口のところだけ穴を開ける。
  //
  // 穴の判定は四角形の**中心**で行う。頂点で判定すると、
  // 縁の一列が中途半端に残って歯抜けになる
  const holed = (x, y, z) => {
    // 大窓。左右どちらも。|x| で切るのは、上面まで穴が回らないようにするため
    if (Math.abs(x) > 1.45) {
      const dy = y - IN.win.y, dz = z - IN.win.z;
      // 外板側の座(半径 1.16)より少し小さく抜く。縁のぎざぎざは
      // 真鍮の座が隠す——ぴったりで抜くと、座の外にぎざぎざが出る
      if (dy * dy + dz * dz < 1.02 * 1.02) return true;
    }
    // 昇降口
    if (y > 0.8 && Math.abs(x) < IN.hatchHalf + 0.03
        && z > IN.hatchZ0 - 0.03 && z < IN.hatchZ1 + 0.03) return true;
    return false;
  };
  {
    const NZ = 34, NT = 26;
    const rows = [];
    const zs = [];
    for (let i = 0; i <= NZ; i++) {
      const z = IN.zFwd + (IN.zAft - IN.zFwd) * (i / NZ);
      zs.push(z);
      const t0 = tDeck(z);              // 右舷の甲板ぎわ(負)
      const t1 = Math.PI - t0;          // 左舷の甲板ぎわ
      const row = [];
      for (let j = 0; j <= NT; j++) {
        const t = t0 + (t1 - t0) * (j / NT);
        const [x, y] = inner(t, z);
        // 天井へ行くほど暗い板。上を明るくすると天井が浮いて、
        // 部屋が屋外に見える
        const up = Math.max(y, 0) / 2.2;
        const col = [WOOD[0] * (1 - 0.30 * up) + WOOD2[0] * 0.30 * up,
                     WOOD[1] * (1 - 0.30 * up) + WOOD2[1] * 0.30 * up,
                     WOOD[2] * (1 - 0.30 * up) + WOOD2[2] * 0.30 * up];
        row.push({ i: V(x, y, z, col), x, y });
      }
      rows.push(row);
    }
    for (let i = 0; i < NZ; i++) {
      for (let j = 0; j < NT; j++) {
        const a = rows[i][j], b = rows[i][j + 1];
        const c = rows[i + 1][j], d = rows[i + 1][j + 1];
        const cx = (a.x + b.x + c.x + d.x) * 0.25;
        const cy = (a.y + b.y + c.y + d.y) * 0.25;
        const cz = (zs[i] + zs[i + 1]) * 0.5;
        if (holed(cx, cy, cz)) continue;
        M.quad(a.i, b.i, d.i, c.i);
      }
    }
  }

  // ---- 肋骨(フレーム) ----
  //
  // 一定の間隔で内張りを横切る真鍮の環。これが入ると、部屋が
  // 「船の中」に見える。無いと、ただの木の筒
  {
    for (let z = IN.zFwd - 0.9; z > IN.zAft + 0.4; z -= 1.30) {
      if (z > IN.hatchZ0 - 0.5 && z < IN.hatchZ1 + 0.5) continue;
      const t0 = tDeck(z), t1 = Math.PI - t0;
      const NT = 18;
      let prev = null;
      for (let j = 0; j <= NT; j++) {
        const t = t0 + (t1 - t0) * (j / NT);
        const [x, y] = inner(t, z);
        // 大窓を横切る肋骨は、そこで切る。
        // 間隔だけ決めて回すと、**ちょうど大窓の真ん中に1本**立って、
        // せっかく透かした窓を縦に割ってしまう(実際そうなった)
        if (holed(x, y, z)) { prev = null; continue; }
        // 内側へ 0.10 出っ張らせる。長さ方向にも厚みを持たせないと、
        // 真横から見たとき紙のように消える
        const s = 0.93;
        const cur = [V(x, y, z - 0.055, BRASS), V(x * s, y * s, z - 0.055, BRASS),
                     V(x * s, y * s, z + 0.055, BRASS), V(x, y, z + 0.055, BRASS)];
        if (prev) {
          for (let q = 0; q < 4; q++) {
            const q2 = (q + 1) % 4;
            M.quad(prev[q], prev[q2], cur[q2], cur[q]);
          }
        }
        prev = cur;
      }
    }
  }

  // ---- 隔壁 ----
  // 前後を閉じる。開いていると、細い船首と艫の暗がりが覗けて、
  // そこだけ「何も無い空間」になる
  const bulkhead = (z, col) => {
    const t0 = tDeck(z), t1 = Math.PI - t0;
    const NT = 20;
    const hub = V(0, IN.deck + 0.9, z, col);
    let prev = null;
    for (let j = 0; j <= NT; j++) {
      const t = t0 + (t1 - t0) * (j / NT);
      const [x, y] = inner(t, z);
      const cur = V(x, y, z, col);
      if (prev !== null) M.tri(hub, prev, cur);
      prev = cur;
    }
    // 甲板と隔壁のあいだ
    const w = deckHalf(z);
    M.tri(hub, V(-w, IN.deck, z, col), V(w, IN.deck, z, col));
  };
  bulkhead(IN.zFwd, WOOD2);
  bulkhead(IN.zAft, WOOD2);

  // ---- 昇降筒 ----
  //
  // 甲板の昇降口から外板の穴まで、四角い筒でつなぐ。
  // 内張りに開けた穴の縁をこれが隠す。
  // 上端は船体の背より高く取る——低いと、外から見たとき
  // 穴の縁と筒の口のあいだに隙間が見える
  {
    const hx = IN.hatchHalf, z0 = IN.hatchZ0, z1 = IN.hatchZ1;
    const yB = 0.95, yT = 2.62;
    const corner = (x, z, y) => V(x, y, z, BRASS);
    const pts = [[-hx, z0], [hx, z0], [hx, z1], [-hx, z1]];
    for (let q = 0; q < 4; q++) {
      const [ax, az] = pts[q], [bx, bz] = pts[(q + 1) % 4];
      const a0 = corner(ax, az, yB), b0 = corner(bx, bz, yB);
      const a1 = corner(ax, az, yT), b1 = corner(bx, bz, yT);
      M.quad(a0, b0, b1, a1);
    }
    // 筒の口の輪。厚みを持たせる
    const o = 0.10;
    const outer = [[-hx - o, z0 - o], [hx + o, z0 - o], [hx + o, z1 + o], [-hx - o, z1 + o]];
    for (let q = 0; q < 4; q++) {
      const [ax, az] = pts[q], [bx, bz] = pts[(q + 1) % 4];
      const [cx, cz] = outer[q], [dx, dz] = outer[(q + 1) % 4];
      M.quad(corner(ax, az, yB), corner(bx, bz, yB),
             corner(dx, dz, yB), corner(cx, cz, yB));
    }
    // 梯子。甲板から筒の口まで
    if (strut) {
      const lz = z1 - 0.22;
      for (const sgn of [-1, 1]) {
        strut(M, W(sgn * 0.34, IN.deck, lz), W(sgn * 0.34, yT - 0.10, lz), 0.045, BRASS);
      }
      for (let y = IN.deck + 0.30; y < yT - 0.15; y += 0.30) {
        strut(M, W(-0.34, y, lz), W(0.34, y, lz), 0.032, BRASS);
      }
    }
    lamp(0, 2.30, (z0 + z1) * 0.5, 0.46, [hx - 0.05, 2.42, (z0 + z1) * 0.5]);
  }

  // ---- 大窓の内側の枠 ----
  // 内張りの穴の縁を真鍮で回す。これが無いと、板に穴が空いているだけ
  for (const sgn of [-1, 1]) {
    const RN = 22, R = 1.02;
    let prev = null;
    for (let j = 0; j <= RN; j++) {
      const a = (j / RN) * Math.PI * 2;
      const y = IN.win.y + Math.sin(a) * R, z = IN.win.z + Math.cos(a) * R;
      const xi = sgn * (surfX(y, z) - IN.liner);
      const cur = [V(xi, y, z, BRASS),
                   V(xi * 0.90, IN.win.y + Math.sin(a) * (R + 0.12),
                     IN.win.z + Math.cos(a) * (R + 0.12), BRASS)];
      if (prev) M.quad(prev[0], prev[1], cur[1], cur[0]);
      prev = cur;
    }
    // 窓のそばに灯りを1つずつ。ここが部屋でいちばん見られる場所
    // 窓のそばの灯りは、窓枠の上から前へ差し出す
    lamp(sgn * 1.30, 1.55, IN.win.z, 0.58,
         [sgn * (surfX(1.55, IN.win.z) - IN.liner - 0.05), 1.72, IN.win.z], 0.095);
  }

  // ---- パイプオルガン ----
  //
  // 映画版のサロンの主。原作のネモも「海の中で弾く人」なので、
  // これが1つあるだけで、この部屋の持ち主が誰なのか分かる。
  //
  // 音管は高さを段にして並べる。全部同じ高さだと柵になる
  {
    const z = IN.zAft + 0.55;
    const NP = 17;
    for (let i = 0; i < NP; i++) {
      const u = (i / (NP - 1)) * 2 - 1;              // -1..1
      const x = u * 1.55;
      // 中央がいちばん高い山型ではなく、両端が高い**谷型**にする。
      // 実物のオルガンは低音管(=長い)が外側に来る
      const h = 0.95 + 1.35 * Math.pow(Math.abs(u), 1.35);
      const rad = 0.055 + 0.030 * Math.abs(u);
      if (strut) {
        strut(M, W(x, IN.deck + 0.86, z), W(x, IN.deck + 0.86 + h, z), rad, BRASS);
        // 管の口。斜めに切った歌口
        strut(M, W(x, IN.deck + 0.86 + h, z),
              W(x, IN.deck + 0.98 + h, z - 0.06), rad * 1.35, BRASS);
      }
    }
    // 台と鍵盤
    box(M, V, -1.75, IN.deck, z - 0.45, 1.75, IN.deck + 0.86, z + 0.30, WOOD);
    box(M, V, -0.85, IN.deck + 0.86, z - 0.34, 0.85, IN.deck + 0.92, z - 0.02, LAMP);
    // 椅子
    box(M, V, -0.55, IN.deck, z + 0.95, 0.55, IN.deck + 0.44, z + 1.30, WOOD2);
    lamp(0, IN.deck + 2.5, z + 1.2, 0.68, [0, IN.deck + 3.05, z + 1.2], 0.10);
  }

  // ---- 陳列棚 ----
  //
  // 原作のサロンは博物館でもある。両舷に低い棚を並べて、
  // ガラスの中を淡く光らせる。中身までは作らない——
  // 光る棚が並んでいるだけで「集めたものが置いてある」に読める
  for (const sgn of [-1, 1]) {
    for (const z of [1.15, -2.15, -4.05]) {
      const w = deckHalf(z);
      const x0 = sgn > 0 ? w - 0.66 : -w;
      const x1 = sgn > 0 ? w : -w + 0.66;
      box(M, V, Math.min(x0, x1), IN.deck, z - 0.62,
          Math.max(x0, x1), IN.deck + 0.82, z + 0.62, WOOD);
      // ガラスの天板
      box(M, V, Math.min(x0, x1) + 0.05, IN.deck + 0.82, z - 0.56,
          Math.max(x0, x1) - 0.05, IN.deck + 0.90, z + 0.56, CASE);
    }
    // 舷側の灯り
    for (const z of [4.3, -3.2]) {
      const w = deckHalf(z);
      lamp(sgn * (w - 0.30), IN.deck + 1.95, z, 0.52,
           [sgn * (surfX(IN.deck + 1.95, z) - IN.liner - 0.04), IN.deck + 2.10, z], 0.085);
    }
  }

  // ---- 海図台 ----
  // 昇降筒の前。降りてきて最初に目に入る場所
  {
    const z = 5.10;
    box(M, V, -0.95, IN.deck, z - 0.55, 0.95, IN.deck + 0.80, z + 0.55, WOOD);
    // 天板は傾けない(箱で作っているので)。かわりに海図を光らせる
    box(M, V, -0.86, IN.deck + 0.80, z - 0.46, 0.86, IN.deck + 0.86, z + 0.46, LAMP);
    lamp(0, IN.deck + 2.3, z, 0.62, [0, 2.15, z], 0.095);
  }

  return lamps;
}

/** 軸に沿った箱。内装はほとんどこれで足りる */
function box(M, V, x0, y0, z0, x1, y1, z1, col) {
  const p = [];
  for (const y of [y0, y1]) {
    p.push([V(x0, y, z0, col), V(x1, y, z0, col), V(x1, y, z1, col), V(x0, y, z1, col)]);
  }
  M.quad(p[1][0], p[1][1], p[1][2], p[1][3]);     // 上
  M.quad(p[0][3], p[0][2], p[0][1], p[0][0]);     // 下
  for (let q = 0; q < 4; q++) {
    const q2 = (q + 1) % 4;
    M.quad(p[0][q], p[0][q2], p[1][q2], p[1][q]);
  }
}

/** 灯りの球。八面体で足りる——小さくて、どの向きからも同じに見える */
function globe(M, V, x, y, z, r) {
  const v = [V(x + r, y, z, LAMP), V(x - r, y, z, LAMP), V(x, y + r, z, LAMP),
             V(x, y - r, z, LAMP), V(x, y, z + r, LAMP), V(x, y, z - r, LAMP)];
  for (const [a, b, c] of [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
                           [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]]) {
    M.tri(v[a], v[b], v[c]);
  }
}
