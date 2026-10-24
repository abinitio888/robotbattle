// Matcher mot AI: start och avslut, samlade i EN serverlös funktion (se dispatch() i
// _lib.js) för att hålla sig inom Vercels gräns på 12 funktioner.
const crypto = require('crypto');
const { dispatch, requireSession, saveUser, acctView, randomFloat, redis, S, HttpError } = require('../_lib.js');

const MATCH_TTL_SECONDS = 30 * 60; // en övergiven match glöms bort efter 30 minuter
const MIN_MATCH_MS = 5000;         // en match som "tog" kortare än så kan inte ha spelats på riktigt

module.exports = dispatch({
  start: {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const { robot, mode, bossId, monsterId } = body;
      const acct = session.user.acct;
      const wantMode = mode === 'stake' ? 'stake' : mode === 'boss' ? 'boss' : mode === 'monster' ? 'monster' : 'normal';
      const match = S.startMatch(acct, robot, wantMode, randomFloat, typeof bossId === 'string' ? bossId : null, typeof monsterId === 'string' ? monsterId : null);
      if (match.error) throw new HttpError(400, match.error);
      const token = crypto.randomBytes(16).toString('hex');
      await redis.set(`match:${token}`, JSON.stringify({ key: session.key, match, startedAt: Date.now() }), { ex: MATCH_TTL_SECONDS });
      await saveUser(session.key, session.user);
      return { acct: acctView(session.user), match: { token, ...match } };
    },
  },

  finish: {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const { token, won } = body;
      const raw = typeof token === 'string' ? await redis.get(`match:${token}`) : null;
      const entry = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
      if (!entry || entry.key !== session.key) throw new HttpError(400, 'Ingen match pågår.');
      if (Date.now() - entry.startedAt < MIN_MATCH_MS) throw new HttpError(400, 'Matchen var för kort.');
      await redis.del(`match:${token}`);
      const result = S.finishMatch(session.user.acct, entry.match, won === true, randomFloat);
      await saveUser(session.key, session.user);
      return { acct: acctView(session.user), result };
    },
  },
});
