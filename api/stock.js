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

    // ── Fundamentals (Korean=Naver, US=Google Finance scraping) ──
    try {
      // KRX industry code → sector name mapping
      const krxSectors = {
        "278":"반도체","298":"가정용기기와용품","266":"전자제품","274":"디스플레이장비및부품",
        "281":"IT하드웨어","285":"반도체장비","263":"소프트웨어","267":"무선통신서비스",
        "271":"자동차","272":"자동차부품","275":"건설","276":"건축자재","277":"화학",
        "279":"식품","280":"음료","282":"의약품","283":"바이오","284":"의료기기",
        "286":"은행","287":"증권","288":"보험","289":"부동산","290":"유틸리티",
        "291":"운송","292":"미디어","293":"엔터테인먼트","294":"호텔레저","295":"유통",
        "296":"섬유의복","297":"철강","299":"기계","300":"조선","301":"항공우주",
        "302":"에너지","303":"통신장비","304":"인터넷서비스"
      };
      const pn = s => s ? parseFloat(String(s).replace(/[^0-9.\-]/g, "")) : null;
      const parseMcap = s => {
        if (!s) return null;
        const t = s.match(/([\d,]+)조/); const e = s.match(/([\d,]+)억/);
        return (t ? parseFloat(t[1].replace(/,/g, "")) * 1e12 : 0) + (e ? parseFloat(e[1].replace(/,/g, "")) * 1e8 : 0);
      };

      if (isKR) {
        const code = symbol.replace(/[^0-9]/g, "");

        // 1) Integration: PER, PBR, EPS, BPS, 시총, 배당, 업종코드, 동종기업
        const intResp = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`);
        if (intResp.ok) {
          const ij = await intResp.json();
          const infos = {};
          (ij.totalInfos || []).forEach(i => { infos[i.code] = i.value; });

          data.fundamentals = {
            marketCap: parseMcap(infos.marketValue),
            per: pn(infos.per), forwardPer: pn(infos.cnsPer),
            pbr: pn(infos.pbr), eps: pn(infos.eps), bps: pn(infos.bps),
            dividendYield: pn(infos.dividendYieldRatio) ? pn(infos.dividendYieldRatio) / 100 : null,
            dividend: pn(infos.dividend),
            fiftyTwoWeekHigh: pn(infos.highPriceOf52Weeks),
            fiftyTwoWeekLow: pn(infos.lowPriceOf52Weeks),
            foreignRate: infos.foreignRate || null
          };

          // Sector from industryCode mapping
          data.sector = krxSectors[ij.industryCode] || null;
          data.industryCode = ij.industryCode || null;

          // Peer companies from industryCompareInfo
          if (Array.isArray(ij.industryCompareInfo) && ij.industryCompareInfo.length) {
            data.peers = ij.industryCompareInfo.slice(0, 5).map(p => ({
              name: p.stockName, code: p.itemCode, price: p.closePrice, change: p.fluctuationsRatio
            }));
          }
        }

        // 2) Annual: Parse ALL rows (ROE, 부채비율, 영업이익률, EPS, PER, PBR...)
        const aResp = await fetch(`https://m.stock.naver.com/api/stock/${code}/finance/annual`);
        if (aResp.ok) {
          const aj = await aResp.json();
          const fi = aj.financeInfo;
          if (fi?.rowList && fi?.trTitleList) {
            const titles = fi.trTitleList.filter(t => t.isConsensus === "N").slice(-3);
            const rows = {};
            fi.rowList.forEach(r => { rows[r.title] = r.columns; });
            const getVal = (rowName, key) => rows[rowName]?.[key]?.value ? pn(rows[rowName][key].value) : null;
            const latestKey = titles[titles.length - 1]?.key;

            data.annual = titles.map(t => ({
              year: t.title.replace(/\./g, ""), revenue: getVal("매출액", t.key),
              operatingProfit: getVal("영업이익", t.key), earnings: getVal("당기순이익", t.key),
              opm: getVal("영업이익률", t.key), npm: getVal("순이익률", t.key),
              roe: getVal("ROE", t.key), debtRatio: getVal("부채비율", t.key),
              eps: getVal("EPS", t.key), per: getVal("PER", t.key),
              bps: getVal("BPS", t.key), pbr: getVal("PBR", t.key),
              dividend: getVal("주당배당금", t.key)
            }));

            // Enrich fundamentals from latest annual
            if (latestKey && data.fundamentals) {
              const f = data.fundamentals;
              f.roe = getVal("ROE", latestKey) ? getVal("ROE", latestKey) / 100 : null;
              f.debtToEquity = getVal("부채비율", latestKey);
              f.operatingMargins = getVal("영업이익률", latestKey) ? getVal("영업이익률", latestKey) / 100 : null;
              f.profitMargins = getVal("순이익률", latestKey) ? getVal("순이익률", latestKey) / 100 : null;
              f.retainedEarnings = getVal("유보율", latestKey);
            }
          }
        }

        // 3) Quarterly: Parse ALL rows
        const qResp = await fetch(`https://m.stock.naver.com/api/stock/${code}/finance/quarter`);
        if (qResp.ok) {
          const qj = await qResp.json();
          const fi = qj.financeInfo;
          if (fi?.rowList && fi?.trTitleList) {
            const titles = fi.trTitleList.filter(t => t.isConsensus === "N").slice(-4);
            const rows = {};
            fi.rowList.forEach(r => { rows[r.title] = r.columns; });
            const getVal = (rowName, key) => rows[rowName]?.[key]?.value ? pn(rows[rowName][key].value) : null;

            data.quarterly = titles.map(t => ({
              quarter: t.title.replace(/\./g, ""),
              revenue: getVal("매출액", t.key) ? getVal("매출액", t.key) * 1e6 : null,
              operatingProfit: getVal("영업이익", t.key) ? getVal("영업이익", t.key) * 1e6 : null,
              earnings: getVal("당기순이익", t.key) ? getVal("당기순이익", t.key) * 1e6 : null,
              opm: getVal("영업이익률", t.key), roe: getVal("ROE", t.key),
              debtRatio: getVal("부채비율", t.key)
            }));
          }
        }

      } else {
        // ★ US stocks: Google Finance HTML scraping
        data.fundamentals = {
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null
        };
        try {
          // Try NASDAQ first, then NYSE
          const exchanges = ["NASDAQ", "NYSE", "NYSEARCA"];
          let gHtml = null;
          for (const ex of exchanges) {
            const gResp = await fetch(`https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:${ex}`, {
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
            });
            if (gResp.ok) { gHtml = await gResp.text(); if (gHtml.length > 10000) break; }
          }
          if (gHtml) {
            // Extract data from Google Finance HTML
            const extract = (label) => {
              const re = new RegExp(label + '[^>]*>[^>]*>([^<]+)', 'i');
              const m = gHtml.match(re); return m ? m[1].trim() : null;
            };
            const extractMeta = (prop) => {
              const re = new RegExp(`"${prop}"\\s*:\\s*"?([^",}]+)`, 'i');
              const m = gHtml.match(re); return m ? m[1].trim() : null;
            };
            // Sector/Industry from structured data
            const sectorMatch = gHtml.match(/data-topic[^>]*>([^<]+)<\/a>[^<]*<\/div>[^<]*<div[^>]*>([^<]+)/);
            // PE ratio
            const peMatch = gHtml.match(/P\/E ratio[^>]*>[^>]*>([^<]+)/i) || gHtml.match(/"PE Ratio[^"]*"[^>]*>[^>]*>([^<]+)/i);
            // Market cap
            const mcapMatch = gHtml.match(/Market cap[^>]*>[^>]*>([^<]+)/i);
            // Dividend yield
            const divMatch = gHtml.match(/Dividend yield[^>]*>[^>]*>([^<]+)/i);
            // Description
            const descMatch = gHtml.match(/data-attrid="description"[^>]*>([^<]{20,200})/i) || gHtml.match(/About[^<]*<[^>]*>([^<]{20,300})/i);

            if (peMatch) data.fundamentals.per = pn(peMatch[1]);
            if (mcapMatch) {
              const mv = mcapMatch[1].trim();
              if (mv.includes("T")) data.fundamentals.marketCap = pn(mv) * 1e12;
              else if (mv.includes("B")) data.fundamentals.marketCap = pn(mv) * 1e9;
              else if (mv.includes("M")) data.fundamentals.marketCap = pn(mv) * 1e6;
            }
            if (divMatch && divMatch[1].includes("%")) data.fundamentals.dividendYield = pn(divMatch[1]) / 100;

            // Sector from Google (look for industry/sector links)
            const secMatch = gHtml.match(/\/finance\/markets\/[^"]*sector[^"]*"[^>]*>([^<]+)/i);
            if (secMatch) data.sector = secMatch[1].trim();

            // Try to get description
            if (descMatch) data.businessSummary = descMatch[1].trim().slice(0, 200);

            data.fundSource = "google-finance";
          }
        } catch(ge) { /* Google scraping failed, use chart meta only */ }

        if (!data.sector) data.sector = null;
        if (!data.industry) data.industry = null;
      }
    } catch (e) { console.log("[FUND ERROR]", yahooTicker, e.message); }

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
