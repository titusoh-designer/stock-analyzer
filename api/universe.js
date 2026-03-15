// Vercel Serverless — Fetch KOSPI/KOSDAQ stock universe from Naver Finance
// Returns top N stocks by market cap

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { market, count } = req.query;
  const mkt = market || "kospi"; // kospi or kosdaq
  const limit = Math.min(parseInt(count) || 500, 800);

  try {
    // Naver Finance stock list API (sorted by market cap)
    const sosok = mkt === "kosdaq" ? "1" : "0"; // 0=KOSPI, 1=KOSDAQ
    const pageSize = 50;
    const totalPages = Math.ceil(limit / pageSize);
    const stocks = [];

    for (let page = 1; page <= totalPages && stocks.length < limit; page++) {
      const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`;
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "ko-KR,ko;q=0.9"
        }
      });
      const html = await resp.text();

      // Parse stock table rows
      const rowRegex = /<a href="\/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)<\/a>/g;
      let match;
      while ((match = rowRegex.exec(html)) !== null && stocks.length < limit) {
        const code = match[1];
        const name = match[2].trim();
        if (name && code && !stocks.find(s => s.s === code)) {
          stocks.push({ s: code, n: name });
        }
      }
    }

    return res.status(200).json({
      market: mkt,
      count: stocks.length,
      stocks,
      fetchedAt: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, market: mkt });
  }
}
