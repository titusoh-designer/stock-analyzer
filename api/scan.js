// ═══════════════════════════════════════════
// scan.js PATCH — 2 changes to apply:
// ═══════════════════════════════════════════
//
// CHANGE 1: After line 138 (atr14 계산 뒤), 아래 RSI + ADX + MA정배열 계산 추가:
//
// ---------- INSERT AFTER atr14 calculation ----------

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
      { const pdm = [], mdm = [], trs2 = [];
        for (let j = 1; j < ohlcv.length; j++) {
          const h = ohlcv[j].high, l = ohlcv[j].low, ph = ohlcv[j-1].high, pl = ohlcv[j-1].low, pc = cls[j-1];
          const up = h - ph, dn = pl - l;
          pdm.push(up > dn && up > 0 ? up : 0); mdm.push(dn > up && dn > 0 ? dn : 0);
          trs2.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        }
        if (pdm.length >= 28) {
          const smooth = (arr) => { let s = arr.slice(0, 14).reduce((a, b) => a + b, 0); const r = [s]; for (let j = 14; j < arr.length; j++) { s = s - s/14 + arr[j]; r.push(s); } return r; };
          const sPdm = smooth(pdm), sNdm = smooth(mdm), sTr = smooth(trs2);
          const dx = sPdm.map((v, j) => { const p = v / sTr[j] * 100, m = sNdm[j] / sTr[j] * 100; return Math.abs(p - m) / (p + m || 1) * 100; });
          if (dx.length >= 14) { let adx = dx.slice(0, 14).reduce((a, b) => a + b, 0) / 14; for (let j = 14; j < dx.length; j++) adx = (adx * 13 + dx[j]) / 14; adxValue = +adx.toFixed(1); }
        }
      }

      // ═══ MA Alignment Score (-100 ~ +100) ═══
      let maAlignScore = 0;
      { const last = cls.length - 1;
        const ma5v = last >= 4 ? cls.slice(last - 4, last + 1).reduce((a, b) => a + b, 0) / 5 : null;
        const ma20v = last >= 19 ? cls.slice(last - 19, last + 1).reduce((a, b) => a + b, 0) / 20 : null;
        const ma60v = last >= 59 ? cls.slice(last - 59, last + 1).reduce((a, b) => a + b, 0) / 60 : null;
        if (ma5v && ma20v && ma60v) {
          // Perfect bull: 가격 > MA5 > MA20 > MA60
          if (cls[last] > ma5v && ma5v > ma20v && ma20v > ma60v) maAlignScore = 100;
          else if (cls[last] > ma20v && ma20v > ma60v) maAlignScore = 70;
          else if (cls[last] > ma60v) maAlignScore = 30;
          else if (cls[last] < ma5v && ma5v < ma20v && ma20v < ma60v) maAlignScore = -100;
          else if (cls[last] < ma20v && ma20v < ma60v) maAlignScore = -70;
          else if (cls[last] < ma60v) maAlignScore = -30;
        }
      }

// ---------- END INSERT ----------
//
//
// CHANGE 2: Replace the results.push (line 281-285) with this version that includes indicators:
//
// ---------- REPLACE results.push ----------

        // Current indicator values for signal matrix
        const lastIdx = cls.length - 1;
        const curRsi = rsiArr[lastIdx];
        const curMacdHist = lastIdx >= 34 ? +(macdLine[lastIdx] - (macdSig[lastIdx] || 0)).toFixed(4) : null;
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

// ---------- END REPLACE ----------
