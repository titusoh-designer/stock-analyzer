// Vercel Serverless — Korean Stock Real-time Price
// Uses Naver mobile JSON API
// Debug mode: /api/realtime?code=005930&debug=1

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { code, debug } = req.query;
  if (!code) return res.status(400).json({ error: "code required" });
  const stockCode = code.replace(/[^0-9]/g, "");

  // KRX market hours
  const now = new Date();
  const kstH = (now.getUTCHours() + 9) % 24;
  const kstM = now.getUTCMinutes();
  const kstTime = kstH * 60 + kstM;
  const day = now.getUTCDay();
  const marketOpen = day >= 1 && day <= 5 && kstTime >= 540 && kstTime <= 930;

  let price = null, open = null, high = null, low = null, volume = null, prevClose = null, name = null;
  let rawData = {};

  // ★ Method 1: Naver mobile basic API
  try {
    const url = `https://m.stock.naver.com/api/stock/${stockCode}/basic`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }
    });
    const json = await resp.json();
    rawData.method1 = json;

    if (json) {
      // ★ Current price: try multiple field names
      // During trading: dealPrice or tradePrice is current
      // After hours: closePrice is final close
      price = +(json.dealPrice || json.tradePrice || json.currentPrice || json.nowVal || json.closePrice || 0);
      prevClose = +(json.previousClosePrice || json.basePrice || json.prevPrice || 0);
      open = +(json.openPrice || 0);
      high = +(json.highPrice || 0);
      low = +(json.lowPrice || 0);
      volume = +(json.accumulatedTradingVolume || json.quant || 0);
      name = json.stockName || json.stockNameEng || null;

      // If price equals prevClose and we have high/low that differ, 
      // it means closePrice was the prev day close — use high/low midpoint as estimate
      if (price === prevClose && high && low && high !== low) {
        // closePrice is prev day — no real current price in this API during trading
        // Don't use this value
        price = null;
      }
    }
  } catch(e) { rawData.method1_error = e.message; }

  // ★ Method 2: Naver polling API (has real-time price during trading)
  if (!price || debug) {
    try {
      const url2 = `https://polling.finance.naver.com/api/realtime/domestic/stock/${stockCode}`;
      const resp2 = await fetch(url2, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json2 = await resp2.json();
      rawData.method2 = json2;
      const d = json2?.datas?.[0] || {};
      if (d) {
        const p2 = +(d.nv || d.closePrice || d.dealPrice || 0);
        if (p2 > 0) {
          price = p2;
          if (!open) open = +(d.ov || d.openPrice || 0);
          if (!high) high = +(d.hv || d.highPrice || 0);
          if (!low) low = +(d.lv || d.lowPrice || 0);
          if (!volume) volume = +(d.aq || d.accumulatedTradingVolume || 0);
          if (!prevClose) prevClose = +(d.pcv || d.previousClosePrice || 0);
        }
      }
    } catch(e) { rawData.method2_error = e.message; }
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
          name = meta.shortName || meta.longName;
          const q = yJson.chart.result[0].indicators?.quote?.[0];
          if (q) {
            const opens = (q.open || []).filter(v => v > 0);
            const highs = (q.high || []).filter(v => v > 0);
            const lows = (q.low || []).filter(v => v > 0);
            const vols = (q.volume || []).filter(v => v > 0);
            if (opens.length && !open) open = opens[0];
            if (highs.length && !high) high = Math.max(...highs);
            if (lows.length && !low) low = Math.min(...lows);
            if (vols.length && !volume) volume = vols.reduce((a, b) => a + b, 0);
          }
          rawData.method3 = "yahoo_used";
          break;
        }
      } catch(e) { continue; }
    }
  }

  const result = {
    code: stockCode, price, open, high, low, volume,
    change: price && prevClose ? price - prevClose : null,
    prevClose, name, marketOpen,
    timestamp: new Date().toISOString()
  };

  // Debug mode: include raw API responses
  if (debug) result.debug = rawData;

  return res.status(200).json(result);
}
