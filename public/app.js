import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

const CHANNELS = [0, 1, 2, 3];

const DEFAULT_SETTINGS = {
  deviceId: "",
  pulseMs: [1500, 1500, 1500, 1500],
  leadMs: 400,
  scents: [
    { name: "Scent 1", color: "#7fb99a" },
    { name: "Scent 2", color: "#8fb3d9" },
    { name: "Scent 3", color: "#e0b988" },
    { name: "Scent 4", color: "#c3a2d6" },
  ],
};

let user = null;
let settings = null;
let eweConnected = false;
let currentVideoKey = null;
let videoUrl = null;
let markers = []; // { id, channel, time }
let basePxPerSecond = 40;
let zoomPct = 90;
let lastPlayTime = 0;
let firedThisPass = new Set();
let suppressFireOnce = false;

// ---------- helpers ----------

async function api(path, opts = {}) {
  const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
  const headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = "Bearer " + token;
  const res = await fetch(path, { ...opts, headers });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: "Bad response from server" };
  }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function toast(msg, isErr) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("err", !!isErr);
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 2600);
}

function fmtTime(sec) {
  if (!isFinite(sec)) sec = 0;
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(1).padStart(4, "0");
  return `${String(m).padStart(2, "0")}:${s}`;
}

function pxPerSecond() {
  return basePxPerSecond * (zoomPct / 100);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- tabs ----------

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("is-active", p.id === "panel-" + name));
}

function initTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
  });
}

// ---------- auth ----------

function authMessage(text, isErr = true) {
  const el = document.getElementById("authMsg");
  el.textContent = text;
  el.className = "hint-msg " + (text ? (isErr ? "err" : "ok") : "");
}

function friendlyAuthError(e) {
  const map = {
    "auth/invalid-credential": "Wrong email or password.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/email-already-in-use": "An account with this email already exists. Try signing in.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/popup-closed-by-user": "The sign-in window was closed.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment.",
  };
  return map[e.code] || e.message;
}

function initAuth() {
  const email = () => document.getElementById("authEmail").value.trim();
  const pass = () => document.getElementById("authPassword").value;
  const run = async (fn) => {
    authMessage("", false);
    try {
      await fn();
    } catch (e) {
      authMessage(friendlyAuthError(e));
    }
  };

  document.getElementById("signInBtn").addEventListener("click", () => run(() => signInWithEmailAndPassword(auth, email(), pass())));
  document.getElementById("signUpBtn").addEventListener("click", () => run(() => createUserWithEmailAndPassword(auth, email(), pass())));
  document.getElementById("googleBtn").addEventListener("click", () => run(() => signInWithPopup(auth, new GoogleAuthProvider())));
  document.getElementById("resetBtn").addEventListener("click", () =>
    run(async () => {
      if (!email()) throw new Error("Enter your email first.");
      await sendPasswordResetEmail(auth, email());
      authMessage("Password reset email sent.", false);
    })
  );
  document.getElementById("authPassword").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("signInBtn").click();
  });
  document.getElementById("signOutBtn").addEventListener("click", () => signOut(auth));

  onAuthStateChanged(auth, async (u) => {
    user = u;
    document.getElementById("authScreen").hidden = !!u;
    document.getElementById("appRoot").hidden = !u;
    if (u) {
      await startApp();
    } else {
      settings = null;
      eweConnected = false;
      const video = document.getElementById("video");
      video.pause();
    }
  });
}

async function startApp() {
  const snap = await getDoc(doc(db, "users", user.uid));
  const saved = snap.exists() ? snap.data() : {};
  settings = { ...DEFAULT_SETTINGS, ...saved };
  renderScentGrid();
  fillSettingsForm();
  await refreshConnStatus();

  const params = new URLSearchParams(location.search);
  if (params.has("ewelink")) {
    history.replaceState({}, "", location.pathname);
    activateTab("settings");
    if (params.get("ewelink") === "connected") {
      toast("eWeLink connected!");
      await fetchDevices();
    } else {
      toast("Could not connect eWeLink. Please try again.", true);
    }
  }
}

// ---------- connection status ----------

async function refreshConnStatus() {
  const el = document.getElementById("connStatus");
  const label = el.querySelector(".conn-label");
  let text;
  try {
    const r = await api("/api/ewelink/status");
    eweConnected = r.connected;
    if (!r.connected) {
      el.className = "conn err";
      label.textContent = "eWeLink not connected";
      text = "Not connected.";
    } else if (!settings.deviceId) {
      el.className = "conn err";
      label.textContent = "Choose your Sonoff";
      text = "Connected. Now choose your Sonoff below.";
    } else {
      el.className = "conn ok";
      label.textContent = "eWeLink connected";
      text = "Connected.";
    }
  } catch (e) {
    el.className = "conn err";
    label.textContent = "Can't reach server";
    text = e.message;
  }
  document.getElementById("eweStatusText").textContent = text;
  document.getElementById("connectEweBtn").textContent = eweConnected ? "Reconnect eWeLink" : "Connect eWeLink";
  document.getElementById("disconnectEweBtn").hidden = !eweConnected;
}

// ---------- scents tab ----------

function renderScentGrid() {
  const grid = document.getElementById("scentGrid");
  grid.innerHTML = "";
  CHANNELS.forEach((ch) => {
    const scent = settings.scents[ch];
    const card = document.createElement("div");
    card.className = "scent-card";
    card.innerHTML = `
      <button class="scent-btn" style="background:${scent.color}" data-channel="${ch}" aria-label="Release ${escapeHtml(scent.name)}">✦</button>
      <div class="scent-name">${escapeHtml(scent.name)}</div>
      <div class="scent-state" id="scent-state-${ch}"></div>
    `;
    grid.appendChild(card);
  });
  grid.querySelectorAll(".scent-btn").forEach((btn) => {
    btn.addEventListener("click", () => triggerScent(Number(btn.dataset.channel)));
  });
}

async function triggerScent(channel) {
  const btn = document.querySelector(`.scent-btn[data-channel="${channel}"]`);
  const stateEl = document.getElementById("scent-state-" + channel);
  btn.classList.add("is-firing");
  stateEl.textContent = "Releasing…";
  try {
    await api("/api/ewelink/trigger", { method: "POST", body: JSON.stringify({ channel }) });
    const ms = (settings.pulseMs && settings.pulseMs[channel]) || 1500;
    setTimeout(() => {
      btn.classList.remove("is-firing");
      stateEl.textContent = "Ready";
    }, ms);
  } catch (e) {
    btn.classList.remove("is-firing");
    stateEl.textContent = "Error";
    toast(e.message, true);
  }
}

// ---------- settings tab ----------

function fillSettingsForm() {
  document.getElementById("s-deviceId").value = settings.deviceId || "";
  document.getElementById("s-leadMs").value = settings.leadMs ?? 400;
  renderScentSettings();
}

function renderScentSettings() {
  const wrap = document.getElementById("scentSettings");
  wrap.innerHTML = "";
  CHANNELS.forEach((ch) => {
    const scent = settings.scents[ch];
    const pulse = (settings.pulseMs && settings.pulseMs[ch]) || 1500;
    const row = document.createElement("div");
    row.className = "scent-setting-row";
    row.innerHTML = `
      <input type="color" value="${scent.color}" data-scent-color="${ch}" />
      <input type="text" value="${escapeHtml(scent.name)}" data-scent-name="${ch}" placeholder="Scent name" />
      <div class="pulse-field">Pulse
        <input type="number" min="500" step="500" value="${pulse}" data-scent-pulse="${ch}" /> ms
      </div>
    `;
    wrap.appendChild(row);
  });
}

function collectSettingsFromForm() {
  const scents = CHANNELS.map((ch) => ({
    name: document.querySelector(`[data-scent-name="${ch}"]`).value.trim() || `Scent ${ch + 1}`,
    color: document.querySelector(`[data-scent-color="${ch}"]`).value,
  }));
  // The relay's built-in timer works in 500 ms steps.
  const pulseMs = CHANNELS.map((ch) => {
    const v = Number(document.querySelector(`[data-scent-pulse="${ch}"]`).value) || 1500;
    return Math.max(500, Math.round(v / 500) * 500);
  });
  return {
    deviceId: document.getElementById("s-deviceId").value.trim(),
    leadMs: Math.max(0, Number(document.getElementById("s-leadMs").value) || 0),
    pulseMs,
    scents,
  };
}

async function saveSettings() {
  const resultEl = document.getElementById("saveSettingsResult");
  const payload = collectSettingsFromForm();
  try {
    await setDoc(doc(db, "users", user.uid), payload, { merge: true });
  } catch (e) {
    resultEl.textContent = e.message;
    resultEl.className = "hint-msg err";
    return;
  }

  // Only talk to eWeLink when the device or pulse lengths actually changed (saves quota).
  const needsConfigure =
    eweConnected &&
    payload.deviceId &&
    (payload.deviceId !== settings.deviceId || JSON.stringify(payload.pulseMs) !== JSON.stringify(settings.pulseMs));
  settings = { ...settings, ...payload };

  resultEl.textContent = "Saved.";
  resultEl.className = "hint-msg ok";
  renderScentGrid();
  if (currentVideoKey) renderTracks();

  if (needsConfigure) {
    try {
      await api("/api/ewelink/configure", { method: "POST", body: JSON.stringify({ pulseMs: payload.pulseMs }) });
    } catch (e) {
      resultEl.textContent = "Saved, but couldn't set pulse length on the device: " + e.message;
      resultEl.className = "hint-msg err";
    }
  }
  refreshConnStatus();
}

async function connectEwelink() {
  try {
    const r = await api("/api/ewelink/connect");
    window.location.href = r.url;
  } catch (e) {
    toast(e.message, true);
  }
}

async function disconnectEwelink() {
  if (!confirm("Disconnect your eWeLink account from this console?")) return;
  try {
    await api("/api/ewelink/disconnect", { method: "POST" });
    toast("Disconnected.");
  } catch (e) {
    toast(e.message, true);
  }
  refreshConnStatus();
}

async function fetchDevices() {
  const el = document.getElementById("fetchDevicesResult");
  const listEl = document.getElementById("deviceList");
  el.textContent = "Fetching…";
  el.className = "hint-msg";
  listEl.innerHTML = "";
  try {
    const res = await api("/api/ewelink/devices");
    const things = res.things || [];
    if (!things.length) {
      el.textContent = "No devices found on this eWeLink account.";
      el.className = "hint-msg err";
      return;
    }
    el.textContent = `Found ${things.length} device(s). Click one to use it.`;
    el.className = "hint-msg ok";
    things.forEach((t) => {
      const row = document.createElement("div");
      row.className = "device-row";
      row.innerHTML = `<div><div>${escapeHtml(t.name)}</div><div class="device-id">${escapeHtml(t.id)}</div></div>
        <div><button type="button" class="btn-secondary" data-use="${escapeHtml(t.id)}">Use as 4-channel device</button></div>`;
      listEl.appendChild(row);
    });
    listEl.querySelectorAll("[data-use]").forEach((b) => {
      b.addEventListener("click", () => {
        document.getElementById("s-deviceId").value = b.dataset.use;
        toast("Device ID filled in. Remember to Save settings.");
      });
    });
    // Works out of the box: a single device gets picked and saved automatically.
    if (things.length === 1 && !settings.deviceId) {
      document.getElementById("s-deviceId").value = things[0].id;
      await saveSettings();
    }
  } catch (e) {
    el.textContent = e.message;
    el.className = "hint-msg err";
  }
}

// ---------- timeline tab ----------

function videoKeyFor(file) {
  // Firestore-safe document id: stable for the same file, no slashes.
  return "v_" + file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 150) + "_" + file.size;
}

async function openVideoFile(file) {
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(file);
  currentVideoKey = videoKeyFor(file);

  document.getElementById("videoName").textContent = file.name;
  document.getElementById("editorEmpty").hidden = true;
  document.getElementById("editor").hidden = false;

  const video = document.getElementById("video");
  video.src = videoUrl;
  firedThisPass.clear();
  lastPlayTime = 0;

  try {
    const snap = await getDoc(doc(db, "users", user.uid, "timelines", currentVideoKey));
    markers = snap.exists() ? snap.data().markers || [] : [];
  } catch (e) {
    markers = [];
    toast("Couldn't load saved timeline: " + e.message, true);
  }
  video.addEventListener("loadedmetadata", () => renderTracks(), { once: true });
  renderTracks();
}

function buildRuler(duration) {
  const ruler = document.getElementById("ruler");
  ruler.innerHTML = "";
  const pps = pxPerSecond();
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  let interval = candidates[candidates.length - 1];
  for (const c of candidates) {
    if (c * pps >= 70) {
      interval = c;
      break;
    }
  }
  for (let t = 0; t <= duration; t += interval) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.style.left = (t * pps).toFixed(1) + "px";
    tick.textContent = fmtTime(t).slice(0, 5);
    ruler.appendChild(tick);
  }
}

function renderTracks() {
  const video = document.getElementById("video");
  const duration = video.duration || 0;
  const pps = pxPerSecond();
  const totalWidth = Math.max(duration * pps + 80, 600);

  document.getElementById("tracksInner").style.width = totalWidth + "px";
  buildRuler(duration);

  const tracksEl = document.getElementById("tracks");
  tracksEl.innerHTML = "";

  CHANNELS.forEach((ch) => {
    const scent = settings.scents[ch];
    const track = document.createElement("div");
    track.className = "track";
    track.dataset.channel = ch;
    track.innerHTML = `<span class="track-label"><span class="swatch" style="background:${scent.color}"></span>${escapeHtml(scent.name)}</span>`;
    track.addEventListener("click", (e) => {
      if (e.target.closest(".cue")) return;
      const rect = track.getBoundingClientRect();
      const x = e.clientX - rect.left;
      addMarker(ch, Math.max(0, x / pps));
    });
    tracksEl.appendChild(track);
  });

  markers.forEach(renderCue);
  updatePlayhead();
}

function renderCue(marker) {
  const track = document.querySelector(`.track[data-channel="${marker.channel}"]`);
  if (!track) return;
  const pps = pxPerSecond();
  const pulseSec = ((settings.pulseMs && settings.pulseMs[marker.channel]) || 1500) / 1000;
  const scent = settings.scents[marker.channel];

  const cue = document.createElement("div");
  cue.className = "cue";
  cue.dataset.id = marker.id;
  cue.style.left = (marker.time * pps).toFixed(1) + "px";
  cue.style.width = Math.max(pulseSec * pps, 26) + "px";
  cue.style.background = scent.color;
  cue.title = `${scent.name} at ${fmtTime(marker.time)}`;
  cue.innerHTML = `<span class="cue-label">${fmtTime(marker.time)}</span><span class="cue-close">×</span>`;

  cue.querySelector(".cue-close").addEventListener("click", (e) => {
    e.stopPropagation();
    removeMarker(marker.id);
  });

  let dragging = false;
  let startX = 0;
  let startLeft = 0;

  cue.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("cue-close")) return;
    dragging = true;
    startX = e.clientX;
    startLeft = marker.time * pps;
    cue.setPointerCapture(e.pointerId);
  });
  cue.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    cue.style.left = Math.max(0, startLeft + (e.clientX - startX)) + "px";
  });
  cue.addEventListener("pointerup", () => {
    if (!dragging) return;
    dragging = false;
    marker.time = parseFloat(cue.style.left) / pps;
    cue.title = `${scent.name} at ${fmtTime(marker.time)}`;
    cue.querySelector(".cue-label").textContent = fmtTime(marker.time);
  });

  track.appendChild(cue);
}

function addMarker(channel, time) {
  markers.push({ id: "m" + Date.now() + Math.random().toString(36).slice(2, 7), channel, time });
  renderTracks();
}

function removeMarker(id) {
  markers = markers.filter((m) => m.id !== id);
  renderTracks();
}

function updatePlayhead() {
  const video = document.getElementById("video");
  document.getElementById("playhead").style.left = (video.currentTime || 0) * pxPerSecond() + "px";
  document.getElementById("timeDisplay").textContent = `${fmtTime(video.currentTime || 0)} / ${fmtTime(video.duration || 0)}`;
}

function checkCueFiring() {
  const video = document.getElementById("video");
  const t = video.currentTime;
  const lead = ((settings && settings.leadMs) || 0) / 1000; // fire early to cover network delay
  if (t < lastPlayTime) firedThisPass.clear();
  if (!suppressFireOnce) {
    markers.forEach((m) => {
      const fireAt = m.time - lead;
      if (fireAt > lastPlayTime && fireAt <= t && !firedThisPass.has(m.id)) {
        firedThisPass.add(m.id);
        triggerScent(m.channel);
      }
    });
  }
  suppressFireOnce = false;
  lastPlayTime = t;
}

async function saveTimeline() {
  if (!currentVideoKey) return;
  const statusEl = document.getElementById("saveStatus");
  try {
    await setDoc(doc(db, "users", user.uid, "timelines", currentVideoKey), {
      name: document.getElementById("videoName").textContent,
      markers,
      updatedAt: Date.now(),
    });
    statusEl.textContent = "Saved.";
    setTimeout(() => (statusEl.textContent = ""), 2000);
  } catch (e) {
    toast(e.message, true);
  }
}

function initTimelineTab() {
  document.getElementById("videoUpload").addEventListener("change", (e) => {
    if (e.target.files[0]) openVideoFile(e.target.files[0]);
    e.target.value = "";
  });

  document.getElementById("zoomRange").addEventListener("input", (e) => {
    zoomPct = Number(e.target.value);
    renderTracks();
  });

  const video = document.getElementById("video");
  const playBtn = document.getElementById("playBtn");
  playBtn.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
  video.addEventListener("play", () => {
    playBtn.textContent = "⏸";
    api("/api/ewelink/status").catch(() => {}); // wakes the server so the first cue isn't delayed
  });
  video.addEventListener("pause", () => (playBtn.textContent = "▶"));
  video.addEventListener("timeupdate", () => {
    updatePlayhead();
    checkCueFiring();
  });
  video.addEventListener("seeking", () => {
    suppressFireOnce = true;
  });

  document.getElementById("saveTimelineBtn").addEventListener("click", saveTimeline);

  // clicking the ruler seeks the video
  document.getElementById("ruler").addEventListener("click", (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    video.currentTime = Math.max(0, (e.clientX - rect.left) / pxPerSecond());
  });
}

// ---------- settings tab wiring ----------

function initSettingsTab() {
  document.getElementById("saveSettingsBtn").addEventListener("click", saveSettings);
  document.getElementById("fetchDevicesBtn").addEventListener("click", fetchDevices);
  document.getElementById("connectEweBtn").addEventListener("click", connectEwelink);
  document.getElementById("disconnectEweBtn").addEventListener("click", disconnectEwelink);
}

// ---------- boot ----------

initTabs();
initSettingsTab();
initTimelineTab();
initAuth();