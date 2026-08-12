import bcrypt from "bcryptjs";

const BCRYPT_RE = /^\$2[aby]\$/;

export function isHashed(value) {
  return typeof value === "string" && BCRYPT_RE.test(value);
}

export function hash(plain) {
  return bcrypt.hashSync(plain, 10);
}

// Verifies a plaintext value against a stored value that may be either a bcrypt
// hash (new accounts / already-migrated) or legacy plaintext (old accounts).
// Returns { ok, needsMigration } — callers should re-hash and persist when
// needsMigration is true, so plaintext values disappear the first time each
// account is used after this upgrade.
export function verify(plain, stored) {
  if (!stored) return { ok: false, needsMigration: false };
  if (isHashed(stored)) return { ok: bcrypt.compareSync(plain, stored), needsMigration: false };
  return { ok: plain === stored, needsMigration: plain === stored };
}
