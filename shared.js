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
    {
      id: 'seraph', name: 'Seraph', rarity: 'divine', types: ['fe', 'flygande'],
      color: '#fffbe8', accent: '#3ee8ff', eye: '#ffd93d', head: 'crown', extra: 'jet',
      scale: 1.15, hp: 120, speed: 255, punch: 10,
      special: { type: 'halo', name: 'Gloria', dmg: 24, heal: 15, desc: 'En ljusring sprider sig längs golvet åt alla håll och läker Seraph med 15 HP. Hoppa över den!' },
    },
    {
      id: 'atlas', name: 'Atlas', rarity: 'divine', types: ['stål', 'strid'],
      color: '#3a4256', accent: '#3ee8ff', eye: '#ffffff', head: 'horn', extra: 'shoulders',
      scale: 1.25, hp: 135, speed: 220, punch: 12,
      special: { type: 'quake', name: 'Jordbävning', dmg: 13, desc: 'Tre skalv över hela banan. Står du på marken när det smäller tar du skada — hoppa i rätt ögonblick!' },
    },
    {
      id: 'eclipse', name: 'Eclipse', rarity: 'divine', types: ['mörk', 'psykisk'],
      color: '#120d24', accent: '#3ee8ff', eye: '#ff5fd2', head: 'hood', extra: 'cape',
      scale: 1.1, hp: 115, speed: 265, punch: 10,
      special: { type: 'blackhole', name: 'Svart hål', dmg: 6, blast: 22, desc: 'Ett svart hål suger in motståndaren och skadar hela tiden, och imploderar sedan. Spring därifrån!' },
    },
    // Monstervärlden: en helt egen sorts motståndare, skild från robotarna — går aldrig att få
    // av en låda eller möta i en vanlig match (precis som bossar), men går heller aldrig in i
    // samlingen om man vinner. Vinner man får man ALLTID ett bestämt utrustningsföremål (drop
    // nedan) — alltså vet man i förväg exakt vad man får, ingen slump där. Dessutom finns
    // alltid en liten chans (MEGA_FRAGMENT_CHANCE) att ÄVEN få en bit av Megavapnet, oavsett
    // vilket monster man besegrar — se EQUIPMENT/MEGA_WEAPON längre ner. Utmanas från en egen
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
      id: 'sumpdrake', name: 'Sumpdrake', rarity: 'monster', monster: true, types: ['gift', 'vatten'], drop: 'servoarms',
      color: '#4a7a5a', accent: '#1a3a28', eye: '#c8ff6b', head: 'horn', extra: 'fins',
      scale: 1.15, hp: 130, speed: 190, punch: 9,
      special: { type: 'poison', name: 'Giftmoln', dmg: 12, desc: 'Släpper ett moln som skadar över tid.' },
    },
    {
      id: 'nattuggla', name: 'Nattuggla', rarity: 'monster', monster: true, types: ['mörk', 'flygande'], drop: 'turbofeet',
      color: '#3a3450', accent: '#15121f', eye: '#ffd93d', head: 'round', extra: 'jet',
      scale: 0.9, hp: 95, speed: 270, punch: 7,
      special: { type: 'snipe', name: 'Nattprick', dmg: 40, desc: 'Siktar med laser, sedan träffar den hårt.' },
    },
    {
      id: 'lavagolem', name: 'Lavagolem', rarity: 'monster', monster: true, types: ['eld', 'sten'], drop: 'steelshield',
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
      id: 'mygghärva', name: 'Mygghärva', rarity: 'monster', monster: true, types: ['kryp', 'gift'], drop: 'lightrig',
      color: '#8acc3a', accent: '#2a4a0a', eye: '#ff3030', head: 'cyclops', extra: 'fins',
      scale: 0.85, hp: 85, speed: 280, punch: 6,
      special: { type: 'spread', name: 'Svärmanfall', dmg: 7, desc: 'Tre skott i solfjäder.' },
    },
    {
      id: 'djupvakt', name: 'Djupvakt', rarity: 'monster', monster: true, types: ['vatten', 'spöke'], drop: 'platearmor',
      color: '#2a5a7a', accent: '#0f2a3a', eye: '#7fffd4', head: 'hood', extra: 'fins',
      scale: 1.15, hp: 125, speed: 170, punch: 9,
      special: { type: 'grapple', name: 'Djupkrok', dmg: 16, desc: 'En krok som drar in motståndaren och slår till.' },
    },
    {
      id: 'taggormen', name: 'Taggormen', rarity: 'monster', monster: true, types: ['gift', 'mark'], drop: 'fangblade',
      color: '#7a3a8a', accent: '#2a0f3a', eye: '#c8ff6b', head: 'horn', extra: 'spikes',
      scale: 1.05, hp: 115, speed: 210, punch: 10,
      special: { type: 'meteorslam', name: 'Taggregn', dmg: 24, desc: 'Slår ner en jättesmäll där motståndaren står.' },
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
    // Megavapnet går aldrig att få direkt — bara genom att sätta ihop MEGA_WEAPON_PIECES
    // delar, som var och en kan droppa (utöver det bestämda föremålet) efter EN monstervinst,
    // oavsett vilket monster, se MEGA_FRAGMENT_CHANCE och finishMatch().
    { id: 'megavapen', name: 'Megavapnet', stat: { hp: 20, punch: 6, speed: 15 }, desc: 'Sätts ihop av fem delar — +20 HP, +6 i slagstyrka och +15 i fart samtidigt, så länge det bärs.' },
  ];
  const EQUIPMENT_IDS = new Set(EQUIPMENT.map((e) => e.id));
  const MEGA_WEAPON_ID = 'megavapen';
  const MEGA_WEAPON_PIECES = 5;
  const MEGA_FRAGMENT_CHANCE = 0.15; // 15 % chans per monstervinst, oavsett vilket monster

  const robotById = Object.fromEntries(ROBOTS.map((r) => [r.id, r]));
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
    // monster: true → ingår aldrig i den SLUMPADE poolen (pickArena) för vanliga matcher, bara
    // tvingas fram uttryckligen för monsterstrider (se startMatch i game.js) — "en annan värld",
    // inte en bana som kan dyka upp av en slump mitt i en robotmatch.
    {
      id: 'direworld', name: 'Monstervärlden', hint: '', monster: true,
      gravityMul: 1, speedMul: 1, dmgMul: 1,
      sky: '#1a0f08', ground: '#0a0503', line: '#5a3a1a',
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
      equipmentInv: {}, equippedItem: null, megaFragments: 0,
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
      equipmentInv: {}, equippedItem: null, megaFragments: 0,
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
      acct.megaFragments = Math.max(0, Math.min(MEGA_WEAPON_PIECES - 1, Math.floor(Number(raw.megaFragments)) || 0));
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

  // Startar en match. Insatsen dras direkt, så det går inte att smita undan en förlust. Alla
  // bossar går att utmana när som helst, oavsett nivå, och om och om igen — vilken av dem
  // man möter slumpas. Ingen insats sätts på spel mot en boss. Monster fungerar likadant
  // (monsterId väljer vilket) — helt skild meny, egen ekonomi (se finishMatch), ingen insats.
  function startMatch(acct, robotId, mode, rng, monsterId) {
    if (!robotById[robotId] || count(acct, robotId) < 1) return { error: 'Du äger inte den roboten.' };
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
  // just det monstret ger (def.drop, aldrig slumpat), plus en liten chans (MEGA_FRAGMENT_CHANCE)
  // att ÄVEN hitta en bit av Megavapnet. Helt egen, parallell ekonomi; förlorar man kostar det
  // inget, precis som mot en boss.
  // rng behövs bara vid vinst (för ett eventuellt nivåpris/föremål/Megavapen-bit) — vänmatcher
  // anropar aldrig den här funktionen.
  function finishMatch(acct, match, won, rng) {
    if (match.monster) {
      const result = {
        won, stake: false, gained: null, lost: null, box: false, levelUps: [], bossWon: null,
        itemWon: null, fragmentWon: false, megaFragments: acct.megaFragments || 0, megaAssembled: false,
      };
      if (won) {
        const drop = robotById[match.opp] && robotById[match.opp].drop;
        if (drop) {
          addEquipment(acct, drop);
          result.itemWon = drop;
        }
        if (rng() < MEGA_FRAGMENT_CHANCE) {
          result.fragmentWon = true;
          acct.megaFragments = (acct.megaFragments || 0) + 1;
          if (acct.megaFragments >= MEGA_WEAPON_PIECES) {
            acct.megaFragments -= MEGA_WEAPON_PIECES;
            addEquipment(acct, MEGA_WEAPON_ID);
            result.megaAssembled = true;
          }
          result.megaFragments = acct.megaFragments;
        }
      }
      return result;
    }
    const result = { won, stake: match.stake, gained: null, lost: null, box: won, levelUps: [], bossWon: null, itemWon: null };
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
      wildcardCustomSpecial: acct.wildcardCustomSpecial || null,
      wildcardColor: acct.wildcardColor || null,
      wildcardHead: acct.wildcardHead || null,
      wildcardExtra: acct.wildcardExtra || null,
      equipmentInv: { ...(acct.equipmentInv || {}) },
      equippedItem: acct.equippedItem || null,
      megaFragments: acct.megaFragments || 0,
      megaWeaponPieces: MEGA_WEAPON_PIECES,
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

  return {
    RARITY, ROBOTS, robotById, rankOf, BOSS_IDS, MONSTER_IDS,
    EQUIPMENT, MEGA_WEAPON_ID, MEGA_WEAPON_PIECES, MEGA_FRAGMENT_CHANCE, addEquipment, equipItem,
    ARENAS, arenaById, pickArena,
    TYPES, typeMultiplier,
    WILDCARD_SPECIALS, wildcardSpecialFor, TYPE_DEFAULTS, customWildcardSpecial,
    HEAD_SHAPES, EXTRA_FEATURES,
    newAccount, sanitize, count, total, canStake, addRobot, removeRobot,
    rollBox, rollBoxFrom, pickOpponent, startMatch, finishMatch, openBox, claimDaily, view, nameWildcard,
    chooseWildcardSpecial, setCustomWildcardSpecial, setWildcardColor, setWildcardHead, setWildcardExtra,
    xpNeeded, addXp,
  };
});
