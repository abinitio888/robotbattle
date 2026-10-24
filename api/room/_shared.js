// Delad kod för rum-reläets fyra rutter: ett generiskt "rum" där servern inte vet något om
// spelregler, bara förmedlar "presence" (vem är här, med vilken data) och fria meddelanden
// ("emit") mellan alla som gått med i samma rumskod — precis som Claude-sidans egen
// room-förmåga. Här finns ingen ständigt körande process att hålla rummen i minnet i, så
// allt ligger i Redis i stället, och klienten (se connectPollRoom i backend.js) FRÅGAR efter
// nytt i stället för att bli knuten (en riktig websocket går inte att hålla vid liv mellan
// serverlösa anrop) — se poll.js.
const { redis, HttpError } = require('../_lib.js');

const ROOM_CODE_RE = /^[a-z0-9]{4,24}$/;
const ROOM_TTL_SECONDS = 2 * 3600; // en övergiven match glöms bort efter två timmar

function peersKey(room) { return `room:${room}:peers`; }
function eventsKey(room) { return `room:${room}:events`; }

function validateRoom(room) {
  if (typeof room !== 'string' || !ROOM_CODE_RE.test(room)) throw new HttpError(400, 'Ogiltig rumskod.');
  return room;
}

async function touchRoom(room) {
  await Promise.all([
    redis.expire(peersKey(room), ROOM_TTL_SECONDS),
    redis.expire(eventsKey(room), ROOM_TTL_SECONDS),
  ]);
}

async function readPeers(room, myPeerId) {
  const raw = await redis.hgetall(peersKey(room));
  const out = [];
  for (const [id, presence] of Object.entries(raw || {})) {
    out.push({ id, presence: typeof presence === 'string' ? JSON.parse(presence) : presence, isMe: id === myPeerId });
  }
  return out;
}

module.exports = { redis, HttpError, ROOM_TTL_SECONDS, peersKey, eventsKey, validateRoom, touchRoom, readPeers };
