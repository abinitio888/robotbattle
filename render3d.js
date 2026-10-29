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


  // ---------- Gudomliga robotar: vingar, gloria, svävande stenar och förmörkelse ----------
  const glowMat = (color, opacity = 0.8) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const shiny = (color, emissive, ei = 0.6) => new THREE.MeshStandardMaterial({
    color, emissive, emissiveIntensity: ei, metalness: 0.6, roughness: 0.3, transparent: true,
  });

  // En mjuk rund glöd (för sprites): stops = [[0, 'rgba(...)'], [1, 'rgba(...)']].
  function radialTex(stops) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (const [at, col] of stops) g.addColorStop(at, col);
    c.fillStyle = g;
    c.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(cv);
  }
  const glowSprite = (tex, color = '#ffffff') => new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  let CORONA_TEX = null;
  let SOFT_TEX = null;
  const coronaTex = () => CORONA_TEX || (CORONA_TEX = radialTex([
    [0, 'rgba(255,255,255,0)'], [0.32, 'rgba(255,255,255,0)'], [0.36, 'rgba(255,240,255,1)'],
    [0.45, 'rgba(190,110,255,0.8)'], [0.7, 'rgba(110,40,200,0.25)'], [1, 'rgba(60,0,120,0)'],
  ]));
  const softTex = () => SOFT_TEX || (SOFT_TEX = radialTex([
    [0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)'],
  ]));

  // En textur som är stark nertill och tonar bort uppåt (för ljusväggar och pelare).
  let FADE_TEX = null;
  function fadeUp(color) {
    if (!FADE_TEX) {
      const cv = document.createElement('canvas');
      cv.width = 4; cv.height = 64;
      const c = cv.getContext('2d');
      const g = c.createLinearGradient(0, 64, 0, 0);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.3, 'rgba(255,255,255,0.5)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 4, 64);
      FADE_TEX = new THREE.CanvasTexture(cv);
    }
    return new THREE.MeshBasicMaterial({ color, map: FADE_TEX, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  }
  // Ansamlingsskivan runt det svarta hålet: virvlande lila spiralarmar.
  let ACC_TEX = null;
  function accretionTex() {
    if (ACC_TEX) return ACC_TEX;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(128, 128, 20, 128, 128, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.2, 'rgba(255,230,255,1)');
    g.addColorStop(0.35, 'rgba(200,110,255,0.85)');
    g.addColorStop(0.7, 'rgba(110,30,200,0.35)');
    g.addColorStop(1, 'rgba(40,0,90,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 256, 256);
    c.globalCompositeOperation = 'destination-out';
    c.lineWidth = 7;
    for (let arm = 0; arm < 4; arm++) {
      c.beginPath();
      for (let k = 0; k <= 60; k++) {
        const r = 30 + k * 1.6;
        const a = arm * Math.PI / 2 + k * 0.07;
        const x = 128 + Math.cos(a) * r;
        const y = 128 + Math.sin(a) * r;
        if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.strokeStyle = 'rgba(0,0,0,0.55)';
      c.stroke();
    }
    ACC_TEX = new THREE.CanvasTexture(cv);
    return ACC_TEX;
  }

  // Urtavla (för Kronos rygg och golvet i Tidsstopp) och visare, ritade på canvas.
  let CLOCK_TEX = null;
  let HANDS_TEX = null;
  function clockTex() {
    if (CLOCK_TEX) return CLOCK_TEX;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const c = cv.getContext('2d');
    c.translate(128, 128);
    const g = c.createRadialGradient(0, 0, 60, 0, 0, 124);
    g.addColorStop(0, 'rgba(255,226,138,0.05)');
    g.addColorStop(0.85, 'rgba(255,226,138,0.35)');
    g.addColorStop(1, 'rgba(255,226,138,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, 124, 0, Math.PI * 2); c.fill();
    c.strokeStyle = 'rgba(255,236,170,1)';
    c.lineWidth = 6;
    c.beginPath(); c.arc(0, 0, 110, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 2;
    c.beginPath(); c.arc(0, 0, 96, 0, Math.PI * 2); c.stroke();
    const nums = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
    c.fillStyle = 'rgba(255,236,170,1)';
    c.font = 'bold 18px Georgia, serif';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
      c.fillText(nums[k], Math.cos(a) * 78, Math.sin(a) * 78);
      c.fillRect(Math.cos(a) * 100 - 3, Math.sin(a) * 100 - 3, 6, 6);
    }
    CLOCK_TEX = new THREE.CanvasTexture(cv);
    return CLOCK_TEX;
  }
  function handsTex() {
    if (HANDS_TEX) return HANDS_TEX;
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    c.fillStyle = 'rgba(255,240,190,1)';
    c.fillRect(61, 18, 6, 48);   // minutvisare
    c.fillRect(60, 36, 8, 30);   // timvisare
    c.beginPath(); c.arc(64, 64, 7, 0, Math.PI * 2); c.fill();
    HANDS_TEX = new THREE.CanvasTexture(cv);
    return HANDS_TEX;
  }

  function buildDivine(def, upper, inner, fists) {
    const mats = [];
    const reg = (mat) => { mats.push({ mat, color: mat.color.clone(), base: mat.opacity }); return mat; };
    const spin = [];  // grupper som snurrar runt roboten
    const flap = [];  // vingar
    const pulse = []; // saker som lyser upp under specialattacken
    const spinners = []; // sprites (visare) och grupper som snurrar runt en egen axel
    const g = new THREE.Group();
    upper.add(g);

    // Ett gudomligt sken under fötterna.
    const aura = new THREE.Mesh(new THREE.RingGeometry(24, 42, 48), reg(glowMat(def.accent, 0.5)));
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 1.5;
    inner.add(aura);
    const auraIn = new THREE.Mesh(new THREE.CircleGeometry(24, 40), reg(glowMat(def.accent, 0.18)));
    auraIn.rotation.x = -Math.PI / 2;
    auraIn.position.y = 1.2;
    inner.add(auraIn);
    pulse.push(aura);

    switch (def.royal ? 'royal' : def.special.type) {
      case 'royal': { // Kungar och drottning: guldsken, svävande juveler och en mantel av glöd
        const sheen = glowSprite(softTex(), def.royal === 'queen' ? '#ff5fd2' : '#ffb347');
        sheen.scale.set(150, 190, 1);
        sheen.position.set(0, 80, 0);
        sheen.material.opacity = 0.45;
        g.add(sheen);
        reg(sheen.material);
        pulse.push(sheen);
        const gold = reg(shiny('#ffd93d', '#ffb000', 0.6));
        const gem = reg(glowMat(def.eye, 0.95));
        const jewels = new THREE.Group();
        jewels.position.y = 150;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          const j = new THREE.Mesh(new THREE.OctahedronGeometry(4.5), k % 2 ? gold : gem);
          j.position.set(Math.cos(a) * 30, Math.sin(a * 2) * 6, Math.sin(a) * 30);
          jewels.add(j);
        }
        g.add(jewels);
        spin.push({ g: jewels, speed: 1.1 });
        // Taggar av guld som en krage runt axlarna.
        for (let k = 0; k < 7; k++) {
          const a = (k / 6 - 0.5) * Math.PI;
          const spike = new THREE.Mesh(cone(3.5, 18, 6), gold);
          spike.position.set(-4 + Math.cos(a) * 4, 100, Math.sin(a) * 22);
          spike.rotation.x = Math.sin(a) * 0.6;
          g.add(spike);
        }
        if (def.royal === 'queen') {
          // Drottningen: ett par skimrande skuggvingar.
          const wing = reg(glowMat('#b46bff', 0.45));
          for (const side of [-1, 1]) {
            const pivot = new THREE.Group();
            pivot.position.set(-20, 96, side * 8);
            pivot.rotation.z = 0.35;
            for (let k = 0; k < 4; k++) {
              const arm = new THREE.Group();
              arm.rotation.x = side * (0.35 + k * 0.32);
              const len = 80 - k * 12;
              const fm = new THREE.Mesh(box(2, len, 14), wing);
              fm.position.y = len / 2;
              arm.add(fm);
              pivot.add(arm);
            }
            g.add(pivot);
            flap.push({ pivot, side });
          }
        }
        break;
      }
      case 'halo': { // Seraph: gloria och änglavingar
        const gold = reg(glowMat('#ffe680', 0.95));
        const halo = new THREE.Mesh(new THREE.TorusGeometry(15, 2, 10, 40), gold);
        halo.rotation.x = Math.PI / 2;
        halo.position.y = 150;
        g.add(halo);
        const haloSoft = new THREE.Mesh(new THREE.TorusGeometry(15, 6, 10, 40), reg(glowMat('#ffd04a', 0.25)));
        haloSoft.rotation.x = Math.PI / 2;
        haloSoft.position.y = 150;
        g.add(haloSoft);
        pulse.push(halo, haloSoft);

        const feather = reg(shiny('#ffffff', '#ffe28a', 0.45));
        const tipMat = reg(glowMat('#fff3b0', 0.85));
        for (const side of [-1, 1]) {
          const pivot = new THREE.Group();
          pivot.position.set(-20, 96, side * 8);
          pivot.rotation.z = 0.4;
          for (let k = 0; k < 6; k++) {
            const len = 78 - k * 9;
            const arm = new THREE.Group();
            arm.rotation.x = side * (0.3 + k * 0.26);
            const fm = new THREE.Mesh(box(3, len, 12 - k), feather);
            fm.position.y = len / 2;
            const tip = new THREE.Mesh(sphere(2.6), tipMat);
            tip.position.y = len;
            arm.add(fm, tip);
            pivot.add(arm);
          }
          g.add(pivot);
          flap.push({ pivot, side });
        }
        const motes = new THREE.Group();
        motes.position.y = 70;
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2;
          const m = new THREE.Mesh(sphere(2.2), gold);
          m.position.set(Math.cos(a) * 44, Math.sin(a * 3) * 22, Math.sin(a) * 44);
          motes.add(m);
        }
        g.add(motes);
        spin.push({ g: motes, speed: 1.4 });
        break;
      }
      case 'quake': { // Atlas: lysande sprickor och stenar som svävar runt den
        const crack = reg(glowMat('#3ee8ff', 0.95));
        const zig = [[-14, 92, 0.5], [-4, 80, -0.6], [6, 66, 0.4], [-2, 52, -0.5], [10, 42, 0.3]];
        for (const [x, y, r] of zig) {
          const c = new THREE.Mesh(box(2.5, 15, 1), crack);
          c.position.set(x, y, 17.6);
          c.rotation.z = r;
          g.add(c);
          const c2 = new THREE.Mesh(box(1, 15, 2.5), crack);
          c2.position.set(22.6, y, x * 0.8);
          c2.rotation.x = r;
          g.add(c2);
        }
        for (const fist of fists) {
          const fg = new THREE.Mesh(sphere(11), reg(glowMat('#3ee8ff', 0.35)));
          fist.add(fg);
          pulse.push(fg);
        }
        const rocks = new THREE.Group();
        rocks.position.y = 58;
        const rockMat = reg(shiny('#6a7084', '#3ee8ff', 0.3));
        const runeMat = reg(glowMat('#3ee8ff', 0.9));
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2;
          const r = new THREE.Mesh(new THREE.DodecahedronGeometry(5 + (k % 3) * 2.5), rockMat);
          r.position.set(Math.cos(a) * 50, Math.sin(a * 2) * 10, Math.sin(a) * 50);
          r.rotation.set(k, k * 2, 0);
          const rune = new THREE.Mesh(sphere(1.8), runeMat);
          rune.position.copy(r.position);
          rocks.add(r, rune);
        }
        g.add(rocks);
        spin.push({ g: rocks, speed: 0.9 });
        break;
      }
      case 'timestop': { // Kronos: en lysande urtavla bakom ryggen och snurrande kugghjul
        const face = glowSprite(clockTex(), '#ffe9a8');
        face.scale.set(104, 104, 1);
        face.position.set(-26, 104, 0);
        g.add(face);
        reg(face.material);
        const hands = glowSprite(handsTex(), '#fff3c4');
        hands.scale.set(80, 80, 1);
        hands.position.copy(face.position);
        g.add(hands);
        reg(hands.material);
        spinners.push({ mat: hands.material, speed: -1.6 });
        pulse.push(face);
        const gearMat = reg(shiny('#c9a85a', '#ffcf5a', 0.35));
        const gears = new THREE.Group();
        gears.position.y = 64;
        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * Math.PI * 2;
          const gear = new THREE.Group();
          gear.add(new THREE.Mesh(new THREE.TorusGeometry(7, 2.2, 6, 12), gearMat));
          for (let t = 0; t < 8; t++) {
            const tooth = new THREE.Mesh(box(3, 3, 3), gearMat);
            tooth.position.set(Math.cos(t * Math.PI / 4) * 9.5, Math.sin(t * Math.PI / 4) * 9.5, 0);
            gear.add(tooth);
          }
          gear.position.set(Math.cos(a) * 46, Math.sin(a * 2) * 14, Math.sin(a) * 46);
          gears.add(gear);
        }
        g.add(gears);
        spin.push({ g: gears, speed: 0.8 });
        break;
      }
      case 'meteor': { // Solaris: en flammande sol runt huvudet och eldklot som kretsar
        const sun = glowSprite(softTex(), '#ff9a2a');
        sun.scale.set(110, 110, 1);
        sun.position.set(0, 112, 0);
        g.add(sun);
        reg(sun.material);
        const core = glowSprite(softTex(), '#fff0a0');
        core.scale.set(50, 50, 1);
        core.position.copy(sun.position);
        g.add(core);
        reg(core.material);
        pulse.push(sun, core);
        const rays = new THREE.Group();
        rays.position.set(0, 112, 0);
        const rayMat = reg(glowMat('#ffb347', 0.85));
        for (let k = 0; k < 10; k++) {
          const ray = new THREE.Mesh(cone(3, 16, 5), rayMat);
          const a = (k / 10) * Math.PI * 2;
          ray.position.set(0, Math.cos(a) * 26, Math.sin(a) * 26);
          ray.rotation.x = a;
          rays.add(ray);
        }
        g.add(rays);
        spinners.push({ obj: rays, axis: 'x', speed: 0.9 });
        const balls = new THREE.Group();
        balls.position.y = 70;
        const fire = reg(glowMat('#ff7a1a', 0.95));
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2;
          const b = new THREE.Mesh(sphere(5), fire);
          b.position.set(Math.cos(a) * 48, Math.sin(a * 2) * 18, Math.sin(a) * 48);
          const halo = new THREE.Mesh(sphere(9), reg(glowMat('#ffcf5a', 0.3)));
          halo.position.copy(b.position);
          balls.add(b, halo);
        }
        g.add(balls);
        spin.push({ g: balls, speed: 1.6 });
        break;
      }
      case 'tide': { // Leviatan: en treudd i handen och vattendroppar som virvlar runt den
        const metal = reg(shiny('#cfe9ff', '#3ee8ff', 0.35));
        const trident = new THREE.Group();
        trident.add(new THREE.Mesh(cyl(1.8, 1.8, 92, 8), metal));
        const bar = new THREE.Mesh(box(22, 3, 3), metal);
        bar.position.y = 44;
        trident.add(bar);
        for (const x of [-10, 0, 10]) {
          const prong = new THREE.Mesh(cone(2.6, 16, 6), metal);
          prong.position.set(x, 54, 0);
          trident.add(prong);
        }
        const glow = new THREE.Mesh(sphere(5), reg(glowMat('#7ff9ff', 0.8)));
        glow.position.y = 46;
        trident.add(glow);
        trident.position.y = 26; // handen håller i nedre delen av skaftet
        fists[0].add(trident);
        const water = new THREE.Group();
        water.position.y = 60;
        const drop = reg(glowMat('#5fd0ff', 0.85));
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * Math.PI * 2;
          const d = new THREE.Mesh(sphere(2.6 + (k % 3)), drop);
          d.position.set(Math.cos(a) * 50, Math.sin(a * 3) * 30, Math.sin(a) * 50);
          water.add(d);
        }
        g.add(water);
        spin.push({ g: water, speed: 1.3 });
        const mist = glowSprite(softTex(), '#2f8fe0');
        mist.scale.set(130, 160, 1);
        mist.position.set(0, 70, 0);
        mist.material.opacity = 0.4;
        g.add(mist);
        reg(mist.material);
        pulse.push(mist);
        break;
      }
      default: { // Eclipse: en förmörkad sol bakom huvudet och svarta kristaller
        const corona = glowSprite(coronaTex());
        corona.scale.set(96, 96, 1);
        corona.position.set(-22, 118, 0);
        g.add(corona);
        reg(corona.material);
        const sun = new THREE.Mesh(sphere(15), reg(new THREE.MeshBasicMaterial({ color: '#05020a', transparent: true })));
        sun.position.copy(corona.position);
        g.add(sun);
        pulse.push(corona);

        const shardMat = reg(shiny('#1a1028', '#9b4dff', 0.65));
        const shards = new THREE.Group();
        shards.position.y = 84;
        shards.rotation.z = 0.35;
        for (let k = 0; k < 5; k++) {
          const a = (k / 5) * Math.PI * 2;
          const sh = new THREE.Mesh(new THREE.OctahedronGeometry(6), shardMat);
          sh.scale.y = 2;
          sh.position.set(Math.cos(a) * 46, 0, Math.sin(a) * 46);
          shards.add(sh);
        }
        g.add(shards);
        spin.push({ g: shards, speed: -1.2 });
        const mist = glowSprite(softTex(), '#7a2fd0');
        mist.scale.set(120, 150, 1);
        mist.position.set(-4, 70, 0);
        mist.material.opacity = 0.35;
        g.add(mist);
        reg(mist.material);
      }
    }

    for (const m of pulse) m.userData.s = m.scale.clone();
    return {
      // power: 0..1 medan specialattacken laddas.
      update(t, power, sil, alpha) {
        g.visible = !sil;
        aura.visible = auraIn.visible = !sil;
        for (const { mat, color, base } of mats) {
          mat.color.copy(color);
          mat.opacity = base * alpha;
        }
        for (const s of spin) s.g.rotation.y = t * s.speed * (1 + power * 3);
        for (const w of flap) w.pivot.rotation.x = w.side * (Math.sin(t * (4 + power * 10)) * 0.18 + power * 0.35);
        const p = 1 + power * 0.8 + Math.sin(t * 5) * 0.06;
        for (const m of pulse) m.scale.copy(m.userData.s).multiplyScalar(p);
        for (const sp of spinners) {
          if (sp.mat) sp.mat.rotation = t * sp.speed * (1 + power * 4);
          else sp.obj.rotation[sp.axis] = t * sp.speed * (1 + power * 3);
        }
      },
    };
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
    // Gudomliga robotar och Monstervärldens kungar/drottning får extra prakt (se buildDivine).
    const divine = def.rarity === 'divine' || def.royal ? buildDivine(def, upper, inner, [front.fist, back.fist]) : null;

    root.traverse((o) => { if (o.isMesh) o.castShadow = o.material.blending !== THREE.AdditiveBlending; });
    glow.castShadow = false;
    return { def, root, inner, upper, legs, back, front, core, cape, flame, glow, divine, M };
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

    if (rig.divine) rig.divine.update(t, glow, sil, alpha);
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
    edge.position.set(0, 1.5, 260);
    g.add(edge);
    const back = new THREE.Mesh(box(W + 40, 3, 4), new THREE.MeshBasicMaterial({ color: arena.line }));
    back.position.set(0, 1.5, -260);
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
    const cam = { x: 0, z: 0, dist: 1080 };
    const halfWidthPerDist = Math.tan((FOV / 2) * Math.PI / 180) * (W / H);
    // Kameran tittar snett uppifrån och följer robotarna både åt sidorna och i djupled.
    function aimCamera(fighters, dt) {
      let lo = Infinity;
      let hi = -Infinity;
      let zLo = Infinity;
      let zHi = -Infinity;
      for (const { f } of fighters) {
        lo = Math.min(lo, wx(f.x)); hi = Math.max(hi, wx(f.x));
        zLo = Math.min(zLo, f.z || 0); zHi = Math.max(zHi, f.z || 0);
      }
      let x = 0;
      let z = 0;
      let dist = 1080;
      if (lo <= hi) {
        x = (lo + hi) / 2;
        z = (zLo + zHi) / 2;
        dist = clamp(((hi - lo) / 2 + 160) / halfWidthPerDist + (zHi - zLo) * 0.6, 760, 1150);
        // Kanterna på banan ska aldrig hamna innanför bild: håll kameran inom det x:et tillåter.
        const room = Math.max(0, W / 2 + 40 - dist * halfWidthPerDist);
        x = clamp(x, -room, room);
      }
      const k = 1 - Math.exp(-dt * 4);
      cam.x += (x - cam.x) * k;
      cam.z += (z - cam.z) * k;
      cam.dist += (dist - cam.dist) * k;
      const lookY = 70;
      camera.position.set(cam.x, lookY + cam.dist * 0.5, cam.z + cam.dist * 0.88);
      camera.lookAt(cam.x, lookY, cam.z);
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

    const booms = new Map();
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
      haloWall: makePool(scene, () => new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 64, 1, true), fadeUp('#ffe36b'))),
      quake: makePool(scene, () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), basic('#caa968', 0.8, true)); m.rotation.x = -Math.PI / 2; return m; }),
      holeCore: makePool(scene, () => new THREE.Mesh(sphere(1), new THREE.MeshBasicMaterial({ color: '#000000' }))),
      holeRing: makePool(scene, () => new THREE.Mesh(new THREE.TorusGeometry(1, 0.12, 8, 40), basic('#b46bff', 0.85, true))),
      holeDisc: makePool(scene, () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.3, 1, 40), basic('#5a1fa8', 0.45, true)); m.rotation.x = -Math.PI / 2; return m; }),
      haloPillar: makePool(scene, () => new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 24, 1, true), fadeUp('#ffe680'))),
      haloSpark: makePool(scene, () => new THREE.Mesh(new THREE.OctahedronGeometry(3.5), basic('#fff6c8', 1, true))),
      feather: makePool(scene, () => new THREE.Mesh(box(2, 14, 6), basic('#ffffff', 0.9))),
      quakeSpike: makePool(scene, () => {
        const m = new THREE.Mesh(cone(1, 1, 5), new THREE.MeshStandardMaterial({ color: '#5a5260', emissive: '#3ee8ff', emissiveIntensity: 0.15, flatShading: true }));
        m.castShadow = true;
        return m;
      }),
      quakeCrack: makePool(scene, () => new THREE.Mesh(box(1, 2, 6), basic('#3ee8ff', 0.9, true))),
      quakeDust: makePool(scene, () => { const s = glowSprite(softTex(), '#b9a98a'); s.material.blending = THREE.NormalBlending; return s; }),
      holeDisk: makePool(scene, () => new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({ map: accretionTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }))),
      holeCorona: makePool(scene, () => glowSprite(coronaTex())),
      holeBit: makePool(scene, () => new THREE.Mesh(sphere(1), basic('#d9a8ff', 1, true))),
      clockFace: makePool(scene, () => { const m = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ map: clockTex(), color: '#ffe9a8', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); m.rotation.x = -Math.PI / 2; return m; }),
      clockHand: makePool(scene, () => new THREE.Mesh(box(1, 3, 1), basic('#fff3c4', 0.95, true))),
      clockDome: makePool(scene, () => new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), basic('#9fd8ff', 0.12, true))),
      meteorWarn: makePool(scene, () => { const m = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 40), basic('#ff3b1f', 0.85, true)); m.rotation.x = -Math.PI / 2; return m; }),
      meteorRock: makePool(scene, () => new THREE.Mesh(new THREE.DodecahedronGeometry(1), new THREE.MeshStandardMaterial({ color: '#3a2418', emissive: '#ff5a1a', emissiveIntensity: 0.8, flatShading: true }))),
      meteorFire: makePool(scene, () => glowSprite(softTex(), '#ff8a2a')),
      meteorTrail: makePool(scene, () => new THREE.Mesh(new THREE.CylinderGeometry(1, 0.1, 1, 10, 1, true), fadeUp('#ffb347'))),
      tideWall: makePool(scene, () => new THREE.Mesh(box(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#1f7fd0', emissive: '#0f4a8a', emissiveIntensity: 0.5, transparent: true, opacity: 0.72, roughness: 0.15, metalness: 0.1, depthWrite: false }))),
      tideFoam: makePool(scene, () => new THREE.Mesh(box(1, 1, 1), basic('#e8fbff', 0.9))),
      tideGap: makePool(scene, () => new THREE.Mesh(box(1, 1, 1), basic('#7ff9ff', 0.35, true))),
      superGlow: makePool(scene, () => glowSprite(softTex())),
      dragonFlame: makePool(scene, () => new THREE.Mesh(cone(1, 1, 6), basic('#ff8a2a', 0.9, true))),
      mirror: makePool(scene, () => new THREE.Mesh(sphere(1), basic('#dff6ff', 0.3, true))),
      mirrorRing: makePool(scene, () => new THREE.Mesh(new THREE.TorusGeometry(1, 0.05, 8, 48), basic('#ffffff', 0.9, true))),
      gravRing: makePool(scene, () => { const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 40), basic('#c47bff', 0.9, true)); m.rotation.x = -Math.PI / 2; return m; }),
      reviveMote: makePool(scene, () => new THREE.Mesh(sphere(1), basic('#a6ffcb', 1, true))),
      megaCharge: makePool(scene, () => glowSprite(softTex(), '#3ee8ff')),
      boltSeg: makePool(scene, () => new THREE.Mesh(box(1, 1, 1), basic('#fff6c0', 1, true))),
      boltGlow: makePool(scene, () => new THREE.Mesh(box(1, 1, 1), basic('#8fb8ff', 0.5, true))),
      boom: makePool(scene, () => new THREE.Mesh(sphere(1), basic('#c47bff', 0.8, true))),
      boomRing: makePool(scene, () => { const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.06, 8, 48), basic('#ffffff', 1, true)); m.rotation.x = -Math.PI / 2; return m; }),
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
      // ---- Supervapnens superkrafter ----
      if (f.dragonT > 0) {
        // Drakvrede: lågor som slickar uppåt runt hela roboten.
        const aura = pools.superGlow.get();
        aura.position.set(cx, cy, cz);
        aura.scale.set(f.w * 2.6, f.h * 1.9, 1);
        aura.material.color.set('#ff5a1a');
        aura.material.opacity = 0.55 + 0.2 * Math.sin(f.time * 18);
        for (let i = 0; i < 9; i++) {
          const fl = pools.dragonFlame.get();
          const a = (i / 9) * Math.PI * 2 + f.time * 2;
          const k = (f.time * 2.5 + i * 0.37) % 1;
          fl.position.set(cx + Math.cos(a) * f.w * 0.55, wy(f.y) + k * f.h * 1.1, cz + Math.sin(a) * f.w * 0.55);
          fl.scale.set(11 * (1 - k * 0.6), 34 * (1 - k * 0.5), 11 * (1 - k * 0.6));
          fl.material.opacity = 0.9 * (1 - k);
        }
      }
      if (f.mirrorT > 0) {
        // Spegelvärn: en blank spegelbubbla med en ring som snurrar runt den.
        const m = ell(pools.mirror, 1.0, 0.66);
        m.material.opacity = 0.35 + 0.1 * Math.sin(f.time * 10);
        const r = pools.mirrorRing.get();
        r.position.set(cx, cy, cz);
        r.scale.setScalar(f.w * 1.1);
        r.rotation.set(1.1 + Math.sin(f.time * 3) * 0.3, f.time * 4, 0);
      }
      if (f.floatT > 0) {
        // Antigravitation: lila ringar som håller roboten svävande, och ett sken på marken under.
        for (let i = 0; i < 3; i++) {
          const r = pools.gravRing.get();
          const k = (f.time * 1.2 + i / 3) % 1;
          r.position.set(cx, wy(f.y) - 10 + k * (f.h + 20), cz);
          r.scale.setScalar(f.w * (0.9 + 0.3 * Math.sin(k * Math.PI)));
          r.material.opacity = Math.sin(k * Math.PI) * 0.9;
        }
        const d = pools.holeDisc.get();
        d.position.set(cx, 2, cz);
        d.scale.setScalar(70);
        d.rotation.z = f.time * 3;
      }
      if (f.reviveT > 0) {
        // Livsljus: gröna ljus som spiralar uppåt.
        const k0 = 1 - f.reviveT / 1.4;
        for (let i = 0; i < 16; i++) {
          const m = pools.reviveMote.get();
          const k = (k0 * 1.5 + i / 16) % 1;
          const a = i * 0.9 + k * 8;
          m.position.set(cx + Math.cos(a) * f.w * 0.7, wy(f.y) + k * f.h * 1.4, cz + Math.sin(a) * f.w * 0.7);
          m.scale.setScalar(3 * (1 - k) + 1);
        }
        const g = pools.superGlow.get();
        g.position.set(cx, cy, cz);
        g.scale.set(f.w * 2.4, f.h * 1.8, 1);
        g.material.color.set('#7dffb0');
        g.material.opacity = f.reviveT / 1.4 * 0.7;
      }
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
        const age = (h.r - 20) / h.speed;
        const ring = pools.halo.get();
        ring.position.set(wx(h.x), 3, h.z || 0);
        ring.scale.setScalar(h.r);
        ring.material.opacity = 0.9 * fade + 0.1;
        const wall = pools.haloWall.get();
        wall.position.set(wx(h.x), 40, h.z || 0);
        wall.scale.set(h.r, 80, h.r);
        wall.material.opacity = 0.9 * fade;
        // En ljuspelare från himlen över Seraph när gloria tänds.
        if (age < 0.6) {
          const pil = pools.haloPillar.get();
          const k = age / 0.6;
          pil.position.set(wx(h.owner.x), 450, h.owner.z || 0);
          pil.scale.set(70 * (1 - k * 0.6), 900, 70 * (1 - k * 0.6));
          pil.material.opacity = 1 - k;
        }
        // Gnistor som stiger längs ringen.
        for (let i = 0; i < 36; i++) {
          const a = (i / 36) * Math.PI * 2 + i * 0.4;
          const m = pools.haloSpark.get();
          const up = (age * 140 + i * 17) % 70;
          m.position.set(wx(h.x) + Math.cos(a) * h.r, 6 + up, (h.z || 0) + Math.sin(a) * h.r);
          m.scale.setScalar(fade * (1 - up / 90));
          m.rotation.y = age * 6 + i;
        }
        // Fjädrar som singlar ner runt Seraph.
        for (let i = 0; i < 10; i++) {
          const m = pools.feather.get();
          const a = i * 2.4;
          const fall = age * 60;
          m.position.set(wx(h.owner.x) + Math.cos(a) * (30 + i * 6) + Math.sin(age * 4 + i) * 10,
            170 + (i % 4) * 20 - fall, (h.owner.z || 0) + Math.sin(a) * (30 + i * 6));
          m.rotation.set(Math.sin(age * 5 + i) * 0.8, a, 0.6 + Math.cos(age * 4 + i) * 0.5);
          m.material.opacity = 0.9 * fade;
        }
      }
      for (const q of s.quakes || []) {
        // Varje skalv: en ring rusar ut, stenspjut skjuter upp och sprickor lyser i marken.
        const cx = wx(q.x);
        const cz = q.z || 0;
        const total = q.ticks[q.ticks.length - 1] + 0.3;
        const crackGrow = clamp(q.t / 0.35, 0, 1) * clamp((total - q.t) / 0.3, 0, 1);
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + 0.3;
          const len = 60 + (i % 3) * 50;
          const m = pools.quakeCrack.get();
          m.scale.set(len * crackGrow, 1, 1);
          m.position.set(cx + Math.cos(a) * len * crackGrow / 2, 1.5, cz - Math.sin(a) * len * crackGrow / 2);
          m.rotation.y = a;
          m.material.opacity = 0.5 + 0.4 * Math.sin(q.t * 20 + i);
        }
        for (let i = 0; i < q.i; i++) {
          const age = q.t - q.ticks[i];
          if (age > 0.6) continue;
          const m = pools.quake.get();
          m.position.set(cx, 2 + i * 0.3, cz);
          m.scale.setScalar(60 + age * 1600);
          m.material.opacity = 0.8 * (1 - age / 0.6);
          for (let ringK = 0; ringK < 5; ringK++) {
            const local = age - ringK * 0.05;
            if (local < 0 || local > 0.45) continue;
            const h = Math.sin(Math.PI * local / 0.45) * (70 - ringK * 6);
            const r = 80 + ringK * 75;
            const n = 8 + ringK * 3;
            for (let j = 0; j < n; j++) {
              const a = (j / n) * Math.PI * 2 + i * 0.7 + ringK;
              const sp = pools.quakeSpike.get();
              const w = 10 + ((j * 7 + ringK) % 3) * 4;
              sp.scale.set(w, h, w);
              sp.position.set(cx + Math.cos(a) * r, h / 2 - 2, cz + Math.sin(a) * r * 0.8);
              sp.rotation.set(Math.sin(j) * 0.25, 0, Math.cos(j) * 0.25);
            }
          }
          for (let j = 0; j < 8; j++) {
            const d = pools.quakeDust.get();
            const a = (j / 8) * Math.PI * 2 + i;
            const r = 60 + age * 500;
            d.position.set(cx + Math.cos(a) * r, 20 + age * 40, cz + Math.sin(a) * r * 0.6);
            d.scale.setScalar(60 + age * 120);
            d.material.opacity = 0.5 * (1 - age / 0.6);
          }
        }
      }
      for (const h of s.holes || []) {
        const grow = clamp((h.max - h.life) / 0.3, 0, 1);
        const shrink = h.life < 0.25 ? h.life / 0.25 : 1;
        const sc = grow * (0.4 + 0.6 * shrink);
        const y = 60;
        const x = wx(h.x);
        const z = h.z || 0;
        const core = pools.holeCore.get();
        core.position.set(x, y, z);
        core.scale.setScalar(24 * sc);
        const corona = pools.holeCorona.get();
        corona.position.set(x, y, z);
        corona.scale.setScalar(160 * sc);
        const disk = pools.holeDisk.get();
        disk.position.set(x, y, z);
        disk.scale.setScalar(110 * sc);
        disk.rotation.set(-1.25, 0, h.life * 5);
        const ring = pools.holeRing.get();
        ring.position.copy(core.position);
        ring.scale.setScalar(40 * sc);
        ring.rotation.set(1.2, h.life * 6, 0);
        const disc = pools.holeDisc.get();
        disc.position.set(x, 2, z);
        disc.scale.setScalar(130 * grow);
        disc.rotation.z = h.life * 3;
        // Bitar som virvlar in mot hålet.
        for (let i = 0; i < 28; i++) {
          const ph = ((h.max - h.life) * 0.9 + i / 28) % 1;
          const r = 170 * (1 - ph) + 12;
          const a = i * 2.1 + ph * 9;
          const b = pools.holeBit.get();
          b.position.set(x + Math.cos(a) * r, y + Math.sin(i * 1.7) * 40 * (1 - ph), z + Math.sin(a) * r);
          b.scale.setScalar(1.5 + ph * 2.5);
        }
        booms.set(h, { x, z, t: 0 });
      }
      // När hålet imploderat finns det inte längre i spelet: rita smällen ett tag till.
      for (const [h, b] of booms) {
        if ((s.holes || []).includes(h)) continue;
        b.t += 1 / 60;
        if (b.t > 0.6) { booms.delete(h); continue; }
        const k = b.t / 0.6;
        const m = pools.boom.get();
        m.position.set(b.x, 60, b.z);
        m.scale.setScalar(20 + k * 170);
        m.material.opacity = 0.8 * (1 - k);
        for (let i = 0; i < 2; i++) {
          const r = pools.boomRing.get();
          r.position.set(b.x, 4 + i * 56, b.z);
          r.scale.setScalar(30 + k * (320 - i * 120));
          r.material.opacity = 1 - k;
        }
      }
      for (const b of s.megabeams || []) {
        const x0 = wx(b.x) + b.dir * 30;
        const y = wy(b.y);
        if (b.t < 0.4) {
          // Laddning: ett växande, flimrande ljusklot framför roboten.
          const c = pools.megaCharge.get();
          c.position.set(x0, y, b.z);
          c.scale.setScalar(30 + (b.t / 0.4) * 90 + Math.sin(b.t * 60) * 8);
        } else {
          const k = (b.t - 0.4) / 0.6;
          const x1 = b.dir > 0 ? W / 2 + 200 : -W / 2 - 200;
          const len = Math.abs(x1 - x0);
          const mid = (x0 + x1) / 2;
          const o = pools.beamOuter.get();
          o.position.set(mid, y, b.z);
          o.scale.set(46 * (1 - k * 0.5), len, 46 * (1 - k * 0.5));
          o.material.color.set('#3ee8ff');
          o.material.opacity = 0.85 * (1 - k);
          const i = pools.beamInner.get();
          i.position.copy(o.position);
          i.scale.set(16 * (1 - k * 0.5), len, 16 * (1 - k * 0.5));
          i.material.opacity = 1 - k;
          const c = pools.megaCharge.get();
          c.position.set(x0, y, b.z);
          c.scale.setScalar(140 * (1 - k));
        }
      }
      for (const [bi, b] of (s.bolts || []).entries()) {
        if (!b.done) continue;
        // En sicksackande blixt från himlen ner på motståndaren.
        const k = b.t / 0.25;
        const gx = wx(b.x);
        const gz = b.z;
        let px = gx;
        let py = 0;
        const segs = 7;
        for (let j = 0; j < segs; j++) {
          const ny = ((j + 1) / segs) * 650;
          const nx = gx + (j === segs - 1 ? 0 : Math.sin(bi * 7.3 + j * 12.1) * 40);
          const len = Math.hypot(nx - px, ny - py);
          for (const [pool, w] of [[pools.boltSeg, 5], [pools.boltGlow, 18]]) {
            const m = pool.get();
            m.position.set((px + nx) / 2, (py + ny) / 2, gz);
            m.scale.set(w, len, w);
            m.rotation.set(0, 0, -Math.atan2(nx - px, ny - py));
            m.material.opacity = (pool === pools.boltSeg ? 1 : 0.5) * (1 - k);
          }
          px = nx;
          py = ny;
        }
        const r = pools.boomRing.get();
        r.position.set(gx, 3, gz);
        r.scale.setScalar(20 + k * 70);
        r.material.opacity = 1 - k;
      }
      for (const c of s.clocks || []) {
        // Urverket: en urtavla på golvet med snurrande visare och en kupol där tiden går långsamt.
        const grow = clamp((c.max - c.life) / 0.3, 0, 1) * clamp(c.life / 0.3, 0, 1);
        const x = wx(c.x);
        const z = c.z || 0;
        const face = pools.clockFace.get();
        face.position.set(x, 2, z);
        face.scale.setScalar(c.r * grow);
        face.rotation.z = (c.max - c.life) * 0.4;
        face.material.opacity = 0.9;
        const dome = pools.clockDome.get();
        dome.position.set(x, 0, z);
        dome.scale.set(c.r * grow, c.r * 0.75 * grow, c.r * grow);
        const age = c.max - c.life;
        for (const [len, speed, w] of [[c.r * 0.8, 3.2, 6], [c.r * 0.5, 0.7, 10]]) {
          const h = pools.clockHand.get();
          const a = age * speed;
          h.scale.set(len * grow, 1, w);
          h.rotation.y = -a;
          h.position.set(x + Math.cos(a) * len * grow / 2, 4, z + Math.sin(a) * len * grow / 2);
        }
      }
      for (const m of s.meteors || []) {
        if (!m.locked) continue;
        const x = wx(m.x);
        const z = m.z || 0;
        if (m.boom < 0) {
          const k = clamp(m.t / m.delay, 0, 1);
          const warn = pools.meteorWarn.get();
          warn.position.set(x, 2, z);
          warn.scale.setScalar(58 * (1.25 - 0.25 * k));
          warn.material.opacity = 0.35 + 0.6 * k;
          // Meteoren kommer snett uppifrån, från bakom banan.
          const y = 20 + (1 - k) * 700;
          const mz = z - (1 - k) * 380;
          const rock = pools.meteorRock.get();
          rock.position.set(x + (1 - k) * 160, y, mz);
          rock.scale.setScalar(16);
          rock.rotation.set(m.t * 7, m.t * 5, 0);
          const fire = pools.meteorFire.get();
          fire.position.copy(rock.position);
          fire.scale.setScalar(70);
          const trail = pools.meteorTrail.get();
          trail.position.set(rock.position.x + 40, y + 110, mz - 60);
          trail.scale.set(14, 230, 14);
          trail.rotation.set(-0.48, 0, -0.38);
          trail.material.opacity = 0.9;
        } else {
          const k = m.boom / 0.45;
          const b = pools.boom.get();
          b.position.set(x, 20, z);
          b.scale.setScalar(20 + k * 90);
          b.material.color.set('#ff8a2a');
          b.material.opacity = 0.9 * (1 - k);
          const r = pools.boomRing.get();
          r.position.set(x, 3, z);
          r.scale.setScalar(30 + k * 120);
          r.material.opacity = 1 - k;
        }
      }
      for (const w of s.tides || []) {
        // En vattenvägg över hela djupet, med en enda lucka (gapZ) att ta sig igenom.
        const x = wx(w.x);
        const lo = -270; // ut till banans kantlinjer (±260)
        const hi = 270;
        const g0 = w.gapZ - w.gapW / 2;
        const g1 = w.gapZ + w.gapW / 2;
        for (const [a, b] of [[lo, g0], [g1, hi]]) {
          if (b - a < 2) continue;
          const wall = pools.tideWall.get();
          wall.scale.set(44, 170, b - a);
          wall.position.set(x, 85, (a + b) / 2);
          const foam = pools.tideFoam.get();
          foam.scale.set(54, 12, b - a);
          foam.position.set(x + w.dir * 6, 172 + Math.sin(w.x * 0.05) * 4, (a + b) / 2);
        }
        const gap = pools.tideGap.get();
        gap.scale.set(48, 4, w.gapW);
        gap.position.set(x, 2, w.gapZ);
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
    function project(x, y, z = 0) {
      tmp.set(wx(x), wy(y), z).project(camera);
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
      rig.root.scale.setScalar(Math.min(1, (def.rarity === 'divine' ? 0.82 : 1.05) / def.scale));
      c.r.render(c.sc, c.cam);
      ctx2d.drawImage(c.r.domElement, 0, 0, ctx2d.canvas.width, ctx2d.canvas.height);
    }

    return { render, project, drawCard };
  }

  window.Render3D = { init };
})();
