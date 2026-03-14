// Vercel Serverless — Watchlist Pattern Scanner
// Checks multiple symbols for pattern signals

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbols, sources } = req.query;
  if (!symbols) return res.status(400).json({ error: "symbols required (comma-separated)" });

  const symList = symbols.split(",").map(s => s.trim()).filter(Boolean);
  const srcList = (sources || "").split(",").map(s => s.trim());
  const results = [];

  for (let idx = 0; idx < symList.length; idx++) {
    const symbol = symList[idx];
    const source = srcList[idx] || "yahoo";
    try {
      // Fetch daily data
      let url, parseKey;
      if (source === "naver") {
        const code = symbol.replace(/[^0-9]/g, "");
        const end = new Date().toISOString().slice(0,10).replace(/-/g,"");
        const start = new Date(Date.now()-200*86400000).toISOString().slice(0,10).replace(/-/g,"");
        url = `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`;
      } else if (source === "coingecko") {
        url = `https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/ohlc?vs_currency=usd&days=90`;
      } else {
        url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d&includePrePost=false`;
      }

      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });

      let ohlcv = [], name = symbol, currency = "USD", currentPrice = 0;

      if (source === "yahoo") {
        const json = await resp.json();
        const result = json.chart?.result?.[0];
        if (!result) continue;
        const ts = result.timestamp || [];
        const q = result.indicators?.quote?.[0] || {};
        const meta = result.meta || {};
        ohlcv = ts.map((t,i) => ({
          close: q.close?.[i]||0, high: q.high?.[i]||0, low: q.low?.[i]||0, open: q.open?.[i]||0, volume: q.volume?.[i]||0
        })).filter(d => d.close > 0);
        name = meta.longName || meta.shortName || symbol;
        currency = meta.currency || "USD";
        currentPrice = meta.regularMarketPrice || ohlcv[ohlcv.length-1]?.close || 0;
      } else if (source === "naver") {
        const text = await resp.text();
        const rows = text.match(/\[.*?\]/g) || [];
        ohlcv = rows.map(r => {
          const v = r.replace(/[\[\]'"\s]/g,"").split(",");
          return v.length >= 6 ? { open:+v[1], high:+v[2], low:+v[3], close:+v[4], volume:+v[5] } : null;
        }).filter(Boolean);
        currency = "KRW";
        currentPrice = ohlcv[ohlcv.length-1]?.close || 0;
      } else if (source === "coingecko") {
        const json = await resp.json();
        if (Array.isArray(json)) {
          ohlcv = json.map(([ts,o,h,l,c]) => ({ open:o, high:h, low:l, close:c, volume:0 }));
          currentPrice = ohlcv[ohlcv.length-1]?.close || 0;
        }
      }

      if (ohlcv.length < 10) { results.push({ symbol, name, error: "insufficient data" }); continue; }

      // Quick technical analysis
      const closes = ohlcv.map(d => d.close);
      const last = closes[closes.length-1];
      const prev = closes[closes.length-2] || last;
      const change = ((last-prev)/prev*100).toFixed(2);

      // RSI
      let rsi = null;
      if (closes.length >= 15) {
        let gains=0, losses=0;
        for(let i=closes.length-14;i<closes.length;i++){const d=closes[i]-closes[i-1];if(d>0)gains+=d;else losses+=Math.abs(d);}
        const ag=gains/14, al=losses/14;
        rsi = al===0?100:+(100-100/(1+ag/al)).toFixed(1);
      }

      // Simple pattern signals
      const signals = [];
      // RSI extremes
      if (rsi !== null) {
        if (rsi > 70) signals.push({ type: "warning", msg: "RSI 과매수 (" + rsi + ")" });
        if (rsi < 30) signals.push({ type: "opportunity", msg: "RSI 과매도 (" + rsi + ")" });
      }
      // MA crossover (5 vs 20)
      if (closes.length >= 20) {
        const ma5now = closes.slice(-5).reduce((a,b)=>a+b,0)/5;
        const ma20now = closes.slice(-20).reduce((a,b)=>a+b,0)/20;
        const ma5prev = closes.slice(-6,-1).reduce((a,b)=>a+b,0)/5;
        const ma20prev = closes.slice(-21,-1).reduce((a,b)=>a+b,0)/20;
        if (ma5prev < ma20prev && ma5now > ma20now) signals.push({ type: "bullish", msg: "골든크로스 (MA5↑MA20)" });
        if (ma5prev > ma20prev && ma5now < ma20now) signals.push({ type: "bearish", msg: "데드크로스 (MA5↓MA20)" });
      }
      // 52w high/low proximity
      const h52 = Math.max(...closes);
      const l52 = Math.min(...closes);
      if (last >= h52 * 0.98) signals.push({ type: "bullish", msg: "52주 신고가 근접" });
      if (last <= l52 * 1.02) signals.push({ type: "warning", msg: "52주 신저가 근접" });
      // Volume spike
      if (ohlcv.length >= 20) {
        const avgVol = ohlcv.slice(-20).reduce((s,d)=>s+d.volume,0)/20;
        const lastVol = ohlcv[ohlcv.length-1].volume;
        if (avgVol > 0 && lastVol > avgVol * 2) signals.push({ type: "alert", msg: "거래량 급증 (" + (lastVol/avgVol).toFixed(1) + "x)" });
      }

      results.push({
        symbol, name, source, currency, currentPrice, change: +change, rsi,
        high52: h52, low52: l52,
        signals,
        trend: closes[closes.length-1] > closes[Math.max(0,closes.length-20)] ? "up" : "down"
      });
    } catch (e) {
      results.push({ symbol, name: symbol, error: e.message });
    }
  }

  return res.status(200).json({ results, scannedAt: new Date().toISOString() });
}
