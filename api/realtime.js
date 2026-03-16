// Vercel Serverless — Naver Real-time Price for Korean Stocks
// Returns current price, high, low, volume, change from Naver Finance

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: "code required" });

  const stockCode = code.replace(/[^0-9]/g, "");

  try {
    // Naver Finance stock detail page
    const url = `https://finance.naver.com/item/sise.naver?code=${stockCode}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9"
      }
    });

    const buffer = await resp.arrayBuffer();
    let html;
    try { html = new TextDecoder('euc-kr').decode(buffer); }
    catch(e) { html = new TextDecoder('utf-8', {fatal:false}).decode(buffer); }

    // Parse key values from the page
    const extract = (id) => {
      // Pattern: <span id="ID">value</span> or <strong id="ID">value</strong>
      const regex = new RegExp(`id="${id}"[^>]*>\\s*([\\d,]+)`, 'i');
      const match = html.match(regex);
      return match ? parseInt(match[1].replace(/,/g, '')) : null;
    };

    // Alternative: parse from _nowVal, _quant, etc
    const extractSpan = (pattern) => {
      const regex = new RegExp(pattern + '[^>]*>\\s*([\\d,]+)', 'i');
      const match = html.match(regex);
      return match ? parseInt(match[1].replace(/,/g, '')) : null;
    };

    let price = extract('_nowVal') || extract('_sise_market_info_left') || null;
    let high = extract('_high') || null;
    let low = extract('_low') || null;
    let open = extract('_open') || null;
    let volume = extract('_quant') || null;
    let change = extract('_change') || null;
    let prevClose = extract('_rate') || null; // might not work

    // Fallback: try different patterns
    if (!price) {
      // Try the main price display
      const priceMatch = html.match(/현재가\s*(?:<[^>]+>)*\s*([\d,]+)/);
      if (priceMatch) price = parseInt(priceMatch[1].replace(/,/g, ''));
    }
    if (!high) {
      const highMatch = html.match(/고가\s*(?:<[^>]+>)*\s*([\d,]+)/);
      if (highMatch) high = parseInt(highMatch[1].replace(/,/g, ''));
    }
    if (!low) {
      const lowMatch = html.match(/저가\s*(?:<[^>]+>)*\s*([\d,]+)/);
      if (lowMatch) low = parseInt(lowMatch[1].replace(/,/g, ''));
    }
    if (!open) {
      const openMatch = html.match(/시가\s*(?:<[^>]+>)*\s*([\d,]+)/);
      if (openMatch) open = parseInt(openMatch[1].replace(/,/g, ''));
    }
    if (!volume) {
      const volMatch = html.match(/거래량\s*(?:<[^>]+>)*\s*([\d,]+)/);
      if (volMatch) volume = parseInt(volMatch[1].replace(/,/g, ''));
    }

    // Determine if market is open (KRX: 9:00-15:30 KST)
    const now = new Date();
    const kstHour = (now.getUTCHours() + 9) % 24;
    const kstMin = now.getUTCMinutes();
    const kstTime = kstHour * 60 + kstMin;
    const marketOpen = kstTime >= 540 && kstTime <= 930; // 9:00 - 15:30
    const day = now.getUTCDay();
    const isWeekday = day >= 1 && day <= 5;

    return res.status(200).json({
      code: stockCode,
      price,
      open,
      high,
      low,
      volume,
      change,
      marketOpen: marketOpen && isWeekday,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, code: stockCode });
  }
}
