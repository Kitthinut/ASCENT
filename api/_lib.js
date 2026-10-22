import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import eWeLink from "ewelink-api-next";

if (!getApps().length) {
  const json = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64 || "", "base64").toString("utf8");
  initializeApp({ credential: cert(JSON.parse(json)) });
}

export const db = getFirestore();
const MONTHLY_LIMIT = Number(process.env.EWELINK_MONTHLY_LIMIT || 45000);

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// Verifies the Firebase ID token sent by the browser and returns the user's uid.
export async function requireUser(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) throw httpError(401, "Please sign in.");
  try {
    return (await getAuth().verifyIdToken(token)).uid;
  } catch {
    throw httpError(401, "Session expired. Please sign in again.");
  }
}

export function newClient(region) {
  return new eWeLink.WebAPI({
    appId: process.env.EWELINK_APP_ID,
    appSecret: process.env.EWELINK_APP_SECRET,
    region: region || "as",
  });
}

// Every eWeLink call counts against the free 50,000/month pool shared by ALL customers.
async function countCall() {
  const ref = db.collection("usage").doc(new Date().toISOString().slice(0, 7));
  const snap = await ref.get();
  if ((snap.data()?.calls || 0) >= MONTHLY_LIMIT) {
    throw httpError(503, "Monthly eWeLink request limit reached. Please try again next month.");
  }
  await ref.set({ calls: FieldValue.increment(1) }, { merge: true });
}

function friendly(r) {
  if (r.error === 4002) return "Your Sonoff is offline. Check its power and Wi-Fi.";
  if (r.error === 412) return "eWeLink request limit reached. Please try again later.";
  return `eWeLink error ${r.error}: ${r.msg || "unknown"}`;
}

// Runs one eWeLink call, counts it, and turns eWeLink error codes into real errors.
export async function callEwelink(fn) {
  await countCall();
  const r = await fn();
  if (r && r.error && r.error !== 0) throw httpError(502, friendly(r));
  return r;
}

// Builds an eWeLink client for this user, refreshing their token when it is about to expire.
export async function getAuthedClient(uid) {
  const ref = db.collection("secrets").doc(uid);
  const s = (await ref.get()).data()?.ewelink;
  if (!s) throw httpError(409, "eWeLink is not connected yet. Open Settings and press Connect eWeLink.");

  const client = newClient(s.region);
  client.at = s.at;
  client.rt = s.rt;

  if (!s.atExp || s.atExp - Date.now() < 24 * 3600 * 1000) {
    try {
      const r = await callEwelink(() => client.user.refreshToken({ rt: s.rt }));
      const at = r.data?.at || client.at;
      const rt = r.data?.rt || client.rt;
      await ref.set({ ewelink: { ...s, at, rt, atExp: Date.now() + 29 * 24 * 3600 * 1000 } }, { merge: true });
      client.at = at;
      client.rt = rt;
    } catch (e) {
      console.error("Token refresh failed:", e.message);
      throw httpError(409, "Your eWeLink session expired. Please reconnect in Settings.");
    }
  }
  return client;
}