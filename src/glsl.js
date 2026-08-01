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
`;

// --- ハッシュ / ノイズ ---
export const UW_NOISE = /* glsl */ `
float hash12(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
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
  return mix(1.0, 0.35, depth);
}

// wp: ワールド座標, n: 法線, strength: 素材ごとの強さ
vec3 causticsLight(vec3 wp, vec3 n, float strength){
  // 太陽の傾きに沿って投影(深いほど模様が横にずれる)
  vec2 proj = wp.xz - uSunDir.xz / max(uSunDir.y, 0.2) * (uSurfaceY - wp.y);
  float c = causticIter(proj * 0.06, uTime * 0.55);
  float up = clamp(n.y * 0.75 + 0.45, 0.0, 1.0);
  return uSunColor * (c * strength * up * uSunI * sunReach(wp));
}
`;

// --- 水中フォグ(距離による散乱) ---
export const UW_FOG = /* glsl */ `
vec3 applyUnderwaterFog(vec3 col, vec3 wp){
  float d = distance(cameraPosition, wp);
  float f = 1.0 - exp(-uFogDensity * uFogDensity * d * d);
  // 視線が上向きなら明るい水色、下向きなら暗い深青に寄せる
  vec3 dir = normalize(wp - cameraPosition);
  vec3 fogC = mix(uFogColor * 0.55, uFogColor * 1.35, clamp(dir.y * 0.5 + 0.55, 0.0, 1.0));
  return mix(col, fogC, clamp(f, 0.0, 1.0));
}
`;

// --- 半球環境光 + 太陽光の基本ライティング ---
export const UW_LIGHTING = /* glsl */ `
vec3 underwaterLight(vec3 albedo, vec3 n, vec3 wp, vec3 viewDir, float specPow, float specI){
  float ndl = clamp(dot(n, uSunDir), 0.0, 1.0);
  // 半波長ラップ(水中の柔らかい拡散)
  float wrap = clamp((dot(n, uSunDir) + 0.5) / 1.5, 0.0, 1.0);
  vec3 hemi = mix(uAmbBottom, uAmbTop, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
  vec3 light = hemi * 1.15 + uSunColor * (0.35 * ndl + 0.45 * wrap) * uSunI * sunReach(wp);
  vec3 col = albedo * light;
  // スペキュラ
  vec3 h = normalize(uSunDir + viewDir);
  col += uSunColor * pow(clamp(dot(n, h), 0.0, 1.0), specPow) * specI * uSunI * sunReach(wp);
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
