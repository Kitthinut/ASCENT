import crypto from "node:crypto";
import { db, httpError, requireUser, newClient, getAuthedClient, callEwelink } from "../_lib.js";

const REDIRECT = process.env.EWELINK_REDIRECT_URL;

async function clientAndDevice(uid) {
  const [client, userSnap] = await Promise.all([getAuthedClient(uid), db.collection("users").doc(uid).get()]);
  const deviceId = userSnap.data()?.deviceId;
  if (!deviceId) throw httpError(409, "No Sonoff selected yet. Choose your device in Settings.");
  return { client, deviceId };
}

// eWeLink redirects the browser here after the customer logs in on eWeLink's own page.
async function callback(req, res) {
  const { code, region, state } = req.query;
  const fail = () => res.redirect(302, "/?ewelink=error");
  if (!code || !state) return fail();

  const stRef = db.collection("oauthStates").doc(String(state));
  const st = (await stRef.get()).data();
  await stRef.delete().catch(() => {});
  if (!st || Date.now() - st.createdAt > 10 * 60 * 1000) return fail();

  const client = newClient(region);
  const r = await callEwelink(() => client.oauth.getToken({ region, redirectUrl: REDIRECT, code }));
  const d = r.data || {};
  if (!d.accessToken) return fail();

  await db.collection("secrets").doc(st.uid).set(
    { ewelink: { at: d.accessToken, rt: d.refreshToken, atExp: d.atExpiredTime, rtExp: d.rtExpiredTime, region } },
    { merge: true }
  );
  return res.redirect(302, "/?ewelink=connected");
}

export default async function handler(req, res) {
  const action = req.query.action;
  try {
    if (action === "callback") return await callback(req, res);

    const uid = await requireUser(req);

    switch (action) {
      // No eWeLink call here, so it is free to call often (also used to warm up the function).
      case "status": {
        const s = (await db.collection("secrets").doc(uid).get()).data()?.ewelink;
        return res.json({ ok: true, connected: !!s });
      }

      case "connect": {
        const state = crypto.randomBytes(16).toString("hex");
        await db.collection("oauthStates").doc(state).set({ uid, createdAt: Date.now() });
        const client = newClient("as");
        const url = await client.oauth.createLoginUrl({ redirectUrl: REDIRECT, grantType: "authorization_code", state });
        return res.json({ ok: true, url });
      }

      case "disconnect": {
        await db.collection("secrets").doc(uid).delete();
        return res.json({ ok: true });
      }

      case "devices": {
        const client = await getAuthedClient(uid);
        let familyId;
        try {
          const fam = await callEwelink(() => client.home.getFamily({}));
          const list = fam.data?.familyList || [];
          familyId = (list.find((f) => f.currentFamily) || list[0])?.id;
        } catch {
          // continue without a family id
        }
        const r = await callEwelink(() => client.device.getAllThings({ familyId, num: 0, beginIndex: -9999999 }));
        const things = (r.data?.thingList || []).map((t) => {
          const i = t.itemData || t;
          return { id: i.deviceid, name: i.name || i.deviceid, online: i.online };
        });
        return res.json({ ok: true, things });
      }

      case "trigger": {
        const channel = Number(req.body?.channel);
        if (!Number.isInteger(channel) || channel < 0 || channel > 3) throw httpError(400, "channel must be 0-3");
        const { client, deviceId } = await clientAndDevice(uid);
        // The relay turns itself off (inching mode, set via "configure"), so only ONE call per cue.
        await callEwelink(() =>
          client.device.setThingStatus({
            type: 1,
            id: deviceId,
            params: { switches: [{ switch: "on", outlet: channel }] },
          })
        );
        return res.json({ ok: true });
      }

      // Puts each outlet into inching mode with the customer's pulse length.
      case "configure": {
        const pulseMs = req.body?.pulseMs;
        if (!Array.isArray(pulseMs) || pulseMs.length !== 4) throw httpError(400, "pulseMs must have 4 values");
        const { client, deviceId } = await clientAndDevice(uid);
        const pulses = pulseMs.map((ms, outlet) => ({
          pulse: "on",
          width: Math.min(36000000, Math.max(500, Math.round(Number(ms) / 500) * 500)),
          outlet,
        }));
        await callEwelink(() => client.device.setThingStatus({ type: 1, id: deviceId, params: { pulses } }));
        return res.json({ ok: true });
      }

      default:
        throw httpError(404, "Unknown action");
    }
  } catch (e) {
    console.error(`[${action}]`, e.message);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
}