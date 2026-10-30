'use strict';

// ---------- Konstanter ----------
const W = 960;
const H = 540;
const FLOOR = 450;
const GRAVITY = 2200;
const JUMP_V = 820;
const MAX_ENERGY = 100;
const SPECIAL_COST = 50;
// Turbomotorn (butiksvara) gör specialattacken billigare.
const specialCost = (f) => f.def.specialCost || SPECIAL_COST;
const STEP = 1 / 60;
const BODY_W = 46;
const BODY_H = 120;
const PUNCH_REACH = 62;
// Djupled: robotarna kan också gå in mot och ut från skärmen (z), inte bara åt sidorna. Slag
// och skott träffar bara om man står i ungefär samma "fil" — man kan alltså kliva undan.
const DEPTH = 230;        // banan sträcker sig från -DEPTH (långt bort) till +DEPTH (nära kameran)
const BODY_D = 40;        // robotens tjocklek i djupled, för träffar
const DEPTH_SPEED = 0.9;  // hur snabbt man går i djupled jämfört med åt sidorna
// Robotdata (namn, statistik, specialattacker) och odds delas med servern via shared.js,
// så att klienten aldrig kan visa något annat än vad servern faktiskt räknar med.
const { RARITY, ROBOTS, rankOf, ARENAS } = Shared;
const robotById = Shared.robotById;
const arenaById = Shared.arenaById;

// ---------- Hjälpfunktioner ----------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const lerp = (a, b, t) => a + (b - a) * t;

// ---------- Effekter ----------
function sparks(x, y, color, n, z = 0) {
  for (let i = 0; i < n; i++) {
    const a = rand(0, Math.PI * 2);
    const s = rand(80, 320);
    const life = rand(0.2, 0.55);
    game.particles.push({ x, y, z, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 80, vz: rand(-1, 1) * s * 0.6, life, max: life, color });
  }
}

// ---------- Strid ----------
// Står o i samma fil som z (djupled)? extra = hur bred attacken själv är i djupled.
const inLane = (o, z, extra = 0) => Math.abs(o.z - z) < o.d / 2 + extra;

function overlaps(o, x0, x1, top, bottom) {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  return !(right < o.x - o.w / 2 || left > o.x + o.w / 2 || bottom < o.y - o.h || top > o.y);
}

function hurt(target, dmg, dirX, knock, source) {
  if (target.dead || target.invuln > 0) return false;
  if (target.passive === 'shadow' && target.shadowCd <= 0 && source !== target) {
    // Skuggform: träffen glider rakt igenom, sedan laddas den om.
    target.shadowCd = 8;
    target.invuln = 0.3;
    sparks(target.x, target.y - target.h * 0.6, '#7a3aff', 16, target.z);
    return false;
  }
  if (target.passive === 'steadfast') { dmg *= 0.85; knock = 0; } // Orubblig
  if (target.def.noKnock) knock = 0; // Magnetstövlarna
  if (target.passive === 'rooted' && target.stillT >= 1) { dmg *= 0.6; knock = 0; } // Rotad
  if (source.passive === 'execute' && target.hp < target.maxHp * 0.3) dmg *= 1.5; // Själsfångst
  const punching = source.act && source.act.kind === 'punch';
  if (punching && source.passive === 'bloodrage' && source.hp < source.maxHp * 0.5) dmg *= 1.5; // Vargblod
  if (punching && source.def.crit && Math.random() < source.def.crit) {
    // Turchippet: en kritisk träff.
    dmg *= 3;
    game.shake = Math.max(game.shake, 0.35);
    sparks(target.x, target.y - target.h * 0.6, '#ffd93d', 22, target.z);
  }
  dmg *= source.enrage || 1; // bossens boostrade skada, se updateBossEnrage()
  dmg *= game.arena.dmgMul; // banans fysik, lika för båda sidorna
  dmg *= Shared.typeMultiplier(source.def.types, target.def.types); // typernas styrkor/svagheter
  dmg *= target.vulnT > 0 ? 1.4 : 1; // bara jokerns "Hån"
  if (source.dragonT > 0 && source.act && source.act.kind === 'punch') dmg *= 2; // Drakhjärtats Drakvrede
  if (target.dragonT > 0) knock = 0; // ...och då kan ingenting knuffa en
  if (game.training && target === game.ai) trainingHit(dmg);
  target.hp = Math.max(0, target.hp - dmg);
  // Taggrustningen: den som slår tar en del av skadan själv.
  if (target.def.thorns && punching && source !== target && !source.dead) {
    source.hp = Math.max(0, source.hp - dmg * target.def.thorns);
    if (source.hp <= 0) source.dead = true;
  }
  // Vampyrtanden: vanliga slag läker den som slår.
  if (source.def.lifesteal && source.act && source.act.kind === 'punch') {
    source.hp = Math.min(source.maxHp, source.hp + dmg * source.def.lifesteal);
  }
  // Spegelsköldens Spegelvärn: samma skada studsar tillbaka på den som slog.
  if (target.mirrorT > 0 && source !== target && !source.dead) {
    source.hp = Math.max(0, source.hp - dmg);
    source.flash = 0.1;
    sparks(source.x, source.y - source.h * 0.6, '#dff6ff', 12, source.z);
    if (source.hp <= 0) source.dead = true;
  }
  target.act = null;
  target.dashT = 0;
  target.hurt = 0.22;
  target.invuln = 0.28;
  target.flash = 0.1;
  target.kx = dirX * knock;
  target.energy = Math.min(MAX_ENERGY, target.energy + 8);
  source.energy = Math.min(MAX_ENERGY, source.energy + 10);
  sparks(target.x, target.y - target.h * 0.6, target.def.color, dmg >= 15 ? 18 : 10, target.z);
  game.shake = Math.max(game.shake, dmg >= 15 ? 0.25 : 0.1);
  if (target.passive === 'rewind' && !target.rewound && target.hp < target.maxHp * 0.25 && target.hpLog.length && target.hpLog[0] > target.hp) {
    // Återspolning: tiden spolas tillbaka till hur det var för fyra sekunder sedan — räddar
    // till och med från en träff som annars hade slagit ut.
    target.rewound = true;
    target.hp = Math.max(target.hp, target.hpLog[0]);
    target.reviveT = 1.4;
    sparks(target.x, target.y - target.h * 0.6, '#ffe28a', 24, target.z);
    game.superBanner = { name: 'Återspolning', t: 1.4, mine: target === game.player };
  }
  if (target.hp <= 0) target.dead = true;
  return true;
}

function meleeHit(f, o, dmg, reach, knock) {
  const x0 = f.x + f.facing * (f.w / 2 - 10);
  const x1 = f.x + f.facing * (f.w / 2 + reach);
  if (!inLane(o, f.z, f.d / 2 + 14)) return false;
  if (!overlaps(o, x0, x1, f.y - f.h * 0.85, f.y - f.h * 0.15)) return false;
  return hurt(o, dmg, f.facing, knock, f);
}

function shoot(f, dmg, speed, r) {
  game.projectiles.push({
    owner: f, x: f.x + f.facing * (f.w / 2 + 8), y: f.y - f.h * 0.6, z: f.z,
    vx: f.facing * speed, dmg, r, color: f.def.eye === '#ffffff' ? f.def.color : f.def.eye,
  });
}

function wave(f, dir, dmg) {
  game.waves.push({ owner: f, x: f.x, z: f.z, vx: dir * 380, dir, dmg, travelled: 0 });
}

const SPECIALS = {
  projectile: {
    dur: 0.55, fires: [0.2],
    fire: (f, o, sp) => shoot(f, sp.dmg, 640, 14),
  },
  burst: {
    dur: 1.0, fires: [0.15, 0.45, 0.75],
    fire: (f, o, sp) => shoot(f, sp.dmg, 720, 8),
  },
  shockwave: {
    dur: 0.75, fires: [0.3],
    fire: (f, o, sp) => {
      wave(f, -1, sp.dmg);
      wave(f, 1, sp.dmg);
      game.shake = 0.3;
    },
  },
  dash: {
    dur: 0.55, fires: [0.12],
    fire: (f) => { f.dashT = 0.28; f.act.hit = false; },
  },
  smash: {
    dur: 0.65, fires: [0.28],
    fire: (f, o, sp) => {
      game.shake = Math.max(game.shake, 0.2);
      meleeHit(f, o, sp.dmg, 85 * f.def.scale, 520);
    },
  },
  annihilate: {
    dur: 0.8, fires: [0.35],
    fire: (f, o, sp) => {
      game.shake = Math.max(game.shake, 0.35);
      meleeHit(f, o, sp.dmg, 95 * f.def.scale, 620);
    },
  },
  lob: {
    dur: 0.6, fires: [0.2],
    fire: (f, o, sp) => {
      const x0 = f.x + f.facing * (f.w / 2 + 8);
      const y0 = f.y - f.h * 0.6;
      const vy = -500;
      const grav = 1300;
      const t = (-vy + Math.sqrt(vy * vy - 2 * grav * (y0 - FLOOR))) / grav;
      const vx = clamp((o.x - x0) / t, -650, 650);
      const vz = (o.z - f.z) / t;
      game.projectiles.push({ owner: f, x: x0, y: y0, z: f.z, vx, vy, vz, grav, dmg: sp.dmg, r: 11, blast: 90, color: f.def.eye });
    },
  },
  beam: {
    dur: 0.7, fires: [0.3],
    fire: (f, o, sp) => {
      const x0 = f.x + f.facing * (f.w / 2);
      const x1 = f.x + f.facing * 820;
      game.beams.push({ x0, x1, y: f.y - f.h * 0.55, z: f.z, t: 0.2, max: 0.2, color: f.def.color });
      if (inLane(o, f.z, 22) && overlaps(o, x0, x1, f.y - f.h * 0.75, f.y - f.h * 0.35)) hurt(o, sp.dmg, f.facing, 360, f);
    },
  },
  barrier: {
    dur: 0.5, fires: [0.1],
    fire: (f, o, sp) => {
      f.shieldT = 1.1;
      f.invuln = Math.max(f.invuln, 1.1);
      f.hp = Math.min(f.maxHp, f.hp + sp.heal);
      sparks(f.x, f.y - f.h / 2, f.def.eye, 16, f.z);
    },
  },
  orbital: {
    dur: 0.7, fires: [0.25],
    fire: (f, o, sp) => {
      [0, -90, 90].forEach((off, i) => {
        game.strikes.push({ owner: f, x: clamp(o.x + off, 30, W - 30), z: o.z, t: 0, delay: 0.55 + i * 0.2, dmg: sp.dmg, done: false });
      });
    },
  },
  overdrive: {
    dur: 0.5, fires: [0.1],
    fire: (f) => {
      f.buffT = 5;
      sparks(f.x, f.y - f.h / 2, f.def.accent, 20, f.z);
    },
  },
  spread: {
    dur: 0.55, fires: [0.2],
    fire: (f, o, sp) => {
      for (const vy of [-170, 0, 170]) {
        game.projectiles.push({
          owner: f, x: f.x + f.facing * (f.w / 2 + 8), y: f.y - f.h * 0.6, z: f.z,
          vx: f.facing * 620, vy, dmg: sp.dmg, r: 7, color: f.def.color,
        });
      }
    },
  },
  drain: {
    dur: 0.55, fires: [0.22],
    fire: (f, o, sp) => {
      if (meleeHit(f, o, sp.dmg, 70 * f.def.scale, 300)) {
        f.hp = Math.min(f.maxHp, f.hp + sp.heal);
        sparks(f.x, f.y - f.h / 2, '#ff4d6d', 12, f.z);
      }
    },
  },
  reflect: {
    dur: 0.45, fires: [0.1],
    fire: (f) => {
      f.reflectT = 2;
      sparks(f.x, f.y - f.h / 2, f.def.color, 14, f.z);
    },
  },
  freeze: {
    dur: 0.6, fires: [0.2],
    fire: (f, o, sp) => {
      shoot(f, sp.dmg, 600, 12);
      game.projectiles[game.projectiles.length - 1].freeze = 1.1;
      game.projectiles[game.projectiles.length - 1].color = '#9be8ff';
    },
  },
  snipe: {
    dur: 1.15, fires: [0.85],
    fire: (f, o, sp) => {
      const x0 = f.x + f.facing * (f.w / 2);
      const x1 = f.x + f.facing * 900;
      game.beams.push({ x0, x1, y: f.y - f.h * 0.55, z: f.z, t: 0.25, max: 0.25, color: '#ff3030' });
      game.shake = Math.max(game.shake, 0.2);
      if (inLane(o, f.z, 16) && overlaps(o, x0, x1, f.y - f.h * 0.75, f.y - f.h * 0.35)) hurt(o, sp.dmg, f.facing, 480, f);
    },
  },
  flurry: {
    dur: 1.4, fires: [0.15, 0.45, 0.75, 1.05],
    fire: (f, o, sp) => {
      const last = f.act.i === 4;
      f.x = clamp(f.x + f.facing * 30, f.w / 2, W - f.w / 2);
      meleeHit(f, o, last ? sp.dmg * 1.5 : sp.dmg, 70 * f.def.scale, last ? 450 : 110);
    },
  },
  boomerang: {
    dur: 0.55, fires: [0.2],
    fire: (f, o, sp) => {
      game.projectiles.push({
        owner: f, x: f.x + f.facing * (f.w / 2 + 8), y: f.y - f.h * 0.6, z: f.z,
        vx: f.facing * 480, dmg: sp.dmg, r: 10, color: f.def.color, turnAt: 210,
      });
    },
  },
  mine: {
    dur: 0.5, fires: [0.15],
    fire: (f, o, sp) => {
      const x = clamp(f.x + f.facing * 50, 24, W - 24);
      game.mines.push({ owner: f, x, z: f.z, armT: 0.55, life: 6, dmg: sp.dmg, r: 34, color: f.def.color });
      sparks(x, FLOOR - 6, f.def.accent, 8, f.z);
    },
  },
  grapple: {
    dur: 0.6, fires: [0.15],
    fire: (f, o, sp) => {
      game.projectiles.push({
        owner: f, x: f.x + f.facing * (f.w / 2 + 8), y: f.y - f.h * 0.6, z: f.z,
        vx: f.facing * 760, dmg: sp.dmg, r: 8, color: f.def.color, pull: true,
      });
    },
  },
  poison: {
    dur: 0.6, fires: [0.2],
    fire: (f, o, sp) => {
      const x0 = f.x + f.facing * (f.w / 2 + 8);
      const y0 = f.y - f.h * 0.6;
      const vy = -420;
      const grav = 1300;
      const t = (-vy + Math.sqrt(vy * vy - 2 * grav * (y0 - FLOOR))) / grav;
      const vx = clamp((o.x - x0) / t, -520, 520);
      game.projectiles.push({
        owner: f, x: x0, y: y0, z: f.z, vx, vy, vz: (o.z - f.z) / t, grav, dmg: 0, r: 10, blast: 0, color: '#8fe05a',
        cloud: { r: 88, life: 4.2, dmg: sp.dmg },
      });
    },
  },
  counter: {
    dur: 0.42, fires: [0, 0.4],
    fire: (f, o, sp) => {
      if (f.act.i === 1) {
        f.invuln = Math.max(f.invuln, 0.28);
        sparks(f.x, f.y - f.h / 2, f.def.eye, 10, f.z);
        return;
      }
      if (Math.abs(o.x - f.x) < (f.w + o.w) / 2 + 55 * f.def.scale) meleeHit(f, o, sp.dmg, 55 * f.def.scale, 360);
    },
  },
  meteorslam: {
    dur: 0.5, fires: [0.15],
    fire: (f, o, sp) => {
      game.strikes.push({ owner: f, x: clamp(o.x, 30, W - 30), z: o.z, t: 0, delay: 0.6, dmg: sp.dmg, done: false });
      game.shake = Math.max(game.shake, 0.3);
    },
  },
  teleport: {
    dur: 0.7, fires: [0.25],
    fire: (f, o, sp) => {
      sparks(f.x, f.y - f.h / 2, f.def.color, 14, f.z);
      const side = o.x >= f.x ? 1 : -1;
      f.x = clamp(o.x + side * (o.w / 2 + f.w / 2 + 10), f.w / 2, W - f.w / 2);
      f.z = o.z;
      f.facing = o.x >= f.x ? 1 : -1;
      sparks(f.x, f.y - f.h / 2, f.def.color, 14, f.z);
      meleeHit(f, o, sp.dmg, 50 * f.def.scale, 380);
    },
  },

  // ---- De gudomligas egna specialattacker ----
  // Unika: ingen annan robot har någon av de här tre mekanikerna.
  halo: {
    // En ljusring som sprider sig längs golvet åt ALLA håll, även i djupled — man måste hoppa
    // över kanten när den passerar. Läker samtidigt den som kastar den.
    dur: 0.6, fires: [0.25],
    fire: (f, o, sp) => {
      game.halos.push({ owner: f, x: f.x, z: f.z, r: 20, max: 420, speed: 460, dmg: sp.dmg, hit: false });
      f.hp = Math.min(f.maxHp, f.hp + sp.heal);
      sparks(f.x, f.y - f.h / 2, '#fff3b0', 20, f.z);
    },
  },
  quake: {
    // Tre skalv över HELA banan. Den som står på marken när ett skalv slår till tar skada —
    // hoppa i rätt ögonblick så klarar du dig.
    dur: 0.7, fires: [0.3],
    fire: (f, o, sp) => {
      game.quakes.push({ owner: f, x: f.x, z: f.z, t: 0, ticks: [0.35, 0.85, 1.35], i: 0, dmg: sp.dmg });
    },
  },
  blackhole: {
    // Ett svart hål öppnar sig där motståndaren står och suger in den i två sekunder, med skada
    // hela tiden, och imploderar sedan — gå därifrån så fort du kan.
    dur: 0.6, fires: [0.25],
    fire: (f, o, sp) => {
      game.holes.push({ owner: f, x: o.x, z: o.z, life: 2.2, max: 2.2, tickT: 0.45, dmg: sp.dmg, blast: sp.blast });
    },
  },
  wolves: {
    // Tre spökvargar springer mot motståndaren — de följer efter både åt sidorna och i
    // djupled, och smäller när de når fram. Spring undan eller hoppa över dem.
    dur: 0.6, fires: [0.25],
    fire: (f, o, sp) => {
      for (let i = 0; i < 3; i++) {
        game.wolves.push({ owner: f, x: f.x, z: f.z + (i - 1) * 40, t: -i * 0.35, life: 3.2, dmg: sp.dmg, done: false, boom: -1, dir: f.facing });
      }
    },
  },
  roots: {
    // Rötter rusar fram längs motståndarens fil (dess djupled när attacken kastas) och håller
    // fast den den träffar. Kliv ur filen i djupled så missar de.
    dur: 0.6, fires: [0.25],
    fire: (f, o, sp) => {
      game.roots.push({ owner: f, x0: f.x, dir: o.x >= f.x ? 1 : -1, z: o.z, t: 0, dmg: sp.dmg, hit: false });
    },
  },
  tether: {
    // En gyllene kedja binder motståndaren vid Valkyria i tre sekunder. Är den för långt bort
    // dras den in och tar skada — men den som står nära klarar sig.
    dur: 0.5, fires: [0.2],
    fire: (f, o, sp) => {
      game.tethers.push({ owner: f, target: o, life: 3, max: 3, tickT: 0.5, dmg: sp.dmg });
    },
  },
  timestop: {
    // Ett jättelikt urverk öppnar sig under motståndaren. Inne i det går tiden långsamt (allt
    // går i en tredjedels fart) och varje tick gör ont — ta dig ut ur cirkeln!
    dur: 0.6, fires: [0.25],
    fire: (f, o, sp) => {
      game.clocks.push({ owner: f, x: o.x, z: o.z, r: 165, life: 3.2, max: 3.2, tickT: 0.8, dmg: sp.dmg });
      sparks(o.x, FLOOR - 40, '#ffe28a', 16, o.z);
    },
  },
  meteor: {
    // Sju meteorer faller en i taget där motståndaren står just då. En röd ring på marken
    // visar var varje meteor slår ner — fortsätt röra på dig!
    dur: 0.7, fires: [0.3],
    fire: (f, o, sp) => {
      for (let i = 0; i < 7; i++) {
        game.meteors.push({ owner: f, t: -i * 0.34, delay: 0.75, x: o.x, z: o.z, dmg: sp.dmg, locked: false, boom: -1 });
      }
    },
  },
  tide: {
    // Två vattenväggar sköljer över hela banan. Varje vägg har bara EN lucka i djupled — gå
    // in i luckan innan vågen når dig. Hoppa över går inte, vågen är för hög.
    dur: 0.7, fires: [0.3],
    fire: (f, o, sp) => {
      const dir = o.x >= f.x ? 1 : -1;
      const g1 = (Math.random() * 2 - 1) * (DEPTH - 50);
      const g2 = clamp(-g1 + (Math.random() - 0.5) * 80, -(DEPTH - 50), DEPTH - 50);
      for (const [i, gapZ] of [g1, g2].entries()) {
        game.tides.push({ owner: f, x: f.x + dir * 30 - dir * i * 380, dir, speed: 400, gapZ, gapW: 110, dmg: sp.dmg, hit: false });
      }
    },
  },

  // ---- Jokerns egna specialattacker ----
  // Unika för jokern — ingen annan robot delar någon av dessa sex mekaniker, till skillnad
  // från den gamla lösningen som bara återanvände andra robotars befintliga attacktyper.
  copycat: {
    dur: 0.5, fires: [0.2],
    fire: (f, o, sp) => {
      const theirs = o.def.special;
      // Två jokrar som kopierar varandra skulle annars rekursera i oändlighet — då blir det
      // i stället ett vanligt, lite hårdare slag.
      if (!theirs || theirs.type === 'copycat') {
        meleeHit(f, o, sp.dmg, 60 * f.def.scale, 320);
        return;
      }
      sparks(f.x, f.y - f.h / 2, o.def.color, 14, f.z);
      SPECIALS[theirs.type].fire(f, o, theirs);
    },
  },
  gamble: {
    dur: 0.5, fires: [0.2],
    fire: (f, o, sp) => {
      if (Math.random() < 0.5) {
        meleeHit(f, o, sp.dmg * 2, 70 * f.def.scale, 440);
        sparks(f.x, f.y - f.h / 2, '#ffd93d', 22, f.z);
        game.shake = Math.max(game.shake, 0.25);
      } else {
        f.buffT = Math.max(f.buffT, 2.5); // helt bom, men inte helt förgäves
        sparks(f.x, f.y - f.h / 2, f.def.accent, 10, f.z);
      }
    },
  },
  swap: {
    dur: 0.5, fires: [0.2],
    fire: (f, o) => {
      // Drar båda mot samma liv mitt emellan — farligt om man leder, en räddning om man inte
      // gör det. Kringgår invuln med flit (det är ödet som byts, inget vanligt slag).
      const mid = (f.hp + o.hp) / 2;
      f.hp = clamp(mid, 0, f.maxHp);
      o.hp = clamp(mid, 0, o.maxHp);
      sparks(f.x, f.y - f.h / 2, f.def.color, 14, f.z);
      sparks(o.x, o.y - o.h / 2, o.def.color, 14, o.z);
      if (f.hp <= 0) f.dead = true;
      if (o.hp <= 0) o.dead = true;
    },
  },
  jinx: {
    dur: 0.5, fires: [0.2],
    fire: (f, o) => {
      o.energy = 0;
      o.jinxT = 4;
      sparks(o.x, o.y - o.h / 2, '#5a5366', 16, o.z);
    },
  },
  allin: {
    dur: 0.6, fires: [0.25],
    fire: (f, o, sp) => {
      const cost = Math.min(f.hp - 1, f.maxHp * 0.2); // offrar upp till 20 % av max-HP, dör aldrig av det
      f.hp -= cost;
      meleeHit(f, o, sp.dmg + cost * 2, 80 * f.def.scale, 500);
      sparks(f.x, f.y - f.h / 2, '#ff3030', 18, f.z);
      game.shake = Math.max(game.shake, 0.25);
    },
  },
  drawcard: {
    dur: 0.5, fires: [0.15],
    fire: (f, o, sp) => {
      const draw = ['buff', 'shield', 'heal'][Math.floor(Math.random() * 3)];
      if (draw === 'buff') f.buffT = Math.max(f.buffT, 4);
      else if (draw === 'shield') { f.shieldT = 1.5; f.invuln = Math.max(f.invuln, 1.5); }
      else f.hp = Math.min(f.maxHp, f.hp + sp.heal);
      sparks(f.x, f.y - f.h / 2, f.def.eye, 16, f.z);
    },
  },
  steal: {
    dur: 0.5, fires: [0.2],
    fire: (f, o, sp) => {
      const take = Math.min(o.energy, sp.steal);
      o.energy -= take;
      f.energy = Math.min(MAX_ENERGY, f.energy + take);
      sparks(o.x, o.y - o.h / 2, f.def.eye, 14, o.z);
    },
  },
  taunt: {
    dur: 0.5, fires: [0.2],
    fire: (f, o) => {
      o.vulnT = 3;
      sparks(o.x, o.y - o.h / 2, '#ff3030', 12, o.z);
    },
  },
  prophecy: {
    dur: 0.6, fires: [0.2],
    fire: (f, o, sp) => {
      // Återanvänder samma försenade-nedslag-system som orbital/meteorslam: siktet syns i förväg,
      // och flyttar man sig undan hinner man missa den helt.
      game.strikes.push({ owner: f, x: clamp(o.x, 30, W - 30), z: o.z, t: 0, delay: 1.1, dmg: sp.dmg, done: false });
    },
  },
  swapplace: {
    dur: 0.5, fires: [0.15],
    fire: (f, o) => {
      const fx = f.x;
      const fz = f.z;
      const ff = f.facing;
      f.x = o.x; f.z = o.z; f.facing = o.facing;
      o.x = fx; o.z = fz; o.facing = ff;
      sparks(f.x, f.y - f.h / 2, f.def.color, 12, f.z);
      sparks(o.x, o.y - o.h / 2, o.def.color, 12, o.z);
    },
  },
};

class Fighter {
  // De passiva förmågorna som räknar tid: Skuggform laddas, Havets kraft läker och
  // Återspolning minns HP bakåt i tiden.
  updatePassive(dt) {
    if (this.dead) return;
    if (this.passive === 'shadow') this.shadowCd = Math.max(0, this.shadowCd - dt);
    if (this.passive === 'tidal') this.hp = Math.min(this.maxHp, this.hp + 1.5 * dt);
    if (this.passive === 'rewind') {
      this.hpLogT -= dt;
      if (this.hpLogT <= 0) {
        this.hpLogT = 0.5;
        this.hpLog.push(this.hp);
        if (this.hpLog.length > 8) this.hpLog.shift(); // 8 x 0,5 s = fyra sekunder
      }
    }
  }

  constructor(def, x, facing) {
    this.def = def;
    this.w = BODY_W * def.scale;
    this.h = BODY_H * def.scale;
    this.d = BODY_D * def.scale;
    this.x = x;
    this.y = FLOOR;
    this.z = 0;
    this.facing = facing;
    this.vy = 0;
    this.kx = 0;
    this.onGround = true;
    this.hp = def.hp;
    this.maxHp = def.hp;
    this.energy = def.startEnergy || 30; // Energikärnan: full energi från start
    this.act = null;
    this.atkCd = 0;
    this.hurt = 0;
    this.invuln = 0;
    this.flash = 0;
    this.dashT = 0;
    this.buffT = 0;
    this.shieldT = 0;
    this.reflectT = 0;
    this.frozenT = 0;
    this.slowT = 0; // inne i Kronos urverk: allt går i en tredjedels fart
    // Supervapnets superkraft (se SUPERS): en gång per match, och bara om man bär ett supervapen.
    this.superReady = !!def.superPower;
    this.dragonT = 0;  // Drakvrede: dubbel slagskada, ingen knuff
    this.mirrorT = 0;  // Spegelvärn: skadan studsar tillbaka
    this.floatT = 0;   // Antigravitation: svävar hjälplöst i luften
    this.slam = null;  // { dmg, owner } — kraschen när Antigravitationen tar slut
    this.reviveT = 0;  // Livsljus: bara för att rita läkningen
    // De gudomligas passiva förmågor (def.passive), se PASSIVE i shared.js-robotarna.
    this.passive = def.passive ? def.passive.type : null;
    this.jumpHeld = false;   // Änglavingar: dubbelhoppet kräver ett nytt tryck i luften
    this.doubleUsed = false;
    this.shadowCd = 0;       // Skuggform: klar när den når 0
    this.rewound = false;    // Återspolning: bara en gång per match
    this.hpLog = [];         // Återspolning: HP de senaste sekunderna
    this.hpLogT = 0;
    this.stillT = 0;         // Rotad: hur länge Gaia stått still
    this.rootT = 0;          // fasthållen av Gaias Rotfäste
    this.jinxT = 0; // bara jokerns "Förbannelse": halverar energiåterhämtningen medan den räknar ner
    this.vulnT = 0; // bara jokerns "Hån": tar 40 % mer skada medan den räknar ner
    this.dead = false;
    this.moving = false;
    this.time = 0;
    this.walkT = 0;
    this.enrage = 1; // bara bossen: skalar skadan den gör, se updateBossEnrage()
  }

  startAct(kind) {
    if (kind === 'punch') {
      this.act = { kind, dur: 0.32, fires: [0.1], t: 0, i: 0, hit: false };
    } else {
      const spec = SPECIALS[this.def.special.type];
      this.act = { kind: 'special', dur: spec.dur, fires: spec.fires, t: 0, i: 0, hit: false };
    }
  }

  updateAct(dt, opp) {
    const a = this.act;
    a.t += dt * (this.buffT > 0 ? 1.5 : 1);
    while (this.act && a.i < a.fires.length && a.t >= a.fires[a.i]) {
      a.i++;
      if (a.kind === 'punch') {
        meleeHit(this, opp, this.def.punch * (this.buffT > 0 ? 1.4 : 1), PUNCH_REACH * this.def.scale, 240);
      } else {
        SPECIALS[this.def.special.type].fire(this, opp, this.def.special);
      }
    }
    if (this.act && a.t >= a.dur) {
      this.act = null;
      this.atkCd = 0.08;
    }
  }

  step(dt, input, opp, canFight) {
    this.time += dt;
    this.hurt = Math.max(0, this.hurt - dt);
    this.invuln = Math.max(0, this.invuln - dt);
    this.flash = Math.max(0, this.flash - dt);
    this.atkCd = Math.max(0, this.atkCd - dt * (this.buffT > 0 ? 2 : 1));
    this.buffT = Math.max(0, this.buffT - dt);
    this.shieldT = Math.max(0, this.shieldT - dt);
    this.reflectT = Math.max(0, this.reflectT - dt);
    this.frozenT = Math.max(0, this.frozenT - dt);
    this.jinxT = Math.max(0, this.jinxT - dt);
    this.vulnT = Math.max(0, this.vulnT - dt);
    const slow = this.slowT > 0 ? 0.33 : 1;
    this.slowT = Math.max(0, this.slowT - dt);
    this.dragonT = Math.max(0, this.dragonT - dt);
    this.mirrorT = Math.max(0, this.mirrorT - dt);
    this.reviveT = Math.max(0, this.reviveT - dt);
    this.rootT = Math.max(0, this.rootT - dt);
    const rooted = this.rootT > 0;
    const floating = this.floatT > 0;
    if (floating) {
      this.floatT -= dt;
      if (this.floatT <= 0) this.vy = 900; // kraschar ner
    }

    let walk = 0;
    let walkZ = 0;
    if (!this.dead) {
      this.facing = opp.x >= this.x ? 1 : -1;
      if (canFight) this.energy = Math.min(MAX_ENERGY, this.energy + 6 * dt * (this.jinxT > 0 ? 0.5 : 1) * (this.passive === 'solar' ? 2 : 1));
      if (canFight) this.updatePassive(dt);
      if (canFight && this.def.startShield && !this.startShieldDone) {
        // Sköldgeneratorn: osårbar de första sekunderna när striden väl börjat.
        this.startShieldDone = true;
        this.shieldT = this.def.startShield;
        this.invuln = Math.max(this.invuln, this.def.startShield);
      }
      if (this.hurt <= 0 && canFight && !floating) {
        if (input.super && this.superReady && !this.act) {
          this.superReady = false;
          useSuper(this, opp);
        }
        if (this.act) {
          this.updateAct(dt * slow, opp);
        } else {
          // Vargblod: Fenrir springer fortare under halva HP.
          const rage = this.passive === 'bloodrage' && this.hp < this.maxHp * 0.5 ? 1.2 : 1;
          walk = rooted ? 0 : input.dir * this.def.speed * (this.buffT > 0 ? 1.35 : 1) * game.arena.speedMul * slow * rage;
          walkZ = rooted ? 0 : (input.depth || 0) * this.def.speed * DEPTH_SPEED * (this.buffT > 0 ? 1.35 : 1) * game.arena.speedMul * slow * rage;
          if (input.jump && this.onGround && !rooted) {
            this.vy = -JUMP_V * (this.def.jumpMul || 1); // Fjäderskorna hoppar högre
            this.onGround = false;
          } else if (input.jump && !this.jumpHeld && !this.onGround && this.passive === 'doublejump' && !this.doubleUsed) {
            // Änglavingar: ett extra hopp mitt i luften.
            this.vy = -JUMP_V * 0.9 * (this.def.jumpMul || 1);
            this.doubleUsed = true;
            sparks(this.x, this.y - 10, '#fff3b0', 12, this.z);
          }
          this.jumpHeld = !!input.jump;
          if (input.attack && this.atkCd <= 0) {
            this.startAct('punch');
          } else if (input.special && this.energy >= specialCost(this)) {
            this.energy -= specialCost(this);
            this.startAct('special');
          }
        }
      }
    }

    let dash = 0;
    if (this.dashT > 0) {
      this.dashT -= dt;
      dash = this.facing * 1100;
      if (this.act && !this.act.hit && meleeHit(this, opp, this.def.special.dmg, 30, 420)) {
        this.act.hit = true;
        this.dashT = 0;
      }
    }

    this.moving = walk !== 0 || walkZ !== 0;
    this.stillT = this.moving || !this.onGround ? 0 : this.stillT + dt; // Rotad
    if (this.moving) this.walkT += dt;
    this.x += (walk + dash + this.kx) * dt;
    this.kx *= Math.exp(-9 * dt);
    this.x = clamp(this.x, this.w / 2, W - this.w / 2);
    this.z = clamp(this.z + walkZ * dt, -DEPTH, DEPTH);

    if (floating) {
      // Antigravitation: lyfts mjukt upp och hänger kvar där.
      this.y += (FLOOR - 170 - this.y) * Math.min(1, dt * 4);
      this.vy = 0;
      this.onGround = false;
      return;
    }
    this.vy += GRAVITY * game.arena.gravityMul * dt;
    this.y += this.vy * dt;
    if (this.y >= FLOOR) {
      this.y = FLOOR;
      this.vy = 0;
      this.onGround = true;
      this.doubleUsed = false;
      if (this.slam) {
        const { dmg, owner } = this.slam;
        this.slam = null;
        game.shake = Math.max(game.shake, 0.45);
        sparks(this.x, FLOOR - 6, '#b46bff', 22, this.z);
        hurt(this, dmg, Math.sign(this.x - owner.x) || 1, 200, owner);
      }
    }
  }
}

// Vem en attack från `owner` ska träffa. I en vanlig match är det bara den andra. I en
// kungastrid (game.allies) slåss spelaren och fyra AI-robotar tillsammans mot kungen, som i
// sin tur anfaller den i laget den just nu siktar på (game.ai.target, se chooseBossTarget).
function enemyOf(owner) {
  if (owner === game.ai) return game.ai.target || game.player;
  return game.ai;
}

function separate(a, b) {
  if (a.dead || b.dead) return;
  const minDx = ((a.w + b.w) / 2) * 0.85;
  const dx = b.x - a.x;
  if (Math.abs(dx) >= minDx) return;
  if (Math.abs(a.y - b.y) > Math.min(a.h, b.h) * 0.7) return;
  if (Math.abs(a.z - b.z) > (a.d + b.d) / 2) return;
  const push = (minDx - Math.abs(dx)) / 2;
  const s = dx >= 0 ? 1 : -1;
  a.x = clamp(a.x - s * push, a.w / 2, W - a.w / 2);
  b.x = clamp(b.x + s * push, b.w / 2, W - b.w / 2);
}

function updateProjectiles(dt) {
  const list = game.projectiles;
  for (const p of list) {
    if (p.dead) continue;
    p.x += p.vx * dt;
    p.z = clamp((p.z || 0) + (p.vz || 0) * dt, -DEPTH - 30, DEPTH + 30);
    if (p.turnAt !== undefined && !p.turned) {
      p.travelled = (p.travelled || 0) + Math.abs(p.vx) * dt;
      if (p.travelled >= p.turnAt) { p.vx = -p.vx; p.turned = true; }
    }
    if (p.grav || p.vy) {
      p.vy += (p.grav || 0) * dt;
      p.y += p.vy * dt;
    }
    if (!p.grav && (p.y < -40 || p.y > FLOOR)) { p.dead = true; continue; }
    const target = enemyOf(p.owner);
    if (p.x < -60 || p.x > W + 60) { p.dead = true; continue; }
    for (const q of list) {
      if (q !== p && !q.dead && q.owner !== p.owner && Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < p.r + q.r) {
        p.dead = true;
        q.dead = true;
        sparks((p.x + q.x) / 2, p.y, '#ffffff', 10, p.z);
      }
    }
    if (p.dead) continue;
    const hit = Math.abs(p.x - target.x) < target.w / 2 + p.r && inLane(target, p.z, p.r)
      && p.y > target.y - target.h - p.r && p.y < target.y + p.r;
    if (hit && target.reflectT > 0) {
      sparks(p.x, p.y, target.def.color, 8, p.z);
      p.owner = target;
      p.vx = -p.vx;
      p.x += Math.sign(p.vx) * (target.w / 2 + p.r + 6);
      continue;
    }
    if (hit) {
      // Krok (grapple) drar motståndaren mot den som kastade den, i stället för bort.
      const dir = p.pull ? (Math.sign(p.owner.x - target.x) || 1) : Math.sign(p.vx);
      const knock = p.pull ? 260 : 300;
      if (hurt(target, p.dmg, dir, knock, p.owner)) {
        p.dead = true;
        if (p.freeze) {
          target.hurt = p.freeze;
          target.invuln = p.freeze + 0.1;
          target.frozenT = p.freeze;
        }
      }
    }
    if (!p.dead && p.grav && p.y >= FLOOR - 6) {
      p.dead = true;
      sparks(p.x, FLOOR - 10, p.color, 22, p.z);
      game.shake = Math.max(game.shake, 0.25);
      if (p.cloud) {
        game.clouds.push({ owner: p.owner, x: p.x, z: p.z, r: p.cloud.r, life: p.cloud.life, tickT: 0.15, dmg: p.cloud.dmg, color: p.color });
      } else if (Math.abs(p.x - target.x) < p.blast + target.w / 2 && inLane(target, p.z, p.blast * 0.6) && target.y >= FLOOR - 50) {
        hurt(target, p.dmg, Math.sign(target.x - p.x) || 1, 420, p.owner);
      }
    }
  }
  game.projectiles = list.filter((p) => !p.dead);
}

function updateWaves(dt) {
  for (const w of game.waves) {
    w.x += w.vx * dt;
    w.travelled += Math.abs(w.vx) * dt;
    const target = enemyOf(w.owner);
    if (w.travelled > 560 || w.x < -30 || w.x > W + 30) { w.dead = true; continue; }
    if (Math.abs(w.x - target.x) < target.w / 2 + 14 && inLane(target, w.z, 18) && target.y >= FLOOR - 26) {
      if (hurt(target, w.dmg, w.dir, 420, w.owner)) w.dead = true;
    }
  }
  game.waves = game.waves.filter((w) => !w.dead);
}

function updateBeams(dt) {
  for (const b of game.beams) b.t -= dt;
  game.beams = game.beams.filter((b) => b.t > 0);
}

function updateStrikes(dt) {
  for (const st of game.strikes) {
    st.t += dt;
    if (!st.done && st.t >= st.delay) {
      st.done = true;
      const target = enemyOf(st.owner);
      sparks(st.x, FLOOR - 20, st.owner.def.color, 16, st.z);
      game.shake = Math.max(game.shake, 0.2);
      if (Math.abs(st.x - target.x) < 46 && inLane(target, st.z, 34)) hurt(target, st.dmg, Math.sign(target.x - st.x) || 1, 300, st.owner);
    }
  }
  game.strikes = game.strikes.filter((st) => st.t < st.delay + 0.25);
}

function updateMines(dt) {
  for (const m of game.mines) {
    m.armT = Math.max(0, m.armT - dt);
    m.life -= dt;
    if (m.dead) continue;
    const target = enemyOf(m.owner);
    if (m.armT <= 0 && Math.abs(m.x - target.x) < m.r + target.w / 2 && inLane(target, m.z, m.r * 0.6) && target.y >= FLOOR - 40) {
      m.dead = true;
      sparks(m.x, FLOOR - 10, m.color, 20, m.z);
      game.shake = Math.max(game.shake, 0.25);
      hurt(target, m.dmg, Math.sign(target.x - m.x) || 1, 400, m.owner);
    } else if (m.life <= 0) {
      m.dead = true;
    }
  }
  game.mines = game.mines.filter((m) => !m.dead);
}

function updateHalos(dt) {
  for (const h of game.halos) {
    h.r += h.speed * dt;
    const target = enemyOf(h.owner);
    const d = Math.hypot(target.x - h.x, target.z - h.z);
    if (!h.hit && Math.abs(d - h.r) < 26 + target.w / 2 && target.y >= FLOOR - 40) {
      if (hurt(target, h.dmg, Math.sign(target.x - h.x) || 1, 380, h.owner)) h.hit = true;
    }
  }
  game.halos = game.halos.filter((h) => h.r < h.max);
}

function updateQuakes(dt) {
  for (const q of game.quakes) {
    q.t += dt;
    if (q.i < q.ticks.length && q.t >= q.ticks[q.i]) {
      q.i++;
      game.shake = Math.max(game.shake, 0.35);
      const target = enemyOf(q.owner);
      sparks(target.x, FLOOR - 4, '#caa968', 10, target.z);
      if (target.y >= FLOOR - 4) hurt(target, q.dmg, Math.sign(target.x - q.owner.x) || 1, 160, q.owner);
    }
  }
  game.quakes = game.quakes.filter((q) => q.t < q.ticks[q.ticks.length - 1] + 0.3);
}

function updateHoles(dt) {
  for (const h of game.holes) {
    h.life -= dt;
    h.tickT -= dt;
    const target = enemyOf(h.owner);
    if (target.dead) continue;
    const dx = h.x - target.x;
    const dz = h.z - target.z;
    const d = Math.hypot(dx, dz);
    if (d > 4 && d < 320) {
      const pull = 175 * dt / d;
      target.x = clamp(target.x + dx * pull, target.w / 2, W - target.w / 2);
      target.z = clamp(target.z + dz * pull, -DEPTH, DEPTH);
    }
    if (h.tickT <= 0 && h.life > 0) {
      h.tickT = 0.45;
      if (d < 120) hurt(target, h.dmg, Math.sign(-dx) || 1, 0, h.owner);
    }
    if (h.life <= 0 && !h.done) {
      h.done = true;
      game.shake = Math.max(game.shake, 0.4);
      sparks(h.x, FLOOR - 60, '#b46bff', 26, h.z);
      if (d < 90) hurt(target, h.blast, Math.sign(-dx) || 1, 520, h.owner);
    }
  }
  game.holes = game.holes.filter((h) => !h.done);
}

function updateWolves(dt) {
  for (const w of game.wolves) {
    if (w.boom >= 0) { w.boom += dt; continue; }
    w.t += dt;
    if (w.t < 0) continue;
    w.life -= dt;
    const target = enemyOf(w.owner);
    const dx = target.x - w.x;
    const dz = target.z - w.z;
    const d = Math.hypot(dx, dz);
    if (d > 1) {
      w.x += (dx / d) * 330 * dt;
      w.z += (dz / d) * 330 * dt;
      w.dir = dx >= 0 ? 1 : -1;
    }
    if (d < 34 && target.y > FLOOR - 50 && !target.dead) {
      w.boom = 0;
      sparks(w.x, FLOOR - 20, '#9fe8ff', 14, w.z);
      hurt(target, w.dmg, w.dir, 300, w.owner);
    } else if (w.life <= 0) {
      w.boom = 0; // försvinner i ett moln
    }
  }
  game.wolves = game.wolves.filter((w) => w.boom < 0.35);
}

function updateRoots(dt) {
  for (const r of game.roots) {
    r.t += dt;
    const front = r.x0 + r.dir * 900 * r.t;
    const target = enemyOf(r.owner);
    const passed = r.dir > 0 ? front >= target.x : front <= target.x;
    if (!r.hit && passed && Math.abs(target.z - r.z) < 40 && target.y > FLOOR - 30 && !target.dead) {
      r.hit = true;
      if (hurt(target, r.dmg, r.dir, 0, r.owner)) target.rootT = 1.5;
    }
  }
  game.roots = game.roots.filter((r) => r.t < 1.6);
}

function updateTethers(dt) {
  for (const c of game.tethers) {
    c.life -= dt;
    c.tickT -= dt;
    const o = c.target;
    const f = c.owner;
    if (o.dead || f.dead) { c.life = 0; continue; }
    if (c.tickT <= 0) {
      c.tickT = 0.5;
      const d = Math.hypot(o.x - f.x, o.z - f.z);
      if (d > 200) {
        // För långt bort: kedjan rycker in en bit och gör ont.
        const k = 120 / d;
        o.x = clamp(o.x + (f.x - o.x) * k, o.w / 2, W - o.w / 2);
        o.z = clamp(o.z + (f.z - o.z) * k, -DEPTH, DEPTH);
        o.invuln = 0;
        hurt(o, c.dmg, Math.sign(f.x - o.x) || 1, 0, f);
      }
    }
  }
  game.tethers = game.tethers.filter((c) => c.life > 0);
}

function updateClocks(dt) {
  for (const c of game.clocks) {
    c.life -= dt;
    c.tickT -= dt;
    const target = enemyOf(c.owner);
    const inside = Math.hypot(target.x - c.x, target.z - c.z) < c.r;
    if (inside) target.slowT = 0.15; // håller i sig så länge man står kvar i urverket
    if (c.tickT <= 0) {
      c.tickT = 0.8;
      if (inside && !target.dead) hurt(target, c.dmg, Math.sign(target.x - c.x) || 1, 0, c.owner);
    }
  }
  game.clocks = game.clocks.filter((c) => c.life > 0);
}

function updateMeteors(dt) {
  for (const m of game.meteors) {
    if (m.boom >= 0) { m.boom += dt; continue; } // smällen ritas en kort stund efter nedslaget
    m.t += dt;
    const target = enemyOf(m.owner);
    if (!m.locked && m.t >= 0) {
      // Varje meteor siktar på där motståndaren står precis när den börjar falla.
      m.locked = true;
      m.x = clamp(target.x + (Math.random() * 2 - 1) * 25, 30, W - 30);
      m.z = clamp(target.z + (Math.random() * 2 - 1) * 25, -DEPTH, DEPTH);
    }
    if (m.locked && m.t >= m.delay) {
      m.boom = 0;
      game.shake = Math.max(game.shake, 0.22);
      sparks(m.x, FLOOR - 10, '#ff8a2a', 14, m.z);
      if (!target.dead && Math.hypot(target.x - m.x, target.z - m.z) < 58 && target.y > FLOOR - 110) {
        hurt(target, m.dmg, Math.sign(target.x - m.x) || 1, 260, m.owner);
      }
    }
  }
  game.meteors = game.meteors.filter((m) => m.boom < 0.45);
}

function updateTides(dt) {
  for (const w of game.tides) {
    w.x += w.dir * w.speed * dt;
    const target = enemyOf(w.owner);
    const inGap = Math.abs(target.z - w.gapZ) < w.gapW / 2 - 10;
    if (!w.hit && !target.dead && !inGap && Math.abs(target.x - w.x) < 26 + target.w / 2) {
      if (hurt(target, w.dmg, w.dir, 700, w.owner)) w.hit = true;
    }
  }
  game.tides = game.tides.filter((w) => (w.dir > 0 ? w.x < W + 80 : w.x > -80));
}

// ---------- Supervapnens superkrafter ----------
// Varje supervapen (se EQUIPMENT i shared.js) har en egen kraft som inget annat har. Den
// används en gång per match med Q eller I, och bara om man bär supervapnet.
const SUPERS = {
  megabeam: (f) => { game.megabeams.push({ owner: f, x: f.x, z: f.z, y: f.y - f.h * 0.55, dir: f.facing, t: 0, hit: false }); },
  thunder: (f) => { for (let i = 0; i < 5; i++) game.bolts.push({ owner: f, t: -0.15 - i * 0.3, x: 0, z: 0, done: false }); },
  dragon: (f) => { f.dragonT = 6; sparks(f.x, f.y - f.h / 2, '#ff6a1a', 24, f.z); },
  mirror: (f) => { f.mirrorT = 5; sparks(f.x, f.y - f.h / 2, '#dff6ff', 20, f.z); },
  revive: (f) => { f.hp = Math.min(f.maxHp, f.hp + f.maxHp * 0.5); f.reviveT = 1.4; sparks(f.x, f.y - f.h / 2, '#7dffb0', 26, f.z); },
  gravity: (f, o) => {
    if (o.dead) return;
    o.floatT = 2;
    o.act = null;
    o.dashT = 0;
    o.slam = { dmg: 16, owner: f };
  },
};

function useSuper(f, opp) {
  const power = f.def.superPower;
  if (!power || !SUPERS[power.type]) return;
  game.shake = Math.max(game.shake, 0.2);
  game.superBanner = { name: power.name, t: 1.4, mine: f === game.player };
  SUPERS[power.type](f, opp);
}

function updateSupers(dt) {
  for (const b of game.megabeams) {
    b.t += dt;
    const target = enemyOf(b.owner);
    if (!b.hit && b.t >= 0.4) {
      // Strålen laddas en kort stund och skjuter sedan tvärs över hela banan i ens egen fil.
      b.hit = true;
      game.shake = Math.max(game.shake, 0.5);
      if (inLane(target, b.z, 40) && b.dir * (target.x - b.x) > 0) hurt(target, 28, b.dir, 650, b.owner);
    }
  }
  game.megabeams = game.megabeams.filter((b) => b.t < 1.0);
  for (const b of game.bolts) {
    b.t += dt;
    if (!b.done && b.t >= 0) {
      const target = enemyOf(b.owner);
      b.done = true;
      b.x = target.x;
      b.z = target.z;
      game.shake = Math.max(game.shake, 0.3);
      sparks(target.x, target.y - target.h * 0.5, '#fff6a0', 14, target.z);
      if (!target.dead) {
        target.invuln = 0; // blixtarna kommer tätt — varje blixt ska träffa
        hurt(target, 6, Math.sign(target.x - b.owner.x) || 1, 120, b.owner);
      }
    }
  }
  game.bolts = game.bolts.filter((b) => b.t < 0.25);
}

function updateClouds(dt) {
  for (const c of game.clouds) {
    c.life -= dt;
    c.tickT -= dt;
    if (c.tickT <= 0) {
      c.tickT = 0.35;
      const target = enemyOf(c.owner);
      if (Math.abs(c.x - target.x) < c.r + target.w / 2 && inLane(target, c.z, c.r * 0.6) && target.y >= FLOOR - 60) {
        hurt(target, c.dmg, Math.sign(target.x - c.x) || 1, 40, c.owner);
      }
    }
  }
  game.clouds = game.clouds.filter((c) => c.life > 0);
}

// ---------- AI ----------
// Hur bra AI:n är. Lägre värden gör den enklare att slå.
const SKILL_EASY = { think: [0.3, 0.55], attack: 0.5, dodge: 0.25, special: 0.3, speed: 0.85, jitter: 0.06 };
const SKILL_HARD = { think: [0.16, 0.34], attack: 0.7, dodge: 0.55, special: 0.5, speed: 1, jitter: 0.04 };
const SKILL_MAX_LEVEL = 10; // nivån där AI:n når SKILL_HARD

// Bossarnas tre svårighetsgrader: hur bra AI:n spelar och hur mycket den stridstillfälliga
// boostern maxar ut (och hur snabbt den gör det). "medium" motsvarar den gamla, enda nivån.
const BOSS_TIERS = {
  easy: { skill: { think: [0.22, 0.42], attack: 0.58, dodge: 0.38, special: 0.4, speed: 0.95, jitter: 0.05 }, enrageMax: 2, enrageSeconds: 70 },
  medium: { skill: SKILL_HARD, enrageMax: 3, enrageSeconds: 60 },
  hard: { skill: { think: [0.1, 0.2], attack: 0.85, dodge: 0.72, special: 0.6, speed: 1.1, jitter: 0.02 }, enrageMax: 4, enrageSeconds: 45 },
};
const bossTier = (def) => BOSS_TIERS[def.difficulty] || BOSS_TIERS.medium;
// Monstervärldens kungar och drottning: den skarpaste AI:n av alla, och en ilska som snabbt
// växer till 2x skada (drottningen 2,5x).
const ROYAL_TIERS = {
  king: { skill: { think: [0.08, 0.16], attack: 0.9, dodge: 0.8, special: 0.7, speed: 1.15, jitter: 0.02 }, enrageMax: 2, enrageSeconds: 90 },
  queen: { skill: { think: [0.06, 0.12], attack: 0.95, dodge: 0.88, special: 0.8, speed: 1.2, jitter: 0.01 }, enrageMax: 2.5, enrageSeconds: 80 },
};

// AI:n blir svårare ju högre nivå du är — lätt i början, nästan SKILL_HARD från nivå 10.
function skillForLevel(level) {
  const t = clamp((level - 1) / (SKILL_MAX_LEVEL - 1), 0, 1);
  const mix = (a, b) => a + (b - a) * t;
  return {
    think: [mix(SKILL_EASY.think[0], SKILL_HARD.think[0]), mix(SKILL_EASY.think[1], SKILL_HARD.think[1])],
    attack: mix(SKILL_EASY.attack, SKILL_HARD.attack),
    dodge: mix(SKILL_EASY.dodge, SKILL_HARD.dodge),
    special: mix(SKILL_EASY.special, SKILL_HARD.special),
    speed: mix(SKILL_EASY.speed, SKILL_HARD.speed),
    jitter: mix(SKILL_EASY.jitter, SKILL_HARD.jitter),
  };
}

function makeBrain(skill = SKILL_EASY) {
  return { skill, timer: 0.9, dir: 0, depth: 0, attack: false, jump: false, special: false, retreat: 0 };
}

function incomingThreat(f, o) {
  for (const p of game.projectiles) {
    if (p.owner !== o || !inLane(f, p.z, p.r + 10)) continue;
    if (Math.sign(p.vx) === Math.sign(f.x - p.x) && Math.abs(p.x - f.x) < 300) return true;
  }
  for (const w of game.waves) {
    if (w.owner !== o || !inLane(f, w.z, 18)) continue;
    if (Math.sign(w.vx) === Math.sign(f.x - w.x) && Math.abs(w.x - f.x) < 240) return true;
  }
  return false;
}

function wantsSpecial(f, o, dist) {
  switch (f.def.special.type) {
    case 'projectile': return dist > 180 && dist < 650;
    case 'burst': return dist > 200 && dist < 700;
    case 'shockwave': return dist < 300 && o.onGround;
    case 'dash': return dist > 140 && dist < 420;
    case 'teleport': return dist > 200;
    case 'smash': return dist < (f.w + o.w) / 2 + 85 * f.def.scale - 12;
    case 'lob': return dist > 220 && dist < 650;
    case 'beam': return dist > 150 && dist < 780;
    case 'barrier': return incomingThreat(f, o) || f.hp < f.maxHp * 0.5;
    case 'orbital': return dist > 120;
    case 'overdrive': return dist < 420 && f.buffT <= 0;
    case 'spread': return dist > 150 && dist < 560;
    case 'drain': return dist < (f.w + o.w) / 2 + 70 * f.def.scale - 12;
    case 'reflect': return incomingThreat(f, o);
    case 'freeze': return dist > 200 && dist < 650;
    case 'snipe': return dist > 250;
    case 'flurry': return dist < (f.w + o.w) / 2 + 70 * f.def.scale - 12;
    case 'boomerang': return dist > 120 && dist < 500;
    case 'mine': return dist > 150 && dist < 500;
    case 'grapple': return dist > 200 && dist < 620;
    case 'poison': return dist > 180 && dist < 650;
    case 'counter': return dist < (f.w + o.w) / 2 + 70 * f.def.scale + 20;
    case 'meteorslam': return dist > 100;
    case 'annihilate': return dist < (f.w + o.w) / 2 + 95 * f.def.scale - 12;
    case 'copycat': return true; // anpassar sig alltid efter det den kopierar
    case 'gamble': return dist < (f.w + o.w) / 2 + 70 * f.def.scale - 12;
    case 'swap': return f.hp < f.maxHp * 0.6; // mest värt när man själv ligger risigt till
    case 'jinx': return o.energy > 30; // inte mycket att tömma annars
    case 'allin': return dist < (f.w + o.w) / 2 + 80 * f.def.scale - 12 && f.hp > f.maxHp * 0.3;
    case 'drawcard': return true;
    case 'steal': return o.energy > 20;
    case 'taunt': return dist < 500;
    case 'prophecy': return dist > 100;
    case 'swapplace': return dist > 220;
    case 'halo': return dist < 380 || f.hp < f.maxHp * 0.6;
    case 'quake': return o.onGround;
    case 'blackhole': return true;
    case 'timestop': return dist < 300;
    case 'wolves': return dist > 120;
    case 'roots': return true;
    case 'tether': return dist > 250;
    case 'meteor': return true;
    case 'tide': return true;
    default: return false;
  }
}

function aiInput(f, o, brain, dt) {
  const k = brain.skill;
  brain.timer -= dt;
  brain.retreat -= dt;
  const input = { dir: brain.dir * k.speed, depth: brain.depth * k.speed, jump: brain.jump, attack: brain.attack, special: brain.special };
  brain.jump = false;
  brain.special = false;

  if (brain.timer <= 0) {
    brain.timer = rand(k.think[0], k.think[1]);
    const dx = o.x - f.x;
    const dist = Math.abs(dx);
    const s = Math.sign(dx) || 1;
    const reach = (f.w + o.w) / 2 + PUNCH_REACH * f.def.scale - 10;
    brain.attack = false;
    brain.dir = 0;
    // Djupled: ställ sig i samma fil som motståndaren (annars missar slagen), men ibland kliva
    // undan i sidled i stället för att hoppa när något är på väg.
    const dz = o.z - f.z;
    brain.depth = Math.abs(dz) > Math.min(f.d, o.d) * 0.35 ? Math.sign(dz) : 0;
    if (brain.retreat > 0 && Math.random() < 0.4) brain.depth = f.z > 0 ? -1 : 1;

    if (incomingThreat(f, o) && Math.random() < k.dodge) {
      if (Math.random() < 0.5 && f.onGround) brain.jump = true;
      else brain.depth = f.z > 0 ? -1 : 1;
    }
    if (brain.retreat > 0) brain.dir = -s;
    else if (dist > reach) brain.dir = s;
    else if (Math.random() < k.attack) brain.attack = true;
    else brain.retreat = rand(0.35, 0.8);

    if (f.energy >= specialCost(f) && Math.random() < k.special && wantsSpecial(f, o, dist)) brain.special = true;
    if (f.onGround && Math.random() < k.jitter) brain.jump = true;
  }
  return input;
}

// ---------- Input ----------
const keys = {};
let specialBuffer = 0;    // kort tidsfönster så en tidig tryckning inte missas, lokalt och i vänmatch
let superBuffer = 0;      // samma sak för supervapnets superkraft (Q eller I)

function playerInput() {
  return {
    dir: (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0),
    // +z är mot kameran: S/↓ går närmare, W/↑ längre in i bilden.
    depth: (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0),
    jump: !!(keys.ShiftLeft || keys.ShiftRight || keys.KeyL),
    attack: !!(keys.Space || keys.KeyJ),
    special: specialBuffer > 0,
    super: superBuffer > 0,
  };
}

function triggerSpecial() { specialBuffer = 0.15; }
function triggerSuper() { superBuffer = 0.15; }

window.addEventListener('keydown', (e) => {
  const handled = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  if (handled.includes(e.code)) e.preventDefault();
  if (!e.repeat) {
    if (e.code === 'KeyE' || e.code === 'KeyK') triggerSpecial();
    if (e.code === 'KeyQ' || e.code === 'KeyI') triggerSuper();
    const onButton = e.target && (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT');
    if (e.code === 'Enter' && !onButton) onEnter();
    const locked = (game.stake || game.online) && (game.phase === 'intro' || game.phase === 'fight');
    if (e.code === 'Escape' && game.phase !== 'menu' && !locked) showSelect();
  }
  keys[e.code] = true;
});
window.addEventListener('keyup', (e) => { keys[e.code] = false; });
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
});

// ---------- Pekskärmskontroller (iPad/iPhone m.fl.) ----------
// Sätter EXAKT samma keys[...]-fält som tangentbordet redan läser (playerInput() bryr sig
// aldrig om var en tryckning kom ifrån) — så hela resten av spelet (strid, gå-runt-läget i
// Monstervärlden osv.) fungerar oförändrat, utan att veta att pekskärmar ens finns.
function bindTouchButton(id, onDown, onUp) {
  // document.getElementById direkt, inte byId — den hjälpfunktionen definieras längre ner i
  // filen (i skärm-avsnittet), och den här kodblocken körs vid sidladdning, före dess.
  const el = document.getElementById(id);
  if (!el) return;
  const down = (e) => { e.preventDefault(); onDown(); };
  const up = (e) => { e.preventDefault(); if (onUp) onUp(); };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
  // Webbläsaren skickar annars en "ghost click" efter pointerup på vissa enheter, vilket kan
  // trigga knappar som råkar ligga under fingret när man släpper.
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}
bindTouchButton('touch-left', () => { keys.ArrowLeft = true; }, () => { keys.ArrowLeft = false; });
bindTouchButton('touch-right', () => { keys.ArrowRight = true; }, () => { keys.ArrowRight = false; });
bindTouchButton('touch-up', () => { keys.ArrowUp = true; }, () => { keys.ArrowUp = false; });
bindTouchButton('touch-down', () => { keys.ArrowDown = true; }, () => { keys.ArrowDown = false; });
bindTouchButton('touch-jump', () => { keys.KeyL = true; }, () => { keys.KeyL = false; });
bindTouchButton('touch-attack', () => { keys.Space = true; }, () => { keys.Space = false; });
bindTouchButton('touch-special', () => { triggerSpecial(); });
bindTouchButton('touch-super', () => { triggerSuper(); });

// ---------- Spelstate ----------
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
// 3D-renderaren (render3d.js). null om WebGL eller three.js saknas — då ritas allt i 2D som förut.
const r3d = window.Render3D ? Render3D.init(document.getElementById('game3d')) : null;
if (!r3d) document.getElementById('game3d').hidden = true;
const overlay = document.getElementById('overlay');
const screens = {
  menu: document.getElementById('screen-menu'),
  auth: document.getElementById('screen-auth'),
  select: document.getElementById('screen-select'),
  result: document.getElementById('screen-result'),
  box: document.getElementById('screen-box'),
  friend: document.getElementById('screen-friend'),
  world: document.getElementById('screen-world'),
  teleport: document.getElementById('screen-teleport'),
  clan: document.getElementById('screen-clan'),
  shop: document.getElementById('screen-shop'),
  trade: document.getElementById('screen-trade'),
};
const hud = {
  namePlayer: document.getElementById('name-player'),
  nameAi: document.getElementById('name-ai'),
  typePlayer: document.getElementById('type-player'),
  typeAi: document.getElementById('type-ai'),
  hpPlayer: document.getElementById('hp-player'),
  hpAi: document.getElementById('hp-ai'),
  enPlayer: document.getElementById('en-player'),
  enAi: document.getElementById('en-ai'),
  arena: document.getElementById('arena-label'),
  superPlayer: document.getElementById('super-player'),
};

function showArenaLabel(def) {
  hud.arena.textContent = def.hint ? `BANA: ${def.name.toUpperCase()} — ${def.hint}` : `BANA: ${def.name.toUpperCase()}`;
}

// net är kontots "backend": LocalBackend sparar bara i webbläsaren (gäst, ingen inloggning
// behövs), RemoteBackend pratar med servern (konto, kan spela vänmatcher). Byts vid inloggning.
let net = new Backend.LocalBackend();
// Sant bara om den här sidan faktiskt har en egen inloggningsserver att prata med (satt i
// boot()) — t.ex. INTE på GitHub Pages, som bara kan visa sidor och aldrig kan svara på ett
// inloggningsförsök. Styr om "Logga in / skapa konto"-knappen ens visas som gäst.
let accountsAvailable = false;

const game = {
  phase: 'menu',      // menu | auth | select | box | friend | intro | fight | over
  acct: null,          // {inv, boxes, selected, dailyAvailable, dailyMinutes} — se shared.js: view()
  selectedId: 'bolt',
  mode: 'normal',       // normal | stake (gäller bara matcher mot AI)
  stake: false,          // pågående match är en insatsmatch
  boss: false,            // pågående match är en bossmatch (okänd identitet tills vunnen)
  bossTime: 0,             // hur länge bossmatchen pågått, styr hur boostad bossen är
  bossTier: null,          // {skill, enrageMax, enrageSeconds} för just den här bossens svårighetsgrad
  monster: false,          // pågående match är en monsterstrid (egen bana, ger utrustning i stället för låda)
  explore: null,           // {player, monsters, near, attackHeld} medan man går runt i Monstervärlden
  arena: arenaById.classic, // banan som pågående/senaste match spelades på, se pickArena()
  matchToken: null,       // matchen som pågår mot AI, från net.startMatch()
  result: null,
  opening: false,
  online: null,   // {isHost, oppName, ended, frame, lastGuestInput} medan en vänmatch pågår — se startFriendMatch()
  fighters: null, // [fighter0, fighter1] i vänmatch, i samma ordning för båda spelarna
  player: null,
  ai: null,
  brain: makeBrain(),
  projectiles: [],
  waves: [],
  beams: [],
  strikes: [],
  mines: [],
  clouds: [],
  halos: [],
  quakes: [],
  holes: [],
  wolves: [],
  roots: [],
  tethers: [],
  allies: [],     // [{ f, brain }] — dina fyra AI-robotar i en kungastrid, annars tomt
  megabeams: [],
  bolts: [],
  superBanner: null,
  clocks: [],
  meteors: [],
  tides: [],
  particles: [],
  shake: 0,
  introT: 0,
  banner: 0,
  overT: 0,
  winner: null,
};

const invCount = (id) => (game.acct ? game.acct.inv[id] || 0 : 0);
const totalRobots = () => (game.acct ? Object.values(game.acct.inv).reduce((a, b) => a + b, 0) : 0);
const canStake = () => totalRobots() >= 2;

function applyAcct(acct) {
  game.acct = acct;
  if (!acct.inv[game.selectedId]) game.selectedId = Object.keys(acct.inv)[0];
}

function dailyCountdown() {
  const m = game.acct.dailyMinutes;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

async function claimDaily() {
  try {
    const r = await net.claimDaily();
    applyAcct(r.acct);
  } catch (e) {
    // Ingen låda att hämta ännu — inget att göra.
  }
  showSelect();
}

function showScreen(name) {
  overlay.hidden = !name;
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

// modeOverride: 'boss' från bossknappen (alltid tillgänglig, bossen slumpas) eller 'monster'
// + monsterId. Annars avgörs läget av de vanliga match/insats-knapparna.
// forceAi: alltid mot AI, även när tillräckligt många spelar för riktiga motståndare.
async function startMatch(modeOverride, monsterId, forceAi) {
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  // När tillräckligt många spelar möter en vanlig match en riktig spelare i stället för AI.
  // Insatsmatcher, bossar och monster är alltid mot AI.
  if (!forceAi && !modeOverride && !(game.mode === 'stake' && canStake()) && pvpInfo && pvpInfo.pvp && roomCap) {
    startRealMatch();
    return;
  }
  byId('explore-bar').hidden = true; // en match (även en ny monsterstrid) stänger av gå-runt-läget
  if (friendRoom) leaveFriendRoom(); // en match mot AI ska aldrig lämna ett vänmatchsrum öppet i bakgrunden
  const wantStake = game.mode === 'stake' && canStake();
  byId('select-error').textContent = '';
  let started;
  try {
    started = await net.startMatch(game.selectedId, modeOverride || (wantStake ? 'stake' : 'normal'), monsterId);
  } catch (e) {
    byId('select-error').textContent = e.message;
    return;
  }
  applyAcct(started.acct);
  game.matchToken = started.match;
  game.stake = started.match.stake;
  game.boss = !!started.match.boss;
  game.monster = !!started.match.monster;
  game.bossTime = 0;
  game.mode = game.stake ? 'stake' : 'normal';
  // Banan slumpas lokalt för matcher mot AI — den påverkar inte ekonomin eller vem som vinner,
  // bara känslan i just den matchen, så den behöver inte vara server-synkad som i vänmatcher.
  // Monstervärlden har sin egen, fasta bana i stället för en slumpad — "en annan värld".
  game.arena = game.monster ? arenaById.direworld : Shared.pickArena(Math.random);
  showArenaLabel(game.arena);

  const pDef = applyEquipment(myDef(robotById[started.match.robot]));
  const aDef = robotById[started.match.opp]; // en eventuell AI-joker är alltid namnlös, får förvalet
  game.bossTier = game.boss ? bossTier(aDef) : aDef.royal ? ROYAL_TIERS[aDef.royal] : null;
  game.online = null;
  game.fighters = null;
  game.player = new Fighter(pDef, W * 0.25, 1);
  game.ai = new Fighter(aDef, W * 0.75, -1);
  game.brain = makeBrain(game.bossTier ? game.bossTier.skill : skillForLevel(game.acct.level));
  game.allies = aDef.royal ? makeAllies() : [];
  game.training = null;
  resetArena();
  hud.namePlayer.textContent = `DU (nivå ${game.acct.level}) · ${displayName(pDef, true)}${game.stake ? ' (insats)' : ''}`;
  hud.nameAi.textContent = game.boss ? '??? · MYSTISK ROBOT' : `${aDef.name} · ${game.monster ? 'MONSTER' : 'AI'}`;
  setHudType(hud.typePlayer, pDef);
  setHudType(hud.typeAi, aDef);
  showScreen(null);
}

// Tömmer banan på alla attacker och effekter och startar nedräkningen till en ny match.
function resetArena() {
  for (const k of ['projectiles', 'waves', 'beams', 'strikes', 'mines', 'clouds', 'halos', 'quakes', 'holes',
    'wolves', 'roots', 'tethers', 'megabeams', 'bolts', 'clocks', 'meteors', 'tides', 'particles']) game[k] = [];
  game.superBanner = null;
  game.winner = null;
  game.result = null;
  game.introT = 2.4;
  game.banner = 0;
  specialBuffer = 0;
  game.phase = 'intro';
}

// ---------- Träningsarenan ----------
// En träningsdocka som aldrig slår tillbaka och aldrig går sönder (den lagar sig själv), så
// man kan prova sina attacker i lugn och ro och se hur mycket skada de gör. Ger inga priser.
const DUMMY = {
  id: 'dummy', name: 'Träningsdocka', rarity: 'common', types: ['normal'],
  color: '#c9a36b', accent: '#7a5a32', eye: '#ff3b1f', head: 'round', extra: 'none',
  scale: 1.15, hp: 2000, speed: 170, punch: 0,
  special: { type: 'none', name: '—', desc: '' },
};

function startTraining(moving) {
  if (friendRoom) leaveFriendRoom();
  game.matchToken = null;
  game.stake = false;
  game.boss = false;
  game.monster = false;
  game.bossTier = null;
  game.allies = [];
  game.online = null;
  game.fighters = null;
  game.arena = arenaById.classic;
  showArenaLabel(game.arena);
  const pDef = applyEquipment(myDef(robotById[game.selectedId]));
  game.player = new Fighter(pDef, W * 0.3, 1);
  game.ai = new Fighter(DUMMY, W * 0.65, -1);
  game.brain = makeBrain(SKILL_EASY);
  game.training = { moving, total: 0, last: 0, hits: [], time: 0, moveT: 0, dir: 0, depth: 0 };
  resetArena();
  game.introT = 0.8;
  hud.namePlayer.textContent = `DU · ${displayName(pDef, true)}`;
  hud.nameAi.textContent = moving ? 'Träningsdocka · RÖRLIG' : 'Träningsdocka · STILLA';
  setHudType(hud.typePlayer, pDef);
  setHudType(hud.typeAi, DUMMY);
  byId('explore-bar').hidden = false;
  byId('explore-hint').textContent = 'Träning — prova dina attacker. Dockan slår aldrig tillbaka.';
  showScreen(null);
}

// Dockans "AI": står still, eller vandrar fram och tillbaka (även i djupled) — men anfaller aldrig.
function trainingInput(dt) {
  const tr = game.training;
  if (!tr.moving) return IDLE;
  tr.moveT -= dt;
  if (tr.moveT <= 0) {
    tr.moveT = rand(0.6, 1.5);
    tr.dir = [-1, 0, 1][Math.floor(Math.random() * 3)];
    tr.depth = [-1, 0, 1][Math.floor(Math.random() * 3)];
  }
  return { ...IDLE, dir: tr.dir * 0.6, depth: tr.depth * 0.6 };
}

function updateTraining(dt) {
  const tr = game.training;
  tr.time += dt;
  const { player, ai } = game;
  if (ai.hp < ai.maxHp * 0.5) ai.hp = ai.maxHp; // dockan lagar sig själv
  ai.dead = false;
  if (player.def.superPower && !player.superReady) {
    // I träningen laddas superkraften om efter fem sekunder, så man kan öva på den.
    tr.superT = (tr.superT || 5) - dt;
    if (tr.superT <= 0) { player.superReady = true; tr.superT = 5; }
  }
  tr.hits = tr.hits.filter((h) => tr.time - h.t < 5);
}

// Anropas från hurt(): räkna skadan på dockan.
function trainingHit(dmg) {
  const tr = game.training;
  tr.total += dmg;
  tr.last = dmg;
  tr.hits.push({ t: tr.time, dmg });
}

function drawTrainingStats() {
  const tr = game.training;
  const dps = tr.hits.reduce((a, h) => a + h.dmg, 0) / 5;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(W / 2 - 170, 60, 340, 62);
  ctx.font = 'bold 15px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffd93d';
  ctx.fillText(`Senaste träff: ${Math.round(tr.last)}   Totalt: ${Math.round(tr.total)}`, W / 2, 84);
  ctx.fillStyle = '#9fe8ff';
  ctx.fillText(`Skada per sekund: ${dps.toFixed(1)}`, W / 2, 108);
  ctx.restore();
}

// ---------- Kungastrid: du och fyra robotar mot en kung eller drottningen ----------
const RAID_ALLIES = 4;
function makeAllies() {
  const pool = ROBOTS.filter((r) => !r.monster && !r.boss && r.rarity !== 'divine' && r.id !== 'wildcard');
  const allies = [];
  for (let i = 0; i < RAID_ALLIES; i++) {
    const def = pool[Math.floor(Math.random() * pool.length)];
    // Lagkamraterna tål lite mer än vanligt, annars hinner kungen slå ut dem direkt.
    const f = new Fighter({ ...def, hp: Math.round(def.hp * 1.5) }, W * (0.08 + i * 0.07), 1);
    f.z = [-0.75, -0.3, 0.3, 0.75][i] * DEPTH;
    allies.push({ f, brain: makeBrain(SKILL_HARD) });
  }
  return allies;
}

// Kungen byter mål med jämna mellanrum: oftast den närmaste i laget, ibland någon annan.
function chooseBossTarget(dt) {
  const boss = game.ai;
  boss.retargetT = (boss.retargetT || 0) - dt;
  const alive = [game.player, ...game.allies.map((a) => a.f)].filter((f) => !f.dead);
  if (!alive.length) return;
  if (boss.target && !boss.target.dead && boss.retargetT > 0) return;
  boss.retargetT = rand(2.5, 4.5);
  alive.sort((a, b) => Math.hypot(a.x - boss.x, a.z - boss.z) - Math.hypot(b.x - boss.x, b.z - boss.z));
  boss.target = Math.random() < 0.7 ? alive[0] : alive[Math.floor(Math.random() * alive.length)];
}

// Ju längre en bossmatch pågår, desto hårdare slår bossen — upp till 3x skada efter en minut.
function updateBossEnrage(dt) {
  if (!game.bossTier) return;
  game.bossTime += dt;
  const { enrageMax, enrageSeconds } = game.bossTier;
  game.ai.enrage = clamp(1 + (enrageMax - 1) * (game.bossTime / enrageSeconds), 1, enrageMax);
}

// Matchen mot AI:n är slut. Resultatet (låda, ev. vunnen/förlorad robot) avgörs av servern
// (eller den lokala motsvarigheten som gäst) — klienten kan inte fuska till en bättre utgång.
function endMatch() {
  // I en kungastrid vinner laget när kungen faller, även om du själv redan ligger ner.
  const won = game.allies.length ? game.ai.hp <= 0 : game.player.hp > 0;
  game.phase = 'over';
  game.winner = won ? game.player : game.ai;
  game.overT = 1.6;
  game.result = null;
  const token = game.matchToken;
  net.finishMatch(token, won)
    .then((r) => { applyAcct(r.acct); game.result = r.result; })
    .catch((e) => { game.result = { won, stake: game.stake, gained: null, lost: null, error: e.message }; });
}

function onEnter() {
  if (game.phase === 'menu') showSelect();
  else if (game.phase === 'select') showHub();
  else if (game.phase === 'teleport') startMatch();
  else if (game.phase === 'over' && !screens.result.hidden && !game.online) startMatch();
  else if (game.phase === 'box') {
    if (game.acct.boxes > 0) openBox();
    else showSelect();
  }
}

// ---------- Skärmar ----------
const byId = (id) => document.getElementById(id);

// Jokerroboten heter "???" tills man döper den själv — och då bara för EN:s egen samling, inte
// för en motståndares likadana robot (vars namn man inte känner till).
function displayName(def, mine) {
  return (mine && def.id === 'wildcard' && game.acct && game.acct.wildcardName) || def.name;
}

// Jokerns attack beror på namnet du gett den, om du inte beskrivit en egen attack i text (den
// vinner alltid) — den här ger tillbaka DIN egen jokers riktiga attack, färg, huvudform och
// extradetalj i stället för förvalen, för kort/detaljvy och för striden (effekternas färg ärvs
// av robotens egen färg, se sparks()-anropen i SPECIALS). Elementet (typerna) följer alltid
// vilken attack som råkar vara aktiv just nu — special.types, se WILDCARD_SPECIALS/
// customWildcardSpecial i shared.js — så byter man attack byter man automatiskt element också.
// En motståndares namnlösa joker förblir förvalet som det är.
function myDef(def) {
  if (def.id !== 'wildcard') return def;
  const acct = game.acct;
  const special = Shared.wildcardSpecialFor(acct && acct.wildcardName, acct && acct.wildcardSpecialType, acct && acct.wildcardCustomSpecial);
  const color = (acct && acct.wildcardColor) || def.color;
  const head = (acct && acct.wildcardHead) || def.head;
  const extra = (acct && acct.wildcardExtra) || def.extra;
  const types = special.types || def.types;
  return { ...def, special, color, head, extra, types };
}

// Lägger på bonusen från det utrustningsföremål man bär (om något) — gäller alltid, oavsett
// vilken robot man valt eller vilken sorts match det är (vanlig, insats, boss, monster). Man
// kan bara bära ETT i taget, se equipItem().
function applyEquipment(def) {
  const itemId = game.acct && game.acct.equippedItem;
  if (!itemId) return def;
  const item = Shared.EQUIPMENT.find((e) => e.id === itemId);
  if (!item) return def;
  const out = { ...def };
  for (const [stat, amount] of Object.entries(item.stat)) out[stat] = (out[stat] || 0) + amount;
  if (item.power) out.superPower = item.power;
  if (item.effect) Object.assign(out, item.effect); // butiksvarornas egna effekter, t.ex. startEnergy

  return out;
}

// Typens/typernas namn (1–2 st, t.ex. "Eld/Flygande") plus vilka typer den sammanlagt är
// stark/svag mot — räknas fram dynamiskt mot varje enskild typ i stället för att slå upp en
// enda fast motsvarighet, eftersom en typ (och särskilt en dubbeltyp) kan ha flera.
function typesText(def) {
  const label = def.types.map((t) => Shared.TYPES[t].label).join('/');
  const allTypes = Object.keys(Shared.TYPES);
  const strongVs = allTypes.filter((t) => Shared.typeMultiplier(def.types, [t]) > 1);
  const weakVs = allTypes.filter((t) => Shared.typeMultiplier(def.types, [t]) < 1);
  const bits = [];
  if (strongVs.length) bits.push(`stark mot ${strongVs.map((t) => Shared.TYPES[t].label).join('/')}`);
  if (weakVs.length) bits.push(`svag mot ${weakVs.map((t) => Shared.TYPES[t].label).join('/')}`);
  return bits.length ? `${label} (${bits.join(', ')})` : label;
}

// Visar vems typ är vad under namnen i HUD:en under hela striden, inte bara innan man valt
// robot — en kort form (bara namnen, i typens egen färg), ingen stark/svag-lista här, den finns
// redan i detaljvyn innan matchen.
function setHudType(el, def) {
  el.textContent = def.types.map((t) => Shared.TYPES[t].label).join('/');
  el.style.color = Shared.TYPES[def.types[0]].color;
}

function detailText(def) {
  return `${displayName(def, true)} (${RARITY[def.rarity].label} · ${typesText(def)}) · HP ${def.hp} · Fart ${def.speed} · Slag ${def.punch} · ${def.special.name}: ${def.special.desc}${def.passive ? ` · ✦ ${def.passive.name}: ${def.passive.desc}` : ''}`;
}

function createCard(def, { locked = false, selected = false, isNew = false, reveal = false, compact = false, n = null } = {}) {
  const card = document.createElement('div');
  card.className = `card ${def.rarity}${locked ? ' locked' : ''}${selected ? ' selected' : ''}`
    + `${isNew ? ' new' : ''}${reveal ? ' reveal' : ''}${compact ? ' compact' : ''}`;

  const cv = document.createElement('canvas');
  cv.width = 130;
  cv.height = 170;
  if (r3d) r3d.drawCard(cv.getContext('2d'), def, { silhouette: locked });
  else drawRobot(cv.getContext('2d'), def, { x: 65, y: 160, facing: 1, silhouette: locked });
  card.appendChild(cv);

  const add = (cls, text) => {
    const line = document.createElement('div');
    line.className = cls;
    line.textContent = text;
    card.appendChild(line);
    return line;
  };
  add('name', locked ? '???' : `${displayName(def, true)}${n !== null ? ` ×${n}` : ''}`);
  add('rarity', locked ? 'Låst' : RARITY[def.rarity].label);
  if (!locked && !compact) {
    add('element', typesText(def)).style.color = Shared.TYPES[def.types[0]].color;
    add('stats', `HP ${def.hp} · Fart ${def.speed} · Slag ${def.punch}`);
    const sp = add('special', '');
    const b = document.createElement('b');
    b.textContent = def.special.name;
    sp.append(b, `: ${def.special.desc}`);
    if (def.passive) {
      const ps = add('special passive', '');
      const pb = document.createElement('b');
      pb.textContent = `✦ ${def.passive.name}`;
      ps.append(pb, `: ${def.passive.desc}`);
    }
  }
  return card;
}

// Visar om framstegen sparas till ens Claude-konto eller bara i webbläsaren som gäst.
// (Den här byggen av spelet har ingen inloggningsknapp — se boot() nedan.)
function renderAccountBar() {
  const bar = byId('account-bar');
  const btn = byId('btn-account');
  if (net.kind === 'artifact') {
    // Claude-sidan har redan en identitet (tittarens eget Claude-konto) — en egen
    // inloggningsknapp här skulle bara leda till ett API som inte finns där.
    bar.textContent = 'Ditt framsteg sparas till ditt Claude-konto';
    btn.hidden = true;
  } else if (net.kind === 'remote') {
    bar.textContent = `Inloggad som ${net.username} — framsteget sparas på kontot`;
    btn.hidden = false;
    btn.textContent = 'Logga ut';
  } else {
    bar.textContent = 'Spelar som gäst (sparas bara i den här webbläsaren)';
    btn.hidden = !accountsAvailable; // t.ex. GitHub Pages har ingen egen server att logga in mot
    btn.textContent = 'Logga in / skapa konto';
  }
}

function showSelect() {
  if (!game.acct) return; // kontot är inte klart inläst än (t.ex. Enter tryckt innan boot() hann klart)
  byId('explore-bar').hidden = true; // t.ex. Escape rakt ut ur Monstervärlden, inte bara "Tillbaka"-knappen
  game.explore = null;
  game.training = null;
  game.hub = null;
  if (friendRoom) leaveFriendRoom(); // t.ex. Escape rakt ut ur en vänmatch, inte bara "Lämna"-knappen
  game.phase = 'select';
  if (game.mode === 'stake' && !canStake()) game.mode = 'normal';
  if (!game.acct.inv[game.selectedId]) game.selectedId = Object.keys(game.acct.inv)[0];

  const cards = byId('cards');
  cards.replaceChildren();
  // Monster hör inte hemma i samlingen — de går aldrig att äga/spela som, bara att utmana i
  // Monstervärlden (se showMonsters), så de ska inte synas som ett permanent olåst "???"-kort.
  for (const def of ROBOTS.filter((r) => !r.monster)) {
    const n = invCount(def.id);
    const card = createCard(myDef(def), { locked: n === 0, selected: n > 0 && def.id === game.selectedId, compact: true, n });
    if (n > 0) {
      card.classList.add('pickable');
      card.addEventListener('mouseenter', () => { byId('detail').textContent = detailText(myDef(def)); });
      card.addEventListener('mouseleave', () => { byId('detail').textContent = detailText(myDef(robotById[game.selectedId])); });
      card.addEventListener('click', () => {
        game.selectedId = def.id;
        net.select(def.id).then((r) => applyAcct(r.acct));
        showSelect();
      });
    }
    cards.appendChild(card);
  }

  byId('detail').textContent = detailText(myDef(robotById[game.selectedId]));
  byId('btn-rename-wildcard').hidden = invCount('wildcard') < 1;
  byId('btn-choose-wildcard-attack').hidden = invCount('wildcard') < 1;
  byId('collection').textContent = `Robotar: ${totalRobots()} st · Lådor: ${game.acct.boxes} · 🪙 ${game.acct.coins || 0} mynt`;
  byId('level-info').textContent = `Nivå ${game.acct.level} · ${game.acct.xp}/${game.acct.xpNeeded} XP till nästa nivå`;
  byId('xp-fill').style.width = `${(100 * game.acct.xp) / game.acct.xpNeeded}%`;
  // En enda bossknapp: servern slumpar vilken boss du möter, och namnet döljs tills du vunnit
  // mot just den.
  const bossButtons = byId('boss-buttons');
  bossButtons.replaceChildren();
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'boss-btn tier-medium';
  btn.textContent = 'Möt en mystisk robot';
  btn.addEventListener('click', () => startMatch('boss'));
  bossButtons.appendChild(btn);
  byId('mode-normal').classList.toggle('active', game.mode === 'normal');
  byId('mode-stake').classList.toggle('active', game.mode === 'stake');
  byId('mode-stake').disabled = !canStake();
  const sel = robotById[game.selectedId];
  const isLastBolt = game.selectedId === 'bolt' && invCount('bolt') <= 1;
  byId('mode-info').textContent = game.mode === 'stake'
    ? isLastBolt
      ? 'Din sista Bolt går inte att sätta i insats — du har alltid minst en kvar. Matchen blir en vanlig match i stället.'
      : `Du sätter in 1 st ${sel.name}. Vinner du får du motståndarens robot och en låda. Förlorar du tappar du din insats.`
    : `Inget står på spel. Du får en låda om du vinner.${canStake() ? '' : ' Insatsmatch kräver minst 2 robotar.'}`;
  byId('btn-daily').hidden = !game.acct.dailyAvailable;
  byId('daily-info').textContent = game.acct.dailyAvailable
    ? 'Din dagliga låda väntar!'
    : `Nästa dagliga låda om ${dailyCountdown()}.`;
  byId('btn-boxes').hidden = game.acct.boxes === 0;
  byId('btn-boxes').textContent = `Öppna låda (${game.acct.boxes})`;
  byId('btn-friend').disabled = !roomCap;
  byId('friend-hint').textContent = roomCap ? '' : 'Vänmatcher går inte att spela i den här vyn just nu.';

  // Gästsamlingen ligger kvar i webbläsaren även efter inloggning. Ge en enkel väg att lägga
  // till den i kontot i stället för att den bara blir liggande oanvänd.
  const guest = net.kind === 'remote' ? Backend.readGuestSave() : null;
  byId('btn-import-guest').hidden = !guest;
  byId('import-info').textContent = guest
    ? `Du har en gästsamling på den här datorn: ${Shared.total(guest)} robotar och ${guest.boxes} lådor.`
    : '';

  byId('select-error').textContent = '';
  renderQuests();
  renderOnlineInfo();
  renderAccountBar();
  showScreen('select');
}

// ---------- Butiken ----------
// Varor som BARA går att köpa för mynt (se SHOP_ITEMS i shared.js), aldrig vinna i en strid.
// Mynt tjänar man i matcher och på den dagliga lådan.
function showShop(message) {
  if (!game.acct) return;
  game.phase = 'shop';
  byId('shop-coins').textContent = `🪙 Du har ${game.acct.coins || 0} mynt`;
  byId('shop-error').textContent = message || '';
  const list = byId('shop-list');
  list.replaceChildren();
  for (const item of [...Shared.SHOP_ITEMS].sort((a, b) => a.shop - b.shop)) {
    const owned = (game.acct.equipmentInv[item.id] || 0) > 0;
    const row = el('div', `shop-item${owned ? ' owned' : ''}`);
    const info = el('div', 'shop-info');
    info.append(el('div', 'name', item.name), el('div', 'stats', item.desc));
    const afford = (game.acct.coins || 0) >= item.shop;
    const btn = worldButton(owned ? 'Köpt ✓' : `Köp · ${item.shop} 🪙`, () => buyShopItem(item), { disabled: owned || !afford });
    row.append(info, btn);
    list.append(row);
  }
  showScreen('shop');
}

async function buyShopItem(item) {
  try {
    const r = await net.buyItem(item.id);
    applyAcct(r.acct);
  } catch (e) {
    showShop(e.message);
    return;
  }
  showShop(`Du köpte ${item.name}! Bär den under Utrustning.`);
}

byId('btn-shop').addEventListener('click', () => { game.fromHub = false; showShop(); });
byId('btn-shop-back').addEventListener('click', () => (game.fromHub ? showHub() : showSelect()));

// ---------- Byteshandel ----------
// Handlaren är en AI som byter bort robotar mot andra robotar som tillsammans är värda minst
// lika mycket (se trade() i shared.js) — t.ex. tio Nova (episka) mot en Omega (legendarisk).
const tradeState = { want: null, give: {} };
const tradeTotal = () => Object.entries(tradeState.give).reduce((sum, [id, n]) => sum + n * Shared.tradeValue(id), 0);
// Hur många av en robot man kan ge bort (alltid minst en Bolt kvar).
const tradeable = (id) => Math.max(0, invCount(id) - (id === 'bolt' ? 1 : 0));

function showTrade() {
  if (!game.acct) return;
  game.phase = 'trade';
  tradeState.give = {};
  byId('trade-error').textContent = '';
  byId('trade-reveal').replaceChildren();
  renderTradeWant();
  renderTradeGive();
  showScreen('trade');
}

function renderTradeWant() {
  const box = byId('trade-want');
  box.replaceChildren();
  for (const def of ROBOTS.filter((r) => Shared.canTradeFor(r.id))) {
    const card = createCard(myDef(def), { compact: true, selected: tradeState.want === def.id, n: invCount(def.id) || null });
    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = `${Shared.tradeValue(def.id)} p`;
    card.append(price);
    card.addEventListener('click', () => { tradeState.want = def.id; byId('trade-reveal').replaceChildren(); renderTradeWant(); renderTradeGive(); });
    box.append(card);
  }
}

function renderTradeGive() {
  const box = byId('trade-give');
  box.replaceChildren();
  const owned = ROBOTS.filter((r) => tradeable(r.id) > 0 && Shared.tradeValue(r.id) > 0)
    .sort((a, b) => Shared.tradeValue(a.id) - Shared.tradeValue(b.id));
  if (!owned.length) box.append(el('p', 'hint', 'Du har inga robotar att byta bort än — öppna lådor eller vinn matcher först.'));
  for (const def of owned) {
    const n = tradeState.give[def.id] || 0;
    const row = el('div', `give-row${n ? ' giving' : ''}`);
    const name = el('span', 'gname', displayName(myDef(def), true));
    name.append(el('span', 'gmeta', `${RARITY[def.rarity].label} · ${Shared.tradeValue(def.id)} p · du har ${invCount(def.id)}`));
    const minus = worldButton('−', () => setGive(def.id, n - 1), { secondary: true, disabled: n === 0 });
    const plus = worldButton('+', () => setGive(def.id, n + 1), { secondary: true, disabled: n >= tradeable(def.id) });
    row.append(name, minus, el('span', 'gcount', String(n)), plus);
    box.append(row);
  }
  renderTradeTotal();
}

function setGive(id, n) {
  tradeState.give[id] = clamp(n, 0, tradeable(id));
  if (!tradeState.give[id]) delete tradeState.give[id];
  byId('trade-error').textContent = '';
  renderTradeGive();
}

function renderTradeTotal() {
  const total = tradeTotal();
  const want = robotById[tradeState.want];
  const price = want ? Shared.tradeValue(want.id) : 0;
  const ok = !!want && total >= price;
  const t = byId('trade-total');
  t.classList.toggle('ok', ok);
  t.textContent = want ? `Du ger ${total} p · ${want.name} kostar ${price} p` : `Du ger ${total} p`;
  byId('btn-trade-do').disabled = !ok;
  byId('btn-trade-auto').disabled = !want;
  // Handlaren säger vad den tycker om affären.
  byId('trade-says').textContent = !want
    ? '🤖 Handlaren: "Välkommen! Vilken robot vill du ha? Jag byter mot vad som helst som är värt lika mycket."'
    : total === 0
      ? `🤖 Handlaren: "${want.name}? Ett fint val. Den kostar ${price} poäng i robotar."`
      : total < price
        ? `🤖 Handlaren: "Hmm, det räcker inte riktigt. Jag vill ha ${price - total} poäng till."`
        : total === price
          ? '🤖 Handlaren: "Affär! Tryck på Byt!"'
          : `🤖 Handlaren: "Generöst! Men jag ger ingen växel — du ger ${total - price} poäng för mycket."`;
}

// Fyller i ett förslag som går så jämnt ut som möjligt: de mest värdefulla som får plats
// först (och då helst sådana man har flera av), sedan mindre för att fylla upp resten.
function autoFillTrade() {
  const want = tradeState.want;
  if (!want) return;
  const price = Shared.tradeValue(want);
  const units = [];
  for (const def of ROBOTS) {
    const v = Shared.tradeValue(def.id);
    if (!v || def.id === want) continue;
    for (let i = 0; i < tradeable(def.id); i++) units.push({ id: def.id, v, spare: i < invCount(def.id) - 1 });
  }
  units.sort((a, b) => (b.v - a.v) || (b.spare - a.spare));
  const give = {};
  let left = price;
  for (const u of units) {
    if (left <= 0) break;
    if (u.v > left) continue;
    give[u.id] = (give[u.id] || 0) + 1;
    left -= u.v;
  }
  if (left > 0) {
    // Räcker inte utan att runda uppåt: lägg till den billigaste som täcker resten.
    const used = (id) => give[id] || 0;
    const extra = units.filter((u) => used(u.id) < tradeable(u.id)).sort((a, b) => a.v - b.v).find((u) => u.v >= left)
      || units.filter((u) => used(u.id) < tradeable(u.id)).sort((a, b) => b.v - a.v)[0];
    if (extra) give[extra.id] = used(extra.id) + 1;
  }
  tradeState.give = give;
  byId('trade-error').textContent = tradeTotal() < price ? 'Du har inte robotar värda tillräckligt för den här än.' : '';
  renderTradeGive();
}

async function doTrade() {
  const want = tradeState.want;
  if (!want) return;
  try {
    const r = await net.trade(tradeState.give, want);
    applyAcct(r.acct);
  } catch (e) {
    byId('trade-error').textContent = e.message;
    return;
  }
  tradeState.give = {};
  renderTradeWant();
  renderTradeGive();
  byId('trade-says').textContent = `🤖 Handlaren: "Tack för affären! ${robotById[want].name} är din."`;
  const reveal = byId('trade-reveal');
  reveal.replaceChildren(el('div', 'reward-title', 'BYTE KLART!'), createCard(myDef(robotById[want]), { reveal: true, isNew: invCount(want) === 1, n: invCount(want) }));
  if (want === 'wildcard') maybePromptWildcardName('wildcard');
}

byId('btn-trade').addEventListener('click', () => { game.fromHub = false; showTrade(); });
byId('btn-trade-back').addEventListener('click', () => (game.fromHub ? showHub() : showSelect()));
byId('btn-trade-auto').addEventListener('click', autoFillTrade);
byId('btn-trade-do').addEventListener('click', doTrade);

// ---------- Dagliga uppdrag ----------
function renderQuests() {
  const box = byId('quests');
  box.replaceChildren();
  const q = game.acct.quests;
  if (!q) return;
  box.append(el('p', 'quests-title', '📜 Dagens uppdrag'));
  for (const it of q.list) {
    const row = el('div', `quest${it.done ? ' done' : ''}`);
    row.append(el('span', 'qname', `${it.done ? '✅' : '◻️'} ${it.name}`), el('span', 'qprog', `${it.prog}/${it.goal} · +${it.coins} 🪙`));
    box.append(row);
  }
  box.append(el('p', 'hint', q.bonus ? 'Alla klara idag — du fick bonuslådan! Nya uppdrag i morgon.' : 'Klara alla tre för en bonuslåda. Nya uppdrag varje dag.'));
}

// ---------- Klaner ----------
// Gå med i (eller skapa) en klan. Varje vinst ger klanen poäng till topplistan, och klanens
// medlemmar får 3 extra mynt per vinst. Kräver konto (se api/world/[action].js).
async function showClan(message) {
  if (!game.acct) return;
  game.phase = 'clan';
  showScreen('clan');
  byId('clan-status').textContent = message || '';
  const box = byId('clan-body');
  box.replaceChildren(el('p', 'hint', 'Laddar...'));
  const api = worldApi();
  let data = null;
  try { data = api ? await api.clans() : null; } catch (e) { data = null; }
  if (game.phase !== 'clan') return;
  box.replaceChildren();
  if (!data) { box.append(el('p', 'hint', 'Klaner behöver sidans egen server.')); return; }
  if (data.clan) {
    const c = data.clan;
    box.append(el('p', 'clan-name', `🛡 ${c.name}`), el('p', 'hint', `${c.points} klanpoäng${c.rank ? ` · plats ${c.rank} på topplistan` : ''} · ${c.members.length} medlemmar`));
    const list = el('div', 'clan-members');
    for (const m of c.members) list.append(el('span', 'clan-member', `${m.owner ? '👑 ' : ''}${m.name}`));
    box.append(list, el('p', 'hint', 'Varje vinst ger klanen poäng (kung/drottning 10, boss 3, monster 2, annars 1) och dig 3 extra mynt.'));
    box.append(worldButton('Lämna klanen', async () => {
      try { await net.clanLeave(); } catch (e) { showClan(e.message); return; }
      showClan('Du lämnade klanen.');
    }, { secondary: true }));
  } else if (!data.loggedIn) {
    box.append(el('p', 'hint', 'Logga in för att skapa eller gå med i en klan.'));
  } else {
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 20;
    input.placeholder = 'Klanens namn';
    input.id = 'clan-name-input';
    const buttons = el('div', 'buttons');
    const act = (fn, done) => async () => {
      try { await fn(input.value); } catch (e) { byId('clan-status').textContent = e.message; return; }
      showClan(done);
    };
    buttons.append(worldButton('Skapa klan', act((n) => net.clanCreate(n), 'Klanen är skapad! Berätta namnet för dina kompisar.')),
      worldButton('Gå med', act((n) => net.clanJoin(n), 'Du är med i klanen!'), { secondary: true }));
    box.append(el('p', '', 'Du är inte med i någon klan än.'), input, buttons);
  }
  box.append(el('p', 'quests-title', '🏆 Topplista'));
  if (!data.top.length) box.append(el('p', 'hint', 'Inga klaner än — skapa den första!'));
  data.top.forEach((t, i) => {
    const row = el('div', 'quest');
    row.append(el('span', 'qname', `${i + 1}. ${t.name}`), el('span', 'qprog', `${t.points} p · ${t.members} st`));
    if (!data.clan && data.loggedIn) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => { const inp = byId('clan-name-input'); if (inp) inp.value = t.name; });
    }
    box.append(row);
  });
}

byId('btn-clan').addEventListener('click', () => { game.fromHub = false; showClan(); });
byId('btn-clan-back').addEventListener('click', () => (game.fromHub ? showHub() : showSelect()));
byId('btn-train-still').addEventListener('click', () => startTraining(false));
byId('btn-train-moving').addEventListener('click', () => startTraining(true));

// ---------- Robotstaden: en värld att gå omkring i ----------
// I stället för en meny går man runt med sin robot bland portaler. Gå fram till en och tryck
// mellanslag/J för att gå in. Några AI-robotar vandrar omkring för att det ska kännas levande.
const HUB_RANGE = 80;
const STATIONS = [
  { id: 'monsters', name: 'Monstervärlden', emoji: '👾', color: '#ff7a1a', x: 160, z: -170 },
  { id: 'boss', name: 'Mystiska robotar', emoji: '❓', color: '#ff1744', x: 480, z: -170 },
  { id: 'world', name: 'Världskartan', emoji: '🌍', color: '#3ddc84', x: 800, z: -170 },
  { id: 'arena', name: 'Arenan', emoji: '⚔', color: '#35d0ff', x: 250, z: -10 },
  { id: 'friend', name: 'Vänmatch', emoji: '🤝', color: '#7ee2a8', x: 480, z: -10 },
  { id: 'stake', name: 'Insatsarenan', emoji: '💰', color: '#ffd93d', x: 710, z: -10 },
  { id: 'shop', name: 'Butiken', emoji: '🛒', color: '#9be15d', x: 130, z: 170 },
  { id: 'trade', name: 'Handlaren', emoji: '🔁', color: '#ff9a2a', x: 360, z: 170 },
  { id: 'clan', name: 'Klanhuset', emoji: '🛡', color: '#a07bff', x: 600, z: 170 },
  { id: 'training', name: 'Träningsarenan', emoji: '🎯', color: '#c9a36b', x: 830, z: 170 },
];
const STATION_HINT = {
  arena: 'vanlig match — vinn en låda',
  stake: 'sätt en robot på spel',
  boss: 'möt en mystisk robot',
  monsters: 'res till Monstervärlden',
  world: 'världsdelarna och deras beskyddare',
  friend: 'spela mot en kompis',
  shop: 'köp varor för mynt',
  trade: 'byt robotar med Handlaren',
  clan: 'gå med i en klan',
  training: 'öva på en träningsdocka',
};
const HUB_HINT = 'Gå med WASD eller piltangenterna. Gå fram till en portal och tryck MELLANSLAG/J.';

function showHub() {
  if (!game.acct) return;
  if (friendRoom) leaveFriendRoom();
  game.training = null;
  game.explore = null;
  game.phase = 'hub';
  game.fromHub = true;
  game.arena = arenaById.hub;
  showArenaLabel(game.arena);
  const prev = game.hub;
  const player = new Fighter(applyEquipment(myDef(robotById[game.selectedId])), prev ? prev.player.x : W / 2, 1);
  player.z = prev ? prev.player.z : 90;
  const pool = ROBOTS.filter((r) => !r.monster && !r.boss && r.id !== 'wildcard');
  const walkers = prev ? prev.walkers : [];
  if (!prev) {
    for (let i = 0; i < 5; i++) {
      const f = new Fighter(pool[Math.floor(Math.random() * pool.length)], rand(80, W - 80), 1);
      f.z = rand(-DEPTH, DEPTH);
      walkers.push({ f, dir: 0, depth: 0, t: 0 });
    }
  }
  game.hub = { player, walkers, near: null, attackHeld: true };
  byId('explore-bar').hidden = false;
  byId('explore-hint').textContent = HUB_HINT;
  showScreen(null);
}

function updateHub(dt) {
  const hub = game.hub;
  if (!hub) return;
  const input = playerInput();
  const p = hub.player;
  p.time += dt;
  const walk = input.dir * p.def.speed;
  const walkZ = input.depth * p.def.speed * DEPTH_SPEED;
  p.moving = walk !== 0 || walkZ !== 0;
  if (p.moving) p.walkT += dt;
  if (input.dir) p.facing = input.dir;
  p.x = clamp(p.x + walk * dt, p.w / 2, W - p.w / 2);
  p.z = clamp(p.z + walkZ * dt, -DEPTH, DEPTH);

  // De vandrande robotarna byter riktning då och då.
  for (const w of hub.walkers) {
    const f = w.f;
    f.time += dt;
    w.t -= dt;
    if (w.t <= 0) {
      w.t = rand(1, 3);
      w.dir = Math.random() < 0.3 ? 0 : Math.random() < 0.5 ? -1 : 1;
      w.depth = Math.random() < 0.5 ? 0 : Math.random() < 0.5 ? -1 : 1;
    }
    const sp = f.def.speed * 0.4;
    f.x = clamp(f.x + w.dir * sp * dt, f.w / 2, W - f.w / 2);
    f.z = clamp(f.z + w.depth * sp * DEPTH_SPEED * dt, -DEPTH, DEPTH);
    f.moving = w.dir !== 0 || w.depth !== 0;
    if (f.moving) f.walkT += dt;
    if (w.dir) f.facing = w.dir;
  }

  let near = null;
  let best = HUB_RANGE;
  for (const st of STATIONS) {
    const d = Math.hypot(st.x - p.x, st.z - p.z);
    if (d < best) { best = d; near = st; }
  }
  if (near !== hub.near) {
    byId('explore-hint').textContent = near ? `${near.emoji} ${near.name} — ${STATION_HINT[near.id]}. MELLANSLAG/J: Gå in` : HUB_HINT;
  }
  hub.near = near;
  if (near && input.attack && !hub.attackHeld) enterStation(near.id);
  hub.attackHeld = input.attack;
}

function enterStation(id) {
  const blocked = (msg) => { byId('explore-hint').textContent = msg; };
  if (id === 'stake' && !canStake()) { blocked('💰 Insatsarenan kräver minst 2 robotar.'); return; }
  if (id === 'friend' && !roomCap) { blocked('Vänmatcher går inte att spela här just nu.'); return; }
  byId('explore-bar').hidden = true;
  switch (id) {
    case 'arena': game.mode = 'normal'; startMatch(); break;
    case 'stake': game.mode = 'stake'; startMatch(); break;
    case 'boss': startMatch('boss'); break;
    case 'monsters': showMonsters(); break;
    case 'world': showWorld(); break;
    case 'friend': showFriend(); break;
    case 'shop': showShop(); break;
    case 'trade': showTrade(); break;
    case 'clan': showClan(); break;
    case 'training': startTraining(true); break;
    default:
  }
}

function drawHub() {
  const hub = game.hub;
  if (!hub) return;
  const stations = STATIONS.map((st) => ({ ...st, near: hub.near === st }));
  if (r3d) {
    const fighters = hub.walkers.map((w) => ({ f: w.f, pose: fighterPose(w.f) }));
    fighters.push({ f: hub.player, pose: fighterPose(hub.player), isPlayer: true });
    r3d.render({ arena: game.arena, shake: 0, fighters, focus: [{ f: hub.player }], stations });
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    for (const st of stations) {
      const at = r3d.project(st.x, FLOOR - 120, st.z);
      ctx.font = `bold ${st.near ? 18 : 14}px ui-monospace, Menlo, monospace`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = st.near ? '#ffffff' : st.color;
      ctx.strokeText(`${st.emoji} ${st.name}`, at.x, at.y);
      ctx.fillText(`${st.emoji} ${st.name}`, at.x, at.y);
    }
    return;
  }
  // Utan 3D: en enkel karta ovanifrån.
  ctx.fillStyle = '#0a1630';
  ctx.fillRect(0, 0, W, H);
  const toY = (z) => H / 2 + (z / DEPTH) * (H * 0.4);
  ctx.textAlign = 'center';
  for (const st of stations) {
    ctx.fillStyle = st.color;
    ctx.globalAlpha = st.near ? 1 : 0.6;
    ctx.beginPath(); ctx.arc(st.x, toY(st.z), 30, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = 'bold 14px ui-monospace, Menlo, monospace';
    ctx.fillStyle = '#fff';
    ctx.fillText(`${st.emoji} ${st.name}`, st.x, toY(st.z) - 38);
  }
  ctx.fillStyle = '#35d0ff';
  ctx.beginPath(); ctx.arc(hub.player.x, toY(hub.player.z), 12, 0, Math.PI * 2); ctx.fill();
}

// ---------- Teleport ----------
// Alla sorters matcher (arenan, mystiska robotar, Monstervärlden, Världskartan, vänmatch)
// ligger bakom en egen skärm i stället för allt på robotvalet. showSelect() fyller i
// knapparnas texter och lägen; här byts bara vilken skärm som syns.
function showTeleport() {
  if (!game.acct) return;
  showSelect();
  game.phase = 'teleport';
  byId('teleport-who').textContent = `Vart vill du åka? Du slåss med ${displayName(myDef(robotById[game.selectedId]), true)}.`;
  showScreen('teleport');
}
// Tillbaka dit man kom ifrån: Teleport om man var där, annars robotvalet.
const backToTeleport = () => (game.acct ? showHub() : showSelect());

byId('btn-teleport').addEventListener('click', showHub);
byId('btn-teleport-back').addEventListener('click', () => showSelect());

// ---------- Monstervärlden ----------
// En helt egen VÄRLD, skild från robotarna: man går runt på en egen bana med sin VALDA robot
// (se game.selectedId) bland monster utplacerade i bilden, och utmanar det man går fram till
// (mellanslag/J) — precis som en vanlig match, men vinner man blir priset ett
// utrustningsföremål i stället för en låda/robot, se finishMatch i shared.js. Monster går
// aldrig att äga eller spela som, bara att utmana, om och om igen, precis som bossarna.
const EXPLORE_RANGE = 70; // hur nära man måste gå för att kunna utmana ett monster

function showMonsters() {
  if (!game.acct) return;
  game.phase = 'monsters';
  game.arena = arenaById.direworld;
  showArenaLabel(game.arena);

  const commonMonsters = ROBOTS.filter((r) => r.monster && !r.royal);
  const kings = ROBOTS.filter((r) => r.royal === 'king');
  const queen = ROBOTS.filter((r) => r.royal === 'queen');
  const royalMonsters = [kings[0], ...queen, ...kings.slice(1)].filter(Boolean);
  const margin = 90;
  game.explore = {
    player: new Fighter(applyEquipment(myDef(robotById[game.selectedId])), 60, 1),
    monsters: [
      ...commonMonsters.map((def, i) => {
        const m = new Fighter(def, margin + (i * (W - 2 * margin)) / Math.max(1, commonMonsters.length - 1), -1);
        m.z = [-0.2, 0.35, 0.85][i % 3] * DEPTH; // utspridda i djupled, så man får gå fram till dem
        return m;
      }),
      // Kungarna och drottningen står på rad längst in i världen, drottningen i mitten.
      ...royalMonsters.map((def, i) => {
        const m = new Fighter(def, W * (0.16 + i * 0.227), -1);
        m.z = -DEPTH * 0.92;
        return m;
      }),
    ],
    near: null,
    attackHeld: false,
  };
  byId('explore-bar').hidden = false;
  byId('explore-hint').textContent = 'Gå med WASD eller piltangenterna.';
  showScreen(null);
}

function updateExplore(dt) {
  const ex = game.explore;
  if (!ex) return;
  const input = playerInput();
  const p = ex.player;
  p.time += dt;
  const walk = input.dir * p.def.speed;
  const walkZ = input.depth * p.def.speed * DEPTH_SPEED;
  p.moving = walk !== 0 || walkZ !== 0;
  if (p.moving) p.walkT += dt;
  if (input.dir) p.facing = input.dir;
  p.x = clamp(p.x + walk * dt, p.w / 2, W - p.w / 2);
  p.z = clamp(p.z + walkZ * dt, -DEPTH, DEPTH);

  let near = null;
  for (const m of ex.monsters) {
    m.time += dt;
    m.facing = m.x >= p.x ? -1 : 1;
    if (Math.hypot(m.x - p.x, m.z - p.z) < EXPLORE_RANGE) near = m;
  }
  ex.near = near;

  if (near && input.attack && !ex.attackHeld) startMatch('monster', near.def.id);
  ex.attackHeld = input.attack;

  byId('explore-hint').textContent = near
    ? near.def.royal
      ? `👑 ${near.def.royal === 'queen' ? 'DROTTNING' : 'KUNG'} — du och 4 robotar mot ${near.def.name}! MELLANSLAG/J: Utmana (ger: ${dropName(near.def)} + en supervapendel)`
      : `MELLANSLAG/J: Utmana ${near.def.name} (ger: ${dropName(near.def)})`
    : 'Gå med WASD eller piltangenterna.';
}

// Man ska veta exakt vad ett monster ger INNAN man utmanar det — ingen slump i VILKET
// föremål, se finishMatch() i shared.js. Namnet på den bestämda biten, för hint-texter.
function dropName(monsterDef) {
  const item = Shared.EQUIPMENT.find((e) => e.id === monsterDef.drop);
  return item ? item.name : '?';
}

function drawExplore() {
  const ex = game.explore;
  if (!ex) return;
  if (r3d) {
    const fighters = ex.monsters.map((m) => ({ f: m, pose: fighterPose(m) }));
    fighters.push({ f: ex.player, pose: fighterPose(ex.player), isPlayer: true });
    r3d.render({ arena: game.arena, shake: 0, fighters });
    ctx.clearRect(0, 0, W, H);
    ctx.textAlign = 'center';
    for (const m of ex.monsters) {
      if (!m.def.royal && ex.near !== m) continue;
      const at = r3d.project(m.x, m.y - m.h - 14, m.z);
      ctx.font = `bold ${m.def.royal ? 15 : 16}px ui-monospace, Menlo, monospace`;
      ctx.fillStyle = m.def.royal ? (ex.near === m ? '#fff3b0' : '#ffd93d') : '#ffd93d';
      ctx.fillText(m.def.royal ? `👑 ${m.def.name}` : m.def.name, at.x, at.y);
    }
    return;
  }
  const arenaId = game.arena.id;
  if (!backgroundCache[arenaId]) backgroundCache[arenaId] = buildBackground(game.arena);
  ctx.drawImage(backgroundCache[arenaId], 0, 0);
  for (const m of ex.monsters) {
    drawFighter(m, false, false);
    if (ex.near === m) {
      ctx.font = 'bold 16px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd93d';
      ctx.fillText(m.def.name, m.x, m.y - m.h - 14);
    }
  }
  drawFighter(ex.player, true, false);
}

// ---- Utrustning (öppningsbar både från Monstervärlden och väljarskärmen, samma ruta) ----
function renderEquipmentModal() {
  const current = byId('equipment-current');
  if (game.acct.equippedItem) {
    const item = Shared.EQUIPMENT.find((e) => e.id === game.acct.equippedItem);
    current.textContent = item ? `Du bär: ${item.name} — ${item.desc}${item.power ? ` Superkraft (Q): ${item.power.name}.` : ''}` : '';
  } else {
    current.textContent = 'Du bär ingen utrustning just nu.';
  }
  byId('btn-unequip').hidden = !game.acct.equippedItem;

  // Supervapnen sätts ihop automatiskt av delar man ibland hittar efter en monstervinst —
  // visa alla, även de man inte har än, med hur nära man är och vilken superkraft de ger.
  const superBox = byId('equipment-mega-progress');
  superBox.replaceChildren();
  const head = document.createElement('p');
  head.className = 'boss-title';
  head.textContent = 'SUPERVAPEN';
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent = 'Varje supervapen har en egen superkraft (Q eller I, en gång per match). Delar hittar du ibland när du besegrar ett monster.';
  superBox.append(head, info);
  for (const w of Shared.SUPER_WEAPONS) {
    const owned = (game.acct.equipmentInv[w.id] || 0) > 0;
    const have = (game.acct.superPieces || {})[w.id] || 0;
    const row = document.createElement('div');
    row.className = `super-row${owned ? ' owned' : ''}`;
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = owned ? `⚡ ${w.name}` : `${w.name} — ${have}/${w.pieces} delar`;
    const desc = document.createElement('div');
    desc.className = 'stats';
    desc.textContent = `${w.power.name}: ${w.power.desc}`;
    row.append(name, desc);
    superBox.append(row);
  }

  const list = byId('equipment-list');
  list.replaceChildren();
  const ownedIds = Object.keys(game.acct.equipmentInv).filter((id) => game.acct.equipmentInv[id] > 0);
  if (!ownedIds.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Du har ingen utrustning än — vinn en monsterstrid för att få ditt första föremål.';
    list.appendChild(p);
  }
  for (const id of ownedIds) {
    const item = Shared.EQUIPMENT.find((e) => e.id === id);
    if (!item) continue;
    const n = game.acct.equipmentInv[id];
    const equipped = game.acct.equippedItem === id;
    const card = document.createElement('div');
    card.className = `card compact${equipped ? ' selected' : ''}`;
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = `${item.name} ×${n}`;
    const desc = document.createElement('div');
    desc.className = 'stats';
    desc.textContent = item.power ? `${item.desc} Superkraft: ${item.power.name}.` : item.desc;
    card.append(name, desc);
    if (!equipped) {
      card.classList.add('pickable');
      card.addEventListener('click', () => reequip(id));
    }
    list.appendChild(card);
  }
}

// Byter utrustning och, om man råkar stå mitt i Monstervärlden just då, uppdaterar den egna
// robotens fart/liv där på en gång (annars skulle man behöva lämna och gå in igen).
async function reequip(id) {
  try {
    const r = await net.equipItem(id);
    applyAcct(r.acct);
  } catch (e) {
    // Inget att göra — kontot hann ändras. Rita bara om med det som faktiskt gäller nu.
  }
  renderEquipmentModal();
  if (game.explore) game.explore.player.def = applyEquipment(myDef(robotById[game.selectedId]));
}

byId('btn-explore-equipment').addEventListener('click', () => {
  renderEquipmentModal();
  byId('equipment-prompt').hidden = false;
});
byId('btn-equipment-close').addEventListener('click', () => { byId('equipment-prompt').hidden = true; });
byId('btn-unequip').addEventListener('click', () => reequip(null));
byId('btn-explore-back').addEventListener('click', () => {
  byId('explore-bar').hidden = true;
  const wasHub = game.phase === 'hub';
  game.explore = null;
  game.training = null;
  if (wasHub) showSelect(); else showHub();
});

async function importGuestCollection() {
  const guest = Backend.readGuestSave();
  if (!guest) return;
  byId('import-info').textContent = 'Importerar...';
  try {
    const r = await net.importGuest(guest.inv, guest.boxes);
    applyAcct(r.acct);
    Backend.clearGuestSave();
    showSelect();
    byId('import-info').textContent = 'Gästsamlingen har lagts till på kontot!';
  } catch (e) {
    byId('import-info').textContent = `Kunde inte importera: ${e.message}`;
  }
}

byId('btn-import-guest').addEventListener('click', importGuestCollection);

function rewardItem(caption, def, opts) {
  const wrap = document.createElement('div');
  wrap.className = 'reward-item';
  const head = document.createElement('div');
  head.className = 'reward-title';
  head.textContent = caption;
  wrap.append(head, createCard(def, opts));
  byId('reward').appendChild(wrap);
}

// Utrustning är inte en robot (ingen canvas/sprite att rita), så den får ett enklare kort —
// samma .card-utseende, bara utan bilden.
function rewardEquipment(caption, item) {
  const wrap = document.createElement('div');
  wrap.className = 'reward-item';
  const head = document.createElement('div');
  head.className = 'reward-title';
  head.textContent = caption;
  const card = document.createElement('div');
  card.className = 'card rare';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = item.name;
  const desc = document.createElement('div');
  desc.className = 'stats';
  desc.textContent = item.desc;
  card.append(name, desc);
  wrap.append(head, card);
  byId('reward').appendChild(wrap);
}

function showResult() {
  const r = game.result;
  const friend = !!r.friend;
  byId('result-title').textContent = r.won ? 'DU VANN!' : 'DU FÖRLORADE';
  byId('reward').replaceChildren();

  let text;
  if (r.ranked && !r.error) {
    // En riktig match räknas som en vanlig match: låda och erfarenhet vid vinst.
    text = `${r.won ? `Du besegrade ${r.oppName} — en riktig spelare!` : `${r.oppName} vann — en riktig spelare.`} ${r.won ? 'Du fick en låda!' : 'Vinn en match för att få en låda.'}`;
  } else if (r.challenge) {
    const name = continentName(r.challenge.continent);
    const leader = r.challenge.role === 'leader';
    if (leader && r.won) { byId('result-title').textContent = 'DU FÖRSVARADE!'; text = `Du försvarade ${name} mot ${r.oppName}!`; }
    else if (leader) text = `${r.oppName} tog ${name} från dig. Utmana dem tillbaka!`;
    else if (r.won) { byId('result-title').textContent = 'NY BESKYDDARE!'; text = `Du besegrade ${r.oppName} och är nu beskyddare av ${name}!`; }
    else text = `${r.oppName} försvarade ${name}. Träna och försök igen!`;
  } else if (friend) {
    text = r.won ? `Du besegrade ${r.oppName}!` : `${r.oppName} vann den här gången.`;
  } else if (r.error) {
    text = `Kunde inte spara resultatet: ${r.error}`;
  } else if (game.boss) {
    if (r.bossWon) {
      byId('result-title').textContent = 'BOSSEN BESEGRAD!';
      text = 'Den mystiska roboten är din — och du fick en låda!';
      rewardItem('AVSLÖJAD!', robotById[r.bossWon], { isNew: true, n: invCount(r.bossWon) });
    } else {
      text = 'Den mystiska roboten var för stark den här gången. Den väntar kvar — försök igen.';
    }
  } else if (game.monster) {
    if (r.itemWon) {
      const item = Shared.EQUIPMENT.find((e) => e.id === r.itemWon);
      const opp = robotById[game.matchToken && game.matchToken.opp];
      text = opp && opp.royal
        ? `Du besegrade ${opp.name}! Ett kungligt föremål är ditt!`
        : 'Du besegrade monstret och fick ett utrustningsföremål!';
      if (item) rewardEquipment('DU FICK ETT FÖREMÅL!', item);
      const w = r.superPiece && Shared.EQUIPMENT.find((e) => e.id === r.superPiece);
      if (w && r.superAssembled) {
        text += ` Och du hittade sista delen av ${w.name} — det är ihopsatt! Bär det och tryck Q för ${w.power.name}.`;
        rewardEquipment(`${w.name.toUpperCase()} ÄR IHOPSATT!`, w);
      } else if (w) {
        text += ` Du hittade dessutom en del av supervapnet ${w.name} (${r.superPieces}/${w.pieces}).`;
      }
    } else {
      const opp = robotById[game.matchToken && game.matchToken.opp];
      text = opp && opp.royal
        ? `${opp.name} var för stark. ${opp.royal === 'queen' ? 'Drottningen' : 'Kungen'} väntar kvar — bli starkare och försök igen.`
        : 'Monstret var för starkt den här gången. Det väntar kvar i Monstervärlden — försök igen.';
    }
  } else if (r.won) {
    text = r.gained ? 'Du vann motståndarens robot och fick en låda!' : 'Du fick en låda!';
    if (r.gained) rewardItem('DU VANN ROBOTEN!', robotById[r.gained], { isNew: true, n: invCount(r.gained) });
  } else if (r.lost) {
    text = 'Du tappade din insats.';
    rewardItem('FÖRLORAD ROBOT', robotById[r.lost], { n: invCount(r.lost) });
  } else {
    text = 'Vinn en match för att få en låda.';
  }
  if (r.coins) text += ` +${r.coins} 🪙 mynt.`;
  if (r.clanPoints) text += ` Klanen fick ${r.clanPoints} poäng.`;
  for (const q of r.quests || []) text += ` 📜 Uppdrag klart: ${q.name}! +${q.coins} mynt.`;
  if (r.questBonus) text += ' Alla dagens uppdrag klara — du fick en bonuslåda!';
  for (const up of r.levelUps || []) {
    rewardItem(`NIVÅ ${up.level}!`, robotById[up.prize], { isNew: true, n: invCount(up.prize) });
  }
  const gainedIds = [r.bossWon, r.gained, ...(r.levelUps || []).map((u) => u.prize)].filter(Boolean);
  if (gainedIds.includes('wildcard')) maybePromptWildcardName('wildcard');
  byId('result-text').textContent = text;
  byId('btn-again').hidden = friend;
  byId('btn-open-result').hidden = friend || game.acct.boxes === 0;
  byId('btn-open-result').textContent = `Öppna låda (${game.acct.boxes})`;
  byId('btn-change').hidden = friend;
  byId('btn-rematch').hidden = !friend || !!r.challenge;
  byId('btn-leave-friend').hidden = !friend;
  byId('btn-leave-friend').textContent = r.challenge ? 'Till världskartan' : 'Lämna';
  showScreen('result');
}

// ---------- Lådor ----------
function renderBox(revealed) {
  const art = byId('box-art');
  const reveal = byId('box-reveal');
  const open = byId('btn-open');
  art.hidden = !!revealed;
  art.classList.remove('shake');
  reveal.replaceChildren();
  if (revealed) {
    const head = document.createElement('div');
    head.className = 'reward-title';
    head.textContent = revealed.def.id === 'wildcard' ? 'JOKERN!'
      : revealed.def.rarity === 'divine' ? 'GUDOMLIG ROBOT!'
      : revealed.def.rarity === 'legendary' ? 'LEGENDARISK ROBOT!'
      : revealed.n === 1 ? 'NY ROBOT!' : `EXTRA KOPIA! Du har nu ${revealed.n} st.`;
    reveal.append(head, createCard(myDef(revealed.def), { isNew: revealed.n === 1, reveal: true, n: revealed.n }));
  }
  open.hidden = game.acct.boxes === 0;
  open.textContent = revealed ? `Öppna nästa (${game.acct.boxes} kvar)` : `Öppna låda (${game.acct.boxes} kvar)`;
  byId('box-text').textContent = game.acct.boxes === 0 && !revealed
    ? 'Du har inga lådor. Vinn matcher för att få fler.'
    : '';
}

function showBox() {
  game.phase = 'box';
  game.opening = false;
  renderBox(null);
  showScreen('box');
}

async function openBox() {
  if (game.acct.boxes <= 0 || game.opening) return;
  game.opening = true;
  let result;
  try {
    result = await net.openBox();
  } catch (e) {
    game.opening = false;
    return;
  }
  applyAcct(result.acct);

  byId('box-reveal').replaceChildren();
  byId('box-art').hidden = false;
  byId('box-art').classList.add('shake');
  byId('btn-open').hidden = true;
  setTimeout(() => {
    game.opening = false;
    renderBox({ def: robotById[result.prize.id], n: result.prize.n });
    maybePromptWildcardName(result.prize.id);
  }, 900);
}

// isRename: true när man själv öppnar rutan igen för att byta namn (och därmed attack, se
// Shared.wildcardSpecialFor) på en joker man redan äger — false för förstagångs-prompten.
function openWildcardPrompt(isRename) {
  byId('wildcard-prompt-title').textContent = isRename ? 'DÖP OM JOKERROBOTEN' : 'DU FICK JOKERROBOTEN!';
  byId('wildcard-name-input').value = isRename ? (game.acct.wildcardName || '') : '';
  byId('wildcard-name-error').textContent = '';
  byId('wildcard-prompt').hidden = false;
}

// Visas första gången man får jokerroboten — den kräver ett eget namn innan den räknas som
// riktigt "upptäckt" i samlingen (annars heter den "???" tills man döper den själv).
function maybePromptWildcardName(acquiredId) {
  // Dubbelkollar faktiskt ägande (inte bara "inget namn satt än") — annars kan prompten visas
  // utan att man egentligen har en joker att döpa, vilket bara skulle ge ett förvirrande fel.
  if (acquiredId !== 'wildcard' || game.acct.wildcardName || invCount('wildcard') < 1) return;
  openWildcardPrompt(false);
}

async function saveWildcardName() {
  const err = byId('wildcard-name-error');
  err.textContent = '';
  try {
    const r = await net.nameWildcard(byId('wildcard-name-input').value);
    applyAcct(r.acct);
    byId('wildcard-prompt').hidden = true;
    if (game.phase === 'select') showSelect();
  } catch (e) {
    if (invCount('wildcard') < 1) {
      // Inget att döpa (t.ex. om kontot hunnit ändras under tiden) — stäng i stället för att
      // fastna i en ruta som aldrig kan lyckas.
      byId('wildcard-prompt').hidden = true;
    } else {
      err.textContent = e.message;
    }
  }
}

byId('btn-save-wildcard-name').addEventListener('click', saveWildcardName);
byId('wildcard-name-input').addEventListener('keydown', (e) => { if (e.code === 'Enter') saveWildcardName(); });
byId('btn-rename-wildcard').addEventListener('click', () => openWildcardPrompt(true));

// Beskriv-jokerns-attack: man skriver fritt hur man vill att den ska fungera, och Claude (via
// artefaktens sample-funktion) tolkar det till en av de riktiga mekanikerna i spelet plus ett
// eget namn och en egen beskrivning — se Shared.customWildcardSpecial för hur svaret
// valideras/begränsas innan det någonsin kan påverka striden.
let wildcardAttackBusy = false;

const HEAD_LABELS = { box: 'Fyrkantigt', round: 'Runt', dome: 'Kupol', cyclops: 'Cyklop', hood: 'Huva', horn: 'Horn', crown: 'Krona' };
const EXTRA_LABELS = {
  none: 'Inget', antenna: 'Antenn', shoulders: 'Axelskydd', fins: 'Fenor', cannon: 'Kanon',
  shield: 'Sköld', jet: 'Jetpack', cape: 'Cape', spikes: 'Taggar', question: 'Frågetecken (originalet)',
};

// Fylls bara en gång — själva alternativen ändras aldrig, bara vilket som är valt.
function populateWildcardAppearanceSelects() {
  const headSel = byId('wildcard-attack-head');
  const extraSel = byId('wildcard-attack-extra');
  const addOpt = (sel, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  };
  addOpt(headSel, '', 'Standard');
  for (const h of Shared.HEAD_SHAPES) addOpt(headSel, h, HEAD_LABELS[h] || h);
  addOpt(extraSel, '', 'Standard');
  for (const e of Shared.EXTRA_FEATURES) addOpt(extraSel, e, EXTRA_LABELS[e] || e);

  // Direktvalet (ingen AI inblandad) — bara jokerns ursprungliga tio attacker, inte alla ~34
  // mekaniker fritextläget kan välja bland, se chooseWildcardSpecial() i shared.js. Fungerar
  // överallt, även där Claude inte går att fråga (den riktiga webbsidan utan en API-nyckel).
  // Bara namnet i listan (inte hela beskrivningen) — en lång text i en <select> kan annars
  // tvinga undan knappen bredvid tills den blir osynlig, se renderWildcardPickDesc() för
  // beskrivningen i stället.
  const pickSel = byId('wildcard-attack-pick');
  addOpt(pickSel, 'auto', 'Styrs av namnet (som vanligt)');
  for (const s of Shared.WILDCARD_SPECIALS) addOpt(pickSel, s.type, s.name);
}
populateWildcardAppearanceSelects();

function renderWildcardPickDesc() {
  const v = byId('wildcard-attack-pick').value;
  const desc = byId('wildcard-attack-pick-desc');
  const special = Shared.WILDCARD_SPECIALS.find((s) => s.type === v);
  desc.textContent = special ? special.desc : 'Jokerns attack väljs som vanligt utifrån namnet den döptes till.';
}
byId('wildcard-attack-pick').addEventListener('change', renderWildcardPickDesc);

function renderWildcardAttackPanel() {
  const current = byId('wildcard-attack-current');
  const custom = game.acct.wildcardCustomSpecial;
  const typeLabel = (special) => (special.types || ['normal']).map((t) => Shared.TYPES[t].label).join('/');
  if (custom) {
    current.textContent = `Nuvarande (egen): ${custom.name} (${typeLabel(custom)}) — ${custom.desc}`;
  } else {
    const auto = Shared.wildcardSpecialFor(game.acct.wildcardName, game.acct.wildcardSpecialType);
    current.textContent = `Nuvarande (styrs av namnet): ${auto.name} (${typeLabel(auto)}) — ${auto.desc}`;
  }
  byId('btn-reset-wildcard-attack').hidden = !custom;
  byId('wildcard-attack-error').textContent = '';
  byId('wildcard-attack-color').value = game.acct.wildcardColor || robotById.wildcard.color;
  byId('wildcard-attack-dmg').value = custom && typeof custom.dmg === 'number' ? custom.dmg : '';
  byId('wildcard-attack-head').value = game.acct.wildcardHead || '';
  byId('wildcard-attack-extra').value = game.acct.wildcardExtra || '';
  // En egen AI-beskriven attack (custom) vinner alltid över ett direktval i hur den faktiskt
  // spelas (se wildcardSpecialFor) — så visa "auto" i direktvalet tills man uttryckligen
  // väljer något där, i stället för att visa ett värde som inte längre stämmer.
  byId('wildcard-attack-pick').value = (!custom && game.acct.wildcardSpecialType) ? game.acct.wildcardSpecialType : 'auto';
  renderWildcardPickDesc();
}

function wildcardAttackErrorText(code) {
  switch (code) {
    case 'not_granted': return 'Du har inte tillåtit att den här sidan frågar Claude.';
    case 'rate_limited': return 'För många förfrågningar just nu — försök igen om en liten stund.';
    case 'refused': return 'Claude avböjde den beskrivningen — försök skriva något annat.';
    case 'session_expired': return 'Din inloggning har gått ut — ladda om sidan.';
    case 'sampling_disabled': case 'not_declared': case 'capability_disabled': case 'capability_removed':
      return 'Den här funktionen är inte tillgänglig just nu.';
    default: return 'Något gick fel — försök igen.';
  }
}

async function generateWildcardAttack() {
  const err = byId('wildcard-attack-error');
  const text = byId('wildcard-attack-text').value.trim();
  err.textContent = '';
  if (!text) { err.textContent = 'Skriv först hur du vill att attacken ska fungera.'; return; }
  if (wildcardAttackBusy) return;
  wildcardAttackBusy = true;
  const btn = byId('btn-generate-wildcard-attack');
  btn.disabled = true;
  btn.textContent = 'Tänker...';
  try {
    if (!window.claude || typeof window.claude.use !== 'function') throw { code: 'not_declared' };
    const sample = await window.claude.use('sample');
    if (!sample) throw { code: 'not_declared' };
    const typeLines = Object.entries(Shared.TYPE_DEFAULTS).map(([t, s]) => `- ${t}: ${s.desc}`).join('\n');
    const elementNames = Object.keys(Shared.TYPES).join(', ');
    const prompt = `Du designar en specialattack för en robot i ett enkelt tvåspelar-fightingspel, utifrån hur en spelare beskriver den.\n\n`
      + `Spelarens beskrivning: "${text}"\n\n`
      + `Välj EN av dessa färdiga mekaniker som passar beskrivningen bäst (ange typens exakta namn i "type"):\n${typeLines}\n\n`
      + `Välj också 1-2 element som matchar attackens TEMA (ange i "types", en lista) bland exakt dessa namn: ${elementNames}.\n\n`
      + `Svara ENDAST med ett JSON-objekt på exakt denna form, inget annat:\n`
      + `{"type": "<en av mekanikerna ovan, exakt stavad>", "types": ["<ett eller två av elementen ovan, exakt stavade>"], "name": "<ett kort svenskt attacknamn, max 24 tecken>", "desc": "<en kort svensk beskrivning av attacken, max 140 tecken>", "dmg": <ett heltal 5-45, utelämna fältet helt om mekaniken inte gör direkt skada>, "heal": <ett heltal 5-30, utelämna fältet helt om mekaniken inte läker>}`;
    const data = await sample.json(prompt, { modelTier: 'quick' });
    if (!data || typeof data !== 'object' || !Shared.TYPE_DEFAULTS[data.type]) {
      err.textContent = 'Kunde inte tolka ett giltigt attackslag ur det svaret — försök beskriva på ett annat sätt.';
      return;
    }
    // Ditt eget siffervärde (om du fyllt i ett) vinner alltid över det Claude föreslog —
    // customWildcardSpecial klipper det ändå till ett säkert spann (5–45). Elementen
    // (data.types) rensas/valideras där också — ett ogiltigt förslag faller bara tillbaka på
    // Normal i stället för att krascha.
    const dmgField = byId('wildcard-attack-dmg').value.trim();
    const dmg = dmgField ? Number(dmgField) : data.dmg;
    const r = await net.setCustomWildcardAttack(data.type, data.name, data.desc, dmg, data.heal, data.types);
    applyAcct(r.acct);
    renderWildcardAttackPanel();
    if (game.phase === 'select') showSelect();
  } catch (e) {
    if (invCount('wildcard') < 1) { byId('wildcard-attack-prompt').hidden = true; return; }
    err.textContent = wildcardAttackErrorText(e && e.code);
  } finally {
    wildcardAttackBusy = false;
    btn.disabled = false;
    btn.textContent = 'Skapa attack';
  }
}

async function resetWildcardAttack() {
  try {
    const r = await net.setCustomWildcardAttack(null);
    applyAcct(r.acct);
    renderWildcardAttackPanel();
    if (game.phase === 'select') showSelect();
  } catch (e) {
    if (invCount('wildcard') < 1) byId('wildcard-attack-prompt').hidden = true;
  }
}

byId('btn-choose-wildcard-attack').addEventListener('click', () => {
  renderWildcardAttackPanel();
  byId('wildcard-attack-prompt').hidden = false;
});
byId('btn-wildcard-attack-close').addEventListener('click', () => { byId('wildcard-attack-prompt').hidden = true; });
byId('btn-generate-wildcard-attack').addEventListener('click', generateWildcardAttack);
byId('btn-reset-wildcard-attack').addEventListener('click', resetWildcardAttack);

// Direktvalet fungerar överallt (ingen AI inblandad) — ett bra alternativ där fritextläget
// inte går att använda (t.ex. den riktiga webbsidan utan en egen API-nyckel), men går lika
// bra att använda på Claude-sidan också.
byId('btn-pick-wildcard-type').addEventListener('click', async () => {
  const v = byId('wildcard-attack-pick').value;
  const err = byId('wildcard-attack-error');
  const btn = byId('btn-pick-wildcard-type');
  err.textContent = '';
  btn.disabled = true;
  const originalLabel = btn.textContent;
  btn.textContent = 'Sparar...';
  try {
    // Ett direktval ska alltid vinna över en tidigare AI-beskriven attack — annars skulle den
    // fortsätta synas/gälla (wildcardSpecialFor kollar den egna, AI-beskrivna attacken FÖRST).
    if (game.acct.wildcardCustomSpecial) {
      const r0 = await net.setCustomWildcardAttack(null);
      applyAcct(r0.acct);
    }
    const r = await net.chooseWildcardSpecial(v === 'auto' ? null : v);
    applyAcct(r.acct);
    renderWildcardAttackPanel();
    if (game.phase === 'select') showSelect();
    // Bekräftelsen ("Nuvarande: ...") står högst upp i rutan — man har precis scrollat ner
    // för att nå den här knappen, så utan att scrolla tillbaka ser det ut som att inget
    // hände alls. Rulla upp OCH visa en tydlig bekräftelse på själva knappen en kort stund.
    byId('wildcard-attack-prompt').scrollTo({ top: 0, behavior: 'smooth' });
    btn.textContent = '✓ Vald!';
    setTimeout(() => { btn.textContent = originalLabel; }, 1500);
  } catch (e) {
    if (invCount('wildcard') < 1) { byId('wildcard-attack-prompt').hidden = true; return; }
    err.textContent = (e && e.message) || 'Något gick fel — försök igen.';
    btn.textContent = originalLabel;
  } finally {
    btn.disabled = false;
  }
});

// Färgen sparas direkt när man väljer en ny, oberoende av "Skapa attack" — inget att tolka,
// så det finns ingen anledning att vänta.
byId('wildcard-attack-color').addEventListener('change', async () => {
  try {
    const r = await net.setWildcardColor(byId('wildcard-attack-color').value);
    applyAcct(r.acct);
    if (game.phase === 'select') showSelect();
  } catch (e) {
    if (invCount('wildcard') < 1) byId('wildcard-attack-prompt').hidden = true;
  }
});
byId('btn-reset-wildcard-color').addEventListener('click', async () => {
  try {
    const r = await net.setWildcardColor(null);
    applyAcct(r.acct);
    renderWildcardAttackPanel();
    if (game.phase === 'select') showSelect();
  } catch (e) {
    if (invCount('wildcard') < 1) byId('wildcard-attack-prompt').hidden = true;
  }
});

// Huvudform och extradetalj sparas precis som färgen: direkt när man väljer, oavsett
// "Skapa attack" — rent kosmetiskt, inget att tolka.
byId('wildcard-attack-head').addEventListener('change', async () => {
  const v = byId('wildcard-attack-head').value;
  try {
    const r = await net.setWildcardHead(v || null);
    applyAcct(r.acct);
    if (game.phase === 'select') showSelect();
  } catch (e) {
    if (invCount('wildcard') < 1) byId('wildcard-attack-prompt').hidden = true;
  }
});
byId('wildcard-attack-extra').addEventListener('change', async () => {
  const v = byId('wildcard-attack-extra').value;
  try {
    const r = await net.setWildcardExtra(v || null);
    applyAcct(r.acct);
    if (game.phase === 'select') showSelect();
  } catch (e) {
    if (invCount('wildcard') < 1) byId('wildcard-attack-prompt').hidden = true;
  }
});

// ---------- Konto (inloggning) ----------
function showAuth() {
  byId('auth-error').textContent = '';
  byId('auth-username').value = '';
  byId('auth-password').value = '';
  game.phase = 'auth';
  showScreen('auth');
}

async function submitAuth(kind) {
  const username = byId('auth-username').value.trim();
  const password = byId('auth-password').value;
  const err = byId('auth-error');
  err.textContent = '';
  const remote = new Backend.RemoteBackend();
  try {
    const r = kind === 'login' ? await remote.login(username, password) : await remote.register(username, password);
    net = remote;
    applyAcct(r.acct);
    showSelect();
  } catch (e) {
    err.textContent = e.message;
  }
}

async function logout() {
  if (net.kind === 'remote') await net.logout().catch(() => {});
  leaveFriendRoom();
  net = new Backend.LocalBackend();
  const r = await net.load();
  applyAcct(r.acct);
  showSelect();
}

byId('btn-account').addEventListener('click', () => {
  if (net.kind === 'remote') logout();
  else showAuth();
});
byId('btn-login').addEventListener('click', () => submitAuth('login'));
byId('btn-register').addEventListener('click', () => submitAuth('register'));
byId('btn-auth-back').addEventListener('click', showSelect);
byId('auth-password').addEventListener('keydown', (e) => { if (e.code === 'Enter') submitAuth('login'); });

// ---------- Vänmatch (realtid via Claude-sidans "room"-förmåga) ----------
// Det finns ingen egen server i den här byggen — "rummet" är artefaktens egen
// realtidskanal (claude.use('room')) mellan alla som har sidan öppen just nu.
// Den som skapar rummet blir alltid "värd" och kör den riktiga fysiksimuleringen
// för BÅDA robotarna (sin egen + den mottagna indatan från gästen); gästen kör
// ingen egen fysik alls, bara det senaste tillstånd värden skickat — annars finns
// ingen gemensam sanning att hålla de två sidorna i otakt mot. Det gör lösningen
// okänslig för att meddelanden tappas bort (inget kräver att alla tickar kommer
// fram, bara att det SENASTE tillståndet gör det, och "rummet" lovar själv inget
// om leverans eller ordning).
let roomCap = null;        // claude.use('room') — null om vänmatcher inte går att spela i den här vyn
// Sant när roomCap kommer från den här sidans egna /api/room/*-frågning (Backend.connectPollRoom)
// i stället för en riktig websocket/claude.use('room') — den skickar långsammare för att inte
// svämma över med anrop, se updateFriendMatch().
let roomIsPolling = false;
let friendRoom = null;      // det gemensamma "rummet" (NamedRoom) just nu, eller null
let friendUnsubs = [];       // avregistreringsfunktioner för rummets lyssnare, körs vid "Lämna"

function friendMessage(text) { byId('friend-status').textContent = text; }

function randomRoomCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Robotens FAKTISKA utseende/attack/utrustning, precis som i en match mot AI — så
// att en jokerägares egen attack/färg/utrustning syns korrekt för motståndaren också,
// utan att behöva räknas ut på nytt av någon server.
function myFriendDef() { return applyEquipment(myDef(robotById[game.selectedId])); }
function myFriendName() { return net.username || 'Gäst'; }

function stopFriendListening() {
  for (const un of friendUnsubs) { try { un(); } catch (e) { /* redan avregistrerad */ } }
  friendUnsubs = [];
}

function leaveFriendRoom() {
  dropChallenge();
  dropRanked();
  stopFriendListening();
  if (friendRoom) { friendRoom.leave().catch(() => {}); friendRoom = null; }
  game.online = null;
}

function backToFriendLobby(message) {
  leaveFriendRoom();
  byId('friend-code').hidden = true;
  byId('friend-join').hidden = false;
  byId('friend-create').hidden = false;
  if (message) friendMessage(message);
  if (game.phase !== 'menu') { game.phase = 'friend'; showScreen('friend'); }
}

function friendPeerLeftMidMatch() {
  if (game.online && game.online.ranked && !game.online.ended) {
    // Motståndaren gav upp mitt i en riktig match: du vinner.
    game.online.ended = true;
    game.phase = 'over';
    game.winner = game.player;
    game.overT = 1.2;
    finishRanked(true);
    return;
  }
  if (ranked && !game.online) { // motståndaren försvann innan matchen hann börja
    leaveFriendRoom();
    startMatch(undefined, undefined, true);
    return;
  }
  if (challenge) {
    const ch = challenge;
    leaveFriendRoom();
    showWorld(ch.role === 'challenger'
      ? `${ch.oppName} lämnade matchen. ${continentName(ch.continent)} har kvar sin beskyddare.`
      : `${ch.oppName} lämnade matchen. Du är fortfarande beskyddare av ${continentName(ch.continent)}.`);
    return;
  }
  backToFriendLobby('Din vän lämnade matchen.');
}

function showFriend() {
  if (!roomCap) { showSelect(); return; }
  leaveFriendRoom();
  game.phase = 'friend';
  byId('friend-code').hidden = true;
  byId('friend-join').hidden = false;
  byId('friend-create').hidden = false;
  byId('friend-code-input').value = '';
  friendMessage('');
  showScreen('friend');
}

// Bevakar om motståndaren (värden eller gästen, beroende på vem som frågar) dyker
// upp eller försvinner, via rummets delade "vem är här"-lista — inte via ett eget
// "hej"-meddelande, som annars skulle kunna hinna missas av den som ansluter sist.
function watchForOpponent(room, opponentRole, onFound, onLost) {
  return room.onPeers(() => {
    const opp = room.peers().find((p) => !p.isMe && p.presence && p.presence.role === opponentRole && p.presence.def);
    if (!game.online) { if (opp) onFound(opp); }
    else if (!game.online.ended && !opp) onLost();
  });
}

function normalizeFriendInput(data) {
  if (!data || typeof data !== 'object') return { ...IDLE };
  return {
    dir: data.dir === 1 ? 1 : data.dir === -1 ? -1 : 0,
    depth: data.depth === 1 ? 1 : data.depth === -1 ? -1 : 0,
    jump: !!data.jump,
    attack: !!data.attack,
    special: !!data.special,
    super: !!data.super,
  };
}

// opts.challenge: en utmaning om en världsdel — rumskoden är då utmaningens id, och ingen kod visas.
async function createFriendRoom(opts = {}) {
  if (!roomCap) { friendMessage('Vänmatcher går inte att spela i den här vyn.'); return; }
  leaveFriendRoom();
  challenge = opts.challenge || null;
  ranked = opts.ranked || null;
  friendMessage('Skapar rum...');
  const code = opts.challenge ? opts.challenge.id : opts.ranked ? opts.ranked.room : randomRoomCode();
  let room;
  try {
    room = await roomCap.join(code);
  } catch (e) {
    friendMessage('Kunde inte skapa rummet. Försök igen.');
    return;
  }
  friendRoom = room;
  byId('friend-join').hidden = true;
  byId('friend-create').hidden = true;
  byId('friend-code').hidden = !!(challenge || ranked);
  byId('friend-code-text').textContent = code.toUpperCase();
  friendMessage(challenge
    ? `Väntar på att ${challenge.oppName} svarar på din utmaning om ${continentName(challenge.continent)}...`
    : 'Väntar på att din vän går med...');
  // Lyssnarna måste finnas INNAN presence() sätts — annars kan gästen (eller värden,
  // vid en snabb anslutning) i teorin hinna svara innan den egna sidan ens lyssnar.
  friendUnsubs.push(watchForOpponent(room, 'guest', (guestPeer) => hostStartMatch(room, guestPeer), friendPeerLeftMidMatch));
  friendUnsubs.push(room.on('rematch', (msg) => {
    if (msg.isMe || !game.online || game.phase !== 'over') return;
    hostRestartMatch(room);
  }));
  friendUnsubs.push(room.on('input', (msg) => {
    if (msg.isMe || !game.online || !game.online.isHost) return;
    game.online.lastGuestInput = normalizeFriendInput(msg.data);
  }));
  await room.presence({ role: 'host', name: myFriendName(), def: myFriendDef() });
}

async function joinFriendRoom(opts = {}) {
  if (!roomCap) { friendMessage('Vänmatcher går inte att spela i den här vyn.'); return; }
  const code = opts.challenge ? opts.challenge.id : opts.ranked ? opts.ranked.room : byId('friend-code-input').value.trim().toLowerCase();
  if (!opts.challenge && !opts.ranked && !/^[a-z0-9]{4}$/.test(code)) { friendMessage('Ange den fyrtecken-koden du fick av din vän.'); return; }
  leaveFriendRoom();
  challenge = opts.challenge || null;
  ranked = opts.ranked || null;
  friendMessage('Ansluter...');
  let room;
  try {
    room = await roomCap.join(code);
  } catch (e) {
    friendMessage('Kunde inte ansluta. Kontrollera koden och försök igen.');
    return;
  }
  friendRoom = room;
  friendMessage('Väntar på värden...');
  // Samma sak här: registrera lyssnarna FÖRE presence(), så värden aldrig kan hinna
  // svara (t.ex. ett startmeddelande) innan den här sidan faktiskt lyssnar efter det.
  friendUnsubs.push(room.on('start', (msg) => { if (!msg.isMe) guestStartMatch(room, msg.data); }));
  friendUnsubs.push(room.on('state', (msg) => {
    if (msg.isMe || !game.online || game.online.isHost) return;
    applyFriendState(msg.data);
  }));
  friendUnsubs.push(room.on('end', (msg) => {
    if (msg.isMe || !game.online || game.online.isHost) return;
    guestEndMatch(msg.data);
  }));
  friendUnsubs.push(watchForOpponent(room, 'host', () => {}, friendPeerLeftMidMatch));
  await room.presence({ role: 'guest', name: myFriendName(), def: myFriendDef() });
}

function beginFriendMatch(isHost, payload) {
  game.friendLast = payload; // återanvänds av värden vid revansch
  game.arena = arenaById[payload.arenaId] || arenaById.classic;
  showArenaLabel(game.arena);
  const hostF = new Fighter(payload.host.def, W * 0.25, 1);
  const guestF = new Fighter(payload.guest.def, W * 0.75, -1);
  game.fighters = [hostF, guestF];
  game.player = isHost ? hostF : guestF;
  game.ai = isHost ? guestF : hostF;
  game.online = { isHost, oppName: challenge ? challenge.oppName : isHost ? payload.guest.name : payload.host.name, ended: false, frame: 0, lastGuestInput: { ...IDLE }, challenge, ranked, rankedToken: null };
  // En riktig match ger låda och erfarenhet precis som mot AI — via samma matchbiljett.
  if (ranked) {
    net.startMatch(game.selectedId, 'normal')
      .then((r) => { if (game.online && game.online.ranked === ranked) game.online.rankedToken = r.match; })
      .catch(() => {});
  }
  game.projectiles = [];
  game.waves = [];
  game.beams = [];
  game.strikes = [];
  game.mines = [];
  game.clouds = [];
  game.halos = [];
  game.quakes = [];
  game.holes = [];
  game.wolves = [];
  game.roots = [];
  game.tethers = [];
  game.megabeams = [];
  game.bolts = [];
  game.superBanner = null;
  game.clocks = [];
  game.meteors = [];
  game.tides = [];
  game.particles = [];
  game.winner = null;
  game.result = null;
  game.mode = 'friend';
  game.allies = [];
  game.training = null;
  game.stake = false;
  game.boss = false;
  game.monster = false;
  specialBuffer = 0;
  game.introT = 2.4;
  game.banner = 0;
  game.phase = 'intro';
  hud.namePlayer.textContent = `DU · ${displayName(game.player.def, true)}`;
  hud.nameAi.textContent = `${game.ai.def.name} · ${game.online.oppName}`;
  setHudType(hud.typePlayer, game.player.def);
  setHudType(hud.typeAi, game.ai.def);
  showScreen(null);
}

function hostStartMatch(room, guestPeer) {
  const arena = Shared.pickArena(Math.random);
  const payload = {
    arenaId: arena.id,
    host: { name: myFriendName(), def: myFriendDef() },
    guest: { name: guestPeer.presence.name || 'Vän', def: guestPeer.presence.def },
  };
  room.emit('start', payload).catch(() => {});
  beginFriendMatch(true, payload);
}

function hostRestartMatch(room) {
  if (!game.friendLast) return;
  const arena = Shared.pickArena(Math.random);
  const payload = { ...game.friendLast, arenaId: arena.id };
  room.emit('start', payload).catch(() => {});
  beginFriendMatch(true, payload);
}

function guestStartMatch(room, payload) {
  if (!payload) return;
  beginFriendMatch(false, payload);
}

function hostEndMatch(winnerIsHost) {
  game.phase = 'over';
  game.winner = winnerIsHost ? game.player : game.ai;
  game.overT = 1.6;
  game.result = { won: winnerIsHost, friend: true, oppName: game.online.oppName };
  finishChallenge(winnerIsHost);
  finishRanked(winnerIsHost);
}

function guestEndMatch(data) {
  if (!game.online) return;
  game.online.ended = true;
  game.phase = 'over';
  const iWon = !(data && data.winnerIsHost);
  game.winner = iWon ? game.player : game.ai;
  game.overT = 1.6;
  game.result = { won: iWon, friend: true, oppName: game.online.oppName };
  finishChallenge(iWon);
  finishRanked(iWon);
}

function sanitizeNum(v, fallback) { return typeof v === 'number' && Number.isFinite(v) ? v : fallback; }

// Hela fighterns synliga tillstånd — "skicka absolut tillstånd", inte deltan, precis
// som rummets egen rekommendation: tappas ett meddelande bort spelar det ingen roll,
// nästa som kommer fram beskriver ändå hela sanningen på nytt.
function fighterSnapshot(f) {
  return {
    x: f.x, y: f.y, z: f.z, facing: f.facing, vy: f.vy, kx: f.kx, onGround: f.onGround,
    hp: f.hp, energy: f.energy, act: f.act, atkCd: f.atkCd, hurt: f.hurt, invuln: f.invuln,
    flash: f.flash, dashT: f.dashT, buffT: f.buffT, shieldT: f.shieldT, reflectT: f.reflectT,
    frozenT: f.frozenT, jinxT: f.jinxT, rootT: f.rootT, vulnT: f.vulnT, dead: f.dead, moving: f.moving,
    time: f.time, walkT: f.walkT, enrage: f.enrage,
    dragonT: f.dragonT, mirrorT: f.mirrorT, floatT: f.floatT, reviveT: f.reviveT, superReady: f.superReady,
  };
}

// Gästens sida litar aldrig blint på nätverksdata — allt som inte är ett giltigt tal
// faller tillbaka till det gästen redan visade, i stället för att t.ex. rita en
// NaN-position eller krascha.
function applyFighterSnapshot(f, snap) {
  if (!snap || typeof snap !== 'object') return;
  const prevHp = f.hp;
  f.x = sanitizeNum(snap.x, f.x);
  f.y = sanitizeNum(snap.y, f.y);
  f.z = clamp(sanitizeNum(snap.z, f.z), -DEPTH, DEPTH);
  f.facing = snap.facing === -1 ? -1 : 1;
  f.vy = sanitizeNum(snap.vy, f.vy);
  f.kx = sanitizeNum(snap.kx, f.kx);
  f.onGround = !!snap.onGround;
  f.hp = clamp(sanitizeNum(snap.hp, f.hp), 0, f.maxHp);
  f.energy = clamp(sanitizeNum(snap.energy, f.energy), 0, MAX_ENERGY);
  f.act = snap.act && typeof snap.act === 'object' ? snap.act : null;
  f.atkCd = sanitizeNum(snap.atkCd, f.atkCd);
  f.hurt = sanitizeNum(snap.hurt, f.hurt);
  f.invuln = sanitizeNum(snap.invuln, f.invuln);
  f.flash = sanitizeNum(snap.flash, f.flash);
  f.dashT = sanitizeNum(snap.dashT, f.dashT);
  f.buffT = sanitizeNum(snap.buffT, f.buffT);
  f.shieldT = sanitizeNum(snap.shieldT, f.shieldT);
  f.reflectT = sanitizeNum(snap.reflectT, f.reflectT);
  f.frozenT = sanitizeNum(snap.frozenT, f.frozenT);
  f.jinxT = sanitizeNum(snap.jinxT, f.jinxT);
  f.rootT = sanitizeNum(snap.rootT, f.rootT);
  f.vulnT = sanitizeNum(snap.vulnT, f.vulnT);
  f.dead = !!snap.dead;
  f.moving = !!snap.moving;
  f.time = sanitizeNum(snap.time, f.time);
  f.walkT = sanitizeNum(snap.walkT, f.walkT);
  f.enrage = sanitizeNum(snap.enrage, f.enrage);
  f.dragonT = sanitizeNum(snap.dragonT, f.dragonT);
  f.mirrorT = sanitizeNum(snap.mirrorT, f.mirrorT);
  f.floatT = sanitizeNum(snap.floatT, f.floatT);
  f.reviveT = sanitizeNum(snap.reviveT, f.reviveT);
  f.superReady = !!snap.superReady;
  if (f.hp < prevHp) { // enda sättet gästen vet att något träffade — inga egna fysikanrop att haka på
    sparks(f.x, f.y - f.h * 0.6, f.def.color, prevHp - f.hp >= 15 ? 18 : 10, f.z);
    game.shake = Math.max(game.shake, prevHp - f.hp >= 15 ? 0.25 : 0.1);
  }
}

function applyFriendState(data) {
  if (!data || !game.fighters) return;
  const [f0, f1] = game.fighters;
  applyFighterSnapshot(f0, data.f0);
  applyFighterSnapshot(f1, data.f1);
}

function sendFriendInput() {
  if (!friendRoom) return;
  friendRoom.emit('input', playerInput()).catch(() => {});
}

function sendFriendState() {
  if (!friendRoom) return;
  const [f0, f1] = game.fighters;
  friendRoom.emit('state', { f0: fighterSnapshot(f0), f1: fighterSnapshot(f1) }).catch(() => {});
}

// Ett steg i en pågående vänmatch. Bara värden kör den riktiga fysiken (för BÅDA
// robotarna) och sänder tillstånd ut regelbundet; gästen skickar bara sin egen indata
// (i samma takt) och ritar vad värden senast sa — ingen egen simulering alls, så de
// två sidorna kan aldrig råka hamna i otakt med varandra. Takten är lägre över den här
// sidans egen fråga-om-nytt-kanal (roomIsPolling) än över en riktig websocket/room-förmåga,
// annars svämmar den över med anrop.
function updateFriendMatch(dt) {
  const om = game.online;
  if (game.phase === 'intro') {
    game.introT -= dt;
    if (game.introT <= 0) { game.phase = 'fight'; game.banner = 0.7; }
  }
  game.banner = Math.max(0, game.banner - dt);
  const fighting = game.phase === 'fight';
  om.frame++;
  const everyN = roomIsPolling ? 8 : 3; // ~7,5 Hz pollat, ~20 Hz över en riktig realtidskanal
  const throttled = om.frame % everyN === 0;

  if (om.isHost) {
    const [f0, f1] = game.fighters;
    f0.step(dt, fighting ? playerInput() : IDLE, f1, fighting);
    f1.step(dt, fighting ? om.lastGuestInput : IDLE, f0, fighting);
    if (fighting) {
      separate(f0, f1);
      updateProjectiles(dt);
      updateWaves(dt);
      updateBeams(dt);
      updateStrikes(dt);
      updateMines(dt);
      updateClouds(dt);
      updateHalos(dt);
      updateQuakes(dt);
      updateHoles(dt);
      updateWolves(dt);
      updateRoots(dt);
      updateTethers(dt);
      updateClocks(dt);
      updateMeteors(dt);
      updateTides(dt);
      updateSupers(dt);
      if (!om.ended && (f0.hp <= 0 || f1.hp <= 0)) {
        om.ended = true;
        const winnerIsHost = f0.hp > 0;
        if (friendRoom) friendRoom.emit('end', { winnerIsHost }).catch(() => {});
        hostEndMatch(winnerIsHost);
      }
    }
    if (throttled) sendFriendState();
  } else if (throttled) {
    sendFriendInput();
  }
}


// ---------- Riktiga motståndare ----------
// När tillräckligt många spelar (pvpInfo.pvp, se api/world/[action].js) ställer "Kämpa!" en i
// kö i stället för att starta en AI-match. Två i kö paras ihop i ett vänmatchsrum; kommer
// ingen i tid blir det en vanlig AI-match ändå.
const CLIENT_ID = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
let pvpInfo = null; // { online, pvp, pvpMin } från senaste pingen
let ranked = null;  // { room } medan man väntar på eller spelar en riktig match

function renderOnlineInfo() {
  const info = byId('online-info');
  if (!pvpInfo) { info.textContent = ''; return; }
  info.classList.toggle('pvp', pvpInfo.pvp);
  info.textContent = pvpInfo.pvp
    ? `🟢 ${pvpInfo.online} spelare är inne — du möter riktiga spelare i stället för AI!`
    : `🟢 ${pvpInfo.online} ${pvpInfo.online === 1 ? 'spelare' : 'spelare'} inne just nu. När ${pvpInfo.pvpMin} är inne möter du riktiga spelare i stället för AI.`;
}

// Matchen tar slut: hämta låda/erfarenhet med matchbiljetten, som i en AI-match.
function finishRanked(iWon) {
  const om = game.online;
  if (!om || !om.ranked) return;
  const oppName = om.oppName;
  game.result = null; // resultatskärmen väntar tills servern svarat
  const done = (extra) => { game.result = { won: iWon, ranked: true, oppName, ...extra }; };
  if (!om.rankedToken) { done({ error: 'Matchen hann inte registreras.' }); return; }
  net.finishMatch(om.rankedToken, iWon)
    .then((r) => { applyAcct(r.acct); done(r.result); })
    .catch((e) => done({ error: e.message }));
}

function dropRanked() {
  if (ranked && !game.online) {
    const api = worldApi();
    if (api) api.mmUnqueue(CLIENT_ID).catch(() => {});
  }
  ranked = null;
}

async function startRealMatch() {
  if (friendRoom) leaveFriendRoom();
  byId('explore-bar').hidden = true;
  game.explore = null;
  const api = worldApi();
  let q = null;
  try { q = api ? await api.mmQueue(CLIENT_ID) : null; } catch (e) { q = null; }
  if (!q || !q.room) { startMatch(undefined, undefined, true); return; }
  game.phase = 'friend';
  showScreen('friend');
  byId('friend-join').hidden = true;
  byId('friend-create').hidden = true;
  byId('friend-code').hidden = true;
  const mine = { room: q.room };
  if (q.role === 'host') {
    await createFriendRoom({ ranked: mine });
    friendMessage('Letar efter en riktig motståndare...');
  } else {
    await joinFriendRoom({ ranked: mine });
    friendMessage('Hittade en riktig motståndare! Matchen börjar...');
  }
  // Ingen kom (eller den man hittade försvann) — då blir det en vanlig AI-match i stället.
  setTimeout(() => {
    if (ranked === mine && !game.online) {
      leaveFriendRoom();
      startMatch(undefined, undefined, true);
    }
  }, (q.role === 'host' ? q.seconds || 25 : 12) * 1000);
}

// ---------- Världskartan ----------
// Varje världsdel kan ha en beskyddare: en riktig spelare (se api/world/[action].js). Titeln
// byter bara ägare i en live-match mellan två spelare, aldrig mot AI: utmanaren skapar ett
// vänmatchrum med utmaningens id som rumskod, och beskyddaren går med när den antar.
let worldState = null;    // senaste svaret från /api/world/state
let worldSelected = null; // världsdelen man klickat på
let challenge = null;     // { id, continent, role: 'challenger' | 'leader', oppName } medan en utmaning väntar eller spelas
let incomingShown = null; // utmaningen som rutan "du blir utmanad" visar just nu
let incomingTimer = null;

// Kartan går att titta på som gäst, men bara med konto kan man bli beskyddare eller utmana.
const worldApi = () => (net.kind === 'remote' ? net : accountsAvailable ? new Backend.RemoteBackend() : null);
const continentName = (id) => (Shared.continentById[id] || { name: id }).name;
const worldLevel = () => (worldState ? worldState.level : game.acct.level);
const robotName = (id) => (robotById[id] ? robotById[id].name : 'okänd robot');

async function refreshWorld() {
  const api = worldApi();
  if (!api) return null;
  try {
    worldState = await api.world();
  } catch (e) {
    return null;
  }
  return worldState;
}

async function showWorld(message) {
  if (!game.acct) return;
  if (friendRoom) leaveFriendRoom();
  byId('explore-bar').hidden = true;
  game.explore = null;
  game.phase = 'world';
  byId('world-status').textContent = message || (worldApi() ? '' : 'Världskartan behöver sidans egen server.');
  showScreen('world');
  renderWorld();
  await refreshWorld();
  if (game.phase === 'world') renderWorld();
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderWorld() {
  const map = byId('world-map');
  map.replaceChildren();
  const level = worldLevel();
  for (const c of Shared.CONTINENTS) {
    const info = worldState ? worldState.continents.find((x) => x.id === c.id) : null;
    const b = el('button', 'continent');
    b.type = 'button';
    b.style.left = `${c.x}%`;
    b.style.top = `${c.y}%`;
    if (level < c.level) {
      // Okänd världsdel: inget namn, ingen beskyddare — bara vilken nivå som behövs.
      b.classList.add('locked');
      b.append(el('span', 'emoji', '🔒'), el('span', 'cname', '???'), el('span', 'leader', `Nivå ${c.level}`));
    } else {
      b.append(el('span', 'emoji', c.emoji), el('span', 'cname', c.name));
      const leader = el('span', 'leader');
      if (!info) leader.textContent = '...';
      else if (!info.leader) leader.textContent = 'Ingen beskyddare';
      else {
        leader.append(el('span', info.online ? 'online-dot' : 'offline-dot'), `👑 ${info.leader.name}`);
        if (info.leader.me) b.classList.add('mine');
      }
      b.append(leader);
    }
    if (c.id === worldSelected) b.classList.add('active');
    b.addEventListener('click', () => { worldSelected = c.id; renderWorld(); });
    map.append(b);
  }
  renderWorldDetail();
}

function worldButton(text, onClick, opts = {}) {
  const b = el('button', opts.secondary ? 'secondary' : '', text);
  b.type = 'button';
  b.disabled = !!opts.disabled;
  b.addEventListener('click', onClick);
  return b;
}

function renderWorldDetail() {
  const box = byId('world-detail');
  box.replaceChildren();
  const c = Shared.continentById[worldSelected];
  if (!c) {
    box.append(el('p', 'hint', 'Klicka på en världsdel.'));
    return;
  }
  if (worldLevel() < c.level) {
    box.append(el('h3', '', '🔒 ???'), el('p', 'hint', `Du vet ingenting om den här världsdelen än. Nå nivå ${c.level} för att upptäcka den.`));
    return;
  }
  box.append(el('h3', '', `${c.emoji} ${c.name}`));
  const info = worldState ? worldState.continents.find((x) => x.id === c.id) : null;
  if (!info) { box.append(el('p', 'hint', 'Laddar...')); return; }
  const loggedIn = net.kind === 'remote';
  const buttons = el('div', 'buttons');
  // Man kan bara beskydda en världsdel: tar man den här lämnar man sin gamla.
  const mine = worldState.continents.find((x) => x.leader && x.leader.me && x.id !== c.id);
  const leaveNote = () => {
    if (mine) box.append(el('p', 'hint', `Du kan bara ha en världsdel. Tar du ${c.name} lämnar du ${continentName(mine.id)}.`));
  };
  if (!info.leader) {
    box.append(el('p', '', `Ingen beskyddar ${c.name} än!`));
    if (loggedIn) { buttons.append(worldButton('Bli beskyddare', () => claimContinent(c.id))); leaveNote(); }
    else box.append(el('p', 'hint', 'Logga in för att kunna bli beskyddare.'));
  } else if (info.leader.me) {
    box.append(el('p', 'crown', `👑 Du beskyddar ${c.name}!`));
    box.append(el('p', 'hint', `På kartan syns du med ${robotName(info.leader.robot)}. Håll spelet öppet — när någon utmanar dig får du en fråga, och du slåss med roboten du har vald.`));
    if (info.leader.robot !== game.selectedId) {
      buttons.append(worldButton(`Visa ${robotName(game.selectedId)} på kartan`, () => claimContinent(c.id), { secondary: true }));
    }
  } else {
    const who = el('p');
    who.append(el('span', info.online ? 'online-dot' : 'offline-dot'), `Beskyddare: 👑 ${info.leader.name} med ${robotName(info.leader.robot)}`);
    box.append(who);
    if (!loggedIn) {
      box.append(el('p', 'hint', 'Logga in för att utmana.'));
    } else if (info.abandoned) {
      box.append(el('p', 'hint', `${info.leader.name} har inte varit här på flera dagar.`));
      buttons.append(worldButton('Ta över världsdelen', () => claimContinent(c.id)));
      leaveNote();
    } else {
      buttons.append(worldButton(`Utmana ${info.leader.name}`, () => startChallenge(c.id), { disabled: !info.online || !roomCap }));
      box.append(el('p', 'hint', info.online
        ? `Du slåss live mot ${info.leader.name} med din valda robot, ${robotName(game.selectedId)}. Vinner du blir du beskyddare!`
        : `${info.leader.name} är inte online just nu. Bara spelare kan ta titeln, aldrig AI — så du får vänta tills de är här.`));
      leaveNote();
    }
  }
  if (buttons.childElementCount) box.append(buttons);
}

async function claimContinent(id) {
  try {
    await net.worldClaim(id);
  } catch (e) {
    byId('world-status').textContent = e.message;
    await refreshWorld();
    renderWorld();
    return;
  }
  await showWorld(`👑 Du är beskyddare av ${continentName(id)}!`);
}

async function startChallenge(id) {
  let r;
  try {
    r = await net.worldChallenge(id);
  } catch (e) {
    byId('world-status').textContent = e.message;
    return;
  }
  game.phase = 'friend';
  showScreen('friend');
  byId('friend-join').hidden = true;
  byId('friend-create').hidden = true;
  byId('friend-code').hidden = true;
  await createFriendRoom({ challenge: { id: r.challenge.id, continent: id, role: 'challenger', oppName: r.challenge.toName } });
}

// En utmaning man lämnar innan matchen börjat ska inte bli hängande hos beskyddaren.
function dropChallenge() {
  if (challenge && challenge.role === 'challenger' && !(game.online && game.online.challenge)) {
    net.worldCancel(challenge.id).catch(() => {});
  }
  challenge = null;
}

// Matchen är slut. Bara beskyddarens sida rapporterar — servern lämnar bara över titeln när
// beskyddaren själv rapporterat att den förlorat.
function finishChallenge(iWon) {
  const ch = game.online && game.online.challenge;
  if (!ch) return;
  game.result.challenge = ch;
  if (ch.role === 'leader') net.worldResult(ch.id, iWon).catch(() => {});
  challenge = null;
  worldSelected = ch.continent;
}

function showIncoming(inc) {
  incomingShown = inc;
  byId('challenge-text').textContent = `${inc.fromName} vill ta ${continentName(inc.continent)} från dig och slåss med ${robotName(inc.robot)}! Du slåss med ${robotName(game.selectedId)}.`;
  byId('challenge-prompt').hidden = false;
  let left = 40;
  byId('challenge-timer').textContent = `${left} sekunder att svara`;
  clearInterval(incomingTimer);
  incomingTimer = setInterval(() => {
    left -= 1;
    byId('challenge-timer').textContent = `${Math.max(0, left)} sekunder att svara`;
    if (left <= 0) hideIncoming();
  }, 1000);
}

function hideIncoming() {
  clearInterval(incomingTimer);
  incomingShown = null;
  byId('challenge-prompt').hidden = true;
}

async function answerChallenge(accept) {
  const inc = incomingShown;
  hideIncoming();
  if (!inc) return;
  try {
    await net.worldAnswer(inc.id, accept);
  } catch (e) {
    if (accept) showWorld(e.message);
    return;
  }
  if (!accept) return;
  byId('explore-bar').hidden = true;
  game.explore = null;
  game.phase = 'friend';
  showScreen('friend');
  byId('friend-join').hidden = true;
  byId('friend-create').hidden = true;
  byId('friend-code').hidden = true;
  await joinFriendRoom({ challenge: { id: inc.id, continent: inc.continent, role: 'leader', oppName: inc.fromName } });
  friendMessage(`Du antog utmaningen från ${inc.fromName}! Matchen börjar...`);
  const id = inc.id;
  setTimeout(() => {
    if (challenge && challenge.id === id && !game.online) {
      leaveFriendRoom();
      showWorld(`${inc.fromName} dök aldrig upp. Du är fortfarande beskyddare.`);
    }
  }, 20000);
}

// Frågar servern med jämna mellanrum: håller en själv "online" på kartan, visar utmaningar
// man får som beskyddare, och svaret på en utmaning man själv skickat.
let worldPolling = false;
async function pollWorld() {
  const api = worldApi();
  if (worldPolling || !api || document.hidden) return;
  const fighting = game.phase === 'intro' || game.phase === 'fight';
  worldPolling = true;
  let st = null;
  try {
    st = await api.worldPing(CLIENT_ID, !!(challenge && challenge.role === 'challenger'));
  } catch (e) {
    st = null;
  }
  if (st && game.phase === 'world') {
    await refreshWorld();
    if (game.phase === 'world') renderWorld();
  }
  worldPolling = false;
  if (!st) return;
  pvpInfo = st;
  renderOnlineInfo();

  const inc = st.incoming;
  if (inc && !fighting && !game.online && !challenge && !ranked && (!incomingShown || incomingShown.id !== inc.id)) showIncoming(inc);
  if (!inc && incomingShown) hideIncoming();

  const out = st.outgoing;
  if (challenge && challenge.role === 'challenger' && !game.online && out && out.id === challenge.id) {
    const who = challenge.oppName;
    if (out.status === 'accepted') friendMessage(`${who} antog utmaningen! Matchen börjar...`);
    else if (out.status === 'declined' || out.status === 'expired' || out.status === 'cancelled') {
      challenge = null; // redan avgjord — inget att ångra hos servern
      leaveFriendRoom();
      showWorld(out.status === 'declined' ? `${who} nekade din utmaning.` : `${who} svarade inte. Försök igen senare!`);
    }
  }
}
setInterval(pollWorld, 5000);

byId('btn-create-room').addEventListener('click', () => createFriendRoom());
byId('btn-join-room').addEventListener('click', () => joinFriendRoom());
byId('friend-code-input').addEventListener('keydown', (e) => { if (e.code === 'Enter') joinFriendRoom(); });
byId('btn-friend-cancel').addEventListener('click', () => { leaveFriendRoom(); backToTeleport(); });
byId('btn-rematch').addEventListener('click', () => {
  if (!friendRoom || !game.online) return;
  if (game.online.isHost) hostRestartMatch(friendRoom);
  else {
    byId('result-text').textContent = 'Väntar på att din vän också vill ha revansch...';
    friendRoom.emit('rematch', {}).catch(() => {});
  }
});
byId('btn-leave-friend').addEventListener('click', () => {
  const fromChallenge = game.result && game.result.challenge;
  leaveFriendRoom();
  if (fromChallenge) showWorld(); else backToTeleport();
});

byId('btn-play').addEventListener('click', showSelect);
byId('btn-fight').addEventListener('click', () => startMatch());
byId('btn-again').addEventListener('click', () => startMatch());
byId('btn-change').addEventListener('click', showSelect);
byId('btn-boxes').addEventListener('click', showBox);
byId('btn-daily').addEventListener('click', claimDaily);
byId('btn-open-result').addEventListener('click', showBox);
byId('btn-open').addEventListener('click', openBox);
byId('btn-box-back').addEventListener('click', showSelect);
byId('btn-friend').addEventListener('click', showFriend);
byId('btn-monsters').addEventListener('click', showMonsters);
byId('btn-world').addEventListener('click', () => showWorld());
byId('btn-world-back').addEventListener('click', backToTeleport);
byId('btn-challenge-accept').addEventListener('click', () => answerChallenge(true));
byId('btn-challenge-decline').addEventListener('click', () => answerChallenge(false));
byId('btn-equipment').addEventListener('click', () => {
  renderEquipmentModal();
  byId('equipment-prompt').hidden = false;
});
byId('mode-normal').addEventListener('click', () => { game.mode = 'normal'; showTeleport(); });
byId('mode-stake').addEventListener('click', () => { game.mode = 'stake'; showTeleport(); });

// ---------- Uppdatering ----------
const IDLE = { dir: 0, depth: 0, jump: false, attack: false, special: false, super: false };

function update(dt) {
  game.shake = Math.max(0, game.shake - dt);
  specialBuffer = Math.max(0, specialBuffer - dt);
  superBuffer = Math.max(0, superBuffer - dt);
  if (game.superBanner) { game.superBanner.t -= dt; if (game.superBanner.t <= 0) game.superBanner = null; }
  for (const p of game.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.z += (p.vz || 0) * dt;
    p.vy += 700 * dt;
    p.life -= dt;
  }
  game.particles = game.particles.filter((p) => p.life > 0);

  if (game.phase === 'monsters') { updateExplore(dt); return; }
  if (game.phase === 'hub') { updateHub(dt); return; }

  const { player, ai } = game;
  if (!player || game.phase === 'menu' || game.phase === 'select' || game.phase === 'auth'
    || game.phase === 'friend' || game.phase === 'box' || game.phase === 'world' || game.phase === 'trade' || game.phase === 'shop' || game.phase === 'teleport' || game.phase === 'clan') return;

  if (game.online) {
    updateFriendMatch(dt);
  } else {
    if (game.phase === 'intro') {
      game.introT -= dt;
      if (game.introT <= 0) {
        game.phase = 'fight';
        game.banner = 0.7;
      }
    }
    game.banner = Math.max(0, game.banner - dt);

    const fighting = game.phase === 'fight';
    if (fighting) updateBossEnrage(dt);
    const allies = game.allies;
    if (allies.length && fighting) chooseBossTarget(dt);
    const bossTarget = (allies.length && ai.target) || player;
    player.step(dt, fighting ? playerInput() : IDLE, ai, fighting);
    const aiIn = !fighting ? IDLE : game.training ? trainingInput(dt) : aiInput(ai, bossTarget, game.brain, dt);
    ai.step(dt, aiIn, bossTarget, fighting);
    for (const a of allies) a.f.step(dt, fighting ? aiInput(a.f, ai, a.brain, dt) : IDLE, ai, fighting);
    separate(player, ai);
    if (allies.length) {
      const team = [player, ...allies.map((x) => x.f)];
      for (const f of team) separate(f, ai);
      for (let i = 0; i < team.length; i++) for (let j = i + 1; j < team.length; j++) separate(team[i], team[j]);
    }
    if (player.act && player.act.kind === 'special') specialBuffer = 0;

    updateProjectiles(dt);
    updateWaves(dt);
    updateBeams(dt);
    updateStrikes(dt);
    updateMines(dt);
    updateClouds(dt);
    updateHalos(dt);
    updateQuakes(dt);
    updateHoles(dt);
    updateWolves(dt);
    updateRoots(dt);
    updateTethers(dt);
    updateClocks(dt);
    updateMeteors(dt);
    updateTides(dt);
    updateSupers(dt);

    const lost = allies.length ? player.hp <= 0 && allies.every((a) => a.f.hp <= 0) : player.hp <= 0;
    if (game.training) updateTraining(dt);
    else if (fighting && (lost || ai.hp <= 0)) endMatch();
  }

  if (game.phase === 'over') {
    game.overT -= dt;
    if (game.overT <= 0 && game.result && screens.result.hidden) showResult();
  }
}

// ---------- Rendering ----------
// Små HP-mätare över dina robotkamrater i en kungastrid. project: spelkoordinat -> skärm.
function drawAllyBars(project) {
  for (const a of game.allies) {
    const f = a.f;
    const at = project(f.x, f.y - f.h - 16, f.z);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(at.x - 26, at.y - 4, 52, 7);
    ctx.fillStyle = f.dead ? '#555' : '#3ddc84';
    ctx.fillRect(at.x - 25, at.y - 3, 50 * Math.max(0, f.hp / f.maxHp), 5);
    ctx.font = 'bold 11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#cfe8d8';
    ctx.fillText(`🤖 ${f.def.name}`, at.x, at.y - 8);
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawArm(c, x, y, angle, len, color) {
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.fillStyle = color;
  c.fillRect(-5, 0, 10, len);
  c.beginPath();
  c.arc(0, len, 7, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

// Ritar en robot med fötterna i (p.x, p.y). Används både i striden och på korten.
function drawRobot(c, def, p) {
  const sil = p.silhouette;
  const body = sil ? '#232c4a' : p.flash > 0 ? '#ffffff' : def.color;
  const dark = sil ? '#1a2240' : p.flash > 0 ? '#e6e6e6' : def.accent;
  const eye = sil ? '#232c4a' : def.eye;
  const t = p.time || 0;
  const air = !!p.air;

  c.save();
  c.globalAlpha = p.alpha === undefined ? 1 : p.alpha;
  c.translate(p.x, p.y);
  c.scale(p.facing * def.scale, def.scale);
  if (p.dead) c.rotate(-1.35);
  else if (p.hurt) c.rotate(-0.16);

  const swing = air ? 0.5 : p.moving ? Math.sin((p.walkT || 0) * 12) * 0.6 : 0;
  const bob = p.moving || air ? 0 : Math.sin(t * 3) * 1.5;

  for (const side of [-1, 1]) {
    c.save();
    c.translate(side * 10, -40);
    c.rotate(swing * side);
    c.fillStyle = dark;
    c.fillRect(-6, 0, 12, 34);
    c.fillStyle = body;
    c.fillRect(-8, 30, 18, 10);
    c.restore();
  }
  c.translate(0, bob);

  // Armar: framarmen används vid attack.
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
  if (def.extra === 'cannon') {
    c.save();
    c.translate(-18, -98);
    c.rotate(-0.5);
    c.fillStyle = dark;
    c.fillRect(-7, -30, 14, 34);
    c.fillStyle = eye;
    c.fillRect(-4, -33, 8, 4);
    c.restore();
  } else if (def.extra === 'jet') {
    c.fillStyle = dark;
    c.fillRect(-34, -96, 14, 38);
    c.fillStyle = eye;
    c.beginPath();
    c.moveTo(-32, -58);
    c.lineTo(-22, -58);
    c.lineTo(-27, -44 + Math.sin(t * 30) * 4);
    c.closePath();
    c.fill();
  } else if (def.extra === 'spikes') {
    c.fillStyle = dark;
    for (let k = 0; k < 3; k++) {
      const y = -94 + k * 16;
      c.beginPath();
      c.moveTo(-20, y);
      c.lineTo(-38, y + 8);
      c.lineTo(-20, y + 16);
      c.closePath();
      c.fill();
    }
  } else if (def.extra === 'question') {
    c.save();
    c.fillStyle = eye;
    c.font = 'bold 34px ui-monospace, Menlo, monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.shadowColor = eye;
    c.shadowBlur = 8;
    c.fillText('?', 0, -70 + Math.sin(t * 2) * 2);
    c.restore();
  } else if (def.extra === 'cape') {
    c.fillStyle = dark;
    c.beginPath();
    c.moveTo(-14, -96);
    c.lineTo(-46, -30 + Math.sin(t * 6) * 3);
    c.lineTo(-8, -44);
    c.closePath();
    c.fill();
  }
  drawArm(c, -4, -88, back, 38, dark);

  c.fillStyle = body;
  roundRect(c, -22, -96, 44, 58, 8);
  c.fill();
  c.fillStyle = dark;
  c.fillRect(-14, -88, 28, 22);
  c.fillStyle = eye;
  c.beginPath();
  c.arc(0, -77, p.ready ? 7 : 5, 0, Math.PI * 2);
  c.fill();

  if (def.extra === 'shoulders') {
    c.fillStyle = dark;
    roundRect(c, -30, -102, 20, 20, 5);
    c.fill();
    roundRect(c, 10, -102, 20, 20, 5);
    c.fill();
  }

  c.fillStyle = body;
  if (def.head === 'box') {
    c.fillRect(-15, -122, 30, 26);
    c.fillStyle = eye;
    c.fillRect(0, -114, 16, 9);
  } else if (def.head === 'dome') {
    c.beginPath();
    c.arc(0, -96, 18, Math.PI, Math.PI * 2);
    c.fill();
    c.fillStyle = eye;
    c.fillRect(2, -110, 14, 7);
  } else if (def.head === 'round') {
    c.beginPath();
    c.arc(0, -110, 15, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = eye;
    c.beginPath();
    c.arc(8, -110, 5, 0, Math.PI * 2);
    c.fill();
  } else if (def.head === 'cyclops') {
    c.fillRect(-16, -122, 32, 26);
    c.fillStyle = dark;
    c.beginPath();
    c.arc(6, -109, 9, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = eye;
    c.beginPath();
    c.arc(7, -109, 6, 0, Math.PI * 2);
    c.fill();
  } else if (def.head === 'horn') {
    c.fillRect(-15, -120, 30, 24);
    c.fillStyle = eye;
    c.fillRect(0, -112, 16, 8);
    c.fillStyle = dark;
    c.beginPath();
    c.moveTo(-13, -120);
    c.lineTo(-18, -138);
    c.lineTo(-4, -120);
    c.moveTo(4, -120);
    c.lineTo(12, -138);
    c.lineTo(15, -120);
    c.fill();
  } else if (def.head === 'crown') {
    c.beginPath();
    c.arc(0, -110, 15, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = eye;
    c.fillRect(2, -113, 13, 6);
    c.fillStyle = sil ? body : '#ffd93d';
    c.beginPath();
    c.moveTo(-12, -121);
    c.lineTo(-14, -137);
    c.lineTo(-6, -129);
    c.lineTo(0, -141);
    c.lineTo(6, -129);
    c.lineTo(14, -137);
    c.lineTo(12, -121);
    c.closePath();
    c.fill();
  } else {
    c.fillStyle = dark;
    c.beginPath();
    c.moveTo(-17, -96);
    c.lineTo(-13, -122);
    c.lineTo(2, -132);
    c.lineTo(17, -112);
    c.lineTo(17, -96);
    c.closePath();
    c.fill();
    c.fillStyle = eye;
    c.fillRect(3, -113, 14, 5);
  }

  if (def.extra === 'antenna') {
    c.strokeStyle = dark;
    c.lineWidth = 3;
    c.beginPath();
    c.moveTo(-4, -122);
    c.lineTo(-8, -138);
    c.stroke();
    c.fillStyle = eye;
    c.beginPath();
    c.arc(-8, -140, 4, 0, Math.PI * 2);
    c.fill();
  } else if (def.extra === 'fins') {
    c.fillStyle = dark;
    c.beginPath();
    c.moveTo(-15, -118);
    c.lineTo(-34, -128);
    c.lineTo(-15, -104);
    c.closePath();
    c.fill();
  }

  drawArm(c, 6, -88, front, frontLen, body);
  if (def.extra === 'shield') {
    c.fillStyle = dark;
    c.beginPath();
    c.arc(26, -64, 17, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = body;
    c.lineWidth = 3;
    c.stroke();
    c.fillStyle = eye;
    c.beginPath();
    c.arc(26, -64, 5, 0, Math.PI * 2);
    c.fill();
  }
  if (glow > 0) {
    c.fillStyle = sil ? eye : def.eye;
    c.globalAlpha *= 0.55 + 0.4 * Math.sin(t * 40);
    c.beginPath();
    c.arc(6 + 45, -88, 6 + glow * 16, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

// arena.sky/ground/line färgar om byggnaderna, golvet och golvlinjen per bana — resten av
// layouten (siluetter, perspektivlinjer) är samma för alla banor, bara temat skiftar.
function buildBackground(arena) {
  const bg = document.createElement('canvas');
  bg.width = W;
  bg.height = H;
  const c = bg.getContext('2d');

  const sky = c.createLinearGradient(0, 0, 0, FLOOR);
  sky.addColorStop(0, '#0a1024');
  sky.addColorStop(1, arena.sky);
  c.fillStyle = sky;
  c.fillRect(0, 0, W, H);

  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let x = 0; x < W; ) {
    const bw = 40 + rnd() * 70;
    const bh = 80 + rnd() * 200;
    c.fillStyle = arena.line;
    c.globalAlpha = 0.5;
    c.fillRect(x, FLOOR - bh, bw, bh);
    c.globalAlpha = 1;
    c.fillStyle = 'rgba(255, 217, 120, 0.35)';
    for (let wy = FLOOR - bh + 12; wy < FLOOR - 16; wy += 22) {
      for (let wx = x + 8; wx < x + bw - 10; wx += 16) {
        if (rnd() < 0.4) c.fillRect(wx, wy, 6, 9);
      }
    }
    x += bw + 4;
  }

  const floor = c.createLinearGradient(0, FLOOR, 0, H);
  floor.addColorStop(0, arena.line);
  floor.addColorStop(1, arena.ground);
  c.fillStyle = floor;
  c.fillRect(0, FLOOR, W, H - FLOOR);
  c.strokeStyle = 'rgba(120, 140, 220, 0.18)';
  c.lineWidth = 1;
  c.beginPath();
  for (let i = -10; i <= 30; i++) {
    c.moveTo(W / 2 + i * 30, FLOOR);
    c.lineTo(W / 2 + i * 120, H);
  }
  c.stroke();
  c.fillStyle = arena.line;
  c.fillRect(0, FLOOR - 2, W, 3);
  return bg;
}

const backgroundCache = {}; // en förbyggd bakgrund per bana-id, bygget är för tungt att göra varje bildruta

function fighterPose(f, opp) {
  const a = f.act;
  return {
    x: f.x, y: f.y, z: f.z, facing: f.facing,
    // Vart roboten tittar i 3D: mot motståndaren, även snett i djupled.
    aimX: opp ? opp.x - f.x : f.facing, aimZ: opp ? opp.z - f.z : 0, time: f.time, walkT: f.walkT,
    moving: f.moving, air: !f.onGround, hurt: f.hurt > 0, flash: f.flash, dead: f.dead,
    actKind: a ? a.kind : null, actT: a ? a.t : 0, actDur: a ? a.dur : 1,
    ready: f.energy >= specialCost(f),
  };
}

function drawFighter(f, isPlayer, mysterious) {
  const pose = fighterPose(f);
  if (mysterious) pose.silhouette = true;
  const a = f.act;

  const lift = clamp((FLOOR - f.y) / 160, 0, 1);
  ctx.fillStyle = `rgba(0, 0, 0, ${0.35 * (1 - lift * 0.6)})`;
  ctx.beginPath();
  ctx.ellipse(f.x, FLOOR + 6, f.w * (0.7 - lift * 0.25), 7, 0, 0, Math.PI * 2);
  ctx.fill();

  if (f.dashT > 0) {
    for (let i = 1; i <= 3; i++) {
      drawRobot(ctx, f.def, { ...pose, x: f.x - f.facing * i * 32, alpha: 0.28 / i, flash: 0 });
    }
  }
  if (a && a.kind === 'special' && f.def.special.type === 'teleport') {
    pose.alpha = a.t < 0.25 ? 1 - (a.t / 0.25) * 0.95 : Math.min(1, 0.05 + (a.t - 0.25) / 0.15);
  }
  if (f.buffT > 0) {
    ctx.strokeStyle = `rgba(255, 70, 50, ${0.45 + 0.25 * Math.sin(f.time * 14)})`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(f.x, f.y - f.h / 2, f.w * 0.9, f.h * 0.62, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  drawRobot(ctx, f.def, pose);
  if (f.reflectT > 0) {
    ctx.fillStyle = 'rgba(200, 255, 235, 0.22)';
    ctx.strokeStyle = `rgba(230, 255, 245, ${0.6 + 0.3 * Math.sin(f.time * 20)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(f.x, f.y - f.h / 2, f.w * 0.95, f.h * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (f.frozenT > 0) {
    ctx.fillStyle = 'rgba(160, 225, 255, 0.55)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(f.x, f.y - f.h / 2, f.w * 0.85, f.h * 0.58, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  if (a && f.def.special.type === 'snipe' && a.t < 0.85) {
    const y = f.y - f.h * 0.55;
    ctx.strokeStyle = `rgba(255, 50, 50, ${0.25 + 0.6 * (a.t / 0.85)})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(f.x + f.facing * (f.w / 2), y);
    ctx.lineTo(f.x + f.facing * 900, y);
    ctx.stroke();
  }
  if (f.shieldT > 0) {
    ctx.fillStyle = 'rgba(95, 214, 192, 0.2)';
    ctx.strokeStyle = 'rgba(95, 214, 192, 0.9)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(f.x, f.y - f.h / 2, f.w * 0.95, f.h * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  if (isPlayer && !f.dead) {
    const y = f.y - f.h - 22;
    ctx.fillStyle = '#35d0ff';
    ctx.beginPath();
    ctx.moveTo(f.x - 8, y - 8);
    ctx.lineTo(f.x + 8, y - 8);
    ctx.lineTo(f.x, y + 4);
    ctx.closePath();
    ctx.fill();
  }
}

function drawProjectiles() {
  for (const p of game.projectiles) {
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 16;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r * 0.45, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;

  for (const b of game.beams) {
    const a = clamp(b.t / b.max, 0, 1);
    ctx.globalAlpha = a;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 14;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(b.x0, b.y);
    ctx.lineTo(b.x1, b.y);
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(b.x0, b.y);
    ctx.lineTo(b.x1, b.y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  for (const st of game.strikes) {
    if (!st.done) {
      const k = clamp(st.t / st.delay, 0, 1);
      ctx.strokeStyle = `rgba(255, 90, 140, ${0.35 + 0.5 * k})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(st.x, FLOOR + 6, 46 * (0.4 + 0.6 * k), 9, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const a = clamp(1 - (st.t - st.delay) / 0.25, 0, 1);
      ctx.fillStyle = `rgba(255, 200, 230, ${a * 0.85})`;
      ctx.fillRect(st.x - 34, 0, 68, FLOOR + 6);
    }
  }

  for (const w of game.waves) {
    ctx.fillStyle = 'rgba(255, 190, 90, 0.85)';
    ctx.beginPath();
    ctx.moveTo(w.x - w.dir * 22, FLOOR);
    ctx.lineTo(w.x, FLOOR - 34);
    ctx.lineTo(w.x + w.dir * 8, FLOOR);
    ctx.closePath();
    ctx.fill();
  }

  for (const c of game.clouds) {
    const a = clamp(c.life / 3, 0.25, 0.7);
    ctx.globalAlpha = a;
    ctx.fillStyle = '#8fe05a';
    ctx.beginPath();
    ctx.ellipse(c.x, FLOOR - 22, c.r, 34, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  for (const m of game.mines) {
    const armed = m.armT <= 0;
    ctx.fillStyle = m.color;
    ctx.beginPath();
    ctx.ellipse(m.x, FLOOR - 4, 14, 6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = armed && Math.sin(m.life * 14) > 0 ? '#ff3030' : '#ffd93d';
    ctx.beginPath();
    ctx.arc(m.x, FLOOR - 6, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBanner(text, size) {
  ctx.font = `bold ${size}px ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#0b0f1a';
  ctx.strokeText(text, W / 2, H / 2 - 40);
  ctx.fillStyle = '#ffd93d';
  ctx.fillText(text, W / 2, H / 2 - 40);
}

function draw() {
  // Mätarna hör till striderna — inte när man går omkring i staden eller Monstervärlden.
  document.getElementById('hud').style.visibility = game.phase === 'hub' || game.phase === 'monsters' ? 'hidden' : '';
  if (game.phase === 'monsters') { drawExplore(); return; }
  if (game.phase === 'hub') { drawHub(); return; }
  const arenaId = game.arena.id;
  if (!backgroundCache[arenaId]) backgroundCache[arenaId] = buildBackground(game.arena);
  const { player, ai } = game;
  const fighting = player && game.phase !== 'menu' && game.phase !== 'select';

  if (r3d) {
    const fighters = [];
    if (fighting) {
      const aiPose = fighterPose(ai, player);
      if (game.boss) aiPose.silhouette = true;
      fighters.push({ f: ai, pose: aiPose }, { f: player, pose: fighterPose(player, ai), isPlayer: true });
      for (const a of game.allies) fighters.push({ f: a.f, pose: fighterPose(a.f, ai) });
    }
    const none = [];
    r3d.render({
      arena: game.arena, shake: game.shake, fighters,
      megabeams: fighting ? game.megabeams : none, bolts: fighting ? game.bolts : none,
      projectiles: fighting ? game.projectiles : none, beams: fighting ? game.beams : none,
      strikes: fighting ? game.strikes : none, waves: fighting ? game.waves : none,
      clouds: fighting ? game.clouds : none, mines: fighting ? game.mines : none,
      particles: fighting ? game.particles : none,
      halos: fighting ? game.halos : none, quakes: fighting ? game.quakes : none,
      holes: fighting ? game.holes : none,
      clocks: fighting ? game.clocks : none, meteors: fighting ? game.meteors : none,
      wolves: fighting ? game.wolves : none, roots: fighting ? game.roots : none, tethers: fighting ? game.tethers : none,
      tides: fighting ? game.tides : none,
    });
    ctx.clearRect(0, 0, W, H);
    if (fighting) drawAllyBars((x, y, z) => r3d.project(x, y, z));
    if (fighting && game.training) drawTrainingStats();
  } else {
    ctx.save();
    if (game.shake > 0) ctx.translate(rand(-1, 1) * game.shake * 24, rand(-1, 1) * game.shake * 24);
    ctx.drawImage(backgroundCache[arenaId], 0, 0);

    if (fighting) {
      drawFighter(ai, false, game.boss);
      for (const a of game.allies) drawFighter(a.f, false);
      drawFighter(player, true);
      drawAllyBars((x, y) => ({ x, y }));
      if (game.training) drawTrainingStats();
      drawProjectiles();
      for (const p of game.particles) {
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 2, p.y - 2, 5, 5);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  if (game.phase === 'intro') drawBanner(String(Math.ceil(game.introT / 0.8)), 120);
  else if (game.banner > 0) drawBanner('KÄMPA!', 84);
  else if (game.phase === 'over') drawBanner('K.O.', 96);
  if (game.superBanner && game.phase === 'fight') {
    const b = game.superBanner;
    ctx.save();
    ctx.globalAlpha = Math.min(1, b.t / 0.3);
    ctx.font = 'bold 34px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.fillStyle = b.mine ? '#3ee8ff' : '#ff6b3d';
    const text = `⚡ ${b.name.toUpperCase()}! ⚡`;
    ctx.strokeText(text, W / 2, 90);
    ctx.fillText(text, W / 2, 90);
    ctx.restore();
  }
  if (game.online && !game.online.ended && friendRoom && !friendRoom.connected()) {
    ctx.font = '18px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fillText('Ansluter om...', W / 2, H - 24);
  }

  if (player) {
    hud.hpPlayer.style.width = `${(player.hp / player.maxHp) * 100}%`;
    hud.hpAi.style.width = `${(ai.hp / ai.maxHp) * 100}%`;
    hud.enPlayer.style.width = `${player.energy}%`;
    hud.enAi.style.width = `${ai.energy}%`;
    hud.enPlayer.classList.toggle('ready', player.energy >= specialCost(player));
    const sp = player.def.superPower;
    const pas = player.def.passive;
    const pasState = player.passive === 'shadow' && player.shadowCd > 0 ? ` (${Math.ceil(player.shadowCd)} s)`
      : player.passive === 'rewind' && player.rewound ? ' — använd'
        : player.passive === 'rooted' && player.stillT >= 1 ? ' (rotad!)'
          : player.passive === 'bloodrage' && player.hp < player.maxHp * 0.5 ? ' (aktiv!)'
            : '';
    const pasText = pas ? `✦ ${pas.name}${pasState}` : '';
    const supText = sp ? (player.superReady ? `Q: ${sp.name}` : `${sp.name} — använd`) : '';
    hud.superPlayer.textContent = [pasText, supText].filter(Boolean).join(' · ');
    hud.superPlayer.classList.toggle('used', !!sp && !player.superReady);
    hud.enAi.classList.toggle('ready', ai.energy >= specialCost(ai));
  }
}

// ---------- Loop ----------
let last = performance.now();
let acc = 0;
function frame(now) {
  acc += Math.min((now - last) / 1000, 0.1);
  last = now;
  while (acc >= STEP) {
    update(STEP);
    acc -= STEP;
  }
  draw();
  requestAnimationFrame(frame);
}

// ---------- Start ----------
// Försöker spara mot artefaktens egen databas (under den här tittarens privata gren) —
// annars (öppnad utanför claude.ai, eller ingen egen identitet att spara mot här) spelar
// man som gäst med samlingen sparad lokalt i webbläsaren i stället.
async function boot() {
  try {
    const artifact = new Backend.ArtifactBackend();
    const r = await artifact.load();
    net = artifact;
    applyAcct(r.acct);
  } catch (e) {
    // Inte på claude.ai (eller ingen egen identitet att spara mot där) — på en riktig,
    // egen webbsida kan den här sidans EGEN server ha ett konto man redan är inloggad
    // på (en cookie från förra besöket); annars blir man gäst, sparad bara lokalt.
    let resumed = false;
    try {
      const remote = new Backend.RemoteBackend();
      const r = await remote.me();
      // me() kastar ALDRIG för "inte inloggad" (401 ger bara null) — bara om det inte
      // finns någon server att fråga alls (t.ex. ett 404 på GitHub Pages). Når vi hit har
      // en riktig server faktiskt svarat, oavsett om man råkade vara inloggad eller inte.
      accountsAvailable = true;
      if (r) { net = remote; applyAcct(r.acct); resumed = true; }
    } catch (e2) { /* ingen egen server här (t.ex. GitHub Pages) — bli gäst nedan */ }
    if (!resumed) {
      const r = await net.load();
      applyAcct(r.acct);
    }
  }
  // Vänmatcher behöver en realtidskanal: Claude-sidans egen (claude.use('room')) om vi
  // körs där, annars den här sidans EGNA /api/room/*-rutter (bara om den här sidan faktiskt
  // har en egen server — samma sak som accountsAvailable redan avgjorde, eftersom de hör
  // till samma driftsättning) — annars är vänmatcher avstängda, t.ex. på GitHub Pages som
  // bara serverar statiska filer.
  try {
    roomCap = (window.claude && typeof window.claude.use === 'function') ? await window.claude.use('room') : null;
  } catch (e) {
    roomCap = null;
  }
  if (!roomCap && accountsAvailable) {
    try {
      roomCap = await Backend.connectPollRoom();
      roomIsPolling = true;
    } catch (e) {
      roomCap = null;
    }
  }
  renderAccountBar();
  byId('btn-play').disabled = false;
  showScreen('menu');
  pollWorld();
}

boot();
requestAnimationFrame(frame);
