import * as THREE from 'three';
import { WORLD } from '../env.js';
import { addCausticsToStandard } from '../environment/seabed.js';
import { wander1 } from '../noise.js';

// ============ アオウミガメ ============
// 前肢を翼のように使う「水中飛翔」。数分ごとに呼吸のため水面へ
// 上がる行動サイクル(cruise → ascend → breathe → descend)を再現。

// ============ 甲羅の形状定数 ============
// 実物のアオウミガメは「潰した球」ではなく、しっかり盛り上がった甲高のドームで、
// 縁(縁甲板)が張り出して厚みを見せる。
const SHELL = {
  halfW: 1.05,    // 半幅
  halfL: 1.38,    // 半長
  height: 0.60,   // 甲羅頂点の高さ
  rimDrop: 0.16,  // 縁が下がる量(厚みの見え)
  belly: 0.30,    // 腹甲の深さ
};
// テクスチャ空間の半extent(甲羅ローカル正規化座標)
const HX = 1.08, HZ = 1.20;

// 上から見た甲羅の輪郭(正規化: 幅±1、前 +0.96 / 後 -1.10)
// 前方は丸く、後方はやや細く伸びる
function outlineAt(a) {
  const s = Math.sin(a), c = Math.cos(a);
  const rear = Math.max(-c, 0);
  const w = 1.0 - 0.30 * Math.pow(rear, 1.7);
  const l = 1.0 + 0.10 * rear * rear - 0.04 * Math.max(c, 0);
  return { x: s * w, z: c * l };
}

// ============ 鱗板(スキュート)模様 ============
// アオウミガメの甲板配列を実物どおりに配置し、ボロノイ分割で境界を作る。
//   椎甲板 5枚(正中線) / 肋甲板 4対 / 項甲板 1枚 / 縁甲板 12対
// 甲羅は平面UV(真上から見た座標)なので、テクスチャは甲羅の平面図そのもの。
function makeCarapaceTexture() {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const data = img.data;

  // seeds: [nx, nz, type] type 0=椎 1=肋 2=項 3=縁
  const seeds = [];
  for (const z of [0.60, 0.28, -0.05, -0.38, -0.71]) seeds.push([0, z, 0]);
  for (const z of [0.50, 0.17, -0.17, -0.50]) {
    seeds.push([-0.56, z, 1]);
    seeds.push([0.56, z, 1]);
  }
  seeds.push([0, 0.90, 2]);
  // 縁甲板: 輪郭に沿って並ぶ小さな板の帯
  const M = 14;
  for (let i = 0; i < M; i++) {
    const a = ((i + 0.5) / M) * Math.PI; // 前→後(右半周)
    const o = outlineAt(a);
    seeds.push([o.x * 1.02, o.z * 1.02, 3]);
    seeds.push([-o.x * 1.02, o.z * 1.02, 3]);
  }

  const ZW = SHELL.halfL / SHELL.halfW; // 距離を実寸比に補正
  const hashF = (i) => {
    const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  const sstep = (x, e0, e1) => {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  };
  // 甲羅表面の風化・付着物によるまだら
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const h = (a, b) => hashF(a * 57.3 + b * 131.7);
    return (h(xi, yi) * (1 - u) + h(xi + 1, yi) * u) * (1 - v)
         + (h(xi, yi + 1) * (1 - u) + h(xi + 1, yi + 1) * u) * v;
  };

  let p = 0;
  for (let py = 0; py < S; py++) {
    const nz = (0.5 - (py + 0.5) / S) * 2 * HZ;
    for (let px = 0; px < S; px++) {
      const nx = ((px + 0.5) / S - 0.5) * 2 * HX;

      let d1 = 1e9, d2 = 1e9, best = 0;
      for (let k = 0; k < seeds.length; k++) {
        const dx = nx - seeds[k][0];
        const dz = (nz - seeds[k][1]) * ZW;
        const d = dx * dx + dz * dz;
        if (d < d1) { d2 = d1; d1 = d; best = k; }
        else if (d < d2) { d2 = d; }
      }
      const s1 = Math.sqrt(d1), s2 = Math.sqrt(d2);
      const seed = seeds[best];
      const type = seed[2];

      // 甲板ごとの下地色: オリーブ褐色。板ごとに濃淡差がある
      const cv = hashF(best * 3.7);
      let r = 0.215 + cv * 0.075;
      let g = 0.180 + cv * 0.065;
      let b = 0.098 + cv * 0.032;
      if (type === 3) { r += 0.025; g += 0.020; b += 0.012; } // 縁甲板はやや明るい

      // 甲板内の成長線: 成長中心(後方寄り)から放射する細い縞。
      // 実物では高コントラストの扇ではなく、控えめな筋として見える
      const ox = seed[0] + (hashF(best * 5.1) - 0.5) * 0.08;
      const oz = seed[1] - (type === 3 ? 0.02 : 0.12);
      const ang = Math.atan2((nz - oz) * ZW, nx - ox);
      const coarse = 0.5 + 0.5 * Math.sin(ang * (4 + Math.floor(cv * 4)) + best * 2.7);
      const fine = 0.5 + 0.5 * Math.sin(ang * (15 + Math.floor(cv * 9)) + best * 1.3);
      const grow = Math.min(s1 / (type === 3 ? 0.30 : 0.34), 1);
      // 縁甲板は小さく、成長線もほとんど目立たない
      const amp = type === 3 ? 0.42 : 1.0;
      const streak = (coarse * 0.65 + fine * 0.35) * Math.pow(grow, 0.9) * amp;
      r += streak * 0.115; g += streak * 0.092; b += streak * 0.040;

      // 風化のまだら
      const mot = vnoise(nx * 9 + 11, nz * 9) - 0.5;
      r += mot * 0.045; g += mot * 0.040; b += mot * 0.022;

      // 甲板の縁は薄く暗い(角質板の段差)
      const edge = 1 - sstep(s2 - s1, 0.0, 0.048);
      r *= 1 - edge * 0.34; g *= 1 - edge * 0.34; b *= 1 - edge * 0.32;
      // 継ぎ目そのものは細い暗線
      const seam = 1 - sstep(s2 - s1, 0.0, 0.013);
      r *= 1 - seam * 0.5; g *= 1 - seam * 0.5; b *= 1 - seam * 0.46;

      data[p++] = Math.max(Math.min(r, 1), 0) * 255;
      data[p++] = Math.max(Math.min(g, 1), 0) * 255;
      data[p++] = Math.max(Math.min(b, 1), 0) * 255;
      data[p++] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ============ 甲羅(背甲)のジオメトリ ============
// 中心から縁へ同心リングを張る。UVは真上から見た平面座標なので
// テクスチャの甲板配置がそのまま甲羅の形に一致する。
function buildCarapace() {
  const SEG = 64, RINGS = 26;
  const pos = [], uv = [], idx = [];

  const yAt = (v) =>
    SHELL.height * Math.pow(Math.max(1 - v * v, 0), 0.62)
    - SHELL.rimDrop * THREE.MathUtils.smoothstep(v, 0.76, 1.0);

  pos.push(0, SHELL.height, 0);
  uv.push(0.5, 0.5);
  for (let i = 1; i <= RINGS; i++) {
    const v = i / RINGS;
    const y = yAt(v);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const o = outlineAt(a);
      const nx = o.x * v, nz = o.z * v;
      pos.push(nx * SHELL.halfW, y, nz * SHELL.halfL);
      uv.push(0.5 + nx / (2 * HX), 0.5 - nz / (2 * HZ));
    }
  }
  const ringStart = (i) => 1 + (i - 1) * SEG;
  for (let j = 0; j < SEG; j++) {
    idx.push(0, 1 + j, 1 + ((j + 1) % SEG));
  }
  for (let i = 1; i < RINGS; i++) {
    const a0 = ringStart(i), b0 = ringStart(i + 1);
    for (let j = 0; j < SEG; j++) {
      const jn = (j + 1) % SEG;
      idx.push(a0 + j, b0 + j, b0 + jn);
      idx.push(a0 + j, b0 + jn, a0 + jn);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

// ============ 腹甲のジオメトリ ============
// 背甲と同じ輪郭で下側を閉じるので、縁で隙間なく繋がり体に厚みが出る
function buildPlastron() {
  const SEG = 64, RINGS = 16;
  const pos = [], uv = [], idx = [];

  const yAt = (v) => -SHELL.rimDrop - SHELL.belly * Math.pow(Math.max(1 - v * v, 0), 0.85);

  pos.push(0, yAt(0), 0);
  uv.push(0.5, 0.5);
  for (let i = 1; i <= RINGS; i++) {
    const v = i / RINGS;
    const y = yAt(v);
    for (let j = 0; j < SEG; j++) {
      const a = (j / SEG) * Math.PI * 2;
      const o = outlineAt(a);
      const nx = o.x * v, nz = o.z * v;
      pos.push(nx * SHELL.halfW, y, nz * SHELL.halfL);
      uv.push(0.5 + nx / (2 * HX), 0.5 - nz / (2 * HZ));
    }
  }
  const ringStart = (i) => 1 + (i - 1) * SEG;
  // 下向きなので巻き順を反転
  for (let j = 0; j < SEG; j++) {
    idx.push(0, 1 + ((j + 1) % SEG), 1 + j);
  }
  for (let i = 1; i < RINGS; i++) {
    const a0 = ringStart(i), b0 = ringStart(i + 1);
    for (let j = 0; j < SEG; j++) {
      const jn = (j + 1) % SEG;
      idx.push(a0 + j, b0 + jn, b0 + j);
      idx.push(a0 + j, a0 + jn, b0 + jn);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setIndex(idx);
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

function makeFlipper(len, wid) {
  // 平たい翼状のひれ: 押しつぶした楕円体を湾曲
  const geo = new THREE.SphereGeometry(1, 12, 8);
  geo.scale(len * 0.5, 0.07, wid * 0.5);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    // 先端を後方へ湾曲させ、細くする
    const t = (x / len + 0.5);
    pos.setZ(i, pos.getZ(i) * (1.15 - t * 0.55) - t * t * wid * 0.35);
    pos.setY(i, pos.getY(i) * (1 - t * 0.3));
  }
  geo.translate(len * 0.42, 0, 0); // 付け根を原点に
  geo.computeVertexNormals();
  return geo;
}

export class SeaTurtle {
  constructor(scene) {
    this.group = new THREE.Group();

    const skin = new THREE.MeshStandardMaterial({ color: '#6a7a52', roughness: 0.85 });
    addCausticsToStandard(skin, 0.7);
    const shellMat = new THREE.MeshStandardMaterial({ map: makeCarapaceTexture(), roughness: 0.62 });
    addCausticsToStandard(shellMat, 0.7);
    const bellyMat = new THREE.MeshStandardMaterial({ color: '#cfc6a2', roughness: 0.85 });
    addCausticsToStandard(bellyMat, 0.4);

    // 背甲 + 腹甲(同じ輪郭で閉じるので縁に厚みが出る)
    this.group.add(new THREE.Mesh(buildCarapace(), shellMat));
    this.group.add(new THREE.Mesh(buildPlastron(), bellyMat));

    // 頭 + 首(首の根本は甲羅の中まで差し込んで連続させる)
    this.head = new THREE.Group();
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.26, 1.1, 12), skin);
    neck.rotation.x = Math.PI / 2 - 0.2;
    neck.position.set(0, 0.10, 0.22);
    this.head.add(neck);
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), skin);
    skull.scale.set(0.85, 0.78, 1.2);
    skull.position.set(0, 0.21, 0.78);
    this.head.add(skull);
    // 目
    const eyeMat = new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.3 });
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), eyeMat);
      eye.position.set(s * 0.155, 0.28, 0.88);
      this.head.add(eye);
    }
    this.head.position.set(0, -0.06, 1.02);
    this.group.add(this.head);

    // 前肢(大きな翼)・後肢
    this.flippers = [];
    const frontGeo = makeFlipper(1.5, 0.62);
    const rearGeo = makeFlipper(0.7, 0.42);
    for (const s of [-1, 1]) {
      const front = new THREE.Mesh(frontGeo, skin);
      front.position.set(s * 0.78, -0.20, 0.50);
      front.rotation.z = s > 0 ? 0 : Math.PI;
      front.rotation.y = s * -0.35;
      this.group.add(front);
      this.flippers.push({ mesh: front, side: s, front: true });

      const rear = new THREE.Mesh(rearGeo, skin);
      rear.position.set(s * 0.50, -0.22, -1.05);
      rear.rotation.z = s > 0 ? 0 : Math.PI;
      rear.rotation.y = s * 0.5;
      this.group.add(rear);
      this.flippers.push({ mesh: rear, side: s, front: false });
    }

    this.group.scale.setScalar(1.15);
    scene.add(this.group);

    // ---- 行動状態 ----
    this.pos = new THREE.Vector3(-6, 7, 8);
    this.heading = 1.2;
    this.speed = 1.1;
    this.seed = 3.3;
    this.time = Math.random() * 50;
    this.state = 'cruise';       // cruise | ascend | breathe | descend
    this.stateTimer = 40 + Math.random() * 40; // 次の呼吸まで
    this.flapPower = 1;
  }

  update(dt) {
    this.time += dt;
    this.stateTimer -= dt;
    const t = this.time;

    // ---- 呼吸サイクル ----
    let targetY;
    switch (this.state) {
      case 'cruise':
        targetY = 5.5 + wander1(t * 0.04, this.seed) * 3;
        this.flapPower = 0.55 + 0.45 * Math.max(0, Math.sin(t * 0.35)); // 漕いでは滑空
        if (this.stateTimer <= 0) { this.state = 'ascend'; }
        break;
      case 'ascend':
        targetY = WORLD.surfaceY - 0.6;
        this.flapPower = 1.2;
        if (this.pos.y > WORLD.surfaceY - 1.2) { this.state = 'breathe'; this.stateTimer = 5 + Math.random() * 3; }
        break;
      case 'breathe':
        targetY = WORLD.surfaceY - 0.45;
        this.flapPower = 0.25; // 水面でほぼ静止
        if (this.stateTimer <= 0) { this.state = 'descend'; }
        break;
      case 'descend':
        targetY = 6;
        this.flapPower = 0.8;
        if (this.pos.y < 7.5) { this.state = 'cruise'; this.stateTimer = 60 + Math.random() * 60; }
        break;
    }

    // ---- 針路 ----
    let turn = wander1(t * 0.06 + 10, this.seed) * 0.4;
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > WORLD.half * 0.75) {
      const toCenter = Math.atan2(-this.pos.x, -this.pos.z);
      let diff = toCenter - this.heading;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      turn += diff * 0.7;
    }
    this.heading += THREE.MathUtils.clamp(turn, -0.5, 0.5) * dt;

    const speedTarget = this.state === 'breathe' ? 0.25 : 0.9 + this.flapPower * 0.7;
    this.speed += (speedTarget - this.speed) * (1 - Math.exp(-1.2 * dt));
    this.pos.y += (targetY - this.pos.y) * (1 - Math.exp(-(this.state === 'cruise' ? 0.35 : 0.8) * dt));
    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;

    // ---- 姿勢・前肢のストローク ----
    this.group.position.copy(this.pos);
    const pitch = THREE.MathUtils.clamp((this.pos.y - targetY) * 0.25, -0.35, 0.35);
    this.group.rotation.set(pitch, this.heading, 0, 'YXZ');

    const stroke = Math.sin(t * 1.9) * this.flapPower;
    const strokeLag = Math.sin(t * 1.9 - 0.7) * this.flapPower;
    for (const f of this.flippers) {
      if (f.front) {
        // 前肢: 大きく上下 + ひねり(揚力ベースの水中飛翔)
        f.mesh.rotation.z = (f.side > 0 ? 0 : Math.PI) + f.side * stroke * 0.55;
        f.mesh.rotation.x = strokeLag * 0.3;
      } else {
        // 後肢: 舵として小さく揺れる
        f.mesh.rotation.x = Math.sin(t * 0.9 + (f.side > 0 ? 0 : 1.2)) * 0.15;
      }
    }
    // 首をわずかに揺らす
    this.head.rotation.y = Math.sin(t * 0.5) * 0.15;
    this.head.rotation.x = this.state === 'ascend' ? -0.3 : Math.sin(t * 0.7) * 0.08;
  }
}
