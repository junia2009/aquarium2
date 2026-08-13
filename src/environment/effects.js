import * as THREE from 'three';
import { baseUniforms, WORLD, U } from '../env.js';
import { UW_UNIFORMS, UW_NOISE, UW_FOG } from '../glsl.js';

// ============ 光芒(ゴッドレイ) ============
// 加算合成のビルボード板に、動くノイズの光条を描く。
// 毎フレーム、カメラの方角へY軸回転させて奥行感を出す。
export function createGodRays(scene, { spots = null, width = 30 } = {}) {
  const group = new THREE.Group();
  const H = WORLD.surfaceY + 3;
  const geo = new THREE.PlaneGeometry(width, H, 1, 1);
  geo.translate(0, -H / 2, 0); // 上端を原点に(水面から吊り下げる)

  const makeMat = (seed) =>
    new THREE.ShaderMaterial({
      uniforms: { ...baseUniforms(), uSeed: { value: seed } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: UW_UNIFORMS + UW_NOISE + /* glsl */ `
        uniform float uSeed;
        varying vec2 vUv;
        varying vec3 vWorldPos;
        void main() {
          // 縦の光条: 横方向のノイズを引き伸ばす
          float x = vUv.x * 7.0 + uSeed * 13.0;
          float shafts = fbm(vec2(x + uTime * 0.10, vUv.y * 0.35 - uTime * 0.03));
          shafts = pow(smoothstep(0.28, 0.9, shafts), 1.7);
          // 板の端・下端をフェード
          float edge = smoothstep(0.0, 0.2, vUv.x) * smoothstep(1.0, 0.8, vUv.x);
          float vert = pow(vUv.y, 2.1);
          // ちらつき(表層の波で光が揺れる)
          float flicker = 0.75 + 0.25 * sin(uTime * 1.7 + uSeed * 20.0 + vUv.x * 9.0);
          float a = shafts * edge * vert * flicker * 0.75 * uSunI;
          // 光芒は水中で散乱光が見える現象。板は水面より上へ少しはみ出して
          // いるので、その部分を消し、水上視点でも出さない
          a *= smoothstep(0.0, 0.9, uSurfaceY - vWorldPos.y);
          a *= 1.0 - smoothstep(-0.2, 1.2, cameraPosition.y - uSurfaceY);
          vec3 col = mix(uSunColor, vec3(0.55, 0.85, 0.95), 0.45);
          gl_FragColor = vec4(col * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

  const rays = [];
  // 既定は水槽じゅうに散らす。流氷ゾーンのように「ここからしか光が
  // 入らない」場所が決まっているゾーンは、その位置を渡す
  const places = spots || [
    { x: 2, z: -4 }, { x: -9, z: 3 }, { x: 10, z: 6 },
    { x: -4, z: -12 }, { x: 14, z: -8 }, { x: -14, z: -10 },
  ];
  places.forEach((s, i) => {
    const m = new THREE.Mesh(geo, makeMat(i * 0.73 + 1));
    m.position.set(s.x, WORLD.surfaceY + 1, s.z);
    m.renderOrder = 50;
    m.frustumCulled = false;
    group.add(m);
    rays.push(m);
  });
  scene.add(group);

  return {
    group,
    update(camera) {
      // 各板をカメラの方へ向ける(Y軸ビルボード)
      for (const r of rays) {
        r.rotation.y = Math.atan2(camera.position.x - r.position.x, camera.position.z - r.position.z);
      }
    },
  };
}

// ============ 泡(エアレーション) ============
// 位置は全てGPUで計算(CPU負荷ゼロ)。上昇するほど膨張し、
// 揺らぎながら昇って水面で消える。
export function createBubbles(scene, emitters) {
  const group = new THREE.Group();
  const H = WORLD.surfaceY;

  for (const em of emitters) {
    const count = em.count ?? 160;
    const seeds = new Float32Array(count * 4);
    const positions = new Float32Array(count * 3); // ダミー(gl_PointSizeのため必要)
    for (let i = 0; i < count; i++) {
      seeds[i * 4 + 0] = (Math.random() - 0.5) * (em.radius ?? 0.8); // x散らばり
      seeds[i * 4 + 1] = (Math.random() - 0.5) * (em.radius ?? 0.8); // z散らばり
      seeds[i * 4 + 2] = 1.4 + Math.random() * 1.8;                  // 上昇速度
      seeds[i * 4 + 3] = Math.random();                              // 位相
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...baseUniforms(),
        uEmitter: { value: new THREE.Vector3(em.x, em.y, em.z) },
        uHeight: { value: H - em.y },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uEmitter;
        uniform float uHeight;
        uniform float uPixelRatio;
        attribute vec4 aSeed;
        varying float vLife;
        void main() {
          float life = fract(aSeed.w + uTime * aSeed.z / uHeight);
          vLife = life;
          float y = life * uHeight;
          // 揺らぎ: 上昇するほど振れ幅が大きくなる
          float wob = 0.08 + y * 0.035;
          vec3 p = uEmitter + vec3(
            aSeed.x + sin(uTime * 2.2 + aSeed.w * 40.0 + y * 0.7) * wob,
            y,
            aSeed.y + cos(uTime * 1.9 + aSeed.w * 31.0 + y * 0.6) * wob
          );
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // 浮上に伴う膨張(水圧の減少)
          float size = (0.5 + life * 1.3) * (0.7 + fract(aSeed.w * 7.3) * 0.6);
          gl_PointSize = size * 46.0 * uPixelRatio / max(-mv.z, 0.1);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vLife;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          // リムが明るい球殻 + ハイライト
          float rim = smoothstep(0.28, 0.48, d);
          float body = smoothstep(0.5, 0.44, d);
          float hl = exp(-dot(c - vec2(-0.14, -0.14), c - vec2(-0.14, -0.14)) * 60.0);
          float fadeIn = smoothstep(0.0, 0.06, vLife);
          float fadeOut = 1.0 - smoothstep(0.94, 1.0, vLife);
          float a = (rim * 0.5 + hl * 0.9 + 0.06) * body * fadeIn * fadeOut;
          vec3 col = vec3(0.75, 0.9, 1.0);
          gl_FragColor = vec4(col * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 60;
    group.add(pts);
  }

  scene.add(group);
  return group;
}

// ============ マリンスノー(浮遊懸濁物) ============
// 水の「質量感」を出す立役者。ゆっくり沈降しながら漂う微粒子。
export function createMarineSnow(scene, { count = 900, size = 1.0 } = {}) {
  const box = { x: 70, y: WORLD.surfaceY, z: 70 };
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * box.x;
    positions[i * 3 + 1] = Math.random() * box.y;
    positions[i * 3 + 2] = (Math.random() - 0.5) * box.z;
    seeds[i * 2 + 0] = Math.random();
    seeds[i * 2 + 1] = 0.10 + Math.random() * 0.25; // 沈降速度
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 2));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...baseUniforms(),
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform float uPixelRatio;
      uniform vec3 uLampPos;
      uniform vec3 uLampDir;
      uniform float uLampI;
      uniform float uLampCos;
      uniform float uLampReach;
      attribute vec2 aSeed;
      varying float vA;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - uTime * aSeed.y, ${WORLD.surfaceY.toFixed(1)});
        p.x += sin(uTime * 0.35 + aSeed.x * 50.0 + p.y * 0.3) * 0.9;
        p.z += cos(uTime * 0.28 + aSeed.x * 70.0) * 0.9;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = (0.5 + fract(aSeed.x * 13.7) * 1.1) * ${size.toFixed(2)};
        gl_PointSize = size * 3.2 * uPixelRatio * clamp(14.0 / max(-mv.z, 1.0), 0.3, 2.4);
        // 近くの粒ほどわずかに濃く。水上へ出たら水中の浮遊物は見えない
        vA = clamp(1.6 - length(mv.xyz) * 0.03, 0.08, 0.5)
           * (1.0 - smoothstep(-0.2, 1.5, cameraPosition.y - ${WORLD.surfaceY.toFixed(1)}));
        // ダイバーライトのある深海では、光錐に入った粒だけが光る。
        // 闇の中を舞う雪がライトに照らされて浮かび上がる、あの絵になる
        vec3 dl = p - uLampPos;
        float ld = length(dl);
        float lampF = smoothstep(uLampCos, mix(uLampCos, 1.0, 0.5), dot(dl / max(ld, 1e-4), uLampDir))
                    * (1.0 - smoothstep(uLampReach * 0.35, uLampReach, ld)) * uLampI;
        vA *= mix(1.0, 0.05 + 2.6 * lampF, step(0.001, uLampI));
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.1, d) * vA * 0.4;
        gl_FragColor = vec4(vec3(0.8, 0.92, 1.0) * a, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 55;
  scene.add(pts);
  return pts;
}
