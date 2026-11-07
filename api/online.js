const { Redis } = require("@upstash/redis");
const KEY = "online";
const WINDOW = 45 * 1000; // считаем «онлайн», если был сигнал за последние 45 секунд

function env(re) {
  const k = Object.keys(process.env).find((n) => re.test(n) && process.env[n]);
  return k ? process.env[k] : undefined;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const url = env(/(REST_API_URL|REST_URL)$/);
  const token = env(/(REST_API_TOKEN|REST_TOKEN)$/);
  if (!url || !token) return res.status(500).json({ error: "Redis env vars not found" });
  const redis = new Redis({ url, token });
  const now = Date.now();
  try {
    const id = String((req.query && req.query.id) || "");
    if (/^User\d{5}$/.test(id)) await redis.zadd(KEY, { score: now, member: id });
    await redis.zremrangebyscore(KEY, 0, now - WINDOW);
    const n = await redis.zcard(KEY);
    return res.status(200).json({ n });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};
