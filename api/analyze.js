// Vercel Serverless — AI Pattern Analysis via xAI Grok API
// v4 — Grok (OpenAI-compatible)
// Uses XAI_API_KEY from Vercel Environment Variables

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only", version: "v4-grok" });

  // Support both key names for flexibility
  const rawKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (!rawKey) {
    return res.status(500).json({
      error: "API key not configured",
      version: "v4-grok",
      hint: "Add XAI_API_KEY in Vercel → Settings → Environment Variables"
    });
  }

  const cleanKey = rawKey.replace(/[\r\n\t]/g, '').replace(/^["'\s]+/, '').replace(/["'\s]+$/, '').trim();

  // ★ Password verification
  const analyzePassword = process.env.ANALYZE_PASSWORD;
  if (analyzePassword) {
    const { password } = req.body || {};
    if (!password || password !== analyzePassword) {
      return res.status(403).json({
        error: "비밀번호가 올바르지 않습니다.",
        authFail: true
      });
    }
  }

  const keyDebug = {
    version: "v4-grok",
    cleanLen: cleanKey.length,
    starts: cleanKey.slice(0, 12),
    ends: cleanKey.slice(-4)
  };

  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt is required", ...keyDebug });

    // Grok API (OpenAI-compatible)
    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cleanKey
      },
      body: JSON.stringify({
        model: "grok-3-mini-fast",
        max_tokens: 8000,
        temperature: 0.3,
        messages: [
          { role: "system", content: "You are a professional stock chart pattern analyst. Always respond in Korean (한국어). Always respond with valid JSON only inside ```json``` code blocks. No text outside the JSON block." },
          { role: "user", content: prompt }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      return res.status(500).json({
        error: data.error?.message || ("HTTP " + response.status),
        httpStatus: response.status,
        apiError: data.error,
        ...keyDebug
      });
    }

    // Extract text from OpenAI-format response
    const text = data.choices?.[0]?.message?.content || "";

    // Try to parse JSON
    let parsed = null;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*"detectedPatterns"[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]); } catch (e) {}
    }
    // If no code block, try parsing the entire response as JSON
    if (!parsed) {
      try { parsed = JSON.parse(text); } catch (e) {}
    }

    return res.status(200).json({
      analysis: parsed,
      raw: text,
      model: data.model,
      usage: data.usage,
      ...keyDebug
    });

  } catch (error) {
    return res.status(500).json({ error: error.message, ...keyDebug });
  }
}
