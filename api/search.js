// Vercel Serverless Function — Stock Symbol Search
// Converts stock names to ticker symbols (Korean, US, Crypto)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { q } = req.query;
  if (!q) return res.status(400).json({ error: "q (query) is required" });

  const results = [];

  try {
    // ── Yahoo Finance Search (covers US + global) ──
    try {
      const yUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0&listsCount=0`;
      const yResp = await fetch(yUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
      const yJson = await yResp.json();
      (yJson.quotes || []).forEach(item => {
        if (!item.symbol) return;
        const isKR = item.exchange === "KSC" || item.exchange === "KOE" || (item.symbol || "").endsWith(".KS") || (item.symbol || "").endsWith(".KQ");
        results.push({
          symbol: item.symbol,
          name: item.longname || item.shortname || item.symbol,
          exchange: item.exchange || "",
          type: item.quoteType || "",
          source: isKR ? "naver" : item.quoteType === "CRYPTOCURRENCY" ? "coingecko" : "yahoo",
          // For naver, extract 6-digit code
          naverCode: isKR ? (item.symbol || "").replace(/\.(KS|KQ)$/, "") : null
        });
      });
    } catch (e) { /* yahoo search failed, continue */ }

    // ── Korean stock name matching (for common names) ──
    const krStocks = {
      "삼성전자": "005930", "SK하이닉스": "000660", "LG에너지솔루션": "373220",
      "삼성바이오로직스": "207940", "현대차": "005380", "기아": "000270",
      "셀트리온": "068270", "KB금융": "105560", "신한지주": "055550",
      "POSCO홀딩스": "005490", "NAVER": "035420", "네이버": "035420",
      "카카오": "035720", "삼성SDI": "006400", "LG화학": "051910",
      "현대모비스": "012330", "삼성물산": "028260", "SK이노베이션": "096770",
      "SK텔레콤": "017670", "KT": "030200", "LG전자": "066570",
      "포스코퓨처엠": "003670", "한국전력": "015760", "삼성생명": "032830",
      "카카오뱅크": "323410", "크래프톤": "259960", "두산에너빌리티": "034020",
      "LG": "003550", "롯데케미칼": "011170", "한화솔루션": "009830",
      "SK": "034730", "에코프로비엠": "247540", "에코프로": "086520",
      "한미반도체": "042700", "두산밥캣": "241560", "CJ제일제당": "097950",
      "하이브": "352820", "엔씨소프트": "036570", "넷마블": "251270",
      "카카오게임즈": "293490", "펄어비스": "263750", "위메이드": "112040"
    };

    const qLower = q.toLowerCase();
    Object.entries(krStocks).forEach(([name, code]) => {
      if (name.toLowerCase().includes(qLower) || code.includes(q)) {
        // Check if already in results
        if (!results.find(r => r.naverCode === code)) {
          results.push({
            symbol: code + ".KS",
            name: name,
            exchange: "KRX",
            type: "EQUITY",
            source: "naver",
            naverCode: code
          });
        }
      }
    });

    // ── CoinGecko search (for crypto) ──
    try {
      const cUrl = `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`;
      const cResp = await fetch(cUrl);
      const cJson = await cResp.json();
      (cJson.coins || []).slice(0, 5).forEach(coin => {
        if (!results.find(r => r.symbol === coin.id)) {
          results.push({
            symbol: coin.id,
            name: coin.name + " (" + coin.symbol?.toUpperCase() + ")",
            exchange: "CRYPTO",
            type: "CRYPTOCURRENCY",
            source: "coingecko",
            naverCode: null
          });
        }
      });
    } catch (e) { /* coingecko search failed, continue */ }

    return res.status(200).json({ query: q, results: results.slice(0, 10) });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
