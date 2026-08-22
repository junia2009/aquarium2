import * as THREE from 'three';
import { DiveCamera } from './camera.js';
// スタイルは index.html の <link> で読み込む(ビルドなし配信と両立させるため)

import { U } from './env.js';
import { createBackground, createLights } from './environment/background.js';
import { setTerrain } from './environment/seabed.js';
import { GREAT_TANK } from './zones/greatTank.js';
import { DOLPHIN_POOL } from './zones/dolphinPool.js';
import { ABYSS } from './zones/abyss.js';
import { ICE_SEA } from './zones/iceSea.js';
import { SHORE } from './zones/shore.js';
import { HUB } from './zones/hub.js';

import { setupUI } from './ui.js';
import { UnderwaterAudio } from './audio.js';
import { UnderwaterScatter } from './postfx.js';
import { PortalWarp } from './transition.js';

// ================= 基盤 =================
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// 水の前方散乱。遠いものほど輪郭がぼける(→ postfx.js)
const scatter = new UnderwaterScatter(renderer);

const scene = new THREE.Scene();
// 画角は縦で持つが、狭くなりすぎるのは横のほう。
//
// 縦画角58度は、横並びの画面(縦横比1.7)なら横87度ある。ところが
// 縦長の携帯(0.58)では横36度しかない——望遠鏡を覗いているのと変わらず、
// 目の前のものが画面いっぱいに来て、部屋のどこにいるのか分からなくなる。
//
// 横の画角に下限を設け、足りないぶんを縦画角で補う。ただし縦を広げ
// すぎると今度は魚眼になるので、76度で頭打ちにする
const FOV_V = 58, FOV_H_MIN = 62, FOV_V_MAX = 76;
const D2R = Math.PI / 180;
function fovFor(aspect) {
  const h = 2 * Math.atan(Math.tan(FOV_V * D2R / 2) * aspect) / D2R;
  if (h >= FOV_H_MIN) return FOV_V;
  const v = 2 * Math.atan(Math.tan(FOV_H_MIN * D2R / 2) / aspect) / D2R;
  return Math.min(v, FOV_V_MAX);
}
const camera = new THREE.PerspectiveCamera(
  fovFor(window.innerWidth / window.innerHeight),
  window.innerWidth / window.innerHeight, 0.1, 500);
scene.fog = new THREE.FogExp2(U.uFogColor.value.clone(), U.uFogDensity.value);

// ダイバー視点の自由カメラ(見回す/平行移動/前後進/上下が全て独立)
const diveCam = new DiveCamera(camera, canvas);

// 背景ドームとライトは全ゾーン共通(色はゾーンのユニフォームで変わる)
createBackground(scene);
const lights = createLights(scene);

const audio = new UnderwaterAudio();

// ================= ゾーン =================
// 各ゾーンは初回訪問時に構築し、以降は表示の切り替えだけで往復する。
// 行き先(水槽)と、そこへ繋ぐポータルエリアは別もの。
// TANKS が増えてもハッチが1枚増えるだけで、UI は伸びない
const TANKS = [GREAT_TANK, DOLPHIN_POOL, ABYSS, ICE_SEA, SHORE];
const ZONES = [HUB, ...TANKS];
const DEFAULT_SUN = new THREE.Color('#ffefcf');
const DEFAULT_LAMP = new THREE.Color('#eaf4ff');
const built = new Map();
let active = null;

function buildZone(def) {
  const root = new THREE.Group();
  root.visible = false;
  scene.add(root);
  // 生物の配置は地形に依存するので、構築前に地形を差し替えておく
  setTerrain(def.terrain);
  const inst = def.build(root, audio);
  // ポータルエリアは、どこへ繋ぐかを外から受け取る。
  // 施設のほうが水槽の一覧を持つと、追加のたびに2か所直すことになる
  if (inst.setDestinations) inst.setDestinations(TANKS);
  built.set(def.key, { def, root, ...inst });
  return built.get(def.key);
}

function enterZone(key, { moveCamera = true } = {}) {
  const zone = built.get(key) || buildZone(ZONES.find((z) => z.key === key));
  if (active === zone) return zone;
  if (active) {
    active.root.visible = false;
    // ゾーン固有の共有ユニフォーム(流氷の被覆など)は必ず戻す。
    // 置きっぱなしにすると、次のゾーンが前のゾーンの影を引きずる
    if (active.onLeave) active.onLeave();
  }
  active = zone;
  active.root.visible = true;
  if (active.onEnter) active.onEnter();

  // 地形・水の色・光をゾーンのものへ
  setTerrain(zone.def.terrain);
  // カメラが地面からどれだけ上まで降りられるか。見るものの大きさが
  // ゾーンごとに桁違いなので、ここもゾーンが決める
  diveCam.setClearance(zone.def.clearance ?? 0.9);
  diveCam.setRange(zone.def.range ?? 42);
  const e = zone.def.env;
  U.uFogColor.value.copy(e.fogColor);
  U.uFogDensity.value = e.fogDensity;
  U.uAmbTop.value.copy(e.ambTop);
  U.uAmbBottom.value.copy(e.ambBottom);
  U.uSunDir.value.copy(e.sunDir);
  // うねりの大きさもゾーンごと。既定は外洋なみ
  U.uSwell.value = e.swell ?? 1.0;
  // 太陽の色はゾーンごと。深海では限りなく黒に近く、太陽を掛けた項が全部消える
  U.uSunColor.value.copy(e.sunColor || DEFAULT_SUN);
  // ダイバーライト。lamp を持たないゾーンでは消灯したまま
  U.uLampI.value = e.lamp ? e.lamp.intensity : 0;
  if (e.lamp) {
    U.uLampColor.value.copy(e.lamp.color || DEFAULT_LAMP);
    U.uLampReach.value = e.lamp.reach ?? 26;
    U.uLampCos.value = Math.cos(e.lamp.angle ?? 0.42);
  }
  scene.fog.color.copy(e.fogColor);
  scene.fog.density = e.fogDensity;
  renderer.toneMappingExposure = e.exposure;
  lights.sun.position.copy(e.sunDir).multiplyScalar(60);
  lights.sun.color.copy(U.uSunColor.value);
  // 標準マテリアル用の半球光も、カスタムシェーダ側の環境光と同じ色にする。
  // ここを固定色のままにすると、深海でも岩や煙突だけ青く照らされてしまう
  lights.hemi.color.copy(e.ambTop);
  lights.hemi.groundColor.copy(e.ambBottom);

  // 環境音もゾーンのもの。深海は泡が消え、低いうなりだけが残る
  audio.setZone(key);

  diveCam.world = zone.world;
  diveCam.clearFollow();
  if (moveCamera) {
    diveCam.pos.copy(zone.def.camera.pos);
    diveCam.vel.set(0, 0, 0);
    diveCam.glide.set(0, 0, 0);
    diveCam.lookAt(zone.def.camera.look);
  }
  ui.setZone(zone.def);
  return zone;
}

// ================= ハッチをくぐる =================
const warp = new PortalWarp(camera, diveCam);
// ポータルエリアへ帰るときの色。行き先の水ではなく、施設の照明の色
const HUB_TINT = new THREE.Color('#7fa6c4');

/**
 * ゾーンへ「入る」。enterZone との違いは、切り替えを演出で包むこと。
 *
 * 切り替えそのものは覆いの下で一瞬に起きる。カメラを動かす仕事は
 * 演出側が持つので、enterZone には位置を触らせない
 */
function warpTo(key, portal) {
  if (warp.active) return;
  const swap = () => {
    const zone = enterZone(key, { moveCamera: false });
    warp.setArrival(zone.def.camera.pos, zone.def.camera.look, zone.def.clearance);
  };
  if (portal) warp.enter(portal.center, portal.normal, portal.tint, swap, audio);
  else warp.back(HUB_TINT, swap, audio);
}

// ================= UI =================
// 餌を落とす先を作るための作業用
const _feedAt = new THREE.Vector3();
const _fwd = new THREE.Vector3();

const ui = setupUI({
  zones: TANKS,
  onHub: () => warpTo(HUB.key, null),
  onFollow: (key) => {
    const t = active.followTargets[key];
    if (!t) return;
    // 群れの中心や決まった1匹を返す追跡先はそのままでよいが、
    // 「そのとき条件に合う個体」を返すものは、ここで1匹に決めさせる。
    // 決めずに毎フレーム選ばせると、条件が変わるたびに別の個体へ飛ぶ
    t.start?.();
    // 立ち位置を持つ追跡先は、そこへ移ってから追う。
    //
    // 追跡は距離を詰めて視線を向けるだけで、壁は抜けません。
    // プロテウスの部屋から潜水艦の札を押すと、耐圧殻を見つめたまま
    // 何も起きませんでした。対象と観客のあいだに建物があるゾーンは
    // ここだけなので、必要な札にだけ立ち位置を持たせてある
    if (t.from) {
      const q = t.from();
      if (q) { diveCam.pos.copy(q); diveCam.lookAt(t.get()); }
    }
    diveCam.setFollow(t.get, t.dist[0], t.dist[1]);
  },
  onFree: () => diveCam.clearFollow(),
  onZone: (key) => warpTo(key, active?.portals?.find((p) => p.key === key) || null),
  // ---- 餌やり ----
  // 撒く場所は「いま見ている先」。カメラの正面に固定距離で置くと、
  // 壁や氷の向こう側へ撒けてしまうので、視線の先にある面まで
  // 引き寄せてから落とす
  onFeed: () => {
    if (!active || !active.onFeed) return;
    // 5m。餌は数cmの生き物なので、遠くへ置くと点にしか見えない
    _feedAt.copy(camera.position).addScaledVector(_fwd.setFromMatrixColumn(camera.matrixWorld, 2).negate(), 5.0);
    active.onFeed(_feedAt);
  },
  audio,
});


// 最初に降り立つのはポータルエリア。ここから各水槽へ入っていく
enterZone(HUB.key);

// ?debug=1 のときだけ、外からカメラを置ける口を開ける。
// ヘッドレスの検証で「この位置からこの方向を見た絵」を撮るのに要る。
// マウスドラッグで代用すると、直したい一点を毎回同じ画角で撮れない。
if (new URLSearchParams(location.search).has('debug')) {
  window.__dive = diveCam;
  window.__three = THREE;
  window.__zone = () => active;
  // 検証から行き先を指定する口。以前はゾーンタブを click していたが、
  // タブそのものが無くなった。UI の形に依存しない口を用意しておく
  window.__go = (key) => enterZone(key);
  // 演出つきの入口。__go は切り替えだけなので、演出そのものを
  // 確かめるにはこちらが要る
  window.__warp = (key) => warpTo(key, active?.portals?.find((p) => p.key === key) || null);
  window.__warpState = () => ({ phase: warp.phase, t: warp.t });
  window.__zoneKey = () => (active ? active.def.key : null);
  window.__env = U;
  window.__scene = scene;
  // 検証用。撒いた餌が減っていくかを外から数える
  window.__feedCount = () => (active && active.feedLeft ? active.feedLeft() : -1);
}

// ================= タップ =================
let downPos = null;
let downTime = 0;
canvas.addEventListener('pointerdown', (e) => {
  downPos = [e.clientX, e.clientY];
  downTime = performance.now();
});
const _raycaster = new THREE.Raycaster();
const _hitPoint = new THREE.Vector3();

canvas.addEventListener('pointerup', (e) => {
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  const held = performance.now() - downTime;
  downPos = null;
  // タップ判定はゆるめに(指はわずかにぶれるし、ゆっくり離すこともある)
  if (e.button > 0 || moved > 12 || held > 600) return;
  // 吸い込まれている最中の入力は捨てる。ここで受けると、
  // 覆いの向こうで別のゾーンへ切り替わってしまう
  if (warp.active) return;

  const ndc = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  _raycaster.setFromCamera(ndc, camera);
  if (!active || !active.onTap) return;
  // ポータルは「タップされた行き先」を文字列で返してくる。
  // ほかのゾーンの onTap は何も返さない
  const dest = active.onTap(_raycaster.ray, _hitPoint);
  if (dest && ZONES.some((z) => z.key === dest)) {
    // 押されたハッチそのものへ吸い込む。「どれを押したか」と
    // 「どこへ吸い込まれるか」がずれていると、演出が嘘になる
    warpTo(dest, active.portals?.find((p) => p.key === dest) || null);
  }
});

// ================= リサイズ =================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.fov = fovFor(camera.aspect);
  camera.updateProjectionMatrix();
  // くぐっている最中に画面が回ったら、戻す先の画角も更新する。
  // 掴んだままにすると、着いたあと古い画角へ戻ってしまう
  warp.baseFov = camera.fov;
  renderer.setSize(window.innerWidth, window.innerHeight);
  scatter.setSize(renderer);
});

// ================= PWA: Service Worker =================
// ネットワーク優先のSW。ここでは登録と「開き直し・復帰のたびの更新チェック」、
// 新版が有効化されたときの自動リロードを行う。
if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // updateViaCache:'none' で sw.js 自体もHTTPキャッシュを介さず毎回確認
      const reg = await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
      const check = () => reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check(); // タブ復帰のたびに更新確認
      });
      // 新しいSWが制御を握ったら一度だけリロードして最新版へ
      let hadController = !!navigator.serviceWorker.controller;
      let refreshed = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) { hadController = true; return; } // 初回インストールは除外
        if (refreshed) return;
        refreshed = true;
        window.location.reload();
      });
    } catch (e) {
      // SW非対応・登録失敗でもアプリはそのまま動く
    }
  });
}

// ================= メインループ =================
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  U.uTime.value = clock.elapsedTime;
  lights.sun.intensity = 1.6 * U.uSunI.value;
  lights.hemi.intensity = 0.9 * (0.6 + 0.4 * U.uSunI.value);
  active.update(dt, camera);
  // 吸い込まれているあいだ、カメラは演出が持つ。自由カメラを
  // 同時に走らせると、地形クランプと押し出しが毎フレーム引き戻して
  // ハッチをくぐれない
  if (warp.active) warp.update(dt);
  else diveCam.update(dt);
  // ダイバーライトは頭に付いているので、カメラを動かした「後」に追従させる。
  // 先に更新すると、振り向いたとき光が1フレーム遅れてついてくる
  if (U.uLampI.value > 0) {
    U.uLampPos.value.copy(camera.position);
    camera.getWorldDirection(U.uLampDir.value);
  }
  // 頭が水面から出ると、こもった水中音から水面のさざめきへ入れ替わる
  const above = THREE.MathUtils.smoothstep(camera.position.y, U.uSurfaceY.value - 0.2, U.uSurfaceY.value + 0.8);
  audio.setAbove(above);

  // 水上へ出たら散乱によるぼけも消す。目と空のあいだに水がないので、
  // 同じ距離でも遠景は硬いまま見える
  scatter.render(renderer, scene, camera, U.uFogDensity.value, 1 - above * 0.92);
  ui.tickFPS(dt);
}

animate();
