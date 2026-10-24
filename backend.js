// Två sätt att spara och styra spelarens konto, med samma anrop:
//  - LocalBackend: allt sparas i webbläsaren (spela utan konto, funkar utan server).
//  - RemoteBackend: kontot ligger på servern och alla ändringar går via API:t.
// Alla metoder returnerar { acct, ... } där acct är kontot enligt Shared.view.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./shared.js'));
  else root.Backend = factory(root.Shared);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';

  const STORE_KEY = 'robotbattle.v2';
  const OLD_STORE_KEY = 'robotbattle.v1';

  function todayKey() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function minutesToMidnight() {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return Math.ceil((midnight - now) / 60000);
  }

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (e) {
      return null;
    }
  }

  // Läser gästsamlingen som sparats i den här webbläsaren, utan att skapa en LocalBackend.
  // Används för att erbjuda "importera till kontot" efter inloggning. Ger null om det inte
  // finns något utöver startroboten (inget värt att importera).
  function readGuestSave() {
    const v2 = readJson(STORE_KEY);
    const v1 = v2 ? null : readJson(OLD_STORE_KEY);
    let acct = null;
    if (v2) acct = S.sanitize(v2);
    else if (v1 && Array.isArray(v1.owned)) acct = S.sanitize({ inv: Object.fromEntries(v1.owned.map((id) => [id, 1])) });
    if (!acct) return null;
    const onlyDefault = acct.boxes === 0 && Object.keys(acct.inv).length === 1 && acct.inv.bolt === 1;
    return onlyDefault ? null : acct;
  }

  function clearGuestSave() {
    try {
      localStorage.removeItem(STORE_KEY);
    } catch (e) {
      // Ingen fara att låta den vara kvar om den inte går att rensa.
    }
  }

  class LocalBackend {
    constructor() {
      this.kind = 'local';
      this.username = null;
      this.acct = S.newAccount();
      this.match = null;
    }

    view() {
      return S.view(this.acct, todayKey(), minutesToMidnight());
    }

    save() {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.acct));
      } catch (e) {
        // Sparning är valfri, till exempel i privat läge.
      }
    }

    async load() {
      const v2 = readJson(STORE_KEY);
      const v1 = v2 ? null : readJson(OLD_STORE_KEY);
      if (v2) {
        this.acct = S.sanitize(v2);
      } else if (v1 && Array.isArray(v1.owned)) {
        this.acct = S.sanitize({ inv: Object.fromEntries(v1.owned.map((id) => [id, 1])), selected: v1.selected });
      }
      return { acct: this.view() };
    }

    async select(robot) {
      if (S.count(this.acct, robot) > 0) this.acct.selected = robot;
      this.save();
      return { acct: this.view() };
    }

    async startMatch(robot, mode, bossId, monsterId) {
      const match = S.startMatch(this.acct, robot, mode, Math.random, bossId, monsterId);
      if (match.error) throw new Error(match.error);
      this.match = match;
      this.save();
      return { acct: this.view(), match: { token: 'local', ...match } };
    }

    async equipItem(itemId) {
      const result = S.equipItem(this.acct, itemId);
      if (result.error) throw new Error(result.error);
      this.save();
      return { acct: this.view() };
    }

    async finishMatch(match, won) {
      if (!this.match) throw new Error('Ingen match pågår.');
      const result = S.finishMatch(this.acct, this.match, won, Math.random);
      this.match = null;
      this.save();
      return { acct: this.view(), result };
    }

    async openBox() {
      const prize = S.openBox(this.acct, Math.random);
      if (!prize) throw new Error('Du har inga lådor.');
      this.save();
      return { acct: this.view(), prize };
    }

    async claimDaily() {
      const ok = S.claimDaily(this.acct, todayKey());
      this.save();
      return { acct: this.view(), ok };
    }

    async nameWildcard(name) {
      const result = S.nameWildcard(this.acct, name);
      if (result.error) throw new Error(result.error);
      this.save();
      return { acct: this.view() };
    }

    async chooseWildcardSpecial(type) {
      const result = S.chooseWildcardSpecial(this.acct, type);
      if (result.error) throw new Error(result.error);
      this.save();
      return { acct: this.view() };
    }

    async setCustomWildcardAttack(type, name, desc, dmg, heal, types) {
      const result = S.setCustomWildcardSpecial(this.acct, type, name, desc, dmg, heal, types);
      if (result.error) throw new Error(result.error);
      this.save();
      return { acct: this.view() };
    }

    async setWildcardColor(hex) {
      const result = S.setWildcardColor(this.acct, hex);
      if (result.error) throw new Error(result.error);
      this.save();
      return { acct: this.view() };
    }

    async setWildcardHead(head) {
      const result = S.setWildcardHead(this.acct, head);
      if (result.error) throw new Error(result.error);
      this.save();
      return { acct: this.view() };
    }

    async setWildcardExtra(extra) {
      const result = S.setWildcardExtra(this.acct, extra);
      if (result.error) throw new Error(result.error);
      this.save();
      return { acct: this.view() };
    }
  }

  class RemoteBackend {
    constructor() {
      this.kind = 'remote';
      this.username = null;
    }

    async api(path, body) {
      const options = { credentials: 'same-origin' };
      if (body !== undefined) {
        options.method = 'POST';
        options.headers = { 'Content-Type': 'application/json' };
        options.body = JSON.stringify(body);
      }
      const res = await fetch(path, options);
      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        // Svar utan JSON hanteras nedan.
      }
      if (!res.ok) {
        const err = new Error((data && data.error) || `Serverfel (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return data;
    }

    // Returnerar { acct } om man är inloggad, annars null.
    async me() {
      try {
        const data = await this.api('/api/me');
        this.username = data.username;
        return { acct: data.acct };
      } catch (e) {
        if (e.status === 401) return null;
        throw e;
      }
    }

    async register(username, password) {
      const data = await this.api('/api/register', { username, password });
      this.username = data.username;
      return { acct: data.acct };
    }

    async login(username, password) {
      const data = await this.api('/api/login', { username, password });
      this.username = data.username;
      return { acct: data.acct };
    }

    async logout() {
      await this.api('/api/logout', {});
      this.username = null;
    }

    select(robot) { return this.api('/api/select', { robot }); }
    startMatch(robot, mode, bossId, monsterId) { return this.api('/api/match/start', { robot, mode, bossId, monsterId }); }
    finishMatch(match, won) { return this.api('/api/match/finish', { token: match.token, won }); }
    openBox() { return this.api('/api/box-open', {}); }
    claimDaily() { return this.api('/api/daily-claim', {}); }
    nameWildcard(name) { return this.api('/api/wildcard/name', { name }); }
    chooseWildcardSpecial(type) { return this.api('/api/wildcard/special', { type }); }
    importGuest(inv, boxes) { return this.api('/api/import-guest', { inv, boxes }); }
    equipItem(itemId) { return this.api('/api/equip', { itemId }); }
    setCustomWildcardAttack(type, name, desc, dmg, heal, types) { return this.api('/api/wildcard/attack', { type, name, desc, dmg, heal, types }); }
    setWildcardColor(hex) { return this.api('/api/wildcard/color', { hex }); }
    setWildcardHead(head) { return this.api('/api/wildcard/head', { head }); }
    setWildcardExtra(extra) { return this.api('/api/wildcard/extra', { extra }); }
  }

  // Används bara av Claude-artefaktversionen (ingen egen server där): sparar kontot i
  // artefaktens egen delade databas, under den här tittarens privata data/users/<id>/-gren
  // (ingen annan — inte ens artefaktens ägare — kan läsa den grenen). Samma anropsmönster
  // som LocalBackend, bara att save() skriver till db i stället för localStorage.
  class ArtifactBackend {
    constructor() {
      this.kind = 'artifact';
      this.username = null;
      this.acct = S.newAccount();
      this.match = null;
      this.ref = null;
    }

    view() {
      return S.view(this.acct, todayKey(), minutesToMidnight());
    }

    async save() {
      if (!this.ref) return;
      try {
        await this.ref.set(this.acct);
      } catch (e) {
        // Spar-fel (t.ex. tillfälligt frånkopplad) — spelet funkar ändå vidare under
        // sessionen, bara att det senaste draget inte hann sparas.
      }
    }

    // Letar upp claude.use('db')/('user') och antingen den här tittarens sparfil eller
    // skapar en ny. Kastar om artefakt-körtiden saknas helt, eller tittaren saknar en
    // egen identitet här — game.js fångar det och faller tillbaka på LocalBackend (gäst,
    // sparas bara i den här webbläsaren).
    async load() {
      if (!window.claude || typeof window.claude.use !== 'function') throw new Error('Artefakt-körtiden saknas.');
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      if (!db || !user) throw new Error('db-funktionen är inte tillgänglig här.');
      const id = await user.id();
      if (!id) throw new Error('Ingen egen identitet att spara mot här.');
      this.ref = db.doc(`data/users/${id}/save`);
      const snap = await this.ref.get();
      if (snap.exists) {
        this.acct = S.sanitize(snap.data());
      } else {
        this.acct = S.newAccount();
        await this.ref.set(this.acct);
      }
      return { acct: this.view() };
    }

    async select(robot) {
      if (S.count(this.acct, robot) > 0) this.acct.selected = robot;
      await this.save();
      return { acct: this.view() };
    }

    async startMatch(robot, mode, bossId, monsterId) {
      const match = S.startMatch(this.acct, robot, mode, Math.random, bossId, monsterId);
      if (match.error) throw new Error(match.error);
      this.match = match;
      await this.save();
      return { acct: this.view(), match: { token: 'artifact', ...match } };
    }

    async equipItem(itemId) {
      const result = S.equipItem(this.acct, itemId);
      if (result.error) throw new Error(result.error);
      await this.save();
      return { acct: this.view() };
    }

    async finishMatch(match, won) {
      if (!this.match) throw new Error('Ingen match pågår.');
      const result = S.finishMatch(this.acct, this.match, won, Math.random);
      this.match = null;
      await this.save();
      return { acct: this.view(), result };
    }

    async openBox() {
      const prize = S.openBox(this.acct, Math.random);
      if (!prize) throw new Error('Du har inga lådor.');
      await this.save();
      return { acct: this.view(), prize };
    }

    async claimDaily() {
      const ok = S.claimDaily(this.acct, todayKey());
      await this.save();
      return { acct: this.view(), ok };
    }

    async nameWildcard(name) {
      const result = S.nameWildcard(this.acct, name);
      if (result.error) throw new Error(result.error);
      await this.save();
      return { acct: this.view() };
    }

    async chooseWildcardSpecial(type) {
      const result = S.chooseWildcardSpecial(this.acct, type);
      if (result.error) throw new Error(result.error);
      await this.save();
      return { acct: this.view() };
    }

    async setCustomWildcardAttack(type, name, desc, dmg, heal, types) {
      const result = S.setCustomWildcardSpecial(this.acct, type, name, desc, dmg, heal, types);
      if (result.error) throw new Error(result.error);
      await this.save();
      return { acct: this.view() };
    }

    async setWildcardColor(hex) {
      const result = S.setWildcardColor(this.acct, hex);
      if (result.error) throw new Error(result.error);
      await this.save();
      return { acct: this.view() };
    }

    async setWildcardHead(head) {
      const result = S.setWildcardHead(this.acct, head);
      if (result.error) throw new Error(result.error);
      await this.save();
      return { acct: this.view() };
    }

    async setWildcardExtra(extra) {
      const result = S.setWildcardExtra(this.acct, extra);
      if (result.error) throw new Error(result.error);
      await this.save();
      return { acct: this.view() };
    }
  }

  // ---------- Vänmatch utan Claude-sidan: samma "room"-form, men genom FRÅGNING ----------
  // Claude-sidans vänmatchskod (game.js) pratar bara med ett objekt format som
  // claude.use('room') ger: join(namn) -> {emit, on, presence, peers, onPeers, leave,
  // connected}. Den här funktionen ger exakt samma form, men genom att regelbundet FRÅGA
  // den här sidans egna /api/room/*-rutter i stället för en ständigt öppen uppkoppling —
  // en serverlös funktion (se api/room/*.js) kan inte hålla en websocket vid liv mellan
  // anrop, så rummet ligger i en delad databas och klienten pollar efter nytt. Något
  // långsammare än en riktig websocket, men samma "room"-form, så game.js:s
  // vänmatchskod används oförändrad oavsett källa.
  const POLL_MS = 200;

  function normalizePollPeer(p) {
    return {
      peer: String(p.id), by: null, isMe: !!p.isMe, sameTab: !!p.isMe, kind: 'viewer', guest: false,
      presence: (p.presence && typeof p.presence === 'object') ? p.presence : {}, updatedAt: Date.now(),
    };
  }

  async function roomApi(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (e) { /* inget JSON-svar */ }
    if (!res.ok) throw new Error((data && data.error) || `Serverfel (${res.status})`);
    return data;
  }

  function makePollNamedRoom(name, peerId, initialPeers, initialCursor) {
    let cursor = initialCursor;
    let lastPeers = initialPeers.map(normalizePollPeer);
    let connected = true;
    let stopped = false;
    const topicFns = new Map();
    const peerFns = new Set();
    const connFns = new Set();

    function setConnected(next) {
      if (connected === next) return;
      connected = next;
      for (const fn of connFns) fn(connected);
    }

    async function pollOnce() {
      if (stopped) return;
      try {
        const url = `/api/room/poll?room=${encodeURIComponent(name)}&peerId=${encodeURIComponent(peerId)}&cursor=${cursor}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('poll_failed');
        const data = await res.json();
        cursor = data.cursor;
        lastPeers = (data.peers || []).map(normalizePollPeer);
        for (const fn of peerFns) fn({ peers: lastPeers });
        for (const ev of data.events || []) {
          const fns = topicFns.get(ev.topic);
          if (!fns) continue;
          const isMe = ev.peerId === peerId;
          for (const fn of fns) fn({ topic: ev.topic, data: ev.data, isMe, sameTab: isMe, peer: null, by: null, kind: 'viewer', guest: false });
        }
        setConnected(true);
      } catch (e) {
        setConnected(false);
      }
      if (!stopped) setTimeout(pollOnce, POLL_MS);
    }
    setTimeout(pollOnce, POLL_MS);

    return {
      name,
      async emit(topic, data) { await roomApi('/api/room/emit', { room: name, peerId, topic, data }); },
      on(topic, fn) {
        if (!topicFns.has(topic)) topicFns.set(topic, new Set());
        topicFns.get(topic).add(fn);
        return () => { const s = topicFns.get(topic); if (s) s.delete(fn); };
      },
      async presence(patch) { await roomApi('/api/room/presence', { room: name, peerId, patch }); },
      peers() { return lastPeers; },
      onPeers(fn) { peerFns.add(fn); fn({ peers: lastPeers }); return () => peerFns.delete(fn); },
      connected() { return connected; },
      onConnection(fn) { connFns.add(fn); fn(connected); return () => connFns.delete(fn); },
      async leave() { stopped = true; await roomApi('/api/room/leave', { room: name, peerId }); },
    };
  }

  // Löser till ett "room"-likt objekt om den här sidan faktiskt har egna /api/room/*-rutter
  // att fråga (t.ex. på en riktig driftsatt adress), annars kastar den (t.ex. på GitHub
  // Pages, som bara kan visa sidor) — samma avslag som claude.use('room') ger null, bara
  // att boot() i game.js hanterar båda på samma sätt.
  async function connectPollRoom() {
    if (typeof fetch === 'undefined') throw new Error('no_fetch');
    return {
      async join(name) {
        const data = await roomApi('/api/room/join', { room: name });
        return makePollNamedRoom(name, data.peerId, data.peers || [], data.cursor || 0);
      },
    };
  }

  return { LocalBackend, RemoteBackend, ArtifactBackend, readGuestSave, clearGuestSave, connectPollRoom };
});
