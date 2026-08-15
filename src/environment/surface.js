import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { UW_UNIFORMS, UW_NOISE, UW_FOG, UW_SKY } from '../glsl.js';

// ============ 水面(水中からも水上からも見る) ============
// 同じ一枚の面を、視点が水の内か外かで別の物理で描き分ける。
//
//  水中から見上げる: スネルの窓(Snell's window)。臨界角約48.6°の円錐内に
//    だけ空が屈折して見え、その外側は全反射で水中の照り返しを映す鏡になる。
//  水上から見下ろす: フレネル反射。浅い角度ではほぼ全反射して空を映し、
//    真下を覗き込むと水の色越しに中の生き物が透ける。α値で透け具合を作る。
export function createWaterSurface(scene) {
  const geo = new THREE.PlaneGeometry(900, 900, 130, 130);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    side: THREE.DoubleSide,
    transparent: true,   // 水上から中の生き物を透かすため。深度は書く
    depthWrite: true,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uSwell;
      varying vec3 vWorldPos;

      // 大きなうねり(頂点変位で水平線のシルエットが揺れる)。
      // 外洋では山と谷で2mほど動く。uSwell はゾーンごとの倍率で、
      // 流氷の海だけはここを大きく落としてある——海氷は波を吸うので、
      // 固まった氷の中の海面はほとんど平らになる
      float swell(vec2 p, float t){
        return (sin(p.x * 0.11 + t * 0.7) * 0.35
             + sin(dot(p, vec2(0.07, 0.09)) + t * 0.5) * 0.45
             + sin(dot(p, vec2(-0.13, 0.05)) + t * 0.9) * 0.2) * uSwell;
      }

      void main() {
        vec3 p = position;
        p.y += swell(p.xz, uTime);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: UW_UNIFORMS + UW_NOISE + UW_FOG + UW_SKY + /* glsl */ `
      varying vec3 vWorldPos;

      // 細かい波の高さ場(法線を数値微分で求める)
      float waveH(vec2 p, float t){
        float h = 0.0;
        h += sin(p.x * 0.50 + t * 1.3) * 0.30;
        h += sin(dot(p, vec2(0.35, 0.42)) + t * 1.7) * 0.25;
        h += sin(dot(p, vec2(-0.22, 0.31)) - t * 1.1) * 0.22;
        h += fbm(p * 0.35 + vec2(t * 0.15, -t * 0.11)) * 0.55;
        return h;
      }

      void main() {
        float t = uTime;
        vec2 p = vWorldPos.xz;

        // 波の法線(上向き)
        float e = 0.28;
        float h0 = waveH(p, t);
        float hx = waveH(p + vec2(e, 0.0), t);
        float hz = waveH(p + vec2(0.0, e), t);
        vec3 n = normalize(vec3(h0 - hx, e * 1.6, h0 - hz));

        vec3 V = normalize(vWorldPos - cameraPosition);
        float dist = distance(cameraPosition, vWorldPos);

        // ================= 水中から見上げた面 =================
        // 屈折(水 -> 空気, eta = 1.33)。全反射なら零ベクトルが返る
        vec3 rf = refract(V, -n, 1.33);
        float k = 1.0 - 1.33 * 1.33 * (1.0 - pow(dot(V, n), 2.0));
        float window = smoothstep(0.0, 0.18, k); // スネルの窓の縁を柔らかく

        // --- 窓の中: 屈折した空(水上と同じ空の関数を使う) ---
        vec3 sky = vec3(0.0);
        if (window > 0.001) {
          sky = skyColor(normalize(rf + vec3(0.0, 1e-4, 0.0))) * 0.55;
        }

        // --- 窓の外: 全反射(水中の暗い照り返し) ---
        vec3 tir = uFogColor * (0.55 + 0.5 * clamp(-n.x * 0.5 + 0.5, 0.0, 1.0));
        tir += uFogColor * fbm(p * 0.6 + t * 0.1) * 0.45;
        tir += uSunColor * pow(fbm(p * 0.9 + vec2(t * 0.4, -t * 0.3)), 6.0) * 0.5 * uSunI;

        vec3 below = mix(tir, sky, window);

        // 波頭のきらめき
        float sparkle = pow(fbm(p * 1.2 + vec2(t * 0.5, t * 0.35)), 5.0);
        below += uSunColor * sparkle * 1.6 * window * uSunI;
        below = applyUnderwaterFog(below, vWorldPos);

        // ================= 水上から見下ろした面 =================
        // フレネル(Schlick近似, 水のF0 = 0.02)。
        // 真下を覗けば2%しか反射しないが、浅い角度ではほぼ鏡になる。
        float cosI = clamp(dot(-V, n), 0.0, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);

        vec3 refl = skyColor(reflect(V, n));
        // 太陽の海面反射(sun glitter)。細かい波が無数の鏡になって散る
        vec3 hv = normalize(uSunDir - V);
        float glit = pow(clamp(dot(n, hv), 0.0, 1.0), 320.0);
        refl += uSunColor * glit * 46.0 * uSunI;

        // 透過側: 水の色。深いほど濃く、下の生き物を隠していく
        vec3 trans = uFogColor * 1.15 + uSunColor * 0.03 * uSunI;
        // 濁り = この割合だけ水中が見えなくなる。
        // 真下を覗けば水中の光路は水深ぶんで済むが、視線が寝るほど光路は
        // 1/sinθ で伸びるので、水平近くではまったく中が見えなくなる。
        float turb = 1.0 - exp(-0.80 / max(cosI, 0.02));
        // 遠景は大気の靄で空へ溶ける = 水平線
        float haze = 1.0 - exp(-pow(dist * 0.0045, 2.0));
        turb = clamp(max(turb, haze), 0.0, 1.0);

        float aA = clamp(F + (1.0 - F) * turb, 0.0, 1.0);
        vec3 above = (refl * F + trans * (1.0 - F) * turb) / max(aA, 1e-3);
        above = mix(above, skyColor(V), haze);
        aA = mix(aA, 1.0, haze);

        // ================= 合成 =================
        float camAbove = smoothstep(-0.15, 0.45, cameraPosition.y - uSurfaceY);
        vec3 col = mix(below, above, camAbove);
        float alpha = mix(1.0, aA, camAbove);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = WORLD.surfaceY;
  mesh.renderOrder = -5;
  scene.add(mesh);
  return mesh;
}
