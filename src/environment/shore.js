import * as THREE from 'three';
import { baseUniforms, U, WORLD } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT, UW_SKY } from '../glsl.js';
import { fbm3, noise3 } from '../noise.js';

// ============ 磯(岩礁海岸) ============
//
// ここまでの4ゾーンは、どれも「水の中」の話だった。水面はいつも頭上の
// 天井で、位置が変わることもなかった。
//
// 磯は水際そのものが主役になる。潮が満ちれば岩が沈み、引けば現れる。
// 波が寄せれば水は岩を駆け上がり、引けば泡だけが残る。同じ岩が
// 1分後には濡れて黒く、5分後には乾いて白い。
//
// この「濡れているかどうかの履歴」が、磯のすべてを決めている。
// 生き物がどこに住めるかも、岩が何色に見えるかも。

// ---- 潮 ----
// 実際の潮汐は半日周期だが、それでは誰も満ち引きを見られない。
// 3分でひと回りさせる。干満差は2.2m——日本の太平洋岸の大潮くらい。
export const TIDE = {
  mean: WORLD.surfaceY,   // 平均水面。ほかのゾーンと同じ16
  amp: 1.1,               // 片振幅。満潮 17.1 / 干潮 14.9
  period: 180,            // 秒
};

/** t 秒における潮位 */
export function tideAt(t) {
  return TIDE.mean + TIDE.amp * Math.sin((t / TIDE.period) * Math.PI * 2 - Math.PI * 0.5);
}

// ---- 波の打ち寄せ ----
// 潮位の上にもう一段、数秒周期のうねりが乗る。これが岩を駆け上がって
// 戻る「波」になる。単純な正弦にすると機械的なので、周期の違う3つを
// 重ねて、たまに大きいのが来るようにする(実際、磯で待っていると
// 数分に一度だけ足元まで届く波が来る)
export function surgeAt(t) {
  return 0.30 * Math.sin(t * 0.62)
       + 0.20 * Math.sin(t * 0.41 + 1.7)
       + 0.14 * Math.sin(t * 0.23 + 4.1);
}

/** いまの水際の高さ(潮位 + 波の打ち上げ) */
export function waterAt(t) { return tideAt(t) + surgeAt(t); }

// ---- 地形 ----
// -Z が沖、+Z が陸。断面は沖で急に落ち、潮間帯でいったん平らな棚になり、
// そこから陸へ立ち上がる。この「棚」が磯の主役で、干満差のなかに
// すっぽり収まっていないと、潮が引いても現れる岩がない。
const PROFILE = [
  [-40, 1.0], [-30, 4.2], [-22, 8.4], [-15, 12.2], [-10, 14.2],
  [-5, 15.35], [0, 15.75], [5, 16.15], [9, 16.75], [14, 18.2],
  [20, 20.4], [28, 23.2], [40, 27.0],
];

function profileAt(z) {
  if (z <= PROFILE[0][0]) return PROFILE[0][1];
  const last = PROFILE[PROFILE.length - 1];
  if (z >= last[0]) return last[1];
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [z0, y0] = PROFILE[i], [z1, y1] = PROFILE[i + 1];
    if (z <= z1) {
      const t = (z - z0) / (z1 - z0);
      return y0 + (y1 - y0) * (t * t * (3 - 2 * t));   // なめらかに繋ぐ
    }
  }
  return last[1];
}

// ---- 潮だまり ----
// 岩の窪みに取り残された水。磯でいちばん見たいものなので、
// 偶然できるのに任せず、置く場所を決めておく。
//
// r は半径、depth は縁からの深さ。縁(rim)と底(floor)の実高は
// 地形から測って後で埋める。
//
// 深さは実物どおり浅く。10〜50cmしかない。
//
// 最初これを1.6mの窪みにしていたら、干潮の海面(14.9m)より底が
// 低くなり、世界じゅうに敷いてある海面の一枚板が窪みの中に顔を出した。
// 岩に空いた穴から海が覗いて、白く光って見えた原因はこれ。
// 潮だまりの底は、いちばん潮が引いたときの海面より上になければならない。
export const POOLS = [
  { x: -7.5, z: 1.5, r: 3.4, depth: 0.42 },
  { x: 4.0, z: -1.0, r: 2.6, depth: 0.34 },
  { x: 11.5, z: 3.5, r: 2.1, depth: 0.28 },
  { x: -15.0, z: 5.0, r: 1.7, depth: 0.24 },
  { x: 0.5, z: 6.5, r: 1.4, depth: 0.20 },
];

/** 潮だまりの窪み。地形から引く深さを返す */
function poolCut(x, z) {
  let cut = 0;
  for (const p of POOLS) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d > p.r * 1.35) continue;
    // 縁は立ち上がり、中は平らな皿。縁を鋭くしないと水が溜まって見えない
    const u = Math.min(d / p.r, 1.35);
    const bowl = u < 1 ? 1 - u * u * u : 0;
    cut = Math.max(cut, bowl * p.depth);
  }
  return cut;
}

/**
 * 磯の高さ場。
 * 岩は砂と違って「面」ではなく「割れて積み重なったもの」なので、
 * なめらかなノイズだけだと粘土の丘になる。段(ベンチ)と割れ目を入れる。
 */
function rockBase(x, z) {
  let y = profileAt(z);
  // 岬と入り江。岸に沿った起伏で、まっすぐな斜面に見えないようにする
  const bay = Math.sin(x * 0.075) * 1.5 + Math.sin(x * 0.031 + 2.2) * 2.3;
  // 潮間帯の棚のあたりでだけ強く効かせる。沖と陸では薄める
  const bench = Math.exp(-Math.pow((z - 2) / 16, 2));
  y += bay * (0.35 + 0.65 * bench);
  // 岩塊。粗いうねりから細かい凹凸まで3段。ここを1段で済ませると
  // 「なめらかな丘」になり、どれだけ色を岩にしても砂丘に見える
  y += fbm3(x * 0.055, 0, z * 0.055, 3) * 1.5;
  y += fbm3(x * 0.17 + 11, 0, z * 0.17, 3) * 0.55;
  y += fbm3(x * 0.52 + 41, 0, z * 0.52, 2) * 0.16;
  // 段。堆積岩の層が波に削られると階段状の棚になる。
  // 高さを量子化するだけで、粘土の丘が割れた岩に変わる。
  // 磯全体に効かせること——潮間帯だけ段にすると、そこだけ床材に見える
  const step = 0.60;
  y += (Math.round(y / step) * step - y) * (0.42 + 0.34 * bench);
  // 割れ目。細く深い溝が岸に直交して何本も走る。
  // 幅は数十cm。ここを広くすると溝ではなく谷になる
  const seam = Math.abs(Math.sin(x * 0.62 + noise3(x * 0.03, 0, z * 0.03) * 3.0));
  y -= Math.pow(1 - Math.min(seam * 7.0, 1), 2) * 0.55 * (0.4 + 0.6 * bench);
  // 岸に平行な層理面の隙間も一組
  const bed = Math.abs(Math.sin(z * 0.48 + noise3(x * 0.04, 0, z * 0.02) * 2.2));
  y -= Math.pow(1 - Math.min(bed * 8.0, 1), 2) * 0.30 * bench;
  return y;
}

/** 磯の高さ場(潮だまりの窪みまで入れた最終形) */
export function shoreTerrain(x, z) {
  return rockBase(x, z) - poolCut(x, z);
}

// 縁の高さは地形から測る。手で置くと必ず地形とずれて、
// 「水面が岩にめり込んでいる」か「宙に浮いている」かのどちらかになる。
// いちばん低い縁がこぼれ口になり、そこまでしか水は溜まらない
for (const p of POOLS) {
  let lo = Infinity;
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    lo = Math.min(lo, rockBase(p.x + Math.cos(a) * p.r * 1.04, p.z + Math.sin(a) * p.r * 1.04));
  }
  p.rim = lo;
  p.floor = lo - p.depth;
}

/** そこが潮だまりの中なら、その定義を返す */
export function poolAt(x, z) {
  for (const p of POOLS) if (Math.hypot(x - p.x, z - p.z) < p.r) return p;
  return null;
}

/**
 * その地点の「水面」。潮だまりの中では、海が引いても縁の高さまで水が残る。
 * 生き物の判定にも描画にも同じ関数を使う——別々に持つと必ずずれる
 */
export function localWater(x, z, sea) {
  const p = poolAt(x, z);
  if (!p) return sea;
  // 縁いっぱいには溜まらない。少し蒸発・浸透したぶん下がる
  return Math.max(sea, Math.min(p.rim - 0.06, p.rim));
}

// ============ 岩 ============
// 磯の岩の色は、その高さが「1日のうちどれだけ水に浸かるか」で決まる。
// 上から順に、乾いた岩・黒い地衣類・フジツボ・イガイ・海藻。
// この帯状分布(zonation)は世界中の岩礁で見られるもので、
// 磯を磯に見せているのはほとんどこれ。
export function createShoreRock(parent) {
  const size = 190, seg = 384;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, shoreTerrain(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...baseUniforms(),
      // 潮位。帯の位置がこれで上下する
      uTide: { value: TIDE.mean },
      // いまの水際(潮位＋波)。濡れの境目
      uWater: { value: TIDE.mean },
      // 直前まで水が来ていた高さ。ここまでは濡れている
      uWetTop: { value: TIDE.mean },
      // 潮だまり (x, z, 半径, 水面の高さ)。
      // 岩のほうにも渡さないと、溜まりの中の岩が「乾いた岩」に塗られる。
      // 水の膜を上に貼るだけでは水に見えない——覗きこんで見えているのは
      // ほとんど「濡れて黒くなった底」のほうだから
      uPools: { value: POOLS.map((p) => new THREE.Vector4(p.x, p.z, p.r, p.rim - 0.06)) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      varying vec3 vN;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: UW_FRAG_PRELUDE + /* glsl */ `
      uniform float uTide;
      uniform float uWater;
      uniform float uWetTop;
      uniform vec4 uPools[${POOLS.length}];
      varying vec3 vW;
      varying vec3 vN;

      void main() {
        vec3 n = normalize(vN);
        float h = vW.y;

        // ---- 岩の地色 ----
        // 一色で塗ると樹脂の塊になる。粒の粗さと、層に沿った縞を入れる。
        //
        // 反射率は低く保つこと。乾いた岩でも0.2〜0.3、濡れれば0.1を切る。
        // ここを0.5にしていたら、水上の直射日光で真っ白に飛んで
        // 帯状分布が一切見えなくなった(砂丘のような絵になった)
        float grain = fbm(vW.xz * 0.55) * 0.5 + fbm(vW.xz * 2.4) * 0.3;
        float strata = fbm(vec2(vW.x * 0.22, vW.y * 1.6));
        vec3 dry  = mix(vec3(0.120, 0.113, 0.104), vec3(0.205, 0.194, 0.178), grain);
        dry = mix(dry, vec3(0.158, 0.142, 0.124), strata * 0.5);

        // ---- 帯状分布 ----
        // 高さを「潮位からの差」で測る。潮が動けば帯も動く……のではなく、
        // 帯は動かない。生き物は平均的な水位に合わせて住み着いているので、
        // 基準は平均潮位(uTide ではなく固定の平均)であるべき。
        // ここを uWater にすると、波が来るたびにフジツボの帯が
        // 上下に泳いでしまう
        float rel = h - ${TIDE.mean.toFixed(2)};

        // 海藻帯(潮下帯)。いつも水の中。褐藻の暗いオリーブ
        float weed = smoothstep(-0.30, -1.30, rel)
                   * (0.55 + 0.45 * fbm(vW.xz * 0.38));
        // イガイ床(潮間帯下部)。青黒い殻がびっしり
        float mussel = smoothstep(-1.05, -0.55, rel) * smoothstep(0.15, -0.25, rel)
                     * smoothstep(0.20, 0.32, fbm(vW.xz * 0.46));
        // フジツボ帯(潮間帯上部)。白い石灰質の殻
        float barn = smoothstep(-0.15, 0.30, rel) * smoothstep(1.35, 0.75, rel)
                   * smoothstep(0.18, 0.30, fbm(vW.xz * 0.58));
        // 地衣類帯(飛沫帯)。しぶきだけが届く高さに黒い膜が張る。
        // これがあると岩の上端が急に「海岸」に見える
        float lichen = smoothstep(1.10, 1.70, rel) * smoothstep(3.4, 2.2, rel)
                     * smoothstep(0.26, 0.44, fbm(vW.xz * 0.32));

        vec3 col = dry;
        col = mix(col, vec3(0.038, 0.034, 0.028), lichen * 0.95);    // 地衣類
        col = mix(col, vec3(0.760, 0.735, 0.680), barn * 0.96);       // フジツボ
        col = mix(col, vec3(0.022, 0.022, 0.036), mussel * 0.95);     // イガイ
        col = mix(col, vec3(0.034, 0.048, 0.020), weed * 0.95);       // 海藻
        // 海藻帯には緑藻の斑も混ぜる。褐藻一色だと黒い泥に見える
        col = mix(col, vec3(0.098, 0.176, 0.068),
                  weed * smoothstep(0.52, 0.74, fbm(vW.xz * 0.72)) * 0.7);

        // 上を向いた面ほど生き物が付く……のだが、ここを厳しくしすぎると
        // 帯が消える。段々に削れた岩は法線が寝ていないので、
        // smoothstep(0.35, 0.85, n.y) では全面が「壁」と判定されて
        // 帯が15%まで薄まり、一様な灰色の岩になっていた。
        // 実際のフジツボもイガイも垂直な岩壁にびっしり付く。
        // 裸のままなのは、天井になった庇と、波に削られ続ける面だけ
        float up = smoothstep(0.02, 0.55, n.y);
        col = mix(dry, col, 0.38 + 0.62 * up);

        // ---- 濡れ ----
        // 水没しているところ、波が届いたばかりのところ、乾いたところ。
        // 濡れた岩は暗く艶が出る。これが無いと潮が引いても絵が変わらない
        float sub = smoothstep(0.05, -0.10, h - uWater);        // いま水の下
        float damp = smoothstep(0.02, -0.55, h - uWetTop);      // さっきまで濡れていた
        // 潮だまりの中。海が引いてもここだけは水の下に残る
        float inPool = 0.0;
        for (int i = 0; i < ${POOLS.length}; i++) {
          vec4 pl = uPools[i];
          float d = length(vW.xz - pl.xy);
          inPool = max(inPool, smoothstep(pl.z, pl.z * 0.90, d)
                             * smoothstep(0.04, -0.10, h - pl.w));
        }
        float wet = max(max(sub, inPool), damp * 0.72);
        col *= mix(1.0, 0.58, wet);

        vec3 viewDir = normalize(cameraPosition - vW);
        // 濡れた岩はよく光る。乾いた岩はほとんど光らない
        // 濡れた岩は光るが、鏡ではない。強度を0.55にしていたら、
        // 潮だまりのような凹んだ面でハイライトが皿いっぱいに広がって、
        // 岩に空いた穴が発光しているように見えた。濡れた岩の鏡面反射は
        // せいぜい0.1程度で、効くのは「艶が出る」ところまで
        vec3 lit = underwaterLight(col, n, vW, viewDir, mix(8.0, 42.0, wet), mix(0.015, 0.10, wet));

        // ---- 泡 ----
        // 水際の白。波が砕けた線と、引いたあとに残る泡の名残。
        // 泡は水際にぴたりと張り付くのではなく、少し上に残る
        float lineF = smoothstep(0.30, 0.0, abs(h - uWater))
                    * (0.45 + 0.55 * fbm(vec2(vW.x * 3.4, vW.z * 3.4 + uTime * 1.6)));
        float left = smoothstep(0.0, 0.45, h - uWater) * smoothstep(0.75, 0.10, h - uWater)
                   * smoothstep(0.45, 0.75, fbm(vec2(vW.x * 5.0, vW.z * 5.0 - uTime * 0.7)));
        float foam = clamp(lineF * 0.85 + left * 0.6, 0.0, 1.0) * up;
        lit = mix(lit, vec3(0.92, 0.95, 0.96), foam);

        gl_FragColor = vec4(applyUnderwaterFog(lit, vW), 1.0);
        ${UW_FRAG_OUTPUT}
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -4;
  parent.add(mesh);
  return { mesh, mat };
}

// ============ 潮だまりの水面 ============
// 海が引いても、窪みの水は縁の高さで残る。海の一枚板とは別に、
// 小さな円盤を潮だまりごとに置く。海面がその縁より上にあるときは
// 隠す——二重に描くと水面が二枚重なって暗くなる。
export function createTidePools(parent) {
  const group = new THREE.Group();
  const discs = [];
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...baseUniforms() },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vW;
      varying vec2 vL;
      void main() {
        vL = position.xz;
        vec3 p = position;
        // 溜まり水はうねらない。風で細かく震えるだけ
        p.y += sin(p.x * 9.0 + uTime * 2.3) * 0.008
             + sin(p.z * 11.0 - uTime * 1.7) * 0.008;
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    // 空を映すので UW_SKY も要る(共通のプレリュードには入っていない)
    fragmentShader: UW_FRAG_PRELUDE + UW_SKY + /* glsl */ `
      varying vec3 vW;
      varying vec2 vL;
      void main() {
        vec3 viewDir = normalize(cameraPosition - vW);
        // 上から覗きこむ浅い水。ほとんど透けて、斜めから見ると空を映す。
        //
        // ただし映しすぎないこと。フレネルを素直に1まで持っていくと、
        // 浅い角度で見た溜まりが真っ白に飛んで、水ではなく光源になる
        // (実際そうなって、岩に空いた穴が発光しているように見えた)。
        // 溜まりの見えかたを決めているのは、映りこみよりも
        // 「濡れて黒くなった底」のほう
        float fres = pow(1.0 - clamp(abs(viewDir.y), 0.0, 1.0), 3.0) * 0.55;
        vec3 sky = skyColor(reflect(-viewDir, vec3(0.0, 1.0, 0.0))) * 0.62;
        // 水そのものの色。浅く、底の岩の色をかぶるので暗く緑がかる
        vec3 tint = uFogColor * 0.55;
        vec3 col = mix(tint, sky, clamp(fres, 0.0, 0.75));
        // 縁は薄くなって岩に溶ける。円板の切り口を見せない
        float edge = smoothstep(1.0, 0.86, length(vL));
        float a = mix(0.14, 0.62, fres) * edge;
        gl_FragColor = vec4(col, a);
        ${UW_FRAG_OUTPUT}
      }
    `,
  });

  for (const p of POOLS) {
    const geo = new THREE.CircleGeometry(1, 40);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(p.x, p.rim - 0.06, p.z);
    m.scale.setScalar(p.r * 0.97);
    m.renderOrder = 56;
    group.add(m);
    discs.push({ mesh: m, pool: p });
  }
  parent.add(group);

  return {
    group,
    /** 海面が縁を越えたら隠す(海の水面が覆うので二重になる) */
    update(sea) {
      for (const d of discs) d.mesh.visible = sea < d.pool.rim - 0.05;
    },
  };
}
