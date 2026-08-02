import * as THREE from 'three';
import { baseUniforms, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { fbm3, noise3 } from '../noise.js';

// ============ 砂底 ============
// 起伏はCPUノイズで変位、砂紋(リップル)はシェーダで法線摂動、
// コースティクスが最も映える場所なので強めに乗せる。
export function createSand(scene) {
  const size = 220;
  const seg = 160;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    // 大きな砂丘 + 中スケールの起伏
    let y = fbm3(x * 0.02, 0, z * 0.02, 3) * 3.2 - 1.2;
    y += fbm3(x * 0.08 + 7, 0, z * 0.08, 2) * 0.8;
    pos.setY(i, y);
  }
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: baseUniforms(),
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: UW_FRAG_PRELUDE + /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vNormal;

      void main() {
        vec2 p = vWorldPos.xz;

        // 砂紋: 流れ方向に伸びる細かい畝。ノイズで揺らして自然に
        float rippleFreq = 2.4;
        float warp = fbm(p * 0.25) * 3.0;
        float ripple = sin(p.x * rippleFreq + p.y * 0.0 + warp + vWorldPos.z * 0.7);
        vec3 n = normalize(vNormal + vec3(ripple * 0.18, 0.0, cos(p.y * rippleFreq * 0.6 + warp) * 0.08));

        // 砂の色ムラ(暗い有機物の斑・明るい貝殻片)
        float mottle = fbm(p * 0.13);
        vec3 albedo = mix(vec3(0.62, 0.55, 0.42), vec3(0.42, 0.38, 0.30), mottle);
        // 貝殻片: セル内の小さな丸い点として散らす(四角く見えないように)
        vec2 fg = p * 9.0;
        vec2 fCell = floor(fg);
        vec2 fOff = vec2(hash12(fCell + 2.7), hash12(fCell + 5.3)) - 0.5;
        float fleck = step(0.975, hash12(fCell))
                    * smoothstep(0.16, 0.06, length(fract(fg) - 0.5 - fOff * 0.5));
        albedo += fleck * 0.28;

        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 col = underwaterLight(albedo, n, vWorldPos, V, 30.0, 0.05);
        col += causticsLight(vWorldPos, n, 1.5) * albedo * 2.2;
        col = applyUnderwaterFog(col, vWorldPos);
        gl_FragColor = vec4(col, 1.0);
        ${UW_FRAG_OUTPUT}
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0;
  scene.add(mesh);
  return mesh;
}

// 砂の高さを取得(生物の配置用に近似計算)
export function sandHeight(x, z) {
  let y = fbm3(x * 0.02, 0, z * 0.02, 3) * 3.2 - 1.2;
  y += fbm3(x * 0.08 + 7, 0, z * 0.08, 2) * 0.8;
  return y;
}

// ============ 岩 ============
// イコサ球をノイズ変位。標準マテリアルに onBeforeCompile で
// コースティクスを注入し、他の物体と光の表現を揃える。
export function addCausticsToStandard(mat, strength = 0.9) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = U.uTime;
    shader.uniforms.uSunDirC = { value: U.uSunDir.value };
    shader.uniforms.uSunColorC = { value: U.uSunColor.value };
    shader.uniforms.uSunIC = U.uSunI;
    shader.uniforms.uSurfaceYC = U.uSurfaceY;
    shader.uniforms.uCauStrength = { value: strength };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCauWorldPos;')
      .replace(
        '#include <worldpos_vertex>',
        '#include <worldpos_vertex>\nvCauWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `#include <common>
        varying vec3 vCauWorldPos;
        uniform float uTime;
        uniform vec3 uSunDirC;
        uniform vec3 uSunColorC;
        uniform float uSunIC;
        uniform float uSurfaceYC;
        uniform float uCauStrength;
        float causticIterStd(vec2 uv, float t){
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
        }`
      )
      .replace(
        '#include <lights_fragment_end>',
        /* glsl */ `#include <lights_fragment_end>
        {
          vec2 proj = vCauWorldPos.xz - uSunDirC.xz / max(uSunDirC.y, 0.2) * (uSurfaceYC - vCauWorldPos.y);
          float cau = causticIterStd(proj * 0.06, uTime * 0.55);
          float up = clamp(normal.y * 0.75 + 0.45, 0.0, 1.0);
          float depth = clamp((uSurfaceYC - vCauWorldPos.y) / uSurfaceYC, 0.0, 1.0);
          float reach = mix(1.0, 0.35, depth);
          reflectedLight.directDiffuse += uSunColorC * cau * uCauStrength * up * uSunIC * reach;
        }`
      );
  };
  return mat;
}

export function createRocks(scene) {
  const group = new THREE.Group();
  const rockMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#59626a'),
    roughness: 0.95,
    metalness: 0.0,
    flatShading: false,
  });
  addCausticsToStandard(rockMat, 0.8);

  // 岩礁の配置(中央左寄りにメイン、右に小さめの根)
  const colliders = [];
  const spots = [
    { x: -13, z: -8, s: 4.2, seed: 1 },
    { x: -16, z: -4, s: 2.8, seed: 2 },
    { x: -10, z: -12, s: 2.4, seed: 3 },
    { x: 12, z: -14, s: 3.2, seed: 4 },
    { x: 15, z: -10, s: 1.9, seed: 5 },
    { x: 4, z: -18, s: 2.2, seed: 6 },
    { x: -4, z: 14, s: 1.6, seed: 7 },
    { x: 18, z: 6, s: 2.0, seed: 8 },
  ];

  for (const s of spots) {
    const geo = new THREE.IcosahedronGeometry(s.s, 4);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      const n = v.clone().normalize();
      const d = fbm3(n.x * 1.8 + s.seed * 11, n.y * 1.8, n.z * 1.8, 4);
      v.addScaledVector(n, (d - 0.45) * s.s * 0.55);
      v.y *= 0.72; // 岩は上下に潰れ気味
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, rockMat);
    mesh.position.set(s.x, sandHeight(s.x, s.z) + s.s * 0.18, s.z);
    mesh.rotation.y = s.seed * 2.4;
    group.add(mesh);

    // 当たり判定: ノイズ変位ぶんを見込み、y方向は潰れた比率に合わせる
    colliders.push({
      center: mesh.position.clone(),
      rx: s.s * 1.15,
      ry: s.s * 0.85,
      rz: s.s * 1.15,
    });
  }

  scene.add(group);
  return { group, colliders };
}
