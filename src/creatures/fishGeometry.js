import * as THREE from 'three';

// ============ 魚の手続き的ジオメトリ ============
// 鼻先 z=+L/2、尾 z=-L/2。楕円断面のリングを連ねて紡錘形の体を作り、
// 尾びれ・背びれ・胸びれを別パートとして結合する。
// 頂点属性:
//   aPart  : 0=体, 1=尾びれ, 2=背びれ, 3=胸びれ左, 4=胸びれ右
//   aBodyUV: x=体軸方向 0(鼻)→1(尾), y=高さ方向 0(腹)→1(背)

// 配列を 0..1 のtで線形補間サンプリング
function sampleProfile(arr, t) {
  const f = Math.min(Math.max(t, 0), 1) * (arr.length - 1);
  const i = Math.floor(f);
  const u = f - i;
  if (i >= arr.length - 1) return arr[arr.length - 1];
  return arr[i] * (1 - u) + arr[i + 1] * u;
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
    // lobe: 上葉の伸び(サメ類) / horizontal: 水平尾びれ(クジラ類のフリューク)
    tail = { len: 0.32, height: 0.55, fork: 0.45, lobe: 0, horizontal: false },
    dorsal = { from: 0.32, to: 0.72, height: 0.5 },
    pectoral = { at: 0.3, len: 0.30, width: 0.14 },
  } = opts;

  const positions = [];
  const bodyUV = [];
  const part = [];
  const indices = [];

  // ---- 体(リング) ----
  const zNose = L / 2;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const z = zNose - t * (L - tail.len * L * 0.15);
    const hh = sampleProfile(hProfile, t) * H;
    const ww = sampleProfile(wProfile, t) * W;
    const yc = sampleProfile(yOffset, t) * H;
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      const y = Math.cos(a); // 1=背, -1=腹
      const x = Math.sin(a);
      positions.push(x * ww, yc + y * hh, z);
      bodyUV.push(t, y * 0.5 + 0.5);
      part.push(0);
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

  // 鼻先キャップ
  const noseIdx = positions.length / 3;
  positions.push(0, sampleProfile(yOffset, 0) * H, zNose + L * 0.015);
  bodyUV.push(0, 0.5);
  part.push(0);
  for (let j = 0; j < radial; j++) {
    indices.push(noseIdx, j, (j + 1) % radial);
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
      const cy = Math.cos(a), sx = Math.sin(a);
      const u = horizontal ? sx : cy;        // 広がり方向の座標
      positions.push(sx * halfW, pedY + cy * halfH, zPed - s * extAt(u));
      bodyUV.push(1.0 + s * 0.22, cy * 0.5 + 0.5);
      part.push(1);
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

  // ---- 背びれ(体の背に沿った帯) ----
  if (dorsal) {
    const dSegs = 6;
    const dStart = positions.length / 3;
    for (let j = 0; j <= dSegs; j++) {
      const t = dorsal.from + (dorsal.to - dorsal.from) * (j / dSegs);
      const z = zNose - t * (L - tail.len * L * 0.15);
      const topY = sampleProfile(yOffset, t) * H + sampleProfile(hProfile, t) * H;
      // 前縁が高く後方へ低くなる
      const finH = dorsal.height * H * (1.0 - 0.55 * (j / dSegs)) * Math.sin(Math.PI * Math.min((j / dSegs) * 2.5 + 0.15, 1));
      positions.push(0, topY - 0.01, z);
      bodyUV.push(t, 1.0);
      part.push(2);
      positions.push(0, topY + finH, z - finH * 0.55);
      bodyUV.push(t, 1.15);
      part.push(2);
    }
    for (let j = 0; j < dSegs; j++) {
      const a = dStart + j * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  // ---- 胸びれ(左右の小さな板) ----
  if (pectoral) {
    for (const side of [1, -1]) {
      const partId = side > 0 ? 4 : 3;
      const t = pectoral.at;
      const z = zNose - t * L;
      const x0 = sampleProfile(wProfile, t) * W * 0.9 * side;
      const y0 = sampleProfile(yOffset, t) * H - sampleProfile(hProfile, t) * H * 0.25;
      const pSegs = 3;
      const pStart = positions.length / 3;
      for (let j = 0; j <= pSegs; j++) {
        const s = j / pSegs; // 0=付け根, 1=先端
        const sweep = pectoral.len * L;
        positions.push(
          x0 + side * s * pectoral.width * L * 1.6,
          y0 - s * sweep * 0.25,
          z - s * sweep
        );
        bodyUV.push(t + s * 0.1, 0.3);
        part.push(partId);
        positions.push(
          x0 + side * s * pectoral.width * L * 1.1,
          y0 - s * sweep * 0.05,
          z - s * sweep * 0.55
        );
        bodyUV.push(t + s * 0.06, 0.35);
        part.push(partId);
      }
      for (let j = 0; j < pSegs; j++) {
        const a = pStart + j * 2;
        if (side > 0) indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        else indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aBodyUV', new THREE.Float32BufferAttribute(bodyUV, 2));
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
