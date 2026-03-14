// Vercel Serverless — AI Pattern Analysis via Anthropic Claude API
// Uses ANTHROPIC_API_KEY from Vercel Environment Variables

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured. Add it in Vercel → Settings → Environment Variables." });
  }

  // Clean the key (remove quotes, whitespace, newlines)
  const cleanKey = apiKey.replace(/^["'\s]+|["'\s]+$/g, '').trim();

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": cleanKey,
        "anthropic-version": "2024-10-22"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      return res.status(500).json({ 
        error: data.error?.message || `HTTP ${response.status}`,
        keyInfo: `starts="${cleanKey.slice(0,12)}..." len=${cleanKey.length}`,
        httpStatus: response.status,
        apiError: data.error
      });
    }

    // Extract text content
    const text = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("\n");

    // Try to parse JSON from response
    let parsed = null;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*"detectedPatterns"[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]); } catch (e) {}
    }

    return res.status(200).json({
      analysis: parsed,
      raw: text,
      model: data.model,
      usage: data.usage
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
