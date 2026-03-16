// Debug: Test Naver minute API response format
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const code = req.query.code || "005930";
  const results = {};

  // Test different Naver API formats
  const tests = [
    { name: "type2_minute_500", url: `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=2&count=500&timeframe=minute` },
    { name: "type2_minute_100", url: `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=2&count=100&timeframe=minute` },
    { name: "type1_minute_5d", url: `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=1&startTime=20250310&endTime=20250316&timeframe=minute` },
    { name: "type2_day_30", url: `https://fchart.stock.naver.com/siseJson.nhn?symbol=${code}&requestType=2&count=30&timeframe=day` },
  ];

  for (const test of tests) {
    try {
      const resp = await fetch(test.url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } });
      const buf = await resp.arrayBuffer();
      let text;
      try { text = new TextDecoder('euc-kr').decode(buf); } 
      catch(e) { text = new TextDecoder('utf-8', {fatal:false}).decode(buf); }
      
      // Get first 500 chars and last 500 chars
      results[test.name] = {
        status: resp.status,
        length: text.length,
        first500: text.slice(0, 500),
        last500: text.slice(-500),
        // Try to find any bracket content
        bracketCount: (text.match(/\[/g) || []).length,
        // First 3 bracket matches
        firstBrackets: (text.match(/\[[^\]]{5,}\]/g) || []).slice(0, 3)
      };
    } catch(e) {
      results[test.name] = { error: e.message };
    }
  }

  return res.status(200).json({ code, results });
}
