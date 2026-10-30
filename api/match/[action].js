// Matcher mot AI: start och avslut, samlade i EN serverlös funktion (se dispatch() i
// _lib.js) för att hålla sig inom Vercels gräns på 12 funktioner.
const crypto = require('crypto');
const { dispatch, requireSession, saveUser, acctView, randomFloat, redis, S, HttpError, clock } = require('../_lib.js');

const MATCH_TTL_SECONDS = 30 * 60; // en övergiven match glöms bort efter 30 minuter
const MIN_MATCH_MS = 5000;
const CLAN_BONUS_COINS = 3;       // extra mynt per vinst för den som är med i en klan         // en match som "tog" kortare än så kan inte ha spelats på riktigt

module.exports = dispatch({
  start: {
    method: 'POST',
    async handler(req, res, body) {
      const session = await requireSession(req);
      const { robot, mode } = body;
      const target = typeof body.target === 'string' ? body.target : typeof body.monsterId === 'string' ? body.monsterId : null;
      const acct = session.user.acct;
      const wantMode = ['stake', 'boss', 'monster', 'street'].includes(mode) ? mode : 'normal';
      const match = S.startMatch(acct, robot, wantMode, randomFloat, target);
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
      const result = S.finishMatch(session.user.acct, entry.match, won === true, randomFloat, clock().today);
      // Klan: varje vinst ger klanpoäng (mer för svårare motståndare) och lite extra mynt.
      if (result.won && session.user.clan) {
        const opp = S.robotById[entry.match.opp];
        const points = opp && opp.royal ? 10 : entry.match.boss ? 3 : entry.match.monster ? 2 : 1;
        await redis.zincrby('clans:points', points, session.user.clan).catch(() => {});
        session.user.acct.coins = (session.user.acct.coins || 0) + CLAN_BONUS_COINS;
        result.coins = (result.coins || 0) + CLAN_BONUS_COINS;
        result.clanPoints = points;
      }
      await saveUser(session.key, session.user);
      return { acct: acctView(session.user), result };
    },
  },
});
