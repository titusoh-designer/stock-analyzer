// Debug endpoint: /api/debug-fund?symbol=AAPL or ?symbol=005930.KS
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const symbol = req.query.symbol || "AAPL";
  const results = {};

  // 1. Yahoo v7 quote (might work without crumb)
  try {
    const qUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const qResp = await fetch(qUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    results.v7_quote_status = qResp.status;
    const qText = await qResp.text();
    results.v7_quote_length = qText.length;
    results.v7_quote_preview = qText.slice(0, 1000);
  } catch(e) { results.v7_quote_error = e.message; }

  // 2. Yahoo v6 quote
  try {
    const q6Url = `https://query2.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const q6Resp = await fetch(q6Url, { headers: { "User-Agent": "Mozilla/5.0" } });
    results.v6_quote_status = q6Resp.status;
    const q6Text = await q6Resp.text();
    results.v6_quote_length = q6Text.length;
    results.v6_quote_preview = q6Text.slice(0, 1000);
  } catch(e) { results.v6_quote_error = e.message; }

  // 3. Financial Modeling Prep (free, no key needed for basic)
  try {
    const fmpUrl = `https://financialmodelingprep.com/api/v3/profile/${encodeURIComponent(symbol)}?apikey=demo`;
    const fmpResp = await fetch(fmpUrl);
    results.fmp_status = fmpResp.status;
    const fmpText = await fmpResp.text();
    results.fmp_preview = fmpText.slice(0, 800);
  } catch(e) { results.fmp_error = e.message; }

  // 4. Korean: Naver integration
  const code = symbol.replace(/[^0-9]/g, "");
  if (code.length >= 4) {
    try {
      const nUrl = `https://m.stock.naver.com/api/stock/${code}/integration`;
      const nResp = await fetch(nUrl);
      results.naver_integration_status = nResp.status;
      const nJson = await nResp.json();
      results.naver_integration_keys = Object.keys(nJson);
      results.naver_totalInfos = nJson.totalInfos?.map(i => ({ code: i.code, key: i.key, value: i.value }));
      results.naver_stockName = nJson.stockName;
      results.naver_sectorName = nJson.sectorName;
      results.naver_industryName = nJson.industryName;
    } catch(e) { results.naver_integration_error = e.message; }

    try {
      const qUrl = `https://m.stock.naver.com/api/stock/${code}/finance/quarter`;
      const qResp = await fetch(qUrl);
      results.naver_quarter_status = qResp.status;
      const qText = await qResp.text();
      results.naver_quarter_preview = qText.slice(0, 1000);
    } catch(e) { results.naver_quarter_error = e.message; }

    try {
      const rUrl = `https://m.stock.naver.com/api/stock/${code}/finance/ratio`;
      const rResp = await fetch(rUrl);
      results.naver_ratio_status = rResp.status;
      const rText = await rResp.text();
      results.naver_ratio_preview = rText.slice(0, 1000);
    } catch(e) { results.naver_ratio_error = e.message; }
  }

  return res.status(200).json(results);
}
