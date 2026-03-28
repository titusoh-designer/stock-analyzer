// /api/sentiment.js — Market Sentiment Dashboard Data
// Sources: Yahoo Finance (indices, VIX, futures, FX, commodities)
//          alternative.me (Crypto Fear & Greed)
//          Naver Finance (Korean futures, FX)
//
// GET /api/sentiment → JSON with all sentiment data
// Cache: 5 minutes (Vercel Edge Cache)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  if (req.method === "OPTIONS") return res.status(200).end();

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

  // ═══ Helper: Yahoo Finance quote (single or batch) ═══
  async function yahooQuote(symbols) {
    // Yahoo v8 chart API — more reliable than v7 quote
    const results = {};
    const promises = symbols.map(async (sym) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d&includePrePost=false`;
        const resp = await fetch(url, { headers: { "User-Agent": UA } });
        const json = await resp.json();
        const r = json.chart?.result?.[0];
        if (!r) return;
        const meta = r.meta || {};
        const quotes = r.indicators?.quote?.[0] || {};
        const closes = quotes.close?.filter(v => v != null) || [];
        const price = meta.regularMarketPrice || closes[closes.length - 1] || 0;
        const prevClose = meta.chartPreviousClose || meta.previousClose || closes[closes.length - 2] || price;
        const change = prevClose ? ((price - prevClose) / prevClose * 100) : 0;
        results[sym] = {
          price: +price.toFixed(meta.currency === "KRW" ? 0 : 2),
          change: +change.toFixed(2),
          prevClose: +prevClose.toFixed(2),
          currency: meta.currency || "USD",
          name: meta.shortName || meta.symbol || sym
        };
      } catch (e) { /* skip */ }
    });
    await Promise.all(promises);
    return results;
  }

  // ═══ Helper: Format price for display ═══
  function fmtPrice(v, prefix = "", suffix = "") {
    if (v == null) return "—";
    if (Math.abs(v) >= 10000) return prefix + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 }) + suffix;
    if (Math.abs(v) >= 1) return prefix + Number(v).toFixed(2) + suffix;
    return prefix + Number(v).toFixed(4) + suffix;
  }

  try {
    // ═══ 1. Fear & Greed Index (Crypto — alternative.me) ═══
    let fearGreed = 50, fearLabel = "중립";
    try {
      const fgResp = await fetch("https://api.alternative.me/fng/?limit=1", {
        headers: { "User-Agent": UA }
      });
      const fgJson = await fgResp.json();
      if (fgJson.data?.[0]) {
        fearGreed = parseInt(fgJson.data[0].value) || 50;
        const cls = fgJson.data[0].value_classification || "";
        fearLabel = cls === "Extreme Fear" ? "극심한 공포" :
                    cls === "Fear" ? "공포" :
                    cls === "Neutral" ? "중립" :
                    cls === "Greed" ? "탐욕" :
                    cls === "Extreme Greed" ? "극심한 탐욕" : "중립";
      }
    } catch (e) { }

    // ═══ 2. Yahoo Finance Batch — VIX, Indices, Futures, FX, Commodities ═══
    const yahooSymbols = [
      // VIX
      "^VIX", "^VVIX",
      // Major indices
      "^KS11",    // KOSPI
      "^GSPC",    // S&P 500
      "^IXIC",    // NASDAQ
      "BTC-USD",  // Bitcoin
      // US Futures
      "ES=F",     // S&P 500 Futures
      "NQ=F",     // NASDAQ 100 Futures
      // FX & Commodities
      "KRW=X",    // USD/KRW
      "CL=F",     // WTI Crude Oil
      "GC=F",     // Gold
      "^TNX",     // US 10Y Treasury Yield
    ];
    const yData = await yahooQuote(yahooSymbols);

    // ═══ 3. Korean Futures (Naver) ═══
    let kospiFutures = null, kospiNightFutures = null;
    try {
      // KOSPI200 futures from Naver
      const kfResp = await fetch("https://m.stock.naver.com/api/index/KOSPI200/basic", {
        headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }
      });
      if (kfResp.ok) {
        const kfJson = await kfResp.json();
        if (kfJson) {
          kospiFutures = {
            price: kfJson.closePrice || kfJson.currentPrice,
            change: kfJson.fluctuationsRatio ? parseFloat(kfJson.fluctuationsRatio) : null
          };
        }
      }
    } catch (e) { }

    // ═══ 4. Sector Performance (Yahoo sector ETFs as proxy) ═══
    const sectorSymbols = {
      US: [
        { sym: "XLK", name: "Tech" },
        { sym: "XLV", name: "Health" },
        { sym: "XLE", name: "Energy" },
        { sym: "XLF", name: "Finance" },
        { sym: "XLY", name: "Consumer" },
      ]
    };
    const sectorData = await yahooQuote(sectorSymbols.US.map(s => s.sym));

    // ═══ Assemble response ═══
    const get = (sym) => yData[sym] || { price: 0, change: 0 };
    const vix = get("^VIX");
    const vvix = get("^VVIX");

    const response = {
      timestamp: new Date().toISOString(),
      source: "live",

      fearGreed,
      label: fearLabel,

      vix: vix.price || 0,
      vixCh: vix.change || 0,
      vvix: vvix.price || 0,

      futures: [
        {
          n: "KOSPI200",
          v: kospiFutures ? fmtPrice(kospiFutures.price) : fmtPrice(get("^KS11").price),
          ch: kospiFutures?.change ?? get("^KS11").change
        },
        { n: "KOSPI 야간선물", v: "—", ch: 0, hl: true, note: "장외 데이터 미제공" },
        { n: "S&P500 선물", v: fmtPrice(get("ES=F").price), ch: get("ES=F").change },
        { n: "나스닥100 선물", v: fmtPrice(get("NQ=F").price), ch: get("NQ=F").change },
      ],

      macro: [
        { n: "USD/KRW", v: fmtPrice(get("KRW=X").price), ch: get("KRW=X").change },
        { n: "WTI", v: fmtPrice(get("CL=F").price, "$"), ch: get("CL=F").change },
        { n: "금", v: fmtPrice(get("GC=F").price, "$"), ch: get("GC=F").change },
        { n: "미국10Y", v: (get("^TNX").price || 0).toFixed(2) + "%", ch: get("^TNX").change },
      ],

      indices: [
        { n: "KOSPI", v: fmtPrice(get("^KS11").price), ch: get("^KS11").change },
        { n: "S&P500", v: fmtPrice(get("^GSPC").price), ch: get("^GSPC").change },
        { n: "NASDAQ", v: fmtPrice(get("^IXIC").price), ch: get("^IXIC").change },
        { n: "BTC", v: fmtPrice(get("BTC-USD").price, "$"), ch: get("BTC-USD").change },
      ],

      sectorsUS: sectorSymbols.US.map(s => ({
        name: s.name,
        ch: sectorData[s.sym]?.change || 0,
        info: s.sym + " ETF 기준"
      })),

      // Korean sectors — hardcoded names, would need KRX API for live data
      sectorsKR: [
        { name: "반도체", ch: 0, info: "실시간 데이터 준비 중" },
        { name: "2차전지", ch: 0, info: "실시간 데이터 준비 중" },
        { name: "조선", ch: 0, info: "실시간 데이터 준비 중" },
        { name: "바이오", ch: 0, info: "실시간 데이터 준비 중" },
        { name: "전력기기", ch: 0, info: "실시간 데이터 준비 중" },
      ],

      // Economic calendar — static (would need investing.com scraping for live)
      eco: [
        { n: "—", d: "—", prev: "—", fc: "—", act: "—", good: null, desc: "경제지표 API 연동 예정" }
      ],

      // News — placeholder
      news: [
        { t: "뉴스 API 연동 준비 중", s: "중립", time: "—" }
      ],

      // Scan-based market temperature (if scan data available)
      scanSummary: null,

      // Data quality flags
      _meta: {
        fearGreedSource: "alternative.me (Crypto F&G)",
        vixSource: "Yahoo Finance ^VIX",
        indicesSource: "Yahoo Finance",
        futuresSource: "Yahoo Finance (ES=F, NQ=F)",
        fxSource: "Yahoo Finance (KRW=X)",
        commoditiesSource: "Yahoo Finance (CL=F, GC=F)",
        sectorUSSource: "Yahoo Finance sector ETFs (XLK, XLV, XLE, XLF, XLY)",
        sectorKRSource: "미구현 — KRX 업종지수 API 필요",
        ecoSource: "미구현 — 수동 또는 스크래핑 필요",
        newsSource: "미구현 — 네이버/Google News RSS 필요",
        nightFuturesNote: "KOSPI 야간선물은 장외거래 데이터로, 무료 API에서 실시간 제공 불가",
        cacheTTL: "5분 (Vercel Edge Cache)"
      }
    };

    // ═══ Optional: Scan summary from Redis ═══
    try {
      const kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
      const kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
      if (kvUrl && kvToken) {
        const r = await fetch(`${kvUrl}/get/scan_results_v1`, {
          headers: { Authorization: `Bearer ${kvToken}` }
        });
        const d = await r.json();
        if (d.result) {
          const scan = JSON.parse(d.result);
          if (scan.results?.length) {
            const total = scan.totalScanned || scan.results.length;
            const sigCount = scan.results.length;
            response.scanSummary = {
              totalScanned: total,
              signalCount: sigCount,
              signalRate: +(sigCount / total * 100).toFixed(1),
              scannedAt: scan.scannedAt,
              label: sigCount / total > 0.1 ? "시그널 활발" : sigCount / total > 0.05 ? "보통" : "시그널 적음"
            };
          }
        }
      }
    } catch (e) { }

    return res.status(200).json(response);

  } catch (err) {
    console.error("[SENTIMENT] Error:", err);
    return res.status(500).json({ error: "Sentiment data fetch failed", message: err.message });
  }
}
