import express from "express";
import multer from "multer";
import eWeLink from "ewelink-api-next";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const SECRETS_PATH = path.join(DATA_DIR, "secrets.json");
const TIMELINES_DIR = path.join(DATA_DIR, "timelines");

for (const dir of [DATA_DIR, UPLOADS_DIR, TIMELINES_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------- config persistence ----------
const DEFAULT_CONFIG = {
  redirectUrl: "http://10.9.137.250:4321/auth/callback",
  scents: [
    { name: "Scent 1", color: "#a8d5ba", deviceId: "", outlet: 0, pulseMs: 3000 },
    { name: "Scent 2", color: "#bcdfc0", deviceId: "", outlet: 1, pulseMs: 3000 },
    { name: "Scent 3", color: "#cfe8cd", deviceId: "", outlet: 2, pulseMs: 3000 },
    { name: "Scent 4", color: "#e2f0da", deviceId: "", outlet: 3, pulseMs: 3000 }
  ]
};

const DEFAULT_SECRETS = {
  appId: "",
  appSecret: "",
  token: null
};

function readJSON(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJSON(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function getConfig() {
  const saved = readJSON(CONFIG_PATH, {});
  return {
    ...DEFAULT_CONFIG,
    redirectUrl: saved.redirectUrl ?? DEFAULT_CONFIG.redirectUrl,
    scents: saved.scents ?? DEFAULT_CONFIG.scents
  };
}

function saveConfig(partial) {
  const merged = { ...getConfig(), ...partial };
  writeJSON(CONFIG_PATH, merged);
  return merged;
}

function getSecrets() {
  return { ...DEFAULT_SECRETS, ...readJSON(SECRETS_PATH, {}) };
}

function saveSecrets(partial) {
  const merged = { ...getSecrets(), ...partial };
  writeJSON(SECRETS_PATH, merged);
  return merged;
}

// ---------- eWeLink client ----------
function buildClient() {
  const cfg = getConfig();
  const secrets = getSecrets();
  if (!secrets.appId || !secrets.appSecret) return null;
  const client = new eWeLink.WebAPI({
    appId: secrets.appId,
    appSecret: secrets.appSecret,
    region: secrets.token?.region || "us",
    requestRecord: false
  });
  if (secrets.token?.data?.accessToken) {
    client.at = secrets.token.data.accessToken;
    client.region = secrets.token.region;
    client.setUrl(secrets.token.region);
  }
  return client;
}

function randomString(length) {
  return [...Array(length)].map(() => (Math.random() * 36 | 0).toString(36)).join("");
}

// ---------- app setup ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const safe = Date.now() + "-" + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
      cb(null, safe);
    }
  }),
  limits: { fileSize: 1024 * 1024 * 1024 } // 1GB
});

// ---------- settings ----------
app.get("/api/settings", (_req, res) => {
  const cfg = getConfig();
  const secrets = getSecrets();
  res.json({
    redirectUrl: cfg.redirectUrl,
    scents: cfg.scents,
    loggedIn: Boolean(secrets.token?.data?.accessToken),
    region: secrets.token?.region || null
  });
});

app.post("/api/settings", (req, res) => {
  const { redirectUrl, scents } = req.body || {};
  const partial = {};
  if (typeof redirectUrl === "string") partial.redirectUrl = redirectUrl.trim();
  if (Array.isArray(scents) && scents.length === 4) partial.scents = scents;
  const saved = saveConfig(partial);
  res.json({ ok: true, config: saved });
});

// ---------- oauth ----------
app.get("/auth/login", (req, res) => {
  const cfg = getConfig();
  const secrets = getSecrets();
  if (!secrets.appId || !secrets.appSecret) {
    return res.status(400).send("Set appId and appSecret in data/secrets.json first, then try again.");
  }
  const client = new eWeLink.WebAPI({ appId: secrets.appId, appSecret: secrets.appSecret, region: "us", requestRecord: false });
  const loginUrl = client.oauth.createLoginUrl({
    redirectUrl: cfg.redirectUrl,
    grantType: "authorization_code",
    state: randomString(10)
  });
  res.redirect(loginUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { code, region } = req.query;
  const cfg = getConfig();
  const secrets = getSecrets();
  if (!code || !region) {
    return res.status(400).send("Missing code/region from eWeLink redirect.");
  }
  try {
    const client = new eWeLink.WebAPI({ appId: secrets.appId, appSecret: secrets.appSecret, region, requestRecord: false });
    const result = await client.oauth.getToken({
      region,
      redirectUrl: cfg.redirectUrl,
      code
    });
    if (result.error !== 0) {
      return res.status(400).send(`eWeLink login failed: ${result.msg || result.error}`);
    }
    result.region = region;
    saveSecrets({ token: result });
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;">
      <h2>Connected to eWeLink ✅</h2>
      <p>You can close this tab and go back to ASCENT.</p>
      <script>setTimeout(()=>{ window.location.href = "/"; }, 1200);</script>
    </body></html>`);
  } catch (err) {
    res.status(500).send("OAuth exchange failed: " + err.message);
  }
});

app.post("/api/auth/logout", (_req, res) => {
  saveSecrets({ token: null });
  res.json({ ok: true });
});

// ---------- devices ----------
app.get("/api/devices", async (_req, res) => {
  const client = buildClient();
  if (!client || !client.at) return res.status(401).json({ error: "Not logged in to eWeLink yet." });
  try {
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
  const cfg = getConfig();
  const scent = cfg.scents[scentIndex];
  if (!scent || !scent.deviceId) throw new Error("This scent has no device assigned yet (Settings tab).");
  const client = buildClient();
  if (!client || !client.at) throw new Error("Not logged in to eWeLink yet.");

  const params = { switches: [{ switch: "on", outlet: Number(scent.outlet) || 0 }] };
  const offParams = { switches: [{ switch: "off", outlet: Number(scent.outlet) || 0 }] };

  await client.device.setThingStatus({ type: 1, id: scent.deviceId, params });
  const duration = overrideMs || scent.pulseMs || 3000;
  setTimeout(async () => {
    try {
      await client.device.setThingStatus({ type: 1, id: scent.deviceId, params: offParams });
    } catch (err) {
      console.error("Failed to switch relay off:", err.message);
    }
  }, duration);

  return duration;
}

app.post("/api/scent/:idx/trigger", async (req, res) => {
  const idx = Number(req.params.idx);
  if (Number.isNaN(idx) || idx < 0 || idx > 3) return res.status(400).json({ error: "Invalid scent index" });
  try {
    const duration = await pulseRelay(idx, req.body?.duration);
    res.json({ ok: true, duration });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- video upload ----------
app.post("/api/video/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No video uploaded" });
  res.json({ ok: true, filename: req.file.filename, url: `/uploads/${req.file.filename}` });
});

app.get("/api/videos", (_req, res) => {
  const files = fs.readdirSync(UPLOADS_DIR).filter((f) => /\.(mp4|webm|mov|m4v)$/i.test(f));
  res.json({ videos: files.map((f) => ({ filename: f, url: `/uploads/${f}` })) });
});

// ---------- timelines ----------
function timelinePath(video) {
  const safe = video.replace(/[^a-zA-Z0-9.\-_]/g, "_");
  return path.join(TIMELINES_DIR, safe + ".json");
}

app.get("/api/timeline/:video", (req, res) => {
  const p = timelinePath(req.params.video);
  res.json(readJSON(p, { video: req.params.video, cues: [] }));
});

app.post("/api/timeline/:video", (req, res) => {
  const p = timelinePath(req.params.video);
  const cues = Array.isArray(req.body?.cues) ? req.body.cues : [];
  writeJSON(p, { video: req.params.video, cues });
  res.json({ ok: true });
});

// ---------- start ----------
const PORT = process.env.PORT || 4321;
app.listen(PORT, () => {
  console.log(`ASCENT running at http://localhost:${PORT}`);
});
