// /api/scan-store — Store & retrieve scan results (Vercel KV)
// GET: retrieve latest scan results
// POST: save scan results

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!kvUrl || !kvToken) {
    return res.status(200).json({ error: "KV not configured", fallback: true });
  }

  const KEY = "scan_results_v1";

  async function kvGet(key) {
    try {
      const r = await fetch(`${kvUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      const d = await r.json();
      return d.result ? JSON.parse(d.result) : null;
    } catch (e) { return null; }
  }

  async function kvSet(key, value, ttlSeconds) {
    const args = ttlSeconds
      ? ["SET", key, JSON.stringify(value), "EX", String(ttlSeconds)]
      : ["SET", key, JSON.stringify(value)];
    await fetch(`${kvUrl}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(args)
    });
  }

  if (req.method === "GET") {
    const data = await kvGet(KEY);
    // Also check if cron is in progress
    const partial = await kvGet("scan_cron_partial");
    const cronInProgress = partial && partial.results && partial.results.length > 0 && partial.progress;

    if (!data && !cronInProgress) return res.status(200).json({ results: null, stored: false });

    const response = data
      ? { results: data.results, scannedAt: data.scannedAt, source: data.source, count: data.count, totalScanned: data.totalScanned, stored: true }
      : { results: null, stored: false };

    if (cronInProgress) {
      response.cronInProgress = true;
      response.cronProgress = partial.progress;
      response.cronAccumulated = partial.results.length;
    }

    return res.status(200).json(response);
  }

  if (req.method === "POST") {
    const { results, source } = req.body || {};
    if (!results || !Array.isArray(results)) {
      return res.status(400).json({ error: "results array required" });
    }
    const payload = {
      results,
      scannedAt: new Date().toISOString(),
      source: source || "manual",
      count: results.length
    };
    await kvSet(KEY, payload, 86400);
    return res.status(200).json({ saved: true, count: results.length });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
