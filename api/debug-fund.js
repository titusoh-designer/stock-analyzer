// Debug: show wider HTML context around financial labels
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

  // Show 500 chars AFTER each label (to find value divs)
  const labels = ["P/E ratio", "Market cap", "Dividend yield", "Avg volume", "Previous close"];
  R.after = {};
  for (const label of labels) {
    const idx = gHtml.indexOf(label);
    if (idx >= 0) {
      // Skip past the tooltip div, find the value
      R.after[label] = gHtml.slice(idx, idx + 600).replace(/\s+/g, " ");
    }
  }

  // Find the key-value table structure (class patterns)
  // Look for the financial stats section
  const statsSection = gHtml.indexOf("P/E ratio");
  if (statsSection > 0) {
    // Go back to find the container start
    const containerStart = gHtml.lastIndexOf("<div", statsSection - 200);
    R.statsContainer = gHtml.slice(Math.max(0, containerStart), statsSection + 800).replace(/\s+/g, " ").slice(0, 1500);
  }

  // Revenue table
  const revIdx = gHtml.indexOf("Revenue</div>");
  if (revIdx > 0) {
    R.revenueTable = gHtml.slice(revIdx, revIdx + 1500).replace(/\s+/g, " ");
  }

  // About section with description
  const aboutIdx = gHtml.indexOf("bLLb2d");
  if (aboutIdx > 0) {
    R.aboutSection = gHtml.slice(aboutIdx, aboutIdx + 500).replace(/\s+/g, " ");
  }

  // Sector links
  const sectorIdx = gHtml.indexOf("/finance/markets/sector");
  if (sectorIdx > 0) {
    R.sectorLink = gHtml.slice(Math.max(0, sectorIdx - 50), sectorIdx + 200).replace(/\s+/g, " ");
  }

  return res.status(200).json(R);
}
