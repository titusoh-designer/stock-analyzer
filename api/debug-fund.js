// Debug: /api/debug-fund?symbol=AAPL or ?symbol=005930
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const symbol = req.query.symbol || "AAPL";
  const results = { symbol };

  // Detect Korean vs US
  const code = symbol.replace(/[^0-9]/g, "");
  const isKR = code.length >= 4 && /^[0-9]+$/.test(code);

  if (isKR) {
    results.type = "Korean";
    // Already confirmed working
    try {
      const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`);
      results.kr_integration = { status: r.status, preview: (await r.text()).slice(0, 500) };
    } catch(e) { results.kr_integration_error = e.message; }

  } else {
    results.type = "US/World";
    const name = symbol.replace(/\.(KS|KQ|O|N|A)$/, "");

    // Test various Naver worldstock endpoints
    const suffixes = [".O", ".N", ".A"]; // NASDAQ, NYSE, AMEX
    for (const sfx of suffixes) {
      const ticker = name + sfx;
      try {
        const r = await fetch(`https://m.stock.naver.com/api/worldstock/stock/${ticker}/integration`);
        const status = r.status;
        const text = await r.text();
        results[`worldstock_${sfx}_integration`] = { status, length: text.length, preview: text.slice(0, 600) };
        if (status === 200 && text.length > 100) {
          results.working_suffix = sfx;
          results.working_ticker = ticker;
          break; // Found working one
        }
      } catch(e) { results[`worldstock_${sfx}_error`] = e.message; }
    }

    // Test finance endpoints with working ticker
    if (results.working_ticker) {
      const wt = results.working_ticker;
      try {
        const r = await fetch(`https://m.stock.naver.com/api/worldstock/stock/${wt}/finance/annual`);
        results.worldstock_annual = { status: r.status, preview: (await r.text()).slice(0, 600) };
      } catch(e) { results.worldstock_annual_error = e.message; }

      try {
        const r = await fetch(`https://m.stock.naver.com/api/worldstock/stock/${wt}/finance/quarter`);
        results.worldstock_quarter = { status: r.status, preview: (await r.text()).slice(0, 600) };
      } catch(e) { results.worldstock_quarter_error = e.message; }
    }

    // Also test crypto
    if (symbol.includes("-USD") || symbol.includes("BTC") || symbol.includes("ETH")) {
      results.note = "Crypto - Naver worldstock likely does not support crypto";
    }
  }

  return res.status(200).json(results);
}
