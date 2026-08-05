import * as THREE from 'three';

// ============ 魚の手続き的ジオメトリ ============
// 鼻先 z=+L/2、尾 z=-L/2。楕円断面のリングを連ねて紡錘形の体を作り、
// 尾びれ・背びれ・胸びれを別パートとして結合する。
// 頂点属性:
//   aPart  : 0=体, 1=尾びれ, 2=背びれ, 3=胸びれ左, 4=胸びれ右
//   aBodyUV: x=体軸方向 0(鼻)→1(尾), y=断面角(0=腹 1=背)
//   aHeight: 体の中心からの実際の高さ(H で割った値)
//
// aBodyUV.y は断面の「角度」なので、断面が円でないときは高さと一致しない。
// 角ばった頭に横一文字の口を引くような場面では aHeight を使う。
// (角度で引くと、等高線が角丸長方形になって輪のように見えてしまう)

// 配列を 0..1 のtで線形補間サンプリング
function sampleLinear(arr, t) {
  const f = Math.min(Math.max(t, 0), 1) * (arr.length - 1);
  const i = Math.floor(f);
  const u = f - i;
  if (i >= arr.length - 1) return arr[arr.length - 1];
  return arr[i] * (1 - u) + arr[i + 1] * u;
}

// Catmull-Rom による滑らかなサンプリング。
// 線形補間だと制御点ごとに傾きが折れるので、メロンのように短い区間で
// 太さが大きく変わる形では、その折れがそのまま面の稜線として見えてしまう。
function sampleSmooth(arr, t) {
  const n = arr.length;
  const f = Math.min(Math.max(t, 0), 1) * (n - 1);
  const i = Math.min(Math.floor(f), n - 2);
  const u = f - i;
  const p0 = arr[Math.max(i - 1, 0)], p1 = arr[i];
  const p2 = arr[i + 1], p3 = arr[Math.min(i + 2, n - 1)];
  return 0.5 * (2 * p1 + (p2 - p0) * u
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
    + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
}

export function buildFishGeometry(opts) {
  const {
    length: L = 1,
    height: H = 0.3,
    width: W = 0.14,
    // 体高・体幅プロファイル(鼻→尾柄)
    hProfile = [0.10, 0.55, 0.9, 1.0, 0.95, 0.75, 0.45, 0.18],
    wProfile = [0.25, 0.7, 0.95, 1.0, 0.9, 0.65, 0.4, 0.2],
    // 体軸の上下オフセット(背の盛り上がり)
    yOffset = [0.0, 0.05, 0.1, 0.1, 0.05, 0.0, -0.02, 0.0],
    rings = 20,
    radial = 14,
    // 断面の変形。単位円上の点(x,y)と体軸位置tを受け取り、変形後の(x,y)を返す。
    // 楕円では表せない「平たい頭」「体側の隆起」などを作るために使う。
    sectionMod = null,
    // 丸く詰まった鼻先。rings>0 でリングを足して半球状に閉じる
    nose = null,
    // lobe: 上葉の伸び(サメ類) / horizontal: 水平尾びれ(クジラ類のフリューク)
    tail = { len: 0.32, height: 0.55, fork: 0.45, lobe: 0, horizontal: false },
    dorsal = { from: 0.32, to: 0.72, height: 0.5 },
    anal = null,      // 臀びれ(背びれと同じ形式で腹側へ)
    pectoral = { at: 0.3, len: 0.30, width: 0.14 },
    pelvic = null,    // 腹びれ(胸びれと同じ形式)
    // プロファイルの補間。既定は線形。短い区間で太さが大きく変わる体型
    // (シロイルカのメロンなど)では、制御点の折れが稜線として見えるので
    // smooth: true にする
    smooth = false,
  } = opts;
  const sampleProfile = smooth ? sampleSmooth : sampleLinear;

  const positions = [];
  const bodyUV = [];
  const height = [];
  const part = [];
  const indices = [];

  // 頂点を1つ積む(位置・体軸UV・高さ・パーツ)
  const push = (x, y, z, u, v, p) => {
    positions.push(x, y, z);
    bodyUV.push(u, v);
    height.push(y / H);
    part.push(p);
  };

  // 単位円上の点に sectionMod を通す
  const sec = (a, t) => {
    let x = Math.sin(a), y = Math.cos(a);
    if (sectionMod) [x, y] = sectionMod(x, y, t);
    return [x, y];
  };

  // ---- 体軸座標の割り当て ----
  // 鼻先にリングを足す場合、そこにも体軸方向の座標を与える。
  // 鼻先の頂点をすべて u=0 にしてしまうと、u に依存する模様
  // (斑点・鰓裂・口)が鼻先だけ潰れて、のっぺりした殻に見える。
  const noseRings = nose?.rings ?? 0;
  const noseLen = (nose?.len ?? 0.015) * L;
  const uFront = noseRings > 0 ? noseLen / L : 0;   // 鼻先が占める u の幅

  // ---- 体(リング) ----
  const zNose = L / 2;
  for (let i = 0; i <= rings; i++) {
    const tt = i / rings;
    const t = uFront + tt * (1 - uFront);
    const z = zNose - tt * (L - tail.len * L * 0.15);
    const hh = sampleProfile(hProfile, tt) * H;
    const ww = sampleProfile(wProfile, tt) * W;
    const yc = sampleProfile(yOffset, tt) * H;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const [x, y] = sec(a, tt);          // y: 1=背, -1=腹
      push(x * ww, yc + y * hh, z, t, Math.cos(a) * 0.5 + 0.5, 0);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j;
      const b = i * radial + ((j + 1) % radial);
      const c = (i + 1) * radial + j;
      const d = (i + 1) * radial + ((j + 1) % radial);
      indices.push(a, c, b, b, c, d);
    }
  }

  // ---- 鼻先 ----
  // 既定は1点のキャップ。nose.rings を与えると、先頭リングの断面を
  // すぼめながら前へ伸ばして丸い吻を作る。
  //
  // 二つ気をつけることがある。
  //  1) リングを s(0..1)で等間隔に置くと、指数(flat)が大きいときに
  //     最後のリングから先端までで一気に閉じ、そこが平らな蓋になって
  //     ナイフのような縁が立つ。角度で刻んで、閉じ際を細かくする。
  //  2) すぼまり始めの傾きが 0 だと、胴の先細りとの間に折れ線が出る。
  //     胴の先端での細り方をそのまま前へ延長した上に丸めを掛ける。
  const h0 = sampleProfile(hProfile, 0) * H;
  const w0 = sampleProfile(wProfile, 0) * W;
  const yc0 = sampleProfile(yOffset, 0) * H;
  const flat = nose?.flat ?? 2;
  const e = 2 / flat;
  // 胴の先端で、前へ1進むごとに細くなる量
  const dtt = 1 / rings;
  const dz0 = (L - tail.len * L * 0.15) * dtt;
  const slopeH = (sampleProfile(hProfile, dtt) * H - h0) / dz0;
  const slopeW = (sampleProfile(wProfile, dtt) * W - w0) / dz0;
  const slopeY = (sampleProfile(yOffset, dtt) * H - yc0) / dz0;

  let frontRow = 0;                       // 最前リングの先頭インデックス
  for (let i = 1; i <= noseRings; i++) {
    const th = (i / (noseRings + 1)) * Math.PI * 0.5;
    const k = Math.pow(Math.cos(th), e);          // 断面の縮み
    const zf = Math.pow(Math.sin(th), e) * noseLen; // 前方への張り出し
    const hh = Math.max(h0 - slopeH * zf, 0) * k;
    const ww = Math.max(w0 - slopeW * zf, 0) * k;
    const yc = yc0 - slopeY * zf;
    const row = positions.length / 3;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const [x, y] = sec(a, 0);
      push(x * ww, yc + y * hh, zNose + zf,
           uFront * (1 - zf / noseLen), Math.cos(a) * 0.5 + 0.5, 0);
    }
    // 巻き順は胴体と揃える。逆に張ると、共有する接合リングで
    // 面法線が打ち消し合い、そこに折れ線が浮き出る
    for (let j = 0; j < radial; j++) {
      const jn = (j + 1) % radial;
      indices.push(frontRow + j, frontRow + jn, row + j);
      indices.push(frontRow + jn, row + jn, row + j);
    }
    frontRow = row;
  }
  // 先端の1点で閉じる
  const noseIdx = positions.length / 3;
  push(0, yc0 - slopeY * noseLen, zNose + noseLen, 0, 0.5, 0);
  for (let j = 0; j < radial; j++) {
    indices.push(noseIdx, frontRow + j, frontRow + ((j + 1) % radial));
  }
  // ---- 尾びれ: 胴体から連続して移行させる ----
  // 尾柄に蓋をして別パーツの扇を刺すと接合部で途切れて見えるので、
  // 断面を「小さな楕円(尾柄)」から「薄く広い膜(ひれ)」へ徐々に変形させ、
  // 胴体と尾びれを1枚の面としてつなぐ。
  const zPed = zNose - (L - tail.len * L * 0.15);
  const pedH = sampleProfile(hProfile, 1) * H;
  const pedW = sampleProfile(wProfile, 1) * W;
  const pedY = sampleProfile(yOffset, 1) * H;
  const spreadMax = tail.height * H * 2.2;
  const lobe = tail.lobe ?? 0;
  const horizontal = !!tail.horizontal;

  // ひれの後退量(u: 広がり方向の座標 -1..1)。中央がへこんでフォークになる
  const extAt = (u) => {
    let e = tail.len * L * (1.0 - tail.fork * (1.0 - Math.abs(u)));
    if (u > 0) e *= 1.0 + lobe * u;   // サメ類は上葉が長い
    return e;
  };

  const tailRings = 12;
  const tailStart = positions.length / 3;
  for (let i = 1; i <= tailRings; i++) {
    const s = i / tailRings;                 // 0=尾柄 1=ひれ後端
    const grow = Math.pow(s, 0.85);          // 広がる軸
    const flat = Math.pow(1 - s, 1.4);       // 薄くなる軸(後端で厚み0)
    // クジラ類のフリュークは水平に広がるので、広がる軸と薄くなる軸が入れ替わる
    const halfW = horizontal ? pedW + (spreadMax - pedW) * grow : pedW * flat;
    const halfH = horizontal ? pedH * flat : pedH + (spreadMax - pedH) * grow;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const cy = Math.cos(a), sx0 = Math.sin(a);
      // 尾柄の断面変形(隆起など)は、ひれへ向かって滑らかに消す
      let mx = sx0, my = cy;
      if (sectionMod) {
        const [dx, dy] = sectionMod(sx0, cy, 1);
        const f = 1 - s;
        mx = sx0 + (dx - sx0) * f;
        my = cy + (dy - cy) * f;
      }
      const u = horizontal ? sx0 : cy;       // 広がり方向の座標
      push(mx * halfW, pedY + my * halfH, zPed - s * extAt(u), 1.0 + s * 0.22, cy * 0.5 + 0.5, 1);
    }
  }
  // 胴体の最終リングから帯でつなぐ(頂点を共有するので継ぎ目が出ない)
  const bodyLast = rings * radial;
  for (let i = 0; i < tailRings; i++) {
    const rowA = i === 0 ? bodyLast : tailStart + (i - 1) * radial;
    const rowB = tailStart + i * radial;
    for (let j = 0; j < radial; j++) {
      const jn = (j + 1) % radial;
      indices.push(rowA + j, rowB + j, rowA + jn);
      indices.push(rowA + jn, rowB + j, rowB + jn);
    }
  }

  // ---- 正中のひれ(背びれ・臀びれ) ----
  // sign = +1 で背側、-1 で腹側に生やす
  const addMedianFin = (spec, sign) => {
    const dSegs = spec.segs ?? 6;
    const dStart = positions.length / 3;
    for (let j = 0; j <= dSegs; j++) {
      const s = j / dSegs;
      const t = spec.from + (spec.to - spec.from) * s;
      const z = zNose - t * (L - tail.len * L * 0.15);
      const yc = sampleProfile(yOffset, t) * H;
      const edgeY = yc + sign * sampleProfile(hProfile, t) * H;
      // 前縁が高く後方へ低くなる
      const finH = spec.height * H * (1.0 - 0.55 * s) * Math.sin(Math.PI * Math.min(s * 2.5 + 0.15, 1));
      push(0, edgeY - sign * 0.01, z, t, sign > 0 ? 1.0 : 0.0, 2);
      push(0, edgeY + sign * finH, z - finH * (spec.sweep ?? 0.55), t, sign > 0 ? 1.15 : -0.15, 2);
    }
    for (let j = 0; j < dSegs; j++) {
      const a = dStart + j * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  };
  if (dorsal) for (const d of (Array.isArray(dorsal) ? dorsal : [dorsal])) addMedianFin(d, 1);
  if (anal) for (const d of (Array.isArray(anal) ? anal : [anal])) addMedianFin(d, -1);

  // ---- 対のひれ(胸びれ・腹びれ) ----
  const addPairedFin = (spec) => {
    for (const side of [1, -1]) {
      const partId = side > 0 ? 4 : 3;
      const t = spec.at;
      const z = zNose - t * L;
      const x0 = sampleProfile(wProfile, t) * W * 0.9 * side;
      const y0 = sampleProfile(yOffset, t) * H - sampleProfile(hProfile, t) * H * (spec.low ?? 0.25);
      const pStart = positions.length / 3;

      if (spec.shape === 'falcate') {
        // 鎌形。前縁はほぼ直線に後退し、後縁がえぐれて先端が尖る。
        // ジンベエザメやマグロ類の翼のような胸びれ。
        const pSegs = spec.segs ?? 8;
        const span = spec.width * L;         // 外への張り出し
        const back = spec.len * L;           // 後退量
        const chord0 = (spec.chord ?? 0.42) * back;
        for (let j = 0; j <= pSegs; j++) {
          const s = j / pSegs;
          const outX = side * span * Math.sin(s * 1.30);
          const dropY = -(spec.droop ?? 0.22) * back * s * s;
          const sweep = back * (0.30 * s + 0.72 * s * s);
          const chord = chord0 * Math.pow(1 - s, 0.62);
          // 前縁
          push(x0 + outX, y0 + dropY, z - sweep, t + s * 0.05, 0.34, partId);
          // 後縁
          push(x0 + outX * 0.98, y0 + dropY - chord * 0.10, z - sweep - chord, t + s * 0.10, 0.28, partId);
        }
        for (let j = 0; j < pSegs; j++) {
          const a = pStart + j * 2;
          if (side > 0) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      } else if (spec.shape === 'paddle') {
        // 幅広く丸い櫂。付け根に弦長(chord)を持たせ、先端を丸く落とす。
        // 既定の胸びれは付け根の弦長が0で、根元が一点に集まった針のような
        // 形になる。細い翼ならそれでいいが、シロイルカのような板状のひれ
        // には使えない。droop を負にすると先端が上へ反る(成体の特徴)。
        const pSegs = spec.segs ?? 10;
        const span = spec.width * L;          // 外への張り出し
        const sweep = spec.len * L;           // 後退量
        const chord0 = (spec.chord ?? 0.06) * L;
        for (let j = 0; j <= pSegs; j++) {
          const s = j / pSegs;
          const out = span * Math.sin(s * Math.PI * 0.52);
          const chord = chord0 * Math.pow(Math.max(1 - s * s, 0), 0.42);
          const back = sweep * (0.15 * s + 0.85 * s * s);
          const drop = -(spec.droop ?? 0.22) * sweep * s * s;
          push(x0 + side * out, y0 + drop, z - back, t + s * 0.06, 0.34, partId);
          push(x0 + side * out, y0 + drop - chord * 0.05, z - back - chord, t + s * 0.10, 0.28, partId);
        }
        for (let j = 0; j < pSegs; j++) {
          const a = pStart + j * 2;
          if (side > 0) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      } else {
        const pSegs = spec.segs ?? 3;
        for (let j = 0; j <= pSegs; j++) {
          const s = j / pSegs; // 0=付け根, 1=先端
          const sweep = spec.len * L;
          push(x0 + side * s * spec.width * L * 1.6, y0 - s * sweep * 0.25, z - s * sweep,
               t + s * 0.1, 0.3, partId);
          push(x0 + side * s * spec.width * L * 1.1, y0 - s * sweep * 0.05, z - s * sweep * 0.55,
               t + s * 0.06, 0.35, partId);
        }
        for (let j = 0; j < pSegs; j++) {
          const a = pStart + j * 2;
          if (side > 0) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
    }
  };
  if (pectoral) addPairedFin(pectoral);
  if (pelvic) addPairedFin(pelvic);

  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aBodyUV', new THREE.Float32BufferAttribute(bodyUV, 2));
  geo.setAttribute('aHeight', new THREE.Float32BufferAttribute(height, 1));
  geo.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  geo.computeVertexNormals();
  geo.userData.length = L;
  return geo;
}

// ---- 種ごとのプリセット ----
export const FISH_SHAPES = {
  // マイワシ: 細長い紡錘形
  sardine: () =>
    buildFishGeometry({
      length: 1.0, height: 0.115, width: 0.055,
      hProfile: [0.12, 0.6, 0.9, 1.0, 0.95, 0.8, 0.5, 0.22],
      wProfile: [0.3, 0.75, 0.95, 1.0, 0.9, 0.7, 0.45, 0.22],
      tail: { len: 0.26, height: 0.75, fork: 0.62 },
      dorsal: { from: 0.4, to: 0.6, height: 0.42 },
      pectoral: { at: 0.28, len: 0.16, width: 0.05 },
    }),
  // ナンヨウハギ: 体高のある楕円形で側扁
  tang: () =>
    buildFishGeometry({
      length: 1.0, height: 0.30, width: 0.075,
      hProfile: [0.15, 0.62, 0.95, 1.0, 0.98, 0.85, 0.5, 0.2],
      wProfile: [0.35, 0.8, 1.0, 1.0, 0.9, 0.7, 0.45, 0.25],
      tail: { len: 0.24, height: 0.5, fork: 0.15 },
      dorsal: { from: 0.22, to: 0.78, height: 0.35 },
      pectoral: { at: 0.32, len: 0.22, width: 0.09 },
    }),
  // カクレクマノミ: ずんぐりした楕円
  clownfish: () =>
    buildFishGeometry({
      length: 1.0, height: 0.235, width: 0.10,
      hProfile: [0.2, 0.65, 0.92, 1.0, 0.95, 0.8, 0.5, 0.24],
      wProfile: [0.4, 0.8, 1.0, 1.0, 0.92, 0.72, 0.5, 0.28],
      tail: { len: 0.25, height: 0.55, fork: 0.06 },
      dorsal: { from: 0.28, to: 0.74, height: 0.36 },
      pectoral: { at: 0.3, len: 0.24, width: 0.1 },
    }),
};
