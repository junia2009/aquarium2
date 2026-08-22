// ============ GLSL 共通チャンク ============
// 各カスタムシェーダの fragment / vertex に文字列連結して使う。
// 依存ユニフォームは baseUniforms() で供給される。

// --- 共通ユニフォーム宣言(fragment用) ---
export const UW_UNIFORMS = /* glsl */ `
uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform float uSunI;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uSurfaceY;
uniform vec3  uAmbTop;
uniform vec3  uAmbBottom;
uniform vec3  uLampPos;
uniform vec3  uLampDir;
uniform vec3  uLampColor;
uniform float uLampI;
uniform float uLampCos;
uniform float uLampReach;
uniform sampler2D uIceTex;
uniform float uIceOn;
uniform float uIceExtent;
// 施設の照明の強さ。プロテウス以外では誰も読まないが、宣言は共通に
// 置く——読む材質(殻・海底・観測所・潜水艦・魚)が多すぎて、
// そこだけ別の前置きにすると必ずどれか1つ書き忘れる
uniform float uStationI;
uniform vec4  uPing;    // xyz=発信点 w=いまの半径
uniform float uPingI;   // 0 なら消えている

// 流氷の覆いを抜けて届く光の割合。
// 海面が氷で蓋をされていると、太陽光は割れ目(リード)からしか入らない。
// 厚さ2mの氷を抜けてくる光は数%しかないので、リードの真下との差は
// ゆうに10倍になる。氷の海の明暗はほぼこれだけで決まるので、
// 光を使うところ全部(直射・環境光・水の色)から参照できるよう、
// いちばん手前の共通チャンクに置いてある。
float iceOpen(vec3 wp){
  if (uIceOn < 0.5) return 1.0;
  float depth = max(uSurfaceY - wp.y, 0.0);
  // 太陽が傾いているぶん、影は水平にずれる。浅いところで氷の真下にいても、
  // 斜めに差す光が届くことがある——これが無いと影が「氷の型抜き」になる
  vec2 uv = (wp.xz + uSunDir.xz / max(uSunDir.y, 0.25) * depth) / uIceExtent + 0.5;
  float cover = texture2D(uIceTex, clamp(uv, 0.001, 0.999)).r;
  // 深いほど影の縁は甘くなる。横から回り込んだ散乱光で埋まるため
  float soft = clamp(depth / 13.0, 0.0, 1.0);
  return 1.0 - cover * mix(0.95, 0.78, soft);
}
`;

// --- ハッシュ / ノイズ ---
export const UW_NOISE = /* glsl */ `
float hash12(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash13(vec3 p){
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i = 0; i < 4; i++){
    v += a * vnoise(p);
    p = p * 2.03 + vec2(17.3, 9.1);
    a *= 0.5;
  }
  return v;
}
`;

// --- 空(大気散乱の近似) ---
// 水上へ出たときの背景であり、水中から見上げたスネルの窓に映る空でもある。
// 同じ関数を両方で使うことで、水面の内と外で空の色が食い違わない。
//   ・レイリー散乱: 短波長(青)ほど強く散る → 天頂が青く、地平が白む
//   ・ミー散乱    : 波長にほぼ依らない前方散乱 → 太陽まわりの白いハロ
//   ・太陽高度が下がるほど光の経路が伸び、青が抜けて赤みが残る
export const UW_SKY = /* glsl */ `
vec3 skyColor(vec3 dir){
  vec3 d = normalize(dir);
  float mu = clamp(dot(d, uSunDir), -1.0, 1.0);

  // 大気中の経路長。天頂で最短、地平線方向ほど長い
  float viewOD = 1.0 / (max(d.y, 0.0) + 0.12);

  // レイリー散乱係数(海面での実測値の比。青が赤の約5.7倍散る)
  const vec3 betaR = vec3(0.0058, 0.0135, 0.0331);

  // 経路上で散乱した割合。天頂では青だけが散って深い青に、
  // 地平線では経路が長く全波長が飽和するので白く霞む
  vec3 inscat = 1.0 - exp(-betaR * viewOD * 8.0);

  // レイリー位相 (3/16π)(1+μ²) を 1 前後に正規化したもの
  float phaseR = 0.5 + 0.5 * mu * mu;
  vec3 col = uSunColor * inscat * (0.62 + 0.38 * phaseR) * 2.90;

  // 太陽高度が低いほど光の経路が伸び、青が抜けて赤みが残る
  float sunOD = 1.0 / (max(uSunDir.y, 0.0) + 0.12);
  vec3 sunAtt = exp(-betaR * sunOD * 9.0);

  // ミー散乱: 大気中の微粒子による前方散乱。太陽まわりの白いハロ
  col += uSunColor * sunAtt * pow(max(mu, 0.0), 8.0) * 0.12;
  // 太陽本体(視半径0.27°。滲みを含めて少し広げてある)
  col += uSunColor * sunAtt * smoothstep(0.9990, 0.99975, mu) * 9.0;

  // 地平線ぎわのもや。水平線を柔らかくして水面との継ぎ目を消す
  float haze = pow(1.0 - clamp(abs(d.y), 0.0, 1.0), 5.0);
  col = mix(col, col * 0.80 + vec3(0.30, 0.34, 0.39) * 0.30, haze * 0.65);

  return max(col, vec3(0.0)) * uSunI;
}
`;

// --- コースティクス(水面の集光模様) ---
// 反復歪みによる古典的手法。太陽方向へ投影した座標で評価するため
// 光芒・水面のきらめきと空間的に整合する。
export const UW_CAUSTICS = /* glsl */ `
float causticIter(vec2 uv, float t){
  vec2 p = mod(uv * 6.28318530718, 6.28318530718) - 250.0;
  vec2 i = vec2(p);
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float tt = t * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + tt) / inten), p.y / (cos(i.y + tt) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}

// 深度による減光(深いほど太陽光が届かない)
float sunReach(vec3 wp){
  float depth = clamp((uSurfaceY - wp.y) / uSurfaceY, 0.0, 1.0);
  return mix(1.0, 0.35, depth) * iceOpen(wp);
}

// wp: ワールド座標, n: 法線, strength: 素材ごとの強さ
vec3 causticsLight(vec3 wp, vec3 n, float strength){
  // 太陽の傾きに沿って投影(深いほど模様が横にずれる)
  vec2 proj = wp.xz - uSunDir.xz / max(uSunDir.y, 0.2) * (uSurfaceY - wp.y);
  float c = causticIter(proj * 0.06, uTime * 0.55);
  float up = clamp(n.y * 0.75 + 0.45, 0.0, 1.0);
  // 水上には集光模様はできない。跳んだイルカの背から縞が抜けていく
  float sub = smoothstep(0.0, 0.7, uSurfaceY - wp.y);
  return uSunColor * (c * strength * up * uSunI * sunReach(wp) * sub);
}
`;

// --- 水中フォグ(距離による散乱) ---
export const UW_FOG = /* glsl */ `
// 視線のうち「水中を通った長さ」だけを返す。
// 空気中には水の散乱がないので、水上視点でも正しく効く。
float underwaterPath(vec3 a, vec3 b){
  float ya = a.y - uSurfaceY;
  float yb = b.y - uSurfaceY;
  float total = distance(a, b);
  if (ya <= 0.0 && yb <= 0.0) return total;      // 全区間が水中
  if (ya >= 0.0 && yb >= 0.0) return 0.0;        // 全区間が空気中
  // 片方だけ水中: 水面との交点までの比を求める
  float f = (ya <= 0.0) ? ya / (ya - yb) : yb / (yb - ya);
  return total * clamp(f, 0.0, 1.0);
}

vec3 applyUnderwaterFog(vec3 col, vec3 wp){
  float d = underwaterPath(cameraPosition, wp);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  // 視線が上向きなら明るい水色、下向きなら暗い深青に寄せる
  vec3 dir = normalize(wp - cameraPosition);
  vec3 fogC = mix(uFogColor * 0.55, uFogColor * 1.35, clamp(dir.y * 0.5 + 0.55, 0.0, 1.0));
  // 水の色は「水中で散乱した日射」そのもの。氷に蓋をされていれば
  // 散らす光が届いていないので、水自体が暗く沈む。
  // ここを一定にすると、影の中の遠景だけが明るく浮いて嘘になる
  fogC *= mix(0.40, 1.0, iceOpen(wp));
  // 水上から覗き込むときは、浅いほど明るいターコイズ、深いほど暗く
  float camAbove = smoothstep(-0.2, 0.6, cameraPosition.y - uSurfaceY);
  vec3 downC = mix(uFogColor * 1.30, uFogColor * 0.50, clamp((uSurfaceY - wp.y) / 15.0, 0.0, 1.0));
  fogC = mix(fogC, downC, camAbove);
  return mix(col, fogC, clamp(f, 0.0, 1.0));
}
`;

// --- 半球環境光 + 太陽光の基本ライティング ---
export const UW_LIGHTING = /* glsl */ `
// ダイバーライト。太陽の届かない深さでは唯一の外部光になる。
// その点に「届いているライトの色」を返す(法線は掛けない)。
//
// 頭に付いた光源なので、光はライト→対象→目と水の中を往復する。
// 水は赤から先に吸うので、遠いものほど青緑に沈み、近いものだけが
// 本来の色を見せる。深海の赤い生物が周囲光では黒く沈み、
// ライトを当てた瞬間だけ赤く浮かび上がるのはこのため。
vec3 lampArrive(vec3 wp){
  if (uLampI <= 0.001) return vec3(0.0);
  vec3 d = wp - uLampPos;
  float dist = length(d);
  vec3 L = d / max(dist, 1e-4);
  float ca = dot(L, uLampDir);
  if (ca < uLampCos || dist > uLampReach) return vec3(0.0);
  float cone = smoothstep(uLampCos, mix(uLampCos, 1.0, 0.62), ca);
  float fall = 1.0 / (1.0 + dist / 10.0);
  fall *= 1.0 - smoothstep(uLampReach * 0.60, uLampReach, dist);
  vec3 ext = exp(-vec3(0.042, 0.012, 0.006) * dist * 2.0);   // 往復ぶんの吸収
  return uLampColor * ext * (cone * fall * uLampI);
}

vec3 underwaterLight(vec3 albedo, vec3 n, vec3 wp, vec3 viewDir, float specPow, float specI){
  float ndl = clamp(dot(n, uSunDir), 0.0, 1.0);
  // 半波長ラップ(水中の柔らかい拡散)
  float wrap = clamp((dot(n, uSunDir) + 0.5) / 1.5, 0.0, 1.0);
  // 流氷は直射日光だけでなく、空からの散乱光もまとめて遮る。
  // 太陽の項にだけ影を掛けても、環境光が明るいままなので影が出てこない
  // ——実際そうなって、氷の下と割れ目の下がまったく同じ明るさになった。
  // 上向きの環境光は「上から降ってくる光」なので、これも氷で落とす
  float open = iceOpen(wp);
  vec3 hemi = mix(uAmbBottom, uAmbTop * mix(0.14, 1.0, open), clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  // 水面から出た体は、青い水中の環境光ではなく空と直射日光で照らされる
  float air = smoothstep(0.0, 1.4, wp.y - uSurfaceY);
  vec3 skyHemi = mix(vec3(0.20, 0.23, 0.26), vec3(0.42, 0.55, 0.76), clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  hemi = mix(hemi, skyHemi, air);
  vec3 light = hemi * 1.15 + uSunColor * (0.35 * ndl + 0.45 * wrap) * uSunI * sunReach(wp);
  light += uSunColor * ndl * 0.75 * uSunI * air;   // 直射日光
  // ダイバーライト(消灯ゾーンでは lampArrive が 0 を返すので何も起きない)
  vec3 lamp = lampArrive(wp);
  vec3 lampL = normalize(uLampPos - wp);
  light += lamp * (0.22 + 0.78 * clamp(dot(n, lampL), 0.0, 1.0));
  vec3 col = albedo * light;
  // スペキュラ
  vec3 h = normalize(uSunDir + viewDir);
  col += uSunColor * pow(clamp(dot(n, h), 0.0, 1.0), specPow) * specI * uSunI * sunReach(wp);
  vec3 hl = normalize(lampL + viewDir);
  col += lamp * pow(clamp(dot(n, hl), 0.0, 1.0), specPow) * specI;
  return col;
}
`;

// fragment 冒頭にまとめて入れる用
export const UW_FRAG_PRELUDE = UW_UNIFORMS + UW_NOISE + UW_CAUSTICS + UW_FOG + UW_LIGHTING;

// トーンマッピング/色空間(three内蔵チャンクを利用)
export const UW_FRAG_OUTPUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
`;
