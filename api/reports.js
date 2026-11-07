const { Redis } = require("@upstash/redis");
const TTL = 3 * 3600 * 1000;
const KEY = "reports";

function env(re) {
  const k = Object.keys(process.env).find((n) => re.test(n) && process.env[n]);
  return k ? process.env[k] : undefined;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const url = env(/(REST_API_URL|REST_URL)$/);
  const token = env(/(REST_API_TOKEN|REST_TOKEN)$/);
  if (!url || !token) {
    return res.status(500).json({ error: "Redis env vars not found. Connect Upstash Redis in Storage and redeploy." });
  }
  const redis = new Redis({ url, token });
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
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};
