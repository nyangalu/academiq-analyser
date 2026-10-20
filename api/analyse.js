import Anthropic from "@anthropic-ai/sdk";

// 300s is the maximum on the Hobby plan (Fluid compute). On Pro this can go up to 800.
export const config = { maxDuration: 300 };

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Marker the client looks for if something fails after streaming has started
// (by then the HTTP status is already 200 and can't be changed).
const ERROR_MARKER = "\n<<<ANALYSE_ERROR>>>";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { system, prompt, maxTokens = 8000 } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  let started = false;
  try {
    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: system || "You are a helpful assistant. Always return valid JSON only.",
      messages: [{ role: "user", content: prompt }],
    });

    // Stream text back as it is generated. This keeps the connection active, so
    // campus/ISP proxies don't drop it as idle during long syntheses.
    stream.on("text", (delta) => {
      if (!started) {
        started = true;
        res.status(200);
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("X-Accel-Buffering", "no");
      }
      res.write(delta);
    });

    await stream.finalMessage();
    if (!started) {
      res.status(200);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    res.end();
  } catch (err) {
    console.error("API error:", err);
    const msg = err?.message || "Internal server error";
    if (started) {
      res.write(ERROR_MARKER + msg);
      res.end();
    } else {
      res.status(500).json({ error: msg });
    }
  }
}
