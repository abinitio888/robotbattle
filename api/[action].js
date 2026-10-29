// Kontorelaterade rutter som inte hör till jokern, en match eller vänmatchen: inloggning,
// konto, dagliga lådan, utrustning och att importera en gästsamling. Samlade i EN serverlös
// funktion (se dispatch() i _lib.js) för att hålla sig inom Vercels gräns på 12 funktioner.
const crypto = require('crypto');
const {
  dispatch, acctAction, requireSession, getUser, saveUser, makePassword, checkPassword,
  validateCredentials, createSession, destroySession, cookieHeader, tooMany, acctView,
  clock, randomFloat, S, HttpError,
} = require('./_lib.js');

function dummyScrypt() {
  return new Promise((resolve) => crypto.scrypt('x', Buffer.alloc(16), 64, () => resolve()));
}

function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

module.exports = dispatch({
  me: {
    method: 'GET',
    async handler(req) {
      const session = await requireSession(req);
      return { username: session.user.name, acct: acctView(session.user) };
    },
  },

  register: {
    method: 'POST',
    async handler(req, res, body) {
      const { username, password } = validateCredentials(body);
      const key = username.toLowerCase();
      // Bara lyckade registreringar räknas mot gränsen, så en felstavning låser aldrig ute
      // en ny användare. Anti-spam-skyddet mot massregistrering sitter här i stället.
      if (await tooMany(`reg:${clientIp(req)}`, 10, 3600)) throw new HttpError(429, 'För många nya konton härifrån. Vänta en stund.');
      if (await getUser(key)) throw new HttpError(409, 'Användarnamnet är upptaget.');
      const { salt, hash } = await makePassword(password);
      const user = { name: username, salt, hash, created: Date.now(), acct: S.newAccount() };
      await saveUser(key, user);
      const token = await createSession(key);
      res.setHeader('Set-Cookie', cookieHeader(req, token, 30 * 24 * 3600));
      return { username, acct: acctView(user) };
    },
  },

  login: {
    method: 'POST',
    async handler(req, res, body) {
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const key = username.toLowerCase();
      if ((await tooMany(`login:${clientIp(req)}`, 20, 600)) || (await tooMany(`login:${key}`, 8, 600))) {
        throw new HttpError(429, 'För många försök. Vänta en stund.');
      }
      const user = await getUser(key);
      // Kör alltid en hash så att svarstiden inte avslöjar om användarnamnet finns.
      const ok = user ? await checkPassword(user, password) : (await dummyScrypt(), false);
      if (!ok) throw new HttpError(401, 'Fel användarnamn eller lösenord.');
      const token = await createSession(key);
      res.setHeader('Set-Cookie', cookieHeader(req, token, 30 * 24 * 3600));
      return { username: user.name, acct: acctView(user) };
    },
  },

  logout: {
    method: 'POST',
    async handler(req, res) {
      const session = await requireSession(req).catch(() => null);
      if (session) await destroySession(session.token);
      res.setHeader('Set-Cookie', cookieHeader(req, '', 0));
      return { ok: true };
    },
  },

  select: {
    method: 'POST',
    handler: acctAction((acct, body) => {
      if (S.count(acct, body.robot) > 0) acct.selected = body.robot;
      return {};
    }),
  },

  equip: {
    method: 'POST',
    handler: acctAction((acct, body) => S.equipItem(acct, typeof body.itemId === 'string' ? body.itemId : null)),
  },

  // Butiken — se buyItem() i shared.js. Mynten finns bara på servern.
  buy: {
    method: 'POST',
    handler: acctAction((acct, body) => S.buyItem(acct, typeof body.itemId === 'string' ? body.itemId : null)),
  },

  // Byteshandel med Handlaren — se trade() i shared.js.
  trade: {
    method: 'POST',
    handler: acctAction((acct, body) => S.trade(acct, body.give, typeof body.want === 'string' ? body.want : null)),
  },

  'box-open': {
    method: 'POST',
    async handler(req) {
      const session = await requireSession(req);
      const prize = S.openBox(session.user.acct, randomFloat, clock().today);
      if (!prize) throw new HttpError(400, 'Du har inga lådor.');
      await saveUser(session.key, session.user);
      return { acct: acctView(session.user), prize };
    },
  },

  'daily-claim': {
    method: 'POST',
    async handler(req) {
      const session = await requireSession(req);
      const ok = S.claimDaily(session.user.acct, clock().today);
      if (ok) await saveUser(session.key, session.user);
      return { acct: acctView(session.user), ok };
    },
  },

  // Lägger en gäst-samling (sparad i klientens webbläsare) till kontot. Insatsen skickas av
  // klienten och är alltså inte pålitlig i sig — hårt begränsad här så ingen kan hitta på en
  // jättesamling åt sig själv. Additivt: kan inte ta bort robotar, bara lägga till.
  'import-guest': {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const IMPORT_MAX_PER_ROBOT = 50;
      const IMPORT_MAX_ROBOTS = 200;
      const IMPORT_MAX_BOXES = 50;
      const inv = body.inv && typeof body.inv === 'object' && !Array.isArray(body.inv) ? body.inv : {};
      const boxes = Math.min(IMPORT_MAX_BOXES, Math.max(0, Math.floor(Number(body.boxes)) || 0));
      const toAdd = {};
      let total = 0;
      for (const id of Object.keys(S.robotById)) {
        const n = Math.min(IMPORT_MAX_PER_ROBOT, Math.max(0, Math.floor(Number(inv[id])) || 0));
        if (n > 0) { toAdd[id] = n; total += n; }
      }
      if (total > IMPORT_MAX_ROBOTS) throw new HttpError(400, `Kan bara importera upp till ${IMPORT_MAX_ROBOTS} robotar åt gången.`);
      for (const [id, n] of Object.entries(toAdd)) {
        for (let i = 0; i < n; i++) S.addRobot(session.user.acct, id);
      }
      session.user.acct.boxes += boxes;
      await saveUser(session.key, session.user);
      return { acct: acctView(session.user), imported: { inv: toAdd, boxes } };
    },
  },
});
