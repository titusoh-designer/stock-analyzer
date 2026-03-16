// Vercel Serverless — Korean Stock Real-time Price
// Uses Naver mobile JSON API (no HTML scraping, no encoding issues)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "code required" });
  const stockCode = code.replace(/[^0-9]/g, "");

  // KRX market hours: 9:00-15:30 KST (Mon-Fri)
  const now = new Date();
  const kstH = (now.getUTCHours() + 9) % 24;
  const kstM = now.getUTCMinutes();
  const kstTime = kstH * 60 + kstM;
  const day = now.getUTCDay();
  const marketOpen = day >= 1 && day <= 5 && kstTime >= 540 && kstTime <= 930;

  let price = null, open = null, high = null, low = null, volume = null, change = null, name = null, prevClose = null;

  // ★ Method 1: Naver mobile API (JSON, works from any IP)
  try {
    const url = `https://m.stock.naver.com/api/stock/${stockCode}/basic`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }
    });
    const json = await resp.json();
    if (json) {
      price = +(json.closePrice || json.nowVal || 0);
      prevClose = +(json.previousClosePrice || json.prevPrice || 0);
      open = +(json.openPrice || 0);
      high = +(json.highPrice || 0);
      low = +(json.lowPrice || 0);
      volume = +(json.accumulatedTradingVolume || json.quant || 0);
      change = price && prevClose ? price - prevClose : null;
      name = json.stockName || json.stockNameEng || null;
    }
  } catch(e) {}

  // ★ Method 2: Naver polling API (fallback)
  if (!price) {
    try {
      const url2 = `https://polling.finance.naver.com/api/realtime/domestic/stock/${stockCode}`;
      const resp2 = await fetch(url2, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json2 = await resp2.json();
      const d = json2?.datas?.[0] || json2;
      if (d) {
        price = +(d.closePrice || d.nv || 0);
        open = +(d.openPrice || d.ov || 0);
        high = +(d.highPrice || d.hv || 0);
        low = +(d.lowPrice || d.lv || 0);
        volume = +(d.accumulatedTradingVolume || d.aq || 0);
        prevClose = +(d.previousClosePrice || d.pcv || 0);
        change = price && prevClose ? price - prevClose : null;
      }
    } catch(e) {}
  }

  // ★ Method 3: Yahoo Finance (last resort)
  if (!price) {
    for (const suffix of [".KS", ".KQ"]) {
      try {
        const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${stockCode}${suffix}?range=1d&interval=1m&includePrePost=false`;
        const yResp = await fetch(yUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
        const yJson = await yResp.json();
        const meta = yJson.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          price = meta.regularMarketPrice;
          prevClose = meta.previousClose || meta.chartPreviousClose;
          change = price - (prevClose || 0);
          name = meta.shortName || meta.longName;
          // Get today's OHLV from first/last candle
          const q = yJson.chart.result[0].indicators?.quote?.[0];
          if (q) {
            const opens = (q.open || []).filter(v => v > 0);
            const highs = (q.high || []).filter(v => v > 0);
            const lows = (q.low || []).filter(v => v > 0);
            const vols = (q.volume || []).filter(v => v > 0);
            if (opens.length) open = opens[0];
            if (highs.length) high = Math.max(...highs);
            if (lows.length) low = Math.min(...lows);
            if (vols.length) volume = vols.reduce((a, b) => a + b, 0);
          }
          break;
        }
      } catch(e) { continue; }
    }
  }

  return res.status(200).json({
    code: stockCode, price, open, high, low, volume, change, prevClose, name,
    marketOpen, timestamp: new Date().toISOString()
  });
}
