const { Redis } = require("@upstash/redis");
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});
const TTL = 3 * 3600 * 1000;
const KEY = "reports";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const now = Date.now();
  try {
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
      const ok =
        [0, 1, 2, 3].includes(b.o) &&
        typeof b.line === "string" && b.line.length > 0 && b.line.length <= 80 &&
        typeof b.station === "string" && b.station.length > 0 && b.station.length <= 80 &&
        typeof b.nick === "string" && /^User\d{5}$/.test(b.nick);
      if (!ok) return res.status(400).json({ error: "bad request" });
      const rep = { o: b.o, line: b.line, station: b.station, nick: b.nick, ts: now, id: Math.random().toString(36).slice(2) };
      await redis.zadd(KEY, { score: now, member: JSON.stringify(rep) });
      await redis.zremrangebyscore(KEY, 0, now - TTL);
      return res.status(200).json({ ok: true });
    }
    await redis.zremrangebyscore(KEY, 0, now - TTL);
    const raw = await redis.zrange(KEY, 0, -1);
    const list = raw.map((x) => (typeof x === "string" ? JSON.parse(x) : x));
    return res.status(200).json(list);
  } catch (e) {
    return res.status(500).json({ error: "server error" });
  }
};
