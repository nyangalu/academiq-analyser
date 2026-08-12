import { adminDb } from "./_lib/firebaseAdmin.js";
import { verifyToken, extractToken } from "./_lib/session.js";
import { postHandler } from "./_lib/http.js";
import { hash } from "./_lib/passwords.js";

export const config = { maxDuration: 30 };

const COLLECTIONS = new Set(["admins", "supervisors", "students", "submissions", "institutionBranding"]);
const SENSITIVE_COLLECTIONS = new Set(["admins", "supervisors", "students"]);

function stripSensitive(collection, record) {
  if (!SENSITIVE_COLLECTIONS.has(collection) || !record) return record;
  const { password, securityQ, ...rest } = record;
  return { ...rest, hasPassword: !!password, hasSecurityQ: !!securityQ?.question };
}

function canRead(session, collection) {
  if (collection === "admins") return session.role === "admin";
  return true; // supervisors/students/submissions/institutionBranding: any authenticated role
}

function canWrite(session, collection, record) {
  const { role, id } = session;
  if (role === "admin") return true;
  if (collection === "supervisors") return role === "supervisor" && record.id === id;
  if (collection === "students") return role === "supervisor" || (role === "student" && record.id === id);
  if (collection === "submissions") return true; // any authenticated role creates/updates reports
  return false; // admins + institutionBranding: admin only
}

// Who's allowed to set a NEW password/security-question on a record: an admin
// (resetting/creating anyone), or the person themselves (self-service change).
function canSetCredentials(session, record) {
  return session.role === "admin" || record.id === session.id;
}

function canDelete(session) {
  return session.role === "admin"; // every delete path in the app is admin-only today
}

export default postHandler(async (req, res) => {
  const token = extractToken(req);
  const session = token && verifyToken(token, "session");
  if (!session) return res.status(401).json({ error: "Not signed in. Please log in again." });

  const { action, collection } = req.body || {};
  if (!COLLECTIONS.has(collection)) return res.status(400).json({ error: "Unknown collection." });

  const db = adminDb();

  if (action === "list") {
    if (!canRead(session, collection)) return res.status(403).json({ error: "Not authorised to read this data." });
    const snap = await db.ref(collection).once("value");
    const all = Object.values(snap.val() || {});
    return res.status(200).json({ records: all.map(r => stripSensitive(collection, r)) });
  }

  if (action === "write") {
    const upserts = Array.isArray(req.body.upserts) ? req.body.upserts : [];
    const deletes = Array.isArray(req.body.deletes) ? req.body.deletes : [];

    for (const record of upserts) {
      if (!record?.id) return res.status(400).json({ error: "Every record needs an id." });
      if (!canWrite(session, collection, record)) return res.status(403).json({ error: "Not authorised to write one or more of these records." });
    }
    if (deletes.length && !canDelete(session)) return res.status(403).json({ error: "Not authorised to delete records." });

    // Password/securityQ never travel as plain fields on a normal record — a client
    // wanting to SET a new one must use the special _setPassword / _setSecurityQ
    // fields below, which get hashed here and require extra authorisation. Any
    // plain password/securityQ on the record itself is ignored, and whatever
    // credential fields already exist in the database are preserved by default —
    // so a routine profile edit (e.g. changing a student's name) can never wipe
    // their password. A plain multi-path update() REPLACES each full record
    // rather than merging, which is why we fetch the existing record first.
    const updates = {};
    for (const record of upserts) {
      const { _setPassword, _setSecurityQ, ...clean } = record;
      if (SENSITIVE_COLLECTIONS.has(collection)) {
        delete clean.password; delete clean.securityQ;
        const existingSnap = await db.ref(`${collection}/${record.id}`).once("value");
        const existing = existingSnap.val();
        if (existing?.password !== undefined) clean.password = existing.password;
        if (existing?.securityQ !== undefined) clean.securityQ = existing.securityQ;

        if (_setPassword) {
          if (!canSetCredentials(session, record)) return res.status(403).json({ error: "Not authorised to set this password." });
          clean.password = hash(_setPassword);
        }
        if (_setSecurityQ?.question && _setSecurityQ?.answer) {
          if (!canSetCredentials(session, record)) return res.status(403).json({ error: "Not authorised to set this security question." });
          clean.securityQ = { question: _setSecurityQ.question, answer: hash(String(_setSecurityQ.answer).trim().toLowerCase()) };
        }
      }
      updates[`${collection}/${record.id}`] = clean;
    }
    for (const id of deletes) updates[`${collection}/${id}`] = null;

    if (Object.keys(updates).length) await db.ref().update(updates);
    return res.status(200).json({ ok: true });
  }

  res.status(400).json({ error: "Unknown action." });
});
