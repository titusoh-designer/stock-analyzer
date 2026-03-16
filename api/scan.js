// Vercel Serverless — Signal Scanner
// Detects: A. ▲매수 시그널 (2+합류) + C. ◆강한상승예상 (5조건 동시)
// Matches main chart signal logic exactly

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { symbols } = req.body;
  if (!symbols || !symbols.length) return res.status(400).json({ error: "symbols required" });
  const scanDays = 365;

  const results = [];

  for (const sym of symbols.slice(0, 10)) {
    try {
      const source = sym.source || "yahoo";
      const ticker = sym.symbol;
      let ohlcv = [];
      let name = sym.name || ticker;
      let currency = "USD";
      let currentPrice = 0;

      if (source === "naver") {
        const code = ticker.replace(/\.(KS|KQ)$/, "");
        for (const suffix of [".KS", ".KQ"]) {
          try {
            const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}?range=1y&interval=1d&includePrePost=false`;
            const yResp = await fetch(yUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
            const yJson = await yResp.json();
            if (yJson.chart?.error) continue;
            const yR = yJson.chart?.result?.[0];
            if (!yR?.timestamp?.length) continue;
            const yQ = yR.indicators?.quote?.[0] || {};
            const yMeta = yR.meta || {};
            ohlcv = yR.timestamp.map((ts, i) => ({
              date: new Date(ts * 1000).toISOString().split("T")[0],
              open: yQ.open?.[i] ?? 0, high: yQ.high?.[i] ?? 0,
              low: yQ.low?.[i] ?? 0, close: yQ.close?.[i] ?? 0,
              volume: yQ.volume?.[i] ?? 0
            })).filter(d => d.close > 0);
            if (ohlcv.length > 30) {
              if (!name || name === ticker) name = yMeta.longName || yMeta.shortName || name;
              currentPrice = yMeta.regularMarketPrice || ohlcv[ohlcv.length - 1].close;
              break;
            }
          } catch (e) { continue; }
        }
        currency = "KRW";
        if (!currentPrice && ohlcv.length) currentPrice = ohlcv[ohlcv.length - 1].close;
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
        if (!name || name === ticker) name = meta.longName || meta.shortName || ticker;
      }

      if (ohlcv.length < 30) continue;

      // ══════════════════════════════════════
      // Signal Detection (A + C)
      // ══════════════════════════════════════
      const cls = ohlcv.map(d => d.close);
      const vols = ohlcv.map(d => d.volume);

      // ── Helpers ──
      const maAt = (n, idx) => idx >= n - 1 ? cls.slice(idx - n + 1, idx + 1).reduce((a, b) => a + b, 0) / n : null;

      const rsiAt = (idx) => {
        if (idx < 14) return null;
        let ag = 0, al = 0;
        for (let j = 1; j <= 14; j++) { const d = cls[idx - 14 + j] - cls[idx - 14 + j - 1]; d > 0 ? ag += d : al += Math.abs(d); }
        ag /= 14; al /= 14;
        for (let j = 15; j <= idx; j++) { const d = cls[j] - cls[j - 1]; ag = (ag * 13 + (d > 0 ? d : 0)) / 14; al = (al * 13 + (d < 0 ? Math.abs(d) : 0)) / 14; }
        return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      };

      const ema = (arr, n) => { const k = 2 / (n + 1); let e = [arr[0]]; for (let j = 1; j < arr.length; j++) e.push(arr[j] * k + e[j - 1] * (1 - k)); return e; };
      const e12 = ema(cls, 12), e26 = ema(cls, 26);
      const macdL = e12.map((v, j) => v - e26[j]);
      const sigL = ema(macdL.slice(26), 9);
      const histAt = (idx) => idx >= 34 ? macdL[idx] - (sigL[idx - 26] || 0) : null;

      const bbAt = (idx) => {
        if (idx < 19) return null;
        const sl = cls.slice(idx - 19, idx + 1);
        const avg = sl.reduce((a, b) => a + b, 0) / 20;
        const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / 20);
        return { upper: avg + 2 * std, lower: avg - 2 * std, width: (4 * std) / (avg || 1) };
      };

      const volAvgAt = (idx) => idx >= 19 ? vols.slice(idx - 19, idx + 1).reduce((a, b) => a + b, 0) / 20 : null;

      // ATR(14)
      const atrArr = [];
      for (let j = 0; j < ohlcv.length; j++) {
        if (j < 1) { atrArr.push(ohlcv[j].high - ohlcv[j].low); continue; }
        atrArr.push(Math.max(ohlcv[j].high - ohlcv[j].low, Math.abs(ohlcv[j].high - cls[j - 1]), Math.abs(ohlcv[j].low - cls[j - 1])));
      }
      const atr14 = [];
      for (let j = 0; j < atrArr.length; j++) {
        if (j < 13) { atr14.push(null); continue; }
        if (j === 13) { atr14.push(atrArr.slice(0, 14).reduce((a, b) => a + b, 0) / 14); continue; }
        atr14.push((atr14[j - 1] * 13 + atrArr[j]) / 14);
      }

      // BB widths
      const bbWidths = [];
      for (let j = 0; j < cls.length; j++) {
        const bb = bbAt(j);
        bbWidths.push(bb ? bb.width : null);
      }

      // ── Scan ──
      let allSignals = [];
      const scanStart = Math.max(25, ohlcv.length - scanDays);

      for (let i = scanStart; i < ohlcv.length; i++) {
        const bullCandle = cls[i] > ohlcv[i].open;
        const daysAgo = ohlcv.length - 1 - i;

        // ═══ A. 매수 시그널 (GC, RSI, MACD, BB, MA↑) ═══
        const buys = [];
        const ma5 = maAt(5, i), ma20 = maAt(20, i);
        const ma5p = maAt(5, i - 1), ma20p = maAt(20, i - 1);
        if (ma5 && ma20 && ma5p && ma20p && ma5p <= ma20p && ma5 > ma20 && bullCandle) buys.push("GC");

        const rsi = rsiAt(i), rsip = rsiAt(i - 1);
        if (rsi != null && rsip != null && rsip < 30 && rsi >= 30 && bullCandle) buys.push("RSI");

        const h = histAt(i), hp = histAt(i - 1);
        if (h != null && hp != null && hp < 0 && h >= 0 && bullCandle) buys.push("MACD");

        const bb = bbAt(i);
        const va = volAvgAt(i);
        if (bb && va && cls[i] > bb.upper && bullCandle && vols[i] > va * 1.2) buys.push("BB");

        if (ma20 && ma20p && cls[i - 1] < ma20p && cls[i] > ma20 && bullCandle) buys.push("MA↑");

        if (buys.length >= 2) {
          allSignals.push({
            type: "A", date: ohlcv[i].date, signals: buys,
            count: buys.length, price: cls[i], daysAgo
          });
        }

        // ═══ C. 강한상승예상 (5조건 동시) ═══
        if (i >= 25 && bbWidths[i] != null) {
          const bbRecent = bbWidths.slice(Math.max(0, i - 20), i + 1).filter(Boolean);
          if (bbRecent.length >= 10) {
            const bbSorted = [...bbRecent].sort((a, b) => a - b);
            const c1 = bbWidths[i] <= bbSorted[Math.floor(bbSorted.length * 0.2)];
            const c2 = atr14[i] != null && atr14[Math.max(0, i - 5)] != null && atr14[i] < atr14[i - 5];
            let c3 = false;
            if (i >= 10) {
              const rH = Math.max(...ohlcv.slice(i - 4, i + 1).map(d => d.high));
              const rL = Math.min(...ohlcv.slice(i - 4, i + 1).map(d => d.low));
              const pH = Math.max(...ohlcv.slice(i - 9, i - 4).map(d => d.high));
              const pL = Math.min(...ohlcv.slice(i - 9, i - 4).map(d => d.low));
              c3 = rH < pH && rL > pL;
            }
            const volRatio = va ? vols[i] / va : 0;
            const c4 = volRatio >= 1.5;
            const c5 = bullCandle;

            if (c1 && c2 && c3 && c4 && c5) {
              allSignals.push({
                type: "C", date: ohlcv[i].date,
                signals: ["BB수렴", "ATR↓", "범위↓", "Vol×" + volRatio.toFixed(1), "양봉"],
                count: 5, price: cls[i], daysAgo
              });
            }
          }
        }
      }

      if (allSignals.length > 0) {
        // C first, then by count desc, daysAgo asc
        allSignals.sort((a, b) => {
          if (a.type !== b.type) return a.type === "C" ? -1 : 1;
          return (b.count - a.count) || (a.daysAgo - b.daysAgo);
        });
        const topSignals = allSignals.slice(0, 10);
        const mini = ohlcv.slice(-30).map(d => ({ c: Math.round(d.close * 100) / 100 }));
        const change = ohlcv.length >= 2 ? ((cls[cls.length - 1] / cls[cls.length - 2] - 1) * 100).toFixed(2) : 0;

        results.push({
          symbol: ticker, name, source, currency, currentPrice,
          change: +change, starSignals: topSignals, bestSignal: topSignals[0],
          mini, dataLen: ohlcv.length
        });
      }
    } catch (e) {
      // Skip failed stocks
    }
  }

  return res.status(200).json({ results, scannedAt: new Date().toISOString(), count: results.length });
}
