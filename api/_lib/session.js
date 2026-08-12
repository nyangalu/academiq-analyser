import jwt from "jsonwebtoken";

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("Missing SESSION_SECRET environment variable. Set it in Vercel to any long random string.");
  return s;
}

// Normal login session — carries role/id/name, used to authorise /api/db calls.
export function signSession({ role, id, name }) {
  return jwt.sign({ role, id, name, typ: "session" }, secret(), { expiresIn: "14d" });
}

// Short-lived token issued only after a security question is answered correctly,
// scoped to resetting exactly one account's password.
export function signResetToken({ role, id }) {
  return jwt.sign({ role, id, typ: "reset" }, secret(), { expiresIn: "10m" });
}

export function verifyToken(token, expectedTyp) {
  try {
    const payload = jwt.verify(token, secret());
    if (expectedTyp && payload.typ !== expectedTyp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// Pulls "Bearer <token>" out of an Authorization header, or a raw token string.
export function extractToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7);
  return req.body?.token || null;
}
