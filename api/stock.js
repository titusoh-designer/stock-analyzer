// ═══════════════════════════════════════════════════════════════
// Vercel Serverless — Stock/Crypto Data API
// 
// Architecture (Option B — confirmed):
//   Yahoo Finance (메인): ALL chart OHLCV data (한국/미국/코인)
//   Naver (보조):         ① 한국 종목명  ② 한국 실시간 (realtime.js)
//
// Korean stocks: source=naver → Yahoo 005930.KS / 065350.KQ
// US stocks:     source=yahoo → Yahoo AAPL, TSLA
// Crypto:        source=yahoo → Yahoo BTC-USD, ETH-USD
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol, source, interval } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  try {
    // ── Determine Yahoo ticker ──
    const isKR = source === "naver";
    let yahooTicker = symbol;

    if (isKR) {
      // Korean stock: try .KS (KOSPI) first, then .KQ (KOSDAQ)
      const code = symbol.replace(/[^0-9]/g, "");
      yahooTicker = await resolveKRTicker(code);
    }

    // ── Yahoo range/interval mapping ──
    const rangeMap = {
      "1m": "7d", "5m": "60d", "10m": "60d", "15m": "60d", "30m": "60d",
      "60m": "6mo", "4h": "6mo",
      "1d": "5y", "1wk": "10y", "1mo": "max"
    };
    const intMap = {
      "1m": "1m", "5m": "5m", "10m": "15m", "15m": "15m", "30m": "30m",
      "60m": "60m", "4h": "60m",
      "1d": "1d", "1wk": "1wk", "1mo": "1mo"
    };
    const range = rangeMap[interval] || "2y";
    const int = intMap[interval] || interval || "1d";
    const isIntraday = ["1m","5m","10m","15m","30m","60m","4h"].includes(interval);

    // ── Fetch from Yahoo Finance ──
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooTicker)}?range=${range}&interval=${int}&includePrePost=false`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    });
    const json = await resp.json();

    if (json.chart?.error) throw new Error(json.chart.error.description || "Yahoo API error");

    const result = json.chart?.result?.[0];
    if (!result) throw new Error("No data returned from Yahoo");

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const meta = result.meta || {};

    // ── Parse OHLCV ──
    let ohlcv = timestamps.map((ts, i) => ({
      date: isIntraday
        ? new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16)
        : new Date(ts * 1000).toISOString().split("T")[0],
      open: quote.open?.[i] ?? 0,
      high: quote.high?.[i] ?? 0,
      low: quote.low?.[i] ?? 0,
      close: quote.close?.[i] ?? 0,
      volume: quote.volume?.[i] ?? 0
    })).filter(d => d.close > 0);

    // ── Aggregate 60m → 4h candles ──
    if (interval === "4h" && ohlcv.length > 0) {
      const agg = [];
      for (let i = 0; i < ohlcv.length; i += 4) {
        const chunk = ohlcv.slice(i, i + 4);
        agg.push({
          date: chunk[0].date,
          open: chunk[0].open,
          high: Math.max(...chunk.map(c => c.high)),
          low: Math.min(...chunk.map(c => c.low)),
          close: chunk[chunk.length - 1].close,
          volume: chunk.reduce((s, c) => s + c.volume, 0)
        });
      }
      ohlcv = agg;
    }

    if (!ohlcv.length) throw new Error("데이터 없음 — 종목코드를 확인하세요");

    // ── Build response ──
    let stockName = meta.longName || meta.shortName || symbol;
    const currency = isKR ? "KRW" : (meta.currency || "USD");

    // Korean stocks: get proper Korean name from Naver
    if (isKR) {
      const code = symbol.replace(/[^0-9]/g, "");
      const krName = await getKRName(code);
      if (krName) stockName = krName;
    }

    const data = {
      source: isKR ? "naver" : "yahoo",
      symbol: isKR ? symbol.replace(/[^0-9]/g, "") : (meta.symbol || symbol),
      currency,
      currentPrice: meta.regularMarketPrice || ohlcv[ohlcv.length - 1]?.close,
      previousClose: meta.previousClose || meta.chartPreviousClose,
      exchange: meta.exchangeName,
      name: stockName,
      ohlcv,
      interval: int,
      fetchedAt: new Date().toISOString()
    };

    // ── Fundamentals (optional, non-blocking) ──
    try {
      const fUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooTicker)}?modules=defaultKeyStatistics,financialData,summaryDetail,price`;
      const fResp = await fetch(fUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const fJson = await fResp.json();
      const ks = fJson?.quoteSummary?.result?.[0]?.defaultKeyStatistics || {};
      const fd = fJson?.quoteSummary?.result?.[0]?.financialData || {};
      const sd = fJson?.quoteSummary?.result?.[0]?.summaryDetail || {};
      const pr = fJson?.quoteSummary?.result?.[0]?.price || {};
      data.fundamentals = {
        marketCap: pr.marketCap?.raw || sd.marketCap?.raw || null,
        per: sd.trailingPE?.raw || ks.trailingPE?.raw || null,
        forwardPer: sd.forwardPE?.raw || ks.forwardPE?.raw || null,
        pbr: sd.priceToBook?.raw || ks.priceToBook?.raw || null,
        eps: fd.revenuePerShare?.raw || null,
        roe: fd.returnOnEquity?.raw || null,
        debtToEquity: fd.debtToEquity?.raw || null,
        dividendYield: sd.dividendYield?.raw || null,
        beta: sd.beta?.raw || ks.beta?.raw || null,
        fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh?.raw || null,
        fiftyTwoWeekLow: sd.fiftyTwoWeekLow?.raw || null,
        shortRatio: ks.shortRatio?.raw || null,
        targetPrice: fd.targetMeanPrice?.raw || null
      };
    } catch (e) { /* fundamentals are optional */ }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ── Helper: Resolve Korean stock code to Yahoo ticker (.KS or .KQ) ──
async function resolveKRTicker(code) {
  // Try .KS (KOSPI) first, then .KQ (KOSDAQ)
  for (const suffix of [".KS", ".KQ"]) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}?range=1d&interval=1d`;
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json = await resp.json();
      if (!json.chart?.error && json.chart?.result?.[0]?.timestamp?.length) {
        return code + suffix;
      }
    } catch (e) { continue; }
  }
  // Default to .KS if both fail (will error later with descriptive message)
  return code + ".KS";
}

// ── Helper: Get Korean stock name from Naver mobile API ──
async function getKRName(code) {
  try {
    const resp = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }
    });
    const json = await resp.json();
    return json?.stockName || null;
  } catch (e) {
    return null;
  }
}
