import * as THREE from 'three';
import { baseUniforms, U, WORLD } from '../env.js';
import { UW_FRAG_PRELUDE, UW_FRAG_OUTPUT } from '../glsl.js';
import { shrimpGeometry, fryGeometry, flakeGeometry } from './feedShapes.js';

// ============ 餌 ============
//
// 水族館でいちばん人が集まるのは餌の時間で、それは魚が動くからではなく
// 「魚がこちらの行動に応えて動く」からだと思う。眺めるだけの水槽と、
// 一度でも餌をまいた水槽とでは、そのあとの見え方が変わる。
//
// なので餌は「粒を撒くエフェクト」ではなく、
//   ・撒いた粒が世界に残り、漂い、沈み、やがて散る
//   ・生き物がそれを目指して寄り、1粒ずつ食べて減っていく
// という状態にした。減っていくのが見えないと、食べているように見えない。
//
// 餌の種類はゾーンで違う。
//   プランクトン: ほとんど動かず、ゆっくり沈む。イワシとジンベエザメ
//   オキアミ    : 自分で泳ぐ。群れを作り、捕食者が来ると跳ねて散る
//   小魚        : 水面近くで銀色にひらめく。イルカ
//   有機物      : 沈降物。深海へまっすぐ落ちていく
//
// 粒は最大でも200ほどなので、CPUで動かして毎フレーム転送している。
// 「食べたら消える」を素直に書くには、GPU任せにしないほうがいい。

const MAX = 300;

// shape 形 / tint 色の掛け値 / len 体長(m。実寸)/ sink 沈降速度(m/s)
// dart 自分で泳ぐ強さ / cohere 群れの中心へ寄る強さ / life 消えるまでの秒数
// flex 泳ぐときの体のしなり(rad)/ flexRate その速さ
// rate  1秒あたりに食べられる口数。フレームレートに依らせないための上限で、
//       これがないと速いPCほど餌が一瞬で消える(=食べる場面が見られない)
//
// 大きさは実寸にしてある。南極オキアミは6cmほど、水族館で撒くアミエビは
// 2〜4cm、イルカに投げる小魚は10cm前後。ここを目分量で決めると、
// 隣を泳ぐ魚と並んだ瞬間に嘘だと分かってしまう。
export const FEED_KINDS = {
  // アミエビ。オキアミより小ぶりで色が淡い。水族館の撒き餌の定番
  plankton: { shape: 'shrimp', tint: [1.30, 1.15, 0.95], len: 0.038, sink: 0.09, dart: 0.10, cohere: 0.5, life: 42, rate: 7, flex: 0.26, flexRate: 8 },
  // 南極オキアミ。赤みが強く、密な群れを作って自分で泳ぐ
  krill: { shape: 'shrimp', tint: [1.55, 0.80, 0.62], len: 0.058, sink: 0.02, dart: 0.55, cohere: 1.3, life: 40, rate: 6, flex: 0.34, flexRate: 10 },
  // 生きた小魚。水面近くでひらめく
  fry: { shape: 'fry', tint: [1.00, 1.04, 1.10], len: 0.095, sink: 0.03, dart: 0.85, cohere: 1.0, life: 34, rate: 5, flex: 0.42, flexRate: 7 },
  // 沈降する有機物。深海ではこれが唯一の食べもの
  detritus: { shape: 'flake', tint: [1.25, 1.20, 1.10], len: 0.038, sink: 0.30, dart: 0.0, cohere: 0.0, life: 50, rate: 5, flex: 0, flexRate: 0 },
};

const SHAPES = { shrimp: shrimpGeometry, fry: fryGeometry, flake: flakeGeometry };

// 群れが固まりきらないための最小半径。これより内側では寄せない
const SWARM_CORE = 0.40;

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _up2 = new THREE.Vector3();
const _right = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();

export class FeedCloud {
  /**
   * @param kind FEED_KINDS のいずれか(キー文字列)
   */
  constructor(parent, kind = 'plankton') {
    this.k = FEED_KINDS[kind] || FEED_KINDS.plankton;
    this.n = 0;                       // 生きている粒の数
    this.credit = 0;                  // このフレームに残っている口数
    this.pos = [];
    this.vel = [];
    this.age = new Float32Array(MAX);
    this.ph = new Float32Array(MAX);  // 揺らぎの位相
    for (let i = 0; i < MAX; i++) {
      this.pos.push(new THREE.Vector3());
      this.vel.push(new THREE.Vector3());
      this.ph[i] = Math.random() * 100;
    }
    this.center = new THREE.Vector3();
    this.fade = new Float32Array(MAX);      // 出入りの透け具合
    this.jit = new Float32Array(MAX);       // 個体ごとの大きさのばらつき
    this.dir = [];                          // 向き。速度が出るまでは前フレームを保つ
    for (let i = 0; i < MAX; i++) this.dir.push(new THREE.Vector3(0, 0, 1));

    const geo = SHAPES[this.k.shape]();
    geo.setAttribute('aFade', new THREE.InstancedBufferAttribute(this.fade, 1));
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(this.ph, 1));
    this.geo = geo;

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...baseUniforms(),
        uTint: { value: new THREE.Color(...this.k.tint) },
        uFlex: { value: this.k.flex },
        uFlexRate: { value: this.k.flexRate },
      },
      transparent: true,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform float uTime;
        uniform float uFlex;
        uniform float uFlexRate;
        attribute vec3 aCol;
        attribute float aFade;
        attribute float aPhase;
        varying vec3 vCol;
        varying vec3 vN;
        varying vec3 vW;
        varying float vFade;
        void main() {
          vCol = aCol; vFade = aFade;
          vec3 p = position;
          vec3 n = normal;
          // 泳ぐしなり。頭を固定して尾へ向かうほど大きく振る。
          // 漂っているだけの粒と、泳いでいる生き物を分けるのはこれ
          if (uFlex > 0.0) {
            float w = pow(clamp(0.5 - p.z, 0.0, 1.0), 1.6);
            float a = uFlex * sin(uTime * uFlexRate + aPhase) * w;
            float s = sin(a), c = cos(a);
            p = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
            n = vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
          }
          vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
          vW = wp.xyz;
          vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: UW_FRAG_PRELUDE + /* glsl */ `
        uniform vec3 uTint;
        varying vec3 vCol;
        varying vec3 vN;
        varying vec3 vW;
        varying float vFade;
        void main() {
          // 薄い板(尾扇・ひれ)を裏から見ることがあるので法線を向け直す
          vec3 n = gl_FrontFacing ? normalize(vN) : -normalize(vN);
          vec3 viewDir = normalize(cameraPosition - vW);
          vec3 col = underwaterLight(vCol * uTint, n, vW, viewDir, 26.0, 0.30);
          // エビも小魚も体は半透明で、逆光では縁が透ける
          float rim = 1.0 - abs(dot(n, viewDir));
          col += vCol * uTint * pow(rim, 2.5) * 0.35;
          col = applyUnderwaterFog(col, vW);
          gl_FragColor = vec4(col, vFade);
          ${UW_FRAG_OUTPUT}
        }
      `,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, MAX);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    parent.add(this.mesh);
  }

  /** ひとつかみ撒く。撒いた点を中心に、少し散らして落とす */
  drop(p, count = 90, spread = 0.9) {
    for (let c = 0; c < count && this.n < MAX; c++) {
      const i = this.n++;
      const a = Math.random() * Math.PI * 2;
      const r = Math.pow(Math.random(), 0.5) * spread;
      this.pos[i].set(
        p.x + Math.cos(a) * r,
        p.y + (Math.random() - 0.5) * spread * 0.8,
        p.z + Math.sin(a) * r
      );
      // 撒いた勢い。手から離れた粒は少し散ってから落ち着く
      this.vel[i].set((Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.5,
                      (Math.random() - 0.5) * 0.8);
      this.dir[i].copy(this.vel[i]).normalize();
      this.age[i] = 0;
      this.ph[i] = Math.random() * 100;
      // 大きさは1匹ずつ違う。粒が全部同じ寸法だと工業製品に見える
      this.jit[i] = 0.78 + Math.random() * 0.44;
    }
    this.center.copy(p);
  }

  /** i 番目を消して、末尾の粒を詰める */
  remove(i) {
    const last = --this.n;
    if (i !== last) {
      this.pos[i].copy(this.pos[last]);
      this.vel[i].copy(this.vel[last]);
      this.dir[i].copy(this.dir[last]);
      this.age[i] = this.age[last];
      this.ph[i] = this.ph[last];
      this.jit[i] = this.jit[last];
    }
  }

  /**
   * 球のなかの粒を食べる。食べた数を返す。
   * 生き物側は「近づいて、口が届いたら呼ぶ」だけでよい。
   *
   * 呼ぶ側は毎フレーム呼ぶので、ここで口数を秒あたりに制限している。
   * こうしないと減る速さが描画のフレームレートで変わってしまい、
   * 速いPCでは撒いた瞬間に消えて、餌に群がる場面そのものが見られない。
   *
   * @param max 一度に飲みこめる数。ジンベエザメのような濾過摂食者は複数
   */
  eatNear(p, radius, max = 1) {
    if (this.credit < 1) return 0;
    const r2 = radius * radius;
    let ate = 0;
    for (let i = 0; i < this.n && ate < max && this.credit >= 1; i++) {
      if (this.pos[i].distanceToSquared(p) < r2) {
        this.remove(i); i--; ate++; this.credit -= 1;
      }
    }
    return ate;
  }

  /** いちばん近い粒。生き物が狙う先 */
  nearest(p, maxDist, out) {
    let best = -1, bd = maxDist * maxDist;
    for (let i = 0; i < this.n; i++) {
      const d = this.pos[i].distanceToSquared(p);
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0) return null;
    return out.copy(this.pos[best]);
  }

  /** 群れが向かう先。生きている粒の重心 */
  focus(out) {
    if (this.n === 0) return null;
    out.set(0, 0, 0);
    for (let i = 0; i < this.n; i++) out.add(this.pos[i]);
    return out.multiplyScalar(1 / this.n);
  }

  get active() { return this.n > 0; }

  /**
   * @param hunters 近づくと餌が逃げる相手(オキアミと小魚だけ)。
   *                {pos} の配列
   */
  update(dt, floorAt = null, hunters = null) {
    const k = this.k;
    const t = U.uTime.value;
    // このフレームぶんの口数を配る。溜めこめるのは2口までで、
    // カクついたフレームのあとにまとめて消えることがないようにしている
    this.credit = Math.min((this.credit || 0) + dt * k.rate, 2);
    // 自分で泳ぐ餌は群れる。オキアミの群れは動物の集団としては
    // 世界でいちばん密なものの部類で、散らばったままだと餌に見えない
    let cx = 0, cy = 0, cz = 0;
    if (k.cohere > 0 && this.n > 0) {
      for (let i = 0; i < this.n; i++) { cx += this.pos[i].x; cy += this.pos[i].y; cz += this.pos[i].z; }
      cx /= this.n; cy /= this.n; cz /= this.n;
    }
    for (let i = 0; i < this.n; i++) {
      this.age[i] += dt;
      if (this.age[i] > k.life) { this.remove(i); i--; continue; }
      const p = this.pos[i], v = this.vel[i];
      // 撒いた勢いは水の粘性ですぐ抜ける
      v.multiplyScalar(Math.exp(-2.2 * dt));
      v.y -= k.sink * dt * 2.0;
      v.y = Math.max(v.y, -k.sink);
      // 自分で泳ぐ餌。オキアミは群れのなかで小刻みに向きを変える
      if (k.dart > 0) {
        const ph = this.ph[i];
        v.x += Math.sin(t * 3.1 + ph) * k.dart * dt;
        v.y += Math.sin(t * 2.3 + ph * 1.7) * k.dart * 0.5 * dt;
        v.z += Math.cos(t * 2.7 + ph * 1.3) * k.dart * dt;
        // 群れの中心へ戻る。中心の近くでは効かせないので、
        // 一点に潰れずに雲のかたちを保つ。捕食者に散らされたあと
        // ゆっくり集まりなおすのも、これがやっている
        if (k.cohere > 0) {
          const dx = cx - p.x, dy = cy - p.y, dz = cz - p.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d > SWARM_CORE) {
            const s = k.cohere * Math.min((d - SWARM_CORE) * 0.6, 1) * dt / d;
            v.x += dx * s; v.y += dy * s; v.z += dz * s;
          }
        }
        // 捕食者が来ると跳ねて散る。オキアミの逃避反応(テイルフリップ)は
        // 動物プランクトンでいちばん速い部類で、これがあると
        // 「食べられている」のが一目で分かる
        if (hunters) {
          for (const h of hunters) {
            const dx = p.x - h.pos.x, dy = p.y - h.pos.y, dz = p.z - h.pos.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 2.2 * 2.2 && d2 > 1e-4) {
              const s = (1 - Math.sqrt(d2) / 2.2) * 7.0 * dt / Math.sqrt(d2);
              v.x += dx * s; v.y += dy * s; v.z += dz * s;
            }
          }
        }
      }
      p.addScaledVector(v, dt);
      // 底に着いたら止まる。そこで食べられるのを待つ
      if (floorAt) {
        const fy = floorAt(p.x, p.z) + 0.06;
        if (p.y < fy) { p.y = fy; v.y = 0; v.x *= 0.4; v.z *= 0.4; }
      }
      if (p.y > WORLD.surfaceY - 0.05) { p.y = WORLD.surfaceY - 0.05; v.y = Math.min(v.y, 0); }

      // 撒きはじめは湧いて出るように、終わりは溶けるように
      this.fade[i] = Math.min(this.age[i] * 4, 1)
                   * (1 - Math.max((this.age[i] - k.life * 0.7) / (k.life * 0.3), 0));

      // ---- 向き ----
      // 泳いでいるものは進む方へ頭を向ける。速度がほぼ0のときに
      // 向きを作ると毎フレームでたらめに回るので、前の向きを保つ
      const d = this.dir[i];
      if (k.flex > 0) {
        const sp = v.length();
        if (sp > 0.02) d.lerp(_v.copy(v).multiplyScalar(1 / sp), 1 - Math.exp(-9 * dt)).normalize();
        _fwd.copy(d);
        // 体の上を水面へ向けておく。真上/真下を向いたときだけ横倒しを避ける
        _up.set(0, 1, 0);
        if (Math.abs(_fwd.y) > 0.985) _up.set(1, 0, 0);
        _right.crossVectors(_up, _fwd).normalize();
        _up2.crossVectors(_fwd, _right);
        _m.makeBasis(_right, _up2, _fwd);
      } else {
        // 沈降物は姿勢を持たないので、ゆっくり回りながら落ちる
        const ph = this.ph[i];
        _e.set(ph + t * 0.25, ph * 1.7 + t * 0.19, ph * 2.3);
        _m.makeRotationFromEuler(_e);
      }
      const s = k.len * this.jit[i];
      _sv.set(s, s, s);
      _m.scale(_sv);
      _m.setPosition(p.x, p.y, p.z);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.geo.attributes.aFade.needsUpdate = true;
    this.geo.attributes.aPhase.needsUpdate = true;
  }
}
