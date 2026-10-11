// Robotdata och ekonomi (lådor, insats, daglig låda). Används av både webbläsaren och servern,
// så att reglerna är exakt desamma överallt. Inga beroenden, ingen DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // weight = chans i procent att en låda ger just den sällsynthetsnivån.
  const RARITY = {
    common: { label: 'Vanlig', weight: 66, rank: 0 },
    rare: { label: 'Sällsynt', weight: 24, rank: 1 },
    epic: { label: 'Episk', weight: 8, rank: 2 },
    legendary: { label: 'Legendarisk', weight: 2, rank: 3 },
    boss: { label: 'Mystisk', weight: 0, rank: 4 },
    wildcard: { label: 'Joker', weight: 0, rank: 2 },
  };

  // ---------- Typer ----------
  // Inspirerat av Pokémons typer (samma 17 namn), men med en egen, enklare styrke/svaghets-
  // lista i stället för att försöka återge Pokémons exakta (upphovsrättsskyddade) sifferschema.
  // Varje robot har 1–2 typer (precis som Pokémon kan ha dubbel typ). TYPE_ADVANTAGES listar
  // bara VEM som är stark mot VEM — motsatt håll (svag) följer automatiskt av samma rad, så
  // listan kan aldrig säga emot sig själv (A>B utesluter B>A).
  const TYPES = {
    eld: { label: 'Eld', color: '#ff6b3d' },
    gräs: { label: 'Gräs', color: '#7fd94a' },
    vatten: { label: 'Vatten', color: '#4da3ff' },
    normal: { label: 'Normal', color: '#c7c7a3' },
    elektrisk: { label: 'Elektrisk', color: '#ffe066' },
    kryp: { label: 'Kryp', color: '#a8c93a' },
    spöke: { label: 'Spöke', color: '#7a6bb5' },
    flygande: { label: 'Flygande', color: '#b8d4f0' },
    strid: { label: 'Strid', color: '#c0392b' },
    psykisk: { label: 'Psykisk', color: '#ff6bb5' },
    stål: { label: 'Stål', color: '#aab4c8' },
    sten: { label: 'Sten', color: '#b5a27a' },
    mark: { label: 'Mark', color: '#caa968' },
    is: { label: 'Is', color: '#9fe8ff' },
    gift: { label: 'Gift', color: '#a040d0' },
    mörk: { label: 'Mörk', color: '#5a5366' },
    fe: { label: 'Fe', color: '#ffb3d9' },
  };
  const TYPE_ADVANTAGES = [
    ['eld', 'gräs'], ['eld', 'is'], ['eld', 'kryp'], ['eld', 'stål'],
    ['vatten', 'eld'], ['vatten', 'sten'], ['vatten', 'mark'],
    ['gräs', 'vatten'], ['gräs', 'sten'], ['gräs', 'mark'],
    ['elektrisk', 'vatten'], ['elektrisk', 'flygande'],
    ['is', 'gräs'], ['is', 'flygande'], ['is', 'mark'],
    ['kryp', 'gräs'], ['kryp', 'psykisk'], ['kryp', 'mörk'],
    ['spöke', 'psykisk'], ['spöke', 'normal'],
    ['flygande', 'gräs'], ['flygande', 'strid'], ['flygande', 'kryp'],
    ['strid', 'normal'], ['strid', 'sten'], ['strid', 'mörk'], ['strid', 'is'],
    ['psykisk', 'strid'], ['psykisk', 'gift'],
    ['stål', 'is'], ['stål', 'sten'], ['stål', 'fe'],
    ['sten', 'eld'], ['sten', 'is'], ['sten', 'flygande'], ['sten', 'kryp'],
    ['mark', 'eld'], ['mark', 'elektrisk'], ['mark', 'gift'], ['mark', 'sten'], ['mark', 'stål'],
    ['gift', 'gräs'], ['gift', 'fe'],
    ['mörk', 'spöke'], ['mörk', 'psykisk'],
    ['fe', 'strid'], ['fe', 'mörk'],
  ];
  const TYPE_STRONG_MUL = 1.5;
  const TYPE_WEAK_MUL = 1 / 1.5; // ungefär så att en vinst + en förlust tar ut varandra
  const strongAgainst = new Set(TYPE_ADVANTAGES.map(([a, b]) => `${a}>${b}`));

  function singleTypeMultiplier(attackerType, defenderType) {
    if (strongAgainst.has(`${attackerType}>${defenderType}`)) return TYPE_STRONG_MUL;
    if (strongAgainst.has(`${defenderType}>${attackerType}`)) return TYPE_WEAK_MUL;
    return 1;
  }

  // Dubbel typ räknas precis som i Pokémon: VARJE kombination av attackerarens och
  // försvararens typer bidrar till slutresultatet, multiplicerat ihop — är man svag mot båda
  // försvararens typer (eller försvararen svag mot båda ens egna) blir skillnaden större, inte
  // bara den bästa/sämsta av dem.
  function typeMultiplier(attackerTypes, defenderTypes) {
    let mul = 1;
    for (const at of attackerTypes || []) {
      for (const dt of defenderTypes || []) {
        mul *= singleTypeMultiplier(at, dt);
      }
    }
    return mul;
  }

  // ---------- Jokerns attack ----------
  // Namnet du ger jokern avgör vilken av ett litet urval specialattacker den får — samma namn
  // ger alltid samma attack (deterministiskt), olika namn ger (oftast) olika attacker. Innan
  // man döpt den, eller för en motståndares namnlösa kopia, används förvalet (index 0), se
  // wildcardSpecialFor() längre ner. Alla är EGNA mekaniker som ingen annan robot har — se
  // SPECIALS i game.js, till skillnad från den allra första lösningen som bara lånade andra
  // robotars befintliga attacktyper.
  const WILDCARD_SPECIALS = [
    { type: 'copycat', name: 'Jokerkopia', dmg: 18, desc: 'Imiterar och använder motståndarens egen specialattack mot dem.' },
    { type: 'gamble', name: 'Turkast', dmg: 14, desc: 'Femtiofemtio: antingen dubbel skada, eller helt bom (men du blir kort snabbare och starkare).' },
    { type: 'swap', name: 'Ödesbyte', desc: 'Drar både dig och motståndaren mot samma liv mitt emellan — farligt om du leder, en räddning om du inte gör det.' },
    { type: 'jinx', name: 'Förbannelse', desc: 'Tömmer motståndarens energi och halverar deras återhämtning en kort stund.' },
    { type: 'allin', name: 'Jokersatsning', dmg: 15, desc: 'Offrar en del av ditt eget liv för en mycket hårdare smäll.' },
    { type: 'drawcard', name: 'Korthandel', heal: 20, desc: 'Drar ett slumpat kort: snabbare & starkare, en sköld, eller läkning.' },
    { type: 'steal', name: 'Jokerstöld', steal: 25, desc: 'Stjäl 25 energi från motståndaren åt dig själv.' },
    { type: 'taunt', name: 'Hån', desc: 'Gör motståndaren sårbar: de tar 40 % mer skada i tre sekunder.' },
    { type: 'prophecy', name: 'Spådom', dmg: 26, desc: 'En försenad smäll där motståndaren står just nu — hinner de flytta sig missar den.' },
    { type: 'swapplace', name: 'Platsbyte', desc: 'Byter plats blixtsnabbt med motståndaren.' },
  ];
  const WILDCARD_SPECIAL_TYPES = new Set(WILDCARD_SPECIALS.map((s) => s.type));

  const ROBOTS = [
    {
      id: 'bolt', name: 'Bolt', rarity: 'common', types: ['elektrisk'],
      color: '#35d0ff', accent: '#0f4a66', eye: '#ffffff', head: 'box', extra: 'antenna',
      scale: 1, hp: 100, speed: 235, punch: 8,
      special: { type: 'projectile', name: 'Energiskott', dmg: 20, desc: 'Ett stort skott rakt fram.' },
    },
    {
      id: 'salvo', name: 'Salvo', rarity: 'common', types: ['gräs'],
      color: '#8bd450', accent: '#274a12', eye: '#fff36b', head: 'round', extra: 'none',
      scale: 1, hp: 90, speed: 205, punch: 6,
      special: { type: 'burst', name: 'Kulspruta', dmg: 7, desc: 'Tre snabba skott i rad.' },
    },
    {
      id: 'titan', name: 'Titan', rarity: 'rare', types: ['mark', 'sten'],
      color: '#ff9f43', accent: '#5a3510', eye: '#ffffff', head: 'dome', extra: 'shoulders',
      scale: 1.2, hp: 105, speed: 140, punch: 8,
      special: { type: 'shockwave', name: 'Jordskalv', dmg: 20, desc: 'Stötvågor längs marken. Hoppa över dem!' },
    },
    {
      id: 'blitz', name: 'Blitz', rarity: 'rare', types: ['elektrisk'],
      color: '#ffd93d', accent: '#5a4a08', eye: '#ff3d3d', head: 'box', extra: 'fins',
      scale: 0.95, hp: 95, speed: 285, punch: 7,
      special: { type: 'dash', name: 'Blixtstöt', dmg: 25, desc: 'Rusar fram och slår till.' },
    },
    {
      id: 'shade', name: 'Shade', rarity: 'epic', types: ['spöke', 'mörk'],
      color: '#b46bff', accent: '#2b1550', eye: '#ff5fd2', head: 'hood', extra: 'none',
      scale: 1, hp: 100, speed: 250, punch: 10,
      special: { type: 'teleport', name: 'Skuggsteg', dmg: 32, desc: 'Teleporterar bakom motståndaren.' },
    },
    {
      id: 'rook', name: 'Rook', rarity: 'common', types: ['sten', 'stål'],
      color: '#8f9bb3', accent: '#2f3646', eye: '#ffb347', head: 'cyclops', extra: 'none',
      scale: 1.1, hp: 110, speed: 200, punch: 8,
      special: { type: 'smash', name: 'Krossen', dmg: 20, desc: 'Ett tungt slag med lång räckvidd.' },
    },
    {
      id: 'mortar', name: 'Mortar', rarity: 'common', types: ['eld'],
      color: '#e0574f', accent: '#4d1712', eye: '#ffd0a0', head: 'horn', extra: 'cannon',
      scale: 1, hp: 100, speed: 230, punch: 8,
      special: { type: 'lob', name: 'Granat', dmg: 28, desc: 'Kastar en granat i en båge som exploderar.' },
    },
    {
      id: 'volt', name: 'Volt', rarity: 'rare', types: ['elektrisk'],
      color: '#4d6bff', accent: '#16215a', eye: '#ffffff', head: 'round', extra: 'antenna',
      scale: 1, hp: 95, speed: 245, punch: 8,
      special: { type: 'beam', name: 'Blixtstråle', dmg: 20, desc: 'Ögonblicklig stråle långt fram. Hoppa högt!' },
    },
    {
      id: 'aegis', name: 'Aegis', rarity: 'rare', types: ['stål'],
      color: '#e8eef8', accent: '#1d6a63', eye: '#5fd6c0', head: 'dome', extra: 'shield',
      scale: 1, hp: 100, speed: 215, punch: 8,
      special: { type: 'barrier', name: 'Energisköld', heal: 6, desc: 'Ogenomtränglig i 1,1 sekunder och lagar 6 HP.' },
    },
    {
      id: 'nova', name: 'Nova', rarity: 'epic', types: ['flygande', 'psykisk'],
      color: '#ff5fa2', accent: '#5a1236', eye: '#ffffff', head: 'horn', extra: 'jet',
      scale: 1, hp: 100, speed: 245, punch: 8,
      special: { type: 'orbital', name: 'Stjärnfall', dmg: 24, desc: 'Tre ljuspelare slår ner. Flytta dig i tid!' },
    },
    {
      id: 'omega', name: 'Omega', rarity: 'legendary', types: ['elektrisk', 'mörk'],
      color: '#262a36', accent: '#ffd93d', eye: '#ff3030', head: 'crown', extra: 'cape',
      scale: 1.15, hp: 110, speed: 250, punch: 9,
      special: { type: 'overdrive', name: 'Överladdning', desc: 'Snabbare, starkare slag och snabbare attacker i 5 sekunder.' },
    },
    {
      id: 'spike', name: 'Spike', rarity: 'common', types: ['stål'],
      color: '#2fc4b2', accent: '#0d4a43', eye: '#ffffff', head: 'box', extra: 'spikes',
      scale: 1, hp: 100, speed: 230, punch: 7,
      special: { type: 'spread', name: 'Hagelbössa', dmg: 8, desc: 'Tre skott i solfjäder.' },
    },
    {
      id: 'vamp', name: 'Vamp', rarity: 'rare', types: ['mörk', 'gift'],
      color: '#8a1c3b', accent: '#2e0713', eye: '#ff4d6d', head: 'hood', extra: 'cape',
      scale: 1, hp: 100, speed: 235, punch: 8,
      special: { type: 'drain', name: 'Blodsug', dmg: 16, heal: 12, desc: 'Slag som lagar dig med 12 HP.' },
    },
    {
      id: 'prisma', name: 'Prisma', rarity: 'rare', types: ['is', 'fe'],
      color: '#9ff2d0', accent: '#1f5c48', eye: '#ffffff', head: 'round', extra: 'fins',
      scale: 1, hp: 115, speed: 225, punch: 9,
      special: { type: 'reflect', name: 'Spegelsköld', desc: 'Skickar tillbaka skott i 2 sekunder.' },
    },
    {
      id: 'frost', name: 'Frost', rarity: 'epic', types: ['is'],
      color: '#bfe9ff', accent: '#1c4f78', eye: '#2a6fb0', head: 'cyclops', extra: 'spikes',
      scale: 1, hp: 105, speed: 245, punch: 9,
      special: { type: 'freeze', name: 'Frysskott', dmg: 12, desc: 'Fryser motståndaren i 1,1 sekunder.' },
    },
    {
      id: 'falk', name: 'Falk', rarity: 'epic', types: ['flygande'],
      color: '#6b8e23', accent: '#2a3610', eye: '#ff3030', head: 'dome', extra: 'cannon',
      scale: 1, hp: 105, speed: 240, punch: 9,
      special: { type: 'snipe', name: 'Prickskott', dmg: 46, desc: 'Siktar med laser, sedan träffar den hårt.' },
    },
    {
      id: 'zenith', name: 'Zenith', rarity: 'legendary', types: ['flygande', 'fe'],
      color: '#f5f5ff', accent: '#7a3cff', eye: '#ffd93d', head: 'crown', extra: 'jet',
      scale: 1.05, hp: 100, speed: 250, punch: 8,
      special: { type: 'flurry', name: 'Slagstorm', dmg: 7, desc: 'Fyra snabba slag i följd, det sista hårdast.' },
    },
    // Bossar: går aldrig att få av en låda eller möta i en vanlig match. Går att utmana via
    // egna knappar, oavsett nivå, om och om igen. difficulty styr hur bra AI:n spelar och hur
    // mycket den stridstillfälliga boostern maxar ut (se skillForBoss/enrageFor i game.js).
    // Vinner du läggs roboten till i samlingen med helt vanliga grundvärden, utan boost.
    {
      id: 'flicker', name: 'Flicker', rarity: 'boss', boss: true, difficulty: 'easy', types: ['elektrisk'],
      color: '#fff9a6', accent: '#8a7a1f', eye: '#ffffff', head: 'round', extra: 'antenna',
      scale: 0.95, hp: 100, speed: 265, punch: 8,
      special: { type: 'drain', name: 'Själadränering', dmg: 14, heal: 10, desc: 'Slag som lagar den med 10 HP.' },
    },
    {
      id: 'specter', name: 'Specter', rarity: 'boss', boss: true, difficulty: 'easy', types: ['spöke'],
      color: '#d8e4ea', accent: '#3a4a52', eye: '#7fffd4', head: 'hood', extra: 'none',
      scale: 1, hp: 110, speed: 270, punch: 9,
      special: { type: 'teleport', name: 'Skuggsprång', dmg: 30, desc: 'Teleporterar bakom dig och slår till hårt.' },
    },
    {
      id: 'nemesis', name: 'Nemesis', rarity: 'boss', boss: true, difficulty: 'medium', types: ['mörk', 'strid'],
      color: '#161a26', accent: '#ff1744', eye: '#ff1744', head: 'crown', extra: 'cape',
      scale: 1.15, hp: 130, speed: 225, punch: 10,
      special: { type: 'annihilate', name: 'Utplåning', dmg: 32, desc: 'Ett förödande slag med enorm knockback.' },
    },
    {
      id: 'warden', name: 'Warden', rarity: 'boss', boss: true, difficulty: 'medium', types: ['vatten', 'stål'],
      color: '#3ecfcf', accent: '#0f4a4a', eye: '#aef7f7', head: 'dome', extra: 'shield',
      scale: 1.05, hp: 125, speed: 215, punch: 10,
      special: { type: 'barrier', name: 'Vaktsköld', heal: 10, desc: 'Ogenomtränglig en kort stund och lagar 10 HP.' },
    },
    {
      id: 'colossus', name: 'Colossus', rarity: 'boss', boss: true, difficulty: 'hard', types: ['sten', 'mark'],
      color: '#2e2a3a', accent: '#6a5acd', eye: '#b388ff', head: 'dome', extra: 'shoulders',
      scale: 1.3, hp: 155, speed: 155, punch: 12,
      special: { type: 'shockwave', name: 'Markskalv', dmg: 28, desc: 'Stötvågor längs marken, åt båda hållen.' },
    },
    {
      id: 'behemoth', name: 'Behemoth', rarity: 'boss', boss: true, difficulty: 'hard', types: ['mark', 'eld'],
      color: '#3a2a1f', accent: '#ff7a1f', eye: '#ffb347', head: 'horn', extra: 'cannon',
      scale: 1.35, hp: 170, speed: 140, punch: 13,
      special: { type: 'orbital', name: 'Himlafall', dmg: 26, desc: 'Tre förödande ljuspelare slår ner.' },
    },
    // Jokern: en helt vanlig samlarrobot (går att få av en låda, möta i vanliga matcher — INTE
    // en boss), men kan dyka upp oavsett vilken sällsynthet lådan rullade. Heter "???" tills
    // man själv döper den, se nameWildcard().
    {
      id: 'wildcard', name: '???', rarity: 'wildcard', types: ['normal'],
      color: '#dfe6ff', accent: '#9b59b6', eye: '#ffd93d', head: 'round', extra: 'question',
      scale: 1, hp: 100, speed: 235, punch: 8,
      special: WILDCARD_SPECIALS[0], // förval tills man döpt den, se wildcardSpecialFor()
    },
    {
      id: 'boomer', name: 'Boomer', rarity: 'common', types: ['flygande'],
      color: '#ffb347', accent: '#5a3200', eye: '#ffffff', head: 'round', extra: 'fins',
      scale: 1, hp: 100, speed: 225, punch: 7,
      special: { type: 'boomerang', name: 'Bumerang', dmg: 13, desc: 'En skiva som svänger tillbaka på vägen ut.' },
    },
    {
      id: 'sapper', name: 'Sapper', rarity: 'common', types: ['mark'],
      color: '#7a8a5a', accent: '#2a3318', eye: '#ffd93d', head: 'cyclops', extra: 'cannon',
      scale: 1, hp: 105, speed: 210, punch: 7,
      special: { type: 'mine', name: 'Mina', dmg: 20, desc: 'Lägger en mina som exploderar när motståndaren kommer nära.' },
    },
    {
      id: 'anchor', name: 'Anchor', rarity: 'rare', types: ['vatten', 'stål'],
      color: '#4a6fa5', accent: '#12233d', eye: '#a0e0ff', head: 'horn', extra: 'shoulders',
      scale: 1.1, hp: 110, speed: 195, punch: 9,
      special: { type: 'grapple', name: 'Krok', dmg: 18, desc: 'En krok som drar in motståndaren och slår till.' },
    },
    {
      id: 'miasma', name: 'Miasma', rarity: 'rare', types: ['gift'],
      color: '#7fd94a', accent: '#1f3a10', eye: '#c8ff6b', head: 'hood', extra: 'none',
      scale: 1, hp: 100, speed: 240, punch: 8,
      special: { type: 'poison', name: 'Giftmoln', dmg: 12, desc: 'Släpper ett moln som skadar över tid.' },
    },
    {
      id: 'riposte', name: 'Riposte', rarity: 'epic', types: ['strid'],
      color: '#e0c4ff', accent: '#3a1f5c', eye: '#ff5fd2', head: 'dome', extra: 'cape',
      scale: 1, hp: 88, speed: 235, punch: 8,
      special: { type: 'counter', name: 'Kontring', dmg: 21, desc: 'Blir osårbar en kort stund och slår tillbaka om du är nära.' },
    },
    {
      id: 'comet', name: 'Comet', rarity: 'legendary', types: ['eld', 'flygande'],
      color: '#ff7a3d', accent: '#5c1f0a', eye: '#ffffff', head: 'crown', extra: 'jet',
      scale: 1.1, hp: 112, speed: 245, punch: 9,
      special: { type: 'meteorslam', name: 'Meteorsmäll', dmg: 30, desc: 'Slår ner en jättesmäll där motståndaren står.' },
    },
  ];

  const robotById = Object.fromEntries(ROBOTS.map((r) => [r.id, r]));
  const BOSS_IDS = ROBOTS.filter((r) => r.boss).map((r) => r.id);
  const rankOf = (def) => RARITY[def.rarity].rank;

  // Enkel, stabil stränghash (FNV-1a) — bara till för att sprida ut namn över attackerna,
  // ingen säkerhetsanvändning. Gemener så att "Rex" och "rex" ger samma attack.
  function hashName(name) {
    let h = 2166136261;
    const s = String(name).toLowerCase();
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  // chosenType: spelarens egna, uttryckliga val (se chooseWildcardSpecial) — om satt och
  // giltigt vinner det alltid över namnet. Annars styrs attacken av namnet som förut.
  function wildcardSpecialFor(name, chosenType) {
    if (chosenType && WILDCARD_SPECIAL_TYPES.has(chosenType)) {
      return WILDCARD_SPECIALS.find((s) => s.type === chosenType);
    }
    if (!name) return WILDCARD_SPECIALS[0];
    return WILDCARD_SPECIALS[hashName(name) % WILDCARD_SPECIALS.length];
  }

  // ---------- Banor ----------
  // En bana ändrar bara fysiken (tyngdkraft, fart, skada) lika för båda robotarna — aldrig
  // vem som vinner i sig, bara hur matchen känns. Slumpas fram av startMatch/vänmatchens
  // server, aldrig valbar i sig, så båda sidor i en vänmatch alltid hamnar på samma bana.
  const ARENAS = [
    {
      id: 'classic', name: 'Verkstadsgolvet', hint: '',
      gravityMul: 1, speedMul: 1, dmgMul: 1,
      sky: '#141b30', ground: '#0a0e18', line: '#2a3556',
    },
    {
      id: 'moon', name: 'Månbasen', hint: 'Låg tyngdkraft — hoppar mycket högre',
      gravityMul: 0.45, speedMul: 1, dmgMul: 1,
      sky: '#190f33', ground: '#0b0718', line: '#5b4b9e',
    },
    {
      id: 'ice', name: 'Isbanan', hint: 'Halt underlag — rör sig mycket snabbare',
      gravityMul: 1, speedMul: 1.45, dmgMul: 1,
      sky: '#082029', ground: '#041019', line: '#2f8fae',
    },
    {
      id: 'scrapyard', name: 'Skrotupplaget', hint: 'Tungt underlag — långsammare men hårdare slag',
      gravityMul: 1, speedMul: 0.72, dmgMul: 1.35,
      sky: '#241a0e', ground: '#120c06', line: '#8a5a2a',
    },
  ];
  const arenaById = Object.fromEntries(ARENAS.map((a) => [a.id, a]));
  // rng är en funktion som ger ett tal i [0, 1) — samma mönster som rollBox/pickOpponent.
  const pickArena = (rng) => ARENAS[Math.floor(rng() * ARENAS.length)];

  // ---------- Konto ----------
  // Ett konto är { inv: {robotId: antal}, boxes, daily: 'ÅÅÅÅ-MM-DD', selected, level, xp }.
  function newAccount() {
    return {
      inv: { bolt: 1 }, boxes: 0, daily: '', selected: 'bolt', level: 1, xp: 0,
      wildcardName: null, wildcardSpecialType: null,
    };
  }

  // Rensar ett fritt namn (för jokerroboten): trim, 1–20 tecken, bokstäver/siffror/vanlig
  // skiljetecken — annars null (ogiltigt), aldrig en krasch.
  function cleanName(raw) {
    if (typeof raw !== 'string') return null;
    const name = raw.trim().replace(/\s+/g, ' ').slice(0, 20);
    return /^[\p{L}\p{N} '\-!?.]{1,20}$/u.test(name) ? name : null;
  }

  // Gör vilket sparat värde som helst till ett giltigt konto.
  function sanitize(raw) {
    const acct = {
      inv: {}, boxes: 0, daily: '', selected: 'bolt', level: 1, xp: 0,
      wildcardName: null, wildcardSpecialType: null,
    };
    if (raw && typeof raw === 'object') {
      const inv = raw.inv && typeof raw.inv === 'object' ? raw.inv : {};
      for (const r of ROBOTS) {
        const n = Math.floor(Number(inv[r.id]));
        if (n > 0 && n < 1e6) acct.inv[r.id] = n;
      }
      acct.boxes = Math.min(1e6, Math.max(0, Math.floor(Number(raw.boxes)) || 0));
      if (typeof raw.daily === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.daily)) acct.daily = raw.daily;
      if (typeof raw.selected === 'string') acct.selected = raw.selected;
      acct.level = Math.max(1, Math.min(9999, Math.floor(Number(raw.level)) || 1));
      acct.xp = Math.max(0, Math.min(1e6, Math.floor(Number(raw.xp)) || 0));
      acct.wildcardName = cleanName(raw.wildcardName);
      if (typeof raw.wildcardSpecialType === 'string' && WILDCARD_SPECIAL_TYPES.has(raw.wildcardSpecialType)) {
        acct.wildcardSpecialType = raw.wildcardSpecialType;
      }
    }
    // Man ska alltid ha minst en Bolt — den går aldrig helt förlorad, oavsett hur kontot ser ut.
    acct.inv.bolt = Math.max(1, acct.inv.bolt || 0);
    if (!acct.inv[acct.selected]) acct.selected = Object.keys(acct.inv)[0];
    return acct;
  }

  // Hur mycket erfarenhet som krävs för att gå från en viss nivå till nästa. Växer sakta så att
  // det aldrig tar orimligt lång tid, men ändå känns som framsteg.
  const xpNeeded = (level) => level + 2;

  // Från vilken sällsynthet ett nivåpris lägst får vara. Var femte nivå är garanterat legendarisk.
  function levelPrizeFloor(level) {
    if (level % 5 === 0) return 'legendary';
    if (level >= 7) return 'epic';
    if (level >= 4) return 'rare';
    return 'common';
  }

  // Som rollBox, men bara bland sällsyntheter på eller över floor — ett nivåpris ska alltid
  // kännas minst lika bra som en vanlig låda.
  // Jokern har en liten, fast chans att dyka upp OAVSETT vilken sällsynthet som annars skulle
  // rullats — den föregår tiernvalet helt i stället för att blandas in i en viss tier (det
  // skulle göra den alldeles för vanlig, eftersom den vanliga tiern redan har flest robotar).
  const WILDCARD_CHANCE = 0.02;

  function rollBoxFrom(rng, floor) {
    if (rng() < WILDCARD_CHANCE) return robotById.wildcard;
    const tiers = Object.keys(RARITY).slice(Object.keys(RARITY).indexOf(floor));
    let pick = rng() * tiers.reduce((sum, t) => sum + RARITY[t].weight, 0);
    let tier = tiers[tiers.length - 1];
    for (const t of tiers) {
      pick -= RARITY[t].weight;
      if (pick <= 0) { tier = t; break; }
    }
    const pool = ROBOTS.filter((r) => r.rarity === tier && !r.boss && r.id !== 'wildcard');
    return pool[Math.floor(rng() * pool.length)];
  }

  // Lägger till erfarenhet och höjer nivån (kan hoppa flera nivåer på en gång om mycket xp ges
  // samtidigt). Varje ny nivå ger en robot som pris. Returnerar en lista över de nivåer som togs.
  function addXp(acct, amount, rng) {
    acct.level = acct.level || 1;
    acct.xp = (acct.xp || 0) + amount;
    const levelUps = [];
    while (acct.xp >= xpNeeded(acct.level)) {
      acct.xp -= xpNeeded(acct.level);
      acct.level += 1;
      const prize = rollBoxFrom(rng, levelPrizeFloor(acct.level));
      addRobot(acct, prize.id);
      levelUps.push({ level: acct.level, prize: prize.id });
    }
    return levelUps;
  }

  const count = (acct, id) => acct.inv[id] || 0;
  const total = (acct) => Object.values(acct.inv).reduce((a, b) => a + b, 0);
  const canStake = (acct) => total(acct) >= 2;
  const addRobot = (acct, id) => { acct.inv[id] = count(acct, id) + 1; };
  const removeRobot = (acct, id) => {
    if (id === 'bolt' && count(acct, id) <= 1) return; // alltid minst en Bolt kvar, se startMatch
    acct.inv[id] = Math.max(0, count(acct, id) - 1);
    if (!acct.inv[id]) delete acct.inv[id];
  };

  // rng är en funktion som ger ett tal i [0, 1).
  function rollBox(rng) {
    if (rng() < WILDCARD_CHANCE) return robotById.wildcard;
    const tiers = Object.keys(RARITY);
    let pick = rng() * tiers.reduce((sum, t) => sum + RARITY[t].weight, 0);
    let tier = tiers[tiers.length - 1];
    for (const t of tiers) {
      pick -= RARITY[t].weight;
      if (pick <= 0) { tier = t; break; }
    }
    const pool = ROBOTS.filter((r) => r.rarity === tier && !r.boss && r.id !== 'wildcard');
    return pool[Math.floor(rng() * pool.length)];
  }

  // Vanlig match: motståndaren kan vara en nivå sällsyntare än din robot. Insatsmatch: aldrig
  // sällsyntare än din insats, eftersom du vinner motståndarens robot.
  function pickOpponent(robotId, stake, rng) {
    const def = robotById[robotId];
    const maxRank = rankOf(def) + (stake ? 0 : 1);
    const pool = ROBOTS.filter((r) => r.id !== robotId && rankOf(r) <= maxRank && !r.boss);
    return pool[Math.floor(rng() * pool.length)];
  }

  // Startar en match. Insatsen dras direkt, så det går inte att smita undan en förlust. Alla
  // bossar går att utmana när som helst, oavsett nivå, och om och om igen — bossId väljer
  // vilken av dem. Ingen insats sätts på spel mot en boss.
  function startMatch(acct, robotId, mode, rng, bossId) {
    if (!robotById[robotId] || count(acct, robotId) < 1) return { error: 'Du äger inte den roboten.' };
    acct.selected = robotId;
    if (mode === 'boss') {
      if (!BOSS_IDS.includes(bossId)) return { error: 'Okänd boss.' };
      return { robot: robotId, stake: false, opp: bossId, boss: true };
    }
    // Bolt går aldrig att sätta i insats som sista kopian — man ska alltid ha minst en kvar.
    const canStakeThis = !(robotId === 'bolt' && count(acct, robotId) <= 1);
    const stake = mode === 'stake' && canStake(acct) && canStakeThis;
    if (stake) removeRobot(acct, robotId);
    return { robot: robotId, stake, opp: pickOpponent(robotId, stake, rng).id };
  }

  // Avslutar en match. Vinst ger en låda och erfarenhet (närmre nästa nivå), och i en
  // insatsmatch får du tillbaka insatsen plus motståndarens robot. En bossvinst ger i stället
  // bossens robot (utan den stridstillfälliga boostern) — bossen går att utmana igen när du
  // vill, om och om igen. Förlorar du mot bossen kostar det inget — bara en ny chans.
  // rng behövs bara vid vinst (för ett eventuellt nivåpris) — vänmatcher anropar aldrig den
  // här funktionen.
  function finishMatch(acct, match, won, rng) {
    const result = { won, stake: match.stake, gained: null, lost: null, box: won, levelUps: [], bossWon: null };
    if (won) {
      acct.boxes += 1;
      result.levelUps = addXp(acct, 1, rng);
      if (match.boss) {
        addRobot(acct, match.opp);
        result.bossWon = match.opp;
      } else if (match.stake) {
        addRobot(acct, match.robot);
        addRobot(acct, match.opp);
        result.gained = match.opp;
      }
    } else if (match.stake) {
      result.lost = match.robot;
    }
    if (!acct.inv[acct.selected]) acct.selected = Object.keys(acct.inv)[0];
    return result;
  }

  function openBox(acct, rng) {
    if (acct.boxes <= 0) return null;
    acct.boxes -= 1;
    const prize = rollBox(rng);
    addRobot(acct, prize.id);
    return { id: prize.id, n: count(acct, prize.id) };
  }

  function claimDaily(acct, today) {
    if (!(today > acct.daily)) return false;
    acct.boxes += 1;
    acct.daily = today;
    return true;
  }

  // Det klienten får se: kontot plus om dagens låda finns att hämta.
  function view(acct, today, minutesToNext) {
    const level = acct.level || 1;
    return {
      inv: { ...acct.inv },
      boxes: acct.boxes,
      selected: acct.selected,
      dailyAvailable: today > acct.daily,
      dailyMinutes: minutesToNext,
      level,
      xp: acct.xp || 0,
      xpNeeded: xpNeeded(level),
      wildcardName: acct.wildcardName || null,
      wildcardSpecialType: acct.wildcardSpecialType || null,
    };
  }

  // Döper jokerroboten — gäller alla kopior man äger, de delar namn precis som alla andra
  // robotar är identiska kopior av sin typ.
  function nameWildcard(acct, name) {
    if (count(acct, 'wildcard') < 1) return { error: 'Du äger inte den roboten än.' };
    const clean = cleanName(name);
    if (!clean) return { error: 'Namnet måste vara 1–20 tecken (bokstäver, siffror, mellanslag).' };
    acct.wildcardName = clean;
    return { name: clean };
  }

  // Väljer jokerns attack rakt av, i stället för att låta namnet avgöra den. type === null
  // (eller 'auto') återställer till namn-styrt läge.
  function chooseWildcardSpecial(acct, type) {
    if (count(acct, 'wildcard') < 1) return { error: 'Du äger inte den roboten än.' };
    if (type === null || type === 'auto') {
      acct.wildcardSpecialType = null;
      return { type: null };
    }
    if (typeof type !== 'string' || !WILDCARD_SPECIAL_TYPES.has(type)) return { error: 'Okänd attack.' };
    acct.wildcardSpecialType = type;
    return { type };
  }

  return {
    RARITY, ROBOTS, robotById, rankOf, BOSS_IDS,
    ARENAS, arenaById, pickArena,
    TYPES, typeMultiplier,
    WILDCARD_SPECIALS, wildcardSpecialFor,
    newAccount, sanitize, count, total, canStake, addRobot, removeRobot,
    rollBox, rollBoxFrom, pickOpponent, startMatch, finishMatch, openBox, claimDaily, view, nameWildcard,
    chooseWildcardSpecial,
    xpNeeded, addXp,
  };
});
