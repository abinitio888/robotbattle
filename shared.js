// Robotdata och ekonomi (lådor, insats, daglig låda). Används av både webbläsaren och servern,
// så att reglerna är exakt desamma överallt. Inga beroenden, ingen DOM.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Shared = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // weight = chans i procent att en låda ger just den sällsynthetsnivån.
  const RARITY = {
    common: { label: 'Vanlig', weight: 65, rank: 0 },
    rare: { label: 'Sällsynt', weight: 24, rank: 1 },
    epic: { label: 'Episk', weight: 8, rank: 2 },
    legendary: { label: 'Legendarisk', weight: 2, rank: 3 },
    divine: { label: 'Gudomlig', weight: 1, rank: 4 },
    boss: { label: 'Mystisk', weight: 0, rank: 5 },
    wildcard: { label: 'Joker', weight: 0, rank: 2 },
    monster: { label: 'Monster', weight: 0, rank: 6 },
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
  // types här är jokerns ELEMENT (se Typer-sektionen längre ner) om just den attacken är
  // aktiv — inte en nödvändig egenskap hos mekaniken i sig, bara vilket element som känns rätt
  // för just den här jokervarianten (t.ex. känns offer-sig-för-skada eldigt). Påverkar
  // skadeberäkningen i hurt(), precis som för vilken annan robot som helst.
  const WILDCARD_SPECIALS = [
    { type: 'copycat', name: 'Jokerkopia', dmg: 18, desc: 'Imiterar och använder motståndarens egen specialattack mot dem.', types: ['psykisk'] },
    { type: 'gamble', name: 'Turkast', dmg: 14, desc: 'Femtiofemtio: antingen dubbel skada, eller helt bom (men du blir kort snabbare och starkare).', types: ['normal'] },
    { type: 'swap', name: 'Ödesbyte', desc: 'Drar både dig och motståndaren mot samma liv mitt emellan — farligt om du leder, en räddning om du inte gör det.', types: ['spöke'] },
    { type: 'jinx', name: 'Förbannelse', desc: 'Tömmer motståndarens energi och halverar deras återhämtning en kort stund.', types: ['mörk'] },
    { type: 'allin', name: 'Jokersatsning', dmg: 15, desc: 'Offrar en del av ditt eget liv för en mycket hårdare smäll.', types: ['eld'] },
    { type: 'drawcard', name: 'Korthandel', heal: 20, desc: 'Drar ett slumpat kort: snabbare & starkare, en sköld, eller läkning.', types: ['fe'] },
    { type: 'steal', name: 'Jokerstöld', steal: 25, desc: 'Stjäl 25 energi från motståndaren åt dig själv.', types: ['mörk'] },
    { type: 'taunt', name: 'Hån', desc: 'Gör motståndaren sårbar: de tar 40 % mer skada i tre sekunder.', types: ['strid'] },
    { type: 'prophecy', name: 'Spådom', dmg: 26, desc: 'En försenad smäll där motståndaren står just nu — hinner de flytta sig missar den.', types: ['psykisk'] },
    { type: 'swapplace', name: 'Platsbyte', desc: 'Byter plats blixtsnabbt med motståndaren.', types: ['spöke'] },
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
      id: 'wildcard', name: '???', rarity: 'wildcard', types: WILDCARD_SPECIALS[0].types,
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
    // Gudomliga: den sällsyntaste nivån man kan få av en låda (1 %), över legendariska.
    // ---- Fler robotar: tre vanliga, tre sällsynta, tre episka och två legendariska ----
    {
      id: 'pip', name: 'Pip', rarity: 'common', types: ['normal'],
      color: '#ffcf5a', accent: '#8a5a12', eye: '#3a2a00', head: 'round', extra: 'antenna',
      scale: 0.9, hp: 90, speed: 260, punch: 7,
      special: { type: 'projectile', name: 'Pipskott', dmg: 16, desc: 'Ett litet men snabbt skott rakt fram.' },
    },
    {
      id: 'grus', name: 'Grus', rarity: 'common', types: ['sten'],
      color: '#9c8f80', accent: '#4a4038', eye: '#ffd93d', head: 'box', extra: 'shoulders',
      scale: 1.1, hp: 115, speed: 190, punch: 8,
      special: { type: 'shockwave', name: 'Grusvåg', dmg: 16, desc: 'Stötvågor av grus längs marken. Hoppa över dem!' },
    },
    {
      id: 'glod', name: 'Glöd', rarity: 'common', types: ['eld'],
      color: '#d9481c', accent: '#5a1a08', eye: '#ffe066', head: 'cyclops', extra: 'jet',
      scale: 1, hp: 95, speed: 240, punch: 7,
      special: { type: 'burst', name: 'Gnistregn', dmg: 6, desc: 'Tre snabba gnistor i rad.' },
    },
    {
      id: 'tornado', name: 'Tornado', rarity: 'rare', types: ['flygande', 'strid'],
      color: '#c8e6f0', accent: '#4a6a80', eye: '#1a3a5a', head: 'horn', extra: 'fins',
      scale: 1, hp: 100, speed: 275, punch: 8,
      special: { type: 'dash', name: 'Virvelstöt', dmg: 24, desc: 'Snurrar fram som en virvelvind och slår till.' },
    },
    {
      id: 'koral', name: 'Koral', rarity: 'rare', types: ['vatten', 'fe'],
      color: '#ff7f9f', accent: '#1f6f8a', eye: '#ffffff', head: 'dome', extra: 'spikes',
      scale: 1, hp: 110, speed: 215, punch: 8,
      special: { type: 'drain', name: 'Korallbett', dmg: 14, heal: 10, desc: 'Slag som lagar dig med 10 HP.' },
    },
    {
      id: 'gnista', name: 'Gnista', rarity: 'rare', types: ['elektrisk', 'kryp'],
      color: '#c6e03a', accent: '#3a4a10', eye: '#1a1a1a', head: 'box', extra: 'cannon',
      scale: 0.95, hp: 95, speed: 245, punch: 8,
      special: { type: 'mine', name: 'Elmina', dmg: 22, desc: 'Lägger en elektrisk mina som smäller när motståndaren kommer nära.' },
    },
    {
      id: 'fantom', name: 'Fantom', rarity: 'epic', types: ['spöke', 'psykisk'],
      color: '#e8e4ff', accent: '#5a4a9a', eye: '#7a5cff', head: 'hood', extra: 'cape',
      scale: 1, hp: 100, speed: 255, punch: 9,
      special: { type: 'beam', name: 'Själsstråle', dmg: 24, desc: 'En spöklik stråle långt fram. Hoppa högt!' },
    },
    {
      id: 'magma', name: 'Magma', rarity: 'epic', types: ['eld', 'sten'],
      color: '#3a2a26', accent: '#ff5a1a', eye: '#ffb347', head: 'horn', extra: 'shoulders',
      scale: 1.15, hp: 115, speed: 210, punch: 10,
      special: { type: 'meteorslam', name: 'Magmasmäll', dmg: 26, desc: 'Slår ner en smäll av glödande lava där motståndaren står.' },
    },
    {
      id: 'viper', name: 'Viper', rarity: 'epic', types: ['gift', 'kryp'],
      color: '#2fae5a', accent: '#0f3a1a', eye: '#ffe066', head: 'cyclops', extra: 'fins',
      scale: 0.95, hp: 95, speed: 270, punch: 9,
      special: { type: 'flurry', name: 'Ormbett', dmg: 7, desc: 'Fyra blixtsnabba bett i följd, det sista hårdast.' },
    },
    {
      id: 'aurora', name: 'Aurora', rarity: 'legendary', types: ['is', 'fe'],
      color: '#9ff0e0', accent: '#5a3aa8', eye: '#ffffff', head: 'crown', extra: 'shield',
      scale: 1.1, hp: 108, speed: 245, punch: 9,
      special: { type: 'orbital', name: 'Norrsken', dmg: 26, desc: 'Tre pelare av norrsken slår ner. Flytta dig i tid!' },
    },
    {
      id: 'ragnar', name: 'Ragnar', rarity: 'legendary', types: ['strid', 'stål'],
      color: '#8a6a4a', accent: '#c0c8d0', eye: '#ff3b1f', head: 'horn', extra: 'cape',
      scale: 1.15, hp: 118, speed: 235, punch: 10,
      special: { type: 'annihilate', name: 'Vikingaslag', dmg: 30, desc: 'Ett förödande yxslag med enorm knockback.' },
    },
    {
      id: 'seraph', name: 'Seraph', rarity: 'divine', types: ['fe', 'flygande'],
      color: '#fffbe8', accent: '#3ee8ff', eye: '#ffd93d', head: 'crown', extra: 'jet',
      scale: 1.15, hp: 130, speed: 265, punch: 10,
      passive: { type: 'doublejump', name: 'Änglavingar', desc: 'Kan hoppa en gång till mitt i luften.' },
      special: { type: 'halo', name: 'Gloria', dmg: 24, heal: 15, desc: 'En ljusring sprider sig längs golvet åt alla håll och läker Seraph med 15 HP. Hoppa över den!' },
    },
    {
      id: 'atlas', name: 'Atlas', rarity: 'divine', types: ['stål', 'strid'],
      color: '#3a4256', accent: '#3ee8ff', eye: '#ffffff', head: 'horn', extra: 'shoulders',
      scale: 1.25, hp: 145, speed: 228, punch: 12,
      passive: { type: 'steadfast', name: 'Orubblig', desc: 'Kan aldrig knuffas undan och tar 15 % mindre skada.' },
      special: { type: 'quake', name: 'Jordbävning', dmg: 13, desc: 'Tre skalv över hela banan. Står du på marken när det smäller tar du skada — hoppa i rätt ögonblick!' },
    },
    {
      id: 'eclipse', name: 'Eclipse', rarity: 'divine', types: ['mörk', 'psykisk'],
      color: '#120d24', accent: '#3ee8ff', eye: '#ff5fd2', head: 'hood', extra: 'cape',
      scale: 1.1, hp: 125, speed: 272, punch: 10,
      passive: { type: 'shadow', name: 'Skuggform', desc: 'Var åttonde sekund glider nästa träff rakt igenom den.' },
      special: { type: 'blackhole', name: 'Svart hål', dmg: 6, blast: 22, desc: 'Ett svart hål suger in motståndaren och skadar hela tiden, och imploderar sedan. Spring därifrån!' },
    },
    {
      id: 'kronos', name: 'Kronos', rarity: 'divine', types: ['psykisk', 'stål'],
      color: '#c9a85a', accent: '#3ee8ff', eye: '#ffffff', head: 'dome', extra: 'cape',
      scale: 1.15, hp: 128, speed: 252, punch: 10,
      passive: { type: 'rewind', name: 'Återspolning', desc: 'En gång per match, när HP blir lågt (eller en träff skulle slå ut den), spolas tiden tillbaka och HP blir som för fyra sekunder sedan.' },
      special: { type: 'timestop', name: 'Tidsstopp', dmg: 8, desc: 'Ett jättelikt urverk under motståndaren: där inne går tiden i en tredjedels fart och varje tick gör ont. Ta dig ut ur cirkeln!' },
    },
    {
      id: 'solaris', name: 'Solaris', rarity: 'divine', types: ['eld', 'fe'],
      color: '#ff8a2a', accent: '#3ee8ff', eye: '#fff3b0', head: 'round', extra: 'jet',
      scale: 1.1, hp: 122, speed: 277, punch: 11,
      passive: { type: 'solar', name: 'Solkraft', desc: 'Energin laddas dubbelt så snabbt.' },
      special: { type: 'meteor', name: 'Meteorregn', dmg: 9, desc: 'Sju meteorer faller en i taget där motståndaren står. En röd ring visar var de slår ner — fortsätt röra på dig!' },
    },
    {
      id: 'leviatan', name: 'Leviatan', rarity: 'divine', types: ['vatten', 'mörk'],
      color: '#1f6fb2', accent: '#3ee8ff', eye: '#7ff9ff', head: 'horn', extra: 'fins',
      scale: 1.25, hp: 140, speed: 238, punch: 11,
      passive: { type: 'tidal', name: 'Havets kraft', desc: 'Läker 1,5 HP varje sekund under hela matchen.' },
      special: { type: 'tide', name: 'Tidvatten', dmg: 17, desc: 'Två vattenväggar sköljer över hela banan med bara en lucka var. Gå in i luckan i djupled — hoppa över går inte!' },
    },
    {
      id: 'fenrir', name: 'Fenrir', rarity: 'divine', types: ['mörk', 'is'],
      color: '#2b3550', accent: '#3ee8ff', eye: '#9fe8ff', head: 'horn', extra: 'spikes',
      scale: 1.2, hp: 135, speed: 270, punch: 11,
      special: { type: 'wolves', name: 'Vargflock', dmg: 12, desc: 'Tre spökvargar jagar motståndaren genom hela banan och smäller när de når fram. Spring och hoppa!' },
      passive: { type: 'bloodrage', name: 'Vargblod', desc: 'Under halva HP slår Fenrir 50 % hårdare och springer 20 % fortare.' },
    },
    {
      id: 'gaia', name: 'Gaia', rarity: 'divine', types: ['gräs', 'mark'],
      color: '#4f8a3a', accent: '#3ee8ff', eye: '#ffe066', head: 'dome', extra: 'none',
      scale: 1.15, hp: 140, speed: 235, punch: 10,
      special: { type: 'roots', name: 'Rotfäste', dmg: 16, desc: 'Rötter rusar fram längs motståndarens fil och håller fast den. Kliv ur filen i djupled!' },
      passive: { type: 'rooted', name: 'Rotad', desc: 'Står Gaia still en sekund slår hon rot och tar 40 % mindre skada.' },
    },
    {
      id: 'valkyria', name: 'Valkyria', rarity: 'divine', types: ['strid', 'flygande'],
      color: '#d9dde6', accent: '#3ee8ff', eye: '#ffd93d', head: 'crown', extra: 'cape',
      scale: 1.15, hp: 128, speed: 275, punch: 11,
      special: { type: 'tether', name: 'Gudakedja', dmg: 7, desc: 'En gyllene kedja binder motståndaren i tre sekunder. Är den för långt bort dras den in och tar skada — gå nära!' },
      passive: { type: 'execute', name: 'Själsfångst', desc: 'Mot en motståndare under 30 % HP gör Valkyria 50 % mer skada.' },
    },
    // Monstervärlden: en helt egen sorts motståndare, skild från robotarna — går aldrig att få
    // av en låda eller möta i en vanlig match (precis som bossar), men går heller aldrig in i
    // samlingen om man vinner. Vinner man får man ALLTID ett bestämt utrustningsföremål (drop
    // nedan) — alltså vet man i förväg exakt vad man får, ingen slump där. Dessutom finns
    // alltid en chans (SUPER_PIECE_CHANCE) att ÄVEN hitta en del av ett supervapen, oavsett
    // vilket monster man besegrar — se EQUIPMENT/SUPER_WEAPONS längre ner. Utmanas från en egen
    // meny, se Monstervärlden i game.js.
    {
      id: 'gnasher', name: 'Gnasher', rarity: 'monster', monster: true, types: ['gift', 'kryp'], drop: 'servoarms',
      color: '#6b8e3a', accent: '#2a3a12', eye: '#ff3030', head: 'cyclops', extra: 'spikes',
      scale: 1.1, hp: 120, speed: 200, punch: 9,
      special: { type: 'poison', name: 'Giftbett', dmg: 14, desc: 'Släpper ett moln som skadar över tid.' },
    },
    {
      id: 'skuggvarg', name: 'Skuggvarg', rarity: 'monster', monster: true, types: ['mörk'], drop: 'turbofeet',
      color: '#2a2436', accent: '#120f1a', eye: '#b388ff', head: 'horn', extra: 'none',
      scale: 1.05, hp: 110, speed: 260, punch: 10,
      special: { type: 'flurry', name: 'Rivklor', dmg: 8, desc: 'Fyra snabba rivningar i följd, den sista hårdast.' },
    },
    {
      id: 'stenkoloss', name: 'Stenkoloss', rarity: 'monster', monster: true, types: ['sten', 'mark'], drop: 'steelshield',
      color: '#8a7a68', accent: '#3a3228', eye: '#ffb347', head: 'dome', extra: 'shoulders',
      scale: 1.3, hp: 160, speed: 130, punch: 12,
      special: { type: 'smash', name: 'Stenknytnäve', dmg: 24, desc: 'Ett tungt slag med lång räckvidd.' },
    },
    {
      id: 'frostspindel', name: 'Frostspindel', rarity: 'monster', monster: true, types: ['is', 'kryp'], drop: 'fangblade',
      color: '#aee8ff', accent: '#2a5a6a', eye: '#ffffff', head: 'cyclops', extra: 'spikes',
      scale: 0.95, hp: 100, speed: 230, punch: 8,
      special: { type: 'freeze', name: 'Frostbett', dmg: 12, desc: 'Fryser motståndaren i 1,1 sekunder.' },
    },
    {
      id: 'sumpdrake', name: 'Sumpdrake', rarity: 'monster', monster: true, types: ['gift', 'vatten'], drop: 'drakfjallet',
      color: '#4a7a5a', accent: '#1a3a28', eye: '#c8ff6b', head: 'horn', extra: 'fins',
      scale: 1.15, hp: 130, speed: 190, punch: 9,
      special: { type: 'poison', name: 'Giftmoln', dmg: 12, desc: 'Släpper ett moln som skadar över tid.' },
    },
    {
      id: 'nattuggla', name: 'Nattuggla', rarity: 'monster', monster: true, types: ['mörk', 'flygande'], drop: 'uggleogat',
      color: '#3a3450', accent: '#15121f', eye: '#ffd93d', head: 'round', extra: 'jet',
      scale: 0.9, hp: 95, speed: 270, punch: 7,
      special: { type: 'snipe', name: 'Nattprick', dmg: 40, desc: 'Siktar med laser, sedan träffar den hårt.' },
    },
    {
      id: 'lavagolem', name: 'Lavagolem', rarity: 'monster', monster: true, types: ['eld', 'sten'], drop: 'lavahjartat',
      color: '#c23a1f', accent: '#4a1206', eye: '#ffd93d', head: 'dome', extra: 'shoulders',
      scale: 1.25, hp: 145, speed: 120, punch: 11,
      special: { type: 'annihilate', name: 'Lavakross', dmg: 28, desc: 'Ett förödande slag med enorm knockback.' },
    },
    {
      id: 'stormfenix', name: 'Stormfenix', rarity: 'monster', monster: true, types: ['eld', 'flygande'], drop: 'lightrig',
      color: '#ff8a3d', accent: '#5a2a08', eye: '#fff36b', head: 'crown', extra: 'jet',
      scale: 1, hp: 105, speed: 250, punch: 8,
      special: { type: 'orbital', name: 'Eldregn', dmg: 20, desc: 'Tre eldpelare slår ner. Flytta dig i tid!' },
    },
    {
      id: 'kristallkrabba', name: 'Kristallkrabba', rarity: 'monster', monster: true, types: ['is', 'stål'], drop: 'platearmor',
      color: '#b8e0ff', accent: '#3a5a7a', eye: '#ffffff', head: 'dome', extra: 'shield',
      scale: 1.1, hp: 135, speed: 150, punch: 9,
      special: { type: 'counter', name: 'Kristallskal', dmg: 18, desc: 'Blir osårbar kort och slår tillbaka om motståndaren är nära.' },
    },
    {
      id: 'mygghärva', name: 'Mygghärva', rarity: 'monster', monster: true, types: ['kryp', 'gift'], drop: 'myggvingarna',
      color: '#8acc3a', accent: '#2a4a0a', eye: '#ff3030', head: 'cyclops', extra: 'fins',
      scale: 0.85, hp: 85, speed: 280, punch: 6,
      special: { type: 'spread', name: 'Svärmanfall', dmg: 7, desc: 'Tre skott i solfjäder.' },
    },
    {
      id: 'djupvakt', name: 'Djupvakt', rarity: 'monster', monster: true, types: ['vatten', 'spöke'], drop: 'djuphjalmen',
      color: '#2a5a7a', accent: '#0f2a3a', eye: '#7fffd4', head: 'hood', extra: 'fins',
      scale: 1.15, hp: 125, speed: 170, punch: 9,
      special: { type: 'grapple', name: 'Djupkrok', dmg: 16, desc: 'En krok som drar in motståndaren och slår till.' },
    },
    {
      id: 'taggormen', name: 'Taggormen', rarity: 'monster', monster: true, types: ['gift', 'mark'], drop: 'taggpansaret',
      color: '#7a3a8a', accent: '#2a0f3a', eye: '#c8ff6b', head: 'horn', extra: 'spikes',
      scale: 1.05, hp: 115, speed: 210, punch: 10,
      special: { type: 'meteorslam', name: 'Taggregn', dmg: 24, desc: 'Slår ner en jättesmäll där motståndaren står.' },
    },
    // ---- Monstervärldens kungar och drottning ----
    // Man möter dem alltid fem mot en: du och fyra AI-robotar (se makeAllies i game.js).
    // Långt, långt svårare än de vanliga monstren: enormt mycket HP, hårda slag, dubbelt så
    // starka specialattacker, den skarpaste AI:n och en ilska som växer ju längre striden pågår
    // (se ROYAL_TIER i game.js). De ger var sitt eget kungligt föremål och alltid en
    // supervapendel.
    {
      id: 'drakkungen', name: 'Drakkungen', rarity: 'monster', monster: true, royal: 'king', types: ['eld', 'flygande'], drop: 'drakkronan',
      color: '#b3261e', accent: '#ffd93d', eye: '#ffb347', head: 'crown', extra: 'cape',
      scale: 1.8, hp: 1150, speed: 230, punch: 14,
      special: { type: 'annihilate', name: 'Kungseld', dmg: 34, desc: 'Ett förödande eldslag med enorm knockback.' },
    },
    {
      id: 'frostkungen', name: 'Frostkungen', rarity: 'monster', monster: true, royal: 'king', types: ['is', 'vatten'], drop: 'frostmanteln',
      color: '#bfe8ff', accent: '#ffd93d', eye: '#3ee8ff', head: 'crown', extra: 'spikes',
      scale: 1.75, hp: 1200, speed: 240, punch: 13,
      special: { type: 'freeze', name: 'Evig is', dmg: 18, desc: 'Fryser motståndaren och slår hårt.' },
    },
    {
      id: 'stenkungen', name: 'Stenkungen', rarity: 'monster', monster: true, royal: 'king', types: ['sten', 'mark'], drop: 'stenhandskarna',
      color: '#7a6a58', accent: '#ffd93d', eye: '#ff7a1a', head: 'crown', extra: 'shoulders',
      scale: 1.9, hp: 1200, speed: 190, punch: 12,
      special: { type: 'smash', name: 'Bergsnäve', dmg: 26, desc: 'Ett gigantiskt slag med lång räckvidd.' },
    },
    {
      id: 'skuggdrottningen', name: 'Skuggdrottningen', rarity: 'monster', monster: true, royal: 'queen', types: ['mörk', 'psykisk'], drop: 'drottningdiademet',
      color: '#2a0f3a', accent: '#ffd93d', eye: '#ff5fd2', head: 'crown', extra: 'cape',
      scale: 1.85, hp: 1400, speed: 260, punch: 13,
      special: { type: 'orbital', name: 'Drottningens dom', dmg: 24, desc: 'Tre skuggpelare slår ner. Flytta dig i tid!' },
    },
  ];

  // ---------- Utrustning ----------
  // Vinner man en monsterstrid får man ALLTID det föremål som just det monstret är satt att ge
  // (def.drop, se ROBOTS ovan) — ingen slump i VILKET föremål, så man vet i förväg exakt vad
  // man ska få. Man kan bära ETT i taget (equipItem), och det ger en permanent bonus på en
  // eller flera av robotens grundsiffror så länge det bärs, oavsett vilken robot man spelar
  // med eller vilken typ av match det är.
  const EQUIPMENT = [
    { id: 'steelshield', name: 'Stålsköld', stat: { hp: 25 }, desc: '+25 HP så länge den bärs.' },
    { id: 'platearmor', name: 'Pansarplatta', stat: { hp: 12 }, desc: '+12 HP så länge den bärs.' },
    { id: 'servoarms', name: 'Servoarmar', stat: { punch: 4 }, desc: '+4 i slagstyrka så länge de bärs.' },
    { id: 'fangblade', name: 'Vasständer', stat: { punch: 2 }, desc: '+2 i slagstyrka så länge de bärs.' },
    { id: 'turbofeet', name: 'Turbofötter', stat: { speed: 35 }, desc: '+35 i fart så länge de bärs.' },
    { id: 'lightrig', name: 'Fjäderdon', stat: { speed: 18 }, desc: '+18 i fart så länge de bärs.' },
    // Ett eget föremål för varje vanligt monster.
    { id: 'drakfjallet', name: 'Drakfjället', stat: { hp: 18, punch: 1 }, desc: '+18 HP och +1 i slagstyrka. Från Sumpdraken.' },
    { id: 'uggleogat', name: 'Uggleögat', stat: { punch: 2, speed: 20 }, desc: '+2 i slagstyrka och +20 i fart. Från Nattugglan.' },
    { id: 'lavahjartat', name: 'Lavahjärtat', stat: { hp: 10, punch: 3 }, desc: '+10 HP och +3 i slagstyrka. Från Lavagolemen.' },
    { id: 'taggpansaret', name: 'Taggpansaret', stat: { hp: 20, punch: 2 }, desc: '+20 HP och +2 i slagstyrka. Från Taggormen.' },
    { id: 'myggvingarna', name: 'Myggvingarna', stat: { speed: 28 }, desc: '+28 i fart. Från Mygghärvan.' },
    { id: 'djuphjalmen', name: 'Djuphjälmen', stat: { hp: 30 }, desc: '+30 HP. Från Djupvakten.' },
    // Butiksvaror: går BARA att köpa för mynt i Butiken, aldrig att vinna i en strid.
    // Några av dem har en egen effekt (effect) som inget stridsföremål har.
    { id: 'raketskorna', name: 'Raketskorna', shop: 300, stat: { speed: 50 }, desc: '+50 i fart.' },
    { id: 'titanplattan', name: 'Titanplattan', shop: 400, stat: { hp: 45 }, desc: '+45 HP.' },
    { id: 'plasmanavarna', name: 'Plasmanävarna', shop: 450, stat: { punch: 8 }, desc: '+8 i slagstyrka.' },
    { id: 'energikarnan', name: 'Energikärnan', shop: 500, stat: {}, effect: { startEnergy: 100 }, desc: 'Du börjar varje match med full energi — specialattacken direkt!' },
    { id: 'vampyrtanden', name: 'Vampyrtanden', shop: 550, stat: {}, effect: { lifesteal: 0.4 }, desc: 'Dina vanliga slag läker dig med 40 % av skadan de gör.' },
    { id: 'balansringen', name: 'Balansringen', shop: 650, stat: { hp: 20, punch: 4, speed: 20 }, desc: '+20 HP, +4 i slagstyrka och +20 i fart.' },
    { id: 'fjaderskorna', name: 'Fjäderskorna', shop: 250, stat: {}, effect: { jumpMul: 1.3 }, desc: 'Du hoppar 30 % högre.' },
    { id: 'magnetstovlarna', name: 'Magnetstövlarna', shop: 350, stat: { hp: 5 }, effect: { noKnock: true }, desc: 'Ingenting kan knuffa dig bakåt. +5 HP.' },
    { id: 'skoldgeneratorn', name: 'Sköldgeneratorn', shop: 450, stat: {}, effect: { startShield: 3 }, desc: 'Du är osårbar de första 3 sekunderna av varje match.' },
    { id: 'snabbchippet', name: 'Snabbchippet', shop: 500, stat: { punch: 3, speed: 35 }, desc: '+3 i slagstyrka och +35 i fart.' },
    { id: 'taggrustningen', name: 'Taggrustningen', shop: 600, stat: { hp: 10 }, effect: { thorns: 0.35 }, desc: 'Den som slår dig tar själv 35 % av skadan tillbaka. +10 HP.' },
    { id: 'turbomotorn', name: 'Turbomotorn', shop: 700, stat: {}, effect: { specialCost: 35 }, desc: 'Specialattacken kostar bara 35 energi i stället för 50.' },
    { id: 'turchippet', name: 'Turchippet', shop: 750, stat: {}, effect: { crit: 0.2 }, desc: 'Vart femte vanligt slag (ungefär) blir en kritisk träff med tre gånger så mycket skada.' },
    { id: 'livsbatteriet', name: 'Livsbatteriet', shop: 800, stat: { hp: 60 }, desc: '+60 HP.' },
    { id: 'guldrustningen', name: 'Guldrustningen', shop: 1200, stat: { hp: 40, punch: 6, speed: 25 }, desc: '+40 HP, +6 i slagstyrka och +25 i fart. Butikens finaste vara.' },
    // Kungligt: bara från Monstervärldens kungar och drottning.
    { id: 'drakkronan', name: 'Drakkronan', royal: true, stat: { hp: 25, punch: 6 }, desc: '+25 HP och +6 i slagstyrka. Från Drakkungen.' },
    { id: 'frostmanteln', name: 'Frostmanteln', royal: true, stat: { hp: 45 }, desc: '+45 HP. Från Frostkungen.' },
    { id: 'stenhandskarna', name: 'Stenhandskarna', royal: true, stat: { punch: 9 }, desc: '+9 i slagstyrka. Från Stenkungen.' },
    { id: 'drottningdiademet', name: 'Drottningens diadem', royal: true, stat: { hp: 30, punch: 6, speed: 30 }, desc: '+30 HP, +6 i slagstyrka och +30 i fart. Från Skuggdrottningen.' },
    // Supervapen går aldrig att få direkt — bara genom att sätta ihop `pieces` delar, som kan
    // droppa (utöver det bestämda föremålet) efter en monstervinst, oavsett vilket monster (se
    // SUPER_PIECE_CHANCE och finishMatch()). Varje supervapen har en EGEN superkraft (`power`)
    // som inget annat vapen har, och som man använder en gång per match (Q eller I).
    {
      id: 'megavapen', name: 'Megavapnet', pieces: 5, stat: { hp: 20, punch: 6, speed: 15 },
      power: { type: 'megabeam', name: 'Megastråle', desc: 'En jättelik stråle tvärs över hela banan i din fil — 28 skada. Kliv undan i djupled!' },
      desc: '+20 HP, +6 i slagstyrka och +15 i fart.',
    },
    {
      id: 'askhammaren', name: 'Åskhammaren', pieces: 3, stat: { punch: 4 },
      power: { type: 'thunder', name: 'Blixtnedslag', desc: 'Fem blixtar slår ner på motståndaren, var den än står — 6 skada var.' },
      desc: '+4 i slagstyrka.',
    },
    {
      id: 'drakhjartat', name: 'Drakhjärtat', pieces: 3, stat: { hp: 10 },
      power: { type: 'dragon', name: 'Drakvrede', desc: 'I sex sekunder brinner du: dubbel skada på vanliga slag, och ingenting kan knuffa dig.' },
      desc: '+10 HP.',
    },
    {
      id: 'spegelskolden', name: 'Spegelskölden', pieces: 3, stat: { hp: 15 },
      power: { type: 'mirror', name: 'Spegelvärn', desc: 'I fem sekunder studsar all skada du tar tillbaka på motståndaren.' },
      desc: '+15 HP.',
    },
    {
      id: 'livskristallen', name: 'Livskristallen', pieces: 3, stat: { hp: 20 },
      power: { type: 'revive', name: 'Livsljus', desc: 'Läker hälften av ditt HP på en gång.' },
      desc: '+20 HP.',
    },
    {
      id: 'gravitronen', name: 'Gravitronen', pieces: 3, stat: { speed: 20 },
      power: { type: 'gravity', name: 'Antigravitation', desc: 'Motståndaren svävar hjälplöst upp i luften i två sekunder och kraschar sedan i marken — 16 skada.' },
      desc: '+20 i fart.',
    },
  ];
  const EQUIPMENT_IDS = new Set(EQUIPMENT.map((e) => e.id));
  const SUPER_WEAPONS = EQUIPMENT.filter((e) => e.power);
  const SUPER_PIECE_CHANCE = 0.25; // 25 % chans per monstervinst att hitta en del, oavsett vilket monster
  const SHOP_ITEMS = EQUIPMENT.filter((e) => e.shop);

  // ---------- Mynt ----------
  // Tjänas i matcher (se finishMatch) och på den dagliga lådan, och används bara i Butiken.
  const COINS = { win: 10, loss: 2, stakeWin: 20, bossWin: 30, monsterWin: 15, royalWin: 100, daily: 20 };
  const MAX_COINS = 10000000;
  const addCoins = (acct, n) => { acct.coins = Math.min(MAX_COINS, (acct.coins || 0) + n); return n; };

  // ---------- Uppdrag ----------
  // Fyra uppdrag åt gången, och de tar aldrig slut: så fort ett blir klart kommer ett nytt i
  // dess ställe. Ju fler man klarat, desto högre uppdragsnivå — större mål men mer mynt.
  // Var tredje klarat uppdrag ger en bonuslåda. Framstegen räknas i finishMatch()/openBox() —
  // aldrig av klienten själv — och mynten delas ut så fort ett uppdrag är klart.
  // name(n, param) ger texten, där n är målet och param typen/sällsyntheten (om uppdraget har en).
  const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`);
  const QUEST_POOL = [
    { id: 'win', on: 'win', goal: 3, step: 1, coins: 40, name: (n) => `Vinn ${plural(n, 'en match', 'matcher')}` },
    { id: 'play', on: 'play', goal: 5, step: 2, coins: 30, name: (n) => `Spela ${plural(n, 'en match', 'matcher')}` },
    { id: 'streak', on: 'streak', goal: 2, step: 1, coins: 60, name: (n) => `Vinn ${n} matcher i rad` },
    { id: 'monster', on: 'monster', goal: 2, step: 1, coins: 50, name: (n) => `Besegra ${plural(n, 'ett monster', 'monster')}` },
    { id: 'boss', on: 'boss', goal: 1, step: 1, coins: 60, name: (n) => `Besegra ${plural(n, 'en mystisk robot', 'mystiska robotar')}` },
    { id: 'stake', on: 'stake', goal: 1, step: 1, coins: 50, name: (n) => `Vinn ${plural(n, 'en insatsmatch', 'insatsmatcher')}` },
    { id: 'royal', on: 'royal', goal: 1, step: 0, coins: 150, name: () => 'Besegra en kung eller drottningen' },
    { id: 'box', on: 'box', goal: 2, step: 1, coins: 30, name: (n) => `Öppna ${plural(n, 'en låda', 'lådor')}` },
    { id: 'type', on: 'typewin', goal: 2, step: 1, coins: 50, param: 'type', name: (n, p) => `Vinn ${plural(n, 'en match', 'matcher')} med en ${TYPES[p].label}-robot` },
    { id: 'rarity', on: 'raritywin', goal: 2, step: 1, coins: 50, param: 'rarity', name: (n, p) => `Vinn ${plural(n, 'en match', 'matcher')} med en ${RARITY[p].label.toLowerCase()} robot` },
    { id: 'divine', on: 'divinewin', goal: 1, step: 1, coins: 60, name: (n) => `Vinn ${plural(n, 'en match', 'matcher')} med en gudomlig robot` },
    { id: 'street', on: 'street', goal: 1, step: 1, coins: 50, name: (n) => `Vinn ${plural(n, 'en robot', 'robotar')} som går omkring i staden` },
    { id: 'elite', on: 'elite', goal: 1, step: 0, coins: 200, name: () => 'Besegra en elitrobot i staden' }, // bara från nivå ELITE_LEVEL
    { id: 'elite3', on: 'elite', goal: 3, step: 1, coins: 400, name: (n) => `Besegra ${n} elitrobotar i staden` }, // bara från nivå CHAMPION_LEVEL
    { id: 'champion', on: 'champion', goal: 1, step: 0, coins: 600, name: () => 'Besegra stadens mästare' }, // bara från nivå CHAMPION_LEVEL
    { id: 'tower', on: 'tower', goal: 2, step: 1, coins: 120, name: (n) => `Klättra ${n} våningar i Utmaningstornet` }, // bara från nivå TOWER_LEVEL
  ];
  const questById = Object.fromEntries(QUEST_POOL.map((q) => [q.id, q]));
  const QUEST_SLOTS = 4;
  const QUEST_BONUS_EVERY = 3;
  const QUESTS_PER_LEVEL = 5;
  const QUEST_MAX_LEVEL = 6;
  // Minst två av de här ligger alltid på tavlan, så att det alltid finns något som går att klara.
  const EASY_QUESTS = ['win', 'play', 'streak', 'box', 'monster'];
  const MIN_EASY = 2;
  // Ett uppdrag som inte gått framåt på så här många matcher byts mot ett nytt.
  const QUEST_STALE = 8;
  const QUEST_RARITIES = ['common', 'rare', 'epic', 'legendary']; // gudomliga har ett eget uppdrag

  const questLevel = (done) => Math.min(QUEST_MAX_LEVEL, Math.floor(done / QUESTS_PER_LEVEL));

  // Nästa uppdrag i kedjan: bestäms av löpnumret seq, men hoppar över sådana som redan ligger
  // på tavlan och sådana man inte kan klara med sina robotar (typen och sällsyntheten väljs
  // bland robotarna man har). Mål och belöning låses när uppdraget dyker upp.
  function nextQuest(acct, st) {
    const owned = Object.keys(acct.inv || {}).filter((id) => acct.inv[id] > 0).map((id) => robotById[id]).filter(Boolean);
    const types = [...new Set(owned.flatMap((r) => r.types))];
    const rarities = QUEST_RARITIES.filter((r) => owned.some((o) => o.rarity === r));
    const taken = new Set(st.active.map((q) => q.id));
    const needEasy = st.active.filter((q) => EASY_QUESTS.includes(q.id)).length < MIN_EASY;
    for (;;) {
      st.seq += 1;
      let h = hashName(`uppdrag-${st.seq}`);
      const next = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = (h ^ (h >>> 13)) >>> 0; return h; };
      const base = QUEST_POOL[next() % QUEST_POOL.length];
      if (taken.has(base.id) || (needEasy && !EASY_QUESTS.includes(base.id))) continue;
      if ((base.param === 'type' && !types.length) || (base.param === 'rarity' && !rarities.length)) continue;
      if (base.id === 'divine' && !owned.some((o) => o.rarity === 'divine')) continue;
      if (base.id === 'elite' && !(acct.level >= ELITE_LEVEL)) continue;
      if ((base.id === 'elite3' || base.id === 'champion') && !(acct.level >= CHAMPION_LEVEL)) continue;
      if (base.id === 'tower' && !(acct.level >= TOWER_LEVEL && (acct.tower || 1) <= TOWER_TOP)) continue;
      const level = questLevel(st.done);
      const q = { id: base.id, goal: base.goal + base.step * level, coins: Math.round(base.coins * (1 + 0.25 * level)), prog: 0, idle: 0 };
      if (base.param === 'type') q.param = types[next() % types.length];
      if (base.param === 'rarity') q.param = rarities[next() % rarities.length];
      return q;
    }
  }

  function questState(acct) {
    // Servern läser konton direkt ur databasen, utan sanitize(), så gamla konton kan fortfarande
    // ha de dagliga uppdragen ({ day, prog, ... }) — de får en ny tavla.
    if (!acct.quests || !Array.isArray(acct.quests.active)) acct.quests = { seq: 0, done: 0, streak: 0, active: [] };
    const st = acct.quests;
    while (st.active.length < QUEST_SLOTS) st.active.push(nextQuest(acct, st));
    return st;
  }

  const questName = (q) => questById[q.id].name(q.goal, q.param);

  // events: vad som hände, t.ex. ['play', 'win', 'monster']. robotDef: roboten man spelade med
  // (för typ- och sällsynthetsuppdragen).
  function questEvent(acct, events, robotDef) {
    const out = { completed: [], added: [], bonus: 0 };
    const st = questState(acct);
    const played = events.includes('play');
    if (played) st.streak = events.includes('win') ? st.streak + 1 : 0;
    st.active = st.active.filter((q) => {
      const base = questById[q.id];
      const before = q.prog;
      if (base.on === 'streak') {
        q.prog = Math.min(q.goal, Math.max(q.prog, st.streak));
      } else if (events.includes(base.on)
        && !(base.param === 'type' && !(robotDef && robotDef.types.includes(q.param)))
        && !(base.param === 'rarity' && !(robotDef && robotDef.rarity === q.param))) {
        q.prog += 1;
      }
      if (q.prog > before) q.idle = 0;
      else if (played) q.idle += 1;
      if (q.idle >= QUEST_STALE) return false;
      if (q.prog < q.goal) return true;
      addCoins(acct, q.coins);
      out.completed.push({ name: questName(q), coins: q.coins });
      st.done += 1;
      if (st.done % QUEST_BONUS_EVERY === 0) {
        acct.boxes += 1;
        out.bonus += 1;
      }
      return false;
    });
    while (st.active.length < QUEST_SLOTS) {
      const q = nextQuest(acct, st);
      st.active.push(q);
      out.added.push(questName(q));
    }
    return out;
  }

  function questView(acct) {
    const st = questState(acct);
    return {
      list: st.active.map((q) => ({ id: q.id, name: questName(q), goal: q.goal, coins: q.coins, prog: q.prog, staleIn: QUEST_STALE - q.idle })),
      done: st.done,
      level: questLevel(st.done) + 1,
      toBonus: QUEST_BONUS_EVERY - (st.done % QUEST_BONUS_EVERY),
      streak: st.streak,
    };
  }

  // ---------- Vecko- och månadsuppdrag ----------
  // Större mål med större belöningar. Samma för alla under veckan (måndag–söndag) respektive
  // månaden. Klarar man alla får man flera bonuslådor.
  const PERIOD_QUESTS = {
    week: {
      label: 'Veckans', count: 3, bonusBoxes: 3,
      pool: [
        { id: 'w_win15', name: 'Vinn 15 matcher', goal: 15, coins: 150, on: 'win' },
        { id: 'w_play25', name: 'Spela 25 matcher', goal: 25, coins: 120, on: 'play' },
        { id: 'w_monster10', name: 'Besegra 10 monster', goal: 10, coins: 200, on: 'monster' },
        { id: 'w_boss3', name: 'Besegra 3 mystiska robotar', goal: 3, coins: 200, on: 'boss' },
        { id: 'w_royal2', name: 'Besegra 2 kungar eller drottningen', goal: 2, coins: 300, on: 'royal' },
        { id: 'w_box10', name: 'Öppna 10 lådor', goal: 10, coins: 150, on: 'box' },
        { id: 'w_divine5', name: 'Vinn 5 matcher med en gudomlig robot', goal: 5, coins: 250, on: 'divinewin' },
      ],
    },
    month: {
      label: 'Månadens', count: 2, bonusBoxes: 6,
      pool: [
        { id: 'm_win60', name: 'Vinn 60 matcher', goal: 60, coins: 700, on: 'win' },
        { id: 'm_monster40', name: 'Besegra 40 monster', goal: 40, coins: 800, on: 'monster' },
        { id: 'm_royal8', name: 'Besegra 8 kungar eller drottningen', goal: 8, coins: 1000, on: 'royal' },
        { id: 'm_boss10', name: 'Besegra 10 mystiska robotar', goal: 10, coins: 800, on: 'boss' },
        { id: 'm_box30', name: 'Öppna 30 lådor', goal: 30, coins: 600, on: 'box' },
      ],
    },
  };
  const PERIOD_IDS = new Set(Object.values(PERIOD_QUESTS).flatMap((p) => p.pool.map((q) => q.id)));

  // ISO-vecka, t.ex. "2026-v44".
  function weekKey(today) {
    const [y, m, d] = today.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3); // torsdagen samma vecka
    const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
    return `${t.getUTCFullYear()}-v${week}`;
  }
  const periodKey = (period, today) => (period === 'week' ? weekKey(today) : today.slice(0, 7));

  function periodQuestsFor(period, key) {
    const cfg = PERIOD_QUESTS[period];
    let h = hashName(`${period}-${key}`);
    const next = () => { h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = (h ^ (h >>> 13)) >>> 0; return h; };
    const pool = [...cfg.pool];
    const picked = [];
    while (picked.length < cfg.count && pool.length) picked.push(pool.splice(next() % pool.length, 1)[0]);
    return picked;
  }

  const periodField = (period) => (period === 'week' ? 'wquests' : 'mquests');

  function periodEvent(acct, today, period, events) {
    const out = { completed: [], bonusBoxes: 0 };
    const key = periodKey(period, today);
    const field = periodField(period);
    if (!acct[field] || acct[field].key !== key) acct[field] = { key, prog: {}, done: [], bonus: false };
    const st = acct[field];
    const cfg = PERIOD_QUESTS[period];
    for (const q of periodQuestsFor(period, key)) {
      if (st.done.includes(q.id) || !events.includes(q.on)) continue;
      st.prog[q.id] = (st.prog[q.id] || 0) + 1;
      if (st.prog[q.id] >= q.goal) {
        st.done.push(q.id);
        addCoins(acct, q.coins);
        out.completed.push({ name: `${cfg.label}: ${q.name}`, coins: q.coins });
      }
    }
    if (!st.bonus && st.done.length >= cfg.count) {
      st.bonus = true;
      acct.boxes += cfg.bonusBoxes;
      out.bonusBoxes = cfg.bonusBoxes;
    }
    return out;
  }

  function periodView(acct, today, period) {
    const key = periodKey(period, today);
    const field = periodField(period);
    const st = acct[field] && acct[field].key === key ? acct[field] : { prog: {}, done: [], bonus: false };
    return {
      label: PERIOD_QUESTS[period].label,
      bonusBoxes: PERIOD_QUESTS[period].bonusBoxes,
      list: periodQuestsFor(period, key).map((q) => ({ id: q.id, name: q.name, goal: q.goal, coins: q.coins, prog: Math.min(q.goal, st.prog[q.id] || 0), done: st.done.includes(q.id) })),
      bonus: !!st.bonus,
    };
  }

  // ---------- Daglig streak ----------
  // Varje dag i rad man hämtar den dagliga lådan växer streaken. Mer mynt ju längre den är,
  // och extra belöningar vid 7, 30, 100 och 365 dagar (en hel årsstreak ger ett eget skin).
  const STREAK_MILESTONES = {
    7: { boxes: 1, coins: 100 },
    30: { boxes: 3, coins: 300 },
    100: { boxes: 5, coins: 1000 },
    365: { boxes: 10, coins: 3000, skin: 'arsguld' },
  };
  function prevDay(today) {
    const [y, m, d] = today.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
  }

  // ---------- Robotnivåer ----------
  // Dubbletter uppgraderar en robot: från nivå N till N+1 kostar N dubbletter (en kopia blir
  // alltid kvar). Varje nivå ger +6 % HP och slag och +3 % fart.
  const ROBOT_MAX_LV = 5;
  const upgradeCost = (lv) => lv;
  const robotLevel = (acct, id) => (acct.robotLv && acct.robotLv[id]) || 1;
  function levelUpDef(def, lv) {
    if (!(lv > 1)) return def;
    const k = lv - 1;
    return {
      ...def, level: lv,
      hp: Math.round(def.hp * (1 + 0.06 * k)),
      punch: Math.round(def.punch * (1 + 0.06 * k) * 10) / 10,
      speed: Math.round(def.speed * (1 + 0.03 * k)),
    };
  }

  // ---------- Skins ----------
  // Köps i Butiken och sätts på vilken egen robot man vill i Garaget. mat styr hur ytan ser ut.
  const SKINS = [
    { id: 'guld', name: 'Guld', price: 400, color: '#ffcf3a', accent: '#b8860b', eye: '#ffffff', mat: { metalness: 0.6, roughness: 0.25, tint: 0.3 } },
    { id: 'skugga', name: 'Skugga', price: 550, color: '#17131f', accent: '#3a2a5a', eye: '#ff3b3b', mat: { metalness: 0.1, roughness: 0.95 } },
    { id: 'neon', name: 'Neon', price: 600, color: '#10102a', accent: '#ff2bd6', eye: '#3ee8ff', mat: { neon: true } },
    { id: 'kristall', name: 'Kristall', price: 750, color: '#bfefff', accent: '#7fd8ff', eye: '#ffffff', mat: { crystal: true } },
    { id: 'regnbage', name: 'Regnbåge', price: 1000, color: '#ff3b3b', accent: '#3ee8ff', eye: '#ffffff', mat: { rainbow: true } },
    { id: 'arsguld', name: 'Årsguld', price: null, color: '#fff3b0', accent: '#ffd93d', eye: '#ff5fd2', mat: { metalness: 0.6, roughness: 0.2, tint: 0.35, neon: true }, desc: 'Bara för den som har en årsstreak på 365 dagar.' },
  ];
  const skinById = Object.fromEntries(SKINS.map((k) => [k.id, k]));

  function buySkin(acct, id) {
    const skin = skinById[id];
    if (!skin || skin.price === null) return { error: 'Det skinnet går inte att köpa.' };
    acct.skins = acct.skins || [];
    if (acct.skins.includes(id)) return { error: 'Du har redan det skinnet.' };
    if ((acct.coins || 0) < skin.price) return { error: `Du behöver ${skin.price - (acct.coins || 0)} mynt till.` };
    acct.coins -= skin.price;
    acct.skins.push(id);
    return { bought: id };
  }

  // skinId === null tar av skinnet.
  function setSkin(acct, robotId, skinId) {
    if (count(acct, robotId) < 1) return { error: 'Du äger inte den roboten.' };
    acct.robotSkin = acct.robotSkin || {};
    if (skinId === null) { delete acct.robotSkin[robotId]; return { skin: null }; }
    if (!(acct.skins || []).includes(skinId)) return { error: 'Du äger inte det skinnet.' };
    acct.robotSkin[robotId] = skinId;
    return { skin: skinId };
  }

  function upgradeRobot(acct, id) {
    if (!robotById[id] || count(acct, id) < 1) return { error: 'Du äger inte den roboten.' };
    const lv = robotLevel(acct, id);
    if (lv >= ROBOT_MAX_LV) return { error: 'Roboten har redan högsta nivån.' };
    const cost = upgradeCost(lv);
    const spare = count(acct, id) - 1;
    if (spare < cost) return { error: `Du behöver ${cost} dubbletter (du har ${spare}).` };
    for (let i = 0; i < cost; i++) removeRobot(acct, id);
    acct.robotLv = acct.robotLv || {};
    acct.robotLv[id] = lv + 1;
    return { level: lv + 1 };
  }

  // Köper en butiksvara. Mynten finns bara på servern (eller i gästens egen webbläsare).
  function buyItem(acct, id) {
    const item = SHOP_ITEMS.find((e) => e.id === id);
    if (!item) return { error: 'Den varan finns inte i Butiken.' };
    if ((acct.equipmentInv[id] || 0) > 0) return { error: 'Du har redan den.' };
    if ((acct.coins || 0) < item.shop) return { error: `Du behöver ${item.shop - (acct.coins || 0)} mynt till.` };
    acct.coins -= item.shop;
    addEquipment(acct, id);
    return { bought: id };
  }

  const robotById = Object.fromEntries(ROBOTS.map((r) => [r.id, r]));

  // Hur ett föremål syns på roboten: [form, färg]. Formerna ritas i render3d.js.
  const ITEM_LOOK = {
    turbofeet: ['boots', '#35d0ff'], lightrig: ['boots', '#9be15d'], raketskorna: ['boots', '#ff7a1a'],
    fjaderskorna: ['boots', '#ffffff'], magnetstovlarna: ['boots', '#ff3b3b'],
    myggvingarna: ['wings', '#9be15d'],
    steelshield: ['armor', '#9aa7c7'], platearmor: ['armor', '#6a7084'], titanplattan: ['armor', '#cfd8e6'],
    guldrustningen: ['armor', '#ffd93d'], taggrustningen: ['armor', '#8a5a2a'], taggpansaret: ['armor', '#5a7a3a'],
    drakfjallet: ['armor', '#2fae5a'], frostmanteln: ['armor', '#bfe8ff'],
    djuphjalmen: ['helmet', '#1f6fb2'], uggleogat: ['helmet', '#ffe066'],
    servoarms: ['gloves', '#9aa7c7'], fangblade: ['gloves', '#ffffff'], plasmanavarna: ['gloves', '#ff2bd6'],
    stenhandskarna: ['gloves', '#7a6a58'], vampyrtanden: ['gloves', '#b3261e'], lavahjartat: ['orb', '#ff5a1a'],
    drakkronan: ['crown', '#ff5a1a'], drottningdiademet: ['crown', '#ff5fd2'],
    energikarnan: ['orb', '#ffd93d'], turchippet: ['orb', '#3ddc84'], skoldgeneratorn: ['orb', '#3ee8ff'],
    balansringen: ['orb', '#b46bff'], snabbchippet: ['orb', '#35d0ff'], livsbatteriet: ['orb', '#7dffb0'],
    megavapen: ['cannon', '#3ee8ff'], askhammaren: ['hammer', '#ffe066'], drakhjartat: ['orb', '#ff6a1a'],
    spegelskolden: ['armor', '#e8f6ff'], livskristallen: ['orb', '#a6ffcb'], gravitronen: ['orb', '#c47bff'],
  };

  // ---------- Set ----------
  // Äger man ALLA föremål i ett set får man en bonus hela tiden, vad man än bär.
  const SETS = [
    { id: 'monster', name: 'Monsterjägaren', items: [...new Set(ROBOTS.filter((r) => r.monster && !r.royal).map((r) => r.drop))], bonus: { hp: 15, speed: 10 }, desc: '+15 HP och +10 fart' },
    { id: 'royal', name: 'Kungligt blod', items: ROBOTS.filter((r) => r.royal).map((r) => r.drop), bonus: { hp: 10, punch: 4 }, desc: '+10 HP och +4 slag' },
    { id: 'super', name: 'Vapenmästaren', items: SUPER_WEAPONS.map((w) => w.id), bonus: { hp: 20, punch: 3, speed: 15 }, desc: '+20 HP, +3 slag och +15 fart' },
    { id: 'shop', name: 'Storkunden', items: SHOP_ITEMS.map((e) => e.id), bonus: { hp: 10, speed: 20 }, desc: '+10 HP och +20 fart' },
  ];
  function setsStatus(acct) {
    return SETS.map((set) => {
      const have = set.items.filter((id) => (acct.equipmentInv[id] || 0) > 0).length;
      return { id: set.id, name: set.name, desc: set.desc, have, total: set.items.length, done: have === set.items.length, bonus: set.bonus };
    });
  }

  // ---------- Monsterjakt ----------
  // Varje dag är ett av de vanliga monstren dagens jaktbyte: första vinsten mot det ger
  // 100 extra mynt och alltid en supervapendel.
  const HUNT_COINS = 100;
  function huntFor(today) {
    const regular = ROBOTS.filter((r) => r.monster && !r.royal);
    return regular[hashName(`jakt-${today || ''}`) % regular.length].id;
  }
  const BOSS_IDS = ROBOTS.filter((r) => r.boss).map((r) => r.id);
  const MONSTER_IDS = ROBOTS.filter((r) => r.monster).map((r) => r.id);
  const rankOf = (def) => RARITY[def.rarity].rank;

  // Alla huvudformer/extradetaljer som faktiskt förekommer bland robotarna — jokerns utseende
  // (se setWildcardHead/setWildcardExtra) får bara vara en av dessa, aldrig något påhittat.
  const HEAD_SHAPES = [...new Set(ROBOTS.map((r) => r.head))];
  const EXTRA_FEATURES = [...new Set(ROBOTS.map((r) => r.extra))];

  // Ett exempel-specialobjekt per mekaniktyp (det första som råkar använda den, bland alla
  // robotar plus jokerns egna) — mallen en fritt beskriven jokerattack (se
  // customWildcardSpecial) byggs från, så att fält den mekaniken faktiskt behöver (t.ex.
  // giftmolnets cloud-objekt) alltid finns och är korrekt ifyllda, även om bara namn,
  // beskrivning och ev. dmg/heal kommer från den fria texten.
  const TYPE_DEFAULTS = {};
  for (const r of ROBOTS) if (!TYPE_DEFAULTS[r.special.type]) TYPE_DEFAULTS[r.special.type] = r.special;
  for (const s of WILDCARD_SPECIALS) if (!TYPE_DEFAULTS[s.type]) TYPE_DEFAULTS[s.type] = s;

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

  // customSpecial: en fritt beskriven attack (se customWildcardSpecial) — vinner över allt
  // annat när den finns. Annars chosenType: spelarens uttryckliga listval (se
  // chooseWildcardSpecial). Annars styrs attacken av namnet, som förut.
  function wildcardSpecialFor(name, chosenType, customSpecial) {
    if (customSpecial && TYPE_DEFAULTS[customSpecial.type]) return customSpecial;
    if (chosenType && WILDCARD_SPECIAL_TYPES.has(chosenType)) {
      return WILDCARD_SPECIALS.find((s) => s.type === chosenType);
    }
    if (!name) return WILDCARD_SPECIALS[0];
    return WILDCARD_SPECIALS[hashName(name) % WILDCARD_SPECIALS.length];
  }

  // Rensar fri text (namn/beskrivning på en egen-designad attack): trim, enkelrum, begränsad
  // längd. Aldrig en krasch — ett tomt/ogiltigt värde ger bara tom sträng, som sedan faller
  // tillbaka på mekanikens eget standardnamn/beskrivning i customWildcardSpecial.
  function cleanAttackText(raw, maxLen) {
    if (typeof raw !== 'string') return '';
    return raw.trim().replace(/\s+/g, ' ').slice(0, maxLen);
  }

  // Bygger en komplett, säker attack från det en fri beskrivning (tolkad av Claude via
  // artefaktens sample-funktion, se game.js) gav: en mekaniktyp, ett namn, en beskrivning, och
  // ev. dmg/heal. ALDRIG tillit till rådata rakt av — typen måste vara en av de verkliga
  // mekanikerna, dmg/heal klipps till ett rimligt spann, och allt annat (t.ex. giftmolnets
  // exakta form) ärvs orört från en beprövad mall. Returnerar null vid en ogiltig typ.
  // Rensar ett förslag på element (t.ex. från Claudes tolkning av en fri beskrivning) till 1–2
  // GILTIGA typnamn — annars (ogiltigt, tomt, för många) faller den tillbaka på ['normal'],
  // aldrig en krasch eller ett påhittat typnamn som skulle krascha typeMultiplier.
  function cleanTypes(raw) {
    if (!Array.isArray(raw)) return ['normal'];
    const clean = raw.filter((t) => typeof t === 'string' && TYPES[t]).slice(0, 2);
    return clean.length ? clean : ['normal'];
  }

  function customWildcardSpecial(type, name, desc, dmg, heal, types) {
    const base = TYPE_DEFAULTS[typeof type === 'string' ? type.trim() : ''];
    if (!base) return null;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
    const out = { ...base };
    const cleanName = cleanAttackText(name, 24);
    const cleanDesc = cleanAttackText(desc, 140);
    if (cleanName) out.name = cleanName;
    if (cleanDesc) out.desc = cleanDesc;
    if ('dmg' in base && typeof dmg === 'number' && Number.isFinite(dmg)) out.dmg = clamp(dmg, 5, 45);
    if ('heal' in base && typeof heal === 'number' && Number.isFinite(heal)) out.heal = clamp(heal, 5, 30);
    out.types = cleanTypes(types);
    return out;
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
    // Banor med något extra: oändlig energi (infiniteEnergy) och/eller saker som blockerar
    // (obstacles). Ett hinder är { x, z, w, d, h, kind }: mitt (x i spelets koordinater, z i
    // djupled), bredd, djup och höjd. Pelare och murar är för höga att hoppa över; lådor kan
    // man hoppa upp på. Hindren stoppar skott och vågor — använd dem som skydd!
    {
      id: 'energy', name: 'Energiverket', hint: 'Oändlig energi — specialattacker hela tiden!',
      gravityMul: 1, speedMul: 1, dmgMul: 1, infiniteEnergy: true,
      sky: '#0d1f2a', ground: '#06121a', line: '#ffd93d',
    },
    {
      id: 'ruins', name: 'Ruinerna', hint: 'Pelare och lådor stoppar skott — göm dig bakom dem!',
      gravityMul: 1, speedMul: 1, dmgMul: 1,
      sky: '#1d1a26', ground: '#0e0c14', line: '#8a7a9e',
      obstacles: [
        { x: 480, z: -125, w: 46, d: 46, h: 220, kind: 'pillar' },
        { x: 480, z: 125, w: 46, d: 46, h: 220, kind: 'pillar' },
        { x: 380, z: 20, w: 50, d: 50, h: 55, kind: 'crate' },
        { x: 590, z: -30, w: 50, d: 50, h: 55, kind: 'crate' },
        { x: 170, z: -170, w: 46, d: 46, h: 220, kind: 'pillar' },
        { x: 790, z: 170, w: 46, d: 46, h: 220, kind: 'pillar' },
      ],
    },
    {
      id: 'fortress', name: 'Fästningen', hint: 'Murar att ta skydd bakom — gå runt dem i djupled!',
      gravityMul: 1, speedMul: 1, dmgMul: 1,
      sky: '#141e1a', ground: '#0a120e', line: '#6aa87a',
      obstacles: [
        { x: 400, z: -95, w: 28, d: 150, h: 120, kind: 'wall' },
        { x: 560, z: 95, w: 28, d: 150, h: 120, kind: 'wall' },
        { x: 480, z: 0, w: 50, d: 50, h: 55, kind: 'crate' },
      ],
    },
    {
      id: 'chaos', name: 'Kaosfabriken', hint: 'Oändlig energi OCH lådor att gömma sig bakom!',
      gravityMul: 1, speedMul: 1, dmgMul: 1, infiniteEnergy: true,
      sky: '#26100e', ground: '#140806', line: '#ff6b3d',
      obstacles: [
        { x: 480, z: -150, w: 50, d: 50, h: 55, kind: 'crate' },
        { x: 480, z: 150, w: 50, d: 50, h: 55, kind: 'crate' },
        { x: 360, z: 70, w: 50, d: 50, h: 55, kind: 'crate' },
        { x: 600, z: -70, w: 50, d: 50, h: 55, kind: 'crate' },
        { x: 480, z: 0, w: 40, d: 40, h: 200, kind: 'pillar' },
      ],
    },
    // monster: true → ingår aldrig i den SLUMPADE poolen (pickArena) för vanliga matcher, bara
    // tvingas fram uttryckligen för monsterstrider (se startMatch i game.js) — "en annan värld",
    // inte en bana som kan dyka upp av en slump mitt i en robotmatch.
    {
      id: 'direworld', name: 'Monstervärlden', hint: '', monster: true,
      gravityMul: 1, speedMul: 1, dmgMul: 1,
      sky: '#1a0f08', ground: '#0a0503', line: '#5a3a1a',
    },
    // Robotstaden: världen man går omkring i mellan matcherna (se showHub i game.js). Också
    // monster: true, så den aldrig slumpas fram som bana för en match.
    {
      id: 'hub', name: 'Robotstaden', hint: '', monster: true, width: 2500,
      gravityMul: 1, speedMul: 1, dmgMul: 1,
      sky: '#10203f', ground: '#0a1630', line: '#3ee8ff',
    },
  ];
  const arenaById = Object.fromEntries(ARENAS.map((a) => [a.id, a]));
  // rng är en funktion som ger ett tal i [0, 1) — samma mönster som rollBox/pickOpponent.
  const pickArena = (rng) => {
    const pool = ARENAS.filter((a) => !a.monster);
    return pool[Math.floor(rng() * pool.length)];
  };

  // ---------- Konto ----------
  // Ett konto är { inv: {robotId: antal}, boxes, daily: 'ÅÅÅÅ-MM-DD', selected, level, xp }.
  function newAccount() {
    return {
      inv: { bolt: 1 }, boxes: 0, daily: '', selected: 'bolt', level: 1, xp: 0,
      wildcardName: null, wildcardSpecialType: null, wildcardCustomSpecial: null, wildcardColor: null,
      wildcardHead: null, wildcardExtra: null,
      equipmentInv: {}, equippedItem: null, superPieces: {}, coins: 0,
    };
  }

  // Rensar ett fritt namn (för jokerroboten): trim, 1–20 tecken, bokstäver/siffror/vanlig
  // skiljetecken — annars null (ogiltigt), aldrig en krasch.
  function cleanName(raw) {
    if (typeof raw !== 'string') return null;
    const name = raw.trim().replace(/\s+/g, ' ').slice(0, 20);
    return /^[\p{L}\p{N} '\-!?.]{1,20}$/u.test(name) ? name : null;
  }

  // Giltig hexfärg (#rrggbb) — annars null, aldrig en krasch.
  function cleanColor(raw) {
    if (typeof raw !== 'string') return null;
    const v = raw.trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(v) ? v : null;
  }

  // Gör vilket sparat värde som helst till ett giltigt konto.
  function sanitize(raw) {
    const acct = {
      inv: {}, boxes: 0, daily: '', selected: 'bolt', level: 1, xp: 0,
      wildcardName: null, wildcardSpecialType: null, wildcardCustomSpecial: null, wildcardColor: null,
      wildcardHead: null, wildcardExtra: null,
      equipmentInv: {}, equippedItem: null, superPieces: {}, coins: 0,
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
      if (raw.wildcardCustomSpecial && typeof raw.wildcardCustomSpecial === 'object') {
        const c = raw.wildcardCustomSpecial;
        acct.wildcardCustomSpecial = customWildcardSpecial(c.type, c.name, c.desc, c.dmg, c.heal, c.types);
      }
      acct.wildcardColor = cleanColor(raw.wildcardColor);
      if (typeof raw.wildcardHead === 'string' && HEAD_SHAPES.includes(raw.wildcardHead)) acct.wildcardHead = raw.wildcardHead;
      if (typeof raw.wildcardExtra === 'string' && EXTRA_FEATURES.includes(raw.wildcardExtra)) acct.wildcardExtra = raw.wildcardExtra;
      const equipmentInv = raw.equipmentInv && typeof raw.equipmentInv === 'object' ? raw.equipmentInv : {};
      for (const e of EQUIPMENT) {
        const n = Math.floor(Number(equipmentInv[e.id]));
        if (n > 0 && n < 1e6) acct.equipmentInv[e.id] = n;
      }
      if (typeof raw.equippedItem === 'string' && EQUIPMENT_IDS.has(raw.equippedItem) && acct.equipmentInv[raw.equippedItem] > 0) {
        acct.equippedItem = raw.equippedItem;
      }
      acct.coins = Math.max(0, Math.min(MAX_COINS, Math.floor(Number(raw.coins)) || 0));
      for (const period of ['week', 'month']) {
        const pq = raw[periodField(period)];
        if (pq && typeof pq === 'object' && typeof pq.key === 'string' && pq.key.length <= 10) {
          const prog = {};
          for (const id of PERIOD_IDS) {
            const n = Math.floor(Number(pq.prog && pq.prog[id]));
            if (n > 0 && n < 100000) prog[id] = n;
          }
          acct[periodField(period)] = { key: pq.key, prog, done: Array.isArray(pq.done) ? pq.done.filter((id) => PERIOD_IDS.has(id)).slice(0, 5) : [], bonus: !!pq.bonus };
        }
      }
      if (raw.streak && typeof raw.streak === 'object' && typeof raw.streak.last === 'string' && raw.streak.last.length <= 10) {
        const n = (v) => Math.max(0, Math.min(100000, Math.floor(Number(v)) || 0));
        acct.streak = { last: raw.streak.last, count: n(raw.streak.count), best: n(raw.streak.best) };
      }
      if (typeof raw.huntDay === 'string' && raw.huntDay.length <= 10) acct.huntDay = raw.huntDay;
      acct.tower = Math.max(1, Math.min(TOWER_TOP + 1, Math.floor(Number(raw.tower)) || 1));
      if (raw.weekly && typeof raw.weekly.week === 'string' && /^\d{4}-v\d{1,2}$/.test(raw.weekly.week)) {
        acct.weekly = { week: raw.weekly.week, floor: Math.max(1, Math.min(WEEKLY_TOP + 1, Math.floor(Number(raw.weekly.floor)) || 1)) };
      }
      if (Array.isArray(raw.medals)) acct.medals = [...new Set(raw.medals.filter((id) => MEDAL_IDS.has(id)))];
      if (raw.stats && typeof raw.stats === 'object') {
        acct.stats = {};
        for (const k of STAT_KEYS) acct.stats[k] = Math.max(0, Math.min(1e7, Math.floor(Number(raw.stats[k])) || 0));
      }
      if (Array.isArray(raw.streetBeaten)) {
        acct.streetBeaten = raw.streetBeaten.filter((k) => typeof k === 'string' && /^\d+:[\w-]+$/.test(k)).slice(-STREET_MAX * 2);
      }
      if (raw.robotLv && typeof raw.robotLv === 'object') {
        acct.robotLv = {};
        for (const id of Object.keys(robotById)) {
          const lv = Math.floor(Number(raw.robotLv[id]));
          if (lv > 1) acct.robotLv[id] = Math.min(ROBOT_MAX_LV, lv);
        }
      }
      if (Array.isArray(raw.skins)) acct.skins = [...new Set(raw.skins.filter((id) => skinById[id]))];
      if (raw.robotSkin && typeof raw.robotSkin === 'object') {
        acct.robotSkin = {};
        for (const [rid, sid] of Object.entries(raw.robotSkin)) {
          if (robotById[rid] && (acct.skins || []).includes(sid)) acct.robotSkin[rid] = sid;
        }
      }
      // Gamla konton hade tre dagliga uppdrag ({ day, prog, ... }) — de får bara nya uppdrag.
      const q = raw.quests;
      if (q && typeof q === 'object' && Array.isArray(q.active)) {
        const int = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v)) || 0));
        const active = [];
        for (const it of q.active.slice(0, QUEST_SLOTS)) {
          const base = it && questById[it.id];
          if (!base || active.some((x) => x.id === it.id)) continue;
          if (base.param === 'type' && !Object.prototype.hasOwnProperty.call(TYPES, it.param)) continue;
          if (base.param === 'rarity' && !QUEST_RARITIES.includes(it.param)) continue;
          const goal = Math.max(1, int(it.goal, 100));
          const quest = {
            id: it.id, goal, coins: int(it.coins, 1000), prog: Math.min(goal - 1, int(it.prog, 100)), idle: int(it.idle, QUEST_STALE - 1),
          };
          if (base.param) quest.param = it.param;
          active.push(quest);
        }
        acct.quests = { seq: int(q.seq, 1e9), done: int(q.done, 1e9), streak: int(q.streak, 1e6), active };
      }
      const pieces = raw.superPieces && typeof raw.superPieces === 'object' && !Array.isArray(raw.superPieces) ? raw.superPieces : {};
      // Gamla konton hade bara Megavapnets delar, i megaFragments.
      const old = { megavapen: raw.megaFragments, ...pieces };
      for (const w of SUPER_WEAPONS) {
        const n = Math.max(0, Math.min(w.pieces - 1, Math.floor(Number(old[w.id])) || 0));
        if (n > 0) acct.superPieces[w.id] = n;
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
    const pool = ROBOTS.filter((r) => r.rarity === tier && !r.boss && !r.monster && r.id !== 'wildcard');
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

  // ---------- Byteshandel med Handlaren (en AI) ----------
  // Varje robot har ett bytesvärde efter hur sällsynt den är — tio episka är värda en
  // legendarisk. Handlaren byter bort vilken vanlig/sällsynt/episk/legendarisk/gudomlig robot som
  // helst mot robotar man ger som tillsammans är värda minst lika mycket. Bossar går att ge
  // bort men aldrig att få; jokern och monstren går inte att byta alls.
  const TRADE_VALUE = { common: 1, rare: 3, epic: 10, legendary: 100, divine: 500, boss: 150 };
  const tradeValue = (id) => (robotById[id] ? TRADE_VALUE[robotById[id].rarity] || 0 : 0);
  const canTradeFor = (id) => !!robotById[id] && !robotById[id].boss && tradeValue(id) > 0;

  // give: { robotId: antal }. Returnerar { got } eller { error }.
  function trade(acct, give, want) {
    if (!canTradeFor(want)) return { error: 'Den roboten byter Handlaren inte bort.' };
    if (!give || typeof give !== 'object' || Array.isArray(give)) return { error: 'Välj vad du vill ge.' };
    let value = 0;
    const clean = {};
    for (const [id, raw] of Object.entries(give)) {
      const n = Math.floor(Number(raw));
      if (!(n > 0)) continue;
      if (tradeValue(id) <= 0) return { error: 'Den roboten vill Handlaren inte ha.' };
      const keep = id === 'bolt' ? 1 : 0; // man har alltid minst en Bolt kvar
      if (count(acct, id) - keep < n) return { error: `Du har inte så många ${robotById[id].name} att ge.` };
      clean[id] = n;
      value += n * tradeValue(id);
    }
    if (value === 0) return { error: 'Välj vad du vill ge.' };
    const price = tradeValue(want);
    if (value < price) return { error: `Handlaren vill ha robotar värda ${price} poäng — du erbjuder ${value}.` };
    for (const [id, n] of Object.entries(clean)) for (let i = 0; i < n; i++) removeRobot(acct, id);
    addRobot(acct, want);
    if (!acct.inv[acct.selected]) acct.selected = want;
    return { got: want };
  }

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
    const pool = ROBOTS.filter((r) => r.rarity === tier && !r.boss && !r.monster && r.id !== 'wildcard');
    return pool[Math.floor(rng() * pool.length)];
  }

  // Vanlig match: motståndaren kan vara en nivå sällsyntare än din robot. Insatsmatch: aldrig
  // sällsyntare än din insats, eftersom du vinner motståndarens robot.
  function pickOpponent(robotId, stake, rng) {
    const def = robotById[robotId];
    const maxRank = rankOf(def) + (stake ? 0 : 1);
    const pool = ROBOTS.filter((r) => r.id !== robotId && rankOf(r) <= maxRank && !r.boss && !r.monster);
    return pool[Math.floor(rng() * pool.length)];
  }

  // ---------- Robotarna som går omkring i Robotstaden ----------
  // Var tionde minut kommer ett nytt gäng. Vilka de är räknas fram ur tiden (lottade som ur en
  // låda), så servern vet exakt vilka som går där och bara de går att utmana. Vinner man får man
  // roboten — men varje robot går bara att vinna en gång innan nästa gäng kommer.
  // Från nivå ELITE_LEVEL går även elitrobotar omkring: minst episka, de slåss som de svåraste
  // bossarna och blir starkare ju högre nivå man har (se eliteTier i game.js), och ger extra
  // mynt när man vinner. Från CHAMPION_LEVEL kommer en elitrobot till, och stadens mästare:
  // minst legendarisk, med mycket mer liv och den skarpaste AI:n — och ett stort pris.
  const STREET_SLOT_MS = 10 * 60 * 1000;
  const STREET_COUNT = 8;
  const ELITE_COUNT = 2;
  const ELITE_LEVEL = 20;
  const ELITE_COINS = 100;
  const CHAMPION_LEVEL = 30;
  const CHAMPION_COINS = 300;
  const CHAMPION_BOXES = 2;
  const STREET_MAX = STREET_COUNT + ELITE_COUNT + 2; // + en elitrobot och mästaren från CHAMPION_LEVEL
  const streetSlot = (now) => Math.floor(now / STREET_SLOT_MS);

  // [{ id, elite, champion, minLevel }] — hela gänget i den tidsluckan, de svåraste sist.
  function streetRobots(slot) {
    let s = hashName(`gata-${slot}`) >>> 0;
    const rng = () => { // mulberry32
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const ids = [];
    const add = (roll, n) => {
      const until = ids.length + n;
      while (ids.length < until) {
        const r = roll();
        if (r.id !== 'wildcard' && !ids.includes(r.id)) ids.push(r.id);
      }
    };
    add(() => rollBox(rng), STREET_COUNT);
    add(() => rollBoxFrom(rng, 'epic'), ELITE_COUNT + 1);
    add(() => rollBoxFrom(rng, 'legendary'), 1);
    return ids.map((id, i) => {
      if (i < STREET_COUNT) return { id, elite: false, champion: false, minLevel: 1 };
      if (i < STREET_COUNT + ELITE_COUNT) return { id, elite: true, champion: false, minLevel: ELITE_LEVEL };
      return { id, elite: true, champion: i === STREET_MAX - 1, minLevel: CHAMPION_LEVEL };
    });
  }

  // Stadsrobotarna man kan utmana just nu: nuvarande gäng (de svåraste bara från sin nivå),
  // minus dem man redan vunnit.
  function streetChallengers(acct, now, slot = streetSlot(now)) {
    const beaten = acct.streetBeaten || [];
    return streetRobots(slot).filter((r) => acct.level >= r.minLevel && !beaten.includes(`${slot}:${r.id}`));
  }

  // ---------- Utmaningstornet (från nivå TOWER_LEVEL) ----------
  // TOWER_TOP våningar, var och en med en bestämd motståndare som blir sällsyntare (och, i
  // game.js, starkare) ju högre upp man kommer. Var tionde våning vaktas av en mystisk robot.
  // Vinst tar en upp en våning och ger mynt; var femte våning ger dessutom en låda och
  // våningens robot. Förlust kostar inget — man står kvar och kan försöka igen.
  const TOWER_LEVEL = 20;
  const TOWER_TOP = 50;
  const TOWER_PRIZE_EVERY = 5;
  const TOWER_TOP_COINS = 1000;
  const towerCoins = (floor) => 20 + floor * 4;

  function towerOpponent(floor) {
    if (floor % 10 === 0) return BOSS_IDS[floor / 10 % BOSS_IDS.length];
    let s = hashName(`torn-${floor}`) >>> 0;
    const rng = () => { // mulberry32
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const floorRarity = floor < 10 ? 'rare' : floor < 20 ? 'epic' : floor < 35 ? 'legendary' : 'divine';
    const below = floor > 1 ? towerOpponent(floor - 1) : null; // aldrig samma robot två våningar i rad
    for (;;) {
      const r = rollBoxFrom(rng, floorRarity);
      if (r.id !== 'wildcard' && r.id !== below) return r.id;
    }
  }

  // ---------- Veckans torn (från nivå TOWER_LEVEL) ----------
  // Tio våningar med nya motståndare varje vecka (samma för alla, bestämda av veckan), episka
  // längst ner och gudomliga högst upp. Vinst = en våning upp och mynt; den som klarar alla tio
  // får en minst legendarisk robot, WEEKLY_TOP_COINS mynt och WEEKLY_TOP_BOXES lådor. Börjar om
  // på måndag. Veckan räknas ur tiden i UTC, så klient och server alltid är överens.
  const WEEKLY_TOP = 10;
  const WEEKLY_TOP_COINS = 500;
  const WEEKLY_TOP_BOXES = 2;
  const weeklyCoins = (floor) => 40 + floor * 10;
  const weekOf = (now) => weekKey(new Date(now).toISOString().slice(0, 10));

  function weeklyOpponent(week, floor) {
    let s = hashName(`vecka-${week}-${floor}`) >>> 0;
    const rng = () => { // mulberry32
      s = (s + 0x6d2b79f5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const floorRarity = floor <= 3 ? 'epic' : floor <= 7 ? 'legendary' : 'divine';
    const below = floor > 1 ? weeklyOpponent(week, floor - 1) : null;
    for (;;) {
      const r = rollBoxFrom(rng, floorRarity);
      if (r.id !== 'wildcard' && r.id !== below) return r.id;
    }
  }

  // Våningen man står på i veckans torn just nu (1 när en ny vecka börjat).
  const weeklyFloor = (acct, week) => (acct.weekly && acct.weekly.week === week ? acct.weekly.floor : 1);

  // ---------- Medaljer ----------
  // Rena hedersbetygelser — de ger inga mynt eller robotar, bara äran (och en fest). Därför
  // går det bra att "Felfri" bygger på klientens uppgift om att man inte blev träffad.
  // stats räknar vinster av olika slag, se countWin().
  const MEDALS = [
    { id: 'first_win', icon: '🥉', name: 'Första vinsten', desc: 'Vinn din första match.', check: (a) => a.stats.wins >= 1 },
    { id: 'wins50', icon: '🥈', name: 'Rutinerad', desc: 'Vinn 50 matcher.', check: (a) => a.stats.wins >= 50 },
    { id: 'wins250', icon: '🥇', name: 'Veteran', desc: 'Vinn 250 matcher.', check: (a) => a.stats.wins >= 250 },
    { id: 'perfect', icon: '✨', name: 'Felfri', desc: 'Vinn en match utan att bli träffad en enda gång.', check: (a, ev) => ev.won && ev.perfect },
    { id: 'street1', icon: '🚶', name: 'Gatuslagsmål', desc: 'Vinn en robot som går omkring i staden.', check: (a) => a.stats.street >= 1 },
    { id: 'street10', icon: '🏙', name: 'Gatans kung', desc: 'Vinn 10 robotar i staden.', check: (a) => a.stats.street >= 10 },
    { id: 'elite1', icon: '⭐', name: 'Elitjägare', desc: 'Besegra en elitrobot i staden.', check: (a) => a.stats.elite >= 1 },
    { id: 'champion', icon: '👑', name: 'Stadens mästare', desc: 'Besegra stadens mästare.', check: (a) => a.stats.champion >= 1 },
    { id: 'boss', icon: '🔮', name: 'Mystiker', desc: 'Besegra en mystisk robot.', check: (a) => a.stats.boss >= 1 },
    { id: 'royal', icon: '🗡', name: 'Kungadråpare', desc: 'Besegra en kung eller drottningen.', check: (a) => a.stats.royal >= 1 },
    { id: 'tower10', icon: '🗼', name: 'Tornklättrare', desc: 'Klara våning 10 i Utmaningstornet.', check: (a) => (a.tower || 1) > 10 },
    { id: 'tower25', icon: '🌆', name: 'Halvvägs', desc: 'Klara våning 25 i Utmaningstornet.', check: (a) => (a.tower || 1) > 25 },
    { id: 'tower50', icon: '🏆', name: 'Toppen av tornet', desc: 'Klara alla 50 våningar.', check: (a) => (a.tower || 1) > TOWER_TOP },
    { id: 'weekly', icon: '📅', name: 'Veckans hjälte', desc: 'Klara alla 10 våningar i veckans torn.', check: (a, ev) => !!ev.weeklyDone },
    { id: 'underdog', icon: '💪', name: 'Underdog', desc: 'Besegra en elitrobot, mästaren eller en tornboss med en vanlig robot.', check: (a, ev) => ev.won && ev.underdog },
    { id: 'collector', icon: '📦', name: 'Samlare', desc: 'Äg 25 olika robotar.', check: (a) => Object.keys(a.inv).filter((id) => a.inv[id] > 0).length >= 25 },
    { id: 'level30', icon: '🔥', name: 'Nivå 30', desc: 'Nå nivå 30.', check: (a) => (a.level || 1) >= 30 },
  ];
  const MEDAL_IDS = new Set(MEDALS.map((m) => m.id));
  const STAT_KEYS = ['wins', 'street', 'elite', 'champion', 'boss', 'royal'];

  function ensureStats(acct) {
    acct.medals = acct.medals || [];
    acct.stats = acct.stats || {};
    for (const k of STAT_KEYS) acct.stats[k] = acct.stats[k] || 0;
  }

  function countWin(acct, match) {
    const s = acct.stats;
    s.wins += 1;
    if (match.street !== undefined) s.street += 1;
    if (match.elite) s.elite += 1;
    if (match.champion) s.champion += 1;
    if (match.boss) s.boss += 1;
    const opp = robotById[match.opp];
    if (match.monster && opp && opp.royal) s.royal += 1;
  }

  // Delar ut de medaljer man just förtjänat. ev: { won, perfect, underdog }. Ger deras id:n.
  function awardMedals(acct, ev = {}) {
    ensureStats(acct);
    const got = MEDALS.filter((m) => !acct.medals.includes(m.id) && m.check(acct, ev)).map((m) => m.id);
    acct.medals.push(...got);
    return got;
  }

  // Startar en match. Insatsen dras direkt, så det går inte att smita undan en förlust. Alla
  // bossar går att utmana när som helst, oavsett nivå, och om och om igen — vilken av dem
  // man möter slumpas. Ingen insats sätts på spel mot en boss. Monster fungerar likadant
  // (monsterId väljer vilket) — helt skild meny, egen ekonomi (se finishMatch), ingen insats.
  // En stadsrobot (mode 'street', target = vilken) går att utmana en stund efter att gänget
  // bytts, så att den man just gått fram till inte försvinner mitt i utmaningen.
  function startMatch(acct, robotId, mode, rng, target, now = Date.now()) {
    if (!robotById[robotId] || count(acct, robotId) < 1) return { error: 'Du äger inte den roboten.' };
    if (mode === 'street') {
      for (const slot of [now, now - 60 * 1000].map(streetSlot)) {
        const hit = streetChallengers(acct, now, slot).find((r) => r.id === target);
        if (!hit) continue;
        acct.selected = robotId;
        return { robot: robotId, stake: false, opp: target, street: slot, elite: hit.elite, champion: hit.champion };
      }
      return { error: 'Den roboten har gått vidare.' };
    }
    if (mode === 'weekly') {
      if (!(acct.level >= TOWER_LEVEL)) return { error: `Veckans torn öppnar på nivå ${TOWER_LEVEL}.` };
      const week = weekOf(now);
      if (!acct.weekly || acct.weekly.week !== week) acct.weekly = { week, floor: 1 }; // ny vecka
      const { floor } = acct.weekly;
      if (floor > WEEKLY_TOP) return { error: 'Du har redan klarat veckans torn — ett nytt kommer på måndag!' };
      acct.selected = robotId;
      return { robot: robotId, stake: false, opp: weeklyOpponent(week, floor), weekly: { week, floor } };
    }
    if (mode === 'tower') {
      if (!(acct.level >= TOWER_LEVEL)) return { error: `Utmaningstornet öppnar på nivå ${TOWER_LEVEL}.` };
      const floor = acct.tower || 1;
      if (floor > TOWER_TOP) return { error: 'Du har redan klarat hela tornet!' };
      acct.selected = robotId;
      return { robot: robotId, stake: false, opp: towerOpponent(floor), tower: floor };
    }
    const monsterId = target;
    acct.selected = robotId;
    if (mode === 'boss') {
      return { robot: robotId, stake: false, opp: BOSS_IDS[Math.floor(rng() * BOSS_IDS.length)], boss: true };
    }
    if (mode === 'monster') {
      if (!MONSTER_IDS.includes(monsterId)) return { error: 'Okänt monster.' };
      return { robot: robotId, stake: false, opp: monsterId, monster: true };
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
  // En monstervinst ger varken låda, erfarenhet eller en robot — bara det bestämda föremålet
  // just det monstret ger (def.drop, aldrig slumpat), plus en chans (SUPER_PIECE_CHANCE)
  // att ÄVEN hitta en del av ett supervapen. Helt egen, parallell ekonomi; förlorar man kostar det
  // inget, precis som mot en boss.
  // rng behövs bara vid vinst (för ett eventuellt nivåpris/föremål/supervapendel) — vänmatcher
  // anropar aldrig den här funktionen. perfect: klienten säger att man inte blev träffad (bara
  // för medaljen Felfri, som inte ger något annat än äran).
  function finishMatch(acct, match, won, rng, today, perfect = false) {
    // Uppdragen: vad hände i matchen?
    const robotDef = robotById[match.robot];
    const oppDef = robotById[match.opp];
    const events = ['play'];
    if (won) {
      events.push('win');
      if (match.monster) events.push('monster');
      if (match.monster && oppDef && oppDef.royal) events.push('royal');
      if (match.boss) events.push('boss');
      if (match.stake) events.push('stake');
      if (match.street !== undefined) events.push('street');
      if (match.elite) events.push('elite');
      if (match.champion) events.push('champion');
      if (match.tower || match.weekly) events.push('tower');
      events.push('typewin', 'raritywin');
      if (robotDef && robotDef.rarity === 'divine') events.push('divinewin');
    }
    const quest = questEvent(acct, events, robotDef);
    const result = finishMatchInner(acct, match, won, rng, today);
    // Vecko- och månadsuppdragen (bara när dagens datum är känt).
    for (const period of ['week', 'month']) {
      if (!today) break;
      const r = periodEvent(acct, today, period, events);
      quest.completed.push(...r.completed);
      if (r.bonusBoxes) result.periodBonus = (result.periodBonus || 0) + r.bonusBoxes;
    }
    result.quests = quest.completed;
    result.newQuests = quest.added;
    result.questBonus = quest.bonus;
    ensureStats(acct);
    if (won) countWin(acct, match);
    const underdog = robotDef && robotDef.rarity === 'common' && (match.elite || (match.tower && oppDef && oppDef.boss));
    const weeklyDone = result.weekly === WEEKLY_TOP;
    result.medals = awardMedals(acct, { won, perfect: perfect === true, underdog: !!underdog, weeklyDone });
    return result;
  }

  function finishMatchInner(acct, match, won, rng, today) {
    if (match.monster) {
      const result = {
        won, stake: false, gained: null, lost: null, box: false, levelUps: [], bossWon: null,
        itemWon: null, superPiece: null, superPieces: 0, superAssembled: null, coins: 0,
      };
      if (won) {
        result.coins = addCoins(acct, robotById[match.opp] && robotById[match.opp].royal ? COINS.royalWin : COINS.monsterWin);
        const drop = robotById[match.opp] && robotById[match.opp].drop;
        if (drop) {
          addEquipment(acct, drop);
          result.itemWon = drop;
        }
        // Kungar, drottningen och dagens jaktbyte ger alltid en supervapendel, de vanliga
        // monstren bara ibland.
        const royal = robotById[match.opp] && robotById[match.opp].royal;
        const hunt = today && match.opp === huntFor(today) && acct.huntDay !== today;
        if (hunt) {
          acct.huntDay = today;
          result.coins += addCoins(acct, HUNT_COINS);
          result.hunt = HUNT_COINS;
        }
        if (royal || hunt || rng() < SUPER_PIECE_CHANCE) {
          // Delen hör till ett supervapen man inte har än (eller, har man alla, vilket som helst).
          const missing = SUPER_WEAPONS.filter((w) => !(acct.equipmentInv[w.id] > 0));
          const pool = missing.length ? missing : SUPER_WEAPONS;
          const w = pool[Math.floor(rng() * pool.length)];
          acct.superPieces = acct.superPieces || {};
          const n = (acct.superPieces[w.id] || 0) + 1;
          result.superPiece = w.id;
          if (n >= w.pieces) {
            delete acct.superPieces[w.id];
            addEquipment(acct, w.id);
            result.superAssembled = w.id;
            result.superPieces = w.pieces;
          } else {
            acct.superPieces[w.id] = n;
            result.superPieces = n;
          }
        }
      }
      return result;
    }
    const result = { won, stake: match.stake, gained: null, lost: null, box: won, levelUps: [], bossWon: null, itemWon: null, coins: 0 };
    result.coins = addCoins(acct, !won ? COINS.loss : match.boss ? COINS.bossWin : match.stake ? COINS.stakeWin : COINS.win);
    if (won) {
      acct.boxes += 1;
      result.levelUps = addXp(acct, 1, rng);
      if (match.weekly) {
        // Bara om man står på den våningen samma vecka (en gammal match räknas inte två gånger).
        const { week, floor } = match.weekly;
        if (acct.weekly && acct.weekly.week === week && acct.weekly.floor === floor) {
          acct.weekly = { week, floor: floor + 1 };
          result.weekly = floor;
          result.coins += addCoins(acct, weeklyCoins(floor));
          if (floor === WEEKLY_TOP) {
            let prize = rollBoxFrom(rng, 'legendary');
            while (prize.id === 'wildcard') prize = rollBoxFrom(rng, 'legendary');
            addRobot(acct, prize.id);
            result.gained = prize.id;
            acct.boxes += WEEKLY_TOP_BOXES;
            result.coins += addCoins(acct, WEEKLY_TOP_COINS);
          }
        }
      } else if (match.tower) {
        // Bara om man faktiskt står på den våningen (en gammal match räknas inte två gånger).
        if ((acct.tower || 1) === match.tower) {
          acct.tower = match.tower + 1;
          result.tower = match.tower;
          result.coins += addCoins(acct, match.tower === TOWER_TOP ? TOWER_TOP_COINS : towerCoins(match.tower));
          if (match.tower % TOWER_PRIZE_EVERY === 0) {
            acct.boxes += 1;
            addRobot(acct, match.opp);
            result.gained = match.opp;
          }
        }
      } else if (match.boss) {
        addRobot(acct, match.opp);
        result.bossWon = match.opp;
      } else if (match.street !== undefined) {
        addRobot(acct, match.opp);
        result.gained = match.opp;
        result.street = true;
        if (match.champion) {
          result.coins += addCoins(acct, CHAMPION_COINS);
          acct.boxes += CHAMPION_BOXES;
          result.champion = true;
        } else if (match.elite) {
          result.coins += addCoins(acct, ELITE_COINS);
          result.elite = true;
        }
        acct.streetBeaten = [...(acct.streetBeaten || []), `${match.street}:${match.opp}`].slice(-STREET_MAX * 2);
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

  function addEquipment(acct, id) {
    acct.equipmentInv[id] = (acct.equipmentInv[id] || 0) + 1;
  }

  // itemId === null tar av det man bär. Man måste äga minst ett exemplar för att bära det.
  function equipItem(acct, itemId) {
    if (itemId === null) {
      acct.equippedItem = null;
      return { equipped: null };
    }
    if (!EQUIPMENT_IDS.has(itemId)) return { error: 'Okänt föremål.' };
    if (!(acct.equipmentInv[itemId] > 0)) return { error: 'Du äger inte det föremålet.' };
    acct.equippedItem = itemId;
    return { equipped: itemId };
  }

  function openBox(acct, rng, today) {
    if (acct.boxes <= 0) return null;
    acct.boxes -= 1;
    questEvent(acct, ['box']);
    if (today) for (const period of ['week', 'month']) periodEvent(acct, today, period, ['box']);
    const prize = rollBox(rng);
    addRobot(acct, prize.id);
    awardMedals(acct); // Samlare
    return { id: prize.id, n: count(acct, prize.id) };
  }

  function claimDaily(acct, today) {
    if (!(today > acct.daily)) return false;
    acct.boxes += 1;
    addCoins(acct, COINS.daily);
    acct.daily = today;
    // Streak: en dag till i rad, eller börja om.
    const st = acct.streak || { last: '', count: 0, best: 0 };
    st.count = st.last === prevDay(today) ? st.count + 1 : 1;
    st.last = today;
    st.best = Math.max(st.best || 0, st.count);
    const coins = addCoins(acct, Math.min(50, 5 * st.count));
    const milestone = STREAK_MILESTONES[st.count] || null;
    if (milestone) {
      acct.boxes += milestone.boxes;
      addCoins(acct, milestone.coins);
      if (milestone.skin) {
        acct.skins = acct.skins || [];
        if (!acct.skins.includes(milestone.skin)) acct.skins.push(milestone.skin);
      }
    }
    st.reward = { coins, milestone: milestone ? st.count : null };
    acct.streak = st;
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
      wildcardCustomSpecial: acct.wildcardCustomSpecial || null,
      wildcardColor: acct.wildcardColor || null,
      wildcardHead: acct.wildcardHead || null,
      wildcardExtra: acct.wildcardExtra || null,
      equipmentInv: { ...(acct.equipmentInv || {}) },
      equippedItem: acct.equippedItem || null,
      superPieces: { ...(acct.superPieces || {}) },
      coins: acct.coins || 0,
      streetBeaten: [...(acct.streetBeaten || [])],
      tower: acct.tower || 1,
      weekly: { week: weekOf(Date.now()), floor: weeklyFloor(acct, weekOf(Date.now())) },
      medals: [...(acct.medals || [])],
      stats: { ...(acct.stats || {}) },
      quests: questView(acct),
      weekQuests: periodView(acct, today, 'week'),
      monthQuests: periodView(acct, today, 'month'),
      streak: acct.streak ? { count: acct.streak.last === today || acct.streak.last === prevDay(today) ? acct.streak.count : 0, best: acct.streak.best || 0, reward: acct.streak.last === today ? acct.streak.reward || null : null } : { count: 0, best: 0, reward: null },
      robotLv: { ...(acct.robotLv || {}) },
      skins: [...(acct.skins || [])],
      robotSkin: { ...(acct.robotSkin || {}) },
      sets: setsStatus(acct),
      hunt: { id: huntFor(today), done: acct.huntDay === today, coins: HUNT_COINS },
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

  // Sätter en fritt beskriven attack (tolkad av Claude från spelarens egen text, se game.js) —
  // vinner över både namnet och ett ev. listval. type === null rensar bort den och går
  // tillbaka till namn/listval igen. Bygger och validerar via customWildcardSpecial, så ett
  // ogiltigt eller korrupt förslag kan aldrig komma in i kontot.
  function setCustomWildcardSpecial(acct, type, name, desc, dmg, heal, types) {
    if (count(acct, 'wildcard') < 1) return { error: 'Du äger inte den roboten än.' };
    if (type === null) {
      acct.wildcardCustomSpecial = null;
      return { special: null };
    }
    const special = customWildcardSpecial(type, name, desc, dmg, heal, types);
    if (!special) return { error: 'Kunde inte tolka ett giltigt attackslag.' };
    acct.wildcardCustomSpecial = special;
    return { special };
  }

  // Sätter hur jokern (och därmed dess attackeffekter, som ärver robotens egen färg) ser ut.
  // hex === null återställer till standardfärgen.
  function setWildcardColor(acct, hex) {
    if (count(acct, 'wildcard') < 1) return { error: 'Du äger inte den roboten än.' };
    if (hex === null) {
      acct.wildcardColor = null;
      return { color: null };
    }
    const clean = cleanColor(hex);
    if (!clean) return { error: 'Ogiltig färg.' };
    acct.wildcardColor = clean;
    return { color: clean };
  }

  // Jokerns huvudform/extradetalj — rent kosmetiskt (ritas i game.js' drawRobot, påverkar
  // ingenting i striden). hex === null återställer till standardformen/-detaljen.
  function setWildcardHead(acct, head) {
    if (count(acct, 'wildcard') < 1) return { error: 'Du äger inte den roboten än.' };
    if (head === null) {
      acct.wildcardHead = null;
      return { head: null };
    }
    if (typeof head !== 'string' || !HEAD_SHAPES.includes(head)) return { error: 'Okänd huvudform.' };
    acct.wildcardHead = head;
    return { head };
  }

  function setWildcardExtra(acct, extra) {
    if (count(acct, 'wildcard') < 1) return { error: 'Du äger inte den roboten än.' };
    if (extra === null) {
      acct.wildcardExtra = null;
      return { extra: null };
    }
    if (typeof extra !== 'string' || !EXTRA_FEATURES.includes(extra)) return { error: 'Okänd detalj.' };
    acct.wildcardExtra = extra;
    return { extra };
  }

  // ---------- Världsdelar ----------
  // Varje världsdel kan ha en beskyddare: en riktig spelare, som bara kan bli av med titeln
  // genom att förlora en live-match mot en annan spelare (aldrig mot AI). Världsdelarna låses
  // upp med nivå, så ju högre nivå du har desto mer av världen får du veta om.
  // x/y är var på kartan (i procent) världsdelen ligger.
  const CONTINENTS = [
    { id: 'europa', name: 'Europa', emoji: '🏰', level: 1, x: 47, y: 14 },
    { id: 'afrika', name: 'Afrika', emoji: '🦁', level: 3, x: 47, y: 50 },
    { id: 'asien', name: 'Asien', emoji: '🐉', level: 5, x: 74, y: 22 },
    { id: 'nordamerika', name: 'Nordamerika', emoji: '🗽', level: 8, x: 15, y: 18 },
    { id: 'sydamerika', name: 'Sydamerika', emoji: '🌋', level: 12, x: 23, y: 58 },
    { id: 'oceanien', name: 'Oceanien', emoji: '🦘', level: 16, x: 80, y: 62 },
    { id: 'antarktis', name: 'Antarktis', emoji: '🐧', level: 20, x: 50, y: 86 },
  ];
  const continentById = Object.fromEntries(CONTINENTS.map((c) => [c.id, c]));

  return {
    RARITY, ROBOTS, robotById, rankOf, BOSS_IDS, MONSTER_IDS,
    CONTINENTS, continentById,
    EQUIPMENT, SUPER_WEAPONS, SUPER_PIECE_CHANCE, addEquipment, equipItem,
    ARENAS, arenaById, pickArena,
    TYPES, typeMultiplier,
    WILDCARD_SPECIALS, wildcardSpecialFor, TYPE_DEFAULTS, customWildcardSpecial,
    HEAD_SHAPES, EXTRA_FEATURES,
    newAccount, sanitize, count, total, canStake, addRobot, removeRobot,
    rollBox, rollBoxFrom, pickOpponent, startMatch, finishMatch, openBox, claimDaily, view, nameWildcard,
    chooseWildcardSpecial, setCustomWildcardSpecial, setWildcardColor, setWildcardHead, setWildcardExtra,
    xpNeeded, addXp,
    TRADE_VALUE, tradeValue, canTradeFor, trade,
    SHOP_ITEMS, COINS, buyItem,
    QUEST_POOL, questEvent, questView,
    STREET_SLOT_MS, ELITE_LEVEL, CHAMPION_LEVEL, streetSlot, streetRobots, streetChallengers,
    TOWER_LEVEL, TOWER_TOP, TOWER_PRIZE_EVERY, towerOpponent, towerCoins,
    MEDALS, awardMedals,
    WEEKLY_TOP, WEEKLY_TOP_COINS, WEEKLY_TOP_BOXES, weekOf, weeklyOpponent, weeklyFloor,
    ROBOT_MAX_LV, upgradeCost, levelUpDef, upgradeRobot,
    SKINS, skinById, buySkin, setSkin,
    ITEM_LOOK, SETS, setsStatus, huntFor, HUNT_COINS, STREAK_MILESTONES,
  };
});
