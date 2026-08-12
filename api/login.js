import { adminDb } from "./_lib/firebaseAdmin.js";
import { signSession } from "./_lib/session.js";
import { verify, hash } from "./_lib/passwords.js";
import { postHandler } from "./_lib/http.js";

export const config = { maxDuration: 30 };

const COLLECTIONS = { admin: "admins", supervisor: "supervisors", student: "students" };
const KEY_FIELD = { admin: "username", supervisor: "username", student: "number" };

function safeUser(role, record) {
  const { password, securityQ, ...rest } = record;
  return { ...rest, role, hasPassword: !!password, hasSecurityQ: !!securityQ?.question };
}

export default postHandler(async (req, res) => {
  const { role, id, password } = req.body || {};
  if (!role || !COLLECTIONS[role] || !id) return res.status(400).json({ error: "Missing role or id" });

  const db = adminDb();

  // One-time bootstrap: if the admins collection is completely empty (fresh deploy),
  // seed a default admin account. This only ever fires once — after that, the account
  // exists and this branch never runs again. Server-side only, unlike the old
  // client-side seed which shipped the password to every visitor's browser.
  if (role === "admin") {
    const adminsSnap = await db.ref("admins").once("value");
    if (!adminsSnap.exists()) {
      await db.ref("admins/adm_default").set({
        id: "adm_default",
        username: "nyangal",
        password: hash("ChangeMe_" + Math.random().toString(36).slice(2, 8) + "!"),
        name: "Lungile Nyanga",
        email: "",
        securityQ: { question: "What is the name of your institution?", answer: hash("nwu") },
        createdAt: new Date().toISOString(),
      });
      return res.status(401).json({ error: "Admin account was just initialised with a random password. Contact whoever set up this deployment, or use the Firebase Console to set a known password directly." });
    }
  }

  const snap = await db.ref(COLLECTIONS[role]).once("value");
  const all = snap.val() || {};
  const key = KEY_FIELD[role];
  const record = Object.values(all).find(r => r[key] === id.trim());

  if (!record) return res.status(401).json({ error: role === "student" ? "Student number not found. Contact your supervisor." : "Invalid username or password." });

  // Students without a password set yet are mid first-time-setup — let them through
  // regardless of what was typed; the client prompts them to set credentials.
  const noPasswordYet = role === "student" && !record.password;

  if (!noPasswordYet) {
    const { ok, needsMigration } = verify(password || "", record.password);
    if (!ok) return res.status(401).json({ error: role === "student" ? "Incorrect password." : "Invalid username or password." });
    if (needsMigration) {
      await db.ref(`${COLLECTIONS[role]}/${record.id}`).update({ password: hash(password) });
    }
  }

  const token = signSession({ role, id: record.id, name: record.name || `${record.initials || ""} ${record.surname || ""}`.trim() });
  res.status(200).json({ token, user: safeUser(role, record) });
});
