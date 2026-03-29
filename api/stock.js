// ═══════════════════════════════════════════════════════════════
// Vercel Serverless — Stock/Crypto Data API v6
// 
// Changes from v5:
//   ① Korean chart OHLCV: Naver 1순위 → Yahoo 폴백
//   ② US fundamentals: Yahoo v10 quoteSummary 1순위 → Google 폴백
//   ③ .KS/.KQ 자동 구분 강화
// ═══════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { symbol, source, interval, debug } = req.query;
  if (!symbol) return res.status(400).json({ error: "symbol is required" });
  const debugMode = debug === "1";
  const debugLog = [];

  const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
  const UA_M = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)";

  try {
    const isKR = source === "naver";
    const code = isKR ? symbol.replace(/[^0-9]/g, "") : symbol;
    const int = interval || "1d";
    const isIntraday = ["1m","5m","10m","15m","30m","60m","4h"].includes(int);

    let ohlcv = [];
    let meta = {};
    let stockName = symbol;
    let currency = isKR ? "KRW" : "USD";
    let chartSource = "yahoo";

    // ═══════════════════════════════════════════
    // ① Korean OHLCV: Naver 1순위 → Yahoo 폴백
    // ═══════════════════════════════════════════
    if (isKR) {
      // Try Naver chart API first
      try {
        const naverData = await fetchNaverChart(code, int);
        if (naverData && naverData.length >= 1) {
          ohlcv = naverData;
          chartSource = "naver-chart";
          console.log(`[NAVER CHART] OK: ${code} ${int} → ${naverData.length}봉`);
        }
      } catch (e) { console.log("[NAVER CHART] fallback to Yahoo:", e.message); }

      // Fallback: Yahoo (try both .KS and .KQ for intraday)
      if (!ohlcv.length) {
        const yahooTicker = await resolveKRTicker(code);
        console.log(`[YAHOO FALLBACK] ${code} → ${yahooTicker} interval=${int}`);

        // Helper: check if data is truly intraday (multiple data points within same day)
        const isRealIntraday = (data) => {
          if (!data || data.length < 2) return false;
          const d0 = (data[0].date || "").slice(0, 10);
          const d1 = (data[1].date || "").slice(0, 10);
          return d0 === d1; // same calendar day = intraday
        };

        try {
          const yData = await fetchYahooChart(yahooTicker, int);
          if (isIntraday && yData.ohlcv.length > 1 && !isRealIntraday(yData.ohlcv)) {
            console.log(`[YAHOO] ${yahooTicker} returned daily instead of ${int}, trying alt suffix`);
            // Yahoo returned daily — try alternate suffix
            const altTicker = yahooTicker.endsWith(".KS") ? code + ".KQ" : code + ".KS";
            try {
              const yData2 = await fetchYahooChart(altTicker, int);
              if (isRealIntraday(yData2.ohlcv)) {
                ohlcv = yData2.ohlcv; meta = yData2.meta; chartSource = "yahoo";
                console.log(`[YAHOO] Alt ${altTicker} OK: ${ohlcv.length}봉 intraday`);
              } else {
                // Both failed intraday — use daily data with warning
                ohlcv = yData.ohlcv; meta = yData.meta; chartSource = "yahoo";
                console.log(`[YAHOO] Both ${yahooTicker} and ${altTicker} returned daily for ${int}`);
              }
            } catch (e2) {
              ohlcv = yData.ohlcv; meta = yData.meta; chartSource = "yahoo";
            }
          } else {
            ohlcv = yData.ohlcv; meta = yData.meta; chartSource = "yahoo";
            if (isIntraday) console.log(`[YAHOO] ${yahooTicker} ${int}: ${ohlcv.length}봉, intraday=${isRealIntraday(ohlcv)}`);
          }
        } catch (e) {
          const altTicker = yahooTicker.endsWith(".KS") ? code + ".KQ" : code + ".KS";
          try {
            const yData2 = await fetchYahooChart(altTicker, int);
            ohlcv = yData2.ohlcv; meta = yData2.meta; chartSource = "yahoo";
          } catch (e2) { console.log(`[YAHOO] Both tickers failed for ${code}`); }
        }
      }

      // Get Korean name from Naver
      const krName = await getKRName(code);
      if (krName) stockName = krName;
      currency = "KRW";
    } else {
      // US / Crypto: Yahoo only
      const yData = await fetchYahooChart(symbol, int);
      ohlcv = yData.ohlcv;
      meta = yData.meta;
      stockName = meta.longName || meta.shortName || symbol;
      currency = meta.currency || "USD";
    }

    if (!ohlcv.length) throw new Error("데이터 없음 — 종목코드를 확인하세요");

    const data = {
      source: isKR ? "naver" : "yahoo",
      chartSource,
      symbol: isKR ? code : (meta.symbol || symbol),
      currency,
      currentPrice: meta.regularMarketPrice || ohlcv[ohlcv.length - 1]?.close,
      previousClose: meta.previousClose || meta.chartPreviousClose || (ohlcv.length >= 2 ? ohlcv[ohlcv.length - 2]?.close : null),
      exchange: meta.exchangeName || (isKR ? "KRX" : null),
      name: stockName,
      ohlcv,
      interval: int,
      fetchedAt: new Date().toISOString()
    };

    // ═══════════════════════════════════════════
    // ② Fundamentals
    // ═══════════════════════════════════════════
    try {
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
        // ── Korean: Naver (unchanged, reliable) ──
        const intResp = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, { headers: { "User-Agent": UA_M } });
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
          data.sector = krxSectors[ij.industryCode] || null;
          data.industryCode = ij.industryCode || null;
          if (Array.isArray(ij.industryCompareInfo) && ij.industryCompareInfo.length) {
            data.peers = ij.industryCompareInfo.slice(0, 5).map(p => ({
              name: p.stockName, code: p.itemCode, price: p.closePrice, change: p.fluctuationsRatio
            }));
          }
        }

        // Annual + Quarter from Naver (unchanged)
        const aResp = await fetch(`https://m.stock.naver.com/api/stock/${code}/finance/annual`, { headers: { "User-Agent": UA_M } });
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
            if (latestKey && data.fundamentals) {
              const f = data.fundamentals;
              f.roe = getVal("ROE", latestKey) ? getVal("ROE", latestKey) / 100 : null;
              f.debtToEquity = getVal("부채비율", latestKey);
              f.operatingMargins = getVal("영업이익률", latestKey) ? getVal("영업이익률", latestKey) / 100 : null;
            }
          }
        }
        const qResp = await fetch(`https://m.stock.naver.com/api/stock/${code}/finance/quarter`, { headers: { "User-Agent": UA_M } });
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

        // Korean Short Interest — time series from Naver
        try {
          let shortData = null;

          // Try 1: Naver short selling balance page (time series)
          try {
            const ssUrl = `https://finance.naver.com/item/sise_short_balance.naver?code=${code}&page=1`;
            const ssResp = await fetch(ssUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(5000) });
            console.log(`[SHORT] sise_short_balance status: ${ssResp.status}`);
            if (ssResp.ok) {
              const ssHtml = await ssResp.text();
              console.log(`[SHORT] HTML length: ${ssHtml.length}`);
              // Parse table rows: date | 공매도잔고(주) | ... | 잔고비율(%) | ...
              const rows = [];
              const trMatches = ssHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
              console.log(`[SHORT] TR matches: ${trMatches.length}`);
              for (const tr of trMatches) {
                const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
                if (!tds || tds.length < 4) continue;
                const strip = s => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").trim();
                const dateStr = strip(tds[0]);
                if (!/^\d{4}\.\d{2}\.\d{2}$/.test(dateStr)) continue;
                const date = dateStr.replace(/\./g, "-");
                const balance = parseFloat(strip(tds[1]).replace(/,/g, "")) || 0;
                const ratio = parseFloat(strip(tds[3]).replace(/,/g, "")) || 0;
                if (balance > 0) rows.push({ date, balance, ratio });
              }
              console.log(`[SHORT] Parsed rows: ${rows.length}`);
              if (rows.length >= 3) {
                rows.reverse(); // oldest first
                shortData = { source: "naver-short-balance", timeSeries: rows };
              }
            }
          } catch (e) { /* page 1 failed */ }

          // Try 2: page 2~3 for more history
          if (shortData && shortData.timeSeries.length < 60) {
            for (let pg = 2; pg <= 4; pg++) {
              try {
                const pgUrl = `https://finance.naver.com/item/sise_short_balance.naver?code=${code}&page=${pg}`;
                const pgResp = await fetch(pgUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(3000) });
                if (!pgResp.ok) break;
                const pgHtml = await pgResp.text();
                const trMatches = pgHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
                for (const tr of trMatches) {
                  const tds = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
                  if (!tds || tds.length < 4) continue;
                  const strip = s => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, "").trim();
                  const dateStr = strip(tds[0]);
                  if (!/^\d{4}\.\d{2}\.\d{2}$/.test(dateStr)) continue;
                  const date = dateStr.replace(/\./g, "-");
                  const balance = parseFloat(strip(tds[1]).replace(/,/g, "")) || 0;
                  const ratio = parseFloat(strip(tds[3]).replace(/,/g, "")) || 0;
                  if (balance > 0) shortData.timeSeries.unshift({ date, balance, ratio });
                }
              } catch (e) { break; }
            }
          }

          // Try 3: Naver mobile API fallback
          if (!shortData) {
            const shortApis = [
              `https://m.stock.naver.com/api/stock/${code}/short-selling`,
              `https://m.stock.naver.com/api/stock/${code}/short-balance`
            ];
            for (const sUrl of shortApis) {
              try {
                const sResp = await fetch(sUrl, { headers: { "User-Agent": UA_M }, signal: AbortSignal.timeout(3000) });
                if (sResp.ok) {
                  const sText = await sResp.text();
                  if (sText && sText.length > 2 && (sText.startsWith("{") || sText.startsWith("["))) {
                    shortData = { source: "naver-mobile", raw: JSON.parse(sText) };
                    break;
                  }
                }
              } catch (e) { continue; }
            }
          }

          // Fallback: foreignRate from integration
          if (shortData) {
            data.shortInterest = shortData;
          } else {
            const fr = data.fundamentals?.foreignRate;
            if (fr) {
              data.shortInterest = {
                source: "naver-integration",
                foreignRate: parseFloat(fr) || null
              };
            }
          }
        } catch (e) { /* short interest optional */ }

      } else {
        // ════════════════════════════════════════════
        // ★ US: Yahoo v10 quoteSummary 1순위 → Google 폴백
        // ════════════════════════════════════════════
        data.fundamentals = {
          marketCap: null, per: null, pbr: null, eps: null,
          dividendYield: null, roe: null, operatingMargins: null,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null
        };

        let yahooV10Success = false;
        try {
          const modules = "defaultKeyStatistics,financialData,incomeStatementHistory,balanceSheetHistory,cashflowStatementHistory,summaryProfile,summaryDetail";
          const v10Url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
          const v10Resp = await fetch(v10Url, { headers: { "User-Agent": UA } });
          const v10Json = await v10Resp.json();
          const qr = v10Json?.quoteSummary?.result?.[0];

          if (qr) {
            const ks = qr.defaultKeyStatistics || {};
            const fd = qr.financialData || {};
            const sd = qr.summaryDetail || {};
            const sp = qr.summaryProfile || {};

            // Key metrics
            const rv = v => v?.raw ?? v?.fmt ? parseFloat(String(v.fmt).replace(/[^0-9.\-]/g, "")) : null;
            data.fundamentals.per = rv(ks.forwardPE) || rv(sd.trailingPE);
            data.fundamentals.pbr = rv(ks.priceToBook);
            data.fundamentals.eps = rv(ks.trailingEps) || rv(fd.earningsPerShare);
            data.fundamentals.marketCap = rv(sd.marketCap);
            data.fundamentals.dividendYield = rv(sd.dividendYield);
            data.fundamentals.roe = rv(fd.returnOnEquity);
            data.fundamentals.operatingMargins = rv(fd.operatingMargins);
            data.fundamentals.profitMargins = rv(fd.profitMargins);
            data.fundamentals.debtToEquity = rv(fd.debtToEquity);
            data.fundamentals.beta = rv(ks.beta);
            data.fundamentals.targetPrice = rv(fd.targetMeanPrice);
            data.fundamentals.bps = rv(ks.bookValue);

            // Short Interest (US only, from defaultKeyStatistics)
            data.shortInterest = {
              sharesShort: rv(ks.sharesShort),
              sharesShortPriorMonth: rv(ks.sharesShortPriorMonth),
              shortRatio: rv(ks.shortRatio),
              shortPercentOfFloat: rv(ks.shortPercentOfFloat),
              sharesPercentSharesOut: rv(ks.sharesPercentSharesOut),
              dateShortInterest: ks.dateShortInterest?.fmt || null,
              sharesOutstanding: rv(ks.sharesOutstanding),
              floatShares: rv(ks.floatShares)
            };

            // Sector + Industry
            data.sector = sp.sector || null;
            data.industry = sp.industry || null;
            data.businessSummary = sp.longBusinessSummary ? sp.longBusinessSummary.slice(0, 300) : null;

            // Annual financials from incomeStatementHistory
            const ish = qr.incomeStatementHistory?.incomeStatementHistory || [];
            const bsh = qr.balanceSheetHistory?.balanceSheetStatements || [];
            const cfh = qr.cashflowStatementHistory?.cashflowStatements || [];
            if (ish.length) {
              data.annual = ish.slice(0, 4).map((s, idx) => {
                const bs = bsh[idx] || {};
                return {
                  year: s.endDate?.fmt?.slice(0, 4) || "",
                  revenue: rv(s.totalRevenue),
                  operatingProfit: rv(s.operatingIncome),
                  earnings: rv(s.netIncome),
                  opm: rv(s.totalRevenue) && rv(s.operatingIncome) ? (rv(s.operatingIncome) / rv(s.totalRevenue) * 100) : null,
                  eps: rv(s.netIncome) && rv(ks.sharesOutstanding) ? rv(s.netIncome) / rv(ks.sharesOutstanding) : null,
                  debtRatio: rv(bs.totalLiab) && rv(bs.totalStockholderEquity) && rv(bs.totalStockholderEquity) > 0
                    ? (rv(bs.totalLiab) / rv(bs.totalStockholderEquity) * 100) : null
                };
              }).reverse();
            }

            // US financials display (for existing UI compatibility)
            if (ish.length) {
              const latest = ish[0];
              const latestBs = bsh[0] || {};
              const latestCf = cfh[0] || {};
              const fmtB = v => { if (!v) return null; const n = rv(v); if (!n) return null; return Math.abs(n) >= 1e9 ? (n/1e9).toFixed(2)+"B" : Math.abs(n) >= 1e6 ? (n/1e6).toFixed(2)+"M" : String(n); };
              data.usFinancials = {
                period: latest.endDate?.fmt || null,
                income: {
                  "Revenue": fmtB(latest.totalRevenue),
                  "Operating expense": fmtB(latest.totalOperatingExpenses),
                  "Net income": fmtB(latest.netIncome),
                  "EBITDA": fmtB(latest.ebitda),
                  "Earnings per share": rv(ks.trailingEps)?.toFixed(2),
                  "Net profit margin": fd.profitMargins?.fmt,
                  "Effective tax rate": latest.incomeBeforeTax && latest.incomeTaxExpense
                    ? ((rv(latest.incomeTaxExpense)/rv(latest.incomeBeforeTax))*100).toFixed(1)+"%" : null
                },
                balance: {
                  "Total assets": fmtB(latestBs.totalAssets),
                  "Total liabilities": fmtB(latestBs.totalLiab),
                  "Total equity": fmtB(latestBs.totalStockholderEquity),
                  "Cash and short-term investments": fmtB(latestBs.cash),
                  "Price to book": ks.priceToBook?.fmt,
                  "Return on assets": fd.returnOnAssets?.fmt,
                  "Return on capital": fd.returnOnEquity?.fmt
                },
                cashflow: {
                  "Cash from operations": fmtB(latestCf.totalCashFromOperatingActivities),
                  "Cash from investing": fmtB(latestCf.totalCashflowsFinancingActivities),
                  "Free cash flow": fmtB(latestCf.freeCashFlow)
                }
              };
            }

            data.fundSource = "yahoo-v10";
            yahooV10Success = true;
          }
        } catch (e) { console.log("[YAHOO V10] Failed:", e.message); }

        // ── Google Finance fallback (if Yahoo v10 failed) ──
        if (!yahooV10Success) {
          try {
            const exchanges = ["NASDAQ", "NYSE", "NYSEARCA"];
            let gHtml = null, gExchange = "";
            for (const ex of exchanges) {
              const gResp = await fetch(`https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:${ex}`, {
                headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }
              });
              if (gResp.ok) { gHtml = await gResp.text(); if (gHtml.length > 10000) { gExchange = ex; break; } }
            }
            if (gHtml) {
              const gVal = (label) => { const re = new RegExp(label + '[\\s\\S]{0,500}?class="P6K39c">([^<]+)', 'i'); const m = gHtml.match(re); return m ? m[1].trim() : null; };
              const rawPE = gVal("P/E ratio"), rawMcap = gVal("Market cap"), rawDiv = gVal("Dividend yield");
              if (rawPE && !data.fundamentals.per) data.fundamentals.per = pn(rawPE);
              if (rawDiv && rawDiv.includes("%") && !data.fundamentals.dividendYield) data.fundamentals.dividendYield = pn(rawDiv) / 100;
              if (rawMcap && !data.fundamentals.marketCap) {
                if (rawMcap.includes("T")) data.fundamentals.marketCap = pn(rawMcap) * 1e12;
                else if (rawMcap.includes("B")) data.fundamentals.marketCap = pn(rawMcap) * 1e9;
                else if (rawMcap.includes("M")) data.fundamentals.marketCap = pn(rawMcap) * 1e6;
              }
              if (!data.sector) { const sm = gHtml.match(/\/finance\/markets\/sector\/([^"?&]+)/i); if (sm) data.sector = decodeURIComponent(sm[1]).replace(/_/g, " "); }
              if (!data.businessSummary) { const dm = [...gHtml.matchAll(/class="bLLb2d"[^>]*>([^<]{30,})/gi)]; if (dm.length) data.businessSummary = dm[dm.length-1][1].trim().slice(0,300); }
              if (!data.fundSource) data.fundSource = "google-finance";
            }
          } catch (ge) { console.log("[GFIN FALLBACK]", ge.message); }
        }
      }
    } catch (e) { console.log("[FUND ERROR]", e.message); }

    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

// ═══════════════════════════════════════════
// Helper: Naver Chart API (Korean stocks)
// ═══════════════════════════════════════════
async function fetchNaverChart(code, interval) {
  const tfMap = {
    "1m": "minute", "5m": "minute5", "10m": "minute10", "30m": "minute30",
    "60m": "minute60", "4h": "minute240",
    "1d": "day", "1wk": "week", "1mo": "month"
  };
  // Naver fchart has different max counts for intraday vs daily
  const countMap = {
    "1m": 500, "5m": 2000, "10m": 2000, "30m": 2000,
    "60m": 2000, "4h": 2000,
    "1d": 2500, "1wk": 520, "1mo": 240
  };
  const timeframe = tfMap[interval] || "day";
  const count = countMap[interval] || 500;

  const url = `https://fchart.stock.naver.com/sise.nhn?symbol=${code}&timeframe=${timeframe}&count=${count}&requestType=0`;
  console.log(`[NAVER FCHART] Request: ${code} tf=${timeframe} count=${count}`);
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
  });
  if (!resp.ok) throw new Error("Naver fchart HTTP " + resp.status);
  const xml = await resp.text();
  console.log(`[NAVER FCHART] Response length: ${xml.length} chars`);

  const items = [...xml.matchAll(/data="([^"]+)"/g)].map(m => m[1]);
  console.log(`[NAVER FCHART] Parsed items: ${items.length}`);
  if (items.length < 1) throw new Error("Naver fchart empty: " + items.length + " items, xml=" + xml.substring(0, 200));

  return items.map(row => {
    const [dt, open, high, low, close, volume] = row.split("|");
    const date = dt.length >= 12
      ? `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)} ${dt.slice(8,10)}:${dt.slice(10,12)}`
      : `${dt.slice(0,4)}-${dt.slice(4,6)}-${dt.slice(6,8)}`;
    return {
      date,
      open: parseInt(open) || 0,
      high: parseInt(high) || 0,
      low: parseInt(low) || 0,
      close: parseInt(close) || 0,
      volume: parseInt(volume) || 0
    };
  }).filter(d => d.close > 0);
}

// ═══════════════════════════════════════════
// Helper: Yahoo Finance v8 Chart
// ═══════════════════════════════════════════
async function fetchYahooChart(ticker, interval) {
  const rangeMap = {
    "1m": "7d", "5m": "60d", "10m": "60d", "15m": "60d", "30m": "60d",
    "60m": "2y", "4h": "2y",
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

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${int}&includePrePost=false`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
  const json = await resp.json();
  if (json.chart?.error) throw new Error(json.chart.error.description || "Yahoo API error");
  const result = json.chart?.result?.[0];
  if (!result) throw new Error("No data from Yahoo");

  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const meta = result.meta || {};

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

  // Aggregate 60m → 4h
  if (interval === "4h" && ohlcv.length > 0) {
    const agg = [];
    for (let i = 0; i < ohlcv.length; i += 4) {
      const chunk = ohlcv.slice(i, i + 4);
      agg.push({
        date: chunk[0].date, open: chunk[0].open,
        high: Math.max(...chunk.map(c => c.high)),
        low: Math.min(...chunk.map(c => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((s, c) => s + c.volume, 0)
      });
    }
    ohlcv = agg;
  }

  return { ohlcv, meta };
}

// ═══════════════════════════════════════════
// Helper: Resolve Korean .KS / .KQ
// ═══════════════════════════════════════════
async function resolveKRTicker(code) {
  for (const suffix of [".KS", ".KQ"]) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suffix}?range=1d&interval=1d`;
      const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      const json = await resp.json();
      if (!json.chart?.error && json.chart?.result?.[0]?.timestamp?.length) return code + suffix;
    } catch (e) { continue; }
  }
  return code + ".KS";
}

async function getKRName(code) {
  try {
    const resp = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`, {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }
    });
    const json = await resp.json();
    return json?.stockName || null;
  } catch (e) { return null; }
}
