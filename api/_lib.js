// Delad hjälpkod för alla serverlösa API-rutter (Vercel). Motsvarar det server.js gjorde med
// en egen, alltid körande process och en JSON-fil på disk — men här kan varje anrop hamna i en
// helt ny, tom process, så allt som ska komma ihåg något (konton, sessioner, hastighetsgränser)
// måste ligga i en riktig databas i stället: Upstash Redis, nåbar via ett vanligt HTTP-anrop
// (`@upstash/redis`), vilket passar serverlösa funktioner perfekt (ingen uppkoppling att hålla
// vid liv mellan anrop).
'use strict';

const crypto = require('crypto');
const { Redis } = require('@upstash/redis');
const S = require('../shared.js');

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const SESSION_SECONDS = 30 * 24 * 3600; // 30 dagar, samma livslängd som tidigare
const TIME_ZONE = process.env.GAME_TZ || 'Europe/Stockholm';
const MAX_USERS = 5000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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

// ---------- Lösenord ----------
function scryptAsync(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function makePassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

async function checkPassword(user, password) {
  const hash = await scryptAsync(password, Buffer.from(user.salt, 'hex'));
  return crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
}

const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function validateCredentials(body) {
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) {
    throw new HttpError(400, 'Användarnamnet ska vara 3–16 tecken: bokstäver, siffror eller _.');
  }
  if (password.length < 6 || password.length > 100) throw new HttpError(400, 'Lösenordet ska vara minst 6 tecken.');
  return { username, password };
}

// ---------- Konton (Redis: user:<key> = JSON) ----------
async function getUser(key) {
  const raw = await redis.get(`user:${key}`);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function saveUser(key, user) {
  await redis.set(`user:${key}`, JSON.stringify(user));
}

// ---------- Sessioner (Redis: session:<hash(token)> = användarnyckel, egen TTL — ersätter den
// gamla periodiska bortstädningen av utgångna sessioner, som inte går att köra i en serverlös
// funktion mellan anrop) ----------
async function createSession(userKey) {
  const token = crypto.randomBytes(32).toString('base64url');
  await redis.set(`session:${sha(token)}`, userKey, { ex: SESSION_SECONDS });
  return token;
}

async function destroySession(token) {
  await redis.del(`session:${sha(token)}`);
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function sessionOf(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const userKey = await redis.get(`session:${sha(token)}`);
  if (!userKey) return null;
  const user = await getUser(userKey);
  return user ? { key: userKey, user, token } : null;
}

function cookieHeader(req, token, maxAgeSeconds) {
  // Alltid samma ursprung (statiska filer + API på samma Vercel-domän) — HTTPS alltid på
  // Vercel, så Secure är alltid säkert att sätta, och SameSite=Strict räcker (ingen
  // tredjepartskontext att tillåta).
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}; Secure`;
}

// ---------- Hastighetsbegränsning (Redis INCR+EXPIRE — ersätter den gamla in-memory Map:en,
// som inte överlever mellan serverlösa anrop i olika processer) ----------
async function tooMany(key, max, windowSeconds) {
  const n = await redis.incr(`rl:${key}`);
  if (n === 1) await redis.expire(`rl:${key}`, windowSeconds);
  return n > max;
}

const acctView = (user) => {
  const { today, minutesToNext } = clock();
  return S.view(user.acct, today, minutesToNext);
};

// ---------- Anropsomslag: enhetlig felhantering + svar ----------
// Vercels Hobby-nivå tillåter högst 12 serverlösa funktioner per driftsättning — alldeles för
// få för en rutt per anrop (konton, jokern, rum...). dispatch() samlar flera näraliggande
// rutter i EN funktion, med vilken åtgärd som menas i webbadressens dynamiska [action]-del
// (t.ex. /api/wildcard/color -> en enda api/wildcard/[action].js, action="color"), i stället
// för en egen fil per litet anrop.
function dispatch(actions) {
  return async (req, res) => {
    try {
      const action = req.query && typeof req.query.action === 'string' ? req.query.action : null;
      const entry = action ? actions[action] : null;
      if (!entry) throw new HttpError(404, 'Finns inte.');
      if (req.method !== entry.method) {
        res.setHeader('Allow', entry.method);
        throw new HttpError(405, 'Fel metod.');
      }
      res.setHeader('Cache-Control', 'no-store');
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const data = await entry.handler(req, res, body);
      res.status(200).json(data);
    } catch (e) {
      if (e instanceof HttpError) { res.status(e.status).json({ error: e.message }); return; }
      console.error(e);
      res.status(500).json({ error: 'Något gick fel på servern.' });
    }
  };
}

async function requireSession(req) {
  const session = await sessionOf(req);
  if (!session) throw new HttpError(401, 'Du måste logga in.');
  return session;
}

// Gemensamt mönster för de enkla kontoändringarna (jokerns namn/attack/utseende, utrustning):
// kör en ren shared.js-funktion mot kontot, spara om den lyckades, svara med kontot — annars
// samma kod upprepad en gång per åtgärd.
function acctAction(fn) {
  return async (req, res, body) => {
    const session = await requireSession(req);
    const result = fn(session.user.acct, body);
    if (result && result.error) throw new HttpError(400, result.error);
    await saveUser(session.key, session.user);
    return { acct: acctView(session.user) };
  };
}

module.exports = {
  redis, HttpError, S, clock, randomFloat, MAX_USERS,
  makePassword, checkPassword, validateCredentials,
  getUser, saveUser, createSession, destroySession, sessionOf, cookieHeader,
  tooMany, acctView, dispatch, requireSession, acctAction,
};
