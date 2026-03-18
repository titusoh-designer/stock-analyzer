// Debug: /api/debug-fund?symbol=AAPL — shows HTML snippets from Google Finance
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const symbol = req.query.symbol || "AAPL";
  const R = { symbol };

  const exchanges = ["NASDAQ", "NYSE", "NYSEARCA"];
  let gHtml = null;
  for (const ex of exchanges) {
    try {
      const r = await fetch(`https://www.google.com/finance/quote/${encodeURIComponent(symbol)}:${ex}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" }
      });
      if (r.ok) { gHtml = await r.text(); if (gHtml.length > 10000) { R.exchange = ex; R.htmlLength = gHtml.length; break; } }
    } catch(e) {}
  }

  if (!gHtml) { R.error = "No Google Finance HTML"; return res.status(200).json(R); }

  // Extract 200-char snippets around key labels
  const labels = ["P/E ratio", "Market cap", "Dividend yield", "Earnings per share", "Return on equity", "Operating margin", "Profit margin", "Price-to-book", "Revenue", "Net income", "About", "sector", "bLLb2d", "description"];
  R.snippets = {};
  for (const label of labels) {
    const idx = gHtml.indexOf(label);
    if (idx >= 0) {
      R.snippets[label] = { found: true, position: idx, context: gHtml.slice(Math.max(0, idx - 30), idx + 200).replace(/\s+/g, " ") };
    } else {
      // Case insensitive search
      const lc = gHtml.toLowerCase().indexOf(label.toLowerCase());
      if (lc >= 0) {
        R.snippets[label] = { found: true, position: lc, caseInsensitive: true, context: gHtml.slice(Math.max(0, lc - 30), lc + 200).replace(/\s+/g, " ") };
      } else {
        R.snippets[label] = { found: false };
      }
    }
  }

  // Also look for JSON-LD structured data
  const jsonLdMatch = gHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (jsonLdMatch) {
    R.jsonLd = jsonLdMatch[1].slice(0, 500);
  }

  // Look for any financial data table patterns
  const tableMatch = gHtml.match(/financials[\s\S]{0,500}/i);
  if (tableMatch) R.financialsSnippet = tableMatch[0].slice(0, 300).replace(/\s+/g, " ");

  return res.status(200).json(R);
}
