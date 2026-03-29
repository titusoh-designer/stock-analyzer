// Vercel Serverless — Signal Scanner
// A: 5-indicator bull (M.A/S.T/DMI/B.B/I.M, 3/5+)
// C: 강한상승예상 (5 conditions simultaneous)

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
      let ohlcv = [], name = sym.name || ticker, currency = "USD", currentPrice = 0;

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
              open: yQ.open?.[i] ?? 0, high: yQ.high?.[i] ?? 0, low: yQ.low?.[i] ?? 0,
              close: yQ.close?.[i] ?? 0, volume: yQ.volume?.[i] ?? 0
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
        const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {}, meta = result.meta || {};
        ohlcv = ts.map((t, i) => ({
          date: new Date(t * 1000).toISOString().split("T")[0],
          open: q.open?.[i] ?? 0, high: q.high?.[i] ?? 0, low: q.low?.[i] ?? 0,
          close: q.close?.[i] ?? 0, volume: q.volume?.[i] ?? 0
        })).filter(d => d.close > 0);
        currency = meta.currency || "USD";
        currentPrice = meta.regularMarketPrice || (ohlcv.length ? ohlcv[ohlcv.length - 1].close : 0);
        if (!name || name === ticker) name = meta.longName || meta.shortName || ticker;
      }

      if (ohlcv.length < 30) continue;

      // ══════ INDICATORS ══════
      const cls = ohlcv.map(d => d.close), vols = ohlcv.map(d => d.volume);

      // MACD line & signal
      const ema = (arr, n) => { const k = 2 / (n + 1); let e = [arr[0]]; for (let j = 1; j < arr.length; j++) e.push(arr[j] * k + e[j - 1] * (1 - k)); return e; };
      const e12 = ema(cls, 12), e26 = ema(cls, 26);
      const macdLine = e12.map((v, j) => v - e26[j]);
      const sigLine = ema(macdLine.slice(26), 9);
      const macdSig = []; for (let j = 0; j < cls.length; j++) macdSig.push(j >= 34 ? sigLine[j - 26] || null : null);
      const macdHist = macdLine.map((v, j) => macdSig[j] != null ? v - macdSig[j] : null);

      // Supertrend (10, 3)
      const atrST = [];
      for (let j = 0; j < ohlcv.length; j++) {
        if (j < 1) { atrST.push(ohlcv[j].high - ohlcv[j].low); continue; }
        atrST.push(Math.max(ohlcv[j].high - ohlcv[j].low, Math.abs(ohlcv[j].high - cls[j - 1]), Math.abs(ohlcv[j].low - cls[j - 1])));
      }
      const atrSMA = []; for (let j = 0; j < atrST.length; j++) atrSMA.push(j >= 9 ? atrST.slice(j - 9, j + 1).reduce((a, b) => a + b, 0) / 10 : null);
      const stUp = [], stDn = [], stDir = [];
      for (let j = 0; j < ohlcv.length; j++) {
        const hl2 = (ohlcv[j].high + ohlcv[j].low) / 2, atr = atrSMA[j];
        if (!atr) { stUp.push(null); stDn.push(null); stDir.push(0); continue; }
        let up = hl2 - 3 * atr, dn = hl2 + 3 * atr;
        if (j > 0 && stUp[j - 1] != null && cls[j - 1] > stUp[j - 1]) up = Math.max(up, stUp[j - 1]);
        if (j > 0 && stDn[j - 1] != null && cls[j - 1] < stDn[j - 1]) dn = Math.min(dn, stDn[j - 1]);
        stUp.push(up); stDn.push(dn);
        let dir = j > 0 ? stDir[j - 1] : 1;
        if (cls[j] > dn) dir = 1; else if (cls[j] < up) dir = -1;
        stDir.push(dir);
      }

      // DMI (+DI, -DI)
      const pDI = [], mDI = [];
      for (let j = 0; j < ohlcv.length; j++) {
        if (j < 14) { pDI.push(null); mDI.push(null); continue; }
        let pS = 0, mS = 0, trS = 0;
        for (let k = j - 13; k <= j; k++) {
          const hi = ohlcv[k].high - ohlcv[k - 1].high, lo = ohlcv[k - 1].low - ohlcv[k].low;
          pS += (hi > lo && hi > 0) ? hi : 0; mS += (lo > hi && lo > 0) ? lo : 0;
          trS += Math.max(ohlcv[k].high - ohlcv[k].low, Math.abs(ohlcv[k].high - cls[k - 1]), Math.abs(ohlcv[k].low - cls[k - 1]));
        }
        pDI.push(trS > 0 ? (pS / trS) * 100 : 0); mDI.push(trS > 0 ? (mS / trS) * 100 : 0);
      }

      // MA20 (BB middle)
      const ma20 = []; for (let j = 0; j < cls.length; j++) ma20.push(j >= 19 ? cls.slice(j - 19, j + 1).reduce((a, b) => a + b, 0) / 20 : null);

      // Ichimoku cloud
      const ichiA = [], ichiB = [];
      for (let j = 0; j < cls.length; j++) {
        const ia = j >= 51 ? (() => { const t2 = (Math.max(...ohlcv.slice(j - 34, j - 25).map(d => d.high)) + Math.min(...ohlcv.slice(j - 34, j - 25).map(d => d.low))) / 2; const k2 = (Math.max(...ohlcv.slice(j - 51, j - 25).map(d => d.high)) + Math.min(...ohlcv.slice(j - 51, j - 25).map(d => d.low))) / 2; return (t2 + k2) / 2; })() : null;
        const ib = j >= 77 ? (Math.max(...ohlcv.slice(j - 77, j - 25).map(d => d.high)) + Math.min(...ohlcv.slice(j - 77, j - 25).map(d => d.low))) / 2 : null;
        ichiA.push(ia); ichiB.push(ib);
      }

      // BB width + vol avg (for C signal)
      const bbWidths = [], volAvg = [];
      for (let j = 0; j < cls.length; j++) {
        if (j < 19) { bbWidths.push(null); volAvg.push(null); continue; }
        const sl = cls.slice(j - 19, j + 1), avg = sl.reduce((a, b) => a + b, 0) / 20;
        const std = Math.sqrt(sl.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / 20);
        bbWidths.push((4 * std) / (avg || 1));
        volAvg.push(vols.slice(j - 19, j + 1).reduce((a, b) => a + b, 0) / 20);
      }

      // ATR(14) for C signal
      const atr14 = [];
      for (let j = 0; j < atrST.length; j++) {
        if (j < 13) { atr14.push(null); continue; }
        if (j === 13) { atr14.push(atrST.slice(0, 14).reduce((a, b) => a + b, 0) / 14); continue; }
        atr14.push((atr14[j - 1] * 13 + atrST[j]) / 14);
      }

      // ═══ RSI(14) for indicators ═══
      const rsiArr = [];
      { let ag = 0, al = 0;
        for (let j = 1; j <= 14 && j < cls.length; j++) { const d = cls[j] - cls[j-1]; d > 0 ? ag += d : al += Math.abs(d); }
        ag /= 14; al /= 14;
        for (let j = 0; j < cls.length; j++) {
          if (j < 14) { rsiArr.push(null); continue; }
          if (j > 14) { const d = cls[j] - cls[j-1]; ag = (ag * 13 + (d > 0 ? d : 0)) / 14; al = (al * 13 + (d < 0 ? Math.abs(d) : 0)) / 14; }
          rsiArr.push(al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(1));
        }
      }

      // ═══ ADX(14) for indicators ═══
      let adxValue = null;
      if (pDI.length > 28) {
        const dxArr = [];
        for (let j = 14; j < pDI.length; j++) {
          if (pDI[j] == null || mDI[j] == null) continue;
          const sum = pDI[j] + mDI[j];
          dxArr.push(sum > 0 ? Math.abs(pDI[j] - mDI[j]) / sum * 100 : 0);
        }
        if (dxArr.length >= 14) {
          let adx = dxArr.slice(0, 14).reduce((a, b) => a + b, 0) / 14;
          for (let j = 14; j < dxArr.length; j++) adx = (adx * 13 + dxArr[j]) / 14;
          adxValue = +adx.toFixed(1);
        }
      }

      // ═══ MA Alignment Score (-100 ~ +100) ═══
      let maAlignScore = 0;
      { const lastIdx = cls.length - 1;
        const ma5v = lastIdx >= 4 ? cls.slice(lastIdx - 4, lastIdx + 1).reduce((a, b) => a + b, 0) / 5 : null;
        const ma20v = ma20[lastIdx];
        const ma60v = lastIdx >= 59 ? cls.slice(lastIdx - 59, lastIdx + 1).reduce((a, b) => a + b, 0) / 60 : null;
        if (ma5v && ma20v && ma60v) {
          const cp = cls[lastIdx];
          if (cp > ma5v && ma5v > ma20v && ma20v > ma60v) maAlignScore = 100;
          else if (cp > ma5v && ma5v > ma20v) maAlignScore = 60;
          else if (cp > ma20v) maAlignScore = 20;
          else if (cp < ma5v && ma5v < ma20v && ma20v < ma60v) maAlignScore = -100;
          else if (cp < ma5v && ma5v < ma20v) maAlignScore = -60;
          else if (cp < ma20v) maAlignScore = -20;
        }
      }

      // ══════ SCAN ══════
      let allSignals = [];
      const scanStart = Math.max(25, ohlcv.length - scanDays);

      for (let i = scanStart; i < ohlcv.length; i++) {
        const daysAgo = ohlcv.length - 1 - i;

        // ═══ A. 5-indicator bull signal ═══
        const buys = [];
        if (i >= 35 && macdLine[i - 1] <= macdSig[i - 1] && macdLine[i] > macdSig[i]) buys.push("M.A");
        if (stDir[i] === 1 && stDir[i - 1] === -1) buys.push("S.T");
        if (pDI[i] != null && mDI[i] != null && pDI[i - 1] != null && mDI[i - 1] != null && pDI[i - 1] <= mDI[i - 1] && pDI[i] > mDI[i]) buys.push("DMI");
        if (ma20[i] != null && ma20[i - 1] != null && cls[i - 1] <= ma20[i - 1] && cls[i] > ma20[i]) buys.push("B.B");
        if (ichiA[i] != null && ichiB[i] != null) {
          const ct = Math.max(ichiA[i], ichiB[i]);
          const pct = (ichiA[i - 1] != null && ichiB[i - 1] != null) ? Math.max(ichiA[i - 1], ichiB[i - 1]) : null;
          if (pct != null && cls[i - 1] <= pct && cls[i] > ct) buys.push("I.M");
        }
        if (buys.length >= 3) {
          allSignals.push({ type: "A", date: ohlcv[i].date, signals: buys, count: buys.length, price: cls[i], daysAgo });
        }

        // ═══ C. 강한상승예상 ═══
        if (i >= 25 && bbWidths[i] != null) {
          const bbR = bbWidths.slice(Math.max(0, i - 20), i + 1).filter(Boolean);
          if (bbR.length >= 10) {
            const bbS = [...bbR].sort((a, b) => a - b);
            const c1 = bbWidths[i] <= bbS[Math.floor(bbS.length * 0.2)];
            const c2 = atr14[i] != null && atr14[Math.max(0, i - 5)] != null && atr14[i] < atr14[i - 5];
            let c3 = false;
            if (i >= 10) {
              const rH = Math.max(...ohlcv.slice(i - 4, i + 1).map(d => d.high));
              const rL = Math.min(...ohlcv.slice(i - 4, i + 1).map(d => d.low));
              const pH = Math.max(...ohlcv.slice(i - 9, i - 4).map(d => d.high));
              const pL = Math.min(...ohlcv.slice(i - 9, i - 4).map(d => d.low));
              c3 = rH < pH && rL > pL;
            }
            const vr = volAvg[i] ? vols[i] / volAvg[i] : 0;
            if (c1 && c2 && c3 && vr >= 1.5 && cls[i] >= ohlcv[i].open) {
              allSignals.push({ type: "C", date: ohlcv[i].date, signals: ["BB수렴", "ATR↓", "범위↓", "Vol×" + vr.toFixed(1), "양봉"], count: 5, price: cls[i], daysAgo });
            }
          }
        }
      }

      if (allSignals.length > 0) {
        allSignals.sort((a, b) => { if (a.type !== b.type) return a.type === "C" ? -1 : 1; return (b.count - a.count) || (a.daysAgo - b.daysAgo); });
        const top = allSignals.slice(0, 10);
        const change = ohlcv.length >= 2 ? ((cls[cls.length - 1] / cls[cls.length - 2] - 1) * 100).toFixed(2) : 0;

        // Weekly aggregation for mini chart
        const weekly = [];
        for (let w = 0; w < ohlcv.length; w += 5) {
          const wk = ohlcv.slice(w, w + 5);
          if (!wk.length) continue;
          weekly.push({ c: wk[wk.length - 1].close, h: Math.max(...wk.map(d => d.high)), l: Math.min(...wk.map(d => d.low)) });
        }
        // Calculate MAs on FULL weekly data, then slice to visible range
        const wkCls = weekly.map(w => w.c);
        const wkMA20Full = [], wkMA22Full = [];
        for (let j = 0; j < weekly.length; j++) {
          wkMA20Full.push(j >= 19 ? wkCls.slice(j - 19, j + 1).reduce((a, b) => a + b, 0) / 20 : null);
          wkMA22Full.push(j >= 21 ? wkCls.slice(j - 21, j + 1).reduce((a, b) => a + b, 0) / 22 : null);
        }
        const sliceStart = Math.max(0, weekly.length - 52);
        const wk52 = weekly.slice(sliceStart);
        const miniMA20 = wkMA20Full.slice(sliceStart);
        const miniMA22 = wkMA22Full.slice(sliceStart);

        // Fetch basic fundamentals (Korean=Naver, US=Google Finance)
        let fund = null;
        const pn = s => s ? parseFloat(String(s).replace(/[^0-9.\-]/g, "")) : null;
        try {
          if (source === "naver") {
            const fCode = ticker.replace(/\.(KS|KQ)$/, "").replace(/[^0-9]/g, "");
            const intResp = await fetch(`https://m.stock.naver.com/api/stock/${fCode}/integration`);
            if (intResp.ok) {
              const intJson = await intResp.json();
              const infos = {};
              (intJson.totalInfos || []).forEach(i => { infos[i.code] = i.value; });
              const parseMcap = s => { if (!s) return null; const t = s.match(/([\d,]+)조/); const e = s.match(/([\d,]+)억/); return (t ? parseFloat(t[1].replace(/,/g, "")) * 1e12 : 0) + (e ? parseFloat(e[1].replace(/,/g, "")) * 1e8 : 0); };
              const krxSectors = {"278":"반도체","298":"가정용기기와용품","266":"전자제품","274":"디스플레이","281":"IT하드웨어","285":"반도체장비","263":"소프트웨어","271":"자동차","275":"건설","277":"화학","282":"의약품","283":"바이오","286":"은행","287":"증권","289":"부동산","295":"유통"};
              fund = {
                sector: krxSectors[intJson.industryCode] || "", industry: intJson.industryName || "",
                marketCap: parseMcap(infos.marketValue),
                per: pn(infos.per), pbr: pn(infos.pbr), roe: null, opm: null,
                quarterly: []
              };
            }
            // Quarterly
            const qResp = await fetch(`https://m.stock.naver.com/api/stock/${fCode}/finance/quarter`);
            if (qResp.ok && fund) {
              const qJson = await qResp.json();
              const fi = qJson.financeInfo;
              if (fi?.rowList && fi?.trTitleList) {
                const titles = fi.trTitleList.filter(t => t.isConsensus === "N").slice(-4);
                const rows = {}; fi.rowList.forEach(r => { rows[r.title] = r.columns; });
                fund.quarterly = titles.map(t => ({
                  q: t.title.replace(/\./g, ""),
                  rev: rows["매출액"]?.[t.key]?.value ? parseFloat(rows["매출액"][t.key].value.replace(/,/g, "")) * 1e6 : null,
                  opProfit: rows["영업이익"]?.[t.key]?.value ? parseFloat(rows["영업이익"][t.key].value.replace(/,/g, "")) * 1e6 : null,
                  earn: rows["당기순이익"]?.[t.key]?.value ? parseFloat(rows["당기순이익"][t.key].value.replace(/,/g, "")) * 1e6 : null
                }));
                const lq = fund.quarterly[fund.quarterly.length - 1];
                if (lq?.rev && lq?.opProfit) fund.opm = (lq.opProfit / lq.rev) * 100;
              }
            }
          } else {
            // US stocks: Google Finance scraping
            try {
              const exchanges = ["NASDAQ", "NYSE", "NYSEARCA"];
              let gHtml = null;
              for (const ex of exchanges) {
                const gResp = await fetch(`https://www.google.com/finance/quote/${encodeURIComponent(ticker)}:${ex}`, {
                  headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" }
                });
                if (gResp.ok) { gHtml = await gResp.text(); if (gHtml.length > 10000) break; }
              }
              if (gHtml) {
                const gVal = (label) => { const re = new RegExp(label + '[\\s\\S]{0,500}?class="P6K39c">([^<]+)', 'i'); const m = gHtml.match(re); return m ? m[1].trim() : null; };
                const rawPE = gVal("P/E ratio"), rawMcap = gVal("Market cap"), rawDiv = gVal("Dividend yield");
                fund = { sector: "", industry: "", per: pn(rawPE), pbr: null, roe: null, opm: null, quarterly: [] };
                if (rawMcap) {
                  if (rawMcap.includes("T")) fund.marketCap = pn(rawMcap) * 1e12;
                  else if (rawMcap.includes("B")) fund.marketCap = pn(rawMcap) * 1e9;
                  else if (rawMcap.includes("M")) fund.marketCap = pn(rawMcap) * 1e6;
                }
                if (rawDiv && rawDiv.includes("%")) fund.dividendYield = pn(rawDiv) / 100;
                const secMatch = gHtml.match(/\/finance\/markets\/sector\/([^"?&]+)/i);
                if (secMatch) fund.sector = decodeURIComponent(secMatch[1]).replace(/_/g, " ");
                // Revenue from table
                const tblMatch = gHtml.match(/Revenue<\/div>[\s\S]{0,300}?Net income[\s\S]{0,3000}?<\/table>/i);
                if (tblMatch) {
                  const qVals = [...tblMatch[0].matchAll(/class="QXDnM">([^<]+)/g)].map(m => m[1].trim());
                  if (qVals.length >= 2) fund.usFinance = { revenue: qVals[0], netIncome: qVals[1] };
                }
              }
            } catch(ge) {}
          }
        } catch (e) { /* fundamentals optional */ }

        // Current indicator values for signal scoring
        const lastIdx = cls.length - 1;
        const curRsi = rsiArr[lastIdx];
        const curMacdHist = macdHist[lastIdx] || null;
        const curAtr = atr14[lastIdx] || null;
        const curBbWidth = bbWidths[lastIdx] || null;
        const curVolRatio = volAvg[lastIdx] ? +(vols[lastIdx] / volAvg[lastIdx]).toFixed(2) : null;

        results.push({
          symbol: ticker, name, source, currency, currentPrice, change: +change,
          starSignals: top, bestSignal: top[0],
          mini: wk52, miniMA20, miniMA22, fund, dataLen: ohlcv.length,
          indicators: {
            rsi: curRsi,
            macdHist: curMacdHist,
            atr: curAtr ? +curAtr.toFixed(2) : null,
            bbWidth: curBbWidth ? +(curBbWidth * 100).toFixed(1) : null,
            adx: adxValue,
            maAlign: maAlignScore,
            volRatio: curVolRatio
          }
        });
      }
    } catch (e) { /* skip */ }
  }

  return res.status(200).json({ results, scannedAt: new Date().toISOString(), count: results.length });
}
