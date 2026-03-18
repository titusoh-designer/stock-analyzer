// Debug: extract ALL financial data from Google Finance
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
      if (r.ok) { gHtml = await r.text(); if (gHtml.length > 10000) { R.exchange = ex; break; } }
    } catch(e) {}
  }
  if (!gHtml) return res.status(200).json({ error: "No HTML" });

  // 1. All P6K39c values (key stats)
  const p6Matches = [...gHtml.matchAll(/([^<>]{2,40})<\/div>[\s\S]{0,500}?class="P6K39c">([^<]+)/g)];
  R.keyStats = p6Matches.map(m => ({ label: m[1].replace(/.*>/, "").trim(), value: m[2].trim() }));

  // 2. Full financials table (all rows)
  const tables = [...gHtml.matchAll(/<table class="slpEwd">([\s\S]*?)<\/table>/g)];
  R.tables = [];
  for (const tbl of tables) {
    const html = tbl[1];
    // Headers
    const headers = [...html.matchAll(/<th class="yNnsfe[^"]*">([^<]+)/g)].map(m => m[1].trim());
    // Rows
    const rows = [...html.matchAll(/<tr class="roXhBd">([\s\S]*?)<\/tr>/g)];
    const parsedRows = [];
    for (const row of rows) {
      const cells = [...row[1].matchAll(/<td[^>]*>[\s\S]*?<\/td>/g)];
      const rowData = cells.map(c => {
        // Get label from rsPbEe class or J9Jhg class
        const labelMatch = c[0].match(/class="rsPbEe"[^>]*>([^<]+)/i) || c[0].match(/class="J9Jhg"[^>]*>([^<]+)/i);
        // Get value from QXDnM class
        const valMatch = c[0].match(/class="QXDnM">([^<]+)/i);
        return labelMatch ? labelMatch[1].trim() : valMatch ? valMatch[1].trim() : null;
      }).filter(Boolean);
      if (rowData.length) parsedRows.push(rowData);
    }
    R.tables.push({ headers, rows: parsedRows });
  }

  // 3. Quarterly tabs - check if there are quarterly financials
  const quarterlyCheck = gHtml.match(/data-has-quarterlies="true"/);
  R.hasQuarterlies = !!quarterlyCheck;

  // 4. All QXDnM values (financial numbers)
  const qMatches = [...gHtml.matchAll(/class="rsPbEe"[^>]*>([^<]+)[\s\S]{0,600}?class="QXDnM">([^<]+)/g)];
  R.allFinancialRows = qMatches.map(m => ({ label: m[1].trim(), value: m[2].trim() }));

  // 5. About section full text
  const aboutMatches = [...gHtml.matchAll(/class="bLLb2d"[^>]*>([^<]+)/g)];
  R.aboutTexts = aboutMatches.map(m => m[1].trim().slice(0, 300));

  // 6. Sector links
  const sectorLinks = [...gHtml.matchAll(/\/finance\/markets\/sector\/([^"?&]+)/g)];
  R.sectorLinks = [...new Set(sectorLinks.map(m => decodeURIComponent(m[1]).replace(/_/g, " ")))];

  // 7. Check for balance sheet / cash flow sections
  R.hasBalanceSheet = gHtml.includes("Balance sheet");
  R.hasCashFlow = gHtml.includes("Cash flow");

  // 8. Wider financials section
  const finStart = gHtml.indexOf("Financials</div>");
  if (finStart > 0) {
    const finSection = gHtml.slice(finStart, finStart + 5000);
    // All table headers in financials section
    const allHeaders = [...finSection.matchAll(/<th class="yNnsfe[^"]*">([^<]*(?:<[^>]*>[^<]*)*)/g)];
    R.financialHeaders = allHeaders.map(m => m[1].replace(/<[^>]+>/g, "").trim()).filter(Boolean);
  }

  return res.status(200).json(R);
}
