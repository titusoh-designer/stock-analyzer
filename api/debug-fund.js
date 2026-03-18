// Debug endpoint: /api/debug-fund?symbol=AAPL or ?symbol=005930
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const symbol = req.query.symbol || "AAPL";
  const results = {};

  // 1. Yahoo quoteSummary (US stocks)
  try {
    const yUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=defaultKeyStatistics,financialData,summaryDetail,price,assetProfile,earnings`;
    const yResp = await fetch(yUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    results.yahoo_status = yResp.status;
    results.yahoo_headers = Object.fromEntries(yResp.headers.entries());
    const yText = await yResp.text();
    results.yahoo_length = yText.length;
    results.yahoo_preview = yText.slice(0, 500);
    try { results.yahoo_json = JSON.parse(yText); } catch(e) { results.yahoo_parse_error = e.message; }
  } catch(e) { results.yahoo_error = e.message; }

  // 2. Yahoo v8 chart (already works - check what meta contains)
  try {
    const cUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const cResp = await fetch(cUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    const cJson = await cResp.json();
    const meta = cJson?.chart?.result?.[0]?.meta || {};
    results.chart_meta_keys = Object.keys(meta);
    results.chart_meta_sample = {
      shortName: meta.shortName, longName: meta.longName, 
      exchangeName: meta.exchangeName, currency: meta.currency,
      regularMarketPrice: meta.regularMarketPrice
    };
  } catch(e) { results.chart_error = e.message; }

  // 3. Korean stock: Naver integration API
  const code = symbol.replace(/[^0-9]/g, "");
  if (code.length >= 4) {
    try {
      const nUrl = `https://m.stock.naver.com/api/stock/${code}/integration`;
      const nResp = await fetch(nUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      results.naver_integration_status = nResp.status;
      const nText = await nResp.text();
      results.naver_integration_length = nText.length;
      results.naver_integration_preview = nText.slice(0, 800);
    } catch(e) { results.naver_integration_error = e.message; }

    try {
      const rUrl = `https://m.stock.naver.com/api/stock/${code}/finance/annual`;
      const rResp = await fetch(rUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      results.naver_annual_status = rResp.status;
      const rText = await rResp.text();
      results.naver_annual_length = rText.length;
      results.naver_annual_preview = rText.slice(0, 800);
    } catch(e) { results.naver_annual_error = e.message; }
  }

  return res.status(200).json(results);
}
