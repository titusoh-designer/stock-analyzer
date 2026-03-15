// Vercel Serverless — Star Signal Scanner
// Scans a batch of stocks for ★ buy signals (3+ confluence within last 10 days)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { symbols } = req.body;
  if (!symbols || !symbols.length) return res.status(400).json({ error: "symbols required" });
  const scanDays = 365; // always scan full year, frontend filters

  const results = [];

  for (const sym of symbols.slice(0, 8)) { // max 8 per batch
    try {
      const source = sym.source || "yahoo";
      const ticker = sym.symbol;
      let ohlcv = [];
      let name = sym.name || ticker;
      let currency = "USD";
      let currentPrice = 0;

      if (source === "naver") {
        const code = ticker.replace(/\.(KS|KQ)$/, "");
        const startDate = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
        const endDate = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const url = `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=1&startTime=${startDate}&endTime=${endDate}&timeframe=day`;
        const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
        // ★ Decode as EUC-KR
        const buffer = await resp.arrayBuffer();
        let text;
        try { text = new TextDecoder('euc-kr').decode(buffer); }
        catch(e) { text = new TextDecoder('utf-8', {fatal:false}).decode(buffer); }
        const rows = text.match(/\["(\d{8})","(\d+)","(\d+)","(\d+)","(\d+)","(\d+)"\]/g) || [];
        ohlcv = rows.map(r => {
          const m = r.match(/"(\d{8})","(\d+)","(\d+)","(\d+)","(\d+)","(\d+)"/);
          return m ? { date: m[1].slice(0,4)+"-"+m[1].slice(4,6)+"-"+m[1].slice(6), open:+m[2], high:+m[3], low:+m[4], close:+m[5], volume:+m[6] } : null;
        }).filter(Boolean);
        currency = "KRW";
        if (ohlcv.length) currentPrice = ohlcv[ohlcv.length - 1].close;
      } else {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d&includePrePost=false`;
        const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const json = await resp.json();
        const result = json.chart?.result?.[0];
        if (!result) continue;
        const ts = result.timestamp || [];
        const q = result.indicators?.quote?.[0] || {};
        const meta = result.meta || {};
        ohlcv = ts.map((t, i) => ({
          date: new Date(t * 1000).toISOString().split("T")[0],
          open: q.open?.[i] ?? 0, high: q.high?.[i] ?? 0,
          low: q.low?.[i] ?? 0, close: q.close?.[i] ?? 0,
          volume: q.volume?.[i] ?? 0
        })).filter(d => d.close > 0);
        currency = meta.currency || "USD";
        currentPrice = meta.regularMarketPrice || (ohlcv.length ? ohlcv[ohlcv.length - 1].close : 0);
        name = meta.longName || meta.shortName || ticker;
      }

      if (ohlcv.length < 30) continue;

      // Calculate signals for last 10 bars
      const cls = ohlcv.map(d => d.close);
      const vols = ohlcv.map(d => d.volume);

      // MAs
      const ma = (arr, n, idx) => idx >= n - 1 ? arr.slice(idx - n + 1, idx + 1).reduce((a, b) => a + b, 0) / n : null;

      // RSI
      const rsiAt = (idx) => {
        if (idx < 14) return null;
        let ag = 0, al = 0;
        for (let i = 1; i <= 14; i++) { const d = cls[idx - 14 + i] - cls[idx - 14 + i - 1]; d > 0 ? ag += d : al += Math.abs(d); }
        ag /= 14; al /= 14;
        for (let i = 15; i <= idx; i++) { const d = cls[i] - cls[i - 1]; ag = (ag * 13 + (d > 0 ? d : 0)) / 14; al = (al * 13 + (d < 0 ? Math.abs(d) : 0)) / 14; }
        return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      };

      // MACD
      const ema = (arr, n) => { const k = 2 / (n + 1); let e = [arr[0]]; for (let i = 1; i < arr.length; i++) e.push(arr[i] * k + e[i - 1] * (1 - k)); return e; };
      const e12 = ema(cls, 12), e26 = ema(cls, 26);
      const macdL = e12.map((v, i) => v - e26[i]);
      const sigL = ema(macdL.slice(26), 9);
      const histAt = (idx) => idx >= 34 ? macdL[idx] - (sigL[idx - 26] || 0) : null;

      // BB
      const bbAt = (idx) => {
        if (idx < 19) return null;
        const sl = cls.slice(idx - 19, idx + 1);
        const avg = sl.reduce((a, b) => a + b, 0) / 20;
        const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / 20);
        return { upper: avg + 2 * std, lower: avg - 2 * std };
      };

      // Vol avg
      const volAvgAt = (idx) => idx >= 19 ? vols.slice(idx - 19, idx + 1).reduce((a, b) => a + b, 0) / 20 : null;

      // Scan last N trading days for ★ signals
      let starSignals = [];
      const scanStart = Math.max(25, ohlcv.length - scanDays);

      for (let i = scanStart; i < ohlcv.length; i++) {
        const buys = [];
        const bullCandle = cls[i] > ohlcv[i].open;
        const bearCandle = cls[i] < ohlcv[i].open;

        const ma5 = ma(cls, 5, i), ma20 = ma(cls, 20, i);
        const ma5p = ma(cls, 5, i - 1), ma20p = ma(cls, 20, i - 1);
        if (ma5 && ma20 && ma5p && ma20p && ma5p <= ma20p && ma5 > ma20 && bullCandle) buys.push("GC");

        const rsi = rsiAt(i), rsip = rsiAt(i - 1);
        if (rsi != null && rsip != null && rsip < 30 && rsi >= 30 && bullCandle) buys.push("RSI");

        const h = histAt(i), hp = histAt(i - 1);
        if (h != null && hp != null && hp < 0 && h >= 0 && bullCandle) buys.push("MACD");

        const bb = bbAt(i);
        const va = volAvgAt(i);
        if (bb && va && cls[i] > bb.upper && bullCandle && vols[i] > va * 1.2) buys.push("BB");

        if (ma20 && ma20p && cls[i - 1] < ma20p && cls[i] > ma20 && bullCandle) buys.push("MA↑");

        if (buys.length >= 3) {
          starSignals.push({
            date: ohlcv[i].date,
            signals: buys,
            count: buys.length,
            price: cls[i],
            daysAgo: ohlcv.length - 1 - i
          });
        }
      }

      if (starSignals.length > 0) {
        // Mini OHLCV (last 60 bars for mini chart)
        const mini = ohlcv.slice(-60).map(d => ({ c: d.close, h: d.high, l: d.low }));
        const change = ohlcv.length >= 2 ? ((cls[cls.length - 1] / cls[cls.length - 2] - 1) * 100).toFixed(2) : 0;

        results.push({
          symbol: ticker,
          name,
          source,
          currency,
          currentPrice,
          change: +change,
          starSignals,
          bestSignal: starSignals.reduce((a, b) => b.count > a.count ? b : a),
          mini
        });
      }
    } catch (e) {
      // Skip failed stocks
    }
  }

  return res.status(200).json({
    results,
    scannedAt: new Date().toISOString(),
    count: results.length
  });
}
