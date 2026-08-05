import Anthropic from "@anthropic-ai/sdk";

export const config = { maxDuration: 120 };

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { system, prompt, maxTokens = 8000 } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      system: system || "You are a helpful assistant. Always return valid JSON only.",
      messages: [{ role: "user", content: prompt }],
    });

    const text = (message.content || []).map(b => b.text || "").join("");
    res.status(200).json({ text });
  } catch (err) {
    console.error("API error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}
