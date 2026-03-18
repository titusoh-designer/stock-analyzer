// Debug: /api/debug-fund?symbol=005930 or ?symbol=AAPL
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const symbol = req.query.symbol || "005930";
  const R = { symbol };

  const code = symbol.replace(/[^0-9]/g, "");
  const isKR = code.length >= 4 && /^[0-9]+$/.test(code);

  if (isKR) {
    R.type = "Korean";

    // 1) Naver integration - check ALL fields
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`);
      const j = await r.json();
      R.naver_int = {
        status: r.status,
        keys: Object.keys(j),
        stockName: j.stockName,
        sectorName: j.sectorName || "MISSING",
        industryName: j.industryName || "MISSING",
        industryCode: j.industryCode || "MISSING",
        description: j.description ? j.description.slice(0, 200) : "MISSING",
        totalInfos: j.totalInfos?.map(i => `${i.code}=${i.value}`),
        industryCompareInfo: j.industryCompareInfo || "MISSING",
        consensusInfo: j.consensusInfo ? "EXISTS" : "MISSING"
      };
    } catch(e) { R.naver_int_error = e.message; }

    // 2) Naver company overview (different endpoint)
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/basic`);
      R.naver_basic = { status: r.status, preview: (await r.text()).slice(0, 600) };
    } catch(e) { R.naver_basic_error = e.message; }

    // 3) Naver finance/annual
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/finance/annual`);
      const j = await r.json();
      R.naver_annual = {
        status: r.status,
        titles: j.financeInfo?.trTitleList?.map(t => t.title),
        rows: j.financeInfo?.rowList?.map(r => r.title)
      };
    } catch(e) { R.naver_annual_error = e.message; }

    // 4) Naver finance/quarter  
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/finance/quarter`);
      const j = await r.json();
      R.naver_quarter = {
        status: r.status,
        titles: j.financeInfo?.trTitleList?.map(t => `${t.title}(${t.isConsensus})`),
        rows: j.financeInfo?.rowList?.map(r => r.title)
      };
    } catch(e) { R.naver_quarter_error = e.message; }

    // 5) Naver /api/stock/{code} (main stock info)
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${code}`);
      R.naver_stock = { status: r.status, preview: (await r.text()).slice(0, 600) };
    } catch(e) { R.naver_stock_error = e.message; }

    // 6) KRX sector info (via naver industry page)
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/industryGroup`);
      R.naver_industry = { status: r.status, preview: (await r.text()).slice(0, 600) };
    } catch(e) { R.naver_industry_error = e.message; }

  } else {
    R.type = "US";

    // 1) Google Finance (scrape test)
    try {
      const gUrl = `https://www.google.com/finance/quote/${symbol}:NASDAQ`;
      const gResp = await fetch(gUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      R.google_finance = { status: gResp.status, length: (await gResp.text()).length };
    } catch(e) { R.google_finance_error = e.message; }

    // 2) Yahoo v8 chart meta (expanded fields test)
    try {
      const cUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`;
      const cResp = await fetch(cUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const cJson = await cResp.json();
      const meta = cJson?.chart?.result?.[0]?.meta || {};
      R.yahoo_chart_meta = meta;
    } catch(e) { R.yahoo_chart_error = e.message; }

    // 3) Naver worldstock (different URL patterns)
    const patterns = [
      `https://m.stock.naver.com/api/worldstock/stock/${symbol}.O/integration`,
      `https://m.stock.naver.com/api/worldstock/stock/${symbol}.N/integration`,
      `https://m.stock.naver.com/api/worldstock/stock/${symbol}%3AUS/integration`,
      `https://m.stock.naver.com/api/worldstock/stock/${symbol}/integration`,
      `https://api.stock.naver.com/world/stock/${symbol}.O/integration`,
    ];
    for (const url of patterns) {
      try {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const text = await r.text();
        const key = url.split("/").slice(-2).join("/");
        R[`naver_${key}`] = { status: r.status, length: text.length, isJson: text.startsWith("{"), preview: text.slice(0, 300) };
        if (r.status === 200 && text.startsWith("{")) { R.naver_working_url = url; break; }
      } catch(e) {}
    }

    // 4) Stockanalysis.com API test
    try {
      const saUrl = `https://stockanalysis.com/api/symbol/s/${symbol.toLowerCase()}`;
      const saResp = await fetch(saUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      R.stockanalysis = { status: saResp.status, preview: (await saResp.text()).slice(0, 400) };
    } catch(e) { R.stockanalysis_error = e.message; }
  }

  return res.status(200).json(R);
}
