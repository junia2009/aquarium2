import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { fbm3, noise3 } from '../noise.js';
import { addCausticsToStandard, sandHeight } from './seabed.js';

// ============ 流氷の海 ============
//
// 水中から見上げる流氷は、これまでの3ゾーンの「水面」とはまったく別物になる。
//   ・海面のほとんどが白い板で塞がれていて、空が見えるのは割れ目(リード)だけ
//   ・その割れ目だけが眩しく、板の下は一様に薄暗い。
//     氷の海の明暗はほぼこれで決まる(→ glsl.js の iceOpen)
//   ・氷そのものも光を通す。薄いところ・縁・ひび割れがぼうっと明るく、
//     厚い中央は青く沈む。だから「白い板」ではなく「光る天井」に見える
//   ・下面は平らではない。沈み込んだ氷が押し合ってできた竜骨(キール)が
//     下へ深く垂れ、そのあいだが浅い谷になっている
//
// 板をただ白く塗ると発泡スチロールにしかならないので、
// 「どれだけ厚いか」を頂点に持たせ、その厚みで透過光を減衰させている。

const ICE_EXTENT = 160;          // 被覆テクスチャが覆うXZの一辺
const COVER_RES = 256;

// ---- 海底 ----
// 極域の大陸棚。氷河が削った岩盤の上に礫が薄く乗っている。
// うねりの周期は熱帯の砂底より長く、砂紋はない。
export function iceTerrain(x, z) {
  // 大きな起伏(氷河が削り残した岩盤の背)
  let y = fbm3(x * 0.016 + 40, 0, z * 0.016, 3) * 4.6 - 1.6;
  // 中央をやや掘り下げて、見上げたときに空(氷)が広く入るようにする
  const r = Math.hypot(x, z);
  y -= Math.exp(-Math.pow(r / 22, 2)) * 2.2;
  // 礫の粗い凹凸
  y += fbm3(x * 0.11 + 9, 0, z * 0.11, 2) * 0.7;
  return y;
}

// ---- 流氷の配置 ----
//
// 最初は「円板をぶつからないように撒く」で作ったが、それは流氷ではなく
// 蓮の葉になった。海を覆う氷はもともと一枚の板で、それが割れて
// できたものだから、隣り合う板の輪郭は互いに噛み合っている。
// あいだにあるのは「板と板の隙間」ではなく「板を割った線」。
//
// そこでボロノイ分割を使う。ジッタ格子に種を撒き、各種の領域(セル)を
// その板の輪郭にして、全体を少しだけ内側へ縮める。縮めたぶんが
// そのまま割れ目(リード)の幅になり、板は自然に噛み合う。
// いくつかのセルを空けておけば、そこが開水面(ポリニヤ)になる。

const LEAD_HALF = 0.55;      // 割れ目の幅の半分(m)

function rng(seed) {
  let s = (seed * 9781) | 0;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

// 凸多角形を半平面 dot(p - a, d) <= 0 で切る(サザーランド・ホジマン)
function clipPoly(poly, ax, az, dx, dz) {
  const out = [];
  const side = (p) => (p[0] - ax) * dx + (p[1] - az) * dz;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const sp = side(p), sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const t = sp / (sp - sq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

function makeFloes(seed = 1) {
  const rnd = rng(seed);
  const HALF = ICE_EXTENT / 2;
  // 格子の間隔がそのまま板の大きさになる。一部のセルへ種を余分に撒くと、
  // そこだけ細かく割れて小さい板になる——実際の流氷も大小が入り混じる
  const CELL = 19;
  const seeds = [];
  const G = Math.ceil(ICE_EXTENT / CELL) + 2;
  for (let gi = -1; gi < G; gi++) {
    for (let gj = -1; gj < G; gj++) {
      const bx = -HALF + gi * CELL, bz = -HALF + gj * CELL;
      const n = rnd() < 0.34 ? 3 : rnd() < 0.5 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        seeds.push([bx + rnd() * CELL, bz + rnd() * CELL]);
      }
    }
  }

  // 開水面(ポリニヤ)。セルを一枚ずつランダムに間引くだけでは、
  // 細い割れ目が少し増えるだけで「開けた水面」にはならない。
  // 氷の下がどこも同じ明るさになってしまい、リードの真下だけが眩しい
  // という、このゾーンでいちばん見せたい対比が出てこない。
  // まとまった範囲ごと抜いて、光の落ちる場所をはっきり作る。
  const POLYNYAS = [];
  for (let i = 0; i < 4; i++) {
    POLYNYAS.push({
      x: (rnd() - 0.5) * (ICE_EXTENT - 60),
      z: (rnd() - 0.5) * (ICE_EXTENT - 60),
      r: 6 + rnd() * 5,
    });
  }
  // 少なくともひとつは水槽の中心近くに置く。見せ場が端にあっては意味がない
  POLYNYAS[0].x = 6; POLYNYAS[0].z = -9; POLYNYAS[0].r = 10;

  const floes = [];
  for (let i = 0; i < seeds.length; i++) {
    const [sx, sz] = seeds[i];
    if (Math.abs(sx) > HALF + CELL || Math.abs(sz) > HALF + CELL) continue;
    if (POLYNYAS.some((q) => Math.hypot(q.x - sx, q.z - sz) < q.r)) continue;
    // ほかに8%ほどのセルが単独で抜け、細かい隙間になる
    if (rnd() < 0.08) continue;

    // 領域の外枠から始めて、近くの種との垂直二等分線で切っていく
    let poly = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]];
    for (let j = 0; j < seeds.length && poly.length >= 3; j++) {
      if (j === i) continue;
      const [tx, tz] = seeds[j];
      const dx = tx - sx, dz = tz - sz;
      const d2 = dx * dx + dz * dz;
      if (d2 > (CELL * 3.2) ** 2 || d2 < 1e-6) continue;
      const len = Math.sqrt(d2);
      // 二等分線を、割れ目の幅ぶん自分の側へ寄せて切る
      const mx = sx + dx * 0.5 - (dx / len) * LEAD_HALF;
      const mz = sz + dz * 0.5 - (dz / len) * LEAD_HALF;
      poly = clipPoly(poly, mx, mz, dx / len, dz / len);
    }
    if (poly.length < 3) continue;

    // 半径の表(角度→輪郭までの距離)。セルは種について凸なので、
    // 角度で引ける形に落とせる
    const SAMP = 64;
    const rad = new Float32Array(SAMP);
    let rMax = 0;
    for (let a = 0; a < SAMP; a++) {
      const th = (a / SAMP) * Math.PI * 2;
      rad[a] = rayPoly(sx, sz, Math.cos(th), Math.sin(th), poly);
      rMax = Math.max(rMax, rad[a]);
    }
    if (rMax < 2.2) continue;    // 細切れの板は作らない
    // 角を少し丸める。割れたばかりの氷でも、波で縁は削れる
    smoothRing(rad, 2);
    // 縁の細かい欠け
    const fs = rnd() * 100;
    for (let a = 0; a < SAMP; a++) {
      const th = (a / SAMP) * Math.PI * 2;
      rad[a] *= 0.97 + 0.05 * noise3(Math.cos(th) * 3 + fs, Math.sin(th) * 3, 0);
    }

    let rMean = 0;
    for (let a = 0; a < SAMP; a++) rMean += rad[a];
    rMean /= SAMP;

    floes.push({
      x: sx, z: sz, rad, r: rMax, rMean,
      seed: fs,
      // 厚さ。一年氷で1〜2m、多年氷で3m超。大きい板ほど古く厚い
      thick: 0.70 + rMean * 0.085 + rnd() * 0.35,
    });
  }
  floes.polynyas = POLYNYAS;
  return floes;
}

// 点から方向 (dx,dz) に出した半直線が凸多角形の辺と交わる距離
function rayPoly(ox, oz, dx, dz, poly) {
  let best = 1e9;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const ex = q[0] - p[0], ez = q[1] - p[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((p[0] - ox) * ez - (p[1] - oz) * ex) / den;
    const s = ((p[0] - ox) * dz - (p[1] - oz) * dx) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.min(best, t);
  }
  return best === 1e9 ? 0 : best;
}

// 周期配列の移動平均(輪郭の角を丸める)
function smoothRing(arr, passes) {
  const n = arr.length;
  for (let p = 0; p < passes; p++) {
    const cp = Float32Array.from(arr);
    for (let i = 0; i < n; i++) {
      arr[i] = (cp[(i - 1 + n) % n] + cp[i] * 2 + cp[(i + 1) % n]) * 0.25;
    }
  }
}

// 板の輪郭半径(角度の関数)
function floeRadius(f, ang) {
  const n = f.rad.length;
  const x = ((ang / (Math.PI * 2)) % 1 + 1) % 1 * n;
  const i = Math.floor(x), t = x - i;
  return f.rad[i % n] * (1 - t) + f.rad[(i + 1) % n] * t;
}

// 下面の垂れ下がり(0=水面 1=いちばん深い)。
//
// 板なので、下面はほぼ平ら。中央がふくらんだレンズ形にすると、
// どう塗っても氷ではなく錠剤に見える。平らな面に、
//   ・氷どうしが押し合ってできた竜骨(キール)の背
//   ・波と海流に削られた凹凸
// を刻み、縁では削れて薄くなる——ただし切り立った壁は残す。
function floeDraft(f, u, ang) {
  // u: 0=中心 1=縁
  const flat = 0.72 + 0.28 * Math.pow(1 - Math.pow(u, 3.2), 0.6);
  // 竜骨: ある方位に沿って走る深い背。押し合った跡なので直線的
  const keelDir = f.seed * 1.7;
  const across = Math.abs(Math.sin(ang - keelDir)) * u;
  const keel = Math.exp(-Math.pow(across / 0.28, 2)) * 0.60 * (1 - u * 0.35);
  // 二本目の、浅くて広い背
  const keel2 = Math.exp(-Math.pow((Math.abs(Math.sin(ang - keelDir - 1.1)) * u) / 0.55, 2)) * 0.22;
  // 削られた凹凸
  const cx = Math.cos(ang) * u, cz = Math.sin(ang) * u;
  const bump = noise3(cx * 4.5 + f.seed * 3, cz * 4.5, 3) * 0.26
             + noise3(cx * 11 + f.seed * 5, cz * 11, 8) * 0.14
             + noise3(cx * 26 + f.seed * 7, cz * 26, 2) * 0.07;
  // 縁は薄いが、垂直の壁になるだけの厚みは残す
  const rimCut = Math.pow(u, 6.0) * 0.42;
  return Math.max(flat + keel + keel2 + bump - 0.22 - rimCut, 0.22);
}

/**
 * 流氷の天蓋。1つのマージ済みメッシュとして作る。
 * @returns { mesh, floes, coverTexture, leadSpots }
 */
export function createIceCanopy(scene, { seed = 1 } = {}) {
  const floes = makeFloes(seed);
  const RINGS = 9, SEGS = 44;

  const pos = [], nrm = [], idx = [];
  const thickA = [], edgeA = [], seedA = [];
  const Y = WORLD.surfaceY;

  for (const f of floes) {
    const base = pos.length / 3;
    // 喫水。海氷は密度が水の約 0.92 なので、9割は水面下に沈む
    const draft = f.thick * 0.90;
    const free = f.thick * 0.10;

    // --- 下面(リング状のグリッド) ---
    for (let i = 0; i <= RINGS; i++) {
      const u = i / RINGS;
      for (let j = 0; j < SEGS; j++) {
        const ang = (j / SEGS) * Math.PI * 2;
        const rr = floeRadius(f, ang) * u;
        const d = floeDraft(f, u, ang) * draft;
        pos.push(f.x + Math.cos(ang) * rr, Y - d, f.z + Math.sin(ang) * rr);
        nrm.push(0, -1, 0);
        thickA.push(d + free);
        edgeA.push(u);
        seedA.push(f.seed);
      }
    }
    for (let i = 0; i < RINGS; i++) {
      for (let j = 0; j < SEGS; j++) {
        const jn = (j + 1) % SEGS;
        const a = base + i * SEGS + j, b = base + i * SEGS + jn;
        const c = base + (i + 1) * SEGS + j, d2 = base + (i + 1) * SEGS + jn;
        idx.push(a, b, c, b, d2, c);
      }
    }

    // --- 上面(雪をかぶった平らな板。水面上へわずかに出る) ---
    const topBase = pos.length / 3;
    for (let i = 0; i <= RINGS; i++) {
      const u = i / RINGS;
      for (let j = 0; j < SEGS; j++) {
        const ang = (j / SEGS) * Math.PI * 2;
        const rr = floeRadius(f, ang) * u;
        // 雪の吹き溜まり。縁では風に削られて薄い
        // 雪の吹き溜まり。乾いた雪が風で運ばれて積もるので、
        // 板の乾舷そのものより厚くなる。ここを削ると水面と面一になり、
        // 上から見たとき「氷の板」ではなく「水に浮いた紙」に見える
        const snow = free * (1.2 + 1.7 * noise3(Math.cos(ang) * u * 3 + f.seed, Math.sin(ang) * u * 3, 5))
                   * (1 - Math.pow(u, 3));
        pos.push(f.x + Math.cos(ang) * rr, Y + free * 0.3 + snow, f.z + Math.sin(ang) * rr);
        nrm.push(0, 1, 0);
        thickA.push(free + snow);
        edgeA.push(u);
        seedA.push(f.seed);
      }
    }
    for (let i = 0; i < RINGS; i++) {
      for (let j = 0; j < SEGS; j++) {
        const jn = (j + 1) % SEGS;
        const a = topBase + i * SEGS + j, b = topBase + i * SEGS + jn;
        const c = topBase + (i + 1) * SEGS + j, d2 = topBase + (i + 1) * SEGS + jn;
        idx.push(a, c, b, b, c, d2);
      }
    }

    // --- 側面(下面の縁と上面の縁をつなぐ壁) ---
    const rimB = base + RINGS * SEGS;
    const rimT = topBase + RINGS * SEGS;
    for (let j = 0; j < SEGS; j++) {
      const jn = (j + 1) % SEGS;
      idx.push(rimB + j, rimT + j, rimB + jn);
      idx.push(rimB + jn, rimT + j, rimT + jn);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('aThick', new THREE.Float32BufferAttribute(thickA, 1));
  geo.setAttribute('aEdge', new THREE.Float32BufferAttribute(edgeA, 1));
  geo.setAttribute('aSeed', new THREE.Float32BufferAttribute(seedA, 1));
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aThick;
      attribute float aEdge;
      attribute float aSeed;
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vThick;
      varying float vEdge;
      varying float vSeed;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        vThick = aThick;
        vEdge = aEdge;
        vSeed = aSeed;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: UW_FRAG_PRELUDE + /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      varying float vThick;
      varying float vEdge;
      varying float vSeed;

      void main() {
        vec3 n = normalize(vNormal);
        if (!gl_FrontFacing) n = -n;
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec2 p = vWorldPos.xz;

        // ---- 氷の中身 ----
        // 海氷は真水の氷とちがって、凍るときに追い出された塩水が
        // 細い管(ブラインチャンネル)として無数に残る。これが光を散らすので
        // 白く濁って見える。管の少ない古い氷ほど透明で、青い。
        float brine = fbm(p * 1.7 + vSeed);
        float channels = pow(abs(sin(fbm(p * 0.55 + vSeed * 2.0) * 9.0)), 8.0);

        // ---- 透過光 ----
        // 上から差した光が板を通って下面へ抜けてくる。厚いほど減衰し、
        // 赤から先に吸われるので、抜けてきた光は青く見える。
        // ここが「白い板」と「光る天井」を分ける
        vec3 kappa = vec3(1.45, 0.62, 0.36);          // 厚み1mあたりの減衰
        float thick = max(vThick, 0.05) * (0.75 + 0.5 * brine);
        vec3 trans = exp(-kappa * thick);
        // 割れ目やひび、板の縁は極端に薄いので、そこだけ白く輝く
        float rim = smoothstep(0.72, 1.0, vEdge);
        // ひびは「線」。fbm をそのまま累乗すると染みのような面になる
        float cw = fbm(p * 0.14 + vSeed * 3.0 + 5.0);
        float crack = smoothstep(0.011, 0.0, abs(cw - 0.5)) * 0.24;
        trans += vec3(1.0) * (rim * 0.50 + crack);

        // ---- 下面か上面か ----
        // 下から見上げるときは透過光が主役。上から見るときは雪の反射が主役
        float under = clamp(-n.y * 0.5 + 0.5, 0.0, 1.0);

        vec3 iceCol = mix(vec3(0.42, 0.62, 0.74), vec3(0.10, 0.32, 0.46),
                          smoothstep(0.4, 2.6, thick));
        vec3 snowCol = vec3(0.86, 0.90, 0.94) * (0.9 + 0.2 * brine);

        // 下面のざらつき。凍りついた微結晶が細かく光を返す
        float frost = 0.85 + 0.30 * fbm(p * 6.0 + vSeed * 7.0);
        vec3 albedo = mix(snowCol, iceCol * frost, under);
        albedo = mix(albedo, albedo + vec3(0.20, 0.24, 0.26), channels * under * 0.8);

        vec3 col = underwaterLight(albedo, n, vWorldPos, V, 26.0, 0.22);
        // 透過光。氷を通ってきたぶんなので、氷の影(iceOpen)は掛けない——
        // 掛けると自分自身の影で消えてしまう
        col += uSunColor * trans * uSunI * under * 0.85;
        // 水面のさざなみが下面に映す揺れる光。
        // リードから入った光が波で曲げられて、氷の裏に模様を投げる
        float ripple = causticIter((p + uTime * 0.03) * 0.09, uTime * 0.4);
        col += uSunColor * ripple * under * 1.1 * uSunI * iceOpen(vWorldPos - vec3(0.0, 0.4, 0.0));
        // 縁のフレネル
        col += uAmbTop * pow(1.0 - abs(dot(n, V)), 3.0) * 0.35;

        col = applyUnderwaterFog(col, vWorldPos);
        gl_FragColor = vec4(col, 1.0);
        ${UW_FRAG_OUTPUT}
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -4;      // 水面より手前(水面は -5)
  scene.add(mesh);

  return {
    mesh, floes,
    coverTexture: bakeCover(floes),
    leadSpots: findLeads(floes),
    polynyas: floes.polynyas,
    field: bakeField(floes),
  };
}

// ---- 氷の高さ場 ----
// 泳ぐペンギンは氷を突き抜けてはいけないし、氷の上へ跳び乗るには
// 板の甲板がどこにあるかを知らなければならない。
// どちらも「その (x,z) の真上に何があるか」を毎フレーム引く問題になる。
//
// floeDraft() を直接呼ぶと、板146枚 × 個体数 ぶんの atan2 とノイズを
// 毎フレーム回すことになる。地形と同じように、あらかじめ格子へ焼いて
// 双一次補間で引く。
const FIELD_RES = 160;

function bakeField(floes) {
  const N = FIELD_RES;
  const px = ICE_EXTENT / N;
  const Y = WORLD.surfaceY;
  // under: 泳げる上限(氷の下面)。氷がなければ水面
  // deck : 氷の上面。氷がなければ -Infinity の代わりに大きな負の数
  const under = new Float32Array(N * N).fill(Y);
  const deck = new Float32Array(N * N).fill(-1e4);

  for (const f of floes) {
    const draft = f.thick * 0.90;
    const free = f.thick * 0.10;
    const i0 = Math.max(Math.floor((f.x - f.r + ICE_EXTENT / 2) / px) - 1, 0);
    const i1 = Math.min(Math.ceil((f.x + f.r + ICE_EXTENT / 2) / px) + 1, N - 1);
    const j0 = Math.max(Math.floor((f.z - f.r + ICE_EXTENT / 2) / px) - 1, 0);
    const j1 = Math.min(Math.ceil((f.z + f.r + ICE_EXTENT / 2) / px) + 1, N - 1);
    for (let j = j0; j <= j1; j++) {
      const z = (j + 0.5) * px - ICE_EXTENT / 2;
      for (let i = i0; i <= i1; i++) {
        const x = (i + 0.5) * px - ICE_EXTENT / 2;
        const dx = x - f.x, dz = z - f.z;
        const d = Math.hypot(dx, dz);
        const ang = Math.atan2(dz, dx);
        const rr = floeRadius(f, ang);
        if (d > rr) continue;
        const u = d / Math.max(rr, 1e-3);
        const k = j * N + i;
        under[k] = Math.min(under[k], Y - floeDraft(f, u, ang) * draft);
        deck[k] = Math.max(deck[k], Y + free * 0.3 + free * 1.2 * (1 - Math.pow(u, 3)));
      }
    }
  }

  const sample = (arr, x, z, outside) => {
    const fx = (x + ICE_EXTENT / 2) / px - 0.5;
    const fz = (z + ICE_EXTENT / 2) / px - 0.5;
    if (fx < 0 || fz < 0 || fx > N - 1 || fz > N - 1) return outside;
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const i1 = Math.min(i + 1, N - 1), j1 = Math.min(j + 1, N - 1);
    const a = arr[j * N + i] * (1 - tx) + arr[j * N + i1] * tx;
    const b = arr[j1 * N + i] * (1 - tx) + arr[j1 * N + i1] * tx;
    return a * (1 - tz) + b * tz;
  };

  return {
    /** その位置で泳げる上限(氷の下面、氷がなければ水面) */
    under: (x, z) => sample(under, x, z, Y),
    /** 氷の甲板の高さ。氷がなければ大きな負の数 */
    deck: (x, z) => sample(deck, x, z, -1e4),
    /** その位置に氷があるか(縁のぼけを避けたいので甲板で判定) */
    hasIce: (x, z) => sample(deck, x, z, -1e4) > -100,
  };
}

// ---- 被覆テクスチャ ----
// 板の輪郭をXZ平面のグレースケールに焼く。縁はぼかす:
// 氷の影の境目は、深くなるほど散乱光で甘くなるので、
// くっきりした型抜きにしてはいけない。
function bakeCover(floes) {
  const N = COVER_RES;
  const px = ICE_EXTENT / N;
  const buf = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    const z = (j + 0.5) * px - ICE_EXTENT / 2;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * px - ICE_EXTENT / 2;
      let cover = 0;
      for (const f of floes) {
        const dx = x - f.x, dz = z - f.z;
        const d = Math.hypot(dx, dz);
        if (d > f.r * 1.3) continue;
        const rr = floeRadius(f, Math.atan2(dz, dx));
        // 縁から内側 1.5m で完全被覆へ
        const c = Math.min(Math.max((rr - d) / 1.5, 0), 1);
        cover = Math.max(cover, c);
      }
      const k = (j * N + i) * 4;
      buf[k] = buf[k + 1] = buf[k + 2] = Math.round(cover * 255);
      buf[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(buf, N, N);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// ---- リード(割れ目)の場所 ----
// 光芒を差し込ませる位置。板の下に立てても意味がないので、
// 実際に空いているところを探して返す。
function findLeads(floes) {
  const spots = [];
  for (let i = 0; i < 900 && spots.length < 7; i++) {
    const a = i * 2.39996323;
    const r = Math.sqrt(i / 900) * 50;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    let open = true;
    for (const f of floes) {
      const dx = x - f.x, dz = z - f.z;
      const d = Math.hypot(dx, dz);
      if (d > f.r + 2.0) continue;
      if (d < floeRadius(f, Math.atan2(dz, dx)) + 1.5) { open = false; break; }
    }
    if (!open) continue;
    if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 9)) continue;
    spots.push({ x, z });
  }
  return spots;
}

export { ICE_EXTENT };

// ============ 礫底と迷子石 ============
// 極域の海底は砂ではなく礫。そこへ、氷山が運んできて落とした
// 大きな石(dropstone / 迷子石)がぽつんと転がっている。
// まわりに何もない平らな礫の上に、ひとつだけ角ばった巨石がある——
// あの不自然さが、氷の海の海底のいちばんの目印になる。
export function createDropstones(scene) {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#5b6168'),
    roughness: 0.96,
    metalness: 0.0,
  });
  addCausticsToStandard(mat, 0.7);

  const colliders = [];
  const spots = [
    { x: -14, z: -9, s: 2.6, seed: 21 },
    { x: 12, z: -15, s: 3.4, seed: 5 },
    { x: 17, z: 7, s: 1.9, seed: 13 },
    { x: -8, z: 16, s: 2.2, seed: 31 },
    { x: -20, z: 3, s: 1.5, seed: 44 },
    { x: 3, z: 20, s: 2.0, seed: 8 },
    { x: 22, z: -3, s: 1.3, seed: 17 },
  ];
  for (const s of spots) {
    const geo = new THREE.IcosahedronGeometry(s.s, 3);
    const p = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const nn = v.clone().normalize();
      // 氷河が削った石は角が立っている。丸い礫より変位を粗くする
      const d = fbm3(nn.x * 2.4 + s.seed * 7, nn.y * 2.4, nn.z * 2.4, 3);
      v.addScaledVector(nn, (d - 0.45) * s.s * 0.7);
      v.y *= 0.66;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, mat);
    m.position.set(s.x, sandHeight(s.x, s.z) + s.s * 0.10, s.z);
    m.rotation.set(s.seed * 0.3, s.seed * 1.9, s.seed * 0.17);
    group.add(m);
    colliders.push({ center: m.position.clone(), rx: s.s * 1.1, ry: s.s * 0.8, rz: s.s * 1.1 });
  }
  scene.add(group);
  return { group, colliders };
}
