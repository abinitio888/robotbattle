// Ljudeffekter, skapade direkt med Web Audio (inga ljudfiler). Allt är korta syntljud: brus
// för smällar, svepande toner för specialer och små melodier för vinst, lådor och uppdrag.
// Webbläsare startar inget ljud förrän man tryckt på något, så ljudet vaknar vid första
// knapptryckningen. M stänger av/sätter på (sparas i webbläsaren).
const Sound = (function () {
  'use strict';
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem('robotbattle-muted') === '1'; } catch (e) { /* ingen lagring */ }

  function wake() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  window.addEventListener('keydown', wake);
  window.addEventListener('pointerdown', wake);

  const ready = () => ctx && ctx.state === 'running' && !muted;

  // En ton som glider från f0 till f1 under dur sekunder.
  function tone(f0, f1, dur, { type = 'square', vol = 0.3, at = 0 } = {}) {
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  // Brus genom ett filter: smällar, sus och explosioner.
  function noise(dur, { freq = 1200, q = 1, vol = 0.4, at = 0, type = 'bandpass' } = {}) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  const notes = (list, step, opts) => list.forEach((f, i) => tone(f, f, step * 1.6, { ...opts, at: i * step }));

  // Många träffar på en gång (t.ex. flerträffsspecialer) blir annars ett enda brus.
  let lastHit = 0;

  const SPECIAL_SOUND = {
    projectile: 'pew', spread: 'pew', snipe: 'pew', flak: 'pew', tankshell: 'boom', boomerang: 'whoosh', lob: 'fall',
    beam: 'beam', annihilate: 'beam', firebreath: 'beam', drain: 'beam', tether: 'beam',
    shockwave: 'boom', smash: 'boom', quake: 'boom', meteorslam: 'boom', burst: 'boom', mine: 'boom',
    dash: 'whoosh', teleport: 'whoosh', treadcharge: 'whoosh', flurry: 'whoosh', grapple: 'whoosh', tide: 'whoosh',
    meteor: 'fall', orbital: 'fall', blackhole: 'fall', wormhole: 'fall',
    barrier: 'shield', reflect: 'shield', counter: 'shield', halo: 'shield',
    timestop: 'clock', chrono: 'clock',
    copycat: 'magic', phantoms: 'magic', sizeshift: 'magic', freeze: 'magic', poison: 'magic', roots: 'magic',
    wolves: 'growl', overdrive: 'growl',
  };
  const ELEMENT_SOUND = {
    eld: 'hiss', drake: 'hiss', vatten: 'bubble', is: 'ice', elektrisk: 'zap', mörk: 'dark', spöke: 'dark', psykisk: 'dark',
    fe: 'fairy', sten: 'rock', mark: 'rock', stål: 'metal',
  };

  // ---------- Stridsmusik ----------
  // En liten slinga som spelas under matchen: bas och en melodi som byts varje takt. Tempot
  // ökar när någon har lite liv kvar (tense), och bossar får en mörkare slinga i moll.
  const MELODY = [[0, 3, 7, 10], [5, 7, 10, 12], [3, 7, 10, 15], [7, 5, 3, 2]];
  const BOSS_MELODY = [[0, 1, 5, 6], [0, 3, 6, 5], [1, 5, 8, 6], [0, -1, 1, 0]];
  const music = { on: false, step: 0, next: 0, boss: false, tense: false, timer: null };
  const hz = (root, semis) => root * Math.pow(2, semis / 12);
  function musicTick() {
    if (!music.on || !ready()) return;
    const beat = music.tense ? 0.17 : 0.22;
    while (music.next < ctx.currentTime + 0.25) {
      const at = Math.max(0, music.next - ctx.currentTime);
      const bar = Math.floor(music.step / 8) % 4;
      const i = music.step % 8;
      const mel = (music.boss ? BOSS_MELODY : MELODY)[bar];
      const root = music.boss ? 98 : 131;
      if (i % 2 === 0) tone(hz(root / 2, mel[0]), hz(root / 2, mel[0]), beat * 1.6, { type: 'triangle', vol: 0.16, at });
      if (i % 4 === 0) noise(0.05, { freq: 120, q: 0.6, vol: 0.25, at, type: 'lowpass' });
      if (i % 4 === 2) noise(0.04, { freq: 5000, q: 1, vol: 0.08, at, type: 'highpass' });
      tone(hz(root * 2, mel[i % 4] + (i >= 4 ? 12 : 0)), hz(root * 2, mel[i % 4] + (i >= 4 ? 12 : 0)), beat * 0.8, { type: 'square', vol: 0.035, at });
      music.step += 1;
      music.next += beat;
    }
  }

  const fx = {
    // Ett slag som träffar; tunga träffar dånar mer.
    hit(dmg) {
      const now = performance.now();
      if (now - lastHit < 45) return;
      lastHit = now;
      const heavy = dmg >= 15;
      noise(heavy ? 0.18 : 0.08, { freq: heavy ? 500 : 1400, q: 0.8, vol: heavy ? 0.6 : 0.35 });
      tone(heavy ? 160 : 260, heavy ? 50 : 120, heavy ? 0.2 : 0.09, { type: 'triangle', vol: heavy ? 0.5 : 0.3 });
    },
    swing() { noise(0.07, { freq: 2500, q: 2, vol: 0.12, type: 'highpass' }); },
    // Ett slag som tas emot i blocket: en metallisk "klonk".
    block() {
      const now = performance.now();
      if (now - lastHit < 45) return;
      lastHit = now;
      tone(900, 700, 0.12, { type: 'square', vol: 0.12 });
      tone(1350, 1100, 0.1, { type: 'triangle', vol: 0.08 });
      noise(0.05, { freq: 3000, q: 3, vol: 0.12 });
    },
    // Blocket går sönder: en spricka och en fallande ton.
    guardBreak() {
      noise(0.3, { freq: 1800, q: 0.8, vol: 0.45 });
      tone(700, 120, 0.4, { type: 'sawtooth', vol: 0.18 });
    },
    jump() { tone(220, 520, 0.12, { type: 'square', vol: 0.08 }); },
    spring() { tone(180, 900, 0.3, { type: 'sine', vol: 0.18 }); tone(360, 1500, 0.25, { type: 'triangle', vol: 0.08, at: 0.05 }); },
    // Varje specialattack låter olika: först en ton efter attackens sort (skott, stråle, smäll
    // ...) och sedan en färg efter elementet (eld fräser, vatten bubblar, el knastrar ...).
    special(kind, element) {
      const k = SPECIAL_SOUND[kind] || 'charge';
      if (k === 'pew') { tone(1400, 300, 0.18, { type: 'square', vol: 0.12 }); tone(2100, 500, 0.12, { type: 'triangle', vol: 0.06, at: 0.02 }); }
      else if (k === 'beam') { tone(220, 880, 0.6, { type: 'sawtooth', vol: 0.1 }); tone(223, 885, 0.6, { type: 'sawtooth', vol: 0.08 }); }
      else if (k === 'boom') { noise(0.6, { freq: 160, q: 0.5, vol: 0.6, type: 'lowpass' }); tone(120, 35, 0.6, { type: 'sine', vol: 0.4 }); }
      else if (k === 'whoosh') { noise(0.35, { freq: 900, q: 0.7, vol: 0.3 }); tone(300, 1200, 0.25, { type: 'triangle', vol: 0.08 }); }
      else if (k === 'fall') { tone(2400, 500, 0.7, { type: 'sine', vol: 0.1 }); noise(0.5, { freq: 200, q: 0.5, vol: 0.5, at: 0.6, type: 'lowpass' }); }
      else if (k === 'magic') { notes([660, 880, 1100, 1320], 0.05, { type: 'triangle', vol: 0.1 }); }
      else if (k === 'shield') { tone(500, 500, 0.4, { type: 'sine', vol: 0.12 }); tone(750, 750, 0.4, { type: 'sine', vol: 0.08 }); }
      else if (k === 'clock') { for (let i = 0; i < 4; i++) tone(1800, 1700, 0.04, { type: 'square', vol: 0.1, at: i * 0.12 }); tone(400, 80, 0.6, { type: 'sine', vol: 0.15, at: 0.45 }); }
      else if (k === 'growl') { tone(90, 140, 0.4, { type: 'sawtooth', vol: 0.18 }); noise(0.4, { freq: 400, q: 1, vol: 0.2 }); }
      else { tone(180, 900, 0.35, { type: 'sawtooth', vol: 0.12 }); tone(270, 1350, 0.35, { type: 'square', vol: 0.06, at: 0.03 }); }
      const e = ELEMENT_SOUND[element];
      if (e === 'hiss') noise(0.4, { freq: 3000, q: 0.6, vol: 0.18, at: 0.05, type: 'highpass' });
      else if (e === 'bubble') for (let i = 0; i < 4; i++) tone(400 + Math.random() * 500, 900 + Math.random() * 400, 0.06, { type: 'sine', vol: 0.1, at: 0.05 + i * 0.06 });
      else if (e === 'zap') for (let i = 0; i < 5; i++) noise(0.03, { freq: 4000, q: 4, vol: 0.2, at: i * 0.05 });
      else if (e === 'ice') notes([2093, 2637, 3136], 0.05, { type: 'sine', vol: 0.06, at: 0.05 });
      else if (e === 'dark') tone(110, 55, 0.5, { type: 'sine', vol: 0.2, at: 0.05 });
      else if (e === 'fairy') notes([1568, 1976, 2349, 2637], 0.04, { type: 'triangle', vol: 0.06, at: 0.05 });
      else if (e === 'rock') noise(0.2, { freq: 300, q: 0.8, vol: 0.3, at: 0.08 });
      else if (e === 'metal') tone(1200, 1000, 0.3, { type: 'square', vol: 0.05, at: 0.05 });
    },
    // Bossen går in i fas 2: ett djupt vrål och en stigande larmton.
    bossPhase() {
      noise(1, { freq: 120, q: 0.4, vol: 0.7, type: 'lowpass' });
      tone(70, 40, 1, { type: 'sawtooth', vol: 0.3 });
      for (let i = 0; i < 3; i++) tone(440, 880, 0.25, { type: 'square', vol: 0.08, at: 0.3 + i * 0.3 });
    },
    superPower() {
      tone(90, 700, 0.6, { type: 'sawtooth', vol: 0.18 });
      noise(0.6, { freq: 300, q: 0.5, vol: 0.3, type: 'lowpass' });
    },
    ko() {
      noise(0.7, { freq: 220, q: 0.4, vol: 0.7, type: 'lowpass' });
      tone(200, 30, 0.8, { type: 'sawtooth', vol: 0.3 });
    },
    win() { notes([523, 659, 784, 1047, 784, 1047], 0.11, { type: 'square', vol: 0.12 }); },
    lose() { notes([392, 330, 262, 196], 0.18, { type: 'triangle', vol: 0.2 }); },
    // rank: 0 vanlig ... 4 gudomlig — sällsyntare lådor får en längre, ljusare melodi.
    box(rank) {
      noise(0.25, { freq: 800, q: 0.6, vol: 0.3 });
      const scale = [523, 659, 784, 988, 1175, 1319, 1568];
      notes(scale.slice(0, 2 + Math.min(5, rank + 1)), 0.08, { type: 'triangle', vol: 0.18, at: 0.15 });
      if (rank >= 3) notes([1568, 2093, 1568, 2093], 0.06, { type: 'square', vol: 0.06 });
    },
    quest() { notes([784, 988, 1319], 0.07, { type: 'square', vol: 0.1 }); },
    // Stora festen: en stigande fanfar och smällande fyrverkerier (fler när det är stort).
    fanfare(big) {
      notes([392, 523, 659, 784, 1047], 0.09, { type: 'square', vol: 0.11 });
      tone(1047, 1047, 0.6, { type: 'triangle', vol: 0.15, at: 0.45 });
      tone(1319, 1319, 0.6, { type: 'triangle', vol: 0.1, at: 0.45 });
      for (let i = 0; i < (big ? 7 : 3); i++) {
        const at = 0.5 + i * 0.22 + Math.random() * 0.1;
        noise(0.35, { freq: 600 + Math.random() * 1500, q: 0.7, vol: 0.35, at });
        tone(1800 + Math.random() * 800, 300, 0.3, { type: 'sine', vol: 0.05, at: at - 0.15 });
      }
    },
    challenge() {
      tone(110, 220, 0.25, { type: 'sawtooth', vol: 0.2 });
      tone(165, 330, 0.25, { type: 'sawtooth', vol: 0.12, at: 0.12 });
    },
  };

  const api = { get muted() { return muted; } };
  // Musiken (startMusic/stopMusic/musicTense) går inte via ready(): den ska kunna sättas på
  // innan ljudet vaknat och börjar då spela när det vaknar.
  api.startMusic = (boss) => {
    music.boss = !!boss;
    music.tense = false;
    if (music.on) return;
    music.on = true;
    music.step = 0;
    music.next = ctx ? ctx.currentTime + 0.05 : 0;
    clearInterval(music.timer);
    music.timer = setInterval(() => {
      if (ctx && music.next < ctx.currentTime) music.next = ctx.currentTime + 0.05;
      musicTick();
    }, 100);
  };
  api.stopMusic = () => { music.on = false; clearInterval(music.timer); music.timer = null; };
  api.musicTense = (on) => { music.tense = !!on; };
  for (const [name, fn] of Object.entries(fx)) api[name] = (...args) => { if (ready()) fn(...args); };
  api.toggle = () => {
    muted = !muted;
    try { localStorage.setItem('robotbattle-muted', muted ? '1' : '0'); } catch (e) { /* ingen lagring */ }
    wake();
    if (master) master.gain.value = muted ? 0 : 0.5;
    return muted;
  };
  return api;
}());
