import { adminDb } from "./_lib/firebaseAdmin.js";
import { hash } from "./_lib/passwords.js";
import { postHandler } from "./_lib/http.js";

export const config = { maxDuration: 30 };

const uid = () => "sup_" + Math.random().toString(36).slice(2);

export default postHandler(async (req, res) => {
  const { name, username, email, password, sqQ, sqA } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: "Name, username and password required." });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  if (!sqA || !String(sqA).trim()) return res.status(400).json({ error: "Enter a security answer." });

  const db = adminDb();
  const snap = await db.ref("supervisors").once("value");
  const all = snap.val() || {};
  const taken = Object.values(all).some(s => s.username === username.trim());
  if (taken) return res.status(409).json({ error: "Username already taken." });

  const record = {
    id: uid(),
    name: name.trim(),
    username: username.trim(),
    email: (email || "").trim(),
    password: hash(password),
    securityQ: { question: sqQ, answer: hash(String(sqA).trim().toLowerCase()) },
    createdAt: new Date().toISOString(),
  };
  await db.ref(`supervisors/${record.id}`).set(record);
  res.status(200).json({ ok: true });
});
