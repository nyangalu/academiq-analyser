export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// Wraps a POST-only JSON handler with CORS + method + error handling boilerplate.
export function postHandler(fn) {
  return async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    try {
      await fn(req, res);
    } catch (err) {
      console.error("API error:", err);
      res.status(500).json({ error: err.message || "Internal server error" });
    }
  };
}
