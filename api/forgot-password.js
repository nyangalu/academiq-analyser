import { adminDb } from "./_lib/firebaseAdmin.js";
import { verify, hash } from "./_lib/passwords.js";
import { postHandler } from "./_lib/http.js";

export const config = { maxDuration: 30 };

const COLLECTIONS = { admin: "admins", supervisor: "supervisors", student: "students" };
const KEY_FIELD = { admin: "username", supervisor: "username", student: "number" };
const MIN_LEN = { admin: 6, supervisor: 6, student: 4 };

async function findRecord(db, role, id) {
  const snap = await db.ref(COLLECTIONS[role]).once("value");
  const all = snap.val() || {};
  return Object.values(all).find(r => r[KEY_FIELD[role]] === id.trim());
}

export default postHandler(async (req, res) => {
  const { action, role, id } = req.body || {};
  if (!role || !COLLECTIONS[role] || !id) return res.status(400).json({ error: "Missing role or id" });
  const db = adminDb();

  if (action === "question") {
    const record = await findRecord(db, role, id);
    if (!record || !record.securityQ?.question) return res.status(404).json({ error: "Account not found or no security question set." });
    return res.status(200).json({ question: record.securityQ.question });
  }

  if (action === "reset") {
    const { answer, newPassword } = req.body || {};
    const record = await findRecord(db, role, id);
    if (!record || !record.securityQ?.answer) return res.status(404).json({ error: "Account not found or no security question set." });

    const { ok, needsMigration } = verify(String(answer || "").trim().toLowerCase(), record.securityQ.answer);
    if (!ok) return res.status(401).json({ error: "Incorrect answer." });

    const min = MIN_LEN[role] || 6;
    if (!newPassword || String(newPassword).length < min) return res.status(400).json({ error: `Password must be at least ${min} characters.` });

    const updates = { password: hash(newPassword) };
    if (needsMigration) updates.securityQ = { ...record.securityQ, answer: hash(String(answer).trim().toLowerCase()) };
    await db.ref(`${COLLECTIONS[role]}/${record.id}`).update(updates);
    return res.status(200).json({ ok: true });
  }

  res.status(400).json({ error: "Unknown action." });
});
