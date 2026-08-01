import * as THREE from 'three';
import { baseUniforms, WORLD } from '../env.js';
import { UW_UNIFORMS, UW_NOISE, UW_FOG } from '../glsl.js';

// ============ 水面(下から見上げる) ============
// こだわり: スネルの窓(Snell's window)を物理的に再現。
// 水中から見上げると臨界角約48.6°の円錐内にだけ空が見え、
// その外側は全反射で暗い鏡面になる。屈折ベクトルを実際に計算して描く。
export function createWaterSurface(scene) {
  const geo = new THREE.PlaneGeometry(700, 700, 110, 110);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform float uTime;
      varying vec3 vWorldPos;

      // 大きなうねり(頂点変位で水平線のシルエットが揺れる)
      float swell(vec2 p, float t){
        return sin(p.x * 0.11 + t * 0.7) * 0.35
             + sin(dot(p, vec2(0.07, 0.09)) + t * 0.5) * 0.45
             + sin(dot(p, vec2(-0.13, 0.05)) + t * 0.9) * 0.2;
      }

      void main() {
        vec3 p = position;
        p.y += swell(p.xz, uTime);
        vec4 wp = modelMatrix * vec4(p, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: UW_UNIFORMS + UW_NOISE + UW_FOG + /* glsl */ `
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

        // 水中からの視線(上向き)
        vec3 V = normalize(vWorldPos - cameraPosition);

        // 屈折(水 -> 空気, eta = 1.33)。全反射なら零ベクトルが返る
        vec3 rf = refract(V, -n, 1.33);
        float k = 1.0 - 1.33 * 1.33 * (1.0 - pow(dot(V, n), 2.0));
        float window = smoothstep(0.0, 0.18, k); // スネルの窓の縁を柔らかく

        // --- 窓の中: 屈折した空 ---
        vec3 sky = vec3(0.0);
        if (window > 0.001) {
          vec3 r = normalize(rf + vec3(0.0, 1e-4, 0.0));
          float su = clamp(r.y, 0.0, 1.0);
          sky = mix(vec3(0.55, 0.75, 0.85), vec3(0.35, 0.62, 0.85), su); // 空のグラデーション
          float sunDot = clamp(dot(r, uSunDir), 0.0, 1.0);
          sky += uSunColor * pow(sunDot, 400.0) * 22.0 * uSunI;  // 太陽ディスク
          sky += uSunColor * pow(sunDot, 12.0) * 0.8 * uSunI;    // ハロ
          sky *= 1.4;
        }

        // --- 窓の外: 全反射(水中の暗い照り返し) ---
        vec3 tir = uFogColor * (0.55 + 0.5 * clamp(-n.x * 0.5 + 0.5, 0.0, 1.0));
        tir += uFogColor * fbm(p * 0.6 + t * 0.1) * 0.45;
        tir += uSunColor * pow(fbm(p * 0.9 + vec2(t * 0.4, -t * 0.3)), 6.0) * 0.5 * uSunI;

        vec3 col = mix(tir, sky, window);

        // 波頭のきらめき
        float sparkle = pow(fbm(p * 1.2 + vec2(t * 0.5, t * 0.35)), 5.0);
        col += uSunColor * sparkle * 1.6 * window * uSunI;

        col = applyUnderwaterFog(col, vWorldPos);
        gl_FragColor = vec4(col, 1.0);
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
