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

    async startMatch(robot, mode, bossId) {
      const match = S.startMatch(this.acct, robot, mode, Math.random, bossId);
      if (match.error) throw new Error(match.error);
      this.match = match;
      this.save();
      return { acct: this.view(), match: { token: 'local', ...match } };
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
    startMatch(robot, mode, bossId) { return this.api('/api/match/start', { robot, mode, bossId }); }
    finishMatch(match, won) { return this.api('/api/match/finish', { token: match.token, won }); }
    openBox() { return this.api('/api/box/open', {}); }
    claimDaily() { return this.api('/api/daily/claim', {}); }
    nameWildcard(name) { return this.api('/api/wildcard/name', { name }); }
    chooseWildcardSpecial(type) { return this.api('/api/wildcard/special', { type }); }
    importGuest(inv, boxes) { return this.api('/api/import-guest', { inv, boxes }); }
  }

  return { LocalBackend, RemoteBackend, readGuestSave, clearGuestSave };
});
