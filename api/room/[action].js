// Vänmatchens rum-relä: gå med, sätta presence, skicka fria meddelanden och fråga om nytt —
// samlade i EN serverlös funktion (se dispatch() i _lib.js) för att hålla sig inom Vercels
// gräns på 12 funktioner. Se _shared.js för själva Redis-modellen.
const crypto = require('crypto');
const { dispatch, HttpError } = require('../_lib.js');
const { redis, peersKey, eventsKey, validateRoom, touchRoom, readPeers } = require('./_shared.js');

function requirePeerId(body) {
  const peerId = typeof body.peerId === 'string' ? body.peerId : null;
  if (!peerId) throw new HttpError(400, 'Du har inte gått med i rummet.');
  return peerId;
}

module.exports = dispatch({
  join: {
    method: 'POST',
    async handler(req, res, body) {
      const room = validateRoom(body.room);
      const peerId = crypto.randomBytes(8).toString('hex');
      await redis.hset(peersKey(room), { [peerId]: JSON.stringify({}) });
      await touchRoom(room);
      const [peers, cursor] = await Promise.all([readPeers(room, peerId), redis.llen(eventsKey(room))]);
      return { peerId, peers, cursor };
    },
  },

  presence: {
    method: 'POST',
    async handler(req, res, body) {
      const room = validateRoom(body.room);
      const peerId = requirePeerId(body);
      if (!body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) throw new HttpError(400, 'Ogiltig presence.');
      const current = await redis.hget(peersKey(room), peerId);
      const base = current ? (typeof current === 'string' ? JSON.parse(current) : current) : null;
      if (base === null) throw new HttpError(400, 'Du har lämnat rummet.');
      const next = { ...base };
      for (const k of Object.keys(body.patch)) {
        if (typeof k !== 'string' || k.length > 64) continue;
        if (body.patch[k] === null) delete next[k]; else next[k] = body.patch[k];
      }
      if (JSON.stringify(next).length > 8192) throw new HttpError(400, 'Presence för stor.');
      await redis.hset(peersKey(room), { [peerId]: JSON.stringify(next) });
      await touchRoom(room);
      return { ok: true };
    },
  },

  emit: {
    method: 'POST',
    async handler(req, res, body) {
      const room = validateRoom(body.room);
      const peerId = requirePeerId(body);
      if (typeof body.topic !== 'string' || body.topic.length > 64) throw new HttpError(400, 'Ogiltigt ämne.');
      const data = body.data === undefined ? null : body.data;
      if (JSON.stringify(data).length > 16384) throw new HttpError(400, 'Meddelandet är för stort.');
      await redis.rpush(eventsKey(room), JSON.stringify({ peerId, topic: body.topic, data }));
      await touchRoom(room);
      return { ok: true };
    },
  },

  poll: {
    method: 'GET',
    async handler(req) {
      const q = req.query || {};
      const room = validateRoom(q.room);
      const peerId = typeof q.peerId === 'string' ? q.peerId : null;
      if (!peerId) throw new HttpError(400, 'Du har inte gått med i rummet.');
      const cursor = Math.max(0, Number(q.cursor) || 0);
      const [peers, len] = await Promise.all([readPeers(room, peerId), redis.llen(eventsKey(room))]);
      let events = [];
      if (len > cursor) {
        const raw = await redis.lrange(eventsKey(room), cursor, len - 1);
        events = raw.map((e) => (typeof e === 'string' ? JSON.parse(e) : e));
      }
      await touchRoom(room);
      return { peers, events, cursor: len };
    },
  },

  leave: {
    method: 'POST',
    async handler(req, res, body) {
      const room = validateRoom(body.room);
      const peerId = requirePeerId(body);
      await redis.hdel(peersKey(room), peerId);
      return { ok: true };
    },
  },
});
