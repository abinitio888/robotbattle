// Världskartan: vem som beskyddar varje världsdel, och utmaningar om titeln. En utmaning
// spelas alltid live mellan två riktiga spelare (vänmatchens rum-relä, med utmaningens id som
// rumskod) — aldrig mot AI. Samlade i EN serverlös funktion (se dispatch() i _lib.js).
//
// Redis:
//   world:leaders        hash världsdel -> { key, name, robot, since }
//   seen:<användare>     senaste gången spelarens sida frågade efter kartan (ms)
//   challenge:<id>       { id, continent, from, fromName, robot, to, toName, created, status }
//   incoming:<användare> id för utmaningen som väntar på svar från den beskyddaren
//   outgoing:<användare> id för den egna senaste utmaningen
const crypto = require('crypto');
const { dispatch, requireSession, sessionOf, redis, HttpError, S, tooMany } = require('../_lib.js');

const LEADERS = 'world:leaders';
const ANSWER_SECONDS = 45;          // så länge en utmaning väntar på svar
const CHALLENGE_TTL = 20 * 60;      // hur länge en utmaning finns kvar alls
const ONLINE_MS = 20 * 1000;        // "online" = sidan har frågat efter kartan nyligen
const ABANDONED_MS = 3 * 24 * 3600 * 1000; // en beskyddare som varit borta så här länge kan ersättas

const parse = (raw) => (raw == null ? null : typeof raw === 'string' ? JSON.parse(raw) : raw);

function continentFor(user, id) {
  const c = S.continentById[id];
  if (!c) throw new HttpError(400, 'Den världsdelen finns inte.');
  if ((user.acct.level || 1) < c.level) throw new HttpError(403, `Du måste vara nivå ${c.level} för att nå ${c.name}.`);
  return c;
}

async function readLeaders() {
  const raw = (await redis.hgetall(LEADERS)) || {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = parse(v);
  return out;
}

// Man kan bara beskydda EN världsdel: tar man en ny lämnar man den gamla, som blir ledig.
async function releaseOthers(userKey, keepId) {
  const leaders = await readLeaders();
  for (const [id, l] of Object.entries(leaders)) {
    if (id !== keepId && l.key === userKey) await redis.hdel(LEADERS, id);
  }
}

async function seenAt(keys) {
  if (keys.length === 0) return {};
  const vals = await redis.mget(...keys.map((k) => `seen:${k}`));
  return Object.fromEntries(keys.map((k, i) => [k, Number(vals[i]) || 0]));
}

async function readChallenge(id) {
  if (typeof id !== 'string' || !/^[a-z0-9]{8,24}$/.test(id)) return null;
  return parse(await redis.get(`challenge:${id}`));
}

const saveChallenge = (c) => redis.set(`challenge:${c.id}`, JSON.stringify(c), { ex: CHALLENGE_TTL });

// En utmaning som ingen svarat på i tid räknas som obesvarad.
function statusOf(c) {
  if (c.status === 'pending' && Date.now() - c.created > ANSWER_SECONDS * 1000) return 'expired';
  return c.status;
}

const challengeView = (c) => ({
  id: c.id, continent: c.continent, fromName: c.fromName, robot: c.robot, toName: c.toName, status: statusOf(c),
});

module.exports = dispatch({
  state: {
    method: 'GET',
    async handler(req) {
      const session = await sessionOf(req);
      const now = Date.now();
      const level = session ? session.user.acct.level || 1 : 1;
      if (session) await redis.set(`seen:${session.key}`, now, { ex: 30 * 24 * 3600 });
      const leaders = await readLeaders();
      const seen = await seenAt([...new Set(Object.values(leaders).map((l) => l.key))]);
      // Världsdelar man inte nått än får man inte veta något om — inte ens vem som beskyddar dem.
      const continents = S.CONTINENTS.map((c) => {
        if (level < c.level) return { id: c.id, locked: true, level: c.level };
        const l = leaders[c.id];
        if (!l) return { id: c.id, leader: null };
        const last = seen[l.key] || 0;
        return {
          id: c.id,
          leader: { name: l.name, robot: l.robot, since: l.since, me: !!session && l.key === session.key },
          online: now - last < ONLINE_MS,
          abandoned: now - last > ABANDONED_MS,
        };
      });
      let incoming = null;
      let outgoing = null;
      if (session) {
        const inc = await readChallenge(await redis.get(`incoming:${session.key}`));
        if (inc && statusOf(inc) === 'pending') incoming = challengeView(inc);
        const out = await readChallenge(await redis.get(`outgoing:${session.key}`));
        if (out) outgoing = challengeView(out);
      }
      return { level, continents, incoming, outgoing, loggedIn: !!session };
    },
  },

  // Bli beskyddare av en världsdel som ingen har — eller som någon lämnat i flera dagar.
  claim: {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const c = continentFor(session.user, body.continent);
      const entry = JSON.stringify({ key: session.key, name: session.user.name, robot: session.user.acct.selected, since: Date.now() });
      const current = parse(await redis.hget(LEADERS, c.id));
      if (!current) {
        if (!(await redis.hsetnx(LEADERS, c.id, entry))) throw new HttpError(409, 'Någon hann före dig!');
      } else if (current.key === session.key) {
        await redis.hset(LEADERS, { [c.id]: entry }); // byter bara roboten som syns på kartan
      } else {
        const last = (await seenAt([current.key]))[current.key];
        if (Date.now() - last <= ABANDONED_MS) throw new HttpError(409, `${current.name} beskyddar redan ${c.name}. Utmana dem!`);
        await redis.hset(LEADERS, { [c.id]: entry });
      }
      await releaseOthers(session.key, c.id);
      return { ok: true };
    },
  },

  challenge: {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const c = continentFor(session.user, body.continent);
      if (await tooMany(`challenge:${session.key}`, 15, 600)) throw new HttpError(429, 'Du har utmanat för många gånger. Vänta en stund.');
      const leader = parse(await redis.hget(LEADERS, c.id));
      if (!leader) throw new HttpError(409, `${c.name} har ingen beskyddare. Bli beskyddare direkt!`);
      if (leader.key === session.key) throw new HttpError(409, `Du beskyddar redan ${c.name}.`);
      const last = (await seenAt([leader.key]))[leader.key];
      if (Date.now() - last > ONLINE_MS) throw new HttpError(409, `${leader.name} är inte online just nu. Försök igen senare!`);
      const busy = await readChallenge(await redis.get(`incoming:${leader.key}`));
      if (busy && statusOf(busy) === 'pending' && busy.from !== session.key) {
        throw new HttpError(409, `${leader.name} har redan en utmaning. Försök igen om en stund.`);
      }
      const ch = {
        id: `c${crypto.randomBytes(6).toString('hex')}`, // bokstaven först: ett id med bara siffror skulle Upstash läsa tillbaka som ett tal
        continent: c.id,
        from: session.key,
        fromName: session.user.name,
        robot: session.user.acct.selected,
        to: leader.key,
        toName: leader.name,
        created: Date.now(),
        status: 'pending',
      };
      await saveChallenge(ch);
      await redis.set(`incoming:${leader.key}`, ch.id, { ex: ANSWER_SECONDS });
      await redis.set(`outgoing:${session.key}`, ch.id, { ex: CHALLENGE_TTL });
      return { challenge: challengeView(ch) };
    },
  },

  // Beskyddaren antar eller nekar.
  answer: {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const ch = await readChallenge(body.id);
      if (!ch || ch.to !== session.key) throw new HttpError(404, 'Utmaningen finns inte längre.');
      if (statusOf(ch) !== 'pending') throw new HttpError(409, 'Utmaningen gäller inte längre.');
      const leader = parse(await redis.hget(LEADERS, ch.continent));
      if (!leader || leader.key !== session.key) throw new HttpError(409, 'Du är inte längre beskyddare där.');
      ch.status = body.accept ? 'accepted' : 'declined';
      await saveChallenge(ch);
      await redis.del(`incoming:${session.key}`);
      return { challenge: challengeView(ch) };
    },
  },

  // Utmanaren ångrar sig innan beskyddaren hunnit svara.
  cancel: {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const ch = await readChallenge(body.id);
      if (!ch || ch.from !== session.key) return { ok: true };
      if (ch.status === 'pending') {
        ch.status = 'cancelled';
        await saveChallenge(ch);
        if ((await redis.get(`incoming:${ch.to}`)) === ch.id) await redis.del(`incoming:${ch.to}`);
      }
      return { ok: true };
    },
  },

  // Matchen är slut. Bara BESKYDDARENS egen sida kan lämna över titeln (genom att rapportera
  // att den förlorade) — ingen kan alltså ta en världsdel genom att bara påstå att den vann.
  result: {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const ch = await readChallenge(body.id);
      if (!ch || ch.status !== 'accepted') return { ok: true, changed: false };
      if (ch.to !== session.key) return { ok: true, changed: false };
      ch.status = 'done';
      ch.winner = body.won ? 'leader' : 'challenger';
      await saveChallenge(ch);
      if (body.won) return { ok: true, changed: false };
      const leader = parse(await redis.hget(LEADERS, ch.continent));
      if (!leader || leader.key !== session.key) return { ok: true, changed: false };
      await redis.hset(LEADERS, {
        [ch.continent]: JSON.stringify({ key: ch.from, name: ch.fromName, robot: ch.robot, since: Date.now() }),
      });
      await releaseOthers(ch.from, ch.continent);
      return { ok: true, changed: true };
    },
  },
});
