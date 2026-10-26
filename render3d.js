// 3D-rendering med three.js. Spelet räknar fortfarande i samma 2D-koordinater som förut
// (x åt höger, y nedåt, golvet på FLOOR) — den här filen översätter bara varje bildruta till
// en 3D-scen: x blir X, höjden över golvet blir Y, och djupet Z är rent utseende. Simuleringen
// (och därmed vänmatcherna) påverkas inte alls. Saknas WebGL eller three.js ger init() null
// och game.js ritar med den gamla 2D-koden i stället.
(function () {
  'use strict';
  const W = 960;
  const H = 540;
  const FLOOR = 450;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const wx = (x) => x - W / 2;
  const wy = (y) => FLOOR - y;

  // ---------- Robotmodellen ----------
  // Byggs ur samma def som 2D-roboten: färger, huvudform, extra. Framåt är +X lokalt, upp är +Y,
  // fötterna står på Y = 0. Måtten är samma "pixlar" som i 2D-ritningen.
  function makeMaterials(def) {
    const std = (color) => new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.45 });
    return {
      body: std(def.color),
      dark: std(def.accent),
      eye: new THREE.MeshBasicMaterial({ color: def.eye }),
      gold: std('#ffd93d'),
      glow: new THREE.MeshBasicMaterial({ color: def.eye, transparent: true, opacity: 0.7, depthWrite: false }),
    };
  }

  function mesh(geo, mat, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    return m;
  }

  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const sphere = (r) => new THREE.SphereGeometry(r, 20, 14);
  const cyl = (rt, rb, h, seg = 16) => new THREE.CylinderGeometry(rt, rb, h, seg);
  const cone = (r, h, seg = 12) => new THREE.ConeGeometry(r, h, seg);

  function questionSprite(color) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const c = cv.getContext('2d');
    c.font = 'bold 54px ui-monospace, Menlo, monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = color;
    c.shadowBlur = 8;
    c.fillStyle = color;
    c.fillText('?', 32, 34);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true }));
    s.scale.set(36, 36, 1);
    return s;
  }

  function buildHead(def, M, root) {
    const head = new THREE.Group();
    root.add(head);
    const visor = (x, y, w, h, d) => head.add(mesh(box(w, h, d), M.eye, x, y, 0));
    switch (def.head) {
      case 'box':
        head.add(mesh(box(30, 26, 28), M.body, 0, 109, 0));
        visor(14, 109.5, 4, 9, 20);
        break;
      case 'dome': {
        const g = new THREE.SphereGeometry(18, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
        head.add(mesh(g, M.body, 0, 96, 0));
        visor(13, 105, 6, 7, 16);
        break;
      }
      case 'round':
        head.add(mesh(sphere(15), M.body, 0, 110, 0));
        head.add(mesh(sphere(5), M.eye, 12, 110, 0));
        break;
      case 'cyclops':
        head.add(mesh(box(32, 26, 28), M.body, 0, 109, 0));
        const ring = mesh(cyl(9, 9, 4), M.dark, 16, 109, 0);
        ring.rotation.z = Math.PI / 2;
        head.add(ring);
        head.add(mesh(sphere(6), M.eye, 18, 109, 0));
        break;
      case 'horn': {
        head.add(mesh(box(30, 24, 26), M.body, 0, 108, 0));
        visor(14, 108, 4, 8, 18);
        for (const z of [-8, 8]) {
          const h = mesh(cone(4, 18), M.dark, -2, 128, z);
          h.rotation.x = z > 0 ? 0.25 : -0.25;
          head.add(h);
        }
        break;
      }
      case 'crown': {
        head.add(mesh(sphere(15), M.body, 0, 110, 0));
        visor(12, 112, 6, 6, 14);
        const gold = M.gold;
        head.add(mesh(cyl(12, 12, 6), gold, 0, 124, 0));
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          head.add(mesh(cone(3.5, 12, 6), gold, Math.cos(a) * 10, 132, Math.sin(a) * 10));
        }
        break;
      }
      default: { // huva
        const g = mesh(cone(19, 40, 16), M.dark, -2, 114, 0);
        g.rotation.z = 0.25;
        head.add(g);
        visor(13, 111, 4, 5, 16);
      }
    }
    return head;
  }

  // Bygger en robot. Returnerar en "rigg" med alla delar som poseRobot() rör på.
  function buildRobot(def) {
    const M = makeMaterials(def);
    const root = new THREE.Group();
    const inner = new THREE.Group(); // skala + tippning (skadad, död)
    root.add(inner);

    const legs = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(0, 40, side * 11);
      pivot.add(mesh(box(12, 34, 12), M.dark, 0, -17, 0));
      pivot.add(mesh(box(22, 10, 16), M.body, 3, -35, 0));
      inner.add(pivot);
      legs.push({ pivot, side });
    }

    const upper = new THREE.Group(); // allt ovanför benen, gungar lite när den står still
    inner.add(upper);
    upper.add(mesh(box(44, 58, 34), M.body, 0, 67, 0));
    upper.add(mesh(box(4, 22, 24), M.dark, 22, 77, 0));
    const core = mesh(sphere(5), M.eye, 24, 77, 0);
    upper.add(core);

    const arm = (z, mat) => {
      const pivot = new THREE.Group();
      pivot.position.set(2, 88, z);
      const limb = mesh(cyl(5, 5, 40, 10), mat, 0, -20, 0);
      const fist = mesh(sphere(7), mat, 0, -40, 0);
      pivot.add(limb, fist);
      upper.add(pivot);
      return { pivot, limb, fist };
    };
    const back = arm(-24, M.dark);
    const front = arm(24, M.body);

    switch (def.extra) {
      case 'cannon': {
        const g = new THREE.Group();
        g.position.set(-16, 96, -6);
        g.rotation.z = 0.5;
        g.add(mesh(cyl(7, 7, 34), M.dark, 0, 15, 0));
        g.add(mesh(cyl(4, 4, 4), M.eye, 0, 33, 0));
        upper.add(g);
        break;
      }
      case 'jet':
        upper.add(mesh(box(14, 38, 26), M.dark, -28, 77, 0));
        break;
      case 'spikes':
        for (let k = 0; k < 3; k++) {
          const s = mesh(cone(7, 18, 8), M.dark, -30, 88 - k * 16, 0);
          s.rotation.z = Math.PI / 2;
          upper.add(s);
        }
        break;
      case 'question': {
        const s = questionSprite(def.eye);
        s.position.set(26, 72, 0);
        upper.add(s);
        break;
      }
      case 'shoulders':
        for (const z of [-22, 22]) upper.add(mesh(box(22, 18, 16), M.dark, 0, 93, z));
        break;
      case 'shield': {
        const g = new THREE.Group();
        g.position.set(28, 64, 30);
        const disc = mesh(cyl(17, 17, 5, 24), M.dark);
        disc.rotation.z = Math.PI / 2;
        const ring = mesh(new THREE.TorusGeometry(17, 2, 8, 24), M.body);
        ring.rotation.y = Math.PI / 2;
        const boss = mesh(sphere(5), M.eye, 3, 0, 0);
        g.add(disc, ring, boss);
        upper.add(g);
        break;
      }
      default:
    }

    let cape = null;
    if (def.extra === 'cape') {
      cape = new THREE.Group();
      cape.position.set(-18, 96, 0);
      cape.add(mesh(box(3, 66, 38), M.dark, 0, -33, 0));
      upper.add(cape);
    }
    let flame = null;
    if (def.extra === 'jet') {
      flame = mesh(cone(6, 16, 10), M.eye, -28, 50, 0);
      flame.rotation.z = Math.PI;
      upper.add(flame);
    }

    const head = buildHead(def, M, upper);
    if (def.extra === 'antenna') {
      const rod = mesh(cyl(1.5, 1.5, 18, 6), M.dark, -6, 131, 0);
      rod.rotation.z = 0.25;
      head.add(rod);
      head.add(mesh(sphere(4), M.eye, -8, 141, 0));
    } else if (def.extra === 'fins') {
      const f = mesh(cone(9, 26, 4), M.dark, -20, 118, 0);
      f.rotation.z = Math.PI / 2 + 0.4;
      f.scale.z = 0.25;
      head.add(f);
    }

    const glow = new THREE.Mesh(sphere(1), M.glow);
    upper.add(glow);

    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    glow.castShadow = false;
    return { def, root, inner, upper, legs, back, front, core, cape, flame, glow, M };
  }

  const SIL_BODY = new THREE.Color('#232c4a');
  const SIL_DARK = new THREE.Color('#1a2240');
  const WHITE = new THREE.Color('#ffffff');
  const FLASH_DARK = new THREE.Color('#e6e6e6');

  // Samma pose-fält som 2D-ritningen tar emot (se fighterPose() i game.js).
  function poseRobot(rig, p, yaw) {
    const { def, M } = rig;
    const sil = !!p.silhouette;
    const flash = p.flash > 0;
    M.body.color.set(sil ? SIL_BODY : flash ? WHITE : def.color);
    M.dark.color.set(sil ? SIL_DARK : flash ? FLASH_DARK : def.accent);
    M.eye.color.set(sil ? SIL_BODY : def.eye);
    M.gold.color.set(sil ? SIL_BODY : '#ffd93d');
    M.glow.color.set(def.eye);
    const alpha = p.alpha === undefined ? 1 : p.alpha;
    for (const k of ['body', 'dark', 'eye', 'gold']) {
      M[k].transparent = alpha < 1;
      M[k].opacity = alpha;
    }

    const t = p.time || 0;
    const air = !!p.air;
    rig.root.position.set(wx(p.x), wy(p.y), p.z || 0);
    // Roboten tittar mot motståndaren (även snett i djupled), plus en liten vridning mot
    // kameran så att man ser den snett framifrån, inte rakt från sidan.
    if (yaw === undefined) {
      const ax = p.aimX !== undefined ? p.aimX : p.facing;
      const az = p.aimZ || 0;
      const face = Math.atan2(-az, Math.abs(ax) < 1 ? p.facing : ax);
      yaw = face + (Math.cos(face) >= 0 ? -0.35 : 0.35);
    }
    rig.root.rotation.y = yaw;
    rig.inner.scale.setScalar(def.scale);
    rig.inner.rotation.z = p.dead ? 1.35 : p.hurt ? 0.16 : 0;

    const swing = air ? 0.5 : p.moving ? Math.sin((p.walkT || 0) * 12) * 0.6 : 0;
    const bob = p.moving || air ? 0 : Math.sin(t * 3) * 1.5;
    for (const leg of rig.legs) leg.pivot.rotation.z = -swing * leg.side;
    rig.upper.position.y = bob;

    let front = -0.15 - swing * 0.8;
    let back = 0.15 + swing * 0.8;
    let frontLen = 40;
    let glow = 0;
    if (p.actKind === 'punch') {
      const ext = Math.sin(Math.PI * clamp(p.actT / (p.actDur * 0.9), 0, 1));
      front = lerp(-0.15, -1.55, ext);
      frontLen = 40 + 24 * ext;
    } else if (p.actKind === 'special') {
      front = -1.5;
      back = -1.3;
      glow = clamp(p.actT / p.actDur, 0, 1);
    }
    // 2D vrider medurs med y nedåt; i 3D med y uppåt blir samma vinkel spegelvänd.
    rig.front.pivot.rotation.z = -front;
    rig.back.pivot.rotation.z = -back;
    rig.front.limb.scale.y = frontLen / 40;
    rig.front.limb.position.y = -frontLen / 2;
    rig.front.fist.position.y = -frontLen;

    rig.core.scale.setScalar(p.ready ? 1.4 : 1);
    if (rig.cape) rig.cape.rotation.z = 0.35 + Math.sin(t * 6) * 0.06;
    if (rig.flame) rig.flame.scale.y = 1 + Math.sin(t * 30) * 0.3;

    rig.glow.visible = glow > 0;
    if (glow > 0) {
      rig.glow.position.set(2 + 50, 88, 24);
      rig.glow.scale.setScalar(6 + glow * 16);
      M.glow.opacity = (0.55 + 0.4 * Math.sin(t * 40)) * alpha;
    }
  }

  // Roboten byggs om bara när något som syns i modellen ändras (t.ex. jokerns huvud).
  const rigKey = (def) => [def.id, def.head, def.extra, def.color, def.accent, def.eye, def.scale].join('|');

  // ---------- Arenan ----------
  function gradientTexture(top, bottom) {
    const cv = document.createElement('canvas');
    cv.width = 4;
    cv.height = 256;
    const c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    c.fillStyle = g;
    c.fillRect(0, 0, 4, 256);
    return new THREE.CanvasTexture(cv);
  }

  function floorTexture(arena) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const c = cv.getContext('2d');
    c.fillStyle = arena.ground;
    c.fillRect(0, 0, 256, 256);
    c.strokeStyle = arena.line;
    c.globalAlpha = 0.8;
    c.lineWidth = 3;
    c.strokeRect(0, 0, 256, 256);
    c.globalAlpha = 0.3;
    c.lineWidth = 1;
    c.strokeRect(64, 64, 128, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(16, 13);
    return tex;
  }

  function windowsTexture(seedStart) {
    const cv = document.createElement('canvas');
    cv.width = 64;
    cv.height = 128;
    const c = cv.getContext('2d');
    c.fillStyle = '#000000';
    c.fillRect(0, 0, 64, 128);
    let seed = seedStart;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    c.fillStyle = '#ffd978';
    for (let y = 6; y < 122; y += 12) {
      for (let x = 5; x < 60; x += 10) if (rnd() < 0.35) c.fillRect(x, y, 5, 7);
    }
    return new THREE.CanvasTexture(cv);
  }

  function buildArena(arena) {
    const g = new THREE.Group();
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 3200),
      new THREE.MeshStandardMaterial({ map: floorTexture(arena), metalness: 0.2, roughness: arena.id === 'ice' ? 0.15 : 0.8 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -100;
    floor.receiveShadow = true;
    g.add(floor);

    // En lysande kant längs själva kampbanan, där golvlinjen satt i 2D.
    const edge = new THREE.Mesh(box(W + 40, 3, 4), new THREE.MeshBasicMaterial({ color: arena.line }));
    edge.position.set(0, 1.5, 140);
    g.add(edge);
    const back = new THREE.Mesh(box(W + 40, 3, 4), new THREE.MeshBasicMaterial({ color: arena.line }));
    back.position.set(0, 1.5, -140);
    g.add(back);

    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (const row of [{ z: -700, n: 22, base: 0.55 }, { z: -1100, n: 26, base: 0.35 }]) {
      for (let x = -1600; x < 1600;) {
        const bw = 60 + rnd() * 110;
        const bh = 120 + rnd() * 380;
        const bd = 60 + rnd() * 80;
        const mat = new THREE.MeshStandardMaterial({
          color: arena.line, emissive: '#ffffff', emissiveMap: windowsTexture(1 + Math.floor(rnd() * 9999)),
          emissiveIntensity: row.base, roughness: 0.9,
        });
        mat.color.multiplyScalar(0.3);
        const b = new THREE.Mesh(box(bw, bh, bd), mat);
        b.position.set(x + bw / 2, bh / 2, row.z - rnd() * 80);
        g.add(b);
        x += bw + 8;
      }
    }
    return g;
  }

  // ---------- Effekter (pooler: samma meshar återanvänds varje bildruta) ----------
  function makePool(scene, factory) {
    const items = [];
    let used = 0;
    return {
      get() {
        if (used >= items.length) { const m = factory(); scene.add(m); items.push(m); }
        const m = items[used++];
        m.visible = true;
        return m;
      },
      finish() {
        for (let i = used; i < items.length; i++) items[i].visible = false;
        used = 0;
      },
    };
  }

  const basic = (color, opacity = 1, additive = false) => new THREE.MeshBasicMaterial({
    color, transparent: opacity < 1 || additive, opacity, depthWrite: !(opacity < 1 || additive),
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });

  function createLights(scene) {
    const hemi = new THREE.HemisphereLight('#b8c8ff', '#202030', 0.75);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight('#ffffff', 0.95);
    sun.position.set(-300, 700, 600);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -650, right: 650, top: 500, bottom: -200, near: 100, far: 2000 });
    scene.add(sun);
    const rim = new THREE.DirectionalLight('#7fb0ff', 0.45);
    rim.position.set(400, 300, -500);
    scene.add(rim);
    return { hemi, sun, rim };
  }

  function init(canvas3d) {
    if (typeof THREE === 'undefined' || !canvas3d) return null;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas3d, antialias: true });
    } catch (e) {
      return null;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const FOV = 34;
    const camera = new THREE.PerspectiveCamera(FOV, W / H, 10, 6000);
    // Kameran följer kämparna: den siktar mitt emellan dem och går närmare ju närmare de står
    // varandra, men aldrig så nära att någon av dem hamnar utanför bild.
    const cam = { x: 0, dist: 1080 };
    const halfWidthPerDist = Math.tan((FOV / 2) * Math.PI / 180) * (W / H);
    function aimCamera(fighters, dt) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const { f } of fighters) { lo = Math.min(lo, wx(f.x)); hi = Math.max(hi, wx(f.x)); }
      let x = 0;
      let dist = 1080;
      if (lo <= hi) {
        x = (lo + hi) / 2;
        dist = clamp(((hi - lo) / 2 + 160) / halfWidthPerDist, 620, 1080);
        // Kanterna på banan ska aldrig hamna innanför bild: håll kameran inom det x:et tillåter.
        const room = Math.max(0, W / 2 + 40 - dist * halfWidthPerDist);
        x = clamp(x, -room, room);
      }
      const k = 1 - Math.exp(-dt * 4);
      cam.x += (x - cam.x) * k;
      cam.dist += (dist - cam.dist) * k;
      const lookY = lerp(95, 110, (cam.dist - 620) / 460);
      camera.position.set(cam.x, lookY + cam.dist * 0.13, cam.dist);
      camera.lookAt(cam.x, lookY, 0);
    }
    let lastT = performance.now();
    const lights = createLights(scene);

    const arenas = {};
    let currentArena = null;
    function setArena(arena) {
      if (currentArena === arena.id) return;
      if (currentArena) arenas[currentArena].group.visible = false;
      if (!arenas[arena.id]) {
        const group = buildArena(arena);
        scene.add(group);
        arenas[arena.id] = { group, sky: gradientTexture('#0a1024', arena.sky), fog: new THREE.Fog(arena.sky, 1300, 2700) };
      }
      const a = arenas[arena.id];
      a.group.visible = true;
      scene.background = a.sky;
      scene.fog = a.fog;
      lights.hemi.groundColor.set(arena.line);
      currentArena = arena.id;
    }

    // Robotar per kämpe (ett Fighter-objekt), plus spökkopior för dash.
    const rigs = new Map();
    function rigFor(owner, slot, def) {
      let byOwner = rigs.get(owner);
      if (!byOwner) { byOwner = {}; rigs.set(owner, byOwner); }
      const key = rigKey(def);
      let rig = byOwner[slot];
      if (!rig || rig.key !== key) {
        if (rig) scene.remove(rig.root);
        rig = buildRobot(def);
        rig.key = key;
        scene.add(rig.root);
        byOwner[slot] = rig;
      }
      rig.used = true;
      rig.root.visible = true;
      return rig;
    }

    const bubble = (color, op) => () => new THREE.Mesh(sphere(1), basic(color, op));
    const pools = {
      buff: makePool(scene, () => new THREE.Mesh(sphere(1), new THREE.MeshBasicMaterial({ color: '#ff4632', wireframe: true, transparent: true, opacity: 0.6 }))),
      reflect: makePool(scene, bubble('#c8ffeb', 0.25)),
      frozen: makePool(scene, bubble('#a0e1ff', 0.55)),
      shield: makePool(scene, bubble('#5fd6c0', 0.28)),
      laser: makePool(scene, () => new THREE.Mesh(box(1, 2, 2), basic('#ff3232', 0.6))),
      marker: makePool(scene, () => { const m = new THREE.Mesh(cone(9, 16, 4), basic('#35d0ff')); m.rotation.z = Math.PI; return m; }),
      projOuter: makePool(scene, () => new THREE.Mesh(sphere(1), basic('#ffffff', 0.85, true))),
      projInner: makePool(scene, () => new THREE.Mesh(sphere(1), basic('#ffffff'))),
      beamOuter: makePool(scene, () => { const m = new THREE.Mesh(cyl(1, 1, 1), basic('#ffffff', 0.8, true)); m.rotation.z = Math.PI / 2; return m; }),
      beamInner: makePool(scene, () => { const m = new THREE.Mesh(cyl(1, 1, 1), basic('#ffffff', 1, true)); m.rotation.z = Math.PI / 2; return m; }),
      strikeRing: makePool(scene, () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32), basic('#ff5a8c', 0.8)); m.rotation.x = -Math.PI / 2; return m; }),
      strikeColumn: makePool(scene, () => new THREE.Mesh(cyl(34, 34, 700, 20), basic('#ffc8e6', 0.85, true))),
      wave: makePool(scene, () => new THREE.Mesh(cone(16, 34, 8), basic('#ffbe5a', 0.85))),
      cloud: makePool(scene, () => new THREE.Mesh(sphere(1), basic('#8fe05a', 0.5))),
      mine: makePool(scene, () => new THREE.Mesh(cyl(14, 14, 6, 16), new THREE.MeshStandardMaterial({ color: '#888888' }))),
      mineLight: makePool(scene, () => new THREE.Mesh(sphere(4), basic('#ffd93d'))),
      particle: makePool(scene, () => new THREE.Mesh(box(5, 5, 5), basic('#ffffff', 1))),
      halo: makePool(scene, () => { const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.035, 8, 64), basic('#fff3b0', 0.9, true)); m.rotation.x = -Math.PI / 2; return m; }),
      haloWall: makePool(scene, () => new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 30, 64, 1, true), basic('#ffe36b', 0.35, true))),
      quake: makePool(scene, () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), basic('#caa968', 0.8, true)); m.rotation.x = -Math.PI / 2; return m; }),
      holeCore: makePool(scene, () => new THREE.Mesh(sphere(1), new THREE.MeshBasicMaterial({ color: '#000000' }))),
      holeRing: makePool(scene, () => new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 8, 40), basic('#b46bff', 0.85, true))),
      holeDisc: makePool(scene, () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.3, 1, 40), basic('#5a1fa8', 0.45, true)); m.rotation.x = -Math.PI / 2; return m; }),
    };

    function fighterEffects(f, isPlayer) {
      const cx = wx(f.x);
      const cy = wy(f.y - f.h / 2);
      const cz = f.z || 0;
      const ell = (pool, sx, sy, color) => {
        const m = pool.get();
        m.position.set(cx, cy, cz);
        m.scale.set(f.w * sx, f.h * sy, f.w * sx);
        if (color) m.material.color.set(color);
        return m;
      };
      if (f.buffT > 0) ell(pools.buff, 0.9, 0.62).material.opacity = 0.45 + 0.25 * Math.sin(f.time * 14);
      if (f.reflectT > 0) ell(pools.reflect, 0.95, 0.6).material.opacity = 0.18 + 0.12 * Math.sin(f.time * 20);
      if (f.frozenT > 0) ell(pools.frozen, 0.85, 0.58);
      if (f.shieldT > 0) ell(pools.shield, 0.95, 0.6);
      const a = f.act;
      if (a && f.def.special.type === 'snipe' && a.t < 0.85) {
        const m = pools.laser.get();
        const x0 = wx(f.x + f.facing * (f.w / 2));
        m.scale.set(900, 1, 1);
        m.position.set(x0 + f.facing * 450, wy(f.y - f.h * 0.55), cz);
        m.material.opacity = 0.25 + 0.6 * (a.t / 0.85);
      }
      if (isPlayer && !f.dead) {
        const m = pools.marker.get();
        m.position.set(cx, wy(f.y - f.h - 22), cz);
        m.rotation.y = f.time * 3;
      }
    }

    function drawFighter(entry) {
      const { f, pose } = entry;
      if (f.dashT > 0) {
        for (let i = 1; i <= 3; i++) {
          poseRobot(rigFor(f, `ghost${i}`, f.def), { ...pose, x: f.x - f.facing * i * 32, alpha: 0.28 / i, flash: 0 });
        }
      }
      if (f.act && f.act.kind === 'special' && f.def.special.type === 'teleport') {
        const t = f.act.t;
        pose.alpha = t < 0.25 ? 1 - (t / 0.25) * 0.95 : Math.min(1, 0.05 + (t - 0.25) / 0.15);
      }
      poseRobot(rigFor(f, 'main', f.def), pose);
      fighterEffects(f, entry.isPlayer);
    }

    function drawProjectiles(s) {
      for (const p of s.projectiles || []) {
        const o = pools.projOuter.get();
        o.position.set(wx(p.x), wy(p.y), p.z || 0);
        o.scale.setScalar(p.r * 1.25);
        o.material.color.set(p.color);
        const i = pools.projInner.get();
        i.position.copy(o.position);
        i.scale.setScalar(p.r * 0.5);
      }
      for (const b of s.beams || []) {
        const a = clamp(b.t / b.max, 0, 1);
        const len = Math.abs(b.x1 - b.x0);
        const mid = wx((b.x0 + b.x1) / 2);
        const o = pools.beamOuter.get();
        o.position.set(mid, wy(b.y), b.z || 0);
        o.scale.set(7, len, 7);
        o.material.color.set(b.color);
        o.material.opacity = a * 0.8;
        const i = pools.beamInner.get();
        i.position.copy(o.position);
        i.scale.set(2.5, len, 2.5);
        i.material.opacity = a;
      }
      for (const st of s.strikes || []) {
        if (!st.done) {
          const k = clamp(st.t / st.delay, 0, 1);
          const m = pools.strikeRing.get();
          m.position.set(wx(st.x), 2, st.z || 0);
          m.scale.setScalar(46 * (0.4 + 0.6 * k));
          m.material.opacity = 0.35 + 0.5 * k;
        } else {
          const m = pools.strikeColumn.get();
          m.position.set(wx(st.x), 350, st.z || 0);
          m.material.opacity = clamp(1 - (st.t - st.delay) / 0.25, 0, 1) * 0.85;
        }
      }
      for (const w of s.waves || []) {
        const m = pools.wave.get();
        m.position.set(wx(w.x), 17, w.z || 0);
        m.rotation.z = -w.dir * 0.35;
      }
      for (const c of s.clouds || []) {
        const m = pools.cloud.get();
        m.position.set(wx(c.x), 30, c.z || 0);
        m.scale.set(c.r, 34, c.r * 0.8);
        m.material.opacity = clamp(c.life / 3, 0.25, 0.7) * 0.75;
      }
      for (const mi of s.mines || []) {
        const m = pools.mine.get();
        m.position.set(wx(mi.x), 3, mi.z || 0);
        m.material.color.set(mi.color);
        const l = pools.mineLight.get();
        l.position.set(wx(mi.x), 8, mi.z || 0);
        l.material.color.set(mi.armT <= 0 && Math.sin(mi.life * 14) > 0 ? '#ff3030' : '#ffd93d');
      }
      for (const h of s.halos || []) {
        const fade = clamp(1 - h.r / h.max, 0, 1);
        const ring = pools.halo.get();
        ring.position.set(wx(h.x), 3, h.z || 0);
        ring.scale.setScalar(h.r);
        ring.material.opacity = 0.9 * fade + 0.1;
        const wall = pools.haloWall.get();
        wall.position.set(wx(h.x), 15, h.z || 0);
        wall.scale.set(h.r, 1, h.r);
        wall.material.opacity = 0.35 * fade;
      }
      for (const q of s.quakes || []) {
        // En ring som rusar ut från Atlas vid varje skalv, över hela banan.
        for (let i = 0; i < q.i; i++) {
          const age = q.t - q.ticks[i];
          if (age > 0.6) continue;
          const m = pools.quake.get();
          m.position.set(wx(q.x), 2 + i * 0.3, q.z || 0);
          m.scale.setScalar(60 + age * 1600);
          m.material.opacity = 0.8 * (1 - age / 0.6);
        }
      }
      for (const h of s.holes || []) {
        const grow = clamp((h.max - h.life) / 0.3, 0, 1);
        const y = 60;
        const core = pools.holeCore.get();
        core.position.set(wx(h.x), y, h.z || 0);
        core.scale.setScalar(26 * grow);
        const ring = pools.holeRing.get();
        ring.position.copy(core.position);
        ring.scale.setScalar(44 * grow);
        ring.rotation.set(1.2, h.life * 6, 0);
        const disc = pools.holeDisc.get();
        disc.position.set(wx(h.x), 2, h.z || 0);
        disc.scale.setScalar(120 * grow);
        disc.rotation.z = h.life * 3;
      }
      for (const p of s.particles || []) {
        const m = pools.particle.get();
        m.position.set(wx(p.x), wy(p.y), (p.z || 0));
        m.material.color.set(p.color);
        m.material.opacity = clamp(p.life / p.max, 0, 1);
        m.material.transparent = true;
        m.rotation.set(p.life * 9, p.life * 7, 0);
      }
    }

    // s: { arena, shake, fighters: [{ f, pose, isPlayer }], projectiles, beams, ... }
    function render(s) {
      setArena(s.arena);
      for (const byOwner of rigs.values()) for (const k in byOwner) { byOwner[k].used = false; }
      for (const entry of s.fighters || []) drawFighter(entry);
      drawProjectiles(s);
      // Kämpar som inte längre finns med (förra matchen) göms och släpps.
      for (const [owner, byOwner] of rigs) {
        let any = false;
        for (const k in byOwner) {
          if (byOwner[k].used) any = true;
          else byOwner[k].root.visible = false;
        }
        if (!any) {
          for (const k in byOwner) scene.remove(byOwner[k].root);
          rigs.delete(owner);
        }
      }
      for (const p of Object.values(pools)) p.finish();

      const now = performance.now();
      aimCamera(s.fighters || [], Math.min((now - lastT) / 1000, 0.1));
      lastT = now;
      if (s.shake > 0) {
        camera.position.x += (Math.random() * 2 - 1) * s.shake * 24;
        camera.position.y += (Math.random() * 2 - 1) * s.shake * 24;
      }
      renderer.render(scene, camera);
    }

    // Var på skärmen (i spelets 960x540-koordinater) en spelpunkt hamnar, för text ovanpå 3D:n.
    const tmp = new THREE.Vector3();
    function project(x, y) {
      tmp.set(wx(x), wy(y), 0).project(camera);
      return { x: (tmp.x + 1) * W / 2, y: (1 - tmp.y) * H / 2 };
    }

    // ---------- Kort: en egen liten renderare som ritar robotar till kortens 2D-canvasar ----------
    let card = null;
    function cardRenderer() {
      if (card) return card;
      const cv = document.createElement('canvas');
      const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
      r.setPixelRatio(1);
      r.setSize(260, 340, false);
      const sc = new THREE.Scene();
      const l = createLights(sc);
      l.sun.castShadow = false;
      const cam = new THREE.PerspectiveCamera(30, 130 / 170, 10, 3000);
      cam.position.set(0, 110, 400);
      cam.lookAt(0, 72, 0);
      card = { r, sc, cam, rigs: {} };
      return card;
    }

    function drawCard(ctx2d, def, { silhouette = false } = {}) {
      const c = cardRenderer();
      const key = rigKey(def);
      if (!c.rigs[key]) { c.rigs[key] = buildRobot(def); c.sc.add(c.rigs[key].root); }
      for (const k in c.rigs) c.rigs[k].root.visible = k === key;
      const rig = c.rigs[key];
      poseRobot(rig, { x: W / 2, y: FLOOR, facing: 1, time: 0, silhouette }, -0.6);
      rig.root.position.set(0, 0, 0);
      // Stora robotar ska ändå få plats på kortet.
      rig.root.scale.setScalar(Math.min(1, 1.05 / def.scale));
      c.r.render(c.sc, c.cam);
      ctx2d.drawImage(c.r.domElement, 0, 0, ctx2d.canvas.width, ctx2d.canvas.height);
    }

    return { render, project, drawCard };
  }

  window.Render3D = { init };
})();
