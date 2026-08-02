import * as THREE from 'three';
import { WORLD } from '../env.js';
import { addCausticsToStandard } from '../environment/seabed.js';
import { wander1 } from '../noise.js';

// ============ アオウミガメ ============
// 前肢を翼のように使う「水中飛翔」。数分ごとに呼吸のため水面へ
// 上がる行動サイクル(cruise → ascend → breathe → descend)を再現。

// 甲羅の鱗板(スキュート)模様をCanvasで手続き生成
function makeShellTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#4a5a3a';
  g.fillRect(0, 0, 512, 512);

  const cell = (cx, cy, r, rot) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot);
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const rr = r * (0.9 + Math.sin(i * 3.7) * 0.08);
      if (i === 0) g.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      else g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
    }
    g.closePath();
    const grad = g.createRadialGradient(0, 0, r * 0.1, 0, 0, r);
    grad.addColorStop(0, '#7a8a55');
    grad.addColorStop(0.7, '#5a6a42');
    grad.addColorStop(1, '#3a4830');
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = '#2c3824';
    g.lineWidth = 6;
    g.stroke();
    g.restore();
  };

  // 中央列 + 側列の鱗板
  for (let row = 0; row < 5; row++) {
    cell(256, 90 + row * 85, 52, 0.1 * Math.sin(row * 5));
    cell(150, 130 + row * 82, 46, 0.3);
    cell(362, 130 + row * 82, 46, -0.3);
    if (row < 4) {
      cell(60, 160 + row * 80, 36, 0.5);
      cell(452, 160 + row * 80, 36, -0.5);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
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
    const shellMat = new THREE.MeshStandardMaterial({ map: makeShellTexture(), roughness: 0.7 });
    addCausticsToStandard(shellMat, 0.7);
    const bellyMat = new THREE.MeshStandardMaterial({ color: '#d8cfa8', roughness: 0.8 });
    addCausticsToStandard(bellyMat, 0.4);

    // 甲羅
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 18), shellMat);
    shell.scale.set(1.05, 0.42, 1.35);
    this.group.add(shell);
    // 腹甲
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.98, 18, 12), bellyMat);
    belly.scale.set(0.95, 0.22, 1.25);
    belly.position.y = -0.18;
    this.group.add(belly);

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
    this.head.position.set(0, 0.02, 1.05);
    this.group.add(this.head);

    // 前肢(大きな翼)・後肢
    this.flippers = [];
    const frontGeo = makeFlipper(1.5, 0.62);
    const rearGeo = makeFlipper(0.7, 0.42);
    for (const s of [-1, 1]) {
      const front = new THREE.Mesh(frontGeo, skin);
      front.position.set(s * 0.85, -0.08, 0.55);
      front.rotation.z = s > 0 ? 0 : Math.PI;
      front.rotation.y = s * -0.35;
      this.group.add(front);
      this.flippers.push({ mesh: front, side: s, front: true });

      const rear = new THREE.Mesh(rearGeo, skin);
      rear.position.set(s * 0.72, -0.1, -1.05);
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
