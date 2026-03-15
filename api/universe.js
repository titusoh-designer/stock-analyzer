// Vercel Serverless — Fetch KOSPI/KOSDAQ stock universe from Naver Finance
// ★ Key: Naver Finance uses EUC-KR encoding → must decode with TextDecoder

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { market, count } = req.query;
  const mkt = market || "kospi";
  const limit = Math.min(parseInt(count) || 500, 800);

  try {
    const sosok = mkt === "kosdaq" ? "1" : "0";
    const pageSize = 50;
    const totalPages = Math.ceil(limit / pageSize);
    const stocks = [];

    for (let page = 1; page <= totalPages && stocks.length < limit; page++) {
      const url = `https://finance.naver.com/sise/sise_market_sum.naver?sosok=${sosok}&page=${page}`;
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "ko-KR,ko;q=0.9",
          "Accept": "text/html,application/xhtml+xml"
        }
      });

      // ★ Decode as EUC-KR (Naver Finance encoding)
      const buffer = await resp.arrayBuffer();
      let html;
      try {
        html = new TextDecoder('euc-kr').decode(buffer);
      } catch (e) {
        html = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      }

      // Parse stock links: <a href="/item/main.naver?code=005930">삼성전자</a>
      const regex = /<a\s+href="\/item\/main\.(?:naver|nhn)\?code=(\d{6})"[^>]*>\s*([^<]+?)\s*<\/a>/g;
      let match;
      while ((match = regex.exec(html)) !== null && stocks.length < limit) {
        const code = match[1];
        const name = match[2].trim();
        if (name && code && name.length > 0 && !stocks.find(s => s.s === code)) {
          stocks.push({ s: code, n: name });
        }
      }

      // Fallback: try title attribute
      if (stocks.length === 0 && page === 1) {
        const altRegex = /code=(\d{6})[^>]*title="([^"]+)"/g;
        while ((match = altRegex.exec(html)) !== null && stocks.length < limit) {
          const code = match[1];
          const name = match[2].trim();
          if (name && code && !stocks.find(s => s.s === code)) {
            stocks.push({ s: code, n: name });
          }
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
