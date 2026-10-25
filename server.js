import express from "express";
import eWeLink from "ewelink-api-next";
import path from "path";
import { fileURLToPath } from "url";
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EWELINK_REDIRECT_URL =
  process.env.EWELINK_REDIRECT_URL || "https://ascent-nu-six.vercel.app/auth/callback";

// ---------- firebase (lazy, so a bad env var gives a readable error) ----------
let _db = null;
function getDb() {
  if (_db) return _db;
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not set in Vercel.");
  }
  if (!getApps().length) {
    let account;
    try {
      account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON. Paste the whole key file.");
    }
    if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, "\n");
    initializeApp({ credential: cert(account) });
  }
  _db = getFirestore();
  return _db;
}

const configRef = () => getDb().collection("ascent").doc("config");
const tokenRef = () => getDb().collection("ascent").doc("token");
const timelines = () => getDb().collection("timelines");

const getConfig = async () => {
  const s = await configRef().get();
  return { scents: [], ...(s.exists ? s.data() : {}) };
};
const saveConfig = async (partial) => {
  const merged = { ...(await getConfig()), ...partial };
  await configRef().set(merged);
  return merged;
};
const getToken = async () => {
  const s = await tokenRef().get();
  return s.exists ? s.data() : null;
};
const saveToken = async (t) => (t ? tokenRef().set(t) : tokenRef().delete());
const getCreds = () => ({
  appId: process.env.EWELINK_APP_ID,
  appSecret: process.env.EWELINK_APP_SECRET,
});
const timelineId = (video) => "t_" + video.replace(/[^a-zA-Z0-9.\-_]/g, "_");

// ---------- eWeLink client ----------
async function buildClient() {
  const { appId, appSecret } = getCreds();
  if (!appId || !appSecret) return null;
  const token = await getToken();
  const client = new eWeLink.WebAPI({
    appId,
    appSecret,
    region: token?.region || "us",
    requestRecord: false,
  });
  if (token?.data?.accessToken) {
    client.at = token.data.accessToken;
    client.region = token.region;
    client.setUrl(token.region);
  }
  return client;
}

const randomString = (n) =>
  [...Array(n)].map(() => ((Math.random() * 36) | 0).toString(36)).join("");

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// quick check that the server is alive: open /api/health in the browser
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasAppId: Boolean(process.env.EWELINK_APP_ID),
    hasAppSecret: Boolean(process.env.EWELINK_APP_SECRET),
    hasFirebaseKey: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT),
    redirectUrl: EWELINK_REDIRECT_URL,
  });
});

// ---------- settings ----------
app.get("/api/settings", async (_req, res) => {
  try {
    const cfg = await getConfig();
    const token = await getToken();
    res.json({
      scents: cfg.scents,
      loggedIn: Boolean(token?.data?.accessToken),
      region: token?.region || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/settings", async (req, res) => {
  const { scents, removedScentIndex } = req.body || {};
  const partial = {};
  if (scents !== undefined) {
    const valid =
      Array.isArray(scents) &&
      scents.every(
        (s) =>
          s &&
          typeof s.name === "string" &&
          typeof s.color === "string" &&
          typeof s.deviceId === "string" &&
          Number.isFinite(Number(s.outlet)) &&
          Number.isFinite(Number(s.pulseMs))
      );
    if (!valid) return res.status(400).json({ error: "Invalid device settings" });
    partial.scents = scents.map((s) => ({ ...s, deviceId: s.deviceId.trim() }));
  }

  try {
    const existing = (await getConfig()).scents;
    if (
      Number.isInteger(removedScentIndex) &&
      removedScentIndex >= 0 &&
      removedScentIndex < existing.length
    ) {
      const snap = await timelines().get();
      const batch = getDb().batch();
      snap.forEach((doc) => {
        const t = doc.data();
        if (Array.isArray(t.cues)) {
          t.cues = t.cues
            .filter((c) => c.scent !== removedScentIndex)
            .map((c) => ({ ...c, scent: c.scent > removedScentIndex ? c.scent - 1 : c.scent }));
          batch.set(doc.ref, t);
        }
      });
      await batch.commit();
    }
    const config = await saveConfig(partial);
    res.json({ ok: true, config });
  } catch (err) {
    res.status(500).json({ error: `Couldn't save device settings: ${err.message}` });
  }
});

// ---------- oauth ----------
app.get("/auth/login", (_req, res) => {
  const { appId, appSecret } = getCreds();
  if (!appId || !appSecret) {
    return res.status(400).send("EWELINK_APP_ID / EWELINK_APP_SECRET are not set in Vercel.");
  }
  try {
    const client = new eWeLink.WebAPI({ appId, appSecret, region: "us", requestRecord: false });
    const loginUrl = client.oauth.createLoginUrl({
      redirectUrl: EWELINK_REDIRECT_URL,
      grantType: "authorization_code",
      state: randomString(10),
    });
    res.redirect(loginUrl);
  } catch (err) {
    res.status(500).send("Couldn't build the eWeLink login URL: " + err.message);
  }
});

app.get("/auth/callback", async (req, res) => {
  const { code, region } = req.query;
  if (!code || !region) return res.status(400).send("Missing code/region from eWeLink redirect.");
  const { appId, appSecret } = getCreds();
  try {
    const client = new eWeLink.WebAPI({ appId, appSecret, region, requestRecord: false });
    const result = await client.oauth.getToken({ region, redirectUrl: EWELINK_REDIRECT_URL, code });
    if (result.error !== 0) {
      return res.status(400).send(`eWeLink login failed: ${result.msg || result.error}`);
    }
    result.region = region;
    await saveToken(JSON.parse(JSON.stringify(result)));
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h2>Connected to eWeLink ✅</h2>
      <p>You can close this tab and go back to ASCENT.</p>
      <script>setTimeout(()=>{ window.location.href = "/"; }, 1200);</script>
    </body></html>`);
  } catch (err) {
    res.status(500).send("OAuth exchange failed: " + err.message);
  }
});

app.post("/api/auth/logout", async (_req, res) => {
  try {
    await saveToken(null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- devices ----------
app.get("/api/devices", async (_req, res) => {
  try {
    const client = await buildClient();
    if (!client || !client.at) return res.status(401).json({ error: "Not logged in to eWeLink yet." });
    const result = await client.device.getAllThingsAllPages();
    const list = (result?.thingList || result?.data?.thingList || [])
      .map((t) => t.itemData || t)
      .filter(Boolean)
      .map((d) => ({ id: d.deviceid, name: d.name, type: d.extra?.uiid, online: d.online }));
    res.json({ devices: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- relay control ----------
async function pulseRelay(scentIndex, overrideMs) {
  const scent = (await getConfig()).scents[scentIndex];
  if (!scent || !scent.deviceId) throw new Error("This scent has no device assigned yet (Settings tab).");
  const client = await buildClient();
  if (!client || !client.at) throw new Error("Not logged in to eWeLink yet.");

  const outlet = Number(scent.outlet) || 0;
  const duration = overrideMs || scent.pulseMs || 3000;

  await client.device.setThingStatus({
    type: 1, id: scent.deviceId, params: { switches: [{ switch: "on", outlet }] },
  });
  await new Promise((r) => setTimeout(r, duration)); // must finish before responding on Vercel
  await client.device.setThingStatus({
    type: 1, id: scent.deviceId, params: { switches: [{ switch: "off", outlet }] },
  });
  return duration;
}

app.post("/api/scent/:idx/trigger", async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const scents = (await getConfig()).scents;
    if (!Number.isInteger(idx) || idx < 0 || idx >= scents.length) {
      return res.status(400).json({ error: "Invalid scent index" });
    }
    const duration = await pulseRelay(idx, req.body?.duration);
    res.json({ ok: true, duration });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- timelines ----------
app.get("/api/timeline/:video", async (req, res) => {
  try {
    const s = await timelines().doc(timelineId(req.params.video)).get();
    res.json(s.exists ? s.data() : { video: req.params.video, cues: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/timeline/:video", async (req, res) => {
  try {
    const cues = Array.isArray(req.body?.cues) ? req.body.cues : [];
    await timelines().doc(timelineId(req.params.video)).set({ video: req.params.video, cues });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- fallback: tells you the server is running but the path is wrong ----------
app.use((req, res) => {
  res.status(404).send(`ASCENT server: no route for ${req.method} ${req.path}`);
});

// ---------- start ----------
export default app;
if (!process.env.VERCEL) {
  app.listen(process.env.PORT || 4321, () => console.log("ASCENT running on :4321"));
}