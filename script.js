/* ==========================================================================
   提瓦特 · 3D 探索框架  |  script.js
   依赖：three r158 + MMDLoader（本地 vendor，ES Module）
   角色：冰之女皇 Anastasya / 雷泽（PMX 模型），敌人：verity（Q 弹怪）
   结构：配置 → 舞台 → 世界 → 角色 → 敌人 → 特效 → 输入 → 战斗 → 主循环
   ========================================================================== */
import * as THREE from 'three';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

(function () {
  'use strict';

  /* =========================================================
     0. 配置
     ========================================================= */
  const CFG = {
    walkSpeed: 5.6,
    sprintSpeed: 9.4,
    jumpPower: 7.4,
    gravity: 18,
    camDist: 6.8,
    camMinDist: 3.6,
    camMaxDist: 12.5,
    attackRange: 3.2,
    attackArc: 0.32,
    attackCd: 0.46,
    skillCd: 6,
    energyMax: 100,
    energyPerHit: 12,
    energyPerSkill: 14,
    energyRegen: 1.2,
    staminaMax: 100,
    staminaDrain: 20,
    staminaRegen: 16,
  };

  const ELEMENTS = {
    anemo:   { name: '风', color: 0x6fc9bd, deep: 0x2f8f86, hair: 0xcfeee8, css: '#6fc9bd', glow: '#a9f0e4' },
    geo:     { name: '岩', color: 0xe8b34a, deep: 0x9b6f1c, hair: 0x6d5636, css: '#e8b34a', glow: '#ffe2a0' },
    electro: { name: '雷', color: 0xb488e0, deep: 0x6c46a8, hair: 0xd9c6f5, css: '#b488e0', glow: '#e0c8ff' },
    cryo:    { name: '冰', color: 0x8fd6ee, deep: 0x3c87a8, hair: 0xdff5ff, css: '#8fd6ee', glow: '#d6f6ff' },
  };

  const PARTY = [
    { id: 0, name: '冰之女皇', element: 'cryo', maxHp: 1320, model: 'anastasya', modelHeight: 1.82 },
    { id: 1, name: '雷泽', element: 'electro', maxHp: 1180, model: 'razor', modelHeight: 1.76 },
  ];

  const SPAWN = { x: 0, z: 5.5 };

  /* =========================================================
     1. 小工具
     ========================================================= */
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
  const rand = (a, b) => a + Math.random() * (b - a);
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };
  // 角度插值（走最短路径）
  function dampAngle(cur, target, lambda, dt) {
    let d = ((target - cur + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    return cur + d * (1 - Math.exp(-lambda * dt));
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rng = mulberry32(20261123);

  /* =========================================================
     2. 地形高度（全场景共用同一个函数，保证角色贴地）
     ========================================================= */
  const PLATEAU = 1.55;
  function groundHeight(x, z) {
    const base =
      Math.sin(x * 0.085) * 1.45 +
      Math.cos(z * 0.1) * 1.25 +
      Math.sin((x + z) * 0.037) * 2.0 +
      Math.cos(x * 0.021 - z * 0.031) * 1.0;
    const d = Math.hypot(x, z);
    const k = smoothstep(9, 20, d);       // 出生点附近压平成一块小场地
    return base * k + PLATEAU * (1 - k);
  }

  /* =========================================================
     3. 舞台
     ========================================================= */
  const stageEl = document.getElementById('stage');
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.02;
  stageEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd5e7df, 46, 132);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 320);
  camera.position.set(0, 12, 24);
  const cameraRay = new THREE.Raycaster();

  /* ---------- 天空穹顶 ---------- */
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x7db4de) },
      midColor: { value: new THREE.Color(0xd6e9e6) },
      botColor: { value: new THREE.Color(0xf5eed9) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor; uniform vec3 midColor; uniform vec3 botColor;
      varying vec3 vPos;
      void main() {
        float h = clamp(normalize(vPos).y * 0.5 + 0.5, 0.0, 1.0);
        vec3 col = mix(botColor, midColor, smoothstep(0.0, 0.52, h));
        col = mix(col, topColor, smoothstep(0.46, 1.0, h));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(210, 32, 20), skyMat));

  /* ---------- 灯光 ---------- */
  const hemi = new THREE.HemisphereLight(0xdff0ff, 0x5d6d47, 0.85);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff1d3, 2.35);
  sun.position.set(26, 38, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 160;
  sun.shadow.camera.left = -44;
  sun.shadow.camera.right = 44;
  sun.shadow.camera.top = 44;
  sun.shadow.camera.bottom = -44;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(0xbfe0ff, 0.55);
  fill.position.set(-24, 16, -20);
  scene.add(fill);

  /* =========================================================
     4. 构建世界
     ========================================================= */
  const world = new THREE.Group();
  scene.add(world);

  // 相机射线只检测这些「会挡人」的实体（树 / 石 / 柱），命中就把相机拉近
  const occluders = [];

  /* ---------- 程序化草地细节纹理（只做明暗斑纹，主色仍由顶点色决定） ---------- */
  function makeGrassTexture() {
    const size = 256;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f2f2ee';
    ctx.fillRect(0, 0, size, size);
    // 大块明暗
    for (let i = 0; i < 26; i++) {
      const x = rng() * size, y = rng() * size, r = 14 + rng() * 46;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const dark = rng() > 0.55;
      g.addColorStop(0, dark ? 'rgba(190,196,176,.75)' : 'rgba(255,255,250,.72)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // 细草线
    for (let i = 0; i < 900; i++) {
      const x = rng() * size, y = rng() * size;
      ctx.strokeStyle = rng() > 0.5 ? 'rgba(206,214,186,.55)' : 'rgba(255,255,244,.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rng() - 0.5) * 3, y - 2 - rng() * 5);
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(30, 30);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }

  /* ---------- 地面 ---------- */
  (function buildTerrain() {
    const seg = 128, size = 180;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cLow = new THREE.Color(0x5f8b3c);
    const cMid = new THREE.Color(0x8cab5e);
    const cHigh = new THREE.Color(0xb4bf7c);
    const cStone = new THREE.Color(0xb6b4a4);
    const tmp = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = groundHeight(x, z);
      pos.setY(i, h);

      const flat = 1 - smoothstep(9, 20, Math.hypot(x, z)); // 出生地
      // 出生点 → 拱门的小径（自然蜿蜒）
      const pathX = Math.sin(z * 0.18) * 1.5;
      const pathD = Math.abs(x - pathX);
      const onPath = z < 4 && z > -30 ? Math.max(0, 1 - pathD / 1.9) : 0;
      tmp.copy(cLow).lerp(cMid, smoothstep(-1.0, 3.2, h));
      tmp.lerp(cHigh, smoothstep(2.8, 5.5, h) * 0.6);
      tmp.lerp(cStone, smoothstep(4.4, 6.2, h) * 0.55);
      if (flat > 0.5) tmp.lerp(new THREE.Color(0xa8bd6a), 0.18);
      if (onPath > 0) tmp.lerp(new THREE.Color(0xbb9d70), onPath * 0.55);
      const n = (rng() - 0.5) * 0.035;
      colors[i * 3] = clamp(tmp.r + n, 0, 1);
      colors[i * 3 + 1] = clamp(tmp.g + n, 0, 1);
      colors[i * 3 + 2] = clamp(tmp.b + n, 0, 1);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0,
      map: makeGrassTexture(),
    });
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    world.add(ground);
  })();

  /* ---------- 空气光尘（氛围） ---------- */
  (function buildMotes() {
    const N = 280;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const a = rng() * Math.PI * 2;
      const r = 6 + Math.pow(rng(), 0.7) * 34;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      pos[i * 3] = x;
      pos[i * 3 + 1] = groundHeight(x, z) + 0.5 + rng() * 6.5;
      pos[i * 3 + 2] = z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xfff6d8, size: 0.11, transparent: true, opacity: 0.7,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    world.add(pts);
  })();

  /* ---------- 树 / 石头 ---------- */
  const matTrunk = new THREE.MeshStandardMaterial({ color: 0x7a5b3c, roughness: 0.95, flatShading: true });
  const matLeafA = new THREE.MeshStandardMaterial({ color: 0x4f8a4a, roughness: 0.9, flatShading: true });
  const matLeafB = new THREE.MeshStandardMaterial({ color: 0x6ba559, roughness: 0.9, flatShading: true });
  const matLeafC = new THREE.MeshStandardMaterial({ color: 0x3f7b44, roughness: 0.9, flatShading: true });
  const matMoss = new THREE.MeshStandardMaterial({ color: 0x5f8547, roughness: 0.95, flatShading: true });
  const matRock = new THREE.MeshStandardMaterial({ color: 0x9a9c93, roughness: 0.95, flatShading: true });
  const matRockDark = new THREE.MeshStandardMaterial({ color: 0x8d9187, roughness: 0.95, flatShading: true });

  const geoTrunk = new THREE.CylinderGeometry(0.16, 0.26, 1.7, 6);
  const geoLeaf1 = new THREE.ConeGeometry(1.15, 2.2, 7);
  const geoLeaf2 = new THREE.ConeGeometry(0.9, 1.8, 7);
  const geoLeaf3 = new THREE.ConeGeometry(0.62, 1.3, 7);
  const geoRock = new THREE.IcosahedronGeometry(1, 1);

  const LEAF_MATS = [matLeafA, matLeafB, matLeafC];
  function spawnTree(x, z, s) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(geoTrunk, matTrunk);
    trunk.position.y = 0.85;
    const leafA = LEAF_MATS[Math.floor(rng() * LEAF_MATS.length)];
    const leafB = LEAF_MATS[Math.floor(rng() * LEAF_MATS.length)];
    const l1 = new THREE.Mesh(geoLeaf1, leafA); l1.position.y = 2.3;
    const l2 = new THREE.Mesh(geoLeaf2, leafB); l2.position.y = 3.3;
    const l3 = new THREE.Mesh(geoLeaf3, leafA); l3.position.y = 4.05;
    const l4 = new THREE.Mesh(geoLeaf3, leafB);
    l4.scale.setScalar(0.62); l4.position.y = 4.72;
    l1.rotation.y = rng() * 3; l2.rotation.y = rng() * 3; l3.rotation.y = rng() * 3;
    g.add(trunk, l1, l2, l3, l4);
    g.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; occluders.push(m); } });
    g.position.set(x, groundHeight(x, z) - 0.1, z);
    g.scale.setScalar(s);
    g.rotation.y = rng() * Math.PI * 2;
    world.add(g);
  }

  for (let i = 0; i < 64; i++) {
    const a = rng() * Math.PI * 2;
    const r = 11 + Math.pow(rng(), 0.7) * 63;
    spawnTree(Math.cos(a) * r, Math.sin(a) * r, 0.85 + rng() * 0.95);
  }

  for (let i = 0; i < 34; i++) {
    const a = rng() * Math.PI * 2;
    const r = 9 + rng() * 66;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rock = new THREE.Mesh(geoRock, rng() > 0.45 ? matRock : matRockDark);
    const s = 0.5 + rng() * 1.6;
    rock.scale.set(s * rand(0.8, 1.4), s * rand(0.6, 1.1), s * rand(0.8, 1.4));
    rock.position.set(x, groundHeight(x, z) - 0.15, z);
    rock.rotation.set(rng() * 3, rng() * 3, rng() * 3);
    rock.castShadow = true; rock.receiveShadow = true;
    world.add(rock);
    occluders.push(rock);
    // 部分石头顶上长苔
    if (rng() > 0.55) {
      const moss = new THREE.Mesh(
        new THREE.SphereGeometry(1, 7, 4, 0, Math.PI * 2, 0, Math.PI * 0.5), matMoss
      );
      moss.scale.set(s * 0.62, s * 0.17, s * 0.62);
      moss.position.set(x, groundHeight(x, z) - 0.15 + s * 0.78, z);
      moss.receiveShadow = true;
      world.add(moss);
    }
  }

  /* ---------- 草簇（实例化，几百丛不会掉帧） ---------- */
  (function buildGrassTufts() {
    const count = 620;
    const geo = new THREE.ConeGeometry(0.13, 0.68, 4, 1, true);
    geo.translate(0, 0.34, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide, flatShading: true,
    });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    let cx = 0, cz = 0;
    for (let i = 0; i < count; i++) {
      if (i % 4 === 0) {   // 每 4 丛聚成一小簇
        const a = rng() * Math.PI * 2;
        const r = 7.5 + Math.pow(rng(), 0.62) * 52;
        cx = Math.cos(a) * r; cz = Math.sin(a) * r;
      }
      const x = cx + rand(-1.5, 1.5), z = cz + rand(-1.5, 1.5);
      dummy.position.set(x, groundHeight(x, z) - 0.02, z);
      dummy.rotation.set(rand(-0.14, 0.14), rng() * Math.PI * 2, rand(-0.14, 0.14));
      dummy.scale.set(rand(0.7, 1.5), rand(0.7, 1.6), rand(0.7, 1.5));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      col.setHSL(0.235 + rng() * 0.075, 0.42 + rng() * 0.22, 0.33 + rng() * 0.17);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    world.add(mesh);
  })();

  /* ---------- 小花点缀 ---------- */
  (function buildFlowers() {
    const count = 150;
    const geo = new THREE.IcosahedronGeometry(0.085, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, flatShading: true });
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    const col = new THREE.Color();
    const palette = [0xfff4d6, 0xffe28f, 0xffc0d0, 0xd6ecff, 0xf6f0ff];
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = 9 + Math.pow(rng(), 0.7) * 62;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      dummy.position.set(x, groundHeight(x, z) + 0.16 + rng() * 0.12, z);
      dummy.scale.setScalar(rand(0.7, 1.5));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      col.setHex(palette[Math.floor(rng() * palette.length)]);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    world.add(mesh);
  })();

  /* ---------- 远景树带（只做剪影，不投影，撑出纵深） ---------- */
  (function buildFarTrees() {
    const matFarTree = new THREE.MeshStandardMaterial({ color: 0x6f8d63, roughness: 1, flatShading: true });
    const geoFar = new THREE.ConeGeometry(1, 3.2, 5);
    const geoFar2 = new THREE.ConeGeometry(0.62, 2.2, 5);
    for (let i = 0; i < 90; i++) {
      const a = rng() * Math.PI * 2;
      const r = 72 + rng() * 16;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const g = new THREE.Group();
      const l1 = new THREE.Mesh(geoFar, matFarTree); l1.position.y = 2.2;
      const l2 = new THREE.Mesh(geoFar2, matFarTree); l2.position.y = 3.7;
      g.add(l1, l2);
      g.position.set(x, groundHeight(x, z) - 0.35, z);
      g.scale.setScalar(1.1 + rng() * 1.4);
      g.rotation.y = rng() * 3;
      world.add(g);
    }
  })();

  /* ---------- 低模云团 ---------- */
  (function buildClouds() {
    const geoCloud = new THREE.IcosahedronGeometry(1, 1);
    const matCloud = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 1, flatShading: true, transparent: true, opacity: 0.93,
    });
    for (let i = 0; i < 10; i++) {
      const g = new THREE.Group();
      const puffs = 4 + Math.floor(rng() * 4);
      for (let p = 0; p < puffs; p++) {
        const puff = new THREE.Mesh(geoCloud, matCloud);
        puff.position.set(rand(-5, 5), rand(-0.6, 1.0), rand(-3, 3));
        puff.scale.set(rand(1.3, 2.5), rand(0.7, 1.25), rand(1.2, 2.2));
        puff.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        g.add(puff);
      }
      const a = rng() * Math.PI * 2, r = 46 + rng() * 40;
      g.position.set(Math.cos(a) * r, 9 + rng() * 13, Math.sin(a) * r);
      g.scale.setScalar(2.4 + rng() * 2.6);
      world.add(g);
    }
  })();

  /* ---------- 程序化石砖纹理 ---------- */
  function makeStoneTexture() {
    const size = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#8f8672';
    ctx.fillRect(0, 0, size, size);
    const bw = 32, bh = 16;
    for (let row = 0; row < size / bh; row++) {
      const offset = (row % 2) * (bw / 2);
      for (let col = -1; col < size / bw + 1; col++) {
        const x = col * bw + offset, y = row * bh;
        const shade = 186 + Math.floor(rng() * 26);
        ctx.fillStyle = `rgb(${shade},${shade - 5},${shade - 20})`;
        ctx.fillRect(x + 1, y + 1, bw - 2, bh - 2);
      }
    }
    // 噪点
    for (let i = 0; i < 500; i++) {
      ctx.fillStyle = `rgba(120,110,92,${0.05 + rng() * 0.07})`;
      ctx.fillRect(rng() * size, rng() * size, 1, 1);
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(7, 7);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /* ---------- 出生点石砖广场 ---------- */
  (function buildPlaza() {
    const y = PLATEAU + 0.02;
    const stoneTex = makeStoneTexture();
    const matPlaza = new THREE.MeshStandardMaterial({ color: 0xffffff, map: stoneTex, roughness: 0.9 });
    const matPlazaInner = new THREE.MeshStandardMaterial({ color: 0xffffff, map: stoneTex, roughness: 0.88 });
    const disc = new THREE.Mesh(new THREE.CircleGeometry(5.1, 36), matPlaza);
    disc.rotation.x = -Math.PI / 2;
    disc.position.y = y;
    disc.receiveShadow = true;
    world.add(disc);

    const inner = new THREE.Mesh(new THREE.CircleGeometry(2.9, 28), matPlazaInner);
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = y + 0.012;
    inner.receiveShadow = true;
    world.add(inner);

    // 中心纹样：八瓣菱形
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const petal = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 1.5), matPlaza);
      petal.rotation.x = -Math.PI / 2;
      petal.rotation.z = a;
      petal.position.set(Math.cos(a) * 1.05, y + 0.02, Math.sin(a) * 1.05);
      world.add(petal);
    }
    // 外环石带
    const ring = new THREE.Mesh(new THREE.RingGeometry(5.1, 5.6, 36), matPlaza);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = y + 0.004;
    ring.receiveShadow = true;
    world.add(ring);
  })();

  /* ---------- 遗迹石柱 + 拱门（远景地标） ---------- */
  const matStone = new THREE.MeshStandardMaterial({ color: 0xcdc6b0, roughness: 0.85, flatShading: true });
  const matStoneDark = new THREE.MeshStandardMaterial({ color: 0xa9a390, roughness: 0.9, flatShading: true });

  (function buildRuins() {
    const ringR = 19;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.22;
      const x = Math.cos(a) * ringR, z = Math.sin(a) * ringR;
      const h = 2.4 + rng() * 3.4;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, h, 8), matStone);
      pillar.position.set(x, groundHeight(x, z) + h / 2 - 0.2, z);
      pillar.rotation.y = rng();
      pillar.castShadow = true; pillar.receiveShadow = true;
      world.add(pillar);
      occluders.push(pillar);
      if (rng() > 0.5) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.28, 1.6), matStoneDark);
        cap.position.set(x, groundHeight(x, z) + h - 0.2, z);
        cap.rotation.y = pillar.rotation.y;
        cap.castShadow = true;
        world.add(cap);
      }
    }

    // 拱门
    const ax = 0, az = -26;
    const baseY = groundHeight(ax, az);
    const legGeo = new THREE.BoxGeometry(1.1, 6.4, 1.1);
    [-2.6, 2.6].forEach((off) => {
      const leg = new THREE.Mesh(legGeo, matStone);
      leg.position.set(ax + off, baseY + 3.0, az);
      leg.castShadow = true; leg.receiveShadow = true;
      world.add(leg);
      occluders.push(leg);
    });
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.85, 1.4), matStoneDark);
    lintel.position.set(ax, baseY + 6.5, az);
    lintel.castShadow = true;
    world.add(lintel);

    const crest = new THREE.Mesh(new THREE.OctahedronGeometry(0.7, 0), matStone);
    crest.position.set(ax, baseY + 7.3, az);
    crest.rotation.z = Math.PI / 4;
    crest.castShadow = true;
    world.add(crest);
  })();

  /* ---------- 远山 ---------- */
  (function buildMountains() {
    const matNear = new THREE.MeshStandardMaterial({ color: 0x7c978b, roughness: 1, flatShading: true });
    const matFar = new THREE.MeshStandardMaterial({ color: 0x9db2a7, roughness: 1, flatShading: true });
    // 近层：成组的双锥山脊，宽窄不一
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + rng() * 0.28;
      const r = 86 + rng() * 26;
      const h = 11 + rng() * 16;
      const g = new THREE.Group();
      const main = new THREE.Mesh(new THREE.ConeGeometry(7 + rng() * 7, h, 5), matNear);
      main.position.y = h / 2 - 3;
      main.rotation.y = rng() * 3;
      main.scale.set(rand(0.9, 1.35), 1, rand(0.8, 1.2));
      const side = new THREE.Mesh(new THREE.ConeGeometry(5 + rng() * 5, h * rand(0.55, 0.8), 5), matNear);
      side.position.set(rand(-7, 7), side.geometry.parameters.height / 2 - 2.2, rand(-6, 6));
      side.rotation.y = rng() * 3;
      g.add(main, side);
      g.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      world.add(g);
    }
    // 远层：更淡的剪影，被雾接住
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + rng() * 0.2;
      const r = 128 + rng() * 24;
      const h = 26 + rng() * 32;
      const cone = new THREE.Mesh(new THREE.ConeGeometry(12 + rng() * 10, h, 5), matFar);
      cone.position.set(Math.cos(a) * r, h / 2 - 6, Math.sin(a) * r);
      cone.rotation.y = rng() * 3;
      cone.scale.set(rand(1.0, 1.5), 1, rand(0.9, 1.3));
      world.add(cone);
    }
  })();

  /* ---------- 浮空岛 ---------- */
  const floaters3D = [];
  (function buildFloatingIslands() {
    for (let i = 0; i < 4; i++) {
      const a = 0.9 + i * 1.35 + rng() * 0.4;
      const r = 52 + rng() * 24;
      const g = new THREE.Group();
      const rockMat = new THREE.MeshStandardMaterial({ color: 0x8b8578, roughness: 1, flatShading: true });
      const grassMat = new THREE.MeshStandardMaterial({ color: 0x79a253, roughness: 1, flatShading: true });

      const body = new THREE.Mesh(new THREE.CylinderGeometry(4, 0.9, 4.6, 7), rockMat);
      body.position.y = -2.3;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(4.05, 4.05, 0.5, 7), grassMat);
      top.position.y = 0.1;

      g.add(body, top);
      for (let t = 0; t < 2; t++) {
        const tree = new THREE.Group();
        const tk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.16, 1.1, 5), matTrunk);
        tk.position.y = 0.55;
        const lf = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.5, 6), matLeafA);
        lf.position.y = 1.5;
        tree.add(tk, lf);
        tree.position.set(rand(-2.4, 2.4), 0.35, rand(-2.4, 2.4));
        tree.scale.setScalar(0.9);
        g.add(tree);
      }
      g.traverse((m) => { if (m.isMesh) m.castShadow = true; });
      g.position.set(Math.cos(a) * r, 33 + rng() * 11, Math.sin(a) * r);
      g.userData.baseY = g.position.y;
      g.userData.phase = rng() * Math.PI * 2;
      world.add(g);
      floaters3D.push(g);
    }
  })();

  /* =========================================================
     5. 角色
     ========================================================= */
  function createCharacter(elementKey) {
    const el = ELEMENTS[elementKey];
    const root = new THREE.Group();

    const matSkin = new THREE.MeshStandardMaterial({ color: 0xf6d8c3, roughness: 0.85 });
    const matCloth = new THREE.MeshStandardMaterial({ color: el.color, roughness: 0.68, metalness: 0.06 });
    const matClothDark = new THREE.MeshStandardMaterial({ color: el.deep, roughness: 0.78, metalness: 0.05 });
    const matHair = new THREE.MeshStandardMaterial({ color: el.hair, roughness: 0.5, metalness: 0.12 });
    const matGold = new THREE.MeshStandardMaterial({ color: 0xc9a86a, roughness: 0.42, metalness: 0.6 });
    const matWhite = new THREE.MeshStandardMaterial({ color: 0xf7f2e6, roughness: 0.8 });
    const matSteel = new THREE.MeshStandardMaterial({ color: 0xd7e4ec, roughness: 0.3, metalness: 0.8 });
    const matEye = new THREE.MeshStandardMaterial({ color: 0x4a3f33, roughness: 0.4 });

    /* ---- 腿 ---- */
    const legGeo = new THREE.CapsuleGeometry(0.105, 0.42, 4, 10);
    const footGeo = new THREE.BoxGeometry(0.2, 0.12, 0.32);
    const legL = new THREE.Group(), legR = new THREE.Group();
    legL.position.set(-0.135, 0.92, 0);
    legR.position.set(0.135, 0.92, 0);
    root.add(legL, legR);

    [legL, legR].forEach((pivot) => {
      const leg = new THREE.Mesh(legGeo, matClothDark);
      leg.position.y = -0.27;
      const foot = new THREE.Mesh(footGeo, matWhite);
      foot.position.set(0, -0.5, 0.06);
      pivot.add(leg, foot);
    });

    /* ---- 身体 ---- */
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.235, 0.42, 6, 14), matWhite);
    torso.position.y = 1.26;
    torso.scale.set(1.06, 1, 0.82);
    root.add(torso);

    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.46, 0.44, 16, 1, true),
      matCloth
    );
    skirt.position.y = 0.96;
    skirt.material.side = THREE.DoubleSide;
    root.add(skirt);

    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.045, 8, 20), matGold);
    belt.position.y = 1.06;
    belt.rotation.x = Math.PI / 2;
    root.add(belt);

    const emblem = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), matGold);
    emblem.position.set(0, 1.36, 0.2);
    emblem.rotation.z = Math.PI / 4;
    root.add(emblem);

    const cape = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.8), matCloth);
    cape.position.set(0, 1.05, -0.24);
    cape.rotation.x = -0.28;
    cape.material.side = THREE.DoubleSide;
    root.add(cape);

    /* ---- 头 ---- */
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.31, 20, 16), matSkin);
    head.position.y = 1.8;
    head.scale.set(0.96, 1.02, 0.94);
    root.add(head);

    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.335, 18, 14), matHair);
    hairCap.position.set(0, 1.85, -0.035);
    hairCap.scale.set(1.0, 0.98, 1.02);
    root.add(hairCap);

    // 前刘海
    const bangGeo = new THREE.ConeGeometry(0.1, 0.32, 5);
    for (let i = -1; i <= 1; i++) {
      const bang = new THREE.Mesh(bangGeo, matHair);
      bang.position.set(i * 0.15, 1.66, 0.255);
      bang.rotation.z = i * 0.28;
      bang.rotation.x = 0.12;
      root.add(bang);
    }
    // 后发束
    const ponytail = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.72, 6), matHair);
    ponytail.position.set(0, 1.55, -0.3);
    ponytail.rotation.x = -0.34;
    root.add(ponytail);

    const eyeGeo = new THREE.SphereGeometry(0.055, 8, 8);
    [-0.11, 0.11].forEach((x) => {
      const eye = new THREE.Mesh(eyeGeo, matEye);
      eye.position.set(x, 1.8, 0.285);
      eye.scale.set(0.85, 1.25, 0.6);
      root.add(eye);
    });

    /* ---- 手臂 ---- */
    const armGeo = new THREE.CapsuleGeometry(0.082, 0.36, 4, 10);
    const armL = new THREE.Group(), armR = new THREE.Group();
    armL.position.set(-0.3, 1.42, 0);
    armR.position.set(0.3, 1.42, 0);
    root.add(armL, armR);
    [armL, armR].forEach((pivot) => {
      const arm = new THREE.Mesh(armGeo, matCloth);
      arm.position.y = -0.2;
      pivot.add(arm);
      pivot.rotation.z = pivot === armL ? 0.12 : -0.12;
    });

    /* ---- 武器（挂在右手） ---- */
    const sword = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.92, 0.13), matSteel);
    blade.position.y = -0.55;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.08), matGold);
    guard.position.y = -0.1;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.24, 8), matClothDark);
    grip.position.y = 0.02;
    const pommel = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), matGold);
    pommel.position.y = 0.15;
    sword.add(blade, guard, grip, pommel);
    sword.position.set(0, -0.36, 0.04);
    sword.rotation.z = 0.12;
    armR.add(sword);

    root.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });

    return {
      root,
      parts: { legL, legR, armL, armR, sword, torso, head, hairCap, cape, skirt, materials: { cloth: matCloth, hair: matHair } },
    };
  }

  /* =========================================================
     6. 玩家
     ========================================================= */
  const player = {
    root: null,
    parts: null,
    pos: new THREE.Vector3(SPAWN.x, 0, SPAWN.z),
    heading: Math.PI * 0.85,
    jumpH: 0,
    vy: 0,
    airborne: false,
    landT: 0,
    takeoffT: 0,
    speed: 0,
    runPhase: 0,
    swingT: 0,
    swingKind: 'normal',
    glow: null,
  };

  const state = {
    started: false,
    active: 0,
    characters: PARTY.map((p) => ({ hp: p.maxHp, maxHp: p.maxHp })),
    stamina: CFG.staminaMax,
    energy: 0,
    skillCd: 0,
    attackCd: 0,
    hurtCd: 0,
    camYaw: Math.PI,
    camPitch: 0.24,
    camDist: CFG.camDist,
    lookAt: new THREE.Vector3(SPAWN.x, PLATEAU + 1.2, SPAWN.z),
    shake: 0,
    sprinting: false,
    attacking: false,
    hurtT: 0,
    regenTimer: 0,
  };

  const camPos = new THREE.Vector3(0, 12, 24);

  function accentColor() { return ELEMENTS[PARTY[state.active].element]; }

  /* ---------- MMD 模型（PMX 本地加载：冰之女皇 / 雷泽 / verity） ---------- */
  // PMX 模型本地正面朝 +Z，与游戏 heading=0（+Z）同向，无需额外旋转
  const MMD_YAW_FIX = 0;
  // 笑脸怪的 PMX 与角色朝向相反，单独补 180°
  const VERITY_YAW_FIX = 0;
  const mmdLoader = new MMDLoader();
  const MMD_PATHS = {
    anastasya: './resources/models/anastasya/anastasya.pmx',
    razor: './resources/models/razor/razor.pmx',
    verity: './resources/models/verity/verity.pmx',
  };
  const mmdPlayers = [];
  let mmdVerity = null;
  const mmdDone = { n: 0, total: 3, failed: 0 };

  function loadMmd(url, tag) {
    return new Promise((resolve) => {
      mmdLoader.load(url, (mesh) => resolve(mesh), null, (err) => {
        console.warn('[MMD] 载入失败：' + tag, err);
        mmdDone.failed++;
        resolve(null);
      });
    });
  }

  function prepareMmd(mesh, targetHeight) {
    const box = new THREE.Box3().setFromObject(mesh);
    const h = Math.max(0.001, box.max.y - box.min.y);
    const k = targetHeight / h;
    mesh.scale.setScalar(k);
    mesh.position.set(0, -box.min.y * k, 0);
    mesh.traverse((m) => {
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      mats.forEach((mt) => {
        if (!mt) return;
        mt.side = THREE.DoubleSide;
        // 保留贴图原本的饱和度：不受场景 ACES 曝光影响（否则黄色笑脸会被洗成米白）
        mt.toneMapped = false;
        if (mt.map) mt.map.colorSpace = THREE.SRGBColorSpace;
        if (mt.emissive) mt.emissive.setRGB(0.14, 0.14, 0.14);
      });
    });
    const inner = new THREE.Group();
    inner.add(mesh);
    const holder = new THREE.Group();
    holder.add(inner);
    holder.visible = false;
    holder.rotation.y = MMD_YAW_FIX;
    world.add(holder);
    const bones = { map: {}, base: {} };
    if (mesh.skeleton) {
      mesh.skeleton.bones.forEach((b) => {
        bones.map[b.name] = b;
        bones.base[b.name] = b.rotation.clone();
      });
    }
    return { holder, inner, mesh, bones };
  }

  function applyMmdForActive() {
    mmdPlayers.forEach((a, i) => { if (a) a.holder.visible = i === state.active; });
    const asset = mmdPlayers[state.active];
    player.mmd = asset || null;
    if (player.glow) {
      if (asset) {
        asset.holder.add(player.glow);
        player.glow.position.set(0, 0.03, 0);
      } else if (player.root) {
        player.root.add(player.glow);
        player.glow.position.set(0, 0.03, 0);
      }
    }
    player.root.visible = !asset;
    if (asset) asset.holder.position.copy(player.root.position);
  }

  // 程序化骨骼动画：走路 / 待机 / 跳跃 / 攻击姿态
  function animateMmd(asset, dt, moving) {
    if (!asset) return;

    const map = asset.bones.map, base = asset.bones.base;
    if (!map['センター'] && !map['上半身']) return;
    const set = (name, axis, v) => {
      const b = map[name];
      if (b && base[name]) b.rotation[axis] = base[name][axis] + v;
    };
    const sw = Math.sin(player.runPhase);
    const amp = clamp(player.speed / CFG.walkSpeed, 0, 1.25);
    const t = player.modelTime || 0;
    player.modelTime = t + dt;

    const up = clamp(player.vy / CFG.jumpPower, -1, 1);
    const rise = Math.max(0, up);          // 上升阶段：收腿
    const fall = Math.max(0, -up);         // 下落阶段：伸腿准备着地

    if (player.airborne) {
      set('左足', 'x', -0.26 - 0.46 * rise + 0.16 * fall);
      set('右足', 'x', -0.14 - 0.34 * rise + 0.12 * fall);
      set('左ひざ', 'x', 0.30 + 0.78 * rise - 0.08 * fall);
      set('右ひざ', 'x', 0.18 + 0.58 * rise - 0.02 * fall);
      set('左腕', 'x', -0.18 - 0.34 * rise + 0.24 * fall);
      set('右腕', 'x', -0.18 - 0.34 * rise + 0.24 * fall);
    } else if (moving) {
      set('左足', 'x', sw * 0.58 * amp);
      set('右足', 'x', -sw * 0.58 * amp);
      set('左ひざ', 'x', Math.max(0, -sw) * 0.72 * amp);
      set('右ひざ', 'x', Math.max(0, sw) * 0.72 * amp);
      set('左腕', 'x', -sw * 0.42 * amp);
      set('右腕', 'x', sw * 0.34 * amp);
    } else {
      const idle = Math.sin(t * 1.8) * 0.035;
      set('左足', 'x', 0); set('右足', 'x', 0);
      set('左ひざ', 'x', 0.02); set('右ひざ', 'x', 0.02);
      set('左腕', 'x', idle); set('右腕', 'x', -idle);
    }

    // MMD 默认是 T-pose，肩部绕 Z 收拢让手臂自然下垂（左负右正）
    const armDown = 0.42;
    const armSway = moving ? sw * 0.05 * amp : 0;
    set('左肩', 'z', -armDown - armSway);
    set('右肩', 'z', armDown + armSway);

    set('上半身', 'x', 0.045 * amp + Math.sin(t * 1.6) * 0.012);
    set('上半身', 'z', moving ? sw * 0.05 * amp : 0);
    set('センター', 'y', Math.abs(sw) * 0.018 * amp);
    set('首', 'x', -0.02 * amp);

    // 普攻：右臂挥砍
    if (player.swingT > 0) {
      const k = 1 - player.swingT;
      const arc = Math.sin(k * Math.PI);
      set('右腕', 'x', -1.55 * arc - 0.15);
      set('右腕', 'z', 0.45 * arc);
      set('右ひじ', 'x', -0.55 * arc);
      set('上半身', 'y', -0.42 * arc);
    } else {
      set('上半身', 'y', 0);
      set('右ひじ', 'x', 0);
    }

    /* ---------- 落地缓冲 + 起跳拉伸（身体弹性） ---------- */
    player.landT = Math.max(0, player.landT - dt);
    player.takeoffT = Math.max(0, player.takeoffT - dt);
    const land = player.landT > 0 ? Math.sin((player.landT / 0.30) * Math.PI) : 0;
    const launch = player.takeoffT > 0 ? Math.sin((player.takeoffT / 0.16) * Math.PI) : 0;

    if (land > 0) {
      const add = (name, axis, v) => { const b = map[name]; if (b) b.rotation[axis] += v; };
      add('左ひざ', 'x', land * 0.46);
      add('右ひざ', 'x', land * 0.46);
      add('上半身', 'x', land * 0.10);
      add('センター', 'y', -land * 0.06);
      asset.holder.position.y = player.root.position.y - land * 0.10;
    } else {
      asset.holder.position.y = player.root.position.y;
    }

    const sq = land * 0.12 - launch * 0.07;   // 落地压扁 / 起跳拉长
    asset.holder.scale.set(1 + sq * 0.55, 1 - sq, 1 + sq * 0.55);
  }

  function attachVerityVisual(en) {
    if (!mmdVerity || en.userData.mmd) return;
    const mesh = cloneSkeleton(mmdVerity.mesh);
    const mats = [];
    mesh.traverse((m) => {
      if (!m.isMesh) return;
      m.castShadow = true;
      m.frustumCulled = false;
      // 材质按怪独立克隆，受击发光才能各闪各的
      m.material = (Array.isArray(m.material) ? m.material : [m.material]).map((mt) => {
        const c = mt.clone();
        if (c.emissive) mats.push(c);
        return c;
      });
      if (m.material.length === 1) m.material = m.material[0];
    });
    const holder = new THREE.Group();
    holder.rotation.y = VERITY_YAW_FIX;
    holder.add(mesh);
    en.children.slice().forEach((c) => { if (!c.userData.auraFx) c.visible = false; });
    en.add(holder);
    en.userData.mmd = holder;
    en.userData.mmdMats = mats;
    en.userData.mmdColors = mats.map((mt) => mt.color.clone());
  }

  function onModelsReady() {
    mmdPlayers.forEach((a, i) => { if (a) a.holder.visible = state.started ? i === state.active : false; });
    applyMmdForActive();
    finishBoot();
    if (mmdDone.failed === 0) toast('角色模型载入完成 · 冰之女皇 / 雷泽', 2200);
  }

  (async function loadModels() {
    for (let i = 0; i < PARTY.length; i++) {
      const mesh = await loadMmd(MMD_PATHS[PARTY[i].model], PARTY[i].name);
      mmdDone.n++;
      const prepared = mesh ? prepareMmd(mesh, PARTY[i].modelHeight) : null;
      mmdPlayers[i] = prepared;
      if (prepared) applyMmdForActive();
    }
    const vm = await loadMmd(MMD_PATHS.verity, 'verity');
    mmdDone.n++;
    mmdVerity = vm ? prepareMmd(vm, 1.35) : null;
    if (mmdVerity) enemies.forEach(attachVerityVisual);
    onModelsReady();
  })();
  setTimeout(() => {
    if (mmdDone.n < mmdDone.total) { mmdDone.n = mmdDone.total; onModelsReady(); }
  }, 25000);

  function buildPlayer() {
    if (player.root) {
      world.remove(player.root);
      player.root.traverse((m) => {
        if (m.isMesh) {
          if (m.geometry) m.geometry.dispose();
          const mats = Array.isArray(m.material) ? m.material : [m.material];
          mats.forEach((mt) => mt && mt.dispose());
        }
      });
    }
    const c = createCharacter(PARTY[state.active].element);
    player.root = c.root;
    player.parts = c.parts;
    player.root.position.copy(player.pos);
    player.root.rotation.y = player.heading;
    world.add(player.root);

    // 脚下的元素光环
    const glowColor = ELEMENTS[PARTY[state.active].element].color;
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(1.05, 40),
      new THREE.MeshBasicMaterial({
        color: glowColor, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = 0.03;
    player.root.add(glow);
    player.glow = glow;

    document.documentElement.style.setProperty('--elem', ELEMENTS[PARTY[state.active].element].css);
    player.root.position.y = groundHeight(player.pos.x, player.pos.z) + player.jumpH;
    applyMmdForActive();
  }

  buildPlayer();

  /* =========================================================
     7. 敌人（史莱姆）
     ========================================================= */
  const enemies = [];
  const slimeGeo = new THREE.SphereGeometry(0.72, 16, 12);
  const slimeEyeGeo = new THREE.SphereGeometry(0.1, 8, 8);
  const slimeMatEye = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.4 });
  const slimeMatHi = new THREE.MeshBasicMaterial({ color: 0xffffff });

  function spawnSlime(i) {
    const el = [0x7fc46a, 0x6fa8e8, 0xe0a05a][i % 3];
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: el, roughness: 0.45, metalness: 0.05, flatShading: false,
      emissive: new THREE.Color(el), emissiveIntensity: 0,
      transparent: true, opacity: 0.95,
    });
    const body = new THREE.Mesh(slimeGeo, mat);
    body.scale.set(1, 0.86, 1);
    body.position.y = 0.62;
    g.add(body);

    [-0.2, 0.2].forEach((x) => {
      const eye = new THREE.Mesh(slimeEyeGeo, slimeMatEye);
      eye.position.set(x, 0.74, 0.6);
      eye.scale.set(0.9, 1.2, 0.5);
      g.add(eye);
      const hi = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 6), slimeMatHi);
      hi.position.set(x + 0.03, 0.79, 0.64);
      g.add(hi);
    });

    // 顶部叶片装饰
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.5, 5), new THREE.MeshStandardMaterial({ color: 0x497f3a, roughness: 0.8, flatShading: true }));
    leaf.position.set(0, 1.2, -0.05);
    leaf.rotation.z = 0.2;
    g.add(leaf);

    g.traverse((m) => { if (m.isMesh) m.castShadow = true; });

    // 元素附着图标（冰/雷），默认隐藏
    const auraIcon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: null, transparent: true, depthWrite: false, depthTest: false, opacity: 0.95,
    }));
    auraIcon.position.set(0, 2.15, 0);
    auraIcon.scale.set(0.62, 0.62, 1);
    auraIcon.visible = false;
    auraIcon.renderOrder = 999;
    auraIcon.userData.auraFx = true;
    g.add(auraIcon);

    // 元素附着光壳：让怪物整体明显染上冰/雷色
    const auraShell = new THREE.Mesh(
      new THREE.SphereGeometry(1.12, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0x2f7bff, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    auraShell.position.y = 0.62;
    auraShell.scale.set(1.1, 1.0, 1.1);
    auraShell.visible = false;
    auraShell.userData.auraFx = true;
    g.add(auraShell);

    g.userData = {
      body, mat, leaf,
      hp: 240, maxHp: 240, alive: true, respawn: 0,
      home: new THREE.Vector3(),
      bobPhase: Math.random() * 6.28,
      flash: 0,
      aura: null, auraT: 0, auraIcon, auraShell,
    };
    world.add(g);
    enemies.push(g);
    return g;
  }

  // 7 只怪，最近的也在 9m 外，避免一开局就被笑脸球包围
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rand(-0.3, 0.3);
    const r = i < 3 ? rand(9, 16) : rand(18, 34);
    const x = Math.cos(a) * r, z = Math.sin(a) * r + SPAWN.z * 0.4;
    const s = spawnSlime(i);
    s.position.set(x, groundHeight(x, z), z);
    s.userData.home.copy(s.position);
  }

  /* =========================================================
     8. 特效系统
     ========================================================= */
  // 圆点贴图（粒子用）
  function makeDotTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.85)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const dotTex = makeDotTexture();

  /* ---------- 粒子池 ---------- */
  const P_MAX = 520;
  const pGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(P_MAX * 3);
  const pCol = new Float32Array(P_MAX * 3);
  for (let i = 0; i < P_MAX; i++) pPos[i * 3 + 1] = -999;
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  pGeo.setAttribute('color', new THREE.BufferAttribute(pCol, 3));
  const pMat = new THREE.PointsMaterial({
    size: 0.24, map: dotTex, vertexColors: true, transparent: true,
    opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
  });
  const particles = new THREE.Points(pGeo, pMat);
  particles.frustumCulled = false;
  scene.add(particles);

  const pData = new Array(P_MAX).fill(null).map(() => ({ alive: false, vx: 0, vy: 0, vz: 0, life: 0, max: 1, r: 1, g: 1, b: 1, grav: 1, drag: 1 }));
  let pCursor = 0;

  function spawnParticles(origin, colorHex, count, speed, opts) {
    const o = opts || {};
    const col = new THREE.Color(colorHex);
    for (let i = 0; i < count; i++) {
      const idx = pCursor = (pCursor + 1) % P_MAX;
      const p = pData[idx];
      p.alive = true;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(rand(-1, 1));
      const s = speed * rand(0.35, 1);
      p.vx = Math.sin(phi) * Math.cos(theta) * s;
      p.vz = Math.sin(phi) * Math.sin(theta) * s;
      p.vy = Math.cos(phi) * s * (o.up || 1) + rand(-0.2, 0.6) * speed * 0.35;
      p.life = p.max = rand(0.5, 1.15) * (o.life || 1);
      p.grav = o.grav === undefined ? 2.2 : o.grav;
      p.drag = o.drag === undefined ? 2.4 : o.drag;
      p.r = col.r; p.g = col.g; p.b = col.b;
      pPos[idx * 3] = origin.x + rand(-0.25, 0.25);
      pPos[idx * 3 + 1] = origin.y + rand(-0.2, 0.3);
      pPos[idx * 3 + 2] = origin.z + rand(-0.25, 0.25);
    }
    pGeo.attributes.position.needsUpdate = true;
    pGeo.attributes.color.needsUpdate = true;
  }

  function updateParticles(dt) {
    let dirty = false;
    for (let i = 0; i < P_MAX; i++) {
      const p = pData[i];
      if (!p.alive) continue;
      dirty = true;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        pPos[i * 3 + 1] = -999;
        pCol[i * 3] = pCol[i * 3 + 1] = pCol[i * 3 + 2] = 0;
        continue;
      }
      const k = p.life / p.max;
      p.vy -= p.grav * dt;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d; p.vz *= d;
      pPos[i * 3] += p.vx * dt;
      pPos[i * 3 + 1] += p.vy * dt;
      pPos[i * 3 + 2] += p.vz * dt;
      pCol[i * 3] = p.r * k;
      pCol[i * 3 + 1] = p.g * k;
      pCol[i * 3 + 2] = p.b * k;
    }
    if (dirty) {
      pGeo.attributes.position.needsUpdate = true;
      pGeo.attributes.color.needsUpdate = true;
    }
  }

  /* ---------- 环形 / 柱形冲击波 ---------- */
  const effects = [];
  function spawnRing(pos, colorHex, maxR, dur, opacity) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 56),
      new THREE.MeshBasicMaterial({
        color: colorHex, transparent: true, opacity: opacity === undefined ? 0.92 : opacity,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.copy(pos);
    mesh.position.y += 0.06;
    scene.add(mesh);
    effects.push({ type: 'ring', mesh, t: 0, dur: dur || 0.72, maxR: maxR || 4, op: opacity === undefined ? 0.92 : opacity });
  }

  function spawnPillar(pos, colorHex) {
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 6, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: colorHex, transparent: true, opacity: 0.42,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    mesh.position.copy(pos);
    mesh.position.y += 3;
    scene.add(mesh);
    effects.push({ type: 'pillar', mesh, t: 0, dur: 0.9 });
  }

  function spawnOrb(pos, colorHex, maxR) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({
        color: colorHex, transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    mesh.position.copy(pos);
    scene.add(mesh);
    effects.push({ type: 'orb', mesh, t: 0, dur: 0.7, maxR: maxR || 3 });
  }

  function updateEffects(dt) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      e.t += dt;
      const k = e.t / e.dur;
      if (k >= 1) {
        scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mesh.material.dispose();
        effects.splice(i, 1);
        continue;
      }
      const ease = 1 - Math.pow(1 - k, 2.2);
      if (e.type === 'ring') {
        const s = 0.4 + ease * e.maxR;
        e.mesh.scale.set(s, s, 1);
        e.mesh.material.opacity = e.op * (1 - k);
      } else if (e.type === 'pillar') {
        e.mesh.scale.set(1 - k * 0.55, 1 + k * 0.8, 1 - k * 0.55);
        e.mesh.material.opacity = 0.7 * (1 - k);
        e.mesh.rotation.y += dt * 2.2;
      } else if (e.type === 'orb') {
        const s = 0.3 + ease * e.maxR;
        e.mesh.scale.setScalar(s);
        e.mesh.material.opacity = 0.55 * (1 - k);
      }
    }
  }

  /* ---------- 伤害数字 ---------- */
  const floatersEl = document.getElementById('floaters');
  const floaters = [];
  const projVec = new THREE.Vector3();

  function toScreen(v3) {
    projVec.copy(v3).project(camera);
    return {
      x: (projVec.x * 0.5 + 0.5) * renderer.domElement.clientWidth,
      y: (-projVec.y * 0.5 + 0.5) * renderer.domElement.clientHeight,
      visible: projVec.z < 1,
    };
  }

  function damageNumber(worldPos, text, kind) {
    const el = document.createElement('div');
    el.className = 'floater' + (kind ? ' ' + kind : '');
    el.textContent = text;
    floatersEl.appendChild(el);
    floaters.push({
      el,
      pos: worldPos.clone().add(new THREE.Vector3(rand(-0.45, 0.45), 1.35, rand(-0.45, 0.45))),
      t: 0, dur: 1.0,
    });
  }

  function updateFloaters(dt) {
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.t += dt;
      if (f.t >= f.dur) {
        f.el.remove();
        floaters.splice(i, 1);
        continue;
      }
      f.pos.y += dt * 1.15;
      const p = toScreen(f.pos);
      const k = f.t / f.dur;
      const scale = k < 0.18 ? 0.7 + k * 1.7 : 1;
      f.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%,-50%) scale(${scale.toFixed(2)})`;
      f.el.style.opacity = String(1 - Math.pow(k, 3));
    }
  }

  /* =========================================================
     9. UI 绑定
     ========================================================= */
  const ui = {
    party: document.getElementById('party'),
    cards: Array.from(document.querySelectorAll('.party-card')).map((card) => ({
      card,
      hp: card.querySelector('.hp-fill'),
      pct: -1, active: null,
    })),
    skillBtn: document.getElementById('btn-skill'),
    skillCdEl: document.getElementById('skill-cd'),
    burstBtn: document.getElementById('btn-burst'),
    burstEnergy: document.getElementById('burst-energy'),
    stamRing: document.getElementById('stam-ring'),
    attackBtn: document.getElementById('btn-attack'),
    jumpBtn: document.getElementById('btn-jump'),
    sprintBtn: document.getElementById('btn-sprint'),
    toastEl: document.getElementById('toast'),
    vignette: document.querySelector('.vignette'),
    start: document.getElementById('start'),
    startBtn: document.getElementById('start-btn'),
    loadBar: document.getElementById('load-bar'),
    cdCache: -1, stamCache: -1, energyCache: -1, burstReady: null, stamOn: null,
  };

  let toastTimer = 0;
  function toast(text, ms) {
    ui.toastEl.textContent = text;
    ui.toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toastEl.classList.remove('is-on'), ms || 1600);
  }

  function hurtFlash() {
    ui.vignette.classList.remove('is-out');
    ui.vignette.classList.add('is-hurt');
    setCooldownish();
  }
  function setCooldownish() {
    clearTimeout(hurtFlash._t);
    hurtFlash._t = setTimeout(() => {
      ui.vignette.classList.add('is-out');
      setTimeout(() => ui.vignette.classList.remove('is-hurt', 'is-out'), 520);
    }, 160);
  }

  /* =========================================================
     10. 输入
     ========================================================= */
  const input = {
    keys: new Set(),
    joyX: 0, joyY: 0,
    sprintHold: false,
    drag: { active: false, id: null, x: 0, y: 0 },
  };

  const el = {
    joy: document.getElementById('joystick'),
    knob: document.getElementById('joy-knob'),
  };

  /* ---- 摇杆 ---- */
  let joyPointer = null;
  function joyUpdate(e) {
    const r = el.joy.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const max = r.width / 2 - 16;
    const len = Math.hypot(dx, dy);
    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }
    input.joyX = dx / max;
    input.joyY = -dy / max;
    el.knob.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    el.knob.parentElement.classList.add('is-active');
  }
  function joyReset() {
    joyPointer = null;
    input.joyX = input.joyY = 0;
    el.knob.style.transform = 'translate(0px, 0px)';
    el.joy.classList.remove('is-active');
  }

  el.joy.addEventListener('pointerdown', (e) => {
    if (!state.started) return;
    e.preventDefault();
    joyPointer = e.pointerId;
    el.joy.setPointerCapture(e.pointerId);
    el.joy.classList.add('is-active');
    joyUpdate(e);
  });
  el.joy.addEventListener('pointermove', (e) => {
    if (e.pointerId !== joyPointer) return;
    e.preventDefault();
    joyUpdate(e);
  });
  el.joy.addEventListener('pointerup', (e) => { if (e.pointerId === joyPointer) joyReset(); });
  el.joy.addEventListener('pointercancel', joyReset);

  /* ---- 按钮 ---- */
  function bindHold(btn, onDown, onUp) {
    btn.addEventListener('pointerdown', (e) => {
      if (!state.started) return;
      e.preventDefault();
      e.stopPropagation();
      btn.classList.add('is-pressed');
      btn.setPointerCapture(e.pointerId);
      onDown && onDown();
    });
    const up = (e) => {
      btn.classList.remove('is-pressed');
      onUp && onUp();
    };
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('pointerleave', up);
  }

  bindHold(ui.sprintBtn, () => { input.sprintHold = true; }, () => { input.sprintHold = false; });
  bindHold(ui.attackBtn, () => { state.attacking = true; tryAttack(); }, () => { state.attacking = false; });
  bindHold(ui.skillBtn, () => { useSkill(); });
  bindHold(ui.burstBtn, () => { useBurst(); });
  bindHold(ui.jumpBtn, () => { doJump(); });

  /* ---- 队伍点击 ---- */
  ui.cards.forEach((c, i) => {
    c.card.addEventListener('pointerdown', (e) => {
      if (!state.started) return;
      e.preventDefault();
      e.stopPropagation();
      switchCharacter(i);
    });
  });

  /* ---- 键盘 ---- */
  window.addEventListener('keydown', (e) => {
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(k)) e.preventDefault();
    input.keys.add(k);
    if (!state.started) return;
    if (k === 'e') useSkill();
    else if (k === 'q') useBurst();
    else if (k === ' ') doJump();
    else if (k >= '1' && k <= '4') switchCharacter(parseInt(k, 10) - 1);
  });
  window.addEventListener('keyup', (e) => { input.keys.delete(e.key.toLowerCase()); });
  window.addEventListener('blur', () => { input.keys.clear(); input.joyX = input.joyY = 0; state.attacking = false; });

  /* ---- 拖动转视角 / 滚轮缩放 ---- */
  const canvas = renderer.domElement;
  canvas.addEventListener('pointerdown', (e) => {
    if (!state.started) return;
    input.drag.active = true;
    input.drag.id = e.pointerId;
    input.drag.x = e.clientX;
    input.drag.y = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!input.drag.active || e.pointerId !== input.drag.id) return;
    const dx = e.clientX - input.drag.x;
    const dy = e.clientY - input.drag.y;
    input.drag.x = e.clientX;
    input.drag.y = e.clientY;
    state.camYaw -= dx * 0.0055;
    state.camPitch = clamp(state.camPitch + dy * 0.0035, -0.05, 0.92);
  });
  const endDrag = (e) => {
    if (e.pointerId !== input.drag.id) return;
    input.drag.active = false;
    input.drag.id = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    if (!state.started) return;
    e.preventDefault();
    state.camDist = clamp(state.camDist + e.deltaY * 0.008, CFG.camMinDist, CFG.camMaxDist);
  }, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  /* =========================================================
     11. 战斗
     ========================================================= */
  // 元素附着 / 超导
  const AURA_TIME = 5.5;             // 附着残留 5.5 秒
  const SUPERCONDUCT_DMG = 80000;    // 冰 + 雷 → 超导 80000 伤害
  const AURA_EMISSIVE = {
    cryo: new THREE.Color(0x2c6bff),
    electro: new THREE.Color(0x8b46ff),
  };
  const AURA_TINT = {
    cryo: new THREE.Color(0xa8d4ff),
    electro: new THREE.Color(0xcaaaff),
  };

  function makeAuraTexture(kind) {
    const size = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d');
    const main = kind === 'cryo' ? '#b9e6ff' : '#e0c8ff';
    ctx.beginPath();
    ctx.arc(64, 64, 50, 0, Math.PI * 2);
    ctx.fillStyle = kind === 'cryo' ? 'rgba(38, 86, 150, .78)' : 'rgba(92, 58, 158, .78)';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = main;
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 4;
    if (kind === 'cryo') {
      // 六角雪花
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI;
        ctx.beginPath();
        ctx.moveTo(64 - Math.cos(a) * 30, 64 - Math.sin(a) * 30);
        ctx.lineTo(64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30);
        ctx.stroke();
      }
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = 64 + Math.cos(a) * 22, y = 64 + Math.sin(a) * 22;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a + 0.5) * 10, y + Math.sin(a + 0.5) * 10);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a - 0.5) * 10, y + Math.sin(a - 0.5) * 10);
        ctx.stroke();
      }
    } else {
      // 闪电
      ctx.beginPath();
      ctx.moveTo(74, 24);
      ctx.lineTo(44, 70);
      ctx.lineTo(62, 70);
      ctx.lineTo(52, 104);
      ctx.lineTo(86, 56);
      ctx.lineTo(66, 56);
      ctx.closePath();
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }
  const AURA_TEX = { cryo: makeAuraTexture('cryo'), electro: makeAuraTexture('electro') };

  function applyAura(en, element) {
    const u = en.userData;
    if (!u.aura) {
      u.aura = element;
      u.auraT = AURA_TIME;
      u.auraEnd = performance.now() + AURA_TIME * 1000;
      if (u.auraIcon) {
        u.auraIcon.material.map = AURA_TEX[element];
        u.auraIcon.material.needsUpdate = true;
        u.auraIcon.visible = true;
      }
      spawnParticles(
        en.position.clone().add(new THREE.Vector3(0, 1.3, 0)),
        ELEMENTS[element].color, 14, 2.0, { up: 0.9, grav: 0.4, life: 0.7 }
      );
      damageNumber(en.position.clone().add(new THREE.Vector3(0, 1.9, 0)),
        element === 'cryo' ? '附着 · 冰' : '附着 · 雷', 'aura');
      return null;
    }
    if (u.aura === element) {
      u.auraT = AURA_TIME;   // 同元素刷新残留时间
      u.auraEnd = performance.now() + AURA_TIME * 1000;
      return null;
    }
    // 冰 × 雷 → 超导
    u.aura = null;
    u.auraT = 0;
    if (u.auraIcon) u.auraIcon.visible = false;
    if (u.auraShell) u.auraShell.visible = false;
    return 'superconduct';
  }

  function superconductFx(en) {
    const p = en.position.clone().add(new THREE.Vector3(0, 1.0, 0));
    spawnRing(en.position.clone(), 0xb07cff, 3.4, 0.55);
    spawnRing(en.position.clone(), 0x9fd4ff, 2.2, 0.45, 0.55);
    spawnParticles(p, 0xb98cff, 52, 5.4, { up: 1.5, grav: 1.2, life: 1.0 });
    spawnParticles(p, 0xdff0ff, 34, 4.2, { up: 2.0, grav: 1.0, life: 0.8 });
    damageNumber(en.position.clone().add(new THREE.Vector3(0, 2.15, 0)), '超导', 'super');
    state.shake = Math.max(state.shake, 0.6);
    toast('超导！冰 × 雷', 1500);
  }

  function forwardVec() {
    return new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading));
  }

  function damageEnemies(origin, radius, forwardOnly, baseDmg, kind, element) {
    let hits = 0;
    const fwd = forwardVec();
    enemies.forEach((en) => {
      const u = en.userData;
      if (!u.alive) return;
      const d = new THREE.Vector3().subVectors(en.position, origin);
      d.y = 0;
      const dist = d.length();
      if (dist > radius) return;
      if (forwardOnly) {
        d.normalize();
        if (d.dot(fwd) < CFG.attackArc) return;
      }
      const dmg = Math.round(baseDmg * rand(0.86, 1.18));
      const crit = Math.random() < 0.22;
      const reacted = element ? applyAura(en, element) : null;
      if (reacted === 'superconduct') {
        hitEnemy(en, SUPERCONDUCT_DMG, 'super');
        superconductFx(en);
      } else {
        hitEnemy(en, crit ? Math.round(dmg * 1.7) : dmg, crit ? 'crit' : kind);
      }
      hits++;
      // 轻微击退
      const push = d.clone().multiplyScalar(0.55);
      en.position.add(push);
    });
    return hits;
  }

  function hitEnemy(en, dmg, kind) {
    const u = en.userData;
    if (!u.alive) return;
    u.hp -= dmg;
    u.flash = 1;
    damageNumber(en.position.clone().add(new THREE.Vector3(0, 0.9, 0)), String(dmg), kind);
    spawnParticles(en.position.clone().add(new THREE.Vector3(0, 0.7, 0)),
      kind === 'super' ? 0xb98cff : accentColor().color, kind === 'super' ? 26 : 10, 2.6);

    if (u.hp <= 0) {
      u.alive = false;
      u.respawn = 6;
      en.visible = false;
      u.aura = null;
      u.auraT = 0;
      if (u.auraIcon) u.auraIcon.visible = false;
      if (u.auraShell) u.auraShell.visible = false;
      spawnParticles(en.position.clone().add(new THREE.Vector3(0, 0.6, 0)), 0xffe9a8, 26, 4.2);
      spawnRing(en.position.clone(), accentColor().color, 2.2, 0.5);
      damageNumber(en.position.clone().add(new THREE.Vector3(0, 1.6, 0)), '击破', 'crit');
    }
  }

  function tryAttack() {
    if (state.attackCd > 0 || !state.started) return;
    state.attackCd = CFG.attackCd;
    player.swingT = 1;
    state.shake = Math.max(state.shake, 0.25);
    const origin = player.pos.clone();
    const hits = damageEnemies(origin, CFG.attackRange, true, 92, '', PARTY[state.active].element);
    if (hits > 0) {
      state.energy = Math.min(CFG.energyMax, state.energy + CFG.energyPerHit);
      const tip = player.pos.clone().add(forwardVec().multiplyScalar(1.5)).add(new THREE.Vector3(0, 1.4, 0));
      spawnParticles(tip, accentColor().color, 12, 3.2, { life: 0.7 });
    }
  }

  function useSkill() {
    if (!state.started || state.skillCd > 0) return;
    const el = accentColor();
    state.skillCd = CFG.skillCd;
    state.energy = Math.min(CFG.energyMax, state.energy + CFG.energyPerSkill);
    state.shake = Math.max(state.shake, 0.5);

    const c = player.pos.clone();
    spawnRing(c, el.color, 5.6, 0.75);
    spawnRing(c, el.glow, 3.2, 0.55, 0.7);
    spawnPillar(c, el.color);
    spawnParticles(c.clone().add(new THREE.Vector3(0, 0.6, 0)), el.color, 46, 5.2, { up: 1.5, grav: 1.2 });

    const hits = damageEnemies(c, 5.6, false, 200, '', PARTY[state.active].element);
    if (hits === 0) spawnParticles(c.clone().add(new THREE.Vector3(0, 1, 0)), el.color, 12, 2.4);
    toast(`元素战技 · ${el.name}`);
  }

  function useBurst() {
    if (!state.started) return;
    if (state.energy < CFG.energyMax) {
      toast(`元素能量不足 ${Math.floor(state.energy)}/${CFG.energyMax}`);
      return;
    }
    const el = accentColor();
    state.energy = 0;
    state.shake = Math.max(state.shake, 1.2);

    const c = player.pos.clone();
    spawnOrb(c.clone().add(new THREE.Vector3(0, 1.5, 0)), el.glow, 8.5);
    spawnRing(c, el.color, 9.2, 1.0);
    spawnRing(c, el.glow, 6.4, 0.75, 0.85);
    spawnRing(c, el.color, 3.6, 0.5);
    spawnPillar(c, el.color);
    spawnParticles(c.clone().add(new THREE.Vector3(0, 0.8, 0)), el.glow, 130, 8.5, { up: 1.2, grav: 1.6, life: 1.25 });

    damageEnemies(c, 9.2, false, 480, 'crit', PARTY[state.active].element);
    toast(`元素爆发 · ${el.name}`, 2000);
  }

  function doJump() {
    if (!state.started || player.airborne) return;
    player.airborne = true;
    player.vy = CFG.jumpPower * (state.sprinting ? 1.08 : 1);
    player.takeoffT = 0.16;
    spawnParticles(player.pos.clone().add(new THREE.Vector3(0, 0.15, 0)), 0xe8ead2, 14, 1.9, { up: 0.45, grav: 1.6, life: 0.5 });
    spawnRing(player.pos.clone().add(new THREE.Vector3(0, 0.05, 0)), 0xf4efdb, 1.3, 0.32);
  }

  function switchCharacter(i) {
    if (i === state.active || i < 0 || i >= PARTY.length || !state.started) return;
    const old = player.pos.clone();
    state.active = i;
    buildPlayer();
    player.pos.copy(old);
    player.root.position.copy(old);
    player.root.rotation.y = player.heading;
    const elem = accentColor();
    spawnRing(old, elem.color, 2.4, 0.6);
    spawnParticles(old.clone().add(new THREE.Vector3(0, 1, 0)), elem.color, 22, 3.2);
    toast(`切换角色 · ${PARTY[i].name}（${elem.name}）`);
    ui.cards.forEach((c, k) => {
      const on = k === i;
      c.isActive = on;
      c.card.classList.toggle('is-active', on);
    });
  }

  function damagePlayer(amount) {
    const ch = state.characters[state.active];
    if (ch.hp <= 0) return;
    ch.hp = Math.max(0, ch.hp - amount);
    state.hurtT = 0.4;
    state.regenTimer = 5;
    damageNumber(player.pos.clone().add(new THREE.Vector3(0, 2.0, 0)), '-' + amount, 'hurt');
    hurtFlash();
    state.shake = Math.max(state.shake, 0.35);

    if (ch.hp <= 0) {
      // 队伍倒下 → 回到出生点恢复
      ch.hp = Math.round(ch.maxHp * 0.6);
      player.pos.set(SPAWN.x, 0, SPAWN.z);
      player.jumpH = 0;
      player.vy = 0;
      player.airborne = false;
      toast('力竭了…… 回到起点恢复体力', 2200);
      spawnRing(player.pos.clone(), 0xffffff, 4, 0.8);
    }
  }

  /* =========================================================
     12. 主循环
     ========================================================= */
  const clock = new THREE.Clock();

  function update(dt, elapsed) {
    /* ---------- 输入 → 方向 ---------- */
    let ax = input.joyX, ay = input.joyY;
    if (input.keys.has('a') || input.keys.has('arrowleft')) ax -= 1;
    if (input.keys.has('d') || input.keys.has('arrowright')) ax += 1;
    if (input.keys.has('w') || input.keys.has('arrowup')) ay += 1;
    if (input.keys.has('s') || input.keys.has('arrowdown')) ay -= 1;

    const mag = Math.hypot(ax, ay);
    if (mag > 1) { ax /= mag; ay /= mag; }

    const joyMag = Math.hypot(input.joyX, input.joyY);
    const moving = state.started && mag > 0.08;

    const wantSprint = state.started && moving && (input.sprintHold || input.keys.has('shift') || joyMag > 0.94);
    state.sprinting = wantSprint && state.stamina > 0.5;

    /* ---------- 体力 ---------- */
    if (state.sprinting) {
      state.stamina = Math.max(0, state.stamina - CFG.staminaDrain * dt);
    } else {
      state.stamina = Math.min(CFG.staminaMax, state.stamina + CFG.staminaRegen * dt);
    }

    /* ---------- 相机朝向 → 世界方向 ---------- */
    const fwd = new THREE.Vector3(-Math.sin(state.camYaw), 0, -Math.cos(state.camYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x); // cross(fwd, up)
    const dir = new THREE.Vector3()
      .addScaledVector(fwd, ay)
      .addScaledVector(right, ax);
    if (dir.lengthSq() > 0.0001) dir.normalize();

    /* ---------- 移动 ---------- */
    const targetSpeed = moving ? (state.sprinting ? CFG.sprintSpeed : CFG.walkSpeed) : 0;
    player.speed = damp(player.speed, targetSpeed, moving ? 10 : 14, dt);

    if (moving) {
      player.pos.addScaledVector(dir, player.speed * dt);
      const angle = Math.atan2(dir.x, dir.z);
      player.heading = dampAngle(player.heading, angle, 12, dt);
      player.runPhase += dt * (state.sprinting ? 15 : 10);
      // 限制在场景范围内
      const r = Math.hypot(player.pos.x, player.pos.z);
      if (r > 78) {
        player.pos.x *= 78 / r;
        player.pos.z *= 78 / r;
      }
      // 冲刺扬尘
      if (state.sprinting && Math.random() < dt * 14) {
        spawnParticles(
          player.pos.clone().add(new THREE.Vector3(rand(-0.3, 0.3), 0.1, rand(-0.3, 0.3))),
          0xe7e3c9, 2, 1.2, { up: 0.3, grav: 0.6, life: 0.5 }
        );
      }
    }

    /* ---------- 跳跃 ---------- */
    if (player.airborne) {
      player.vy -= CFG.gravity * dt;
      player.jumpH += player.vy * dt;
      if (player.jumpH <= 0) {
        const drop = Math.abs(player.vy);
        player.jumpH = 0;
        player.vy = 0;
        player.airborne = false;
        player.landT = 0.30;
        if (drop > 3.2) {
          spawnParticles(
            player.pos.clone().add(new THREE.Vector3(0, 0.12, 0)),
            0xdcd7bd, 16, 2.2, { up: 0.55, grav: 2.4, life: 0.55 }
          );
          spawnRing(player.pos.clone().add(new THREE.Vector3(0, 0.06, 0)), 0xf2ecd8, 1.7, 0.42);
          state.shake = Math.max(state.shake, Math.min(0.22, drop * 0.018));
        }
      }
    }

    /* ---------- 贴地 ---------- */
    const gy = groundHeight(player.pos.x, player.pos.z);
    player.root.position.set(player.pos.x, gy + player.jumpH, player.pos.z);
    player.root.rotation.y = player.heading;

    // PMX 模型跟随玩家（位置 / 朝向 / 程序化骨骼动画）
    if (player.mmd) {
      player.mmd.holder.position.copy(player.root.position);
      player.mmd.holder.rotation.y = player.heading + MMD_YAW_FIX;
      animateMmd(player.mmd, dt, moving);
    }

    /* ---------- 动作姿态 ---------- */
    const p = player.parts;
    const moveK = clamp(player.speed / CFG.walkSpeed, 0, 1.6);
    const swing = Math.sin(player.runPhase);
    if (moving) {
      p.legL.rotation.x = swing * 0.62 * moveK;
      p.legR.rotation.x = -swing * 0.62 * moveK;
      p.armL.rotation.x = -swing * 0.45 * moveK;
      p.armR.rotation.x = swing * 0.3 * moveK;
    } else {
      const idle = Math.sin(elapsed * 1.9) * 0.045;
      p.legL.rotation.x = damp(p.legL.rotation.x, 0, 8, dt);
      p.legR.rotation.x = damp(p.legR.rotation.x, 0, 8, dt);
      p.armL.rotation.x = damp(p.armL.rotation.x, idle, 8, dt);
      p.armR.rotation.x = damp(p.armR.rotation.x, idle, 8, dt);
    }
    // 上半身呼吸 / 摆动
    p.torso.rotation.z = moving ? swing * 0.06 : Math.sin(elapsed * 1.6) * 0.02;
    p.head.rotation.z = moving ? -swing * 0.04 : 0;
    p.hairCap.rotation.z = p.head.rotation.z;
    p.cape.rotation.x = -0.28 - clamp(player.speed / 9.4, 0, 1) * 0.5 + Math.sin(elapsed * 3) * 0.03;

    /* ---------- 挥剑 ---------- */
    if (player.swingT > 0) {
      player.swingT = Math.max(0, player.swingT - dt / 0.38);
      const k = 1 - player.swingT;              // 0 → 1
      const arc = Math.sin(k * Math.PI);        // 起—落
      p.armR.rotation.x = -1.5 * arc - 0.4 * (1 - arc);
      p.armR.rotation.z = -0.12 - 0.5 * arc;
      p.sword.rotation.z = 0.12 + arc * 0.7;
      p.torso.rotation.y = -0.35 * arc;
    } else {
      p.armR.rotation.z = damp(p.armR.rotation.z, -0.12, 10, dt);
      p.sword.rotation.z = damp(p.sword.rotation.z, 0.12, 10, dt);
      p.torso.rotation.y = damp(p.torso.rotation.y, 0, 10, dt);
    }

    // 脚下光环
    if (player.glow) {
      const s = 1 + Math.sin(elapsed * 2.4) * 0.06;
      player.glow.scale.set(s, s, 1);
      player.glow.material.opacity = 0.16 + Math.sin(elapsed * 2.4) * 0.05;
    }

    /* ---------- 倒计时器 ---------- */
    state.attackCd = Math.max(0, state.attackCd - dt);
    state.skillCd = Math.max(0, state.skillCd - dt);
    state.energy = Math.min(CFG.energyMax, state.energy + CFG.energyRegen * dt);
    state.shake = Math.max(0, state.shake - dt * 3.2);
    state.hurtT = Math.max(0, state.hurtT - dt);
    state.hurtCd = Math.max(0, state.hurtCd - dt);
    if (state.attacking && state.attackCd <= 0) tryAttack();

    /* ---------- HP 缓慢恢复 ---------- */
    if (state.regenTimer > 0) state.regenTimer -= dt;
    else {
      const ch = state.characters[state.active];
      if (ch.hp > 0 && ch.hp < ch.maxHp) ch.hp = Math.min(ch.maxHp, ch.hp + 8 * dt);
    }

    /* ---------- 敌人 ---------- */
    enemies.forEach((en) => {
      const u = en.userData;
      if (!u.alive) {
        u.respawn -= dt;
        if (u.respawn <= 0) {
          u.alive = true;
          u.hp = u.maxHp;
          en.position.copy(u.home);
          en.position.y = groundHeight(en.position.x, en.position.z);
          en.visible = true;
          spawnParticles(en.position.clone().add(new THREE.Vector3(0, 0.5, 0)), 0xbdf5c2, 18, 2.4);
        }
        return;
      }

      const toPlayer = new THREE.Vector3().subVectors(player.pos, en.position);
      toPlayer.y = 0;
      const dist = toPlayer.length();
      if (dist < 19 && dist > 1.75 && state.started) {
        toPlayer.normalize();
        en.position.addScaledVector(toPlayer, dt * 1.15);
        en.rotation.y = dampAngle(en.rotation.y, Math.atan2(toPlayer.x, toPlayer.z), 6, dt);
      }
      en.position.y = groundHeight(en.position.x, en.position.z);

      // 果冻跳动
      const bob = Math.abs(Math.sin(elapsed * 3.2 + u.bobPhase));
      en.position.y += bob * 0.28;
      u.body.scale.set(1 + bob * 0.1, 0.86 - bob * 0.14, 1 + bob * 0.1);
      u.body.position.y = 0.62;
      u.leaf.rotation.z = 0.2 + Math.sin(elapsed * 2.6 + u.bobPhase) * 0.16;

      // Q 弹怪：整只模型做果冻式挤压 / 拉伸
      if (u.mmd) {
        const squash = 1 + bob * 0.18;
        u.mmd.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash));
        u.mmd.position.y = bob * 0.22;
      }

      // 元素附着计时与表现
      if (u.aura) {
        // 用真实时钟计时，避免低帧率把 5.5 秒拉长
        u.auraT = Math.max(0, (u.auraEnd - performance.now()) / 1000);
        if (u.auraT <= 0) {
          u.aura = null;
          u.auraT = 0;
          if (u.auraIcon) u.auraIcon.visible = false;
          if (u.auraShell) u.auraShell.visible = false;
        } else {
          if (u.auraIcon) {
            const s2 = 0.46 + 0.08 * Math.sin(elapsed * 7 + u.bobPhase);
            u.auraIcon.scale.set(s2, s2, 1);
          }
          if (u.auraShell) {
            u.auraShell.visible = true;
            u.auraShell.material.color.setHex(u.aura === 'cryo' ? 0x2f7bff : 0x8236ff);
            u.auraShell.material.opacity = 0.26 + 0.10 * Math.sin(elapsed * 6.5 + u.bobPhase);
            u.auraShell.rotation.y += dt * 0.7;
          }
          if (Math.random() < dt * 7) {
            spawnParticles(
              en.position.clone().add(new THREE.Vector3(rand(-0.45, 0.45), rand(1.0, 1.6), rand(-0.45, 0.45))),
              ELEMENTS[u.aura].color, 1, 1.0, { up: 0.9, grav: -0.5, life: 0.9 }
            );
          }
        }
      }

      // 受击闪光
      if (u.flash > 0) {
        u.flash = Math.max(0, u.flash - dt * 4);
        u.mat.emissiveIntensity = u.flash * 1.4;
        en.scale.setScalar(1 + u.flash * 0.08);
      } else {
        en.scale.setScalar(1);
      }
      if (u.mmdMats) {
        // 附着时整体染色（冰 → 淡蓝，雷 → 淡紫）
        const tint = u.aura && u.auraT > 0
          ? (u.aura === 'cryo' ? AURA_TINT.cryo : AURA_TINT.electro)
          : null;
        for (let mi = 0; mi < u.mmdMats.length; mi++) {
          u.mmdMats[mi].color.copy(u.mmdColors[mi]);
          if (tint) u.mmdMats[mi].color.multiply(tint);
        }
      }
      // MMD 怪：附着时染元素色，否则受击泛红
      if (u.mmdMats) {
        if (u.aura && u.auraT > 0) {
          const pulse = 0.34 + 0.16 * Math.sin(elapsed * 6 + u.bobPhase) + Math.max(0, u.flash) * 0.5;
          for (let mi = 0; mi < u.mmdMats.length; mi++) {
            u.mmdMats[mi].emissive.copy(AURA_EMISSIVE[u.aura]).multiplyScalar(pulse);
          }
        } else {
          const g = 0.14 + Math.max(0, u.flash) * 0.62;
          for (let mi = 0; mi < u.mmdMats.length; mi++) {
            u.mmdMats[mi].emissive.setRGB(g, 0.14, 0.14);
          }
        }
      }

      // 接触造成伤害
      if (state.started && dist < 1.95 && state.hurtCd <= 0) {
        damagePlayer(16);
        state.hurtCd = 1.4;
        // 推开
        const push = new THREE.Vector3().subVectors(en.position, player.pos).setY(0).normalize();
        player.pos.addScaledVector(push, 0.9);
      }
    });

    /* ---------- 浮空岛 ---------- */
    floaters3D.forEach((g) => {
      g.position.y = g.userData.baseY + Math.sin(elapsed * 0.6 + g.userData.phase) * 0.8;
      g.rotation.y += dt * 0.04;
    });

    updateParticles(dt);
    updateEffects(dt);
    updateFloaters(dt);

    /* ---------- 相机 ---------- */
    const off = new THREE.Vector3(
      Math.sin(state.camYaw) * Math.cos(state.camPitch),
      Math.sin(state.camPitch),
      Math.cos(state.camYaw) * Math.cos(state.camPitch)
    ).multiplyScalar(state.camDist);

    // 视线目标抬到胸口以上，坡地也不会只剩下半身
    // 注意：player.pos.y 始终是 0，真实高度要读 root（地形高度 + 跳跃高度）
    const lookY = 1.34;
    const pivot = new THREE.Vector3(player.pos.x, player.root.position.y + lookY, player.pos.z);

    // 沿「角色 → 相机」方向采样地形，被坡挡住时把相机收紧、抬高，直到视线通畅
    let camOff = off.clone();

    // 树 / 石 / 柱挡在相机和角色之间时，把相机沿视线拉近，避免被树冠糊住
    const rayDir = camOff.clone();
    const camLen = rayDir.length();
    rayDir.normalize();
    cameraRay.set(pivot, rayDir);
    cameraRay.far = camLen;
    const blockedHits = cameraRay.intersectObjects(occluders, false);
    if (blockedHits.length && blockedHits[0].distance < camLen - 0.25) {
      const d = Math.max(2.2, blockedHits[0].distance - 0.6);
      camOff.multiplyScalar(d / camLen);
    }

    let wantPos = pivot.clone().add(camOff);
    for (let s = 0; s < 9; s++) {
      const testPos = pivot.clone().add(camOff);
      const camGround = groundHeight(testPos.x, testPos.z) + 1.85;
      if (testPos.y < camGround) testPos.y = camGround;
      let blocked = false;
      for (let i = 1; i <= 5; i++) {
        const k = i / 6;
        const sx = pivot.x + (testPos.x - pivot.x) * k;
        const sz = pivot.z + (testPos.z - pivot.z) * k;
        const sy = pivot.y + (testPos.y - pivot.y) * k;
        if (sy < groundHeight(sx, sz) + 0.55) { blocked = true; break; }
      }
      wantPos = testPos;
      if (!blocked) break;
      // 收近 + 抬高，绕开坡体
      camOff.multiplyScalar(0.82);
      camOff.y += 1.1 + s * 0.22;
    }
    // 最终保险：不陷进地面
    const finalGround = groundHeight(wantPos.x, wantPos.z) + 1.55;
    if (wantPos.y < finalGround) wantPos.y = finalGround;

    const shakeAmp = state.shake * 0.22;
    wantPos.x += rand(-1, 1) * shakeAmp;
    wantPos.z += rand(-1, 1) * shakeAmp;

    camPos.lerp(wantPos, 1 - Math.exp(-7.5 * dt));
    camera.position.copy(camPos);

    // 地形抬升时测量相机是否被地面顶起，视线目标再上抬一点补偿
    const camGroundNow = groundHeight(camera.position.x, camera.position.z) + 1.2;
    if (camera.position.y < camGroundNow) camera.position.y = camGroundNow;

    const wantLook = new THREE.Vector3(player.pos.x, player.root.position.y + lookY, player.pos.z);
    state.lookAt.lerp(wantLook, 1 - Math.exp(-9 * dt));
    camera.lookAt(state.lookAt);

    /* ---------- 阳光跟随 ---------- */
    sun.position.set(player.pos.x + 26, player.pos.y + 34, player.pos.z + 16);
    sun.target.position.set(player.pos.x, player.pos.y, player.pos.z);
    sun.target.updateMatrixWorld();

    updateHUD();
  }

  /* =========================================================
     13. HUD 刷新
     ========================================================= */
  function updateHUD() {
    // 队伍卡片
    ui.cards.forEach((c, i) => {
      const st = state.characters[i];
      const pct = Math.round((st.hp / st.maxHp) * 100);
      if (pct !== c.pct) {
        c.pct = pct;
        c.hp.style.width = pct + '%';
        c.hp.classList.toggle('is-low', pct <= 30);
      }
      const shouldActive = i === state.active;
      if (c.isActive !== shouldActive) {
        c.isActive = shouldActive;
        c.card.classList.toggle('is-active', shouldActive);
      }
    });

    // 技能冷却
    const cdPct = Math.round((state.skillCd / CFG.skillCd) * 100);
    if (cdPct !== ui.cdCache) {
      ui.cdCache = cdPct;
      ui.skillCdEl.style.setProperty('--cd', cdPct);
      ui.skillCdEl.classList.toggle('is-on', cdPct > 0);
    }

    // 体力
    const stamPct = Math.round((state.stamina / CFG.staminaMax) * 100);
    if (stamPct !== ui.stamCache) {
      ui.stamCache = stamPct;
      ui.stamRing.style.setProperty('--stam', stamPct);
      ui.stamRing.classList.toggle('is-empty', stamPct < 10);
    }
    const stamOn = state.sprinting || stamPct < 100;
    if (stamOn !== ui.stamOn) {
      ui.stamOn = stamOn;
      ui.stamRing.classList.toggle('is-on', stamOn);
    }

    // 能量 / 爆发就绪
    const enPct = Math.round(state.energy);
    if (enPct !== ui.energyCache) {
      ui.energyCache = enPct;
      ui.burstEnergy.style.setProperty('--energy', enPct);
    }
    const ready = state.energy >= CFG.energyMax - 0.5;
    if (ready !== ui.burstReady) {
      ui.burstReady = ready;
      ui.burstBtn.classList.toggle('is-ready', ready);
    }
  }

  /* =========================================================
     14. 渲染循环
     ========================================================= */
  let last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
    last = now;
    update(dt, now / 1000);
    renderer.render(scene, camera);
  }
  requestAnimationFrame(loop);

  /* =========================================================
     15. 自适应
     ========================================================= */
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 260));

  /* =========================================================
     16. 开场
     ========================================================= */
  /* ---------- 启动加载：全屏图轮播 + 真实进度 ---------- */
  const bootEl = document.getElementById('boot');
  const bootStage = document.getElementById('boot-stage');
  const bootFill = document.getElementById('boot-fill');
  const bootPct = document.getElementById('boot-pct');
  const bootTip = document.getElementById('boot-tip');
  const bootSlides = bootStage ? Array.from(bootStage.querySelectorAll('.boot-slide')) : [];
  // 前两张各 1s，其余 0.5s，循环直到模型加载完毕
  const BOOT_DURS = [1000, 1000, 500, 500, 500];
  let bootIdx = 0;
  let bootTimer = 0;
  let bootDone = false;
  let bootProgress = 0;

  function showBootSlide(i) {
    bootSlides.forEach((s, k) => s.classList.toggle('is-on', k === i));
  }
  function nextBootSlide() {
    if (bootDone) return;
    bootIdx = (bootIdx + 1) % Math.max(1, bootSlides.length);
    showBootSlide(bootIdx);
    bootTimer = setTimeout(nextBootSlide, BOOT_DURS[bootIdx]);
  }
  if (bootSlides.length) {
    showBootSlide(0);
    bootTimer = setTimeout(nextBootSlide, BOOT_DURS[0]);
  }

  const bootTick = setInterval(() => {
    if (bootDone) return;
    bootProgress = Math.min(90, bootProgress + Math.max(0.35, (90 - bootProgress) * 0.022));
    if (bootFill) bootFill.style.width = bootProgress.toFixed(1) + '%';
    if (bootPct) bootPct.textContent = Math.floor(bootProgress) + '%';
    if (bootTip && mmdDone.n > 0) bootTip.textContent = '正在载入 3D 模型 ' + mmdDone.n + ' / ' + mmdDone.total;
  }, 180);

  function finishBoot() {
    if (bootDone) return;
    bootDone = true;
    clearTimeout(bootTimer);
    clearInterval(bootTick);
    bootProgress = 100;
    if (bootFill) bootFill.style.width = '100%';
    if (bootPct) bootPct.textContent = '100%';
    if (bootTip) bootTip.textContent = '加载完成';
    setTimeout(() => {
      if (bootEl) bootEl.classList.add('is-hidden');
      ui.startBtn.disabled = false;
      ui.startBtn.textContent = '进入提瓦特';
    }, 420);
  }

  // file:// 打开时模型必被拦截，直接在开始面板说明原因
  if (location.protocol === 'file:') {
    const warn = document.getElementById('file-warn');
    if (warn) warn.hidden = false;
    if (ui.startBtn) ui.startBtn.textContent = '请用本地服务器打开';
  }

  ui.startBtn.textContent = '正在载入角色模型…';

  ui.startBtn.addEventListener('click', () => {
    if (ui.startBtn.disabled) return;
    state.started = true;
    ui.start.classList.add('is-hidden');
    toast('WASD 移动 · 拖动画面转视角 · E / Q 释放技能', 2600);
    // 初始给一点能量，方便直接体验爆发
    state.energy = 40;
    spawnRing(player.pos.clone(), accentColor().color, 3.2, 0.9);
    spawnParticles(player.pos.clone().add(new THREE.Vector3(0, 1, 0)), accentColor().color, 30, 3.6);
  });

  // 开局先给玩家一个好看的镜头
  (function introCamera() {
    const off = new THREE.Vector3(
      Math.sin(state.camYaw) * Math.cos(0.36),
      Math.sin(0.3),
      Math.cos(state.camYaw) * Math.cos(0.3)
    ).multiplyScalar(11);
    camPos.copy(player.pos.clone().add(off).add(new THREE.Vector3(0, 2, 0)));
    camera.position.copy(camPos);
    state.lookAt.copy(player.pos).add(new THREE.Vector3(0, 1.6, 0));
    camera.lookAt(state.lookAt);
  })();

  window.__TEYVAT_DEBUG = { scene, world, enemies, state, mmdPlayers, mmdVerity, player, camera, renderer, THREE, occluders, cameraRay, groundHeight };
})();
