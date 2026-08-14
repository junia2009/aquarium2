import * as THREE from 'three';
import { createWaterSurface } from '../environment/surface.js';
import { createSand, createRocks, sandHeight, reefTerrain } from '../environment/seabed.js';
import { createKelp, createAnemone, KELP_CLUSTERS } from '../environment/flora.js';
import { createGodRays, createBubbles, createMarineSnow } from '../environment/effects.js';
import { CollisionWorld } from '../collision.js';
import { disturbPoint } from '../interaction.js';

import { FISH_SHAPES } from '../creatures/fishGeometry.js';
import { createFishMaterial } from '../creatures/fishMaterial.js';
import { School, makeSchoolInstanceAttr } from '../creatures/school.js';
import { Wanderer } from '../creatures/wanderer.js';
import { EagleRay } from '../creatures/ray.js';
import { SeaTurtle } from '../creatures/turtle.js';
import { JellyfishSwarm } from '../creatures/jellyfish.js';
import { GardenEelColony } from '../creatures/gardenEel.js';
import { WhaleShark, HumpbackWhale } from '../creatures/giants.js';
import { GREAT_TANK_SPECIES } from '../species.js';

// ============ 大水槽ゾーン ============
// サンゴ礁の岩場を中心に、外洋の大型回遊魚までが同居する水槽。
export const GREAT_TANK = {
  key: 'greatTank',
  name: '大水槽',
  sub: 'GRAND TANK',
  icon: '🐟',
  terrain: reefTerrain,
  env: {
    fogColor: new THREE.Color('#0b3a58'),
    fogDensity: 0.024,
    ambTop: new THREE.Color('#3b87a8'),
    ambBottom: new THREE.Color('#07222f'),
    sunDir: new THREE.Vector3(0.28, 0.9, 0.16).normalize(),
    exposure: 1.08,
  },
  camera: { pos: new THREE.Vector3(0, 7.5, 24), look: new THREE.Vector3(0, 7, 0) },
  tap: 'クリック: 魚が驚く',
  species: GREAT_TANK_SPECIES,

  build(root, audio) {
    createWaterSurface(root);
    createSand(root);
    const rocks = createRocks(root);
    createKelp(root);
    const anemonePos = new THREE.Vector3(12.5, 0, -12.5);
    createAnemone(root, anemonePos);

    // --- 衝突ワールド ---
    // 岩とイソギンチャクは実体のある障害物、海藻はしなるので
    // 「避けるが押し戻さない」やわらかい障害物として登録する。
    const world = new CollisionWorld();
    for (const c of rocks.colliders) world.addStatic(c.center, c.rx, c.ry, c.rz);
    for (const k of KELP_CLUSTERS) {
      const base = sandHeight(k.x, k.z);
      world.addStatic(new THREE.Vector3(k.x, base + 3.6, k.z), k.r + 0.6, 4.2, k.r + 0.6, { soft: true });
    }
    world.addStatic(
      new THREE.Vector3(anemonePos.x, sandHeight(anemonePos.x, anemonePos.z) + 0.7, anemonePos.z),
      1.9, 1.4, 1.9
    );

    const godRays = createGodRays(root);
    createBubbles(root, [
      { x: -13.5, y: sandHeight(-13.5, -7) + 0.5, z: -7, count: 170, radius: 0.9 },
      { x: 14.5, y: sandHeight(14.5, -11) + 0.4, z: -11, count: 110, radius: 0.6 },
    ]);
    createMarineSnow(root);

    // --- マイワシの群れ(ボイド) ---
    const sardineGeo = FISH_SHAPES.sardine();
    sardineGeo.scale(0.55, 0.55, 0.55);
    const SARDINE_N = 180;
    const sardineMesh = new THREE.InstancedMesh(
      sardineGeo,
      createFishMaterial({
        pattern: 0, len: 0.55,
        swim: { freq: 11, amp: 0.09, waveNum: 1.1, headAmp: 0.12, flapFreq: 6 },
      }),
      SARDINE_N
    );
    sardineMesh.frustumCulled = false;
    makeSchoolInstanceAttr(sardineGeo, SARDINE_N, [0.8, 1.15]);
    root.add(sardineMesh);
    const sardines = new School({
      mesh: sardineMesh, count: SARDINE_N,
      center: new THREE.Vector3(0, 9.5, 0), homeRadius: 19, seed: 1,
      params: { maxSpeed: 6.0, minSpeed: 2.4, perception: 2.4, bodyRadius: 0.22, avoidRange: 1.2 },
    });

    // --- ナンヨウハギの小さな群れ ---
    const tangGeo = FISH_SHAPES.tang();
    tangGeo.scale(0.72, 0.72, 0.72);
    const TANG_N = 7;
    const tangMesh = new THREE.InstancedMesh(
      tangGeo,
      createFishMaterial({
        pattern: 2, len: 0.72,
        swim: { freq: 4.5, amp: 0.035, waveNum: 0.55, headAmp: 0.06, flapFreq: 7.5 },
      }),
      TANG_N
    );
    tangMesh.frustumCulled = false;
    makeSchoolInstanceAttr(tangGeo, TANG_N, [0.85, 1.1]);
    root.add(tangMesh);
    const tangs = new School({
      mesh: tangMesh, count: TANG_N,
      center: new THREE.Vector3(10, 5, -10), homeRadius: 9, seed: 5,
      params: {
        maxSpeed: 2.6, minSpeed: 0.9, perception: 3.0,
        wCoh: 0.5, wAli: 0.6, maxForce: 8, yMin: 1.8, yMax: 9, burstSpeed: 6,
        bodyRadius: 0.30, avoidRange: 1.3,
      },
    });

    // --- カクレクマノミのペア(イソギンチャクに定住) ---
    const clownGeo = FISH_SHAPES.clownfish();
    clownGeo.scale(0.42, 0.42, 0.42);
    const clownMesh = new THREE.InstancedMesh(
      clownGeo,
      createFishMaterial({
        pattern: 1, len: 0.42,
        swim: { freq: 10, amp: 0.09, waveNum: 0.7, headAmp: 0.3, flapFreq: 9 },
      }),
      2
    );
    clownMesh.frustumCulled = false;
    makeSchoolInstanceAttr(clownGeo, 2, [0.8, 1.05]);
    root.add(clownMesh);
    const clowns = new Wanderer({
      mesh: clownMesh, count: 2,
      home: anemonePos.clone().add(new THREE.Vector3(0, sandHeight(anemonePos.x, anemonePos.z) + 1.4, 0)),
      radius: 2.6, speed: [0.5, 2.0], retarget: [0.8, 2.4],
    });

    // --- 大型遊泳者たち ---
    const ray = new EagleRay(root);
    const turtle = new SeaTurtle(root);
    const whaleShark = new WhaleShark(root);
    const whale = new HumpbackWhale(root);
    const jellies = new JellyfishSwarm(root, 6);
    const eels = new GardenEelColony(root, {
      center: new THREE.Vector3(4, 0, 13), radius: 6.5, count: 14,
    });

    // 大型生物同士もぶつからないよう、動く障害物として登録する。
    // 細長い生物は oriented を付けて、当たり判定を体の向きに追従させる
    // (軸平行のままだと、泳ぐ向きによって前後がはみ出したり横が
    //  太くなったりして、めり込みとすり抜けの両方が起きる)。
    world.addDynamic(whaleShark, 1.9, 1.7, 7.4, { oriented: true });
    world.addDynamic(whale, 1.62, 2.15, 8.4, { oriented: true });
    world.addDynamic(ray, 2.6, 0.9, 2.2);
    world.addDynamic(turtle, 1.7, 0.9, 1.8);
    for (const c of [whaleShark, whale, ray, turtle, jellies]) c.setWorld(world);

    // クジラの息継ぎで鳴き声(環境音ON時のみ)
    whale.onBlow = () => audio.whaleCall();

    const eelSpot = new THREE.Vector3(4, sandHeight(4, 13) + 2.2, 13);

    return {
      world,
      // 追跡対象と、生物の大きさに応じた追跡距離 [近, 遠]
      followTargets: {
        whaleshark: { get: () => whaleShark.pos, dist: [13, 30] },
        whale: { get: () => whale.pos, dist: [16, 34] },
        sardine: { get: () => sardines.schoolCenter, dist: [6, 16] },
        tang: { get: () => tangs.schoolCenter, dist: [4, 10] },
        clownfish: { get: () => clowns.center, dist: [2.5, 7] },
        ray: { get: () => ray.pos, dist: [5, 14] },
        turtle: { get: () => turtle.pos, dist: [5, 13] },
        jelly: { get: () => jellies.center, dist: [4, 11] },
        eel: { get: () => eelSpot, dist: [4, 11] },
      },

      update(dt, camera) {
        const predators = [
          { pos: ray.pos, radius: 4.5 },
          { pos: turtle.pos, radius: 4.0 },
          { pos: whaleShark.pos, radius: 8.5 },
          { pos: whale.pos, radius: 9.5 },
        ];
        sardines.update(dt, predators, world);
        tangs.update(dt, predators, world);
        clowns.update(dt);
        ray.update(dt);
        turtle.update(dt);
        whaleShark.update(dt);
        whale.update(dt);
        jellies.update(dt);
        eels.update(dt, [
          { pos: ray.pos, radius: 8 },
          { pos: turtle.pos, radius: 7 },
          { pos: whaleShark.pos, radius: 13 },
          { pos: whale.pos, radius: 15 },
          { pos: camera.position, radius: 6 },
        ]);
        godRays.update(camera);
      },

      // タップに反応するのはイワシの群れのみ
      onTap(ray3, hit) {
        if (disturbPoint(ray3, sardines, 4.5, hit)) sardines.scare(hit, 11, 80);
      },
    };
  },
};
