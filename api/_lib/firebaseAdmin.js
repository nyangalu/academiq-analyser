import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

const DATABASE_URL = "https://academiq-analyser-c5e16-default-rtdb.europe-west1.firebasedatabase.app";

function getAdminApp() {
  const existing = getApps();
  if (existing.length) return existing[0];

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Vercel's env var UI can mangle literal newlines in multi-line values; this
  // normalises both "\n" (escaped) and already-correct real newlines.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "Missing Firebase Admin credentials. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Vercel Environment Variables (from a service account key generated in Firebase Console → Project Settings → Service Accounts)."
    );
  }

  return initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    databaseURL: DATABASE_URL,
  });
}

export function adminDb() {
  return getDatabase(getAdminApp());
}
