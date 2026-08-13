import * as THREE from 'three';
import { baseUniforms, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { fbm3, noise3 } from '../noise.js';

// ============ 砂底 ============
// 起伏はCPUノイズで変位、砂紋(リップル)はシェーダで法線摂動、
// コースティクスが最も映える場所なので強めに乗せる。
export function createSand(scene, { height = null, tint = null } = {}) {
  const size = 220;
  const seg = 160;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);

  const hf = height || reefTerrain;
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, hf(pos.getX(i), pos.getZ(i)));
  }
  geo.computeVertexNormals();

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...baseUniforms(),
      uSandLight: { value: tint ? tint.light.clone() : new THREE.Color(0.62, 0.55, 0.42) },
      uSandDark: { value: tint ? tint.dark.clone() : new THREE.Color(0.42, 0.38, 0.30) },
    },
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
      uniform vec3 uSandLight;
      uniform vec3 uSandDark;

      void main() {
        vec2 p = vWorldPos.xz;

        // 砂紋: 流れ方向に伸びる細かい畝。ノイズで揺らして自然に
        float rippleFreq = 2.4;
        float warp = fbm(p * 0.25) * 3.0;
        float ripple = sin(p.x * rippleFreq + p.y * 0.0 + warp + vWorldPos.z * 0.7);
        vec3 n = normalize(vNormal + vec3(ripple * 0.18, 0.0, cos(p.y * rippleFreq * 0.6 + warp) * 0.08));

        // 砂の色ムラ(暗い有機物の斑・明るい貝殻片)
        float mottle = fbm(p * 0.13);
        vec3 albedo = mix(uSandLight, uSandDark, mottle);
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

// ============ 地形の高さ場 ============
// ゾーンごとに底の形が違うので、実装を差し替えられるようにしておく。
// 生物・当たり判定・カメラはすべて sandHeight() を参照する。
export function reefTerrain(x, z) {
  let y = fbm3(x * 0.02, 0, z * 0.02, 3) * 3.2 - 1.2;
  y += fbm3(x * 0.08 + 7, 0, z * 0.08, 2) * 0.8;
  return y;
}

let terrainFn = reefTerrain;

/** ゾーンの地形を差し替える */
export function setTerrain(fn) {
  terrainFn = fn || reefTerrain;
}

/** 砂の高さ(生物の配置・当たり判定に使う) */
export function sandHeight(x, z) {
  return terrainFn(x, z);
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
    // ダイバーライト。深海ゾーンでは岩や煙突を照らす唯一の光になる
    shader.uniforms.uLampPos = U.uLampPos;
    shader.uniforms.uLampDir = U.uLampDir;
    shader.uniforms.uLampColor = U.uLampColor;
    shader.uniforms.uLampI = U.uLampI;
    shader.uniforms.uLampCos = U.uLampCos;
    shader.uniforms.uLampReach = U.uLampReach;
    // 流氷の覆い。岩だけ氷の影に入らないと、そこだけ浮いて見える
    shader.uniforms.uIceTex = U.uIceTex;
    shader.uniforms.uIceOn = U.uIceOn;
    shader.uniforms.uIceExtent = U.uIceExtent;
    shader.uniforms.uSunDirI = { value: U.uSunDir.value };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCauWorldPos;')
      .replace(
        '#include <worldpos_vertex>',
        /* glsl */ `#include <worldpos_vertex>
        // インスタンス描画では transformed にインスタンス行列が入らない。
        // ここで掛けないと、全個体が原点にいることになってライトが当たらない
        #ifdef USE_INSTANCING
          vCauWorldPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vCauWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif`
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
        uniform vec3 uLampPos;
        uniform vec3 uLampDir;
        uniform vec3 uLampColor;
        uniform float uLampI;
        uniform float uLampCos;
        uniform float uLampReach;
        uniform sampler2D uIceTex;
        uniform float uIceOn;
        uniform float uIceExtent;
        uniform vec3 uSunDirI;
        // glsl.js の iceOpen と同じ式
        float iceOpenStd(vec3 wp){
          if (uIceOn < 0.5) return 1.0;
          float depth = max(uSurfaceYC - wp.y, 0.0);
          vec2 uv = (wp.xz + uSunDirI.xz / max(uSunDirI.y, 0.25) * depth) / uIceExtent + 0.5;
          float cover = texture2D(uIceTex, clamp(uv, 0.001, 0.999)).r;
          return 1.0 - cover * mix(0.95, 0.78, clamp(depth / 13.0, 0.0, 1.0));
        }
        // glsl.js の lampArrive と同じ式。標準マテリアル側にも同じ光を届ける
        vec3 lampArriveStd(vec3 wp){
          if (uLampI <= 0.001) return vec3(0.0);
          vec3 d = wp - uLampPos;
          float dist = length(d);
          vec3 L = d / max(dist, 1e-4);
          float ca = dot(L, uLampDir);
          if (ca < uLampCos || dist > uLampReach) return vec3(0.0);
          float cone = smoothstep(uLampCos, mix(uLampCos, 1.0, 0.62), ca);
          float fall = 1.0 / (1.0 + dist / 10.0);
          fall *= 1.0 - smoothstep(uLampReach * 0.60, uLampReach, dist);
          vec3 ext = exp(-vec3(0.042, 0.012, 0.006) * dist * 2.0);
          return uLampColor * ext * (cone * fall * uLampI);
        }
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
          float reach = mix(1.0, 0.35, depth) * iceOpenStd(vCauWorldPos);
          reflectedLight.directDiffuse += uSunColorC * cau * uCauStrength * up * uSunIC * reach;
          // 氷の影では拡散光そのものも落ちる。集光模様だけ消えて
          // 岩が明るいままだと、影が「模様の抜け」にしか見えない
          float open = iceOpenStd(vCauWorldPos);
          reflectedLight.directDiffuse *= mix(0.20, 1.0, open);
          // 空からの散乱光も氷が遮る。ここを落とさないと、
          // 岩だけが氷の下で明るいまま浮いてしまう
          reflectedLight.indirectDiffuse *= mix(0.16, 1.0, open);
          vec3 lamp = lampArriveStd(vCauWorldPos);
          vec3 lampL = normalize(uLampPos - vCauWorldPos);
          reflectedLight.directDiffuse += diffuseColor.rgb * lamp
            * (0.22 + 0.78 * clamp(dot(normal, lampL), 0.0, 1.0));
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
