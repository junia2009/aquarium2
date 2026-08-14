import * as THREE from 'three';

// ============ 餌のかたち ============
//
// 最初、餌は丸い点スプライトで描いていた。これが「光ってる何か」に
// 見えてしまった。理由ははっきりしていて、この水族館のほかのものは
// すべて光を受けて陰のつくジオメトリなのに、餌だけが陰も遠近も持たない
// 発光する円だったから。水のなかに浮いているのではなく、画面に貼られていた。
//
// なので餌も生き物として作る。オキアミはエビだし、小魚は魚だし、
// 沈降物は不定形の塊で、どれも丸い光の玉ではない。
//
// 形は長さ1に正規化して +Z を頭にしておき、実寸はインスタンス行列の
// スケールで与える。こうすると同じ形を大きさ違いで使い回せる。

/** 頂点を溜めて、最後に法線を面から計算する小さな入れ物 */
class MeshBuf {
  constructor() { this.p = []; this.c = []; this.i = []; }
  v(x, y, z, col) {
    const k = this.p.length / 3;
    this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]);
    return k;
  }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.i.push(a, b, c, a, c, d); }

  geo() {
    const pos = new Float32Array(this.p);
    const nrm = new Float32Array(this.p.length);
    // 面法線を頂点に足しこんで正規化する。断面の傾きまで含めて
    // 正しく出るので、細くすぼまる腹部にちゃんと陰がつく
    for (let f = 0; f < this.i.length; f += 3) {
      const a = this.i[f] * 3, b = this.i[f + 1] * 3, c = this.i[f + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { nrm[k] += nx; nrm[k + 1] += ny; nrm[k + 2] += nz; }
    }
    for (let k = 0; k < nrm.length; k += 3) {
      const L = Math.hypot(nrm[k], nrm[k + 1], nrm[k + 2]) || 1;
      nrm[k] /= L; nrm[k + 1] /= L; nrm[k + 2] /= L;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setIndex(this.i);
    return g;
  }
}

/** rings = [{z, rx, ry, y, col}] を輪切りにしてつなぐ */
function tube(M, rings, sides) {
  const rows = rings.map((rg) => {
    const row = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      row.push(M.v(Math.cos(a) * rg.rx, rg.y + Math.sin(a) * rg.ry, rg.z, rg.col));
    }
    return row;
  });
  for (let i = 0; i < rows.length - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const s2 = (s + 1) % sides;
      M.quad(rows[i][s], rows[i][s2], rows[i + 1][s2], rows[i + 1][s]);
    }
  }
  return rows;
}

/** 小さな球。目に使う */
function blob(M, cx, cy, cz, r, col, seg = 4) {
  const rows = [];
  for (let i = 0; i <= seg; i++) {
    const th = (i / seg) * Math.PI;
    const row = [];
    for (let s = 0; s < seg * 2; s++) {
      const a = (s / (seg * 2)) * Math.PI * 2;
      row.push(M.v(cx + Math.sin(th) * Math.cos(a) * r, cy + Math.cos(th) * r,
                   cz + Math.sin(th) * Math.sin(a) * r, col));
    }
    rows.push(row);
  }
  for (let i = 0; i < seg; i++) {
    for (let s = 0; s < seg * 2; s++) {
      const s2 = (s + 1) % (seg * 2);
      M.quad(rows[i][s], rows[i][s2], rows[i + 1][s2], rows[i + 1][s]);
    }
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

/** 折れ線テーブルを u で引く */
function sample(tbl, u) {
  const x = Math.min(Math.max(u, 0), 1) * (tbl.length - 1);
  const i = Math.min(Math.floor(x), tbl.length - 2);
  return lerp(tbl[i], tbl[i + 1], x - i);
}

// ---- エビ(オキアミ・アミ) ----
//
// オキアミの見分けどころは、丸くて真っ黒な複眼と、頭胸甲より細く
// 6節に分かれた腹部と、扇のように開く尾扇。この3つがあると
// 「小さいエビ」に見える。逆にこれが無いと、ただの粒になる。
// [体に沿った位置 u, 半径]。頭胸甲(u<0.44)は太く、腹部はそこから
// 一段細くなって尾へ絞られる。この段差と、腹側への反りと、開いた尾扇——
// この3つが揃うとエビの影になる。滑らかな紡錘形にすると小魚に見えてしまう
const SHRIMP = [
  [0.00, 0.012], [0.06, 0.044], [0.13, 0.068], [0.21, 0.080],
  [0.30, 0.084], [0.38, 0.079], [0.43, 0.066], [0.47, 0.057],
  [0.55, 0.053], [0.64, 0.049], [0.73, 0.045], [0.82, 0.041],
  [0.90, 0.036], [1.00, 0.029],
];
// 腹側への反り。体長に対してこれだけ下がる
function shrimpDrop(u) { return -0.17 * Math.pow(u, 1.9); }

export function shrimpGeometry() {
  const M = new MeshBuf();
  const BODY = [0.97, 0.58, 0.46];   // 半透明の殻。橙がかった肌色
  const GUT  = [0.52, 0.56, 0.28];   // 中腸腺。植物プランクトンを食べるので緑がかる
  const SIDES = 7;
  const rings = SHRIMP.map(([u, r], i) => {
    // 腹節。1リング1節にして、交互に陰を落とす
    const shade = u > 0.47 && i % 2 === 0 ? 0.86 : 1;
    // 頭胸部だけ中腸腺の色を混ぜる
    const g = u > 0.14 && u < 0.42 ? 0.38 : 0;
    return {
      u, z: 0.5 - 0.82 * u, rx: r * 0.90, ry: r * 1.14, y: shrimpDrop(u),
      col: [lerp(BODY[0], GUT[0], g) * shade, lerp(BODY[1], GUT[1], g) * shade,
            lerp(BODY[2], GUT[2], g) * shade],
    };
  });
  const rows = tube(M, rings, SIDES);

  // 遊泳肢(腹肢)。腹の下に並ぶ小さな櫂で、オキアミはこれを
  // 波打たせて泳ぐ。細部だが、腹の下がつるつるだと甲殻類に見えない
  const LEG = [0.90, 0.58, 0.50];
  for (let s = 0; s < 5; s++) {
    const u = 0.50 + s * 0.082;
    const z = 0.5 - 0.82 * u, y = shrimpDrop(u);
    const r = sample(SHRIMP.map((e) => e[1]), u) * 0.9;
    for (const sx of [-1, 1]) {
      // 先の丸い櫂。尖らせると鋸の歯に見えてしまう
      const a = M.v(sx * r * 0.45, y - r * 0.80, z + 0.011, LEG);
      const b = M.v(sx * r * 0.45, y - r * 0.80, z - 0.011, LEG);
      const t1 = M.v(sx * r * 0.85, y - r * 1.45, z - 0.024, LEG);
      const t2 = M.v(sx * r * 0.85, y - r * 1.45, z - 0.004, LEG);
      M.quad(a, b, t1, t2);
    }
  }
  // 胸脚(摂餌用のかご)。頭胸部の下の毛むくじゃらな部分
  for (let s = 0; s < 3; s++) {
    const u = 0.22 + s * 0.075;
    const z = 0.5 - 0.82 * u, y = shrimpDrop(u);
    for (const sx of [-1, 1]) {
      const a = M.v(sx * 0.030, y - 0.055, z + 0.014, LEG);
      const b = M.v(sx * 0.030, y - 0.055, z - 0.014, LEG);
      const t = M.v(sx * 0.055, y - 0.115, z - 0.035, LEG);
      M.tri(a, b, t);
    }
  }

  // 尾扇(尾節と尾肢)。5枚が水平に開く。エビの尾扇は水平なので
  // 真横からは薄いのが正しいが、それだと尾が無いように見えるので、
  // 板ごとに少しずつ角度を変えて、どこから見ても輪郭が残るようにしてある
  const FAN = [0.94, 0.55, 0.47];
  const base = rings[rings.length - 1];
  const bz = base.z, by = base.y;
  for (const [spread, tipZ, lift] of [
    [0.000, -0.210, 0.000], [-0.075, -0.185, 0.018], [0.075, -0.185, 0.018],
    [-0.135, -0.140, 0.042], [0.135, -0.140, 0.042],
  ]) {
    const a = M.v(-0.022, by, bz + 0.004, FAN);
    const b = M.v(0.022, by, bz + 0.004, FAN);
    const t1 = M.v(spread - 0.028, by + lift, bz + tipZ, FAN);
    const t2 = M.v(spread + 0.028, by + lift, bz + tipZ, FAN);
    M.quad(a, b, t2, t1);
  }

  // 複眼。オキアミの目は体のわりに大きく、真っ黒で球形。
  // 遠くて体の細部が潰れても、この2つの黒点だけは残って甲殻類に見える
  const EYE = [0.03, 0.025, 0.035];
  for (const sx of [-1, 1]) blob(M, sx * 0.042, 0.016, 0.380, 0.032, EYE, 2);

  // 触角。前へ長く伸びる。細いので遠目には消えるが、
  // 輪郭にこれがあるかどうかで「エビ」と「小魚」が分かれる
  const ANT = [0.72, 0.50, 0.44];
  for (const sx of [-1, 1]) {
    for (const [ay, spread, len] of [[0.010, 0.075, 0.42], [-0.014, 0.030, 0.28]]) {
      const a = M.v(sx * 0.016, ay + 0.006, 0.47, ANT);
      const b = M.v(sx * 0.016, ay - 0.006, 0.47, ANT);
      const t = M.v(sx * spread, ay + 0.030, 0.47 + len, ANT);
      M.tri(a, b, t);
    }
  }
  void rows;
  return M.geo();
}

// ---- 小魚 ----
// イルカに撒く生きた小魚。側扁した体と二叉の尾で「魚」に見せる
const FRY_R = [0.010, 0.046, 0.072, 0.082, 0.080, 0.070, 0.056, 0.041, 0.027, 0.016];

export function fryGeometry() {
  const M = new MeshBuf();
  const N = 10, SIDES = 7;
  const rings = [];
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const r = sample(FRY_R, u);
    rings.push({ z: 0.5 - 0.78 * u, rx: r * 0.42, ry: r * 1.15, y: 0, col: [0.62, 0.68, 0.74] });
  }
  const rows = tube(M, rings, SIDES);
  // 背は暗く腹は銀白。水中の小魚はこの明暗だけでそれと分かる
  const col = M.c, pos = M.p;
  for (let k = 0; k < pos.length; k += 3) {
    const t = Math.min(Math.max(pos[k + 1] / 0.09 * 0.5 + 0.5, 0), 1);
    col[k] = lerp(0.20, 0.94, t); col[k + 1] = lerp(0.30, 0.96, t); col[k + 2] = lerp(0.40, 0.99, t);
  }

  // 尾びれ(二叉)。魚の尾は縦なので yz 面に張る
  const FIN = [0.55, 0.62, 0.68];
  const tail = rings[N - 1];
  const t0 = M.v(0, 0, tail.z, FIN);
  for (const sy of [-1, 1]) {
    const a = M.v(0, sy * 0.012, tail.z, FIN);
    const t = M.v(0, sy * 0.105, -0.50, FIN);
    const m = M.v(0, sy * 0.030, -0.40, FIN);
    M.tri(t0, a, t); M.tri(t0, t, m);
  }
  // 背びれ
  M.tri(M.v(0, 0.06, 0.10, FIN), M.v(0, 0.135, -0.02, FIN), M.v(0, 0.05, -0.10, FIN));
  // 目
  const EYE = [0.04, 0.04, 0.05];
  for (const sx of [-1, 1]) blob(M, sx * 0.020, 0.012, 0.395, 0.017, EYE, 3);
  void rows;
  return M.geo();
}

// ---- 沈降物(マリンスノーの塊) ----
// 生き物の死骸や糞が絡まった、ぼろぼろの不定形。
// 規則的な形にすると途端に嘘になるので、頂点をばらばらに散らす
export function flakeGeometry(seed = 1) {
  const M = new MeshBuf();
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const COL = [0.60, 0.57, 0.50];
  // ひと塊ではなく、小さな粒がゆるく連なった房にする。
  // マリンスノーは殻や糞や粘液が絡まった凝集体で、なめらかな石ではない。
  // 球を粗く割ると尖った角錐になってしまうので、正20面体を種にして
  // 頂点を少しだけ揺らす。こうすると角の丸い小片になる
  const ico = new THREE.IcosahedronGeometry(1, 0).toNonIndexed().getAttribute('position');
  for (let b = 0; b < 7; b++) {
    const ox = (rnd() - 0.5) * 0.46, oy = (rnd() - 0.5) * 0.40, oz = (rnd() - 0.5) * 0.46;
    const sc = 0.085 + rnd() * 0.095;
    for (let f = 0; f < ico.count; f += 3) {
      const c = 0.72 + rnd() * 0.56;
      const idx = [];
      for (let k = 0; k < 3; k++) {
        const j = f + k;
        const w = 0.80 + rnd() * 0.40;
        idx.push(M.v(ox + ico.getX(j) * sc * w, oy + ico.getY(j) * sc * w,
                     oz + ico.getZ(j) * sc * w, [COL[0] * c, COL[1] * c, COL[2] * c]));
      }
      M.tri(idx[0], idx[1], idx[2]);
    }
  }
  return M.geo();
}
