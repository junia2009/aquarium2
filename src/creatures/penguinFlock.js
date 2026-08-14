import * as THREE from 'three';
import { baseUniforms, WORLD, U } from '../env.js';
import { PENGUIN_KINDS, buildPenguinGeometry } from './penguin.js';
import { createFishMaterial } from './fishMaterial.js';
import { wander1 } from '../noise.js';
import { clampToTerrain } from '../collision.js';
import { sandHeight } from '../environment/seabed.js';

// ============ ペンギンの群れ ============
//
// 泳ぎの中身が、ここまでの生き物と根本的に違う。
// 魚もイルカも、体をくねらせて「連続的に」進む。ペンギンは翼を打つ鳥なので、
//   ・数回続けて強く打って加速し(バースト)
//   ・翼を左右に伸ばしたまま滑る(グライド)
// を繰り返す。速度計を付ければ、のこぎりの歯のような波形になる。
// 一定速度で泳がせると、どれだけ翼を動かしても鳥には見えない。
//
// 打つ速さは一定ではないので、羽ばたきの位相は時間×周波数では作れない。
// 速さを変えた瞬間に位相が飛んで、翼が瞬間移動してしまう。
// CPU側で位相を積分し、振幅とあわせて aInfo で渡す(→ fishMaterial.js)。

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _qb = new THREE.Matrix4();

const GRAVITY = 9.8;

// ============ 気泡の尾 ============
//
// 潜るペンギンは銀色の泡を引く。あれは吐いた息ではない。
// 羽毛のあいだに抱えこんだ空気が、加速と水圧で押し出されているもの。
// だから泡が出るのは「速く泳いだとき」と「深く潜ったとき」で、
// ゆっくり漂っているときには出ない。ここもそう作る。
//
// 粒は生まれた時刻・場所・初速だけをCPUが書き込み、その後の運動は
// GPUが計算する。書き込みが起きるのは粒が生まれる瞬間だけなので、
// 数百粒あってもCPUの負荷はほとんどない。
const BUBBLE_MAX = 1600;

class BubbleTrail {
  constructor(parent) {
    this.n = BUBBLE_MAX;
    this.head = 0;
    this.origin = new Float32Array(BUBBLE_MAX * 3);
    this.birth = new Float32Array(BUBBLE_MAX).fill(-999);
    this.vel = new Float32Array(BUBBLE_MAX * 3);
    this.seed = new Float32Array(BUBBLE_MAX * 2);
    for (let i = 0; i < BUBBLE_MAX; i++) {
      this.seed[i * 2 + 0] = Math.random();          // 大きさ
      this.seed[i * 2 + 1] = Math.random() * 100;    // 揺らぎの位相
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.origin, 3));
    geo.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 2));
    this.geo = geo;

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
        uniform float uSurfaceY;
        uniform float uPixelRatio;
        attribute float aBirth;
        attribute vec3 aVel;
        attribute vec2 aSeed;
        varying float vA;
        void main() {
          float age = uTime - aBirth;
          float life = 3.2 + aSeed.x * 2.0;
          if (aBirth < -900.0 || age < 0.0 || age > life) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; return;
          }
          vec3 p = position;
          // 生まれた瞬間の勢い(ペンギンの後流)は、粘性ですぐ抜ける
          p += aVel / 3.0 * (1.0 - exp(-3.0 * age));
          // 浮上。小さな泡は水の粘性に負けてゆっくりしか上がらない。
          // 大きい泡ほど速い(終端速度は半径にだいたい比例する)
          // 羽毛から出る泡はごく小さい(数mm)。小さい泡ほど水の粘性に
          // 負けて上がるのが遅く、そのぶん長く尾を引く
          float rise = 0.10 + aSeed.x * 0.22;
          p.y += rise * age;
          // 泡は上がりながら左右に揺れる。まっすぐ上げると噴水になる
          float ph = aSeed.y + age * 2.4;
          p.x += sin(ph) * 0.045 * age;
          p.z += cos(ph * 1.13) * 0.045 * age;

          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;
          // 上がるほど水圧が下がって膨らむ
          float grow = 1.0 + 0.25 * age;
          gl_PointSize = (0.0035 + aSeed.x * 0.0075) * grow * 900.0 * uPixelRatio / max(-mv.z, 0.1);
          // 水面に達したら消える
          vA = smoothstep(0.0, 0.25, age) * (1.0 - smoothstep(life * 0.6, life, age));
          vA *= smoothstep(0.0, 0.6, uSurfaceY - p.y);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          // 気泡は水と空気の境界。全反射で縁がいちばん明るく、中は抜ける
          float rim = smoothstep(0.30, 0.50, d) * smoothstep(0.5, 0.46, d);
          float hl = exp(-dot(c - vec2(-0.13, -0.13), c - vec2(-0.13, -0.13)) * 70.0);
          float a = (rim * 1.5 + hl * 0.8 + 0.04) * vA;
          gl_FragColor = vec4(vec3(0.82, 0.93, 1.0) * a, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });

    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 58;
    parent.add(this.points);
    this.dirty = false;
  }

  emit(pos, vel, time, spread = 0.05) {
    const i = this.head % this.n;
    this.head++;
    this.origin[i * 3 + 0] = pos.x + (Math.random() - 0.5) * spread;
    this.origin[i * 3 + 1] = pos.y + (Math.random() - 0.5) * spread;
    this.origin[i * 3 + 2] = pos.z + (Math.random() - 0.5) * spread;
    this.vel[i * 3 + 0] = vel.x * 0.35 + (Math.random() - 0.5) * 0.3;
    this.vel[i * 3 + 1] = vel.y * 0.35 + (Math.random() - 0.5) * 0.3;
    this.vel[i * 3 + 2] = vel.z * 0.35 + (Math.random() - 0.5) * 0.3;
    this.birth[i] = time;
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.aBirth.needsUpdate = true;
    this.geo.attributes.aVel.needsUpdate = true;
    this.dirty = false;
  }
}

export { BubbleTrail };

// ============ 群れ ============
export class PenguinFlock {
  /**
   * @param kind    PENGUIN_KINDS のいずれか
   * @param iceField createIceCanopy が返す field(氷の下面・甲板の高さ場)
   */
  constructor(parent, {
    kind = PENGUIN_KINDS.king,
    count = 6,
    center = new THREE.Vector3(0, 9, 0),
    radius = 16,
    iceField = null,
    bubbles = null,
    splash = null,
    openSpots = [],
    haulOuts = [],
  } = {}) {
    this.kind = kind;
    this.center = center.clone();
    this.radius = radius;
    this.iceField = iceField;
    this.bubbles = bubbles;
    this.splash = splash;
    this.openSpots = openSpots.length ? openSpots : [{ x: center.x, z: center.z }];
    this.haulOuts = haulOuts;
    this.time = 0;
    this.world = null;
    this.neighbors = null;

    const geo = buildPenguinGeometry(kind);
    this.mat = createFishMaterial({
      pattern: 9,
      len: kind.total,
      species: kind.species,
      wing: geo.userData.wingRoot,
      // 体はほとんど曲げない。翼で進む鳥なので、うねりは硬直を避けるぶんだけ
      swim: { freq: 1.0, amp: 0.008, waveNum: 0.35, headAmp: 0.05, flapFreq: kind.beatFreq * 6.28 },
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, count);
    this.mesh.frustumCulled = false;

    // aInfo は羽ばたき用に意味が変わる:
    //   x = 羽ばたきの位相(CPUが積分する) / y = 振幅(0で滑空)
    //   z = 体格 / w = 色ゆらぎ(体のうねりの位相にも使う)
    this.info = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      this.info[i * 4 + 0] = Math.random() * Math.PI * 2;
      this.info[i * 4 + 1] = 1;
      this.info[i * 4 + 2] = 0.92 + Math.random() * 0.16;
      this.info[i * 4 + 3] = Math.random();
    }
    this.infoAttr = new THREE.InstancedBufferAttribute(this.info, 4);
    geo.setAttribute('aInfo', this.infoAttr);
    parent.add(this.mesh);

    this.members = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random();
      this.members.push({
        pos: new THREE.Vector3(
          center.x + Math.cos(a) * radius * 0.4,
          center.y + (Math.random() - 0.5) * 3,
          center.z + Math.sin(a) * radius * 0.4
        ),
        vel: new THREE.Vector3(),
        heading: a + 1.6,
        pitch: 0,
        bank: 0,
        seed: Math.random() * 50,
        speed: kind.speed,
        wingPhase: Math.random() * Math.PI * 2,
        wingAmp: 1,
        // バースト・グライドの交代。翼を打つ鳥の泳ぎはこの往復でできている
        stroking: true,
        phaseT: 0.6 + Math.random() * 1.6,
        state: 'swim',
        body: kind.total * 0.16,
        // 息継ぎ。潜水時間を使い切ると開水面か氷の縁へ向かう
        breath: kind.dive * (0.05 + Math.random() * 0.7),
        plan: 'porpoise',
        target: null,
        aimX: 0, aimZ: 0,
        arcs: 0,
        slide: 0,
        rest: 0,
        curiousT: 0,
        curX: 0, curY: 0, curZ: 0,
      });
    }
  }

  setWorld(world) { this.world = world; }
  setNeighbors(list) { this.neighbors = list; }

  /** 図鑑からの追跡先。群れの平均ではなく先頭の個体を返す。
   *  散らばった群れの平均は、たいてい誰もいない空間を指してしまう */
  get lead() { return this.members[0].pos; }

  /** その位置で泳げる上限(氷の下面か水面) */
  ceilingAt(x, z) {
    return this.iceField ? this.iceField.under(x, z) : WORLD.surfaceY;
  }

  /**
   * 視線の先にいる個体を「気にさせる」。
   *
   * イワシは音圧で散り、深海のクラゲは警報を出すが、ペンギンは逆で、
   * 動くものがあると寄ってくる。潜水者のまわりを一周してのぞき込み、
   * 満足すると離れていく——南極の海でいちばんよく知られた行動なので、
   * ここでの「タップ」はそれにした。
   *
   * @returns 気にした個体がいれば true
   */
  curiousAlongRay(ray, slack = 1.0) {
    let best = null, bestT = 1e9;
    for (const m of this.members) {
      if (m.state !== 'swim') continue;
      // 体を回転楕円体とみなして視線との交差を解く。
      // 「視線にいちばん近い個体」を選ぶと、はるか後ろの1羽が
      // 手前の1羽を差し置いて選ばれることがある
      const r = m.body * 1.6 + slack;
      _v.copy(m.pos).sub(ray.origin);
      const b = _v.dot(ray.direction);
      if (b < 0) continue;
      const disc = r * r - (_v.lengthSq() - b * b);
      if (disc < 0) continue;
      const tHit = b - Math.sqrt(disc);
      if (tHit > 0 && tHit < bestT) { bestT = tHit; best = m; }
    }
    if (!best) return false;
    // 当たった個体と、その近くの数羽が一緒に来る。ペンギンは群れで動く
    const px = ray.origin.x + ray.direction.x * 1.4;
    const py = ray.origin.y + ray.direction.y * 1.4;
    const pz = ray.origin.z + ray.direction.z * 1.4;
    for (const m of this.members) {
      if (m.state !== 'swim') continue;
      if (m !== best && m.pos.distanceTo(best.pos) > 6) continue;
      m.curiousT = 5.5 + Math.random() * 3.5;
      m.curX = px + (Math.random() - 0.5) * 2.2;
      m.curY = py + (Math.random() - 0.5) * 1.4;
      m.curZ = pz + (Math.random() - 0.5) * 2.2;
    }
    return true;
  }

  /** いま息継ぎに行くならどこへ、を決める。
   *  ・たいていは開水面へ出て、水面すれすれをポーポイジングする
   *  ・ときどき氷へ跳び乗る(上陸点が近くにあるときだけ) */
  planSurfacing(m) {
    const wantIce = Math.random() < this.kind.haulOutChance && this.haulOuts.length;
    if (wantIce) {
      // いちばん近い上陸点。ただし遠すぎるものは選ばない
      let best = null, bestD = 1e9;
      for (const h of this.haulOuts) {
        const d = Math.hypot(h.fromX - m.pos.x, h.fromZ - m.pos.z);
        if (d < bestD) { bestD = d; best = h; }
      }
      if (best && bestD < 34) {
        m.plan = 'haulOut';
        m.target = best;
        m.aimX = best.fromX; m.aimZ = best.fromZ;
        m.state = 'approach';
        return;
      }
    }
    // 開水面へ。氷の下で浮上しても息はできない
    let best = null, bestD = 1e9;
    for (const s of this.openSpots) {
      const d = Math.hypot(s.x - m.pos.x, s.z - m.pos.z);
      if (d < bestD) { bestD = d; best = s; }
    }
    m.plan = 'porpoise';
    m.target = best;
    m.aimX = best ? best.x : m.pos.x;
    m.aimZ = best ? best.z : m.pos.z;
    m.arcs = 2 + Math.floor(Math.random() * 4);
    m.state = 'approach';
  }

  update(dt) {
    this.time += dt;
    const t = this.time;
    const k = this.kind;
    const others = this.neighbors || this.members;
    const cruise = k.speed;
    const surf = WORLD.surfaceY;

    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];

      // ================= 水の外 =================
      if (m.state === 'air' || m.state === 'onIce') {
        this.updateAirborne(m, dt, i);
        continue;
      }

      // ---- 息継ぎ ----
      // 潜水時間を使い切ったら、開水面か氷の縁へ向かう。
      // 氷の下でいくら浮上しても息はできない——このゾーンでは
      // 「どこで浮上するか」が生死を分ける
      m.breath -= dt;
      if (m.state === 'swim' && m.breath <= 0) this.planSurfacing(m);
      // 息継ぎに向かったまま水面へ出られないことがある(狙った割れ目が
      // ふさがっている、途中で氷に阻まれる)。諦めて泳ぎに戻す道を
      // 用意しておかないと、その個体は永遠に助走し続ける
      if (m.state === 'approach') {
        m.giveUp = (m.giveUp || 0) + dt;
        if (m.giveUp > 14) { m.state = 'swim'; m.giveUp = 0; m.breath = k.dive * 0.5; }
      } else m.giveUp = 0;

      // ---- バーストとグライドの交代 ----
      // 打っているあいだは加速し、止めているあいだは減速する。
      // 速度が一定だと、翼をいくら振っても推進しているように見えない
      m.phaseT -= dt;
      if (m.phaseT <= 0) {
        m.stroking = !m.stroking;
        m.phaseT = m.stroking
          ? 1.2 + Math.random() * 1.6      // 打つ
          : 1.1 + Math.random() * 2.2;     // 滑る
      }
      let target = m.stroking ? cruise * 1.60 : cruise * 0.42;
      // 打ち出しは速く、惰性の減速はやや遅い(推力が消えて抵抗だけになる)。
      // ここを近づけすぎると速度がほぼ一定になり、翼をいくら動かしても
      // 「進んでいる」ように見えない——最初がまさにそれだった
      let rate = m.stroking ? 2.4 : 1.25;
      if (m.state === 'approach') {
        // 助走中は打ちっぱなし。水面を割るには巡航の倍は要る
        target = cruise * (m.plan === 'haulOut' ? 2.5 : 1.9);
        rate = 2.2;
        m.stroking = true;
        m.phaseT = 1.0;
      }
      m.speed += (target - m.speed) * (1 - Math.exp(-rate * dt));

      // ---- 翼 ----
      // 打つ速さは出したい推力で決まる。速く泳ぐほど速く打つ。
      // 位相は積分する(時間×周波数だと、速さを変えた瞬間に翼が飛ぶ)
      const effort = THREE.MathUtils.clamp((m.speed - cruise * 0.5) / cruise, 0, 1.6);
      const rateHz = k.beatFreq * (0.55 + 0.75 * effort);
      m.wingPhase += rateHz * Math.PI * 2 * dt;
      if (m.wingPhase > Math.PI * 2) m.wingPhase -= Math.PI * 2;
      // 滑空では翼を左右に伸ばしたまま止める。振幅を0へ落とすと
      // その姿勢になる。ただし打つのをやめた瞬間に止めるのではなく、
      // 振り切ってから静かに畳む
      const wantAmp = m.stroking ? 1 : 0.06;
      m.wingAmp += (wantAmp - m.wingAmp) * (1 - Math.exp(-(m.stroking ? 7 : 3.6) * dt));

      // ---- 針路 ----
      let turn;
      if (m.curiousT > 0) {
        // のぞきに来ている。近づいたら速度を落として、まわりを回る
        m.curiousT -= dt;
        const d = Math.hypot(m.curX - m.pos.x, m.curZ - m.pos.z);
        const want = d > 2.2
          ? Math.atan2(m.curX - m.pos.x, m.curZ - m.pos.z)
          : Math.atan2(m.curX - m.pos.x, m.curZ - m.pos.z) + 1.25;   // 近くでは回り込む
        let diff = want - m.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        turn = diff * 3.0;
      } else if (m.state === 'approach') {
        // 息継ぎ地点へまっすぐ向かう
        const want = Math.atan2(m.aimX - m.pos.x, m.aimZ - m.pos.z);
        let diff = want - m.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        turn = diff * 2.6;
      } else {
        // 群れの中心へゆるく寄りつつ、氷の下を蛇行する
        turn = wander1(t * 0.22 + m.seed * 3, m.seed) * 1.5;
        const dx = m.pos.x - this.center.x, dz = m.pos.z - this.center.z;
        const r = Math.hypot(dx, dz);
        if (r > this.radius) {
          const toIn = Math.atan2(-dx, -dz);
          let diff = toIn - m.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          turn += diff * 1.4;
        }
      }
      // 仲間との近接回避
      for (const o of others) {
        if (o === m) continue;
        const ox = m.pos.x - o.pos.x, oz = m.pos.z - o.pos.z;
        const oy = m.pos.y - o.pos.y;
        const near = (m.body + o.body) * 2.6;
        const d2 = ox * ox + oz * oz;
        if (d2 < near * near && Math.abs(oy) < near && d2 > 1e-4) {
          const away = Math.atan2(ox, oz);
          let diff = away - m.heading;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          turn += diff * (1 - Math.sqrt(d2) / near) * 2.2;
        }
      }
      m.heading += THREE.MathUtils.clamp(turn, -2.6, 2.6) * dt;
      // 翼で進む生き物は、曲がるとき体ごと大きく傾ける。
      // 舵で曲がる魚と違い、傾けた翼の揚力そのもので曲がるため
      const wantBank = THREE.MathUtils.clamp(-turn * 0.55, -1.0, 1.0);
      m.bank += (wantBank - m.bank) * (1 - Math.exp(-4 * dt));

      // ---- 深さ ----
      let targetY = this.center.y + wander1(t * 0.10 + m.seed, m.seed) * 4.0;
      if (m.curiousT > 0) targetY = m.curY;
      const floor = sandHeight(m.pos.x, m.pos.z) + m.body + 0.6;
      // 頭上を塞いでいるのは氷だけ。水面は壁ではない。
      // ここを一律に「水面まで」で止めると、跳ぶための上向きの速度が
      // 作れず、いつまでも水面下をなぞるだけになる(実際そうなった)
      const iced = this.iceField ? this.iceField.hasIce(m.pos.x, m.pos.z) : false;
      const ceil = iced ? this.ceilingAt(m.pos.x, m.pos.z) - m.body - 0.25 : surf + 3.0;
      let dist2Aim = 1e9;
      if (m.state === 'approach') {
        dist2Aim = Math.hypot(m.aimX - m.pos.x, m.aimZ - m.pos.z);
        // 息継ぎ地点の手前で潜り、そこから斜めに駆け上がる。
        // 水面直下を横に走ってから跳ぼうとしても、上向きの速度が作れない。
        // 目標は水面より上に置く。水面ちょうどに置くと、近づくほど
        // 残り距離が0に収束して上昇がゆるみ、水平になってしまう
        targetY = dist2Aim > 9 ? surf - 5.0 : surf + 2.5;
      }
      targetY = THREE.MathUtils.clamp(targetY, floor, Math.max(ceil, floor + 0.2));

      const dy = targetY - m.pos.y;
      const vy = THREE.MathUtils.clamp(dy * 1.6, -m.speed * 0.75, m.speed * 0.85);
      m.pitch += (Math.atan2(vy, m.speed) - m.pitch) * (1 - Math.exp(-5 * dt));

      const ch = Math.cos(m.pitch) * m.speed;
      m.vel.set(Math.sin(m.heading) * ch, Math.sin(m.pitch) * m.speed, Math.cos(m.heading) * ch);
      m.pos.addScaledVector(m.vel, dt);

      // ---- 離水 ----
      // 水面へ達したところで弾道へ切り替える。速度はここで作り直さず、
      // 助走で得たものをそのまま引き継ぐ(作り直すと、水面で
      // 一瞬にして仰角が変わり、跳ね上がったように見える)
      if (m.state === 'approach' && m.pos.y > surf - m.body * 0.6 && m.vel.y > 0) {
        this.launch(m, dist2Aim);
        continue;
      }

      if (this.world) this.world.pushOut(m.pos, m.body, m.vel);
      clampToTerrain(m.pos, m.body + 0.3, m.vel);
      // 氷は突き抜けさせない。押し戻すだけでなく、上向きの速度も殺す。
      // 氷が無いところでは何もしない——水面は通り抜けてよい
      if (this.iceField && this.iceField.hasIce(m.pos.x, m.pos.z)) {
        const hardCeil = this.ceilingAt(m.pos.x, m.pos.z) - m.body * 0.6;
        if (m.pos.y > hardCeil) {
          m.pos.y = hardCeil;
          if (m.vel.y > 0) m.vel.y = 0;
          m.pitch = Math.min(m.pitch, 0);
        }
      } else if (m.state !== 'approach' && m.pos.y > surf - m.body * 0.7) {
        // ふだんの遊泳では水面から出ない。出るのは息継ぎのときだけ
        m.pos.y = surf - m.body * 0.7;
        if (m.vel.y > 0) m.vel.y = 0;
        m.pitch = Math.min(m.pitch, 0);
      }

      // ---- 気泡の尾 ----
      // 羽毛の空気は、加速したときと深いところで押し出される。
      // 漂っているときに出しっぱなしにすると、ただの泡発生装置になる
      if (this.bubbles) {
        const depth = Math.max(WORLD.surfaceY - m.pos.y, 0);
        const push = THREE.MathUtils.clamp((m.speed - cruise * 0.9) / (cruise * 0.6), 0, 1);
        const rateB = push * (0.8 + depth * 0.16) * 62;
        m.bubbleAcc = (m.bubbleAcc || 0) + rateB * dt;
        while (m.bubbleAcc >= 1) {
          m.bubbleAcc -= 1;
          // 泡は背中と翼の付け根から抜ける。尾のあたりに置くと
          // 「排気」に見えてしまう
          // 泡は一点からではなく、背中から尾にかけて全体から抜ける。
          // 一点から出すと排気管になる
          const along = -Math.random() * 0.55 * k.total / Math.max(m.speed, 0.5);
          _v.copy(m.pos).addScaledVector(m.vel, along);
          _v.y += m.body * 0.45;
          this.bubbles.emit(_v, m.vel, U.uTime.value, m.body * 0.9);
        }
      }

      // ---- 姿勢 ----
      this.poseAt(m, i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.infoAttr.needsUpdate = true;
    if (this.bubbles) this.bubbles.flush();
  }

  /**
   * 離水。助走で得た速度をそのまま弾道へ渡す。
   *
   * ポーポイジングは「息継ぎのついでの跳躍」ではなく、速く泳ぐための手段。
   * 水面ぎわを泳ぐと造波抵抗で急に重くなるので、ある速さを超えると
   * 空中を飛んだほうが安く済む。だから弧は低く長い。
   * 氷へ跳び乗るときだけは話が別で、板の高さを越える必要があるから
   * 立ち上がりが急になる。
   */
  launch(m, distToAim) {
    const surf = WORLD.surfaceY;
    m.pos.y = surf;
    if (m.plan === 'haulOut') {
      // 板の乾舷を越える高さが要る。真上に近い角度で強く跳ぶ
      const h = this.iceField
        ? Math.max(this.iceField.deck(m.target.x, m.target.z) - surf, 0.3)
        : 0.4;
      const reach = Math.hypot(m.target.x - m.pos.x, m.target.z - m.pos.z);
      // まず板を越える高さを満たす初速を出し、その滞空時間で
      // 着地点まで届くかを見る。届かないなら、水平を速くするのではなく
      // もっと高く跳ぶ(滞空時間を伸ばす)。水平だけ上げると
      // 板をかすめて向こうへ飛び越してしまう
      let vy = Math.sqrt(2 * GRAVITY * (h + 0.55));
      let flight = 2 * vy / GRAVITY;
      const FWD_MAX = 5.5;
      if (reach / flight > FWD_MAX) {
        flight = reach / FWD_MAX;
        vy = Math.min(flight * GRAVITY / 2, 7.5);
        flight = 2 * vy / GRAVITY;
      }
      const fwd = THREE.MathUtils.clamp(reach / flight, 0.8, FWD_MAX);
      m.heading = Math.atan2(m.target.x - m.pos.x, m.target.z - m.pos.z);
      m.vel.set(Math.sin(m.heading) * fwd, vy, Math.cos(m.heading) * fwd);
    } else {
      // ポーポイジングの弧。低く長い
      const fwd = Math.max(m.speed * 0.92, 3.0);
      const vy = 1.9 + Math.random() * 0.9;
      m.vel.set(Math.sin(m.heading) * fwd, vy, Math.cos(m.heading) * fwd);
    }
    m.state = 'air';
    m.wingAmp = 0.25;         // 空中では翼を伸ばしたまま
    if (this.splash) this.splash.burst(_v.copy(m.pos), U.uTime.value, 0.34);
  }

  /** 空中と氷の上。水中とは支配する式がまったく違うので分けてある */
  updateAirborne(m, dt, i) {
    const surf = WORLD.surfaceY;

    if (m.state === 'air') {
      m.vel.y -= GRAVITY * dt;
      m.pos.addScaledVector(m.vel, dt);
      m.heading = Math.atan2(m.vel.x, m.vel.z);
      // 姿勢は速度に沿う。跳び出しは頭が上、落ちるにつれ頭が下がる
      m.pitch = Math.atan2(m.vel.y, Math.hypot(m.vel.x, m.vel.z));
      m.bank += (0 - m.bank) * (1 - Math.exp(-5 * dt));

      const deck = this.iceField ? this.iceField.deck(m.pos.x, m.pos.z) : -1e4;
      // 氷の上へ落ちてきたら着地。腹から滑り込む(トボガン)
      if (m.plan === 'haulOut' && deck > -100 && m.pos.y <= deck + m.body && m.vel.y < 0) {
        m.pos.y = deck + m.body * 0.55;
        m.state = 'onIce';
        m.slide = Math.hypot(m.vel.x, m.vel.z);
        m.rest = 5 + Math.random() * 8;
        m.breath = this.kind.dive * (0.8 + Math.random() * 0.4);
        m.wingAmp = 0;
        m.pitch = 0;
        return this.poseAt(m, i);
      }
      // 水へ戻る
      if (m.pos.y <= surf && m.vel.y < 0) {
        m.pos.y = surf;
        if (this.splash) this.splash.burst(_v.copy(m.pos), U.uTime.value, 0.5);
        m.speed = Math.hypot(m.vel.x, m.vel.z) * 0.85;
        m.arcs = (m.arcs || 0) - 1;
        if (m.plan === 'porpoise' && m.arcs > 0) {
          // まだ弧を続ける。水面すれすれを走り、すぐまた跳ぶ
          m.state = 'approach';
          m.aimX = m.pos.x + Math.sin(m.heading) * 6;
          m.aimZ = m.pos.z + Math.cos(m.heading) * 6;
        } else {
          m.state = 'swim';
          m.breath = this.kind.dive * (0.8 + Math.random() * 0.4);
        }
        m.wingAmp = 1;
      }
      return this.poseAt(m, i);
    }

    // ---- 氷の上 ----
    // 跳び乗った勢いで腹這いのまま滑り、止まってしばらく休む。
    // 立ち姿にはしない。この体は首が曲がらない一本の紡錘形なので、
    // 直立させると嘴が真上を向いてしまう。腹で滑るのは実際の行動でもある
    m.slide *= Math.exp(-1.9 * dt);
    if (m.slide > 0.05) {
      m.pos.x += Math.sin(m.heading) * m.slide * dt;
      m.pos.z += Math.cos(m.heading) * m.slide * dt;
      const deck = this.iceField ? this.iceField.deck(m.pos.x, m.pos.z) : surf;
      m.pos.y = Math.max(deck, surf) + m.body * 0.55;
    }
    m.rest -= dt;
    if (m.rest <= 0) {
      // 縁へ向かって滑り出し、そのまま水へ落ちる
      m.state = 'air';
      m.plan = 'porpoise';
      m.arcs = 0;
      m.heading = Math.atan2(m.target.fromX - m.pos.x, m.target.fromZ - m.pos.z);
      const v = 2.2 + Math.random();
      m.vel.set(Math.sin(m.heading) * v, 0.3, Math.cos(m.heading) * v);
      m.wingAmp = 0.3;
    }
    return this.poseAt(m, i);
  }

  /** 行列を1体ぶん書き込む */
  poseAt(m, i) {
    _fwd.set(Math.sin(m.heading) * Math.cos(m.pitch), Math.sin(m.pitch),
             Math.cos(m.heading) * Math.cos(m.pitch)).normalize();
    _up.set(0, 1, 0);
    _right.crossVectors(_up, _fwd);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    _up.crossVectors(_fwd, _right);
    _m.makeBasis(_right, _up, _fwd);
    _q.setFromAxisAngle(_fwd, m.bank);
    _m.premultiply(_qb.makeRotationFromQuaternion(_q));
    _m.setPosition(m.pos);
    const s = this.info[i * 4 + 2];
    _m.scale(_v.set(s, s, s));
    this.mesh.setMatrixAt(i, _m);
    this.info[i * 4 + 0] = m.wingPhase;
    this.info[i * 4 + 1] = m.wingAmp;
  }
}
