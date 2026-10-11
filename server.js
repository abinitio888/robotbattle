'use strict';

// Robotbattle-server: konton, sparad samling och rum för vänmatcher.
// Starta med `npm start` och öppna http://localhost:3000.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const S = require('./shared.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TIME_ZONE = process.env.GAME_TZ || 'Europe/Stockholm';
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const MAX_USERS = 5000;
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MIN_MATCH_MS = 5000;
const IMPORT_MAX_PER_ROBOT = 50;   // gräns per robotslag vid import av en gästsamling
const IMPORT_MAX_ROBOTS = 200;     // gräns på totalen, så en klient inte kan hitta på en jättesamling
const IMPORT_MAX_BOXES = 50;
const INPUT_DELAY = 6;
const ROOM_WAIT_MS = 10 * 60 * 1000;

const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/game.js': ['game.js', 'text/javascript; charset=utf-8'],
  '/shared.js': ['shared.js', 'text/javascript; charset=utf-8'],
  '/backend.js': ['backend.js', 'text/javascript; charset=utf-8'],
  '/netplay.js': ['netplay.js', 'text/javascript; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self' ws: wss:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

// ---------- Databas (en JSON-fil, sparas med kort fördröjning) ----------
let db = { users: {}, sessions: {} };

function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  db.users = db.users || {};
  db.sessions = db.sessions || {};
}

function saveNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 200);
}

// ---------- Tid (dagliga lådan följer svensk tid som standard) ----------
const dateFormat = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function clock() {
  const parts = Object.fromEntries(dateFormat.formatToParts(new Date()).map((p) => [p.type, p.value]));
  return {
    today: `${parts.year}-${parts.month}-${parts.day}`,
    minutesToNext: 24 * 60 - (Number(parts.hour) * 60 + Number(parts.minute)),
  };
}

const randomFloat = () => crypto.randomInt(0, 2 ** 32) / 2 ** 32;

// ---------- Lösenord och sessioner ----------
function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function makePassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function checkPassword(user, password) {
  const hash = await scrypt(password, Buffer.from(user.salt, 'hex'));
  return crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function createSession(userKey) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.sessions[sha(token)] = { user: userKey, exp: Date.now() + SESSION_MS };
  saveSoon();
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionOf(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const session = db.sessions[sha(token)];
  if (!session || session.exp < Date.now()) return null;
  const user = db.users[session.user];
  return user ? { key: session.user, user, tokenHash: sha(token) } : null;
}

function cookieHeader(req, token, maxAgeSeconds) {
  const secure = SECURE_COOKIE || req.headers['x-forwarded-proto'] === 'https';
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

// ---------- Begränsningar mot gissning av lösenord ----------
const hits = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, list] of hits) if (!list.some((t) => now - t < 3600 * 1000)) hits.delete(key);
  for (const [key, s] of Object.entries(db.sessions)) if (s.exp < now) delete db.sessions[key];
  for (const [token, m] of matches) if (now - m.startedAt > 30 * 60 * 1000) matches.delete(token);
  for (const [code, room] of rooms) if (!room.players[1] && now - room.created > ROOM_WAIT_MS) closeRoom(code, 'Rummet gick ut.');
}, 60 * 1000).unref();

// ---------- HTTP ----------
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const type = (req.headers['content-type'] || '').split(';')[0].trim();
    if (type !== 'application/json') return reject(new HttpError(415, 'Fel innehållstyp.'));
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4096) {
        reject(new HttpError(413, 'För stor förfrågan.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad');
        resolve(parsed);
      } catch (e) {
        reject(new HttpError(400, 'Ogiltig JSON.'));
      }
    });
    req.on('error', reject);
  });
}

const acctView = (user) => {
  const { today, minutesToNext } = clock();
  return S.view(user.acct, today, minutesToNext);
};

function validateCredentials(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new HttpError(400, 'Användarnamnet ska vara 3–16 tecken: bokstäver, siffror eller _.');
  }
  if (password.length < 6 || password.length > 100) throw new HttpError(400, 'Lösenordet ska vara minst 6 tecken.');
  return { username, password };
}

const matches = new Map();   // token -> { user, match, startedAt }
const activeMatch = new Map(); // användare -> token

const routes = {
  'GET /api/me': async (req, res, session) => {
    if (!session) throw new HttpError(401, 'Inte inloggad.');
    return { username: session.user.name, acct: acctView(session.user) };
  },

  'POST /api/register': async (req, res) => {
    const { username, password } = validateCredentials(await readBody(req));
    // Bara lyckade registreringar räknas mot gränsen, så en felstavning låser aldrig ute en ny
    // användare. Anti-spam-skyddet mot att skapa massor av konton sitter i stället här nedanför.
    const key = username.toLowerCase();
    if (db.users[key]) throw new HttpError(409, 'Användarnamnet är upptaget.');
    if (tooMany(`reg:${req.socket.remoteAddress}`, 10, 3600 * 1000)) throw new HttpError(429, 'För många nya konton härifrån. Vänta en stund.');
    if (Object.keys(db.users).length >= MAX_USERS) throw new HttpError(503, 'Servern är full.');
    const { salt, hash } = await makePassword(password);
    db.users[key] = { name: username, salt, hash, created: Date.now(), acct: S.newAccount() };
    const token = createSession(key);
    saveSoon();
    res.setCookie = cookieHeader(req, token, SESSION_MS / 1000);
    return { username, acct: acctView(db.users[key]) };
  },

  'POST /api/login': async (req, res) => {
    const body = await readBody(req);
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const key = username.toLowerCase();
    if (tooMany(`login:${req.socket.remoteAddress}`, 20, 10 * 60 * 1000) || tooMany(`login:${key}`, 8, 10 * 60 * 1000)) {
      throw new HttpError(429, 'För många försök. Vänta en stund.');
    }
    const user = db.users[key];
    // Kör alltid en hash så att svarstiden inte avslöjar om användarnamnet finns.
    const ok = user ? await checkPassword(user, password) : (await scrypt(password, Buffer.alloc(16)), false);
    if (!ok) throw new HttpError(401, 'Fel användarnamn eller lösenord.');
    res.setCookie = cookieHeader(req, createSession(key), SESSION_MS / 1000);
    return { username: user.name, acct: acctView(user) };
  },

  'POST /api/logout': async (req, res, session) => {
    if (session) {
      delete db.sessions[session.tokenHash];
      saveSoon();
    }
    res.setCookie = cookieHeader(req, '', 0);
    return { ok: true };
  },

  'POST /api/select': async (req, res, session) => {
    const { robot } = await readBody(req);
    if (S.count(session.user.acct, robot) > 0) {
      session.user.acct.selected = robot;
      saveSoon();
    }
    return { acct: acctView(session.user) };
  },

  'POST /api/match/start': async (req, res, session) => {
    const { robot, mode, bossId } = await readBody(req);
    const acct = session.user.acct;
    const wantMode = mode === 'stake' ? 'stake' : mode === 'boss' ? 'boss' : 'normal';
    const match = S.startMatch(acct, robot, wantMode, randomFloat, typeof bossId === 'string' ? bossId : null);
    if (match.error) throw new HttpError(400, match.error);
    const token = crypto.randomBytes(16).toString('hex');
    matches.delete(activeMatch.get(session.key));
    matches.set(token, { user: session.key, match, startedAt: Date.now() });
    activeMatch.set(session.key, token);
    saveSoon();
    return { acct: acctView(session.user), match: { token, ...match } };
  },

  'POST /api/match/finish': async (req, res, session) => {
    const { token, won } = await readBody(req);
    const entry = matches.get(token);
    if (!entry || entry.user !== session.key) throw new HttpError(400, 'Ingen match pågår.');
    if (Date.now() - entry.startedAt < MIN_MATCH_MS) throw new HttpError(400, 'Matchen var för kort.');
    matches.delete(token);
    activeMatch.delete(session.key);
    const result = S.finishMatch(session.user.acct, entry.match, won === true, randomFloat);
    saveSoon();
    return { acct: acctView(session.user), result };
  },

  'POST /api/box/open': async (req, res, session) => {
    await readBody(req);
    const prize = S.openBox(session.user.acct, randomFloat);
    if (!prize) throw new HttpError(400, 'Du har inga lådor.');
    saveSoon();
    return { acct: acctView(session.user), prize };
  },

  'POST /api/daily/claim': async (req, res, session) => {
    await readBody(req);
    const ok = S.claimDaily(session.user.acct, clock().today);
    if (ok) saveSoon();
    return { acct: acctView(session.user), ok };
  },

  'POST /api/wildcard/name': async (req, res, session) => {
    const { name } = await readBody(req);
    const result = S.nameWildcard(session.user.acct, typeof name === 'string' ? name : '');
    if (result.error) throw new HttpError(400, result.error);
    saveSoon();
    return { acct: acctView(session.user) };
  },

  'POST /api/wildcard/special': async (req, res, session) => {
    const { type } = await readBody(req);
    const result = S.chooseWildcardSpecial(session.user.acct, type === undefined ? null : type);
    if (result.error) throw new HttpError(400, result.error);
    saveSoon();
    return { acct: acctView(session.user) };
  },

  // Lägger en gäst-samling (sparad i klientens webbläsare) till kontot. Insatsen skickas av
  // klienten och är alltså inte pålitlig i sig — den begränsas hårt här så att ingen kan
  // hitta på en jättesamling åt sig själv. Additivt: kan inte ta bort robotar, bara lägga till.
  'POST /api/import-guest': async (req, res, session) => {
    const body = await readBody(req);
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
    saveSoon();
    return { acct: acctView(session.user), imported: { inv: toAdd, boxes } };
  },
};

const PUBLIC_ROUTES = new Set(['POST /api/register', 'POST /api/login', 'POST /api/logout', 'GET /api/me']);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const name = `${req.method} ${url.pathname}`;
      const handler = routes[name];
      if (!handler) throw new HttpError(404, 'Finns inte.');
      const session = sessionOf(req);
      if (!session && !PUBLIC_ROUTES.has(name)) throw new HttpError(401, 'Du måste logga in.');
      const data = await handler(req, res, session);
      return send(res, 200, data, res.setCookie ? { 'Set-Cookie': res.setCookie } : {});
    }
    const file = req.method === 'GET' ? STATIC_FILES[url.pathname] : null;
    if (!file) throw new HttpError(404, 'Finns inte.');
    return send(res, 200, fs.readFileSync(path.join(__dirname, file[0])), { 'Content-Type': file[1] });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    return send(res, 500, { error: 'Något gick fel på servern.' });
  }
});

// ---------- Vänmatcher (WebSocket) ----------
// Servern är bara en förmedlare: båda spelarna kör samma simulering och skickar
// sina knapptryckningar via servern. Vänmatcher påverkar inte någons samling.
const rooms = new Map();

function wsSend(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function newRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
    if (!rooms.has(code)) return code;
  }
}

function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  for (const p of room.players) {
    if (!p) continue;
    p.ws.room = null;
    wsSend(p.ws, { t: 'left', reason });
  }
}

function leaveRoom(ws, reason) {
  if (ws.room) closeRoom(ws.room.code, reason);
}

function startRoom(room) {
  room.rematch = [false, false];
  // Banan slumpas EN gång här och skickas med till båda spelarna — annars kan de två
  // klienternas lockstep-simulering divergera om de råkade välja olika banor var för sig.
  const arena = S.pickArena(randomFloat).id;
  // Jokerns attack beror på ägarens eget namn på den — servern räknar ut den en gång här
  // (samma delade funktion som klienten) och skickar med den, så att båda sidor i matchen
  // alltid är överens om vilken attack en jokerspelare faktiskt har, utan att avslöja namnet.
  const wildcardSpecial = (p) => (p.robot === 'wildcard' ? S.wildcardSpecialFor(p.ws.user.acct.wildcardName, p.ws.user.acct.wildcardSpecialType) : undefined);
  room.players.forEach((p, slot) => {
    wsSend(p.ws, {
      t: 'start',
      slot,
      delay: INPUT_DELAY,
      arena,
      players: room.players.map((q) => ({ name: q.name, robot: q.robot, wildcardSpecial: wildcardSpecial(q) })),
    });
  });
}

function ownedRobot(user, robot) {
  return typeof robot === 'string' && S.robotById[robot] && S.count(user.acct, robot) > 0;
}

function onMessage(ws, msg) {
  switch (msg.t) {
    case 'create': {
      leaveRoom(ws, 'Du skapade ett nytt rum.');
      if (!ownedRobot(ws.user, msg.robot)) return wsSend(ws, { t: 'error', error: 'Du äger inte den roboten.' });
      const code = newRoomCode();
      const room = { code, players: [{ ws, name: ws.user.name, robot: msg.robot, key: ws.userKey }, null], created: Date.now(), rematch: [false, false] };
      rooms.set(code, room);
      ws.room = room;
      ws.slot = 0;
      return wsSend(ws, { t: 'created', code });
    }
    case 'join': {
      const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
      const room = rooms.get(code);
      if (!room || room.players[1]) return wsSend(ws, { t: 'error', error: 'Rummet finns inte eller är fullt.' });
      if (room.players[0].key === ws.userKey) return wsSend(ws, { t: 'error', error: 'Du kan inte gå med i ditt eget rum.' });
      if (!ownedRobot(ws.user, msg.robot)) return wsSend(ws, { t: 'error', error: 'Du äger inte den roboten.' });
      leaveRoom(ws, 'Du gick med i ett annat rum.');
      room.players[1] = { ws, name: ws.user.name, robot: msg.robot, key: ws.userKey };
      ws.room = room;
      ws.slot = 1;
      return startRoom(room);
    }
    case 'in': {
      const room = ws.room;
      if (!room || !room.players[1]) return null;
      if (!Number.isInteger(msg.tick) || msg.tick < 0 || msg.tick > 1e7) return null;
      if (!Number.isInteger(msg.bits) || msg.bits < 0 || msg.bits > 31) return null;
      return wsSend(room.players[1 - ws.slot].ws, { t: 'in', tick: msg.tick, bits: msg.bits });
    }
    case 'h': {
      const room = ws.room;
      if (!room || !room.players[1] || typeof msg.h !== 'string' || msg.h.length > 64) return null;
      return wsSend(room.players[1 - ws.slot].ws, { t: 'h', tick: msg.tick, h: msg.h });
    }
    case 'rematch': {
      const room = ws.room;
      if (!room || !room.players[1]) return null;
      room.rematch[ws.slot] = true;
      if (room.rematch[0] && room.rematch[1]) return startRoom(room);
      return wsSend(room.players[1 - ws.slot].ws, { t: 'rematch' });
    }
    case 'leave':
      return leaveRoom(ws, 'Din vän lämnade.');
    default:
      return null;
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });

server.on('upgrade', (req, socket, head) => {
  const reject = (status) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return reject('404 Not Found');
  // Webbläsare skickar alltid Origin. Den måste vara samma sida, annars kan en annan webbplats
  // kapa anslutningen med din inloggning.
  if (req.headers.origin) {
    try {
      if (new URL(req.headers.origin).host !== req.headers.host) return reject('403 Forbidden');
    } catch (e) {
      return reject('403 Forbidden');
    }
  }
  const session = sessionOf(req);
  if (!session) return reject('401 Unauthorized');
  return wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = session.user;
    ws.userKey = session.key;
    ws.room = null;
    ws.alive = true;
    ws.msgCount = 0;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (data) => {
      ws.msgCount += 1;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        return;
      }
      if (msg && typeof msg === 'object') onMessage(ws, msg);
    });
    ws.on('close', () => leaveRoom(ws, 'Din vän tappade anslutningen.'));
    ws.on('error', () => ws.terminate());
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.msgCount > 200 * 5) ws.terminate();   // mer än ~200 meddelanden per sekund
    ws.msgCount = 0;
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 5000).unref();

// ---------- Start ----------
function flushAndExit() {
  if (saveTimer) clearTimeout(saveTimer);
  saveNow();
  process.exit(0);
}

if (require.main === module) {
  loadDb();
  process.on('SIGINT', flushAndExit);
  process.on('SIGTERM', flushAndExit);
  server.listen(PORT, HOST, () => {
    console.log(`Robotbattle körs på http://localhost:${PORT}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const n of list || []) if (n.family === 'IPv4' && !n.internal) console.log(`  i samma nätverk: http://${n.address}:${PORT}`);
    }
  });
}

module.exports = { server, loadDb, saveNow, db: () => db };
