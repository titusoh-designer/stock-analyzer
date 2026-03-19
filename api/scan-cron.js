// /api/scan-cron — Full-universe self-chaining auto scanner
// Phase 0: Load all stocks from /api/universe + hardcoded US/Crypto → store list in KV
// Phase 1+: Scan 40 stocks per phase → append results to KV → trigger next phase
// Final phase: Sort + save to scan_results_v1 → done

export const config = { maxDuration: 60 };

const BATCH_PER_PHASE = 40; // stocks per 60-second phase

// US + Crypto hardcoded (no universe API for these)
const US_STOCKS = [
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","TSLA","AVGO","BRK-B","LLY",
  "JPM","V","UNH","XOM","MA","COST","HD","PG","JNJ","ABBV",
  "NFLX","CRM","AMD","ORCL","BAC","KO","PEP","TMO","MRK","ADBE",
  "WMT","CSCO","ACN","MCD","IBM","INTC","QCOM","TXN","INTU","AMAT",
  "NOW","ISRG","BKNG","UBER","PANW","CRWD","SNOW","DDOG","ZS","NET"
];
const CRYPTO_STOCKS = [
  "BTC-USD","ETH-USD","SOL-USD","BNB-USD","XRP-USD",
  "ADA-USD","DOGE-USD","AVAX-USD","DOT-USD","LINK-USD"
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ error: "KV not configured" });

  const phase = parseInt(req.query.phase || "0");
  const days = parseInt(req.query.days || "10");
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "https://stock-analyzer-sooty-five.vercel.app";

  // ── KV helpers ──
  const kvGet = async (k) => {
    try { const r = await fetch(`${kvUrl}/get/${k}`, { headers: { Authorization: `Bearer ${kvToken}` } }); const d = await r.json(); return d.result ? JSON.parse(d.result) : null; } catch { return null; }
  };
  const kvSet = async (k, v, ttl) => {
    const args = ttl ? ["SET", k, JSON.stringify(v), "EX", String(ttl)] : ["SET", k, JSON.stringify(v)];
    await fetch(`${kvUrl}`, { method: "POST", headers: { Authorization: `Bearer ${kvToken}`, "Content-Type": "application/json" }, body: JSON.stringify(args) });
  };

  // ══════ PHASE 0: Build full stock list ══════
  if (phase === 0) {
    console.log("[CRON] Phase 0 — Building full universe...");
    const fullList = [];

    // Load Korean stocks from universe API
    try {
      const [kpResp, kdResp] = await Promise.all([
        fetch(`${baseUrl}/api/universe?market=kospi&count=1000`),
        fetch(`${baseUrl}/api/universe?market=kosdaq&count=600`)
      ]);
      const kp = await kpResp.json(), kd = await kdResp.json();
      if (kp.stocks) kp.stocks.forEach(s => fullList.push({ symbol: s.s, source: "naver" }));
      if (kd.stocks) kd.stocks.forEach(s => fullList.push({ symbol: s.s, source: "naver" }));
    } catch (e) { console.log("[CRON] Universe load error:", e.message); }

    // Add US + Crypto
    US_STOCKS.forEach(s => fullList.push({ symbol: s, source: "yahoo" }));
    CRYPTO_STOCKS.forEach(s => fullList.push({ symbol: s, source: "yahoo" }));

    console.log(`[CRON] Universe loaded: ${fullList.length} stocks`);

    // Save universe + init partial results
    await kvSet("scan_cron_universe", fullList, 7200); // 2h TTL
    await kvSet("scan_cron_partial", { results: [], startedAt: new Date().toISOString(), total: fullList.length }, 7200);

    // Trigger phase 1
    fetch(`${baseUrl}/api/scan-cron?phase=1&days=${days}`).catch(() => {});

    return res.status(200).json({
      phase: 0, totalStocks: fullList.length,
      totalPhases: Math.ceil(fullList.length / BATCH_PER_PHASE),
      message: "Universe loaded, scanning started"
    });
  }

  // ══════ PHASE 1+: Scan batch ══════
  const universe = await kvGet("scan_cron_universe");
  if (!universe || !Array.isArray(universe)) {
    return res.status(200).json({ error: "No universe found in KV. Run phase=0 first." });
  }

  const totalPhases = Math.ceil(universe.length / BATCH_PER_PHASE);
  const startIdx = (phase - 1) * BATCH_PER_PHASE; // phase 1 = index 0
  const endIdx = Math.min(startIdx + BATCH_PER_PHASE, universe.length);
  const batch = universe.slice(startIdx, endIdx);

  if (batch.length === 0) {
    return res.status(200).json({ done: true, phase, message: "No more stocks to scan" });
  }

  console.log(`[CRON] Phase ${phase}/${totalPhases} — stocks ${startIdx + 1}-${endIdx} of ${universe.length}`);

  // Scan in sub-batches of 8
  const phaseResults = [];
  const subSize = 8;
  for (let i = 0; i < batch.length; i += subSize) {
    const sub = batch.slice(i, i + subSize);
    try {
      const symbols = sub.map(s => s.symbol).join(",");
      const sources = sub.map(s => s.source).join(",");
      const url = `${baseUrl}/api/scan?symbols=${symbols}&sources=${sources}&days=${days}`;
      const resp = await fetch(url, { headers: { "User-Agent": "CronChain/1.0" } });
      if (resp.ok) {
        const data = await resp.json();
        if (data.results) phaseResults.push(...data.results);
      }
    } catch (e) {
      console.log(`[CRON] Sub-batch error at ${startIdx + i}:`, e.message);
    }
  }

  // Append to partial results
  const partial = await kvGet("scan_cron_partial") || { results: [], startedAt: new Date().toISOString() };
  partial.results.push(...phaseResults);
  partial.lastPhase = phase;
  partial.progress = `${endIdx}/${universe.length}`;

  const isLast = endIdx >= universe.length;

  if (isLast) {
    // ══════ FINAL: Sort + save ══════
    partial.results.sort((a, b) => {
      const sa = a.bestSignal, sb = b.bestSignal;
      if (!sa) return 1; if (!sb) return -1;
      const wa = sa.type === "C" ? 100 : (sa.count || 0) * 10;
      const wb = sb.type === "C" ? 100 : (sb.count || 0) * 10;
      if (wb !== wa) return wb - wa;
      return (sa.daysAgo || 999) - (sb.daysAgo || 999);
    });

    const payload = {
      results: partial.results,
      scannedAt: new Date().toISOString(),
      source: "cron-6am",
      count: partial.results.length,
      totalScanned: universe.length
    };
    await kvSet("scan_results_v1", payload, 86400);

    // Cleanup
    await kvSet("scan_cron_partial", null, 1);
    await kvSet("scan_cron_universe", null, 1);

    console.log(`[CRON] ✓ COMPLETE — ${partial.results.length} results from ${universe.length} stocks`);
    return res.status(200).json({
      done: true, phase, totalPhases,
      totalScanned: universe.length,
      totalResults: partial.results.length,
      withSignals: partial.results.filter(r => r.bestSignal).length,
      scannedAt: payload.scannedAt
    });
  }

  // Save partial + chain to next phase
  await kvSet("scan_cron_partial", partial, 7200);
  fetch(`${baseUrl}/api/scan-cron?phase=${phase + 1}&days=${days}`).catch(() => {});

  return res.status(200).json({
    done: false, phase, totalPhases,
    batchScanned: batch.length,
    phaseResults: phaseResults.length,
    accumulated: partial.results.length,
    progress: `${endIdx}/${universe.length}`,
    nextPhase: phase + 1
  });
}
