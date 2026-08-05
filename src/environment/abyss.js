import * as THREE from 'three';
import { baseUniforms, WORLD, U } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { addCausticsToStandard } from './seabed.js';
import { fbm3 } from '../noise.js';

// ============ 深海(漸深層)の環境 ============
// 太陽光は届かない。見えるものは「ダイバーライトが当たったもの」と
// 「自分で光るもの」だけになる。ここでは前者を作る。

// ---- 地形 ----
// ほとんど平坦な軟泥の平原。片側に熱水噴出孔の湧く高まりがある。
export function abyssTerrain(x, z) {
  // 大きなうねり(海丘)
  let y = fbm3(x * 0.018 + 40, 0, z * 0.018, 3) * 2.6 - 0.6;
  // 噴出孔のある高まり
  const d = Math.hypot(x - 11, z + 12);
  y += Math.max(0, 5.4 - d * 0.42) * 0.9;
  // 軟泥の細かい起伏
  y += fbm3(x * 0.09 + 11, 0, z * 0.09, 2) * 0.45;
  return y;
}

// ---- 軟泥の海底 ----
// 深海底は砂紋ではなく、生物の這い跡と巣穴が刻まれた平らな泥。
// 砂と同じ「うねる畝」を出すと浅い海に見えてしまう。
export function createSediment(scene) {
  const size = 200;
  const seg = 150;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, abyssTerrain(pos.getX(i), pos.getZ(i)));
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

        // 有孔虫の殻が降り積もった、灰白色の軟泥
        float mottle = fbm(p * 0.11);
        vec3 albedo = mix(vec3(0.34, 0.325, 0.30), vec3(0.19, 0.185, 0.175), mottle);

        // 這い跡: 生き物が泥の上を引きずっていった細い溝。
        // 歪ませた線を細く抜くと、うねうねと曲がった跡になる
        float warp = fbm(p * 0.07) * 6.0;
        float trail = smoothstep(0.10, 0.0, abs(fract(p.x * 0.05 + warp) - 0.5) - 0.44);
        trail *= smoothstep(0.45, 0.75, fbm(p * 0.04 + 13.0));

        // 巣穴: 泥に開いた小さな黒い穴。縁がわずかに盛り上がる
        vec2 bg = p * 0.55;
        vec2 bCell = floor(bg);
        vec2 bOff = vec2(hash12(bCell + 1.7), hash12(bCell + 9.1)) - 0.5;
        float br = length(fract(bg) - 0.5 - bOff * 0.6);
        float burrow = step(0.90, hash12(bCell * 1.31)) * smoothstep(0.16, 0.05, br);
        float rim = step(0.90, hash12(bCell * 1.31)) * smoothstep(0.28, 0.17, br) * (1.0 - burrow);

        albedo *= 1.0 - trail * 0.30 - burrow * 0.80;
        albedo += rim * 0.05;

        // 法線もわずかに乱して、泥の柔らかさを出す
        // 泥のきめ。粗いうねりだけだと、ライトの下が白い皿に見える
        albedo *= 0.86 + 0.28 * fbm(p * 2.6);
        vec3 n = normalize(vNormal + vec3(
          (fbm(p * 3.2) - 0.5) * 0.34 + (fbm(p * 0.9) - 0.5) * 0.22 - burrow * 0.5,
          0.0,
          (fbm(p * 3.2 + 7.0) - 0.5) * 0.34 + (fbm(p * 0.9 + 3.0) - 0.5) * 0.22
        ));

        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 col = underwaterLight(albedo, n, vWorldPos, V, 18.0, 0.02);
        col = applyUnderwaterFog(col, vWorldPos);
        gl_FragColor = vec4(col, 1.0);
        ${UW_FRAG_OUTPUT}
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);
  return mesh;
}

// ---- 熱水噴出孔(ブラックスモーカー) ----
// 硫化物が積み上がってできた煙突。実物は300℃を超えるが、その熱放射は
// 赤外なので目には見えない。光っているように描くのは間違いなので、
// あくまで「ライトを当てて初めて見える黒い岩」として置く。
function buildChimney(h, r0, seed) {
  const RINGS = 26, SEG = 18;
  const pos = [], idx = [];
  const rnd = (i) => {
    const v = Math.sin((i + seed) * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  for (let i = 0; i <= RINGS; i++) {
    const t = i / RINGS;
    // 裾は広く、上へ向かって急に細る。途中に何段も瘤ができる
    const taper = Math.pow(1 - t, 0.55) * (0.30 + 0.70 * Math.pow(1 - t, 1.6));
    const bulge = 0.78 + 0.44 * rnd(i * 3.1) + 0.16 * Math.sin(t * 19 + seed);
    const r = r0 * (0.35 + 1.45 * taper) * bulge;
    const y = t * h;
    // 積み上がりが片側へ倒れ、途中で向きも変わる
    const lean = t * t * r0 * 0.9 + Math.sin(t * 4.2 + seed) * r0 * 0.22;
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      // 縦にも横にもばらつかせる。滑らかな回転体だと煙突に見えない
      const k = 0.68 + 0.64 * rnd(i * 7 + j * 13) * (0.5 + 0.5 * rnd(j * 5.7));
      pos.push(Math.sin(a) * r * k + lean, y, Math.cos(a) * r * k);
    }
  }
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < SEG; j++) {
      const jn = (j + 1) % SEG;
      const a = i * SEG + j, b = i * SEG + jn;
      const c = (i + 1) * SEG + j, d = (i + 1) * SEG + jn;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  // 面ごとに法線を立てて、硫化物の割れた稜をそのまま見せる
  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  return flat;
}

// ---- 噴煙 ----
// 硫化物の微粒子が黒い煙のように立ち上る。周囲の水より熱くて軽いので
// まっすぐ上がり、冷えるにつれて広がって溶ける。
function createPlumes(scene, mouths) {
  const PER = 220;
  const count = mouths.length * PER;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const slot = Math.floor(i / PER);
    const a = Math.random() * Math.PI * 2;
    const r = Math.pow(Math.random(), 0.6);
    seeds[i * 4 + 0] = Math.cos(a) * r;
    seeds[i * 4 + 1] = Math.sin(a) * r;
    seeds[i * 4 + 2] = Math.random();          // 位相
    seeds[i * 4 + 3] = slot;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));

  const N = mouths.length;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...baseUniforms(),
      uMouths: { value: mouths.map((m) => m.clone()) },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uMouths[${N}];
      uniform float uPixelRatio;
      uniform vec3 uLampPos;
      uniform vec3 uLampDir;
      uniform float uLampI;
      uniform float uLampCos;
      uniform float uLampReach;
      attribute vec4 aSeed;
      varying float vA;
      void main() {
        int slot = int(aSeed.w + 0.5);
        float life = 9.0;
        float age = mod(uTime * 0.55 + aSeed.z * life, life);
        float t = age / life;
        vec3 p = uMouths[slot];
        // 立ち上がりは速く、上ほど鈍る。同時に横へ広がる
        p.y += 7.0 * (1.0 - exp(-1.5 * age));
        float spread = 0.35 + 3.2 * t * t;
        p.x += aSeed.x * spread + sin(uTime * 0.4 + aSeed.z * 30.0) * t * 1.2;
        p.z += aSeed.y * spread + cos(uTime * 0.33 + aSeed.z * 40.0) * t * 1.2;

        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = (14.0 + 40.0 * t) * uPixelRatio * clamp(14.0 / max(-mv.z, 1.0), 0.2, 3.0);

        // 煙も自分では光らない。ライトが当たったぶんだけ見える
        vec3 dl = p - uLampPos;
        float ld = length(dl);
        float lampF = smoothstep(uLampCos, mix(uLampCos, 1.0, 0.5), dot(dl / max(ld, 1e-4), uLampDir))
                    * (1.0 - smoothstep(uLampReach * 0.35, uLampReach, ld)) * uLampI;
        vA = (1.0 - t) * (1.0 - t) * (0.05 + 0.95 * lampF);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vA;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.05, d) * vA * 0.28;
        gl_FragColor = vec4(vec3(0.10, 0.09, 0.085) * a, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 54;
  scene.add(pts);
  return pts;
}

// ---- チューブワーム(ハオリムシ) ----
// 白い棲管の先から真っ赤な鰓冠を出す。この赤は周囲光では真っ黒に沈み、
// ダイバーライトを当てた瞬間だけ血の色になる。深海の赤い生物が
// 赤いのは「赤い光が届かない=見えない色だから」で、それをそのまま描く。
function createTubeWorms(scene, clusters) {
  const group = new THREE.Group();
  const tubeMat = new THREE.MeshStandardMaterial({ color: '#e6e0d0', roughness: 0.85 });
  const plumeMat = new THREE.MeshStandardMaterial({ color: '#d81a1e', roughness: 0.55 });
  addCausticsToStandard(tubeMat, 0.0);
  addCausticsToStandard(plumeMat, 0.0);

  const tube = new THREE.CylinderGeometry(0.022, 0.034, 1, 6, 1, true);
  // 鰓冠は丸みのある羽根。真球だとマッチ棒、尖った円錐だと矢尻に見える
  const plume = new THREE.SphereGeometry(1, 8, 7);
  plume.scale(0.055, 0.17, 0.055);
  plume.translate(0, 0.10, 0);

  let n = 0;
  for (const c of clusters) n += c.count;
  const tubes = new THREE.InstancedMesh(tube, tubeMat, n);
  const plumes = new THREE.InstancedMesh(plume, plumeMat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();

  let i = 0;
  for (const c of clusters) {
    for (let k = 0; k < c.count; k++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * c.radius;
      const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
      const y = abyssTerrain(x, z);
      // 中心ほど長く育つ。長さがそろうと人工物に見える
      const len = (0.25 + Math.pow(Math.random(), 1.7) * 1.35) * (1.25 - r / c.radius * 0.5);
      // 棲管は熱水のほうへ思い思いに傾く
      // 外周ほど外へ倒れる(熱水のほうへ首を伸ばす)
      const outw = (r / c.radius) * 0.55;
      dir.set(Math.cos(a) * outw + (Math.random() - 0.5) * 0.5, 1,
              Math.sin(a) * outw + (Math.random() - 0.5) * 0.5).normalize();
      q.setFromUnitVectors(up, dir);
      m.compose(new THREE.Vector3(x, y + len * 0.5 * dir.y, z), q, new THREE.Vector3(1, len, 1));
      tubes.setMatrixAt(i, m);
      m.compose(
        new THREE.Vector3(x + dir.x * len, y + dir.y * len, z + dir.z * len),
        q, new THREE.Vector3(1, 1, 1)
      );
      plumes.setMatrixAt(i, m);
      i++;
    }
  }
  group.add(tubes, plumes);
  scene.add(group);
  return group;
}

// ---- 噴出孔一式 ----
export function createVentField(scene, spots) {
  const group = new THREE.Group();
  const rockMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#5b4d40'), roughness: 0.97, metalness: 0.0,
  });
  addCausticsToStandard(rockMat, 0.0);   // 深海に集光模様はない。ライトだけ効かせる

  const mouths = [];
  const colliders = [];
  for (const s of spots) {
    const base = abyssTerrain(s.x, s.z);
    const geo = buildChimney(s.h, s.r, s.seed);
    const mesh = new THREE.Mesh(geo, rockMat);
    mesh.position.set(s.x, base, s.z);
    group.add(mesh);
    mouths.push(new THREE.Vector3(s.x + s.r * 0.9, base + s.h, s.z));
    colliders.push({
      center: new THREE.Vector3(s.x + s.r * 0.45, base + s.h * 0.5, s.z),
      rx: s.r * 1.5, ry: s.h * 0.55, rz: s.r * 1.5,
    });
  }
  scene.add(group);
  createPlumes(scene, mouths);
  createTubeWorms(scene, spots.map((s) => ({
    x: s.x - s.r * 1.7, z: s.z + s.r * 1.3, radius: s.r * 1.5, count: 150,
  })));
  return { group, colliders, mouths };
}
