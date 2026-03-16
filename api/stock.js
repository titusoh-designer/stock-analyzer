// Vercel Serverless Function — Stock Data Proxy
// Calls Alpha Vantage, Yahoo Finance, CoinGecko directly (no CORS issues)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol, source, interval, apikey } = req.query;

  if (!symbol) return res.status(400).json({ error: "symbol is required" });

  try {
    let data;

    // ── Yahoo Finance (default, no key needed) ──
    if (!source || source === "yahoo") {
      const rangeMap = {
        "1m": "1d", "5m": "5d", "10m": "5d", "15m": "5d", "30m": "10d",
        "60m": "30d", "4h": "60d",
        "1d": "2y", "1wk": "5y", "1mo": "10y"
      };
      // Yahoo doesn't support 10m or 4h directly — use closest
      const intMap = {
        "1m": "1m", "5m": "5m", "10m": "15m", "15m": "15m", "30m": "30m",
        "60m": "60m", "4h": "60m",
        "1d": "1d", "1wk": "1wk", "1mo": "1mo"
      };
      const range = rangeMap[interval] || "2y";
      const int = intMap[interval] || interval || "1d";
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${int}&includePrePost=false`;
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json = await resp.json();

      if (json.chart?.error) throw new Error(json.chart.error.description);

      const result = json.chart?.result?.[0];
      if (!result) throw new Error("No data returned");

      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const meta = result.meta || {};

      const isIntraday = ["1m","5m","10m","15m","30m","60m","4h"].includes(interval);
      let ohlcv = timestamps.map((ts, i) => ({
        date: isIntraday
          ? new Date(ts * 1000).toISOString().replace("T"," ").slice(0,16)
          : new Date(ts * 1000).toISOString().split("T")[0],
        open: quote.open?.[i] ?? 0,
        high: quote.high?.[i] ?? 0,
        low: quote.low?.[i] ?? 0,
        close: quote.close?.[i] ?? 0,
        volume: quote.volume?.[i] ?? 0
      })).filter(d => d.close > 0);

      // Aggregate 60m → 4h candles
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

      data = {
        source: "yahoo",
        symbol: meta.symbol || symbol,
        currency: meta.currency || "USD",
        currentPrice: meta.regularMarketPrice,
        previousClose: meta.previousClose || meta.chartPreviousClose,
        exchange: meta.exchangeName,
        name: meta.longName || meta.shortName || symbol,
        ohlcv,
        interval: int,
        fetchedAt: new Date().toISOString()
      };

      // ── Fundamental data (PER, PBR, market cap, etc.) ──
      try {
        const fUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics,financialData,summaryDetail,price`;
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
          dividendYield: sd.dividendYield?.raw || null,
          beta: sd.beta?.raw || ks.beta?.raw || null,
          fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh?.raw || null,
          fiftyTwoWeekLow: sd.fiftyTwoWeekLow?.raw || null,
          shortRatio: ks.shortRatio?.raw || null,
          targetMeanPrice: fd.targetMeanPrice?.raw || null,
          recommendationMean: fd.recommendationMean?.raw || null,
          recommendationKey: fd.recommendationKey || null,
          profitMargins: fd.profitMargins?.raw || null,
          returnOnEquity: fd.returnOnEquity?.raw || null,
          debtToEquity: fd.debtToEquity?.raw || null,
        };
      } catch (e) { data.fundamentals = null; }

      // ── Weekly summary for multi-timeframe analysis ──
      if (["1d","60m","4h","30m","15m","10m","5m","1m"].includes(interval)) {
        try {
          const wUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1wk&includePrePost=false`;
          const wResp = await fetch(wUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
          const wJson = await wResp.json();
          const wResult = wJson.chart?.result?.[0];
          if (wResult) {
            const wTs = wResult.timestamp || [];
            const wQ = wResult.indicators?.quote?.[0] || {};
            data.weeklyOhlcv = wTs.slice(-52).map((ts, i) => ({
              date: new Date(ts * 1000).toISOString().split("T")[0],
              open: wQ.open?.[i] ?? 0, high: wQ.high?.[i] ?? 0,
              low: wQ.low?.[i] ?? 0, close: wQ.close?.[i] ?? 0,
              volume: wQ.volume?.[i] ?? 0
            })).filter(d => d.close > 0);
          }
        } catch (e) { /* weekly fetch failed */ }
      }
    }

    // ── Alpha Vantage ──
    else if (source === "alphavantage") {
      const key = apikey || process.env.ALPHA_VANTAGE_KEY || "demo";
      let fn;
      if (interval === "60min") fn = `TIME_SERIES_INTRADAY&interval=60min&outputsize=compact`;
      else if (interval === "1wk") fn = `TIME_SERIES_WEEKLY`;
      else if (interval === "1mo") fn = `TIME_SERIES_MONTHLY`;
      else fn = `TIME_SERIES_DAILY&outputsize=compact`;

      const url = `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(symbol)}&apikey=${key}`;
      const resp = await fetch(url);
      const json = await resp.json();

      if (json["Error Message"]) throw new Error(json["Error Message"]);
      if (json["Note"]) throw new Error("Rate limit exceeded");

      const tsKey = Object.keys(json).find(k => k.includes("Time Series"));
      if (!tsKey) throw new Error("No time series data found");

      const entries = Object.entries(json[tsKey]).slice(0, 200).reverse();
      const ohlcv = entries.map(([date, v]) => ({
        date, open: +v["1. open"], high: +v["2. high"],
        low: +v["3. low"], close: +v["4. close"], volume: +v["5. volume"]
      }));

      const meta = json["Meta Data"] || {};
      data = {
        source: "alphavantage",
        symbol: meta["2. Symbol"] || symbol,
        currency: "USD",
        currentPrice: ohlcv[ohlcv.length - 1]?.close,
        name: symbol,
        ohlcv,
        interval: interval || "1d",
        fetchedAt: new Date().toISOString()
      };
    }

    // ── CoinGecko (crypto, no key needed) ──
    else if (source === "coingecko") {
      const days = interval === "1wk" ? 730 : interval === "1mo" ? 1825 : 365;
      const url = `https://api.coingecko.com/api/v3/coins/${symbol.toLowerCase()}/ohlc?vs_currency=usd&days=${days}`;
      const resp = await fetch(url);
      const json = await resp.json();

      if (!Array.isArray(json)) throw new Error("Invalid CoinGecko response");

      const ohlcv = json.map(([ts, o, h, l, c]) => ({
        date: new Date(ts).toISOString().split("T")[0],
        open: o, high: h, low: l, close: c, volume: 0
      }));

      // Get current price
      const priceResp = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${symbol.toLowerCase()}&vs_currencies=usd&include_24hr_change=true`);
      const priceJson = await priceResp.json();
      const coinData = priceJson[symbol.toLowerCase()] || {};

      data = {
        source: "coingecko",
        symbol: symbol.toUpperCase(),
        currency: "USD",
        currentPrice: coinData.usd || ohlcv[ohlcv.length - 1]?.close,
        change24h: coinData.usd_24h_change,
        name: symbol,
        ohlcv,
        interval: interval || "1d",
        fetchedAt: new Date().toISOString()
      };
    }

    // ── Naver Finance (Korean stocks) ──
    else if (source === "naver") {
      const code = symbol.replace(/[^0-9]/g, "");
      const isIntraday = ["1m","5m","10m","15m","30m","60m","4h"].includes(interval);
      
      let rawOhlcv = [];
      
      if (isIntraday) {
        // ★ Try multiple Naver minute API formats
        const attempts = [
          // Format 1: requestType=2 + count + timeframe=minute
          `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=2&count=500&timeframe=minute`,
          // Format 2: requestType=2 with naver domain
          `https://fchart.stock.naver.com/siseJson.naver?symbol=${code}&requestType=2&count=500&timeframe=minute`,
          // Format 3: requestType=1 with recent dates
          `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=1&startTime=${new Date(Date.now()-7*86400000).toISOString().slice(0,10).replace(/-/g,"")}&endTime=${new Date().toISOString().slice(0,10).replace(/-/g,"")}&timeframe=minute`,
        ];

        let debugInfo = [];
        for (const url of attempts) {
          try {
            const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
            const buf = await resp.arrayBuffer();
            let text;
            try { text = new TextDecoder('euc-kr').decode(buf); }
            catch(e) { text = new TextDecoder('utf-8', {fatal:false}).decode(buf); }

            const rowRegex = /\[([^\]]+)\]/g;
            let rmatch;
            while ((rmatch = rowRegex.exec(text)) !== null) {
              const vals = rmatch[1].replace(/['"\s]/g, "").split(",").map(v => v.trim());
              if (vals.length >= 6 && +vals[4] > 0) {
                const ds = vals[0];
                let dateStr = null;
                if (/^\d{14}$/.test(ds)) dateStr = ds.slice(0,4)+"-"+ds.slice(4,6)+"-"+ds.slice(6,8)+" "+ds.slice(8,10)+":"+ds.slice(10,12);
                else if (/^\d{12}$/.test(ds)) dateStr = ds.slice(0,4)+"-"+ds.slice(4,6)+"-"+ds.slice(6,8)+" "+ds.slice(8,10)+":"+ds.slice(10,12);
                else if (/^\d{8}$/.test(ds)) dateStr = ds.slice(0,4)+"-"+ds.slice(4,6)+"-"+ds.slice(6,8)+" 00:00";
                else continue;
                rawOhlcv.push({ date: dateStr, open: +vals[1], high: +vals[2], low: +vals[3], close: +vals[4], volume: +vals[5] });
              }
            }
            debugInfo.push({ url: url.slice(0,80), rows: rawOhlcv.length, textLen: text.length, sample: text.slice(0,200) });
            if (rawOhlcv.length > 0) break; // found working format
          } catch(e) { debugInfo.push({ url: url.slice(0,80), error: e.message }); }
        }

        // If Naver minute failed, fallback to Yahoo .KS/.KQ
        if (rawOhlcv.length === 0) {
          const rangeMap = {"1m":"7d","5m":"60d","10m":"60d","15m":"60d","30m":"60d","60m":"6mo","4h":"6mo"};
          const intMap = {"1m":"1m","5m":"5m","10m":"15m","15m":"15m","30m":"30m","60m":"60m","4h":"60m"};
          for (const suffix of [".KS", ".KQ"]) {
            try {
              const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}?range=${rangeMap[interval]||"5d"}&interval=${intMap[interval]||"5m"}&includePrePost=false`;
              const yResp = await fetch(yUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
              const yJson = await yResp.json();
              if (yJson.chart?.error) continue;
              const yResult = yJson.chart?.result?.[0];
              if (!yResult?.timestamp?.length) continue;
              const yTs = yResult.timestamp;
              const yQ = yResult.indicators?.quote?.[0] || {};
              rawOhlcv = yTs.map((ts, i) => ({
                date: new Date(ts * 1000).toISOString().replace("T"," ").slice(0,16),
                open: yQ.open?.[i] ?? 0, high: yQ.high?.[i] ?? 0,
                low: yQ.low?.[i] ?? 0, close: yQ.close?.[i] ?? 0,
                volume: yQ.volume?.[i] ?? 0
              })).filter(d => d.close > 0);
              if (rawOhlcv.length > 3) break;
            } catch(e) { continue; }
          }
          debugInfo.push({ source: "yahoo_fallback", rows: rawOhlcv.length });
        }

        rawOhlcv.sort((a, b) => a.date.localeCompare(b.date));

        if (!rawOhlcv.length) throw new Error("분봉 데이터 없음. debug: " + JSON.stringify(debugInfo).slice(0,500));
      } else {
        // Daily/Weekly/Monthly — use requestType=1 with date range
        const tfMap = {"1d":"day","1wk":"week","1mo":"month"};
        const tf = tfMap[interval] || "day";
        const end = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        let daysBack = 600;
        if (tf === "week") daysBack = 1460;
        else if (tf === "month") daysBack = 3650;
        const startDate = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
        const url = `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=1&startTime=${startDate}&endTime=${end}&timeframe=${tf}`;
        const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
        const buf = await resp.arrayBuffer();
        let text;
        try { text = new TextDecoder('euc-kr').decode(buf); }
        catch(e) { text = new TextDecoder('utf-8', {fatal:false}).decode(buf); }

        const rowRegex = /\[([^\]]+)\]/g;
        let rmatch;
        while ((rmatch = rowRegex.exec(text)) !== null) {
          const vals = rmatch[1].replace(/['"\s]/g, "").split(",").map(v => v.trim());
          if (vals.length >= 6 && /^\d{8}$/.test(vals[0]) && +vals[4] > 0) {
            rawOhlcv.push({
              date: vals[0].slice(0,4)+"-"+vals[0].slice(4,6)+"-"+vals[0].slice(6,8),
              open: +vals[1], high: +vals[2], low: +vals[3], close: +vals[4], volume: +vals[5]
            });
          }
        }
      }

      // Aggregate minute data into desired interval
      let ohlcv = rawOhlcv;
      if (isIntraday && interval !== "1m" && rawOhlcv.length > 0) {
        const mins = {"5m":5,"10m":10,"15m":15,"30m":30,"60m":60,"4h":240}[interval] || 5;
        ohlcv = [];
        for (let i = 0; i < rawOhlcv.length; i += mins) {
          const chunk = rawOhlcv.slice(i, i + mins);
          if (!chunk.length) continue;
          ohlcv.push({
            date: chunk[0].date,
            open: chunk[0].open,
            high: Math.max(...chunk.map(c => c.high)),
            low: Math.min(...chunk.map(c => c.low)),
            close: chunk[chunk.length - 1].close,
            volume: chunk.reduce((s, c) => s + c.volume, 0)
          });
        }
      }

      if (!ohlcv.length) throw new Error("네이버 데이터 없음 — 파싱 " + rawOhlcv.length + "건");

      data = {
        source: "naver",
        symbol: code,
        currency: "KRW",
        currentPrice: ohlcv[ohlcv.length - 1]?.close,
        name: code,
        ohlcv,
        interval: interval || "1d",
        fetchedAt: new Date().toISOString()
      };
    }

    else {
      throw new Error(`Unknown source: ${source}`);
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
