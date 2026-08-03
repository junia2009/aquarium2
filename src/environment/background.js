import * as THREE from 'three';
import { baseUniforms, U } from '../env.js';
import { UW_UNIFORMS, UW_SKY, UW_FRAG_OUTPUT } from '../glsl.js';

// ============ 遠景ドーム(水中の青のグラデーション) ============
// フォグの到達しない遠景。上方は水面越しの明るさ、下方は深淵の闇。
export function createBackground(scene) {
  // 空のグラデーションを乗せるので、水中だけの頃より細かく分割する
  const geo = new THREE.SphereGeometry(220, 64, 40);
  const mat = new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: UW_UNIFORMS + UW_SKY + /* glsl */ `
      varying vec3 vDir;
      void main() {
        float up = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        // 深淵 → 水平線 → 上方の明るさ
        vec3 deep    = vec3(0.008, 0.045, 0.085);
        vec3 horizon = uFogColor * 0.95;
        vec3 upper   = uFogColor * 1.9 + vec3(0.05, 0.14, 0.16);
        vec3 col = mix(deep, horizon, smoothstep(0.0, 0.5, up));
        col = mix(col, upper, smoothstep(0.5, 1.0, up));
        // 太陽方向のぼんやりした明るみ(水中の前方散乱)
        float sunGlow = pow(clamp(dot(normalize(vDir), uSunDir), 0.0, 1.0), 6.0);
        col += uSunColor * sunGlow * 0.35 * uSunI;

        // 水上へ出たら遠景は空になる。
        // (水中にいる間、ドームの上半分は水面に隠れて見えない)
        float camAbove = smoothstep(-0.3, 0.9, cameraPosition.y - uSurfaceY);
        col = mix(col, skyColor(vDir), camAbove);

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.renderOrder = -10;
  scene.add(dome);
  return dome;
}

// ============ ライト(標準マテリアル用: 岩・カメなど) ============
export function createLights(scene) {
  const hemi = new THREE.HemisphereLight(
    new THREE.Color('#4d9cbf'),
    new THREE.Color('#0a2431'),
    0.9
  );
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(new THREE.Color('#ffefcf'), 1.6);
  sun.position.copy(U.uSunDir.value).multiplyScalar(60);
  scene.add(sun);
  scene.add(sun.target);

  return { hemi, sun };
}

export function setupFog(scene) {
  scene.fog = new THREE.FogExp2(U.uFogColor.value.clone(), U.uFogDensity.value);
  return scene.fog;
}
